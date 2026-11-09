import * as d from "../../../core/protocol/decoders";
import { createResourcesClient } from "../resources/client";
import { createResourceTransfer, type ResourceTransfer } from "../resources/transfer";
import type { ResourcesClient } from "../resources/client";
import type { ResourceContentContext, ResourcePin } from "../resources/types";
import { failureText } from "../../connections/failure";
import { createViewerWorker } from "./worker-client";
import { VIEWER_LIMITS as L } from "./limits";
import type {
  RichViewerController,
  RichViewerOptions,
  RichViewerState,
  ViewerWorker,
} from "./types";
export function pinKey(pin: ResourcePin): string {
  return JSON.stringify([
    pin.connection.id,
    pin.connection.generation,
    pin.connection.socket,
    pin.workspaceId,
    pin.resourceId,
    pin.version,
    pin.digest,
    pin.sizeBytes,
  ]);
}
/** Only convert the complete verified Blob when it fits a rich viewer. Larger files
 * retain the existing bounded prefix and their full verified download separately. */
export async function completeContent(
  content: ResourceContentContext,
): Promise<ResourceContentContext> {
  if (content.source.completeness === "complete" || content.blob.size > L.imageBytes)
    return content;
  const bytes = new Uint8Array(await content.blob.arrayBuffer());
  return { ...content, source: { ...content.source, bytes, completeness: "complete" } };
}
export function createRichViewerController(
  { http }: RichViewerOptions,
  dependencies: {
    readonly client?: ResourcesClient;
    readonly transfer?: ResourceTransfer;
    readonly worker?: ViewerWorker;
  } = {},
): RichViewerController {
  const client = dependencies.client ?? createResourcesClient(http),
    transfer = dependencies.transfer ?? createResourceTransfer(client),
    worker = dependencies.worker ?? createViewerWorker();
  const listeners = new Set<() => void>();
  let state: RichViewerState = { comparison: { kind: "idle" }, unexpected: null },
    active: AbortController | null = null,
    epoch = 0,
    disposed = false;
  function publish(next: RichViewerState) {
    state = next;
    for (const listener of listeners) listener();
  }
  function clearComparison() {
    epoch++;
    active?.abort();
    active = null;
    publish({ comparison: { kind: "idle" }, unexpected: null });
  }
  return {
    worker,
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clearComparison,
    compareVersion: async (left, version) => {
      if (disposed) return;
      const captured: ResourcePin = Object.freeze({
          ...left,
          connection: Object.freeze({ ...left.connection }),
        }),
        owner = pinKey(captured),
        selectedVersion = version;
      active?.abort();
      const abort = new AbortController();
      active = abort;
      const generation = ++epoch;
      const owns = () => !disposed && !abort.signal.aborted && epoch === generation;
      const failure = (message: string) => {
        if (owns()) publish({ comparison: { kind: "failed", owner, message }, unexpected: null });
      };
      publish({
        comparison: { kind: "loading", owner, version: selectedVersion },
        unexpected: null,
      });
      try {
        if (selectedVersion === "0") {
          failure("Content version must be positive.");
          return;
        }
        const retained = await http.request({
          method: "GET",
          path: `/connections/${encodeURIComponent(captured.connection.id)}/generations/${encodeURIComponent(captured.connection.generation)}`,
          codec: d.connectionProfile,
          signal: abort.signal,
        });
        if (!owns()) return;
        if (!retained.ok) {
          failure(failureText(retained.failure));
          return;
        }
        if (
          retained.data.id !== captured.connection.id ||
          retained.data.generation !== captured.connection.generation ||
          retained.data.socket !== captured.connection.socket
        ) {
          failure(
            "Retained profile differs from this exact publication capture. No daemon read was sent.",
          );
          return;
        }
        const metadata = await client.get(captured, captured.resourceId, abort.signal);
        if (!owns()) return;
        if (!metadata.ok) {
          failure(failureText(metadata.failure));
          return;
        }
        const found = await client.version(
          captured,
          captured.resourceId,
          selectedVersion,
          metadata.data.queryRevision,
          abort.signal,
        );
        if (!owns()) return;
        if (!found.ok) {
          failure(failureText(found.failure));
          return;
        }
        if (found.data.partial || found.data.value.size_bytes === null) {
          failure(
            "The exact content version descriptor is incomplete. No current version was substituted.",
          );
          return;
        }
        const item = found.data.value,
          pin: ResourcePin = Object.freeze({
            ...captured,
            version: item.revision,
            digest: item.digest,
            sizeBytes: found.data.value.size_bytes,
            filename: item.filename,
            mimeType: item.mime_type,
          });
        const downloaded = await transfer.download(pin, () => {}, abort.signal);
        if (!owns()) return;
        if (!downloaded.ok) {
          failure(downloaded.message);
          return;
        }
        const length = downloaded.blob.size,
          bytes = new Uint8Array(
            await downloaded.blob.slice(0, length <= L.imageBytes ? length : 1048576).arrayBuffer(),
          );
        if (!owns()) return;
        const content: ResourceContentContext = {
          pin,
          blob: downloaded.blob,
          source: {
            key: pinKey(pin),
            label: pin.filename,
            bytes,
            completeness: bytes.length === length ? "complete" : "partial",
            hints: { filename: pin.filename, mime: pin.mimeType, intent: "unknown" },
          },
        };
        publish({ comparison: { kind: "ready", owner, content }, unexpected: null });
      } catch (error: unknown) {
        if (owns())
          publish({
            comparison: { kind: "failed", owner, message: "Unexpected comparison failure." },
            unexpected: { owner, error },
          });
      } finally {
        if (active === abort) active = null;
      }
    },
    dispose: () => {
      disposed = true;
      clearComparison();
      transfer.dispose();
      worker.dispose();
      listeners.clear();
    },
  };
}
