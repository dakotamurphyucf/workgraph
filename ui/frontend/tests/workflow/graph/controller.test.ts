import { afterEach, describe, expect, it } from "vitest";
import { jsonField } from "../../../src/core/json";
import * as d from "../../../src/core/protocol/decoders";
import * as c from "../../../src/core/protocol/codec";
import type { HttpClient, HttpRequest, HttpResult } from "../../../src/core/protocol/http";
import type { JsonObject, ReadResponse } from "../../../src/core/protocol/types";
import { createWorkController, DEFAULT_WORK_FILTERS } from "../../../src/features/work/read-model";
import { createGraphController } from "../../../src/features/workflow/graph/controller";
import {
  ancestryGap,
  relationAction,
  visibleGraphNodes,
  focusedNodes,
  layoutGraph,
  graphPositionBounds,
} from "../../../src/features/workflow/graph/model";
import { createTestProcessor } from "../../core/processing-harness";
import { context, decode, json } from "../../work/actions-fixtures";
import { id, policy, rawTicket } from "./fixtures";

const owners: (() => void)[] = [];
afterEach(() => {
  for (const dispose of owners.splice(0)) dispose();
});
function wire(data: unknown, revision = "100", pagination: unknown = null): ReadResponse {
  return decode(d.readResponse, {
    response: {
      data,
      meta: {
        workspace_revision: revision,
        budget: { truncated: false, omitted_fields: "0", omitted_items: "0" },
      },
    },
    pagination,
  });
}
function fixture(
  handler?: (method: string, params: JsonObject) => Promise<ReadResponse> | ReadResponse,
) {
  let revision = "100",
    ticketRevision = "1";
  const processor = createTestProcessor(),
    calls: { method: string; params: JsonObject }[] = [];
  const client: HttpClient = {
    processing: processor,
    async request<T>(request: HttpRequest<T>): Promise<HttpResult<T>> {
      if (request.body?.kind !== "object") throw new Error("Expected companion read");
      const method = jsonField(request.body, "method"),
        params = jsonField(request.body, "params");
      if (method?.kind !== "string" || params?.kind !== "object")
        throw new Error("Expected typed read");
      if (method.value === "ticket.hierarchy.get") {
        // Hierarchy_api.Get.codec accepts only ticket_id after workspace scoping.
        // Unlike paged planning reads, it has no revision/budget request fields.
        expect(
          c.record({ workspace_id: d.identifier, ticket_id: d.identifier }).decode(params).ok,
        ).toBe(true);
      }
      calls.push({ method: method.value, params });
      const data = handler
        ? await handler(method.value, params)
        : method.value === "ticket.list"
          ? wire(
              {
                items: [
                  rawTicket("a", { revision: ticketRevision }),
                  rawTicket("b", { revision: ticketRevision }),
                ],
                offset: "0",
                remaining: "0",
                next_offset: null,
              },
              revision,
            )
          : method.value === "ticket.hierarchy.get"
            ? policy("a", "inherit", revision).response
            : wire(
                {
                  ticket: rawTicket("outside", {
                    revision: ticketRevision,
                    project_id: "another-project",
                  }),
                },
                revision,
              );
      const decoded = request.codec.decode(
        d.jsonObject([
          [
            "response",
            d.jsonObject([
              ["data", data.response.data],
              ["meta", data.response.meta],
            ]),
          ],
          ["pagination", data.pagination ?? d.jsonNull()],
        ]),
      );
      return decoded.ok
        ? { ok: true, data: decoded.value, httpStatus: 200 }
        : {
            ok: false,
            failure: { kind: "protocol", message: "Bad synthetic response", issue: decoded.issue },
          };
    },
  };
  const work = createWorkController({ client }),
    graph = createGraphController({ http: client, readController: work }),
    initialContext = context(client),
    scope = {
      connection: initialContext.connection,
      workspaceId: id("demo"),
      projectId: id("northstar"),
    },
    ctx = {
      ...initialContext,
      writer: { actorId: "mira", runId: "mira-run" },
      route: {
        ...initialContext.route,
        projectId: "northstar",
        entityId: null,
        view: "workflow" as const,
      },
    };
  owners.push(() => {
    graph.dispose();
    work.dispose();
    processor.dispose();
  });
  return {
    work,
    graph,
    client,
    scope,
    ctx,
    calls,
    advance() {
      revision = "101";
      ticketRevision = "2";
    },
  };
}

