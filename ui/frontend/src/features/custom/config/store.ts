import { createResourcesClient, type ResourcesClient } from "../../knowledge/resources/client";
import { createResourceTransfer, type ResourceTransfer } from "../../knowledge/resources/transfer";
import type { ResourcePin } from "../../knowledge/resources/types";
import type { TransferResult } from "../../history/transcript/transfer.types";
import type { HttpFailure } from "../../../core/protocol/http";
import { decodeConfigSource } from "./decode";
import type { ConfigReadResult, ConfigStore, ConfigStoreOptions } from "./types";
import { pinCodec } from "./codecs";
import * as d from "../../../core/protocol/decoders";
function failure(error: HttpFailure): ConfigReadResult {
  switch (error.kind) {
    case "aborted":
      return {
        ok: false,
        kind: "cancelled",
        message: "Config read was cancelled.",
        failure: error,
      };
    case "input":
      return { ok: false, kind: "input", message: error.message, failure: error };
    case "protocol":
      return { ok: false, kind: "protocol", message: error.message, failure: error };
    case "network":
    case "remote":
      return {
        ok: false,
        kind: "unavailable",
        message:
          "The exact config source is unavailable. The previous working configuration is unchanged.",
        failure: error,
      };
  }
}
function transferFailure(error: Extract<TransferResult, { ok: false }>): ConfigReadResult {
  switch (error.kind) {
    case "cancelled":
    case "timeout":
    case "busy":
    case "input":
    case "protocol":
      return { ok: false, kind: error.kind, message: error.message, failure: null };
    case "read":
      return { ok: false, kind: "unavailable", message: error.message, failure: null };
  }
}
/** Owns one finite transfer. No activation state is replaced on failure. */
export function createConfigStore(
  options: ConfigStoreOptions,
  client: ResourcesClient = createResourcesClient(options.http),
  transfer: ResourceTransfer = createResourceTransfer(client),
): ConfigStore {
  let disposed = false;
  let active: AbortController | null = null;
  return {
    read: async (scope, pin, signal) => {
      if (disposed || signal?.aborted)
        return {
          ok: false,
          kind: "cancelled",
          message: "Config owner is disposed or read was cancelled.",
          failure: null,
        };
      if (active !== null)
        return {
          ok: false,
          kind: "busy",
          message: "One config transfer is already active. Retry explicitly after it finishes.",
          failure: null,
        };
      const parsed = pinCodec.decode(
        d.jsonObject([
          ["resource_id", d.jsonString(pin.resource_id)],
          ["version", d.jsonString(pin.version)],
          ["digest", d.jsonString(pin.digest)],
          ["size_bytes", d.jsonString(pin.size_bytes)],
        ]),
      );
      if (!parsed.ok || BigInt(parsed.value.size_bytes) > 65_536n)
        return {
          ok: false,
          kind: "input",
          message: "Configuration pins must identify at most 64 KiB of exact content.",
          failure: null,
        };
      // Capture all caller-owned scalar associations before the first await.
      const ownedScope = Object.freeze({
        workspaceId: scope.workspaceId,
        connection: Object.freeze({ ...scope.connection }),
      });
      const ownedPin = Object.freeze({ ...parsed.value });
      const owner = new AbortController();
      active = owner;
      const abort = () => owner.abort();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const resource = await client.get(ownedScope, ownedPin.resource_id, owner.signal);
        if (!resource.ok) return failure(resource.failure);
        if (owner.signal.aborted)
          return {
            ok: false,
            kind: "cancelled",
            message: "Config read was cancelled.",
            failure: null,
          };
        const version = await client.version(
          ownedScope,
          ownedPin.resource_id,
          ownedPin.version,
          resource.data.queryRevision,
          owner.signal,
        );
        if (!version.ok) return failure(version.failure);
        const captured = version.data;
        if (
          captured.partial ||
          captured.value.revision !== ownedPin.version ||
          captured.value.digest !== ownedPin.digest ||
          captured.value.size_bytes !== ownedPin.size_bytes
        )
          return {
            ok: false,
            kind: "integrity",
            message:
              "Config content version, digest or size differs from its immutable pin. No current-version fallback was used.",
            failure: null,
          };
        const target: ResourcePin = Object.freeze({
          ...ownedScope,
          resourceId: ownedPin.resource_id,
          version: ownedPin.version,
          digest: ownedPin.digest,
          sizeBytes: ownedPin.size_bytes,
          filename: captured.value.filename,
          mimeType: captured.value.mime_type,
        });
        const result = await transfer.download(target, () => {}, owner.signal);
        if (!result.ok) return transferFailure(result);
        if (owner.signal.aborted)
          return {
            ok: false,
            kind: "cancelled",
            message: "Config read was cancelled.",
            failure: null,
          };
        if (result.blob.size !== Number(ownedPin.size_bytes) || result.digest !== ownedPin.digest)
          return {
            ok: false,
            kind: "integrity",
            message: "Verified config transfer differs from its expected bytes/digest.",
            failure: null,
          };
        const decoded = await decodeConfigSource(
          options.http.processing,
          new Uint8Array(await result.blob.arrayBuffer()),
          owner.signal,
        );
        if (!decoded.ok)
          return {
            ok: false,
            kind: decoded.failure.kind === "aborted" ? "cancelled" : decoded.failure.kind,
            message: decoded.failure.message,
            failure: null,
          };
        if (owner.signal.aborted || disposed)
          return {
            ok: false,
            kind: "cancelled",
            message: "Config read was cancelled.",
            failure: null,
          };
        return {
          ok: true,
          capture: Object.freeze({
            scope: ownedScope,
            pin: ownedPin,
            blob: result.blob,
            decoded: decoded.value,
          }),
        };
      } finally {
        signal?.removeEventListener("abort", abort);
        if (active === owner) active = null;
      }
    },
    dispose: () => {
      disposed = true;
      active?.abort();
      transfer.dispose();
    },
  };
}
