import { jsonField } from "../json";
import type { HttpFailure } from "../protocol/http";
import type {
  LiveAdapter,
  LiveChangeReader,
  LiveCursor,
  LiveReadOwner,
  LiveScope,
  LiveStatus,
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
    visible = true,
    epoch = 0;
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
    !disposed && visible && epoch === owner && !signal.aborted;
  const delayMs = () => Math.min(30000, 1000 * 2 ** Math.min(Math.max(0, state.failures - 1), 5));
  const failed = () =>
    publish({
      kind: state.failures >= 2 ? "offline" : "reconnecting",
      failures: state.failures + 1,
    });
  const success = (retainedCapture = state.retainedCapture) => {
    if (!observationFailed && !projectionFailed)
      publish({ kind: "live", failures: 0, lastSuccessMs: now(), retainedCapture });
  };
  const stop = () => {
    epoch++;
    abort.abort();
    if (debounce !== undefined) clearTimeout(debounce);
    if (retry !== undefined) clearTimeout(retry);
    retry = undefined;
    projectionFailed = false;
    debounce = undefined;
    dirty = false;
    flight = null;
    observationFailed = false;
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
    if (disposed || !visible || selected === null || abort.signal.aborted) return Promise.resolve();
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
          if (result.ok) success(result.retainedCapture === true);
          else {
            failed();
            dirty = false;
          }
        } catch {
          // The passive slots retain errors with their exact read identity.
          if (active(owner, signal)) {
            projectionFailed = true;
            failed();
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
        }, delayMs());
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
  async function watch(owner: number, signal: AbortSignal) {
    const captured = selected;
    if (captured === null) return;
    let cursor: LiveCursor | null = null,
      waiting = false,
      fallbackAt = -Infinity;
    while (active(owner, signal)) {
      const started = now();
      try {
        const result = await reader.read(
          captured.scope,
          captured.adapter.sources,
          cursor,
          waiting,
          signal,
        );
        if (!active(owner, signal)) return;
        if (!result.ok || result.data.needsLargerBudget) {
          observationFailed = true;
          failed();
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
          await pauseFor(delayMs(), signal);
          continue;
        }
        observationFailed = false;
        const first = cursor === null;
        cursor = result.data.cursor;
        waiting = !result.data.hasMore;
        if (first) await refresh();
        else if (result.data.changed) schedule(owner, signal);
        else success();
        // Defensive floor only for unexpectedly fast empty responses, not an
        // additional page polling timer. Normal waits already take 25 seconds.
        if (!result.data.changed && !result.data.hasMore && now() - started < 250)
          await pauseFor(250, signal);
      } catch {
        if (!active(owner, signal)) return;
        observationFailed = true;
        failed();
        await pauseFor(delayMs(), signal);
      }
    }
  }
  function start() {
    if (disposed || !visible || selected === null) return;
    abort = new AbortController();
    publish({ kind: "connecting" });
    if (selected.scope.workspaceId === null || selected.adapter.sources.length === 0)
      void refresh();
    else void watch(epoch, abort.signal);
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
      stop();
      const identity = {};
      selected = {
        scope: Object.freeze({ ...scope, connection: Object.freeze({ ...scope.connection }) }),
        adapter,
        identity,
      };
      publish({ ...initial, kind: visible ? "connecting" : "paused" });
      start();
      return () => {
        if (selected?.identity === identity) {
          stop();
          selected = null;
          publish({ kind: "paused" });
        }
      };
    },
    refresh,
    setVisible(next) {
      if (next === visible) return;
      visible = next;
      stop();
      if (next) start();
      else publish({ kind: "paused" });
    },
    dispose() {
      stop();
      disposed = true;
      selected = null;
      listeners.clear();
    },
  };
}
