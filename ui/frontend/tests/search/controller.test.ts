import { describe, it, expect } from "vitest";
import type { HttpResult } from "../../src/core/protocol/http";
import { createSearchStore } from "../../src/features/search/controller";
import type {
  CapturedHistorySearch,
  PlanningCapture,
  SearchClient,
} from "../../src/features/search/types";
import { capture, decimal, deferred, hit, query, scope } from "./fixtures";
const ok = <T>(data: T): HttpResult<T> => ({ ok: true, data, httpStatus: 200 });
function client(overrides: Partial<SearchClient> = {}): SearchClient {
  return {
    confirm: () => Promise.resolve(ok(scope.connection)),
    planning: () => Promise.resolve(ok(capture())),
    history: () => Promise.reject(new Error("Unconfigured history")),
    resolve: () =>
      Promise.resolve(
        ok({
          view: "work",
          connectionId: "local",
          workspaceId: "workspace",
          projectId: null,
          entityId: "ticket",
        }),
      ),
    ...overrides,
  };
}
describe("Search launch ownership", () => {
  it("pins continuations across refreshes and never accepts continuation under a different query", async () => {
    const calls: unknown[][] = [],
      store = createSearchStore(
        client({
          planning: (...args) => {
            calls.push(args);
            return Promise.resolve(ok(capture(args[2], calls.length === 1 ? "2" : "0")));
          },
        }),
        null,
      );
    await store.planning(scope, query);
    store.edit({
      ...store.get().draft,
      text: "new unsent",
      kinds: ["fact"],
      includeArchived: true,
    });
    const retainedPage = store.get().planning;
    if (retainedPage.kind !== "ready") throw new Error("Missing retained query");
    await store.planning(retainedPage.value.scope, retainedPage.value.query, true);
    expect(store.get().draft.text).toBe("new unsent");
    expect(calls[1]?.slice(2, 4)).toEqual(["1", "7"]);
    await store.planning(scope, { ...query, text: "different" }, true);
    expect(calls).toHaveLength(2);
    expect(store.get().issue?.kind).toBe("input");
    store.dispose();
  });
  it("ignores stale success AND rejection after a newer query owns the slot", async () => {
    const first = deferred<HttpResult<PlanningCapture>>(),
      second = deferred<HttpResult<PlanningCapture>>();
    let calls = 0;
    const store = createSearchStore(
      client({ planning: () => (++calls === 1 ? first.promise : second.promise) }),
      null,
    );
    const a = store.planning(scope, query),
      b = store.planning(scope, { ...query, text: "new" });
    second.resolve(ok({ ...capture(), query: { ...query, text: "new" } }));
    await b;
    first.reject(new Error("obsolete"));
    await a;
    expect(store.get().planning.kind).toBe("ready");
    if (store.get().planning.kind !== "ready") throw new Error("Not ready");
    expect(store.get().unexpected).toBeNull();
    store.dispose();
  });
  it("retains unexpected owned errors visibly and clears old results for a different scope", async () => {
    const store = createSearchStore(
      client({
        planning: () => Promise.reject(new Error("unexpected worker failure")),
      }),
      null,
    );
    await store.planning(scope, query);
    expect(store.get().planning.kind).toBe("unexpected_error");
    store.dispose();
  });
  it("pins every history page to initial exact head and follows scanned cursor instead of last hit", async () => {
    const calls: Parameters<SearchClient["history"]>[] = [],
      head = "a".repeat(64),
      sequence = decimal("42");
    const initial = {
      text: "needle",
      sessionId: "session",
      kinds: [],
      capture: { kind: "current" as const },
      limit: "25",
      maxBytes: "65536",
    };
    const result = (
      queryInput: typeof initial | Parameters<SearchClient["history"]>[1],
      n: number,
    ): CapturedHistorySearch => ({
      scope,
      requestedQuery: queryInput,
      value: {
        scope: {
          connectionId: scope.connection.id,
          generation: scope.connection.generation,
          workspaceId: scope.workspaceId,
        },
        query: queryInput,
        capture: {
          workspace_id: scope.workspaceId,
          head: head as CapturedHistorySearch["value"]["capture"]["head"],
          sessions: [],
          sequence: decimal("1"),
        },
        data: {
          items: [],
          next: { session_id: scope.workspaceId, sequence },
          has_more: n < 3,
          restart_after_indexing: false,
          coverage: [],
          index_complete: false,
          unindexed_events: decimal("3"),
          unsearchable_events: decimal("0"),
          omitted_for_budget: decimal("0"),
        },
      },
    });
    const store = createSearchStore(
      client({
        history: (...args) => {
          calls.push(args);
          return Promise.resolve(ok(result(args[1], calls.length)));
        },
      }),
      null,
    );
    await store.history(scope, initial);
    store.edit({ ...store.get().draft, text: "unsubmitted", sessionId: "other-session" });
    for (let page = 0; page < 2; page++) {
      const previous = store.get().history;
      if (previous.kind !== "ready") throw new Error("Missing retained history");
      await store.history(previous.value.scope, previous.value.requestedQuery, true);
    }
    expect(store.get().draft.sessionId).toBe("other-session");
    expect(calls).toHaveLength(3);
    expect(calls[1]?.[1].capture).toEqual({ kind: "pinned", head });
    expect(calls[2]?.[2]).toEqual({ session_id: "workspace", sequence: "42" });
    const capturedHistory = store.get().history;
    store.scope({ ...scope, projectId: scope.workspaceId });
    expect(store.get().history.kind).toBe("idle");
    store.scope(scope);
    expect(store.get().history).toBe(capturedHistory);
    expect(store.get().draft.sessionId).toBe("other-session");
    expect(calls).toHaveLength(3);
    store.dispose();
  });
  it("does not navigate a late open result after another open or cancel", async () => {
    const pending =
      deferred<ReturnType<SearchClient["resolve"]> extends Promise<infer T> ? T : never>();
    const store = createSearchStore(client({ resolve: () => pending.promise }), null),
      opening = store.open(capture(), hit);
    store.cancel();
    pending.resolve(
      ok({
        view: "work",
        connectionId: "local",
        workspaceId: "workspace",
        projectId: null,
        entityId: "ticket",
      }),
    );
    expect(await opening).toBeNull();
    expect(store.get().opening).toBe(false);
    store.dispose();
  });
  it("keeps drafts across palette remount and reports denied recents without swallowing unexpected errors", () => {
    const store = createSearchStore(client(), {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("Blocked", "SecurityError");
      },
    });
    store.edit({ ...store.get().draft, text: "unsent query", sessionId: "session" });
    store.remember({
      view: "work",
      connectionId: "local",
      workspaceId: "workspace",
      projectId: null,
      entityId: "ticket",
    });
    expect(store.get().draft.text).toBe("unsent query");
    expect(store.get().persistenceIssue).toContain("Blocked");
    expect(store.get().recent).toHaveLength(1);
    store.dispose();
    const invalid = createSearchStore(client(), {
      getItem: () => "#/facts?connection=local&workspace=workspace&fact_mode=pinned",
      setItem: () => {},
    });
    expect(invalid.get().recent).toHaveLength(0);
    expect(invalid.get().persistenceIssue).not.toBeNull();
    invalid.dispose();
  });
});