describe("launch-owned graph captures", () => {
  it("loads shared parents once and follows a deep off-view ancestry chain without a depth cutoff", async () => {
    const f = fixture((method, params) => {
      const target = jsonField(params, "ticket_id");
      const key = target?.kind === "string" ? target.value : "";
      if (method === "ticket.list")
        return wire({
          items: Array.from({ length: 68 }, (_, i) =>
            rawTicket(`child-${i}`, { parent_ticket_id: "parent-0" }),
          ),
          offset: "0",
          remaining: "0",
          next_offset: null,
        });
      if (method === "ticket.hierarchy.get") return policy(key, "inherit", "100").response;
      const at = Number(key.slice("parent-".length));
      return wire({
        ticket: rawTicket(key, { parent_ticket_id: at < 69 ? `parent-${at + 1}` : null }),
      });
    });
    await f.work.open(f.scope, null);
    expect(f.graph.get().projection.unknownAncestry).toHaveLength(68);
    await f.graph.loadAncestry();
    expect(f.graph.get().projection.unknownAncestry).toHaveLength(0);
    expect(f.graph.get().expanded.size).toBe(70);
    expect(f.calls.filter((call) => call.method === "ticket.read")).toHaveLength(70);
    expect(f.calls.filter((call) => call.method === "ticket.hierarchy.get")).toHaveLength(70);
    const count = f.calls.length;
    await f.graph.loadAncestry();
    expect(f.calls).toHaveLength(count);
  });
  it("does not admit a parent policy from a different workspace revision", async () => {
    const f = fixture((method) =>
      method === "ticket.list"
        ? wire({
            items: [rawTicket("child", { parent_ticket_id: "parent" }), rawTicket("parent")],
            offset: "0",
            remaining: "0",
            next_offset: null,
          })
        : policy("parent", "inherit", "101").response,
    );
    await f.work.open(f.scope, null);
    await f.graph.loadAncestry();
    expect(f.graph.get().policies.size).toBe(0);
    expect(f.graph.get().projection.unknownAncestry).toEqual(["child"]);
    expect(f.graph.get().ancestryIssue).toContain("same workspace revision");
    expect(f.graph.get().ancestryLoading).toBe(false);
  });
  it("ignores an ancestry read after switching to another scope", async () => {
    let finish!: (value: ReadResponse) => void;
    const pending = new Promise<ReadResponse>((resolve) => {
      finish = resolve;
    });
    const f = fixture((method) =>
      method === "ticket.list"
        ? wire({
            items: [rawTicket("child", { parent_ticket_id: "parent" })],
            offset: "0",
            remaining: "0",
            next_offset: null,
          })
        : pending,
    );
    await f.work.open(f.scope, null);
    const loading = f.graph.loadAncestry();
    await f.work.open({ ...f.scope, projectId: id("other-project") }, null);
    finish(wire({ ticket: rawTicket("parent") }));
    await loading;
    expect(f.graph.get().expanded.size).toBe(0);
    expect(f.graph.get().ancestryLoading).toBe(false);
  });

  it("does not rethrow an obsolete boundary failure into the active component", async () => {
    let reject!: (error: unknown) => void;
    const pending = new Promise<ReadResponse>((_, fail) => {
      reject = fail;
    });
    const f = fixture((method) =>
      method === "ticket.read"
        ? pending
        : wire({ items: [rawTicket("a")], offset: "0", remaining: "0", next_offset: null }),
    );
    await f.work.open(f.scope, null);
    const first = f.graph.expand(id("outside"));
    const observed = first.then(
      () => "settled",
      () => "rejected",
    );
    await f.work.open({ ...f.scope, projectId: id("other-project") }, null);
    reject(new TypeError("obsolete boundary defect"));
    expect(await observed).toBe("settled");
    expect(f.graph.get().expanded.size).toBe(0);
    expect(f.graph.get().unexpected).toBeNull();
  });

  it("projects the complete pinned Work collection and retains large-layout movement", async () => {
    const f = fixture((_method, params) => {
      const field = jsonField(params, "offset"),
        offset = field?.kind === "string" ? Number(field.value) : 0,
        remaining = Math.max(0, 1040 - offset - 40),
        next = remaining > 0 ? String(offset + 40) : null;
      const nextParams = d.jsonObject([
        ...params.fields
          .filter((entry) => entry.name !== "offset" && entry.name !== "at_revision")
          .map((entry) => [entry.name, entry.value] as const),
        ["offset", d.jsonString(next ?? "1040")],
        ["at_revision", d.jsonString("100")],
      ]);
      return wire(
        {
          items: Array.from({ length: 40 }, (_, n) => rawTicket(`page-${offset + n}`)),
          offset: String(offset),
          remaining: String(remaining),
          next_offset: next,
        },
        "100",
        {
          capture: { workspace_revision: "100" },
          consistency: "current_revision_guard",
          complete: next === null,
          stop: next === null ? "complete" : "page_limit",
          next_request:
            next === null
              ? null
              : {
                  jsonrpc: "2.0",
                  workgraph_api: "0.7",
                  id: "synthetic-next",
                  method: "ticket.list",
                  params: nextParams.fields.reduce<Record<string, unknown>>((object, entry) => {
                    if (entry.value.kind === "string") object[entry.name] = entry.value.value;
                    else if (entry.value.kind === "boolean") object[entry.name] = entry.value.value;
                    return object;
                  }, {}),
                },
          retry_request: null,
        },
      );
    });
    await f.work.open(f.scope, null);
    expect(f.graph.get().pages).toHaveLength(1);
    expect(f.graph.get().projection.nodes).toHaveLength(1040);
    expect(f.graph.get().pages[0]?.value.remaining).toBe("0");
    expect(f.calls).toHaveLength(26);
    const last = id("page-999"),
      initial = layoutGraph(f.graph.get().projection, "none").positions.get(last)!;
    expect(initial.y).toBeGreaterThan(100000);
    expect(() => f.graph.move(last, { ...initial, x: initial.x + 24 })).not.toThrow();
    expect(f.graph.get().positions.get(last)).toEqual({ ...initial, x: initial.x + 24 });
    await f.work.page("next");
    expect(f.graph.get().pages).toHaveLength(1);
    expect(f.graph.get().projection.nodes).toHaveLength(1040);
    expect(f.graph.get().issue).toBeNull();
    expect(
      f.calls.slice(1).every((call) => {
        const revision = jsonField(call.params, "at_revision");
        return revision?.kind === "string" && revision.value === "100";
      }),
    ).toBe(true);
  });
  it("retains opening writer/records through actor switch, same-ID refresh and route remount", async () => {
    const f = fixture();
    await f.work.open(f.scope, null);
    f.graph.compose(f.ctx, { kind: "prerequisite", from: id("a"), to: id("b") });
    const draft = f.graph.get().composer!;
    f.graph.hideComposer();
    expect(f.graph.get().composerOpen).toBe(false);
    const switched = { ...f.ctx, writer: { actorId: "rowan", runId: "rowan-run" } };
    f.advance();
    await f.work.refresh();
    expect(f.graph.get().pages[0]?.value.items[0]?.revision).toBe("2");
    expect(f.graph.get().composer).toBe(draft);
    f.graph.compose(switched, { from: id("b"), to: id("a") });
    expect(f.graph.get().composerOpen).toBe(true);
    expect(f.graph.get().composer).toBe(draft);
    const action = relationAction(draft);
    expect(action.context.writer).toEqual({ actorId: "mira", runId: "mira-run" });
    expect(action.target.ticket.value.ticket.ticket_id).toBe("b");
    expect(action.target.ticket.value.ticket.revision).toBe("1");
    expect(action.target.ticket.revision).toBe("100");
    expect(action.edits).toEqual([
      ["prerequisite_id", { kind: "scalar", presence: "value", text: "a" }],
    ]);
    f.graph.closeComposer();
    f.graph.compose(switched, { from: id("a"), to: id("b") });
    expect(f.graph.get().composer?.context.writer.actorId).toBe("rowan");
    expect(f.graph.get().composer?.tickets[0]?.value.ticket.revision).toBe("2");
  });
  it("keeps a retained draft across a different endpoint/workspace scope without retargeting", async () => {
    const f = fixture();
    await f.work.open(f.scope, null);
    f.graph.compose(f.ctx, { from: id("a"), to: id("b") });
    await f.work.open({ ...f.scope, workspaceId: id("second") }, null);
    expect(f.graph.get().scope?.workspaceId).toBe("second");
    expect(relationAction(f.graph.get().composer!).target.scope.workspaceId).toBe("demo");
    expect(relationAction(f.graph.get().composer!).context.connection.generation).toBe("1");
  });
  it("keeps local layout/focus purely local and rejects nonfinite presentation inputs", async () => {
    const f = fixture();
    await f.work.open(f.scope, null);
    const before = f.calls.length;
    f.graph.present({
      focus: "ancestors",
      grouping: "milestone",
      layers: { related: true },
      zoom: 1.25,
    });
    f.graph.move(id("a"), { x: 50, y: 80 });
    expect(f.calls).toHaveLength(before);
    expect(f.graph.get().positions.get(id("a"))).toEqual({ x: 50, y: 80 });
    expect(() => f.graph.present({ zoom: NaN })).toThrow(RangeError);
    expect(() => f.graph.move(id("a"), { x: Infinity, y: 0 })).toThrow(RangeError);
    const bounds = graphPositionBounds(f.graph.get().projection);
    expect(() => f.graph.move(id("a"), { x: bounds.maxX + 1, y: 0 })).toThrow(RangeError);
    expect(() => f.graph.move(id("a"), { x: 0, y: bounds.maxY + 1 })).toThrow(RangeError);
    f.graph.resetLayout();
    expect(f.graph.get().positions.size).toBe(0);
  });
  it("ignores a late boundary read after capture refresh even when transport ignores cancellation", async () => {
    let release!: (response: ReadResponse) => void;
    const deferred = new Promise<ReadResponse>((resolve) => {
      release = resolve;
    });
    let revision = "100";
    const f = fixture((method) =>
      method === "ticket.list"
        ? wire(
            { items: [rawTicket("a")], offset: "0", remaining: "0", next_offset: null },
            revision,
          )
        : deferred,
    );
    await f.work.open(f.scope, null);
    const pending = f.graph.expand(id("outside"));
    revision = "101";
    await f.work.refresh();
    release(wire({ ticket: rawTicket("outside") }, "100"));
    await pending;
    expect(f.graph.get().revision).toBe("101");
    expect(f.graph.get().expanded.size).toBe(0);
    expect(f.graph.get().referenceRead.kind).toBe("idle");
  });
  it("uses the exact native current-only hierarchy request and admits only a matching returned planning revision", async () => {
    const f = fixture();
    await f.work.open(f.scope, null);
    await f.graph.policy(id("a"));
    expect(f.calls.at(-1)).toEqual({
      method: "ticket.hierarchy.get",
      params: d.jsonObject([
        ["workspace_id", d.jsonString("demo")],
        ["ticket_id", d.jsonString("a")],
      ]),
    });
    expect(f.graph.get().policies.get(id("a"))?.revision).toBe("100");
    f.advance(); // Current-only hierarchy is now revision101; graph remains100.
    await f.graph.policy(id("b"));
    expect(f.graph.get().policies.has(id("b"))).toBe(false);
    // Mismatched identity is rejected separately; a matching future policy below
    // proves the revision guard rather than relying on that identity check.
    const changed = fixture((method) =>
      method === "ticket.list"
        ? wire({
            items: [rawTicket("a"), rawTicket("child", { parent_ticket_id: "a" })],
            offset: "0",
            remaining: "0",
            next_offset: null,
          })
        : policy("a", "inherit", "101").response,
    );
    await changed.work.open(changed.scope, null);
    await changed.graph.policy(id("a"));
    expect(changed.graph.get().policyRead.kind).toBe("ready");
    expect(changed.graph.get().policies.size).toBe(0);
    expect(changed.graph.get().issue).toContain("revision 101, while this graph is revision 100");
    expect(changed.graph.get().projection.unknownAncestry).toContain("child");
    expect(changed.graph.get().projection.relations.some((edge) => edge.kind === "inherited")).toBe(
      false,
    );
  });
  it("rejects mismatched hierarchy identities instead of projecting another ticket policy", async () => {
    const f = fixture((method) =>
      method === "ticket.list"
        ? wire({ items: [rawTicket("a")], offset: "0", remaining: "0", next_offset: null })
        : policy("other", "inherit").response,
    );
    await f.work.open(f.scope, null);
    await f.graph.policy(id("a"));
    expect(f.graph.get().policyRead.kind).toBe("failed");
    expect(f.graph.get().policies.size).toBe(0);
  });
  it("clears previous graph pages on filter change and never merges different captures", async () => {
    const f = fixture();
    await f.work.open(f.scope, null);
    const oldId = f.graph.get().pages[0]?.id;
    f.advance();
    await f.work.setFilters({ ...DEFAULT_WORK_FILTERS, text: "new query" });
    expect(f.graph.get().pages).toHaveLength(1);
    expect(f.graph.get().pages[0]?.id).not.toBe(oldId);
    expect(f.graph.get().revision).toBe("101");
  });
  it("does not associate the previous ready page with a newly published filter while its read is pending", async () => {
    let release!: (value: ReadResponse) => void,
      reads = 0;
    const pending = new Promise<ReadResponse>((resolve) => {
      release = resolve;
    });
    const f = fixture(() =>
      ++reads === 1
        ? wire({ items: [rawTicket("old")], offset: "0", remaining: "0", next_offset: null })
        : pending,
    );
    await f.work.open(f.scope, null);
    const update = f.work.setFilters({ ...DEFAULT_WORK_FILTERS, text: "new" });
    expect(f.graph.get().pages).toEqual([]);
    expect(f.graph.get().projection.nodes).toEqual([]);
    release(
      wire({ items: [rawTicket("new")], offset: "0", remaining: "0", next_offset: null }, "101"),
    );
    await update;
    expect(f.graph.get().projection.nodes.map((node) => node.id)).toEqual(["new"]);
  });
  it("walks past a captured independent parent to the first missing higher ancestor policy", async () => {
    const f = fixture((method, params) => {
      if (method === "ticket.list")
        return wire({
          items: [
            rawTicket("p"),
            rawTicket("middle", { parent_ticket_id: "p" }),
            rawTicket("child", { parent_ticket_id: "middle" }),
          ],
          offset: "0",
          remaining: "0",
          next_offset: null,
        });
      const key = jsonField(params, "ticket_id");
      return policy(key?.kind === "string" ? key.value : "bad", "independent").response;
    });
    await f.work.open(f.scope, null);
    expect(ancestryGap(f.graph.get(), id("child"))).toEqual({ id: "middle", kind: "policy" });
    await f.graph.policy(id("middle"));
    expect(ancestryGap(f.graph.get(), id("child"))).toEqual({ id: "p", kind: "policy" });
  });
  it("prioritizes a selected/focused ticket beyond the initial 200 nodes", async () => {
    const f = fixture();
    await f.work.open(f.scope, null);
    const base = f.graph.get().projection.nodes[0]!;
    const nodes = Array.from({ length: 250 }, (_, n) => ({ ...base, id: id(`node-${n}`) }));
    const projection = { ...f.graph.get().projection, nodes, relations: [] };
    const visible = visibleGraphNodes(
      projection,
      id("node-249"),
      focusedNodes(projection, id("node-249"), "neighbors"),
    );
    expect(visible).toHaveLength(200);
    expect(visible[0]?.id).toBe("node-249");
  });
  it("resolves display keys at the captured revision and rejects a wrong returned key", async () => {
    const f = fixture((method, params) =>
      method === "ticket.list"
        ? wire({ items: [rawTicket("a")], offset: "0", remaining: "0", next_offset: null })
        : wire({
            ticket_id: "actual",
            display_key: jsonField(params, "display_key")?.kind === "string" ? "SYN-42" : "bad",
          }),
    );
    await f.work.open(f.scope, null);
    expect(await f.graph.resolve("SYN-42")).toBe("actual");
    expect(jsonField(f.calls.at(-1)!.params, "at_revision")).toEqual(json("100"));
    expect(await f.graph.resolve("SYN-other")).toBeNull();
    expect(f.graph.get().resolutionRead.kind).toBe("failed");
  });
});
