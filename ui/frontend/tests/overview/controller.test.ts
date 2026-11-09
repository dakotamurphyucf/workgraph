import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { FeatureContext } from "../../src/app/types";
import { jsonField, parseJsonText, type JsonValue } from "../../src/core/json";
import * as d from "../../src/core/protocol/decoders";
import type { HttpClient, HttpRequest, HttpResult } from "../../src/core/protocol/http";
import type { JsonObject, ReadInvocation, ReadResponse } from "../../src/core/protocol/types";
import { createOverviewController, current } from "../../src/features/overview/controller";
import { nextInvocation } from "../../src/features/overview/client";
import {
  attentionInvocation,
  captureScope,
  coordinationInvocation,
  defaultAttention,
  digestInvocation,
  defaultDigest,
} from "../../src/features/overview/model";
import { createTestProcessor } from "../core/processing-harness";
const clean: (() => void)[] = [];
afterEach(() => {
  for (const done of clean.splice(0)) done();
});
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/native-probe.json", import.meta.url), "utf8"),
) as { reads: { method: string; raw: string }[] };
function raw(text: string): JsonValue {
  const p = parseJsonText(text);
  if (!p.ok) throw new Error(p.error.message);
  return p.value.value;
}
function replace(value: JsonValue, key: string, v: JsonValue): JsonObject {
  if (value.kind !== "object") throw new Error("object");
  return {
    kind: "object",
    fields: [...value.fields.filter((f) => f.name !== key), { name: key, value: v }],
  };
}
function sample(method: string): ReadResponse {
  if (method === "ticket.read" || method === "request.get") {
    // This cursor/lifecycle fixture omits optional display enrichment. An invalid
    // detail response must preserve the independently valid coordinator capture.
    const base = sample("project.brief");
    return { ...base, response: { ...base.response, data: d.jsonObject([]) } };
  }
  if (method === "ticket.list") {
    const brief = sample("project.brief");
    // Bounded supplemental status queries were added to the project summary.
    // This ownership fixture deliberately returns an empty status page; tests
    // of exact count reconciliation live with the dashboard projection.
    return {
      ...brief,
      response: {
        ...brief.response,
        data: raw('{"items":[],"offset":"0","next_offset":null,"remaining":"0"}'),
      },
    };
  }
  const source = fixture.reads.find((r) => r.method === method);
  if (source === undefined) throw new Error("actual sample");
  const result = jsonField(raw(source.raw), "result");
  const decoded = d.publicResponse.decode(result);
  if (!decoded.ok) throw new Error(decoded.issue.expected);
  return { response: decoded.value, pagination: null };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { resolve, reject, promise };
}
function setup() {
  const processing = createTestProcessor(),
    calls: { request: HttpRequest<unknown>; method: string; params: JsonObject }[] = [];
  let handle: (
    method: string,
    params: JsonObject,
    signal: AbortSignal | undefined,
  ) => ReadResponse | Promise<ReadResponse> = (method) => sample(method);
  const http: HttpClient = {
    processing,
    request: async <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
      if (request.path !== "/read" || request.method !== "POST")
        throw new Error("No write/ack endpoint allowed");
      const method = request.body === undefined ? undefined : jsonField(request.body, "method"),
        params = request.body === undefined ? undefined : jsonField(request.body, "params");
      if (method?.kind !== "string" || params?.kind !== "object")
        throw new Error("captured selector");
      calls.push({ request, method: method.value, params });
      const answer = await handle(method.value, params, request.signal);
      const decoded = request.codec.decode(
        d.jsonObject([
          [
            "response",
            d.jsonObject([
              ["data", answer.response.data],
              ["meta", answer.response.meta],
            ]),
          ],
          ["pagination", answer.pagination ?? d.jsonNull()],
        ]),
      );
      if (!decoded.ok) throw new Error(decoded.issue.expected);
      return { ok: true, data: decoded.value, httpStatus: 200 };
    },
  };
  const controller = createOverviewController({ http });
  const context: FeatureContext = {
    client: http,
    connection: {
      id: id("local"),
      generation: dec("1"),
      label: "Local",
      socket: "/tmp/overview-one.sock",
    },
    profileState: "current",
    writer: { actorId: "alice", runId: "run-a" },
    route: {
      view: "overview",
      connectionId: "local",
      workspaceId: "demo",
      projectId: "release",
      entityId: null,
    },
    navigate: () => {},
  };
  clean.push(() => {
    controller.dispose();
    processing.dispose();
  });
  return {
    controller,
    context,
    calls,
    setHandle: (value: typeof handle) => {
      handle = value;
    },
  };
}
function id(v: string) {
  const r = d.identifier.decode(d.jsonString(v));
  if (!r.ok) throw new Error("id");
  return r.value;
}
function dec(v: string) {
  const r = d.decimal.decode(d.jsonString(v));
  if (!r.ok) throw new Error("counter");
  return r.value;
}
function completeAttention(cursor = "consumed") {
  const x = sample("attention.read");
  return {
    ...x,
    response: {
      ...x.response,
      data: replace(
        replace(
          replace(x.response.data, "has_more", d.jsonBoolean(false)),
          "cursor",
          d.jsonString(cursor),
        ),
        "items",
        d.jsonArray([]),
      ),
    },
  };
}
async function until(test: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (test()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error("did not settle");
}

describe("immutable overview reads and independent cursors", () => {
  it("keeps one continuous refresh barrier while prior captures remain ready", async () => {
    const x = setup(),
      attentionGate = deferred<ReadResponse>(),
      digestGate = deferred<ReadResponse>();
    await x.controller.open(x.context);
    expect(x.controller.get().refreshing).toBe(false);
    x.setHandle((method) =>
      method === "attention.read"
        ? attentionGate.promise
        : method === "activity.digest"
          ? digestGate.promise
          : sample(method),
    );
    const refresh = x.controller.refresh();
    expect(x.controller.get().refreshing).toBe(true);
    expect(x.controller.get().summary.kind).toBe("ready");
    attentionGate.resolve(sample("attention.read"));
    await until(() => x.calls.filter((v) => v.method === "activity.digest").length === 2);
    expect(x.controller.get().refreshing).toBe(true);
    digestGate.resolve(sample("activity.digest"));
    await refresh;
    expect(x.controller.get().refreshing).toBe(false);
  });
  it("clears the selected scope and cancels foreground wait when workspace selection is removed", async () => {
    const x = setup(),
      pending = deferred<ReadResponse>();
    let signal: AbortSignal | undefined;
    x.setHandle((method, _params, s) => {
      if (method === "attention.wait") {
        signal = s;
        return pending.promise;
      }
      return method === "attention.read" ? completeAttention() : sample(method);
    });
    await x.controller.open(x.context);
    const waiting = x.controller.wait();
    await until(() => signal !== undefined);
    const count = x.calls.length;
    await x.controller.open({
      ...x.context,
      route: { ...x.context.route, workspaceId: null, projectId: null },
    });
    expect(signal?.aborted).toBe(true);
    expect(x.controller.get().scope).toBeNull();
    expect(x.controller.get().waiting).toBe(false);
    pending.resolve(completeAttention("obsolete"));
    await waiting;
    expect(x.controller.get().attention.kind).toBe("idle");
    expect(x.calls).toHaveLength(count);
    await x.controller.open(x.context);
    expect(x.controller.get().scope?.workspaceId).toBe("demo");
    expect(current(x.controller.get().attention)?.value.cursor).toBe("consumed");
  });
  it("fences a pending current refresh across no-workspace selection and reselect", async () => {
    const x = setup(),
      pending = deferred<ReadResponse>();
    let first = true;
    x.setHandle((method) => {
      if (method === "project.brief" && first) {
        first = false;
        return pending.promise;
      }
      return sample(method);
    });
    const old = x.controller.open(x.context);
    await until(() => x.calls.some((v) => v.method === "project.brief"));
    await x.controller.open({
      ...x.context,
      route: { ...x.context.route, workspaceId: null, projectId: null },
    });
    expect(x.controller.get().scope).toBeNull();
    const next = x.controller.open(x.context);
    await next;
    const currentSummary = current(x.controller.get().summary);
    pending.resolve(sample("project.brief"));
    await old;
    expect(current(x.controller.get().summary)).toBe(currentSummary);
    expect(x.controller.get().scope?.workspaceId).toBe("demo");
    expect(x.calls.filter((c) => !["ticket.read", "request.get"].includes(c.method))).toHaveLength(
      11,
    );
  });
  it("admits one current check at a time and stops the remaining checks after pause", async () => {
    const x = setup(),
      gate = deferred<ReadResponse>();
    let active = 0,
      maximum = 0;
    x.setHandle(async (method) => {
      active++;
      maximum = Math.max(maximum, active);
      const result =
        method === "project.brief" ? await gate.promise : await Promise.resolve(sample(method));
      active--;
      return result;
    });
    const loading = x.controller.open(x.context);
    await until(() => x.calls.some((v) => v.method === "project.brief"));
    await Promise.resolve();
    expect(x.calls.map((v) => v.method)).toEqual(["attention.read", "project.brief"]);
    x.controller.pause();
    gate.resolve(sample("project.brief"));
    await loading;
    expect(maximum).toBe(1);
    expect(x.calls).toHaveLength(2);
  });
  it("keeps an explicit activity query without issuing a redundant initial scan", async () => {
    const x = setup(),
      gate = deferred<ReadResponse>();
    x.setHandle((method) => (method === "project.brief" ? gate.promise : sample(method)));
    const loading = x.controller.open(x.context);
    await until(() => x.calls.some((v) => v.method === "project.brief"));
    await x.controller.setDigestQuery({ ...defaultDigest, limit: "2" });
    gate.resolve(sample("project.brief"));
    await loading;
    const requests = x.calls.filter((v) => v.method === "activity.digest");
    expect(requests).toHaveLength(1);
    expect(jsonField(requests[0]!.params, "limit")).toEqual(d.jsonString("2"));
  });
  it("reopens an aborted first load without joining its obsolete refresh flight", async () => {
    const x = setup(),
      old = deferred<ReadResponse>();
    let first = true;
    x.setHandle((method) => {
      if (method === "attention.read" && first) {
        first = false;
        return old.promise;
      }
      return method === "attention.read" ? completeAttention("reopened") : sample(method);
    });
    const pending = x.controller.open(x.context);
    x.controller.pause();
    await x.controller.open(x.context);
    expect(x.calls.filter((v) => v.method === "attention.read")).toHaveLength(2);
    expect(current(x.controller.get().attention)?.value.cursor).toBe("reopened");
    old.resolve(completeAttention("obsolete"));
    await pending;
    expect(current(x.controller.get().attention)?.value.cursor).toBe("reopened");
    expect(x.controller.get().summary.kind).toBe("ready");
  });
  it("fences follow-on readiness when scope changes between async owner checks", async () => {
    const x = setup(),
      replacement = deferred<ReadResponse>();
    let first = true,
      switched = false,
      next: Promise<void> | undefined;
    x.setHandle((method) => {
      if (method !== "attention.read") return sample(method);
      if (first) {
        first = false;
        return completeAttention("first");
      }
      return replacement.promise;
    });
    const unsubscribe = x.controller.subscribe(() => {
      if (!switched && x.controller.get().attention.kind === "ready") {
        switched = true;
        queueMicrotask(() =>
          queueMicrotask(() => {
            next = x.controller.open({ ...x.context, writer: { actorId: "bob", runId: null } });
          }),
        );
      }
    });
    await x.controller.open(x.context);
    await until(() => next !== undefined);
    expect(x.controller.get().scope?.actorId).toBe("bob");
    expect(x.controller.get().readiness.kind).toBe("idle");
    replacement.resolve(completeAttention("second"));
    await next;
    expect(current(x.controller.get().readiness)?.invocation.params).toEqual(
      current(x.controller.get().attention)?.invocation.params,
    );
    unsubscribe();
  });

  it("captures changes before checks, coalesces refresh, and does no writes", async () => {
    const x = setup(),
      gate = deferred<ReadResponse>();
    x.setHandle((method) => (method === "attention.read" ? gate.promise : sample(method)));
    const open = x.controller.open(x.context);
    const again = x.controller.refresh();
    expect(x.calls.map((v) => v.method)).toEqual(["attention.read"]);
    gate.resolve(sample("attention.read"));
    await Promise.all([open, again]);
    expect(
      x.calls
        .filter((c) => !["ticket.read", "request.get"].includes(c.method))
        .map((v) => v.method),
    ).toEqual([
      "attention.read",
      "project.brief",
      "ticket.list",
      "ticket.list",
      "ticket.list",
      "ticket.list",
      "coordinator.overview",
      "coordinator.overview",
      "activity.digest",
    ]);
    expect(current(x.controller.get().summary)?.value.title).toBe("Synthetic delivery workflow");
    await x.controller.open({ ...x.context, route: { ...x.context.route, view: "activity" } });
    expect(x.calls.filter((c) => !["ticket.read", "request.get"].includes(c.method))).toHaveLength(
      9,
    );
  });
  it("keeps every actor/run/consumer selector through attention paging", async () => {
    const x = setup();
    await x.controller.open(x.context);
    await x.controller.setAttentionFilter({
      kinds: ["communication", "readiness"],
      recipient: { kind: "actor", id: id("alice") },
      consumerId: "overview-observer",
      excludeSelf: true,
    });
    const first = current(x.controller.get().attention);
    if (first === undefined) throw new Error("capture");
    await x.controller.nextAttention();
    const last = x.calls.at(-1);
    expect(last?.method).toBe("attention.read");
    expect(jsonField(last!.params, "filter")).toEqual(jsonField(first.invocation.params, "filter"));
    expect(jsonField(last!.params, "cursor")).toEqual(d.jsonString(first.value.cursor));
  });
  it("rejects waiting over unseen changes and never acknowledges them", async () => {
    const x = setup();
    await x.controller.open(x.context);
    const n = x.calls.length;
    await x.controller.wait();
    expect(x.calls).toHaveLength(n);
    expect(x.controller.get().issue?.message).toContain("every captured change page");
  });
  it("explicit Stop aborts one foreground wait and retains its previous complete page", async () => {
    const x = setup(),
      pending = deferred<ReadResponse>();
    let signal: AbortSignal | undefined;
    x.setHandle((method, _params, s) => {
      if (method === "attention.wait") {
        signal = s;
        return pending.promise;
      }
      return method === "attention.read" ? completeAttention() : sample(method);
    });
    await x.controller.open(x.context);
    const waiting = x.controller.wait();
    await until(() => signal !== undefined);
    expect(x.controller.get().waiting).toBe(true);
    x.controller.stop();
    expect(signal?.aborted).toBe(true);
    pending.resolve(completeAttention("late"));
    await waiting;
    expect(current(x.controller.get().attention)?.value.cursor).toBe("consumed");
    // An explicit Stop is cancellation, not a failed server read. Keep the
    // last complete page ready instead of briefly displaying an error.
    expect(x.controller.get().attention.kind).toBe("ready");
    expect(x.controller.get().waiting).toBe(false);
    expect(x.calls.filter((v) => v.method === "attention.wait")).toHaveLength(1);
  });
  it("fences ignored cancellation across same-ID endpoint generations", async () => {
    const x = setup(),
      pending = deferred<ReadResponse>();
    let first = true,
      oldSignal: AbortSignal | undefined;
    x.setHandle((method, _params, signal) => {
      if (method === "attention.read" && first) {
        first = false;
        oldSignal = signal;
        return pending.promise;
      }
      return method === "attention.read" ? completeAttention("second-generation") : sample(method);
    });
    const old = x.controller.open(x.context);
    await x.controller.open({
      ...x.context,
      connection: {
        ...x.context.connection,
        generation: dec("2"),
        socket: "/tmp/overview-two.sock",
      },
    });
    expect(oldSignal?.aborted).toBe(true);
    pending.resolve(completeAttention("obsolete"));
    await old;
    expect(current(x.controller.get().attention)?.value.cursor).toBe("second-generation");
    expect(x.controller.get().scope?.connection.generation).toBe("2");
  });
  it("retains same-query data on unexpected refresh failure without repainting a switched scope", async () => {
    const x = setup();
    await x.controller.open(x.context);
    const before = current(x.controller.get().summary);
    x.setHandle((method) => {
      if (method === "project.brief") throw new Error("unexpected transport defect");
      return sample(method);
    });
    await x.controller.refresh();
    expect(x.controller.get().summary.kind).toBe("unexpected_error");
    expect(current(x.controller.get().summary)).toBe(before);
    const pending = deferred<ReadResponse>();
    x.setHandle((method) => (method === "project.brief" ? pending.promise : sample(method)));
    const old = x.controller.refresh();
    await until(() => x.controller.get().summary.kind === "loading");
    x.setHandle((method) => sample(method));
    await x.controller.open({ ...x.context, writer: { actorId: "bob", runId: null } });
    pending.reject(new Error("obsolete read defect"));
    await old;
    expect(x.controller.get().summary.kind).toBe("ready");
  });
  it("readiness paging never consumes the durable change cursor", async () => {
    const x = setup();
    x.setHandle((method, params) => {
      if (method !== "attention.read") return sample(method);
      const base = sample(method),
        rd = jsonField(base.response.data, "readiness");
      if (rd === undefined || rd.kind !== "object") throw new Error("readiness");
      const isNext = jsonField(params, "readiness_cursor") !== undefined;
      return {
        ...base,
        response: {
          ...base.response,
          data: replace(
            replace(
              base.response.data,
              "cursor",
              d.jsonString(isNext ? "MUST-NOT-CONSUME" : "original-durable"),
            ),
            "readiness",
            replace(
              replace(rd, "has_more", d.jsonBoolean(!isNext)),
              "cursor",
              isNext ? d.jsonNull() : d.jsonString("readiness-only"),
            ),
          ),
        },
      };
    });
    await x.controller.open(x.context);
    await x.controller.nextReadiness();
    expect(current(x.controller.get().attention)?.value.cursor).toBe("original-durable");
    expect(current(x.controller.get().readiness)?.value.hasMore).toBe(false);
    expect(jsonField(x.calls.at(-1)!.params, "cursor")).toEqual(d.jsonString("original-durable"));
  });
  it("does not attach an old digest page to a failed new query", async () => {
    const x = setup();
    await x.controller.open(x.context);
    x.setHandle((method) => {
      if (method === "activity.digest") throw new Error("new selection defect");
      return sample(method);
    });
    await x.controller.setDigestQuery({ ...defaultDigest, ticketId: "new-ticket" });
    const n = x.calls.length;
    await x.controller.nextDigest();
    expect(x.calls).toHaveLength(n);
    expect(current(x.controller.get().digest)).toBeUndefined();
  });
  it("validates native continuation parameters rather than trusting supplied method or writer", async () => {
    const x = setup();
    await x.controller.open(x.context);
    const observed = current(x.controller.get().coordination);
    if (observed === undefined || observed.value.cursor === null) throw new Error("native cursor");
    const original = observed.invocation,
      params = replace(original.params, "cursor", d.jsonString(observed.value.cursor));
    const metadata = (request: ReadInvocation) =>
      d.jsonObject([
        [
          "next_request",
          d.jsonObject([
            ["jsonrpc", d.jsonString("2.0")],
            ["workgraph_api", d.jsonString("0.7")],
            ["id", d.jsonString("native")],
            ["method", d.jsonString(request.method)],
            ["params", request.params],
          ]),
        ],
      ]);
    const valid = {
      ...observed,
      response: { ...observed.response, pagination: metadata({ ...original, params }) },
    };
    expect(nextInvocation(valid)).toMatchObject({ ok: true, data: { params } });
    expect(
      nextInvocation({
        ...valid,
        response: {
          ...valid.response,
          pagination: metadata({
            ...original,
            params: replace(params, "actor_id", d.jsonString("bob")),
          }),
        },
      }).ok,
    ).toBe(false);
    expect(
      nextInvocation({
        ...valid,
        response: {
          ...valid.response,
          pagination: metadata({ ...original, method: "request.ack", params }),
        },
      }).ok,
    ).toBe(false);
  });
  it("freezes actual selected scope and distinct native read families", () => {
    const x = setup(),
      scope = captureScope(x.context);
    expect(Object.isFrozen(scope.connection)).toBe(true);
    const c = coordinationInvocation(scope);
    expect(jsonField(c.params, "actor_id")).toEqual(d.jsonString("alice"));
    expect(jsonField(c.params, "run_id")).toEqual(d.jsonString("run-a"));
    expect(attentionInvocation(scope, defaultAttention).lane).toBe("visible");
    expect(digestInvocation(scope, defaultDigest).lane).toBe("history");
  });
});

it("rejects a different planning capture for optional attention ownership", async () => {
  const x = setup();
  x.setHandle((method, params) => {
    if (method !== "ticket.read") return sample(method);
    const base = sample("coordinator.overview");
    const ticketId = jsonField(params, "ticket_id");
    expect(jsonField(params, "at_revision")).toEqual(
      jsonField(base.response.meta, "workspace_revision"),
    );
    const ticket = raw(
      JSON.stringify({
        ticket_id: ticketId?.kind === "string" ? ticketId.value : "missing",
        display_key: "WG-1",
        title: "Changed after the capture",
        description: "",
        acceptance_criteria: "",
        revision: "1",
        membership_revision: "1",
        status: "todo",
        status_id: null,
        priority: "0",
        archived: false,
        assignee_id: "wrong-capture-actor",
        project_id: "release",
        milestone_id: null,
        parent_ticket_id: null,
        prerequisite_ticket_ids: [],
        related_ticket_ids: [],
        label_ids: [],
        claim: null,
        hold: null,
      }),
    );
    return {
      ...base,
      response: {
        ...base.response,
        data: d.jsonObject([["ticket", ticket]]),
        meta: replace(base.response.meta, "workspace_revision", d.jsonString("999999")),
      },
    };
  });
  await x.controller.open(x.context);
  const value = current(x.controller.get().coordination)?.value;
  expect(value).toBeDefined();
  expect(value?.items.some((row) => row.detail !== undefined)).toBe(false);
});

it("starts Overview near the current planning head and preserves explicit activity queries", async () => {
  const x = setup();
  x.setHandle((method) => {
    const value = sample(method);
    return method === "project.brief"
      ? {
          ...value,
          response: {
            ...value.response,
            meta: replace(value.response.meta, "workspace_revision", d.jsonString("1001")),
          },
        }
      : value;
  });
  await x.controller.open(x.context);
  expect(x.controller.get().digestQuery.after).toBe("901");
  const initial = x.calls.find((c) => c.method === "activity.digest");
  expect(initial && jsonField(initial.params, "after")).toEqual(d.jsonString("901"));
  await x.controller.setDigestQuery({ ...defaultDigest, after: "20", limit: "5" });
  await x.controller.refresh();
  expect(x.controller.get().digestQuery.after).toBe("20");
  expect(x.controller.get().digestQuery.limit).toBe("5");
});

it("retains the visible recent activity while a same-scope refresh is pending", async () => {
  const x = setup();
  await x.controller.open(x.context);
  const before = current(x.controller.get().digest);
  expect(before).toBeDefined();
  const pending = deferred<ReadResponse>();
  x.setHandle((method) => (method === "activity.digest" ? pending.promise : sample(method)));
  const refresh = x.controller.refresh();
  await until(() => x.controller.get().digest.kind === "loading");
  expect(current(x.controller.get().digest)).toBe(before);
  pending.resolve(sample("activity.digest"));
  await refresh;
  expect(x.controller.get().digest.kind).toBe("ready");
});

it("does not publish canceled passive question reads as refresh failures", async () => {
  const x = setup();
  await x.controller.open(x.context);
  const questionGate = deferred<ReadResponse>(),
    foregroundGate = deferred<ReadResponse>();
  let heldQuestion = false;
  const failures: string[] = [];
  const unsubscribe = x.controller.subscribe(() => {
    const value = x.controller.get().questions;
    if (value.kind === "failed") failures.push(value.failure.kind);
  });
  x.setHandle((method, params) => {
    if (method === "attention.read") return foregroundGate.promise;
    if (method === "coordinator.overview" && jsonField(params, "kinds") !== undefined) {
      heldQuestion = true;
      return questionGate.promise;
    }
    return sample(method);
  });
  const passive = x.controller.refreshLive(new AbortController().signal);
  await until(() => heldQuestion);
  const foreground = x.controller.refresh();
  questionGate.resolve(sample("coordinator.overview"));
  await passive;
  const duringRefresh = [...failures];
  foregroundGate.resolve(sample("attention.read"));
  await foreground;
  unsubscribe();
  expect(duringRefresh).toEqual([]);
  expect(failures).toEqual([]);
  expect(x.controller.get().questions.kind).toBe("ready");
});

it("defers passive refresh while a foreground refresh owns the page", async () => {
  const x = setup();
  await x.controller.open(x.context);
  const gate = deferred<ReadResponse>();
  x.setHandle((method) => (method === "attention.read" ? gate.promise : sample(method)));
  const foreground = x.controller.refresh();
  const calls = x.calls.length;
  await x.controller.refreshLive(new AbortController().signal);
  const afterPassive = x.calls.length;
  gate.resolve(sample("attention.read"));
  await foreground;
  expect(afterPassive).toBe(calls);
});
