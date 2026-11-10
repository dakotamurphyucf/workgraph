import { resourcePresentation } from "./presentation";
import { refreshSlots, createReadSlot, type ReadState } from "../../../core/state/read-slot";
import * as d from "../../../core/protocol/decoders";
import { createResourcesClient, type ResourcesClient } from "./client";
import { createResourceTransfer, type ResourceTransfer } from "./transfer";
import type {
  ResourceCapture,
  ResourceDirectoryOptions,
  ResourcePage,
  ResourceRecord,
  ResourceScope,
  ResourceTarget,
  ResourceSelection,
  ResourcesController,
  ResourcesControllerOptions,
  ResourcesState,
  ResourceVersion,
} from "./types";

const zeroResult = d.decimal.decode(d.jsonString("0"));
if (!zeroResult.ok) throw new Error("Invalid fixed resource offset.");
const zero = zeroResult.value;
const scopeKey = (scope: ResourceScope) => [
  scope.connection.id,
  scope.connection.generation,
  scope.connection.socket,
  scope.workspaceId,
];
const selectionKey = (selection: ResourceSelection) =>
  JSON.stringify([
    ...scopeKey(selection),
    selection.resourceId,
    selection.content?.version ?? null,
    selection.content?.expectedDigest ?? null,
  ]);
function freezeSelection(selection: ResourceSelection): ResourceSelection {
  return Object.freeze({
    ...selection,
    connection: Object.freeze({ ...selection.connection }),
    content: selection.content === null ? null : Object.freeze({ ...selection.content }),
  });
}
function current<T>(state: ReadState<T>): T | undefined {
  return state.kind === "ready"
    ? state.value
    : state.kind === "loading" || state.kind === "failed" || state.kind === "unexpected_error"
      ? state.previous
      : undefined;
}
/** Launch-owned read locations. Each publication checks the immutable selection
 * epoch, including intermediate awaits and failures; drafts are a separate owner. */
