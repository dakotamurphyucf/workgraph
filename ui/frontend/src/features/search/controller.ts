import { parseRoute, routeHref } from "../../app/navigation";
import type { Route } from "../../app/types";
import type { Decimal } from "../../core/protocol/types";
import { createReadSlot, type ReadState, type ReadSlot } from "../../core/state/read-slot";
import { createSearchClient, ownQuery, ownScope, queryKey, scopeKey } from "./client";
import type {
  CapturedHistorySearch,
  PlanningCapture,
  SearchClient,
  SearchController,
  SearchDraft,
  SearchOptions,
  SearchScope,
  SearchState,
} from "./types";

export interface RecentStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}
const storageKey = "workgraph.ui.search.recents.v1";
export const initialSearchDraft: SearchDraft = Object.freeze({
  text: "",
  domain: "planning",
  kinds: Object.freeze([
    "ticket",
    "comment",
    "handoff",
    "resource",
    "resource_text",
    "fact",
    "project",
    "milestone",
    "workspace",
  ] as const),
  includeArchived: false,
  sessionId: "",
  paste: "",
});
export function retained<T>(state: ReadState<T>): T | undefined {
  return state.kind === "ready" ? state.value : state.kind === "idle" ? undefined : state.previous;
}
function historyKey(
  scope: Parameters<SearchClient["history"]>[0],
  query: Parameters<SearchClient["history"]>[1],
) {
  return JSON.stringify([
    scopeKey(scope),
    query.text,
    query.sessionId,
    [...query.kinds].sort(),
    query.capture.kind,
    query.capture.kind === "pinned" ? query.capture.head : null,
    query.limit,
    query.maxBytes,
  ]);
}
/** Launch-owned state. Reads are explicit; changing palette presentation never reissues them. */
export function createSearchStore(
  client: SearchClient,
  storage: RecentStorage | null,
): SearchController {
  interface Entry {
    readonly planning: ReadSlot<PlanningCapture>;
    readonly history: ReadSlot<CapturedHistorySearch>;
    draft: SearchDraft;
    position: string | null;
  }
  let planning = createReadSlot<PlanningCapture>(),
    history = createReadSlot<CapturedHistorySearch>();
  const listeners = new Set<() => void>(),
    scopes = new Map<string | null, Entry>();
  let active: Entry = { planning, history, draft: initialSearchDraft, position: null };
  scopes.set(null, active);
  let boundScope: string | null = null;
  let disposed = false,
    opening: AbortController | null = null,
    epoch = 0;
  let state: SearchState = {
    draft: initialSearchDraft,
    planning: planning.get(),
    history: history.get(),
    position: null,
    opening: false,
    issue: null,
    unexpected: null,
    recent: [],
    persistenceIssue: null,
  };
  const publish = (next: SearchState) => {
    if (disposed) return;
    state = next;
    for (const listener of listeners) listener();
  };
  const publishStorageError = (error: unknown) =>
    publish({
      ...state,
      ...(error instanceof DOMException
        ? { persistenceIssue: `Recent links could not be saved: ${error.message}` }
        : { unexpected: { owner: "recent links", error } }),
    });
  const persist = () => {
    if (storage === null) return;
    try {
      storage.setItem(storageKey, state.recent.map(routeHref).join("\n"));
    } catch (error: unknown) {
      publishStorageError(error);
    }
  };
  if (storage !== null) {
    try {
      const source = storage.getItem(storageKey);
      if (source !== null) {
        if (new TextEncoder().encode(source).length > 65536)
          throw new DOMException("Stored links exceed 64 KiB.", "DataError");
        const lines = source === "" ? [] : source.split("\n");
        if (lines.length > 32)
          throw new DOMException("Stored links exceed 32 entries.", "DataError");
        const recent: Route[] = [];
        for (const line of lines) {
          const decoded = parseRoute(line);
          if (!decoded.ok) throw new DOMException("A stored link is invalid.", "DataError");
          recent.push(decoded.route);
        }
        state = { ...state, recent };
      }
    } catch (error: unknown) {
      publishStorageError(error);
    }
  }
  const listen = (entry: Entry) => {
    entry.planning.subscribe(() => {
      if (entry === active) publish({ ...state, planning: entry.planning.get() });
    });
    entry.history.subscribe(() => {
      if (entry === active) publish({ ...state, history: entry.history.get() });
    });
  };
  listen(active);
  const cancelOpen = () => {
    epoch++;
    opening?.abort();
    opening = null;
    if (state.opening) publish({ ...state, opening: false });
  };
  // Only a loading slot needs cancellation. Reinstall its prior successful immutable capture
  // locally; this never invokes the client, and ReadSlot identity fences the abandoned promise.
  const stop = <T>(slot: ReadSlot<T>) => {
    const value = slot.get();
    if (value.kind !== "loading") return;
    slot.clear();
    const previous = value.previous;
    if (previous !== undefined)
      void slot
        .load(value.key, () => Promise.resolve({ ok: true, data: previous, httpStatus: 200 }))
        .catch(() => {
          // ReadSlot owns unexpected errors in this exact entry, including while inactive.
          // Evicted/disposed entries intentionally have no later publication owner.
        });
  };
  const bindScope = (scope: SearchScope | null) => {
    const key = scope === null ? null : scopeKey(scope);
    if (disposed || boundScope === key) return;
    cancelOpen();
    const old = active;
    old.draft = state.draft;
    old.position = state.position;
    const cached = scopes.get(key);
    active = cached ?? {
      planning: createReadSlot<PlanningCapture>(),
      history: createReadSlot<CapturedHistorySearch>(),
      draft: initialSearchDraft,
      position: null,
    };
    if (cached === undefined) listen(active);
    planning = active.planning;
    history = active.history;
    boundScope = key;
    scopes.delete(key);
    scopes.set(key, active);
    stop(old.planning);
    stop(old.history);
    while (scopes.size > 4) {
      const first = scopes.keys().next().value;
      if (first === undefined) break;
      const evicted = scopes.get(first);
      scopes.delete(first);
      evicted?.planning.dispose();
      evicted?.history.dispose();
    }
    publish({
      ...state,
      draft: active.draft,
      position: active.position,
      planning: planning.get(),
      history: history.get(),
      issue: null,
      unexpected: null,
    });
  };
  return {
    get: () => state,
    subscribe: (listener) => {
      if (disposed) throw new Error("Search controller disposed.");
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    scope: bindScope,
    position: (marker) => publish({ ...state, position: marker }),
    edit: (draft) =>
      publish({
        ...state,
        draft: Object.freeze({ ...draft, kinds: Object.freeze([...draft.kinds]) }),
      }),
    async planning(input, queryInput, next = false) {
      if (disposed) return;
      bindScope(input);
      cancelOpen();
      const scope = ownScope(input),
        query = ownQuery(queryInput),
        key = queryKey(scope, query),
        previous = retained(planning.get());
      let offset = "0" as Decimal,
        revision: Decimal | undefined;
      if (next) {
        if (
          previous === undefined ||
          queryKey(previous.scope, previous.query) !== key ||
          previous.value.next_offset === null
        ) {
          publish({
            ...state,
            issue: {
              kind: "input",
              message: "No continuation exists for this exact planning query.",
            },
          });
          return;
        }
        offset = previous.value.next_offset;
        revision = previous.revision;
      }
      publish({ ...state, issue: null, position: next ? state.position : null });
      try {
        await planning.load(key, (signal) =>
          client.planning(scope, query, offset, revision, signal),
        );
      } catch {
        /* ReadSlot retains the owned unexpected failure; stale failures have no owner. */
      }
    },
    async history(input, queryInput, next = false) {
      if (disposed) return;
      bindScope(input);
      cancelOpen();
      const scope = ownScope(input),
        query = Object.freeze({
          ...queryInput,
          kinds: Object.freeze([...queryInput.kinds]),
          capture: Object.freeze({ ...queryInput.capture }),
        }),
        key = historyKey(scope, query),
        snapshot = history.get(),
        previous = retained(snapshot);
      let after: Parameters<SearchClient["history"]>[2] = null,
        effective = query;
      if (next) {
        if (
          previous === undefined ||
          snapshot.kind === "idle" ||
          snapshot.key !== key ||
          !previous.value.data.has_more ||
          previous.value.data.next === null
        ) {
          publish({
            ...state,
            issue: {
              kind: "input",
              message: "No scanned-event continuation exists for this exact history query.",
            },
          });
          return;
        }
        after = previous.value.data.next;
        effective = { ...query, capture: { kind: "pinned", head: previous.value.capture.head } };
      }
      publish({ ...state, issue: null, position: next ? state.position : null });
      try {
        await history.load(key, async (signal) => {
          const result = await client.history(scope, effective, after, signal);
          return result.ok
            ? { ...result, data: { ...result.data, requestedQuery: query } }
            : result;
        });
      } catch {
        /* Owned unexpected failures remain visible in the ReadSlot. */
      }
    },
    async open(capture, hit) {
      if (disposed) return null;
      cancelOpen();
      const owner = epoch,
        abort = new AbortController();
      opening = abort;
      publish({ ...state, opening: true, issue: null, unexpected: null });
      try {
        const result = await client.resolve(capture, hit, abort.signal);
        if (disposed || owner !== epoch) return null;
        opening = null;
        publish({ ...state, opening: false, ...(result.ok ? {} : { issue: result.failure }) });
        return result.ok ? result.data : null;
      } catch (error: unknown) {
        if (!disposed && owner === epoch) {
          opening = null;
          publish({ ...state, opening: false, unexpected: { owner: "open result", error } });
        }
        return null;
      }
    },
    remember(route) {
      const encoded = routeHref(route),
        decoded = parseRoute(encoded);
      if (!decoded.ok) throw new Error(decoded.message);
      const recent = [
        decoded.route,
        ...state.recent.filter((value) => routeHref(value) !== encoded),
      ].slice(0, 32);
      while (new TextEncoder().encode(recent.map(routeHref).join("\n")).length > 65536)
        recent.pop();
      publish({ ...state, recent, persistenceIssue: null });
      persist();
    },
    clearRecent() {
      publish({ ...state, recent: [], persistenceIssue: null });
      persist();
    },
    dismiss: cancelOpen,
    cancel() {
      cancelOpen();
      planning.clear();
      history.clear();
    },
    dispose() {
      cancelOpen();
      disposed = true;
      for (const entry of scopes.values()) {
        entry.planning.dispose();
        entry.history.dispose();
      }
      scopes.clear();
      listeners.clear();
    },
  };
}
export function createSearchController(options: SearchOptions): SearchController {
  let storage: RecentStorage | null = null,
    error: unknown;
  try {
    storage = globalThis.localStorage ?? null;
  } catch (caught: unknown) {
    error = caught;
  }
  // Access-denied storage is reported through the same explicit persistence channel.
  if (error !== undefined) {
    const failure =
      error instanceof Error
        ? error
        : new Error("Unexpected storage access failure", { cause: error });
    return createSearchStore(createSearchClient(options.http), {
      getItem() {
        throw failure;
      },
      setItem() {
        throw failure;
      },
    });
  }
  return createSearchStore(createSearchClient(options.http), storage);
}
