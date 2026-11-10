import { jsonField } from "../json";
import type { HttpFailure } from "../protocol/http";
import type {
  LiveAdapter,
  LiveChangeReader,
  LiveCursor,
  LiveReadOwner,
  LiveScope,
  LiveStatus,
  LiveSource,
} from "./live-types";
interface OwnerOptions {
  readonly reader: LiveChangeReader;
  readonly now?: () => number;
  readonly fallbackMs?: number;
  readonly debounceMs?: number;
}
const initial: LiveStatus = {
  kind: "paused",
  lastSuccessMs: null,
  failures: 0,
  retainedCapture: false,
};
const capacityUnavailable = (failure: HttpFailure) => {
  if (failure.kind !== "remote" || failure.problem.details === undefined) return false;
  const meter = jsonField(failure.problem.details, "meter");
  return meter?.kind === "string" && meter.value === "ui-live-observations";
};
const invalidCursor = (failure: HttpFailure) =>
  failure.kind === "remote" &&
  ["Conflict", "Invalid_argument", "Unsupported_version"].includes(failure.problem.kind) &&
  failure.problem.message.includes("feed cursor");
/** One observation flight, one serial projection refresh, and a bounded debounce.
 * Transient transport failures retain both cursors and already rendered content.
 * Healthy idle waits never trigger projected reads. */
