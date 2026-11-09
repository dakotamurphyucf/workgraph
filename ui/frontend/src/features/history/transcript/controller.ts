import { FORMAT_LIMITS } from "../formats/limits";
import { clearHistoryTarget } from "../../../app/navigation";
import type { FeatureContext } from "../../../app/types";
import { type JsonValue } from "../../../core/json";
import * as d from "../../../core/protocol/decoders";
import type { HttpClient, HttpResult } from "../../../core/protocol/http";
import type { Decimal, Identifier, JsonObject, Preparation } from "../../../core/protocol/types";
import { HTTP_LIMITS } from "../../../core/protocol/worker/jobs";
import type { OperationController } from "../../../core/state/operations";
import {
  refreshSlots,
  createReadSlot,
  type ReadCompletion,
  type ReadState,
} from "../../../core/state/read-slot";
import { createConnectionsClient } from "../../connections/client";
import {
  projectCapturedPayloadAsync,
  type FormatSelection,
  type ProjectionResult,
} from "../formats";
import { chunkBytes, PayloadBytesError, verified } from "./bytes";
import { createHistoryClient, invalid, sameCapture } from "./client";
import * as codecs from "./codecs";
import { createVerifiedTransfer, type VerifiedTransfer } from "./transfer";
import type {
  Captured,
  CaptureChoice,
  DirectoryPage,
  DirectoryQuery,
  EventRecord,
  EventWindow,
  HistoryController,
  HistoryDraft,
  HistoryScope,
  HistoryState,
  PayloadItem,
  PayloadBytes,
  PayloadPart,
  SessionDetail,
  SessionTarget,
  WindowDirection,
} from "./types";
export function current<T>(state: ReadState<T>): T | undefined {
  return state.kind === "ready" ? state.value : state.kind === "idle" ? undefined : state.previous;
}
export function id(value: string): Identifier {
  const found = d.identifier.decode(d.jsonString(value));
  if (!found.ok)
    throw new PayloadBytesError(
      "Use an ASCII identifier of1–96 letters, digits, underscores or hyphens.",
    );
  return found.value;
}
export function decimal(value: string): Decimal {
  const found = d.decimal.decode(d.jsonString(value));
  if (!found.ok) throw new PayloadBytesError("Expected canonical decimal.");
  return found.value;
}
export function partKey(event: EventRecord["event_ref"], part: PayloadPart): string {
  return `${event.session_id}/${event.sequence}/${part.kind}${part.kind === "attachment" ? `/${part.index}` : ""}`;
}
export function partBlob(event: EventRecord, part: PayloadPart) {
  return part.kind === "payload"
    ? event.event.payload.blob
    : part.kind === "searchable_text"
      ? event.event.searchable_text?.blob
      : event.event.attachments[Number(part.index)];
}
export function partJson(part: PayloadPart) {
  return d.jsonObject(
    part.kind === "attachment"
      ? [
          ["kind", d.jsonString(part.kind)],
          ["index", d.jsonString(part.index)],
        ]
      : [["kind", d.jsonString(part.kind)]],
  );
}
export function refJson(ref: EventRecord["event_ref"]) {
  return d.jsonObject([
    ["session_id", d.jsonString(ref.session_id)],
    ["sequence", d.jsonString(ref.sequence)],
  ]);
}
const defaultQuery: DirectoryQuery = { order: "last_event_at", includeArchived: false, runId: "" };
const failure = (message: string): HttpResult<never> => ({
  ok: false,
  failure: { kind: "input", message },
});
/** The slot publishes current unexpected failures and suppresses obsolete ones.
 * Consume its rethrow here instead of republishing it through the global handler. */
async function observedRead<T>(
  read: Promise<ReadCompletion<T>>,
): Promise<ReadCompletion<T> | null> {
  try {
    return await read;
  } catch {
    return null;
  }
}
const snapshot = (context: FeatureContext): FeatureContext =>
  Object.freeze({
    ...context,
    connection: Object.freeze({ ...context.connection }),
    writer: Object.freeze({ ...context.writer }),
    route: Object.freeze({ ...context.route }),
  });