describe("Dismiss destination ownership without clearing queries", () => {
  for (const outcome of ["resolve", "reject"] as const)
    it(`ignores ${outcome} after palette dismissal, retaining captured results`, async () => {
      const pending = deferred<HttpResult<import("../../src/app/types").Route>>(),
        store = createSearchStore(client({ resolve: () => pending.promise }), null);
      await store.planning(scope, query);
      const opened = store.open(capture(), hit);
      store.dismiss();
      if (outcome === "resolve")
        pending.resolve(
          ok({
            view: "work",
            connectionId: "local",
            workspaceId: "workspace",
            projectId: null,
            entityId: "ticket",
          }),
        );
      else pending.reject(new Error("late descriptor failure"));
      expect(await opened).toBeNull();
      expect(store.get().planning.kind).toBe("ready");
      expect(store.get().recent).toEqual([]);
      expect(store.get().unexpected).toBeNull();
      expect(store.get().issue).toBeNull();
      store.dispose();
    });
});

describe("Bounded exact-scope return captures", () => {
  it("restores the original captured page, unsent draft and result marker without requery", async () => {
    let reads = 0;
    const store = createSearchStore(
        client({
          planning: (target, q, offset) => {
            reads++;
            return Promise.resolve(
              ok({ ...capture(offset, offset === "0" ? "2" : "0"), scope: target, query: q }),
            );
          },
        }),
        null,
      ),
      foreign = { ...scope, projectId: scope.workspaceId };
    store.scope(scope);
    await store.planning(scope, query);
    store.edit({ ...store.get().draft, text: "original unsent", kinds: ["fact"] });
    await store.planning(scope, query, true);
    store.position("planning:fact:project/key:1");
    const original = store.get().planning;
    store.scope(foreign);
    expect(store.get().planning.kind).toBe("idle");
    expect(store.get().draft.text).toBe("");
    await store.planning(foreign, { ...query, text: "foreign" });
    store.scope(scope);
    expect(store.get().planning).toBe(original);
    if (original.kind !== "ready") throw new Error("Missing captured page");
    expect(original.value.value.offset).toBe("1");
    expect(store.get().draft.text).toBe("original unsent");
    expect(store.get().draft.kinds).toEqual(["fact"]);
    expect(store.get().position).toBe("planning:fact:project/key:1");
    expect(reads).toBe(3);
    store.dispose();
  });
  for (const outcome of ["success", "rejection"] as const)
    it(`fences obsolete ${outcome} when returning to a captured scope`, async () => {
      const pending = deferred<HttpResult<PlanningCapture>>();
      let reads = 0;
      const store = createSearchStore(
        client({
          planning: () => (++reads === 1 ? Promise.resolve(ok(capture())) : pending.promise),
        }),
        null,
      );
      store.scope(scope);
      await store.planning(scope, query);
      const old = store.planning(scope, query);
      store.scope({ ...scope, projectId: scope.workspaceId });
      expect(store.get().planning.kind).toBe("idle");
      if (outcome === "success") pending.resolve(ok({ ...capture(), revision: decimal("99") }));
      else pending.reject(new Error("obsolete failure"));
      await old;
      store.scope(scope);
      const value = store.get().planning;
      expect(value.kind).toBe("ready");
      if (value.kind !== "ready") throw new Error("Missing original capture");
      expect(value.value.revision).toBe("7");
      expect(store.get().unexpected).toBeNull();
      expect(reads).toBe(2);
      store.dispose();
    });
  it("evicts the least recently used capture after four exact scopes without implicit I/O", async () => {
    let reads = 0;
    const store = createSearchStore(
      client({
        planning: (target) => {
          reads++;
          return Promise.resolve(ok({ ...capture(), scope: target }));
        },
      }),
      null,
    );
    for (let n = 0; n < 5; n++)
      await store.planning(
        { ...scope, projectId: `scope-${n}` as typeof scope.workspaceId },
        query,
      );
    store.scope({ ...scope, projectId: "scope-0" as typeof scope.workspaceId });
    expect(store.get().planning.kind).toBe("idle");
    expect(reads).toBe(5);
    store.dispose();
  });
});