export function createLiveReadOwner({
  reader,
  now = Date.now,
  fallbackMs = 15000,
  debounceMs = 250,
}: OwnerOptions): LiveReadOwner {
  let state = initial,
    disposed = false,
    epoch = 0;
  type Observation = {
    readonly key: string;
    readonly scope: LiveScope;
    readonly sources: readonly LiveSource[];
    readonly abort: AbortController;
  };
  let observation: Observation | null = null;
  let observationFailures = 0,
    projectionFailures = 0;
  const observationKey = (scope: LiveScope, sources: readonly LiveSource[]) =>
    JSON.stringify([
      scope.connection.id,
      scope.connection.generation,
      scope.connection.socket,
      scope.workspaceId,
      [...sources].sort(),
    ]);
  const observing = (captured: Observation) =>
    !disposed && observation === captured && !captured.abort.signal.aborted;
  const stopObservation = () => {
    const previous = observation;
    observation = null;
    previous?.abort.abort(); // Reader sends server-side cancellation and drains HTTP.
    observationFailed = false;
    observationFailures = 0;
  };
  let selected: { scope: LiveScope; adapter: LiveAdapter; identity: object } | null = null;
  let abort = new AbortController();
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let projectionFailed = false;
  let flight: Promise<void> | null = null,
    dirty = false,
    observationFailed = false;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<LiveStatus>) => {
    if (disposed) return;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener();
  };
  const active = (owner: number, signal: AbortSignal) =>
    !disposed && epoch === owner && !signal.aborted;
  const retryMs = 1000;
  const failed = (source: "observation" | "projection") => {
    if (source === "observation") observationFailures++;
    else projectionFailures++;
    publish({
      kind:
        observationFailures > 0
          ? observationFailures >= 3
            ? "offline"
            : "reconnecting"
          : "refresh_failed",
      failures: Math.max(observationFailures, projectionFailures),
    });
  };
  const success = (retainedCapture = state.retainedCapture) => {
    publish({
      kind: observationFailed
        ? observationFailures >= 3
          ? "offline"
          : "reconnecting"
        : projectionFailed
          ? "refresh_failed"
          : "live",
      failures: Math.max(observationFailures, projectionFailures),
      lastSuccessMs: !observationFailed && !projectionFailed ? now() : state.lastSuccessMs,
      retainedCapture,
    });
  };
  const stopProjection = () => {
    epoch++;
    abort.abort();
    if (debounce !== undefined) clearTimeout(debounce);
    if (retry !== undefined) clearTimeout(retry);
    retry = undefined;
    projectionFailed = false;
    projectionFailures = 0;
    debounce = undefined;
    dirty = false;
    flight = null;
  };
  const pauseFor = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const id = setTimeout(done, ms);
      function done() {
        clearTimeout(id);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
    });
  function refresh(): Promise<void> {
    if (disposed || selected === null || abort.signal.aborted) return Promise.resolve();
    dirty = true;
    if (flight !== null) return flight;
    const captured = selected,
      owner = epoch,
      signal = abort.signal;
    const task = (async () => {
      while (dirty && active(owner, signal)) {
        dirty = false;
        try {
          const result = await captured.adapter.refresh(signal);
          if (!active(owner, signal)) return;
          projectionFailed = !result.ok;
          if (result.ok) {
            projectionFailures = 0;
            success(result.retainedCapture === true);
          } else {
            failed("projection");
            dirty = false;
          }
        } catch {
          // The passive slots retain errors with their exact read identity.
          if (active(owner, signal)) {
            projectionFailed = true;
            failed("projection");
            dirty = false;
          }
        }
      }
    })().finally(() => {
      if (flight !== task) return;
      flight = null;
      if (retry !== undefined) clearTimeout(retry);
      retry = undefined;
      if (projectionFailed && active(owner, signal))
        retry = setTimeout(() => {
          retry = undefined;
          if (active(owner, signal)) void refresh();
        }, retryMs);
    });
    flight = task;
    return task;
  }
  function schedule(owner: number, signal: AbortSignal) {
    if (debounce !== undefined) return;
    debounce = setTimeout(() => {
      debounce = undefined;
      if (active(owner, signal)) void refresh();
    }, debounceMs);
  }
  async function watch(captured: Observation) {
    const signal = captured.abort.signal;
    let cursor: LiveCursor | null = null,
      waiting = false,
      fallbackAt = -Infinity;
    while (observing(captured)) {
      const started = now();
      try {
        const result = await reader.read(captured.scope, captured.sources, cursor, waiting, signal);
        if (!observing(captured)) return;
        if (!result.ok || result.data.needsLargerBudget) {
          observationFailed = true;
          failed("observation");
          if (!result.ok && invalidCursor(result.failure)) {
            cursor = null;
            waiting = false;
          }
          if (
            !result.ok &&
            capacityUnavailable(result.failure) &&
            now() - fallbackAt >= fallbackMs
          ) {
            fallbackAt = now();
            await refresh();
          }
          await pauseFor(retryMs, signal);
          continue;
        }
        observationFailed = false;
        observationFailures = 0;
        const first = cursor === null;
        cursor = result.data.cursor;
        waiting = !result.data.hasMore;
        if (first) await refresh();
        else if (result.data.changed) schedule(epoch, abort.signal);
        else success();
        // Defensive floor only for unexpectedly fast empty responses, not an
        // additional page polling timer. Normal waits already take 25 seconds.
        if (!result.data.changed && !result.data.hasMore && now() - started < 250)
          await pauseFor(250, signal);
      } catch {
        if (!observing(captured)) return;
        observationFailed = true;
        failed("observation");
        await pauseFor(retryMs, signal);
      }
    }
  }
  function start() {
    if (disposed || selected === null) return;
    abort = new AbortController();
    const { scope, adapter } = selected;
    const key = observationKey(scope, adapter.sources);
    if (observation?.key === key) {
      // Only the projection changed. Keep the active wait, cursor and health.
      void refresh();
      return;
    }
    stopObservation();
    publish({ ...initial, kind: "connecting" });
    if (scope.workspaceId === null || adapter.sources.length === 0) void refresh();
    else {
      const captured: Observation = {
        key,
        scope,
        sources: [...adapter.sources],
        abort: new AbortController(),
      };
      observation = captured;
      void watch(captured);
    }
  }
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open(scope, adapter) {
      stopProjection();
      const identity = {};
      selected = {
        scope: Object.freeze({ ...scope, connection: Object.freeze({ ...scope.connection }) }),
        adapter,
        identity,
      };
      start();
      return () => {
        if (selected?.identity !== identity) return;
        stopProjection();
        selected = null;
        // React replaces the old page attachment in the same effect flush.
        // Defer stopping so a compatible replacement can retain the live wait.
        queueMicrotask(() => {
          if (selected !== null || disposed) return;
          stopObservation();
          publish({ kind: "paused" });
        });
      };
    },
    refresh,
    dispose() {
      stopProjection();
      stopObservation();
      disposed = true;
      selected = null;
      listeners.clear();
    },
  };
}