export function createResourcesController(
  options: ResourcesControllerOptions,
  ports?: { readonly client: ResourcesClient; readonly transfer: ResourceTransfer },
): ResourcesController {
  const client = ports?.client ?? createResourcesClient(options.http),
    transfer = ports?.transfer ?? createResourceTransfer(client);
  const directory = createReadSlot<ResourceCapture<ResourcePage<ResourceRecord>>>(),
    metadata = createReadSlot<ResourceCapture<ResourceRecord>>(),
    versions = createReadSlot<ResourceCapture<ResourcePage<ResourceVersion>>>();
  let versionCapture: {
    readonly key: string;
    readonly revision: import("../../../core/protocol/types").Decimal;
  } | null = null;
  let disposed = false,
    epoch = 0,
    selection: ResourceSelection | null = null,
    download: AbortController | null = null;
  let state: ResourcesState = {
    scope: null,
    directory: directory.get(),
    directoryPreviousOffsets: [],
    metadata: metadata.get(),
    versions: versions.get(),
    versionPreviousOffsets: [],
    content: { kind: "idle" },
    updateIssue: null,
    includeArchived: false,
    directoryTarget: null,
    unexpected: null,
  };
  const listeners = new Set<() => void>();
  function publish(change: Partial<ResourcesState> = {}) {
    if (disposed) return;
    state = Object.freeze({
      ...state,
      ...change,
      content: resourcePresentation(change.content ?? state.content, current(metadata.get())),
      directory: directory.get(),
      metadata: metadata.get(),
      versions: versions.get(),
    });
    listeners.forEach((listener) => listener());
  }
  const subscriptions = [
    directory.subscribe(() => publish()),
    metadata.subscribe(() => publish()),
    versions.subscribe(() => publish()),
  ];
  const clearVersions = () => {
    versionCapture = null;
    versions.clear();
    publish({ versionPreviousOffsets: [] });
  };
  const clearSelection = () => {
    epoch++;
    download?.abort();
    download = null;
    selection = null;
    metadata.clear();
    clearVersions();
    publish({ content: { kind: "idle" }, unexpected: null });
  };
  async function select(input: ResourceSelection, passive?: AbortSignal): Promise<void> {
    if (disposed || passive?.aborted) return;
    const publishSelection = (change: Partial<ResourcesState>) => {
      if (passive && change.content && change.content.kind !== "verified") {
        const { content, ...rest } = change;
        publish({
          ...rest,
          updateIssue: content.kind === "failed" ? content.message : state.updateIssue,
        });
      } else publish(change);
    };
    const selected = freezeSelection(input),
      key = selectionKey(selected);
    const verified = state.content;
    if (
      selected.content !== null &&
      verified.kind === "verified" &&
      JSON.stringify(scopeKey(selected)) === JSON.stringify(scopeKey(verified.pin)) &&
      selected.resourceId === verified.pin.resourceId &&
      selected.content.version === verified.pin.version &&
      (selected.content.expectedDigest === null ||
        selected.content.expectedDigest === verified.pin.digest)
    ) {
      // Latest-to-explicit navigation can name the bytes already verified here.
      // Keep the passive viewer and its explicit renderer choice mounted. A
      // different pin or an unpinned latest selection still takes the read path.
      if (selection === null || selectionKey(selection) !== key) {
        clearVersions();
      }
      selection = selected;
      publishSelection({ scope: selected });
      return;
    }
    if (
      passive === undefined &&
      selection !== null &&
      selectionKey(selection) === key &&
      (state.content.kind === "verified" || state.content.kind === "loading")
    )
      return;
    epoch++;
    const owner = epoch;
    download?.abort();
    const abort = new AbortController();
    download = abort;
    selection = selected;
    const signal = passive ? AbortSignal.any([abort.signal, passive]) : abort.signal;
    const owns = () => !disposed && owner === epoch && !signal.aborted;
    if (!passive) {
      clearVersions();
    }
    publishSelection({
      scope: selected,
      content: { kind: "loading", selection: selected, receivedBytes: 0, totalBytes: null },
      unexpected: null,
    });
    const fail = (message: string) => {
      if (owns())
        publishSelection({
          content: { kind: "failed", selection: selected, message, failure: null },
        });
    };
    try {
      const loaded = await metadata.load(
        JSON.stringify([...scopeKey(selected), selected.resourceId]),
        (signal) => client.get(selected, selected.resourceId, signal),
        // Resource metadata is always current; an explicit content pin freezes
        // only the publication bytes. Metadata updates must not move that pin.
        { live: true, signal, background: passive !== undefined },
      );
      if (!owns()) return;
      if (!loaded.ok) {
        if ("failure" in loaded)
          publishSelection({
            content: {
              kind: "failed",
              selection: selected,
              message: "Resource metadata could not be captured.",
              failure: loaded.failure,
            },
          });
        return;
      }
      const captured = loaded.data;
      let version: ResourceVersion = captured.value.current_version;
      if (selected.content !== null && selected.content.version !== version.revision) {
        const historical = await client.version(
          selected,
          selected.resourceId,
          selected.content.version,
          captured.queryRevision,
          signal,
        );
        if (!owns()) return;
        if (!historical.ok) {
          publishSelection({
            content: {
              kind: "failed",
              selection: selected,
              message:
                "Exact published version could not be read; current content was not substituted.",
              failure: historical.failure,
            },
          });
          return;
        }
        version = historical.data.value;
      }
      if (
        selected.content?.expectedDigest !== null &&
        selected.content?.expectedDigest !== undefined &&
        selected.content.expectedDigest !== version.digest
      ) {
        fail(
          "Published version SHA-256 differs from the exact evidence pin; content was not substituted.",
        );
        return;
      }
      let size = version.size_bytes;
      if (size === null) {
        const first = await client.chunk(
          selected,
          selected.resourceId,
          version.revision,
          zero,
          signal,
        );
        if (!owns()) return;
        if (!first.ok) {
          publishSelection({
            content: {
              kind: "failed",
              selection: selected,
              message:
                "Declared byte size is unavailable and the exact version could not be inspected.",
              failure: first.failure,
            },
          });
          return;
        }
        if (first.data.digest !== version.digest) {
          fail("Resource range differs from the historical version digest.");
          return;
        }
        size = first.data.size_bytes;
      }
      const pin = Object.freeze({
        connection: selected.connection,
        workspaceId: selected.workspaceId,
        resourceId: selected.resourceId,
        version: version.revision,
        digest: version.digest,
        sizeBytes: size,
        filename: version.filename,
        mimeType: version.mime_type,
      });
      const result = await transfer.download(
        pin,
        (receivedBytes, totalBytes) => {
          if (owns())
            publishSelection({
              content: { kind: "loading", selection: selected, receivedBytes, totalBytes },
            });
        },
        signal,
      );
      if (!owns()) return;
      if (!result.ok) {
        fail(result.message);
        return;
      }
      if (result.digest !== pin.digest || result.blob.size !== Number(pin.sizeBytes)) {
        fail("Verified transfer result differs from the selected immutable content.");
        return;
      }
      // Full content is already worker-verified; the passive text renderer gets a
      // bounded preview, while Download retains the complete verified Blob.
      const bytes = new Uint8Array(await result.blob.slice(0, 1048576).arrayBuffer());
      if (!owns()) return;
      const source = Object.freeze({
        key: JSON.stringify([...scopeKey(pin), pin.resourceId, pin.version, pin.digest]),
        label: `${pin.filename} · content v${pin.version}`,
        bytes,
        completeness:
          result.blob.size > bytes.byteLength ? ("partial" as const) : ("complete" as const),
        hints: { filename: pin.filename, mime: pin.mimeType, intent: "prose" as const },
      });
      publishSelection({
        content: { kind: "verified", pin, blob: result.blob, source },
        updateIssue: null,
      });
    } catch (error) {
      if (owns()) publishSelection({ unexpected: { error } });
    } finally {
      if (download === abort) download = null;
    }
  }
  async function loadDirectory(
    scope: ResourceScope,
    opts: ResourceDirectoryOptions = {},
    previousOffsets: readonly import("../../../core/protocol/types").Decimal[] = [],
  ): Promise<void> {
    if (disposed) return;
    const captured = Object.freeze({
      ...scope,
      connection: Object.freeze({ ...scope.connection }),
    });
    if (
      state.scope !== null &&
      JSON.stringify(scopeKey(state.scope)) !== JSON.stringify(scopeKey(captured))
    )
      clearSelection();
    const includeArchived = opts.includeArchived ?? state.includeArchived;
    const target: ResourceTarget | null =
      opts.target === undefined ? null : Object.freeze({ ...opts.target });
    const prior = directory.get().kind === "loading" ? undefined : current(directory.get());
    const sameQuery =
      prior !== undefined &&
      JSON.stringify(scopeKey(prior.scope)) === JSON.stringify(scopeKey(captured)) &&
      includeArchived === state.includeArchived &&
      JSON.stringify(target) === JSON.stringify(state.directoryTarget);
    publish({
      scope: captured,
      includeArchived,
      directoryTarget: target,
      ...(sameQuery ? {} : { directoryPreviousOffsets: [] }),
    });
    try {
      const result = await directory.load(
        JSON.stringify([
          ...scopeKey(captured),
          includeArchived,
          target,
          opts.offset ?? "0",
          opts.atRevision ?? null,
        ]),
        (signal) =>
          client.list(
            captured,
            { ...opts, includeArchived, ...(target === null ? {} : { target }) },
            signal,
          ),
        {
          ...(sameQuery && prior !== undefined ? { previous: prior } : {}),
          live: opts.atRevision === undefined && (opts.offset === undefined || opts.offset === "0"),
        },
      );
      if (result.ok) publish({ directoryPreviousOffsets: Object.freeze([...previousOffsets]) });
    } catch (error) {
      const observed = directory.get();
      if (!disposed && observed.kind === "unexpected_error" && observed.error === error)
        publish({ unexpected: { error } });
    }
  }
  async function loadVersions(
    offset?: import("../../../core/protocol/types").Decimal,
    previousOffsets: readonly import("../../../core/protocol/types").Decimal[] = [],
  ): Promise<void> {
    const selected = selection,
      captured = current(metadata.get());
    if (
      selected === null ||
      captured === undefined ||
      disposed ||
      JSON.stringify(scopeKey(selected)) !== JSON.stringify(scopeKey(captured.scope)) ||
      captured.value.resource_id !== selected.resourceId
    )
      return;
    const key = selectionKey(selected),
      prior = current(versions.get());
    const revision =
      offset === undefined
        ? captured.queryRevision
        : versionCapture?.key === key
          ? versionCapture.revision
          : undefined;
    if (revision === undefined) {
      await versions.load(JSON.stringify([key, "missing-continuation"]), () =>
        Promise.resolve({
          ok: false,
          failure: {
            kind: "input",
            message: "Load Published versions before continuing its captured page.",
          },
        }),
      );
      return;
    }
    try {
      const result = await versions.load(
        JSON.stringify([...scopeKey(selected), selected.resourceId, revision, offset ?? "0"]),
        (signal) =>
          client.history(
            selected,
            selected.resourceId,
            {
              atRevision: revision,
              ...(offset === undefined ? {} : { offset }),
            },
            signal,
          ),
        prior === undefined ? {} : { previous: prior },
      );
      if (result.ok && selection !== null && selectionKey(selection) === key) {
        versionCapture = { key, revision: result.data.queryRevision };
        publish({ versionPreviousOffsets: Object.freeze([...previousOffsets]) });
      }
    } catch (error) {
      const observed = versions.get();
      if (!disposed && observed.kind === "unexpected_error" && observed.error === error)
        publish({ unexpected: { error } });
    }
  }
  return {
    refreshLive: async (signal) => {
      const result = await refreshSlots([directory, metadata], signal);
      const latest = current(metadata.get()),
        content = state.content,
        selected = selection;
      if (
        !signal.aborted &&
        selected?.content === null &&
        content.kind === "verified" &&
        latest &&
        latest.value.current_version.revision !== content.pin.version &&
        download === null
      )
        await select(selected, signal);
      return { ...result, ok: result.ok && state.updateIssue === null };
    },
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    directory: loadDirectory,
    nextDirectory: async () => {
      const prior = directory.get().kind === "loading" ? undefined : current(directory.get());
      if (prior === undefined || prior.value.next_offset === null) return;
      await loadDirectory(
        prior.scope,
        {
          offset: prior.value.next_offset,
          atRevision: prior.queryRevision,
          includeArchived: state.includeArchived,
          ...(state.directoryTarget === null ? {} : { target: state.directoryTarget }),
        },
        [...state.directoryPreviousOffsets, prior.value.offset],
      );
    },
    previousDirectory: async () => {
      const prior = directory.get().kind === "loading" ? undefined : current(directory.get()),
        offset = state.directoryPreviousOffsets.at(-1);
      if (prior === undefined || offset === undefined) return;
      await loadDirectory(
        prior.scope,
        {
          offset,
          atRevision: prior.queryRevision,
          includeArchived: state.includeArchived,
          ...(state.directoryTarget === null ? {} : { target: state.directoryTarget }),
        },
        state.directoryPreviousOffsets.slice(0, -1),
      );
    },
    select,
    refreshMetadata: async () => {
      const selected = selection;
      if (selected === null || disposed) return;
      // Refresh latest metadata only. Never replace the pinned reader bytes or a
      // retained historical content selection underneath the user.
      try {
        await metadata.load(
          JSON.stringify([...scopeKey(selected), selected.resourceId]),
          (signal) => client.get(selected, selected.resourceId, signal),
          { live: true },
        );
      } catch (error) {
        const observed = metadata.get();
        if (!disposed && observed.kind === "unexpected_error" && observed.error === error)
          publish({ unexpected: { error } });
      }
    },
    versions: loadVersions,
    nextVersions: async () => {
      const prior = versions.get().kind === "loading" ? undefined : current(versions.get());
      if (prior?.value.next_offset !== null && prior?.value.next_offset !== undefined)
        await loadVersions(prior.value.next_offset, [
          ...state.versionPreviousOffsets,
          prior.value.offset,
        ]);
    },
    previousVersions: async () => {
      const offset = state.versionPreviousOffsets.at(-1);
      if (offset !== undefined && versions.get().kind !== "loading")
        await loadVersions(offset, state.versionPreviousOffsets.slice(0, -1));
    },
    cancelDownload: () => {
      const selected = selection;
      epoch++;
      download?.abort();
      download = null;
      if (selected !== null && state.content.kind === "loading")
        publish({
          content: {
            kind: "failed",
            selection: selected,
            message: "Download cancelled before complete verification.",
            failure: null,
          },
        });
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      epoch++;
      download?.abort();
      directory.dispose();
      metadata.dispose();
      versions.dispose();
      transfer.dispose();
      subscriptions.forEach((unsubscribe) => unsubscribe());
      listeners.clear();
    },
  };
}
