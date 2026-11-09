import { afterEach, describe, expect, it } from "vitest";
import { createWorkController, current, queryParams } from "../../src/features/work/read-model";
import {
  completionCodec,
  contextCodec,
  decodeCapture,
  listCodec,
  readinessCodec,
  ticketCodec,
} from "../../src/features/work/read-model.codec";
import type { WorkController, WorkScope } from "../../src/features/work/read-model.types";
import { DEFAULT_WORK_FILTERS } from "../../src/features/work/read-model";
import { jsonField, parseJsonText, type JsonValue } from "../../src/core/json";
import * as d from "../../src/core/protocol/decoders";
import type { Codec } from "../../src/core/protocol/codec";
import type { HttpClient, HttpRequest, HttpResult } from "../../src/core/protocol/http";
import type { JsonObject, ReadResponse } from "../../src/core/protocol/types";
import { createTestProcessor } from "../core/processing-harness";

function json(value: unknown): JsonValue {
  const r = parseJsonText(JSON.stringify(value));
  if (!r.ok) throw new Error(r.error.message);
  return r.value.value;
}
function decode<T>(codec: Codec<T>, value: unknown): T {
  const r = codec.decode(json(value));
  if (!r.ok) throw new Error(`${r.issue.path.join(".")}: ${r.issue.expected}`);
  return r.value;
}
const scope: WorkScope = {
  connection: decode(d.connectionProfile, {
    id: "local",
    generation: "1",
    label: "Synthetic",
    socket: "/tmp/synthetic.sock",
  }),
  workspaceId: decode(d.identifier, "demo"),
  projectId: decode(d.identifier, "release"),
};
const checks = [
  "hold",
  "prerequisites",
  "children",
  "amendment_acknowledgements",
  "configured_policy",
];
function completion() {
  return {
    can_complete: true,
    checks: checks.map((kind) => ({ kind, passed: true })),
    blocked_prerequisite_ids: [],
    blocked_prerequisite_count: "0",
    unfinished_child_ids: [],
    unfinished_child_count: "0",
    problem: null,
    policy: { digest: "a".repeat(64) },
  };
}
function ready() {
  return {
    ready: true,
    assessment: { scope: "graph", unknown_checks: [] },
    reason_count: "0",
    reasons: [],
    completion: completion(),
  };
}
function ticket(id = "one") {
  return {
    ticket_id: id,
    display_key: `SYN-${id}`,
    title: `Full title for ${id} — 雪`,
    description: "## Synthetic instructions\n\n```ocaml\nlet result = 42\n```",
    acceptance_criteria: "Capture all source-rule links.",
    revision: "9007199254740993",
    membership_revision: "1",
    status: "todo",
    status_id: null,
    priority: "2",
    archived: false,
    assignee_id: null,
    project_id: "release",
    milestone_id: null,
    parent_ticket_id: null,
    prerequisite_ticket_ids: [],
    related_ticket_ids: [],
    label_ids: [],
    claim: null,
    hold: null,
  };
}
function page(
  items: readonly unknown[],
  offset = "0",
  next: string | null = null,
  remaining = "0",
) {
  return { items, offset, next_offset: next, remaining };
}
function context(id = "one") {
  return {
    ticket: ticket(id),
    readiness: ready(),
    completion_readiness: completion(),
    parent: null,
    blocker_ticket_ids: [],
    related: page([]),
    resources: page([]),
    communication: { threads: page([]), requests: page([]) },
    amendments: page([]),
    pending_amendment_acknowledgements: page([]),
    attempts: page([]),
    recoveries: page([]),
    children: page([]),
    updates: page([]),
    activity_since_handoff: page([]),
    fact_keys: { items: [], remaining: "0", total: "0" },
    handoff: null,
  };
}
function next(method: string, params: unknown) {
  return { jsonrpc: "2.0", workgraph_api: "0.7", id: "next", method, params };
}
function pagination(revision = "7", extra: Record<string, unknown> = {}) {
  return {
    capture: { workspace_revision: revision },
    consistency: "current_revision_guard",
    complete: true,
    stop: "complete",
    next_request: null,
    retry_request: null,
    ...extra,
  };
}
function response(data: unknown, paging: unknown = pagination(), revision = "7"): ReadResponse {
  return decode(d.readResponse, {
    response: {
      data,
      meta: {
        workspace_revision: revision,
        budget: { truncated: false, omitted_fields: "0", omitted_items: "0" },
      },
    },
    pagination: paging,
  });
}
const owners: {
  readonly controller: WorkController;
  readonly processor: ReturnType<typeof createTestProcessor>;
}[] = [];
afterEach(() => {
  for (const { controller, processor } of owners) {
    controller.dispose();
    processor.dispose();
  }
  owners.length = 0;
});
function fixture(
  handler: (
    method: string,
    params: JsonObject,
    signal: AbortSignal | undefined,
  ) => Promise<ReadResponse> | ReadResponse,
) {
  const processor = createTestProcessor(),
    calls: { method: string; params: JsonObject; signal: AbortSignal | undefined }[] = [];
  const client: HttpClient = {
    processing: processor,
    async request<T>(request: HttpRequest<T>): Promise<HttpResult<T>> {
      const name = request.body?.kind === "object" ? jsonField(request.body, "method") : undefined,
        params = request.body?.kind === "object" ? jsonField(request.body, "params") : undefined;
      if (name?.kind !== "string" || params?.kind !== "object")
        throw new Error("Expected read invocation");
      calls.push({ method: name.value, params, signal: request.signal });
      const result = await handler(name.value, params, request.signal);
      const decoded = request.codec.decode(
        d.jsonObject([
          [
            "response",
            d.jsonObject([
              ["data", result.response.data],
              ["meta", result.response.meta],
            ]),
          ],
          ["pagination", result.pagination ?? d.jsonNull()],
        ]),
      );
      return decoded.ok
        ? { ok: true, data: decoded.value, httpStatus: 200 }
        : {
            ok: false,
            failure: {
              kind: "protocol",
              message: "Invalid fixture response",
              issue: decoded.issue,
            },
          };
    },
  };
  const controller = createWorkController({ client });
  owners.push({ controller, processor });
  return { controller, calls };
}
function standard(method: string, params: JsonObject): ReadResponse {
  const id = jsonField(params, "ticket_id"),
    name = id?.kind === "string" ? id.value : "one";
  if (method === "ticket.list") return response(page([ticket()]));
  if (method === "ticket.read") return response({ ticket: ticket(name) }, null);
  if (method === "ticket.context")
    return response(context(name), pagination("7", { sections: [] }));
  return response(ready(), null);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("captured work read projections", () => {
  it("preserves exact counters, complete title and unprojected lossless fields", () => {
    const value = ticket();
    const raw = json({ ...value, lease_detail: { source: "retained" } });
    const result = ticketCodec.decode(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.revision).toBe("9007199254740993");
    expect(result.value.raw).toBe(raw);
    expect(result.value.title).toContain("雪");
  });
  it("rejects malformed statuses, claims, identity duplicates and skipped page rows", () => {
    expect(ticketCodec.decode(json({ ...ticket(), status: "ready" })).ok).toBe(false);
    expect(
      ticketCodec.decode(
        json({ ...ticket(), claim: { actor_id: "actor", run_id: null, token: "0" } }),
      ).ok,
    ).toBe(false);
    expect(listCodec.decode(json(page([ticket(), ticket()]))).ok).toBe(false);
    expect(listCodec.decode(json(page([ticket()], "0", "2", "9"))).ok).toBe(false);
  });
  it("retains graph vs candidate unknown checks and rejects invented readiness/completion counts", () => {
    const value = ready();
    expect(readinessCodec.decode(json({ ...value, reason_count: "1" })).ok).toBe(false);
    expect(readinessCodec.decode(json({ ...value, ready: false })).ok).toBe(false);
    expect(completionCodec.decode(json({ ...completion(), can_complete: false })).ok).toBe(false);
    expect(
      completionCodec.decode(
        json({
          ...completion(),
          checks: [...completion().checks.slice(1), completion().checks[1]],
        }),
      ).ok,
    ).toBe(false);
    const candidate = {
      ...value,
      assessment: {
        scope: "candidate",
        unknown_checks: ["run_lifecycle", "run_budget", "required_path_ownership"],
      },
    };
    expect(decode(readinessCodec, candidate).assessment).toEqual(candidate.assessment);
  });
  it("keeps inherited prerequisites source identity and exact error details", () => {
    const reason = {
      kind: "inherited_prerequisite",
      ancestor_ticket_id: "parent",
      prerequisite_ticket_id: "prereq",
    };
    const result = decode(readinessCodec, {
      ...ready(),
      ready: false,
      reason_count: "1",
      reasons: [reason],
    });
    expect(jsonField(result.reasons[0]!, "ancestor_ticket_id")).toEqual(d.jsonString("parent"));
    expect(
      readinessCodec.decode(
        json({
          ...ready(),
          ready: false,
          reason_count: "1",
          reasons: [{ kind: "invented_permission" }],
        }),
      ).ok,
    ).toBe(false);
  });
  it("requires every nested context section, preserving missing versus empty", () => {
    const full = context();
    expect(contextCodec.decode(json(full)).ok).toBe(true);
    expect(contextCodec.decode(json({ ...full, updates: undefined })).ok).toBe(false);
    const result = decode(contextCodec, full);
    expect(result.sections["/data/updates"]?.items).toEqual([]);
    expect(result.sections["/data/fact_keys"]?.remaining).toBe("0");
  });
  it("rejects continuation query drift, cross-generation-target scopes, wrong revisions and mutation methods", () => {
    const params = queryParams(scope, DEFAULT_WORK_FILTERS);
    for (const change of [
      { method: "ticket.move" },
      { workspace_id: "other" },
      { at_revision: "8" },
      { project_id: "other" },
      { text: "changed" },
    ]) {
      const method = "method" in change ? change.method : "ticket.list";
      const selectors = {
        workspace_id: "demo",
        project_id: "release",
        max_bytes: "1048576",
        limit: "40",
        include_archived: false,
        offset: "1",
        at_revision: "7",
        ...change,
      };
      delete (selectors as { method?: string }).method;
      const value = response(
        page([ticket()], "0", "1", "1"),
        pagination("7", {
          complete: false,
          stop: "page_limit",
          next_request: next(method, selectors),
        }),
      );
      expect(decodeCapture(value, listCodec, scope, "ticket.list", params).ok).toBe(false);
    }
  });
  it("admits exact native continuation and partiality without inventing a total", () => {
    const params = queryParams(scope, DEFAULT_WORK_FILTERS),
      selectors = {
        workspace_id: "demo",
        project_id: "release",
        max_bytes: "1048576",
        limit: "40",
        include_archived: false,
        offset: "1",
        at_revision: "7",
      };
    const capture = decodeCapture(
      response(
        page([ticket()], "0", "1", "9007199254740993"),
        pagination("7", {
          complete: false,
          stop: "page_limit",
          next_request: next("ticket.list", selectors),
        }),
      ),
      listCodec,
      scope,
      "ticket.list",
      params,
    );
    expect(capture.ok).toBe(true);
    if (!capture.ok) return;
    expect(capture.value.partial).toBe(true);
    expect(capture.value.controls[0]?.next?.params).toEqual(json(selectors));
    expect(capture.value.value.remaining).toBe("9007199254740993");
  });
  it("captures all filter selectors without interpreting assignment as ownership", () => {
    const params = queryParams(scope, {
      ...DEFAULT_WORK_FILTERS,
      text: "雪",
      status: "in_progress",
      priority: "1",
      assigneeId: "assigned",
      labelId: "label",
      milestoneId: "mile",
      includeArchived: true,
    });
    expect(jsonField(params, "assignee_id")).toEqual(d.jsonString("assigned"));
    expect(jsonField(params, "label_id")).toEqual(d.jsonString("label"));
    expect(jsonField(params, "status")).toEqual(d.jsonString("in_progress"));
    expect(jsonField(params, "actor_id")).toBeUndefined();
  });
});
describe("work read ownership and capture lifecycle", () => {
  it("opens tickets on Conversation while preserving the tab during refresh and identical remount", async () => {
    const { controller } = fixture(standard);
    const one = decode(d.identifier, "one");
    await controller.open(scope, one);
    for (const tab of ["relationships", "completion", "admission", "details"] as const) {
      controller.setPresentation({ tab });
      await controller.refreshLive(new AbortController().signal);
      await controller.refresh();
      await controller.open({ ...scope }, one);
      expect(controller.get().tab).toBe(tab);
      await controller.open(scope, null);
      await controller.open(scope, one);
      expect(controller.get().tab).toBe("activity");
    }
    controller.setPresentation({ tab: "details" });
    await controller.open(scope, decode(d.identifier, "other"));
    expect(controller.get().tab).toBe("activity");
    controller.setPresentation({ tab: "completion" });
    await controller.open({ ...scope, projectId: null }, one);
    expect(controller.get().tab).toBe("activity");
  });
  it("loads the list and current inspector independently so ordinary selections can follow updates", async () => {
    const { controller, calls } = fixture(standard);
    await controller.open(scope, decode(d.identifier, "one"));
    expect(calls.map((c) => c.method)).toEqual([
      "ticket.list",
      "ticket.read",
      "ticket.context",
      "ticket.readiness",
    ]);
    for (const call of calls.slice(1))
      expect(jsonField(call.params, "at_revision")).toBeUndefined();
    expect(current(controller.get().ticket)?.value.ticket.title).toBe(ticket().title);
    expect(controller.get().readinessTarget).toBeNull();
  });
  it("does not issue duplicate reads for an identical remount, preserves presentation and query", async () => {
    const { controller, calls } = fixture(standard);
    await controller.open(scope, null);
    controller.setPresentation({ layout: "board", grouping: "priority", tab: "completion" });
    await controller.setFilters({ ...DEFAULT_WORK_FILTERS, text: "synthetic" });
    const count = calls.length;
    await controller.open({ ...scope }, null);
    expect(calls.length).toBe(count);
    expect(controller.get().layout).toBe("board");
    expect(controller.get().filters.text).toBe("synthetic");
  });
  it("ignores a late old endpoint response even when transport ignores cancellation", async () => {
    const old = deferred<ReadResponse>(),
      { controller, calls } = fixture((method, params) =>
        calls.length === 1 ? old.promise : standard(method, params),
      );
    const first = controller.open(scope, null),
      secondScope = {
        ...scope,
        connection: { ...scope.connection, generation: decode(d.decimal, "2") },
      };
    await controller.open(secondScope, null);
    old.resolve(response(page([ticket("stale")])));
    await first;
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(current(controller.get().list)?.value.items[0]?.ticket_id).toBe("one");
    expect(controller.get().scope?.connection.generation).toBe("2");
  });
  it("keeps an explicit unavailable deep link selected, rather than falling back to first list row", async () => {
    const { controller } = fixture(standard);
    await controller.open(scope, decode(d.identifier, "outside"));
    expect(controller.get().selectedId).toBe("outside");
    expect(current(controller.get().ticket)?.value.ticket.ticket_id).toBe("outside");
  });
  it("follows exact selected section params without replacing sibling sections or ticket header", async () => {
    const selectors = {
      workspace_id: "demo",
      ticket_id: "one",
      max_bytes: "1048576",
      limit: "20",
      include_archived: false,
      at_revision: "7",
      offset: "1",
    };
    const first = {
      ...context(),
      updates: page([{ body: "first" }], "0", "1", "2"),
      children: page([ticket("child")]),
    };
    const { controller, calls } = fixture((method, params) => {
      if (method !== "ticket.context") return standard(method, params);
      if (jsonField(params, "offset"))
        return response(
          { ...context(), updates: page([{ body: "second" }], "1", null, "0") },
          pagination("7", {
            sections: [
              {
                path: "/data/updates",
                complete: true,
                stop: "complete",
                next_request: null,
                retry_request: null,
              },
            ],
          }),
        );
      return response(
        first,
        pagination("7", {
          complete: false,
          stop: "page_limit",
          sections: [
            {
              path: "/data/updates",
              complete: false,
              stop: "page_limit",
              next_request: next("ticket.context", selectors),
              retry_request: null,
            },
          ],
        }),
      );
    });
    await controller.open(scope, decode(d.identifier, "one"));
    const id = current(controller.get().ticket)?.id;
    await controller.section("/data/updates", "next");
    expect(calls.at(-1)?.params).toEqual(json(selectors));
    expect(current(controller.get().sections["/data/updates"]!)?.value.items[0]).toEqual(
      json({ body: "second" }),
    );
    expect(current(controller.get().context)?.value.sections["/data/children"]?.items.length).toBe(
      1,
    );
    expect(current(controller.get().ticket)?.id).toBe(id);
  });
  it("captures readiness identity before await and never mutates it when caller switches actor", async () => {
    const pending = deferred<ReadResponse>();
    let assessment = false;
    const { controller, calls } = fixture((method, params) =>
      assessment && method === "ticket.readiness" ? pending.promise : standard(method, params),
    );
    await controller.open(scope, decode(d.identifier, "one"));
    assessment = true;
    const writer = { actorId: "actor", runId: "run-one" },
      task = controller.assess(writer);
    writer.actorId = "other";
    writer.runId = "run-two";
    expect(controller.get().readinessTarget).toEqual({ actorId: "actor", runId: "run-one" });
    expect(jsonField(calls.at(-1)!.params, "target_run_id")).toEqual(d.jsonString("run-one"));
    pending.resolve(
      response({ ...ready(), assessment: { scope: "run", unknown_checks: [] } }, null),
    );
    await task;
    expect(controller.get().readinessTarget?.runId).toBe("run-one");
  });
  it("assesses only the loaded page in bounded graph-only requests and ignores later old-page results", async () => {
    const waits: ReturnType<typeof deferred<ReadResponse>>[] = [];
    const { controller, calls } = fixture((method, params) => {
      if (method === "ticket.list")
        return response(page(Array.from({ length: 8 }, (_, i) => ticket(`row-${i}`))));
      if (method === "ticket.readiness") {
        const wait = deferred<ReadResponse>();
        waits.push(wait);
        return wait.promise;
      }
      return standard(method, params);
    });
    await controller.open(scope, null);
    const task = controller.assessLoaded();
    expect(waits.length).toBe(4);
    const refresh = controller.setFilters({ ...DEFAULT_WORK_FILTERS, text: "new" });
    await refresh;
    for (const wait of waits) wait.resolve(response(ready(), null));
    await task;
    expect(controller.get().assessed).toEqual({});
    expect(calls.filter((c) => c.method === "ticket.readiness").length).toBe(4);
    expect(controller.get().assessing).toBe(false);
  });
  it("rejects invalid query inputs before sending and preserves current read", async () => {
    const { controller, calls } = fixture(standard);
    await controller.open(scope, null);
    const count = calls.length;
    await expect(
      controller.setFilters({ ...DEFAULT_WORK_FILTERS, text: "雪".repeat(86) }),
    ).rejects.toThrow("256");
    await expect(
      controller.setFilters({ ...DEFAULT_WORK_FILTERS, labelId: "bad/id" }),
    ).rejects.toThrow("identifier");
    expect(calls.length).toBe(count);
  });
});

describe("bounded native projection and independent section captures", () => {
  it("accepts a valid prose-bounded context while retaining complete protected readiness", () => {
    const params = d.jsonObject([
      ["workspace_id", d.jsonString("demo")],
      ["ticket_id", d.jsonString("one")],
    ]);
    const source = response(
      { ...context(), ticket: { ...ticket(), description: "bounded prefix" } },
      pagination("7", { sections: [] }),
    );
    const bounded = {
      ...source,
      response: {
        ...source.response,
        meta: d.jsonObject([
          ["workspace_revision", d.jsonString("7")],
          [
            "budget",
            json({
              truncated: true,
              omitted_fields: "1",
              omitted_items: "0",
              details: [{ path: "/data/ticket/description", kind: "text_bytes", omitted: "5000" }],
              details_complete: true,
            }),
          ],
        ]),
      },
    };
    const result = decodeCapture(bounded, contextCodec, scope, "ticket.context", params);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.partial).toBe(true);
    expect(result.value.value.readiness.reason_count).toBe("0");
    expect(result.value.value.readiness.ready).toBe(true);
  });
  it("rejects impossible target assessment, wrong ticket and malformed omission summaries", () => {
    const params = d.jsonObject([
      ["workspace_id", d.jsonString("demo")],
      ["ticket_id", d.jsonString("one")],
    ]);
    expect(
      decodeCapture(
        response({ ...ready(), assessment: { scope: "candidate", unknown_checks: [] } }, null),
        readinessCodec,
        scope,
        "ticket.readiness",
        params,
      ).ok,
    ).toBe(false);
    expect(
      decodeCapture(response(context("other")), contextCodec, scope, "ticket.context", params).ok,
    ).toBe(false);
    const source = response(context());
    const bad = {
      ...source,
      response: {
        ...source.response,
        meta: d.jsonObject([
          ["workspace_revision", d.jsonString("7")],
          ["budget", json({ truncated: true, omitted_fields: "0", omitted_items: "0" })],
        ]),
      },
    };
    expect(decodeCapture(bad, contextCodec, scope, "ticket.context", params).ok).toBe(false);
  });
  it("continues context fact metadata via fact.keys and subsequent root pages at the same capture", async () => {
    const firstSelectors = {
        workspace_id: "demo",
        scope: { kind: "ticket", id: "one" },
        max_bytes: "1048576",
        limit: "20",
        at_revision: "7",
        offset: "1",
      },
      secondSelectors = { ...firstSelectors, offset: "2" };
    const { controller, calls } = fixture((method, params) => {
      if (method === "ticket.context")
        return response(
          { ...context(), fact_keys: { items: [{ key: "first" }], remaining: "2", total: "3" } },
          pagination("7", {
            complete: false,
            stop: "page_limit",
            sections: [
              {
                path: "/data/fact_keys",
                response_path: "/data",
                complete: false,
                stop: "page_limit",
                next_request: next("fact.keys", firstSelectors),
                retry_request: null,
              },
            ],
          }),
        );
      if (method === "fact.keys")
        return jsonField(params, "offset")?.kind === "string" &&
          (jsonField(params, "offset") as { value: string }).value === "1"
          ? response(
              page([{ key: "second" }], "1", "2", "1"),
              pagination("7", {
                complete: false,
                stop: "page_limit",
                next_request: next("fact.keys", secondSelectors),
              }),
            )
          : response(page([{ key: "third" }], "2", null, "0"));
      return standard(method, params);
    });
    await controller.open(scope, decode(d.identifier, "one"));
    await controller.section("/data/fact_keys", "next");
    expect(calls.at(-1)?.method).toBe("fact.keys");
    expect(current(controller.get().sections["/data/fact_keys"]!)?.value.offset).toBe("1");
    await controller.section("/data/fact_keys", "next");
    expect(calls.at(-1)?.params).toEqual(json(secondSelectors));
    expect(current(controller.get().sections["/data/fact_keys"]!)?.value.items[0]).toEqual(
      json({ key: "third" }),
    );
  });
  it("ignores an obsolete nested page after selecting another ticket", async () => {
    const pending = deferred<ReadResponse>(),
      selectors = {
        workspace_id: "demo",
        ticket_id: "one",
        max_bytes: "1048576",
        limit: "20",
        include_archived: false,
        at_revision: "7",
        offset: "1",
      };
    const { controller } = fixture((method, params) => {
      if (method === "ticket.context" && jsonField(params, "offset")) return pending.promise;
      if (
        method === "ticket.context" &&
        jsonField(params, "ticket_id")?.kind === "string" &&
        (jsonField(params, "ticket_id") as { value: string }).value === "one"
      )
        return response(
          { ...context(), updates: page([{ body: "first" }], "0", "1", "1") },
          pagination("7", {
            complete: false,
            stop: "page_limit",
            sections: [
              {
                path: "/data/updates",
                complete: false,
                stop: "page_limit",
                next_request: next("ticket.context", selectors),
                retry_request: null,
              },
            ],
          }),
        );
      return standard(method, params);
    });
    await controller.open(scope, decode(d.identifier, "one"));
    const task = controller.section("/data/updates", "next");
    await controller.select(decode(d.identifier, "other"));
    pending.resolve(
      response(
        { ...context(), updates: page([{ body: "stale" }], "1", null, "0") },
        pagination("7", { sections: [] }),
      ),
    );
    await task;
    expect(controller.get().sections).toEqual({});
    expect(current(controller.get().ticket)?.value.ticket.ticket_id).toBe("other");
  });
});

