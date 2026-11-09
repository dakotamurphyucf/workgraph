import type { LiveRefreshResult } from "./live-types";
import { jsonArray, jsonNull, jsonString } from "../protocol/decoders";
import type { ProtocolProcessor } from "../protocol/worker";
import { OPERATION_LIMITS } from "../protocol/worker/jobs";
import { stringifyJson, type JsonValue } from "../json";
import type { HttpFailure, HttpResult } from "../protocol/http";
import type { Decimal, Digest, Identifier } from "../protocol/types";

export type HistoryCapture =
  | { readonly kind: "current" }
  | { readonly kind: "empty" }
  | { readonly kind: "pinned"; readonly head: Digest };
export interface ReadScope {
  readonly connectionId: Identifier;
  readonly generation: Decimal;
  readonly workspaceId: Identifier | undefined;
  readonly projectId: Identifier | undefined;
  readonly actorId: Identifier | undefined;
  readonly runId: Identifier | undefined;
  readonly history: HistoryCapture;
}
export type ReadState<T> =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly key: string; readonly previous: T | undefined }
  | { readonly kind: "ready"; readonly key: string; readonly value: T }
  | {
      readonly kind: "failed";
      readonly key: string;
      readonly previous: T | undefined;
      readonly failure: HttpFailure;
    }
  | {
      readonly kind: "unexpected_error";
      readonly key: string;
      readonly previous: T | undefined;
      readonly error: unknown;
    };
export type ReadCompletion<T> = HttpResult<T> | { readonly ok: false; readonly superseded: true };
export interface ReadOptions<T> {
  readonly signal?: AbortSignal;
  /** Quiet passive publication preserves the rendered projection during I/O. */
  readonly background?: boolean;
  /** Explicit same-entity carryover across a new capture key. The controller
   * must verify endpoint and selection before supplying this value. */
  readonly previous?: T;
  /** Only a current projection may explicitly opt into replay. */
  readonly live?: boolean;
  readonly after?: (value: T, signal: AbortSignal) => Promise<void>;
}
export interface ReadSlot<T> {
  readonly get: () => ReadState<T>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly load: (
    key: string,
    read: (signal: AbortSignal) => Promise<HttpResult<T>>,
    options?: ReadOptions<T>,
  ) => Promise<ReadCompletion<T>>;
  readonly refresh: (signal: AbortSignal) => Promise<LiveRefreshResult>;
  readonly clear: () => void;
  readonly dispose: () => void;
}

/**
 * Small known-field queries only. Arbitrary parameters use readKeyAsync.
 * Identity includes the effective writer and exact query/capture. Undefined and
 * empty-history are explicitly distinct. Only known strings enter JSON.stringify.
 */
export function readKey(scope: ReadScope, method: string, params: JsonValue): string {
  const encoded = stringifyJson(params);
  if (!encoded.ok) throw new Error(`Invalid bounded query parameters: ${encoded.error.message}`);
  return JSON.stringify([
    scope.connectionId,
    scope.generation,
    scope.workspaceId ?? null,
    scope.projectId ?? null,
    scope.actorId ?? null,
    scope.runId ?? null,
    scope.history.kind,
    scope.history.kind === "pinned" ? scope.history.head : null,
    method,
    encoded.value,
  ]);
}

/** Arbitrary/large query identities use the worker; all scope strings are captured before yielding. */
export function readKeyAsync(
  processing: ProtocolProcessor,
  scope: ReadScope,
  method: string,
  params: JsonValue,
  signal?: AbortSignal,
) {
  const nullable = (value: string | undefined) =>
    value === undefined ? jsonNull() : jsonString(value);
  const value = jsonArray([
    jsonString(scope.connectionId),
    jsonString(scope.generation),
    nullable(scope.workspaceId),
    nullable(scope.projectId),
    nullable(scope.actorId),
    nullable(scope.runId),
    jsonString(scope.history.kind),
    scope.history.kind === "pinned" ? jsonString(scope.history.head) : jsonNull(),
    jsonString(method),
    params,
  ]);
  return processing.encode(value, {
    canonical: true,
    limits: OPERATION_LIMITS,
    ...(signal === undefined ? {} : { signal }),
  });
}

