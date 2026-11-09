import type {
  LiveAdapter,
  LiveChangeReader,
  LiveReadOwner,
  LiveScope,
  LiveStatus,
} from "./live-types";

interface OwnerOptions {
  readonly reader: LiveChangeReader;
  readonly now?: () => number;
  readonly pollMs?: number;
  readonly safetyMs?: number;
}
const initial: LiveStatus = {
  kind: "paused",
  lastSuccessMs: null,
  failures: 0,
  retainedCapture: false,
};
/** Browser-independent scheduler. One mount owns its abort tree, timers and
 * coalesced refresh flight. Every callback is passive and explicitly supplied. */
export function createLiveReadOwner({
  reader,
  now = Date.now,
  pollMs = 3000,
  safetyMs = 15000,
}: OwnerOptions): LiveReadOwner {
  let state = initial;
  let disposed = false,
    visible = true,
    epoch = 0;
  let selected: { scope: LiveScope; adapter: LiveAdapter; identity: object } | null = null;
  let abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flight: Promise<void> | null = null,
    dirty = false;
  const listeners = new Set<() => void>();
  const failedFeeds = new Set<string>();
  const publish = (patch: Partial<LiveStatus>) => {
    if (disposed) return;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener();
  };
  const active = (owner: number, signal: AbortSignal) =>
    !disposed && visible && epoch === owner && !signal.aborted;
  const delayMs = () =>
    state.failures === 0 ? 0 : Math.min(30000, 1000 * 2 ** Math.min(state.failures - 1, 5));
  const failed = () =>
    publish({
      kind: state.failures >= 2 ? "offline" : "reconnecting",
      failures: state.failures + 1,
    });
  const success = (retainedCapture = state.retainedCapture) =>
    publish(
      failedFeeds.size > 0
        ? { kind: "reconnecting", retainedCapture }
        : { kind: "live", failures: 0, lastSuccessMs: now(), retainedCapture },
    );
  const stop = () => {
    epoch++;
    abort.abort();
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    dirty = false;
    flight = null;
    failedFeeds.clear();
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
          if (result.ok) success(result.retainedCapture === true);
          else {
            failed();
            dirty = false;
          }
        } catch {
          // Slots retain the actual exception with their exact read identity.
          if (active(owner, signal)) {
            failed();
            dirty = false;
          }
        }
      }
    })().finally(() => {
      if (flight === task) flight = null;
    });
    flight = task;
    return task;
  }
  async function watch(source: "planning" | "history", owner: number, signal: AbortSignal) {
    const captured = selected;
    if (captured === null) return;
    let cursor: string | null = null,
      waiting = false;
    while (active(owner, signal)) {
      try {
        const result = await reader.read(captured.scope, source, cursor, waiting, signal);
        if (!active(owner, signal)) return;
        if (!result.ok || result.data.needsLargerBudget) {
          failedFeeds.add(source);
          failed();
          // A restored/reconnected root may invalidate a cursor. Re-establish
          // a native cursor and refresh current projections after backoff.
          cursor = null;
          waiting = false;
          await pauseFor(delayMs(), signal);
          continue;
        }
        failedFeeds.delete(source);
        const first = cursor === null;
        cursor = result.data.cursor;
        waiting = !result.data.hasMore;
        if (first || result.data.changed) await refresh();
        // A conforming wait blocks; a fast timeout or empty-page implementation
        // cannot turn this observer into a tight request loop.
        if (!result.data.changed && !result.data.hasMore) await pauseFor(250, signal);
      } catch {
        if (!active(owner, signal)) return;
        failedFeeds.add(source);
        failed();
        cursor = null;
        waiting = false;
        await pauseFor(delayMs(), signal);
      }
    }
  }
  function start() {
    if (disposed || !visible || selected === null) return;
    abort = new AbortController();
    const owner = epoch,
      signal = abort.signal,
      captured = selected;
    publish({ kind: "connecting" });
    // Watchers establish observation before the first projected refresh.
    const sources =
      captured.scope.workspaceId === null ? [] : [...new Set(captured.adapter.sources)];
    for (const source of sources) void watch(source, owner, signal);
    if (sources.length === 0) void refresh();
    const tick = () => {
      const interval = Math.max(captured.adapter.poll ? pollMs : safetyMs, delayMs());
      timer = setTimeout(() => {
        timer = undefined;
        if (!active(owner, signal)) return;
        void refresh().finally(() => {
          if (active(owner, signal)) tick();
        });
      }, interval);
    };
    tick();
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
      if (next === visible) {
        if (next) void refresh();
        return;
      }
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