describe("complete ticket collection", () => {
  function paginated(method: string, params: JsonObject): ReadResponse {
    if (method !== "ticket.list") return standard(method, params);
    const offset = jsonField(params, "offset");
    const position = offset?.kind === "string" ? offset.value : "0";
    if (position === "0") {
      const selectors = Object.fromEntries(
        params.fields.map((field) => [
          field.name,
          field.value.kind === "string" || field.value.kind === "boolean"
            ? field.value.value
            : null,
        ]),
      );
      return response(
        page([ticket("first")], "0", "1", "1"),
        pagination("7", {
          complete: false,
          stop: "page_limit",
          next_request: next("ticket.list", { ...selectors, offset: "1", at_revision: "7" }),
        }),
      );
    }
    return response(page([ticket("second")], "1"));
  }
  it("follows exact continuations, retaining filters and every ticket", async () => {
    const { controller, calls } = fixture(paginated);
    await controller.open(scope, null);
    await controller.setFilters({ ...DEFAULT_WORK_FILTERS, text: "雪", assigneeId: "reviewer" });
    expect(current(controller.get().list)?.value.items.map((item) => item.ticket_id)).toEqual([
      "first",
      "second",
    ]);
    expect(current(controller.get().list)?.value.offset).toBe("0");
    expect(current(controller.get().list)?.value.remaining).toBe("0");
    const request = calls.at(-1)?.params;
    expect(request && jsonField(request, "at_revision")).toEqual(d.jsonString("7"));
    expect(request && jsonField(request, "text")).toEqual(d.jsonString("雪"));
    expect(request && jsonField(request, "assignee_id")).toEqual(d.jsonString("reviewer"));
    await controller.refreshLive(new AbortController().signal);
    expect(current(controller.get().list)?.value.items.map((item) => item.ticket_id)).toEqual([
      "first",
      "second",
    ]);
  });
  it("retains the complete previous collection if a continuation fails its revision guard", async () => {
    let changed = false;
    const { controller } = fixture((method, params) => {
      if (changed && method === "ticket.list" && jsonField(params, "offset") !== undefined)
        return response(page([ticket("wrong-capture")], "1"), pagination("8"), "8");
      return paginated(method, params);
    });
    await controller.open(scope, null);
    changed = true;
    await controller.refresh();
    expect(controller.get().list.kind).toBe("failed");
    expect(current(controller.get().list)?.value.items.map((item) => item.ticket_id)).toEqual([
      "first",
      "second",
    ]);
    changed = false;
    await controller.refresh();
    expect(controller.get().list.kind).toBe("ready");
  });
  it("rejects duplicate tickets across pages", async () => {
    const { controller } = fixture((method, params) =>
      method === "ticket.list" && jsonField(params, "offset") !== undefined
        ? response(page([ticket("first")], "1"))
        : paginated(method, params),
    );
    await controller.open(scope, null);
    expect(controller.get().list.kind).toBe("failed");
    expect(current(controller.get().list)).toBeUndefined();
  });
  it("does not publish a superseded collection after filters change mid-continuation", async () => {
    const wait = deferred<ReadResponse>();
    const { controller } = fixture((method, params) => {
      if (method !== "ticket.list") return standard(method, params);
      if (jsonField(params, "text") !== undefined) return response(page([ticket("replacement")]));
      return jsonField(params, "offset") !== undefined ? wait.promise : paginated(method, params);
    });
    const initial = controller.open(scope, null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await controller.setFilters({ ...DEFAULT_WORK_FILTERS, text: "new" });
    wait.resolve(response(page([ticket("stale")], "1")));
    await initial;
    expect(current(controller.get().list)?.value.items.map((item) => item.ticket_id)).toEqual([
      "replacement",
    ]);
  });
});