export function createHistoryController({
  http,
  operations,
  verifiedTransfer,
}: {
  readonly http: HttpClient;
  readonly operations: OperationController;
  readonly verifiedTransfer?: VerifiedTransfer;
}): HistoryController {
  const api = createHistoryClient(http),
    directory = createReadSlot<Captured<DirectoryPage>>(),
    session = createReadSlot<Captured<SessionDetail>>(),
    window = createReadSlot<Captured<EventWindow>>(),
    batch = createReadSlot<Captured<readonly PayloadItem[]>>(),
    transfer = verifiedTransfer ?? createVerifiedTransfer();
  let passiveWindowAbort: AbortController | null = null;
  let moreAbort: AbortController | null = null;
  let state: HistoryState = {
    scope: null,
    historicalGeneration: false,
    query: defaultQuery,
    directory: directory.get(),
    session: session.get(),
    window: window.get(),
    payloadBatch: batch.get(),
    payloads: new Map(),
    projections: new Map(),
    projecting: false,
    payloadFailure: null,
    expanding: false,
    selectedPart: null,
    followLatest: false,
    loadingMore: false,
    readingEvents: false,
    format: "auto",
    draft: null,
    transfer: { kind: "idle" },
    unexpected: null,
  };
  let context: FeatureContext | null = null,
    target: SessionTarget | null = null,
    selectedKey = "",
    disposed = false,
    epoch = 0;
  let expansion: AbortController | null = null,
    projection: AbortController | null = null,
    download: AbortController | null = null;
  const preferences = new Map<string, FormatSelection>(),
    listeners = new Set<() => void>();
  const publish = (patch: Partial<HistoryState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  for (const [slot, key] of [
    [directory, "directory"],
    [session, "session"],
    [window, "window"],
    [batch, "payloadBatch"],
  ] as const)
    slot.subscribe(() => publish({ [key]: slot.get() }));
  const unexpected = (error: unknown) => publish({ unexpected: { error } });
  const run = (work: Promise<unknown>) => {
    void work.catch(unexpected);
  };
  const scopeKey = (scope: HistoryScope) =>
    JSON.stringify([scope.connectionId, scope.generation, scope.workspaceId]);
  const active = (identity: number) => !disposed && epoch === identity;
  const preferenceKey = () =>
    state.scope === null || target === null ? "" : `${scopeKey(state.scope)}/${target.sessionId}`;
  const cancelExpansion = () => {
    expansion?.abort();
    expansion = null;
    publish({ expanding: false });
  };
  const resetPayloads = () => {
    moreAbort?.abort();
    moreAbort = null;
    publish({ loadingMore: false, readingEvents: false });
    cancelExpansion();
    projection?.abort();
    batch.clear();
    publish({
      payloads: new Map(),
      projections: new Map(),
      projecting: false,
      payloadFailure: null,
      selectedPart: null,
    });
  };
  async function projectVisible(identity: number, staged?: Captured<EventWindow>) {
    projection?.abort();
    const controller = new AbortController();
    projection = controller;
    const capture = staged ?? current(window.get()),
      scope = state.scope;
    if (!capture || !scope) return;
    const selection = state.format;
    publish({ projecting: true });
    // Retain already verified projections for unchanged immutable payloads while
    // a passive refresh processes the new window. Dropping the whole map after
    // the first result briefly rendered every other message as generic JSON.
    const projected = new Map<string, ProjectionResult>();
    for (const event of capture.data.items) {
      const key = partKey(event.event_ref, { kind: "payload" });
      const prior = state.projections.get(key),
        payload = state.payloads.get(key);
      if (
        prior &&
        payload?.complete &&
        prior.selection === selection &&
        prior.capture.bytes.length === payload.bytes.length
      )
        projected.set(key, prior);
    }
    try {
      for (const event of capture.data.items) {
        if (!active(identity) || controller.signal.aborted) return;
        const key = partKey(event.event_ref, { kind: "payload" }),
          payload = state.payloads.get(key);
        if (!payload || projected.has(key)) continue;
        const result = await projectCapturedPayloadAsync(
          http.processing,
          {
            captureId: `${scopeKey(scope)}/${capture.capture.head}/${key}`,
            scopeId: [
              scope.connectionId,
              scope.generation,
              scope.workspaceId,
              event.event_ref.session_id,
            ],
            metadata: d.jsonObject([
              ["role", d.jsonString(event.event.role)],
              ["kind", d.jsonString(event.event.kind)],
              ["phase", d.jsonString(event.event.phase)],
              ["provenance", event.event.provenance],
            ]),
            bytes: payload.bytes,
            completeness: payload.complete ? "complete" : "partial",
            producer: null,
          },
          selection,
          controller.signal,
        );
        if (controller.signal.aborted || !active(identity)) return;
        if (result.ok) {
          projected.set(key, result.value);
        } else if (result.failure.kind !== "aborted")
          publish({ payloadFailure: { kind: "input", message: result.failure.message } });
      }
    } catch (error: unknown) {
      if (active(identity) && !controller.signal.aborted) throw error;
    } finally {
      if (active(identity) && !controller.signal.aborted)
        publish({ projections: new Map(projected), projecting: false });
    }
  }
  async function loadBatch(
    capture: Captured<EventWindow>,
    scope: HistoryScope,
    identity: number,
    passive?: AbortSignal,
    fullWindow?: Captured<EventWindow>,
  ) {
    if (capture.data.items.length === 0) return true;
    publish({ payloadFailure: null });
    const refs = capture.data.items.map((item) => item.event_ref);
    const payloads = new Map<string, PayloadBytes>(state.payloads);
    const result = await observedRead(
      batch.load(
        JSON.stringify([scopeKey(scope), capture.capture.head, refs.map((ref) => ref.sequence)]),
        async (signal) => {
          const read = await api.read(
            scope,
            "history.payloads",
            { kind: "pinned", head: capture.capture.head },
            [
              ["event_refs", d.jsonArray(refs.map(refJson))],
              ["length", d.jsonString("32768")],
            ],
            codecs.payloadBatch,
            signal,
          );
          if (!read.ok) return read;
          if (
            !sameCapture(read.data.capture, capture.capture) ||
            read.data.data.items.length !== refs.length ||
            read.data.data.items.some(
              (item, index) =>
                item.event_ref.session_id !== refs[index]?.session_id ||
                item.event_ref.sequence !== refs[index]?.sequence,
            )
          )
            return invalid(
              "Payload batch changed the captured refs/order or omitted requested items.",
            );
          // Complete each ordinary event before admitting this page. A JSON prefix
          // cannot identify a tool result reliably, even when its call ID is visible.
          // Sequential continuations use the batch's cancellation lifetime and pin.
          try {
            for (const [index, item] of read.data.data.items.entries()) {
              const event = capture.data.items[index];
              if (!event) throw new Error("Validated payload order lost its event.");
              const key = partKey(item.event_ref, { kind: "payload" });
              const retained = payloads.get(key);
              const blob = event.event.payload.blob;
              let bytes = chunkBytes(item.payload, blob, 0, 32768);
              if (
                retained?.complete &&
                retained.verified &&
                retained.blob.digest === blob.digest &&
                retained.blob.size_bytes === blob.size_bytes
              )
                continue;
              let offset = item.payload.next_offset;
              let complete = !item.payload.has_more;
              if (!complete && BigInt(blob.size_bytes) <= BigInt(FORMAT_LIMITS.maxBytes)) {
                const assembled = new Uint8Array(Number(blob.size_bytes));
                assembled.set(bytes);
                while (!complete) {
                  if (signal.aborted || !active(identity))
                    return {
                      ok: false,
                      failure: { kind: "aborted", message: "History read cancelled." },
                    };
                  const next = await api.read(
                    scope,
                    "history.payload",
                    { kind: "pinned", head: capture.capture.head },
                    [
                      ["event_ref", refJson(item.event_ref)],
                      ["part", partJson({ kind: "payload" })],
                      ["offset", d.jsonString(offset)],
                      ["length", d.jsonString("262144")],
                    ],
                    codecs.payloadChunk,
                    signal,
                  );
                  if (!next.ok) return next;
                  if (!sameCapture(next.data.capture, capture.capture))
                    return invalid("Payload continuation changed capture.");
                  const chunk = chunkBytes(next.data.data, blob, Number(offset));
                  if (chunk.length === 0 && next.data.data.has_more)
                    return invalid("Positive-length payload retrieval did not advance.");
                  assembled.set(chunk, Number(offset));
                  offset = next.data.data.next_offset;
                  complete = !next.data.data.has_more;
                }
                bytes = assembled;
              }
              if (complete && !(await verified(bytes, blob)))
                return invalid("Complete payload digest differs from its pinned blob.");
              if (signal.aborted || !active(identity))
                return {
                  ok: false,
                  failure: { kind: "aborted", message: "History read cancelled." },
                };
              payloads.set(key, {
                event: item.event_ref,
                part: { kind: "payload" },
                blob,
                bytes,
                nextOffset: offset,
                complete,
                verified: complete,
              });
            }
          } catch (error: unknown) {
            if (signal.aborted || !active(identity))
              return {
                ok: false,
                failure: { kind: "aborted", message: "History read cancelled." },
              };
            if (error instanceof PayloadBytesError) return invalid(error.message);
            throw error;
          }
          return { ...read, data: { data: read.data.data.items, capture: read.data.capture } };
        },
        { ...(passive === undefined ? {} : { signal: passive, background: true }) },
      ),
    );
    if (result === null || !result.ok || !active(identity) || passive?.aborted) return false;
    if (active(identity)) {
      publish({ payloads });
      await projectVisible(identity, fullWindow);
      return active(identity) && !passive?.aborted && state.payloadFailure === null;
    }
    return false;
  }
  async function loadWindow(
    direction: WindowDirection,
    anchor: Decimal,
    passive?: AbortSignal,
    append = false,
    fixedDetail?: Captured<SessionDetail>,
  ) {
    const detail = fixedDetail ?? current(session.get()),
      scope = state.scope;
    if (!detail || !scope) return;
    const identity = ++epoch,
      selected = target;
    if (!passive && !append) resetPayloads();
    const previous = current(window.get());
    publish({ readingEvents: true });
    try {
      const result = await observedRead(
        window.load(
          JSON.stringify([
            scopeKey(scope),
            detail.capture.head,
            detail.data.session.session_id,
            direction,
            anchor,
          ]),
          async (signal) => {
            const read = await api.read(
              scope,
              "history.read",
              { kind: "pinned", head: detail.capture.head },
              [
                ["session_id", d.jsonString(detail.data.session.session_id)],
                ["direction", d.jsonString(direction)],
                ["anchor", d.jsonString(anchor)],
                [
                  "limit",
                  d.jsonString(
                    selected?.sequence !== undefined && direction === "around" ? "1" : "60",
                  ),
                ],
              ],
              codecs.eventWindow,
              signal,
            );
            if (!read.ok) return read;
            const page = read.data.data;
            if (
              !sameCapture(detail.capture, read.data.capture) ||
              page.session_id !== detail.data.session.session_id ||
              page.through !== detail.data.through ||
              page.items.some(
                (item, index) =>
                  item.event_ref.session_id !== page.session_id ||
                  BigInt(item.event_ref.sequence) > BigInt(page.through) ||
                  (direction === "before"
                    ? BigInt(item.event_ref.sequence) >= BigInt(anchor)
                    : direction === "after" && BigInt(item.event_ref.sequence) <= BigInt(anchor)) ||
                  (index > 0 &&
                    (direction === "before"
                      ? BigInt(item.event_ref.sequence) >=
                        BigInt(page.items[index - 1]!.event_ref.sequence)
                      : BigInt(item.event_ref.sequence) <=
                        BigInt(page.items[index - 1]!.event_ref.sequence))),
              ) ||
              (page.items.length > 0 && page.next_anchor !== page.items.at(-1)?.event_ref.sequence)
            )
              return invalid("History window changed capture, bounds, order or continuation.");
            if (
              selected?.sequence !== undefined &&
              direction === "around" &&
              !page.items.some((item) => item.event_ref.sequence === selected.sequence)
            )
              return invalid(
                "The exact linked event is unavailable in this captured window; no current event was substituted.",
              );
            let combined = read.data;
            if (append && previous) {
              if (
                previous.data.session_id !== page.session_id ||
                BigInt(previous.data.through) > BigInt(page.through) ||
                page.items.some((item) =>
                  previous.data.items.some(
                    (old) => old.event_ref.sequence === item.event_ref.sequence,
                  ),
                ) ||
                (page.has_more && page.items.length === 0)
              )
                return invalid("History continuation repeated events or moved backwards.");
              combined = {
                ...read.data,
                data: { ...page, items: [...previous.data.items, ...page.items] },
              };
            }
            // Publish appended rows only after their bodies and projections are
            // ready. Cancellation retains the previous complete visible window.
            const loaded = await loadBatch(read.data, scope, identity, signal, combined);
            if (!loaded)
              return invalid(
                "Message bodies could not finish loading. Previously displayed messages are retained; retry loading.",
              );
            return { ...read, data: combined };
          },
          passive === undefined
            ? {}
            : {
                signal: passive,
                background: true,
                ...(previous === undefined ? {} : { previous }),
              },
        ),
      );
      return !!result?.ok && active(identity) && !passive?.aborted;
    } finally {
      if (active(identity)) publish({ readingEvents: false });
    }
  }
  async function loadMore(all = false) {
    if (
      moreAbort ||
      state.expanding ||
      state.readingEvents ||
      state.projecting ||
      state.window.kind === "loading"
    )
      return;
    const detail = current(session.get()),
      first = current(window.get());
    if (!detail || !first) return;
    const owner = new AbortController();
    moreAbort = owner;
    const savedTarget = target;
    publish({ loadingMore: true });
    try {
      do {
        const shown = current(window.get());
        const last = shown?.data.items.at(-1)?.event_ref.sequence ?? decimal("0");
        if (
          owner.signal.aborted ||
          target !== savedTarget ||
          BigInt(last) >= BigInt(detail.data.through)
        )
          break;
        if (!(await loadWindow("after", last, owner.signal, true, detail))) break;
      } while (all && !owner.signal.aborted);
    } finally {
      if (moreAbort === owner) {
        moreAbort = null;
        publish({ loadingMore: false });
      }
    }
  }
  async function loadSession(selected: SessionTarget) {
    const scope = state.scope;
    if (!scope) return;
    const identity = ++epoch;
    target = selected;
    publish({
      followLatest: false,
    });
    window.clear();
    resetPayloads();
    publish({ format: preferences.get(preferenceKey()) ?? "auto" });
    const result = await observedRead(
      session.load(
        JSON.stringify([
          scopeKey(scope),
          selected.sessionId,
          selected.capture,
          selected.sequence ?? null,
        ]),
        async (signal) => {
          const read = await api.read(
            scope,
            "session.get",
            selected.capture,
            [["session_id", d.jsonString(selected.sessionId)]],
            codecs.sessionDetail,
            signal,
            "visible",
          );
          if (!read.ok) return read;
          const through = read.data.capture.sessions.find(
            (item) => item.session_id === selected.sessionId,
          )?.through;
          if (
            read.data.data.session.workspace_id !== scope.workspaceId ||
            read.data.data.session.session_id !== selected.sessionId ||
            through !== read.data.data.through
          )
            return invalid("Session result disagrees with its captured session bound.");
          if (selected.sequence !== undefined && BigInt(selected.sequence) > BigInt(through))
            return invalid("The linked event does not exist at this captured head.");
          return read;
        },
        { live: selected.capture.kind === "current" },
      ),
    );
    if (result?.ok && active(identity))
      await loadWindow(
        selected.sequence === undefined ? "after" : "around",
        selected.sequence ?? decimal("0"),
      );
  }
  async function loadDirectory(query: DirectoryQuery, next = false) {
    const scope = state.scope;
    if (!scope) return;
    const previous = current(directory.get());
    const capture: CaptureChoice =
      next && previous ? { kind: "pinned", head: previous.capture.head } : { kind: "current" };
    const offset = next && previous ? previous.data.next_offset : decimal("0");
    const frozen = Object.freeze({ ...query });
    publish({ query: frozen });
    await observedRead(
      directory.load(
        JSON.stringify([scopeKey(scope), frozen, capture, offset]),
        async (signal) => {
          if (frozen.runId !== "" && !d.identifier.decode(d.jsonString(frozen.runId)).ok)
            return failure("Run filter requires an exact resolved run ID.");
          const read = await api.read(
            scope,
            "session.list",
            capture,
            [
              ["order", d.jsonString(frozen.order)],
              ["include_archived", d.jsonBoolean(frozen.includeArchived)],
              ["offset", d.jsonString(offset)],
              ["limit", d.jsonString("25")],
              ...(frozen.runId === "" ? [] : [["run_id", d.jsonString(frozen.runId)] as const]),
            ],
            codecs.directoryPage,
            signal,
            "visible",
          );
          if (!read.ok) return read;
          if (
            read.data.data.next_offset !==
              String(BigInt(offset) + BigInt(read.data.data.items.length)) ||
            read.data.data.items.some(
              (item) =>
                item.workspace_id !== scope.workspaceId ||
                (!frozen.includeArchived && item.archived) ||
                (frozen.runId !== "" && item.run_id !== frozen.runId),
            ) ||
            (next && previous && !sameCapture(previous.capture, read.data.capture))
          )
            return invalid("Directory result changed its filter, capture or exact continuation.");
          if (next && previous) {
            const ids = new Set(previous.data.items.map((item) => item.session_id));
            if (read.data.data.items.some((item) => ids.has(item.session_id)))
              return invalid("Directory continuation repeated a session.");
            return {
              ...read,
              data: {
                ...read.data,
                data: {
                  ...read.data.data,
                  items: [...previous.data.items, ...read.data.data.items],
                },
              },
            };
          }
          return read;
        },
        { live: !next },
      ),
    );
  }
  function select(next: FeatureContext) {
    context = snapshot(next);
    const route = next.route,
      requestedGeneration = route.history?.generation ?? next.connection.generation;
    const key = JSON.stringify([
      next.connection.id,
      requestedGeneration,
      route.workspaceId,
      route.entityId,
      route.history ?? null,
    ]);
    if (selectedKey === key) {
      const historicalGeneration = requestedGeneration !== next.connection.generation;
      if (state.historicalGeneration !== historicalGeneration) publish({ historicalGeneration });
      return;
    }
    const sameDirectory =
      state.scope?.connectionId === next.connection.id &&
      state.scope.generation === requestedGeneration &&
      state.scope.workspaceId === route.workspaceId;
    selectedKey = key;
    target = null;
    ++epoch;
    session.clear();
    window.clear();
    if (!sameDirectory) directory.clear();
    resetPayloads();
    if (route.workspaceId === null) {
      publish({ scope: null });
      return;
    }
    const generation = d.positiveDecimal.decode(d.jsonString(requestedGeneration)),
      workspace = d.identifier.decode(d.jsonString(route.workspaceId));
    if (!generation.ok || !workspace.ok) {
      publish({
        scope: null,
        payloadFailure: {
          kind: "input",
          message: "History requires a valid workspace and exact generation.",
        },
      });
      return;
    }
    const scope: HistoryScope = {
      connectionId: next.connection.id,
      generation: generation.value,
      workspaceId: workspace.value,
    };
    publish({ scope, historicalGeneration: scope.generation !== next.connection.generation });
    const identity = epoch;
    run(
      (async () => {
        if (scope.generation !== next.connection.generation) {
          const attached = await createConnectionsClient(http)
            .attach({ ...next.connection, generation: scope.generation })
            .catch((error: unknown) => {
              if (active(identity)) throw error;
              return null;
            });
          if (attached === null) return;
          if (!active(identity)) return;
          if (
            !attached.ok ||
            attached.data.connection.id !== scope.connectionId ||
            attached.data.connection.generation !== scope.generation
          ) {
            await directory.load(key, () =>
              Promise.resolve(
                attached.ok
                  ? invalid("Retained generation resolution changed profile identity.")
                  : attached,
              ),
            );
            return;
          }
        }
        if (!sameDirectory || current(directory.get()) === undefined)
          run(loadDirectory(state.query));
        if (route.entityId !== null) {
          const selected: SessionTarget = {
            sessionId: id(route.entityId),
            capture:
              route.history === undefined
                ? { kind: "current" }
                : {
                    kind: "pinned",
                    head:
                      route.history.head === null
                        ? null
                        : (() => {
                            const found = d.digest.decode(d.jsonString(route.history.head));
                            if (!found.ok) throw new PayloadBytesError("Invalid capture digest.");
                            return found.value;
                          })(),
                  },
            ...(route.history?.sequence === undefined
              ? {}
              : { sequence: decimal(route.history.sequence) }),
          };
          await loadSession(selected);
        }
      })(),
    );
  }
  function expand(event: EventRecord, part: PayloadPart, complete = false) {
    const scope = state.scope,
      capture = current(window.get());
    if (!scope || !capture || !capture.data.items.includes(event)) return;
    const blob = partBlob(event, part);
    if (!blob) {
      publish({
        payloadFailure: { kind: "input", message: "This event has no selected retained part." },
      });
      return;
    }
    cancelExpansion();
    const controller = new AbortController();
    expansion = controller;
    const identity = epoch,
      key = partKey(event.event_ref, part);
    publish({ expanding: true, selectedPart: key, payloadFailure: null });
    run(
      (async () => {
        try {
          let previous = state.payloads.get(key),
            bytes = previous?.bytes ?? new Uint8Array(),
            offset = previous?.nextOffset ?? decimal("0");
          if (previous?.complete) return;
          const capacity = Math.min(
            Number(blob.size_bytes),
            complete ? 16 * 1024 * 1024 : bytes.length + 262144,
          );
          const assembled = new Uint8Array(capacity);
          assembled.set(bytes);
          do {
            if (bytes.length >= 16 * 1024 * 1024) {
              publish({
                payloadFailure: {
                  kind: "input",
                  message:
                    "Preview stops at 16 MiB. Use the independently verified full download for this file.",
                },
              });
              return;
            }
            const read = await api.read(
              scope,
              "history.payload",
              { kind: "pinned", head: capture.capture.head },
              [
                ["event_ref", refJson(event.event_ref)],
                ["part", partJson(part)],
                ["offset", d.jsonString(offset)],
                ["length", d.jsonString(String(Math.min(262144, 16 * 1024 * 1024 - bytes.length)))],
              ],
              codecs.payloadChunk,
              controller.signal,
            );
            if (controller.signal.aborted || !active(identity)) return;
            if (!read.ok) {
              publish({ payloadFailure: read.failure });
              return;
            }
            if (!sameCapture(read.data.capture, capture.capture))
              throw new PayloadBytesError("Payload continuation changed capture.");
            const chunk = chunkBytes(read.data.data, blob, Number(offset));
            if (chunk.length === 0 && read.data.data.has_more)
              throw new PayloadBytesError("Positive-length payload retrieval did not advance.");
            assembled.set(chunk, bytes.length);
            bytes = assembled.subarray(0, bytes.length + chunk.length);
            offset = read.data.data.next_offset;
            const done = !read.data.data.has_more;
            if (done && !(await verified(bytes, blob)))
              throw new PayloadBytesError("Assembled payload digest differs from its pinned blob.");
            if (controller.signal.aborted || !active(identity)) return;
            previous = {
              event: event.event_ref,
              part,
              blob,
              bytes,
              nextOffset: offset,
              complete: done,
              verified: done,
            };
            // Expanding source or attachment bytes must not evict complete
            // conversation bodies: that would break already visible tool pairs.
            const payloads = new Map(state.payloads);
            payloads.set(key, previous);
            publish({ payloads });
            if (done || !complete) break;
          } while (!controller.signal.aborted);
          if (part.kind === "payload") await projectVisible(identity);
        } catch (error: unknown) {
          if (!active(identity) || controller.signal.aborted) return;
          if (error instanceof PayloadBytesError) {
            if (active(identity) && !controller.signal.aborted)
              publish({
                payloadFailure: { kind: "protocol", message: error.message, issue: undefined },
              });
          } else throw error;
        } finally {
          if (active(identity) && !controller.signal.aborted) {
            expansion = null;
            publish({ expanding: false });
          }
        }
      })(),
    );
  }
  const newDraft = (selected: FeatureContext, kind: HistoryDraft["kind"], sessionId = "") => {
    if (state.draft !== null) return;
    if (selected.profileState !== "current") return;
    if (
      kind !== "create" &&
      ((selected.route.history !== undefined &&
        selected.route.history.generation !== selected.connection.generation) ||
        (state.scope !== null &&
          state.scope.connectionId === selected.connection.id &&
          state.scope.generation !== selected.connection.generation))
    ) {
      publish({
        payloadFailure: {
          kind: "input",
          message:
            "This session is viewed through a retained connection generation. Explicitly open the current target before creating an import/archive draft; the session ID was not transplanted to another daemon.",
        },
      });
      return;
    }
    publish({
      draft: {
        context: snapshot(selected),
        kind,
        sessionId,
        title: "",
        source: "[]",
        preparation: null,
        pending: false,
        issue: null,
        batches: [],
        batchIndex: 0,
      },
    });
  };
  async function reviewDraft() {
    const draft = state.draft;
    if (!draft || draft.pending || draft.preparation !== null) return;
    publish({ draft: { ...draft, pending: true, issue: null } });
    try {
      const saved = draft.context,
        actor = id(saved.writer.actorId ?? ""),
        workspace = id(saved.route.workspaceId ?? ""),
        sessionId = id(draft.sessionId);
      const runId = saved.writer.runId === null ? null : id(saved.writer.runId);
      const intention = id(`history-${crypto.randomUUID()}`);
      let batches = draft.batches,
        index = draft.batchIndex;
      const params: [string, JsonValue][] = [
        ["workspace_id", d.jsonString(workspace)],
        ["actor_id", d.jsonString(actor)],
        ["session_id", d.jsonString(sessionId)],
      ];
      if (runId !== null) params.push(["run_id", d.jsonString(runId)]);
      if (draft.kind === "create") {
        if (draft.title.length === 0)
          throw new PayloadBytesError("Enter a nonempty session title.");
        params.push(["title", d.jsonString(draft.title)]);
      }
      if (draft.kind === "import") {
        if (batches.length === 0) {
          const parsed = await http.processing.parse(draft.source, { limits: HTTP_LIMITS });
          if (!parsed.ok) throw new PayloadBytesError(parsed.failure.message);
          if (!parsed.value.ok) throw new PayloadBytesError(parsed.value.error.message);
          const value = parsed.value.value.value;
          if (
            value.kind !== "array" ||
            value.items.length === 0 ||
            value.items.length > 1024 ||
            value.items.some((item) => item.kind !== "object")
          )
            throw new PayloadBytesError(
              "Import expects1–1024 current event-input objects. Provider files require an explicit conversion outside this viewer.",
            );
          const objects: JsonObject[] = [];
          for (const item of value.items) if (item.kind === "object") objects.push(item);
          const planned: (readonly JsonObject[])[] = [];
          for (let start = 0; start < objects.length; start += 128)
            planned.push(Object.freeze(objects.slice(start, start + 128)));
          batches = Object.freeze(planned);
          index = 0;
        }
        const events = batches[index];
        if (!events) throw new PayloadBytesError("No remaining import batch.");
        params.push(["events", d.jsonArray(events)]);
      }
      const preparation: Preparation = {
        intention_id: intention,
        connection_id: saved.connection.id,
        generation: saved.connection.generation,
        context: {
          workspace_id: workspace,
          project_id: saved.route.projectId === null ? null : id(saved.route.projectId),
          writer: { actor_id: actor, run_id: runId },
        },
        method:
          draft.kind === "create"
            ? "session.create"
            : draft.kind === "archive"
              ? "session.archive"
              : "session.append",
        params: d.jsonObject(params),
      };
      // Capture/freeze draft before await; callers cannot edit it during admission.
      const frozen = {
        ...draft,
        pending: true,
        preparation,
        batches,
        batchIndex: index,
        issue: null,
      };
      publish({ draft: frozen });
      const registered = await operations.register(preparation);
      if (state.draft?.preparation !== preparation) return;
      if (!registered.ok) {
        publish({
          draft: {
            ...frozen,
            pending: false,
            preparation: null,
            issue:
              registered.failure.kind === "aborted"
                ? "Admission cancelled."
                : registered.failure.kind === "remote"
                  ? registered.failure.problem.message
                  : registered.failure.message,
          },
        });
        return;
      }
      const prepared = await operations.act(intention, "prepare");
      if (state.draft?.preparation === preparation)
        publish({
          draft: {
            ...frozen,
            pending: false,
            issue: prepared.ok
              ? null
              : prepared.failure.kind === "aborted"
                ? "Preparation observation cancelled; preserve this intention."
                : prepared.failure.kind === "remote"
                  ? prepared.failure.problem.message
                  : prepared.failure.message,
          },
        });
    } catch (error: unknown) {
      if (error instanceof PayloadBytesError) {
        if (state.draft?.pending)
          publish({ draft: { ...state.draft, pending: false, issue: error.message } });
      } else {
        unexpected(error);
        throw error;
      }
    }
  }
  return {
    refreshLive: async (signal) => {
      const result = await refreshSlots([directory, session], signal);
      const detail = current(session.get()),
        displayed = current(window.get());
      if (
        !signal.aborted &&
        state.followLatest &&
        target?.capture.kind === "current" &&
        detail &&
        displayed &&
        detail.data.session.session_id === displayed.data.session_id &&
        (detail.data.through !== displayed.data.through ||
          window.get().kind === "failed" ||
          batch.get().kind === "failed") &&
        !state.expanding &&
        !state.loadingMore &&
        !state.readingEvents &&
        !state.projecting &&
        state.window.kind !== "loading"
      ) {
        const owner = new AbortController();
        passiveWindowAbort = owner;
        try {
          await loadWindow(
            "after",
            displayed.data.items.at(-1)?.event_ref.sequence ?? decimal("0"),
            AbortSignal.any([signal, owner.signal]),
            true,
            detail,
          );
        } finally {
          if (passiveWindowAbort === owner) passiveWindowAbort = null;
        }
      }
      const failed =
        window.get().kind === "failed" ||
        batch.get().kind === "failed" ||
        state.payloadFailure !== null;
      return {
        ...result,
        ok: result.ok && !failed,
        retainedCapture: result.retainedCapture || !state.followLatest,
      };
    },
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    select,
    directory: (query, next) => run(loadDirectory(query, next)),
    open: (sessionId) => {
      if (context) {
        const route = clearHistoryTarget(context.route);
        context.navigate({ ...route, view: "history", entityId: sessionId });
      }
    },
    window: (direction, anchor) => {
      publish({ followLatest: false });
      run(loadWindow(direction, anchor));
    },
    loadMore: (all) => run(loadMore(all)),
    cancelLoadMore: () => moreAbort?.abort(),
    setFollowing: (follow) => {
      const allowed = follow && target?.capture.kind === "current";
      if (!allowed) passiveWindowAbort?.abort();
      if (state.followLatest !== allowed) publish({ followLatest: allowed });
    },
    pauseFollowing: () => {
      passiveWindowAbort?.abort();
      if (state.followLatest) publish({ followLatest: false });
    },
    refresh: () => {
      if (context?.route.history !== undefined) {
        const route = clearHistoryTarget(context.route);
        context.navigate(route);
      } else if (target)
        run(loadSession({ sessionId: target.sessionId, capture: { kind: "current" } }));
      run(loadDirectory(state.query));
    },
    expand,
    cancelExpansion,
    setFormat: (format) => {
      preferences.set(preferenceKey(), format);
      publish({ format });
      run(projectVisible(epoch));
    },
    newDraft,
    editDraft: (patch) => {
      const draft = state.draft;
      if (draft && !draft.pending && draft.preparation === null && draft.batchIndex === 0)
        publish({ draft: { ...draft, ...patch, issue: null, batches: [], batchIndex: 0 } });
    },
    discardDraft: () => {
      if (!state.draft?.pending) publish({ draft: null });
    },
    reviewDraft,
    nextImportBatch: () => {
      const draft = state.draft;
      if (draft?.kind !== "import" || draft.preparation === null || draft.pending) return;
      const previous = operations.get(draft.preparation.intention_id);
      if (previous?.operation?.state.kind !== "committed") return;
      if (draft.batchIndex + 1 < draft.batches.length)
        publish({
          draft: { ...draft, preparation: null, batchIndex: draft.batchIndex + 1, issue: null },
        });
    },
    download: (event, part) => {
      const scope = state.scope,
        capture = current(window.get()),
        blob = partBlob(event, part);
      if (!scope || !capture || !blob || !capture.data.items.includes(event) || download !== null)
        return;
      const controller = new AbortController();
      download = controller;
      const origin = `Connection ${scope.connectionId} generation ${scope.generation} · workspace ${scope.workspaceId} · session ${event.event_ref.session_id} event ${event.event_ref.sequence} · ${part.kind}${part.kind === "attachment" ? ` ${part.index}` : ""} · capture ${capture.capture.head ?? "empty"}`;
      const label = `${event.event_ref.session_id}-${event.event_ref.sequence}-${part.kind}${part.kind === "attachment" ? `-${part.index}` : ""}.bin`;
      run(
        transfer
          .download(
            blob,
            {
              read: async (offset, signal) => {
                const result = await api.read(
                  scope,
                  "history.payload",
                  { kind: "pinned", head: capture.capture.head },
                  [
                    ["event_ref", refJson(event.event_ref)],
                    ["part", partJson(part)],
                    ["offset", d.jsonString(offset)],
                    ["length", d.jsonString("262144")],
                  ],
                  codecs.payloadChunk,
                  signal,
                );
                return result.ok
                  ? sameCapture(capture.capture, result.data.capture)
                    ? { ...result, data: result.data.data }
                    : invalid("Download changed captured head.")
                  : result;
              },
            },
            (received, total) =>
              publish({ transfer: { kind: "loading", received, total, label, origin } }),
            controller.signal,
          )
          .then((result) => {
            publish({
              transfer: result.ok
                ? { kind: "complete", blob: result.blob, digest: blob.digest, label, origin }
                : { kind: "failed", message: result.message },
            });
          })
          .finally(() => {
            if (download === controller) download = null;
          }),
      );
    },
    cancelDownload: () => download?.abort(),
    dispose: () => {
      moreAbort?.abort();
      passiveWindowAbort?.abort();
      disposed = true;
      ++epoch;
      expansion?.abort();
      projection?.abort();
      download?.abort();
      transfer.dispose();
      directory.dispose();
      session.dispose();
      window.dispose();
      batch.dispose();
      listeners.clear();
    },
  };
}