/**
 * One visible read location, owned by a component/controller. Cancellation is
 * paired with an identity check because transports may ignore AbortSignal.
 * Previous results survive refresh failures only for the exact same query key.
 */
export function createReadSlot<T>(): ReadSlot<T> {
  let state: ReadState<T> = { kind: "idle" };
  let pending: { readonly identity: object; readonly controller: AbortController } | undefined;
  let disposed = false;
  let live:
    | {
        key: string;
        read: (signal: AbortSignal) => Promise<HttpResult<T>>;
        after: ReadOptions<T>["after"];
      }
    | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: ReadState<T>): void => {
    state = next;
    for (const listener of listeners) listener();
  };
  const cancel = (): void => {
    const previous = pending;
    pending = undefined;
    previous?.controller.abort();
  };
  const previousFor = (key: string): T | undefined => {
    if (state.kind === "idle" || state.key !== key) return undefined;
    return state.kind === "ready" ? state.value : state.previous;
  };
  const slot: ReadSlot<T> = {
    get: () => state,
    subscribe: (listener) => {
      if (disposed) throw new Error("Read slot has been disposed.");
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load: async (key, read, options = {}) => {
      if (disposed) throw new Error("Read slot has been disposed.");
      if (options.signal?.aborted) return { ok: false, superseded: true };
      const previous = options.previous ?? previousFor(key);
      live = options.live ? { key, read, after: options.after } : undefined;
      cancel();
      const identity = {};
      const controller = new AbortController();
      pending = { identity, controller };
      const before = state;
      const abort = () => {
        if (pending?.identity !== identity) return;
        cancel();
        if (!options.background) publish(before);
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      if (!options.background) publish({ kind: "loading", key, previous });
      try {
        const result = await read(controller.signal);
        if (disposed || pending?.identity !== identity) return { ok: false, superseded: true };
        publish(
          result.ok
            ? { kind: "ready", key, value: result.data }
            : { kind: "failed", key, previous, failure: result.failure },
        );
        if (
          result.ok &&
          options.after !== undefined &&
          pending?.identity === identity &&
          !controller.signal.aborted
        )
          await options.after(result.data, controller.signal);
        return disposed || pending?.identity !== identity
          ? { ok: false, superseded: true }
          : result;
      } catch (error: unknown) {
        if (!disposed && pending?.identity === identity)
          publish({ kind: "unexpected_error", key, previous, error });
        throw error;
      } finally {
        options.signal?.removeEventListener("abort", abort);
        if (pending?.identity === identity) pending = undefined;
      }
    },
    refresh: async (signal) => {
      const captured = live;
      if (captured === undefined) return { ok: true, retainedCapture: state.kind !== "idle" };
      // Foreground reads own their slot. A later owner tick can catch up.
      if (pending !== undefined || signal.aborted) return { ok: true };
      const result = await slot.load(captured.key, captured.read, {
        signal,
        background: true,
        live: true,
        ...(captured.after === undefined ? {} : { after: captured.after }),
      });
      return { ok: result.ok || "superseded" in result };
    },
    clear: () => {
      cancel();
      live = undefined;
      publish({ kind: "idle" });
    },
    dispose: () => {
      cancel();
      disposed = true;
      live = undefined;
      listeners.clear();
      state = { kind: "idle" };
    },
  };
  return slot;
}

/** Serial passive reads leave capacity for user actions and never retry writes. */
export async function refreshSlots(
  slots: readonly Pick<ReadSlot<unknown>, "refresh">[],
  signal: AbortSignal,
): Promise<LiveRefreshResult> {
  let ok = true,
    retainedCapture = false;
  for (const slot of slots) {
    if (signal.aborted) break;
    const result = await slot.refresh(signal);
    ok = ok && result.ok;
    retainedCapture ||= result.retainedCapture === true;
  }
  return { ok, retainedCapture };
}
