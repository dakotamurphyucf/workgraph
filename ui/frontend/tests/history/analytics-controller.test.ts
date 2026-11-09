import { afterEach, describe, expect, it } from "vitest";
import { parseJsonText, jsonField, type JsonValue } from "../../src/core/json";
import * as c from "../../src/core/protocol/codec";
import * as d from "../../src/core/protocol/decoders";
import type { FeatureContext } from "../../src/app/types";
import type { HttpClient, HttpRequest, HttpResult } from "../../src/core/protocol/http";
import type { ManagedOperation, OperationController } from "../../src/core/state/operations";
import type { Preparation } from "../../src/core/protocol/types";
import {
  createHistoryAnalyticsController,
  defaultUsage,
} from "../../src/features/history/analytics/controller";
import type { SearchQuery } from "../../src/features/history/analytics/types";
import { usageQueryMatches } from "../../src/features/history/analytics/client";
import { nativeResponses } from "./analytics-native-fixtures";
import { createTestProcessor } from "../core/processing-harness";
function json(x: unknown): JsonValue {
  const v = parseJsonText(JSON.stringify(x));
  if (!v.ok) throw new Error(v.error.message);
  return v.value.value;
}
function decode<T>(codec: c.Codec<T>, x: unknown): T {
  const v = codec.decode(json(x));
  if (!v.ok) throw new Error(v.issue.expected);
  return v.value;
}
const native = (label: string) => {
  const v = nativeResponses.find((x) => x.label === label);
  if (v === undefined) throw new Error(label);
  return v.response;
};
const closes: (() => void)[] = [];
afterEach(() => {
  for (const f of closes.splice(0)) f();
});
const query: SearchQuery = {
  text: "needle",
  sessionId: "a-history",
  kinds: [],
  capture: { kind: "current" },
  limit: "25",
  maxBytes: "1048576",
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function harness(reply?: (method: string, params: JsonValue | undefined) => Promise<unknown>) {
  const processing = createTestProcessor(),
    calls: { method: string; params: JsonValue | undefined }[] = [],
    registered: Preparation[] = [],
    actions: string[] = [],
    entries = new Map<string, ManagedOperation>();
  const http: HttpClient = {
    processing,
    request: async <T>(r: HttpRequest<T>): Promise<HttpResult<T>> => {
      const m = r.body === undefined ? undefined : jsonField(r.body, "method"),
        method = m?.kind === "string" ? m.value : r.path,
        params = r.body === undefined ? undefined : jsonField(r.body, "params");
      calls.push({ method, params });
      const returned = await reply?.(method, params),
        response =
          returned ??
          native(
            method === "history.search"
              ? params !== undefined && jsonField(params, "after_event") !== undefined
                ? "search-next"
                : "search-first"
              : method === "usage.aggregate"
                ? "usage-budget"
                : "usage-list",
          );
      const value = r.codec.decode(json({ response, pagination: null }));
      if (!value.ok)
        return {
          ok: false,
          failure: { kind: "protocol", message: value.issue.expected, issue: value.issue },
        };
      return { ok: true, data: value.value, httpStatus: 200 };
    },
  };
  const operations: OperationController = {
    get: (id) => entries.get(id),
    list: () => [...entries.values()],
    subscribe: () => () => {},
    register: (p) => {
      registered.push(p);
      const entry: ManagedOperation = { preparation: p, operation: null, phase: { kind: "draft" } };
      entries.set(p.intention_id, entry);
      return Promise.resolve({ ok: true, entry });
    },
    adopt: () => Promise.reject(new Error("unused")),
    act: (id, action) => {
      actions.push(action);
      const entry = entries.get(id);
      if (entry === undefined) throw new Error("missing");
      return Promise.resolve({ ok: true, entry });
    },
    dispose: () => {},
  };
  const controller = createHistoryAnalyticsController({ http, operations }),
    context: FeatureContext = {
      client: http,
      connection: decode(d.connectionProfile, {
        id: "local",
        generation: "1",
        label: "Local",
        socket: "/tmp/fixture.sock",
      }),
      profileState: "current",
      route: {
        view: "history",
        connectionId: "local",
        workspaceId: "demo",
        projectId: "release",
        entityId: null,
      },
      writer: { actorId: "original", runId: "original-run" },
      navigate: () => {},
    };
  const selection = {
    scope: {
      connectionId: context.connection.id,
      generation: context.connection.generation,
      workspaceId: decode(d.identifier, "demo"),
    },
    sessionId: null,
    head: undefined,
  };
  controller.select(selection);
  closes.push(() => {
    controller.dispose();
    processing.dispose();
  });
  return { controller, context, selection, calls, registered, actions, operations };
}
const ready = async (test: () => boolean) => {
  await expect.poll(test).toBe(true);
};
describe("launch-owned History analytics", () => {
  it("continues native scanned reference at the same head and rejects changed filters", async () => {
    const h = harness();
    h.controller.search(query);
    await ready(() => h.controller.get().search.kind === "ready");
    const first = h.controller.get().searchCapture;
    expect(first).not.toBeNull();
    h.controller.search({ ...query, text: "changed" }, true);
    expect(h.calls).toHaveLength(1);
    expect(h.controller.get().issue).toMatch(/unchanged/u);
    h.controller.search(query, true);
    await ready(() => h.calls.length === 2 && h.controller.get().search.kind === "ready");
    expect(jsonField(h.calls[1]?.params ?? d.jsonNull(), "head")).toEqual(
      d.jsonString(first?.capture.head ?? ""),
    );
    expect(jsonField(h.calls[1]?.params ?? d.jsonNull(), "after_event")).toEqual(
      json(first?.data.next),
    );
    expect(h.calls[0]?.method).toBe("history.search");
  });
  it("keeps exact budget cursor/revision and allows only budget/limit changes during continuation", async () => {
    const h = harness();
    h.controller.aggregate({ ...defaultUsage, group: "run", maxBytes: "4096" });
    await ready(() => h.controller.get().aggregate.kind === "ready");
    const value = h.controller.get().aggregateCapture;
    if (value === null) throw new Error("missing");
    h.controller.aggregate({ ...defaultUsage, group: "run", layout: "rows" }, true);
    expect(h.calls).toHaveLength(1);
    h.controller.aggregate(
      { ...defaultUsage, group: "run", maxBytes: value.data.required_bytes ?? "1048576" },
      true,
    );
    await ready(() => h.calls.length === 2);
    expect(jsonField(h.calls[1]?.params ?? d.jsonNull(), "cursor")).toEqual(
      d.jsonString(value.data.cursor ?? ""),
    );
    expect(jsonField(h.calls[1]?.params ?? d.jsonNull(), "at_revision")).toEqual(
      d.jsonString(value.revision),
    );
  });
  it("retains the last confirmed continuation across failed next-page reads", async () => {
    let count = 0;
    const h = harness(() => {
      if (++count === 2) return Promise.reject(new Error("unexpected reader bug"));
      return Promise.resolve(native(count === 1 ? "search-first" : "search-next"));
    });
    h.controller.search(query);
    await ready(() => h.controller.get().search.kind === "ready");
    const before = h.controller.get().searchCapture;
    h.controller.search(query, true);
    await ready(() => h.controller.get().search.kind === "unexpected_error");
    expect(h.controller.get().searchCapture).toBe(before);
    expect(h.controller.get().unexpected).toBeNull();
    h.controller.search(query, true);
    await ready(() => h.calls.length === 3 && h.controller.get().search.kind === "ready");
    expect(h.calls[1]?.params).toEqual(h.calls[2]?.params);
  });
  it("a failed new-filter scan cannot carry an earlier page's cursor into the new query", async () => {
    let count = 0;
    const h = harness(() =>
      Promise.resolve(
        ++count === 1
          ? native("usage-budget")
          : { data: { malformed: true }, meta: { workspace_revision: "1" } },
      ),
    );
    const original = { ...defaultUsage, group: "run" as const, maxBytes: "4096" };
    h.controller.aggregate(original);
    await ready(() => h.controller.get().aggregate.kind === "ready");
    const prior = h.controller.get().aggregateCapture;
    if (prior === null) throw new Error("capture");
    const changed = { ...original, actorId: "another-author" };
    expect(usageQueryMatches(prior.invocation, h.selection.scope, original)).toBe(true);
    expect(usageQueryMatches(prior.invocation, h.selection.scope, changed)).toBe(false);
    h.controller.aggregate(changed);
    await ready(() => h.controller.get().aggregate.kind === "failed");
    expect(h.controller.get().aggregateCapture).toBeNull();
    h.controller.aggregate(changed, true);
    expect(h.calls).toHaveLength(2);
    expect(h.controller.get().issue).toMatch(/unchanged usage/u);
  });
  it("does not publish a delayed old-scope rejection or old-key success over a new selection", async () => {
    const wait = deferred<unknown>();
    const h = harness(() => wait.promise);
    h.controller.search(query);
    await ready(() => h.calls.length === 1);
    h.controller.select({
      ...h.selection,
      scope: { ...h.selection.scope, generation: decode(d.decimal, "2") },
    });
    wait.reject(new Error("old reader"));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.controller.get().search.kind).toBe("idle");
    expect(h.controller.get().unexpected).toBeNull();
    expect(h.controller.get().searchCapture).toBeNull();
  });
  it("late same-key failure cannot replace a newer successful capture", async () => {
    const wait = deferred<unknown>();
    let count = 0;
    const h = harness(() =>
      ++count === 1 ? wait.promise : Promise.resolve(native("search-first")),
    );
    h.controller.search(query);
    await ready(() => h.calls.length === 1);
    h.controller.search(query);
    await ready(() => h.controller.get().search.kind === "ready");
    const before = h.controller.get().searchCapture;
    wait.reject(new Error("superseded"));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.controller.get().search.kind).toBe("ready");
    expect(h.controller.get().searchCapture).toBe(before);
  });
  it("coalesces review, retains writer after navigation and never executes automatically", async () => {
    const h = harness();
    h.controller.newReport(h.context);
    const draft = h.controller.get().drafts[0];
    if (draft === undefined) throw new Error("draft");
    h.controller.editReport(draft.id, {
      ...draft.input,
      tokens: "9007199254740993",
      elapsedMs: "0",
      provenance: "Caller report",
      timestamp: "source time",
    });
    const one = h.controller.reviewReport(draft.id),
      two = h.controller.reviewReport(draft.id);
    expect(one).toBe(two);
    await one;
    expect(h.registered).toHaveLength(1);
    expect(h.actions).toEqual(["prepare"]);
    expect(h.registered[0]?.context.writer.actor_id).toBe("original");
    h.controller.select({
      ...h.selection,
      scope: { ...h.selection.scope, generation: decode(d.decimal, "2") },
    });
    h.controller.editReport(draft.id, { ...draft.input, tokens: "2" });
    expect(h.controller.get().drafts[0]?.input.tokens).toBe("9007199254740993");
    expect(h.controller.get().drafts[0]?.frozen?.generation).toBe("1");
    h.controller.selectReport(null);
    expect(h.controller.get().drafts).toHaveLength(1);
  });
  it("missing values stay editable validation, oversized paste retains previous input, and old generation refuses new reporting", async () => {
    const h = harness();
    h.controller.newReport(h.context);
    const draft = h.controller.get().drafts[0];
    if (draft === undefined) throw new Error("draft");
    await h.controller.reviewReport(draft.id);
    expect(h.controller.get().drafts[0]?.issue).toMatch(/exact integer/u);
    expect(h.controller.get().drafts[0]?.frozen).toBeNull();
    h.controller.editReport(draft.id, { ...draft.input, provenance: "x".repeat(12001) });
    expect(h.controller.get().drafts[0]?.input.provenance).toBe("");
    expect(h.controller.get().drafts[0]?.issue).toMatch(/previous text/u);
    h.controller.select({
      ...h.selection,
      scope: { ...h.selection.scope, generation: decode(d.decimal, "2") },
    });
    h.controller.newReport(h.context);
    expect(h.controller.get().drafts).toHaveLength(1);
    expect(h.controller.get().issue).toMatch(/current endpoint/u);
  });
});
