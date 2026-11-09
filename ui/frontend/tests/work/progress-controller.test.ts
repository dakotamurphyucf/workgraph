import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonField } from "../../src/core/json";
import * as d from "../../src/core/protocol/decoders";
import { object as objectCodec } from "../../src/core/protocol/codec";
import type { Companion } from "../../src/core/protocol/client";
import type { HttpClient, HttpRequest, HttpResult } from "../../src/core/protocol/http";
import type { Operation, Preparation, ReadResponse } from "../../src/core/protocol/types";
import { createOperationController } from "../../src/core/state/operations";
import { createWorkProgressController } from "../../src/features/work/progress/controller";
import {
  continuation,
  invocation,
  pageInvocation,
  validatePage,
} from "../../src/features/work/progress/client";
import type { ProgressController, ProgressPage } from "../../src/features/work/progress/types";
import type { WorkActionContext } from "../../src/features/work/read-model.types";
import { createTestProcessor } from "../core/processing-harness";
import { context, decode, json, response, target } from "./actions-fixtures";
const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Uninitialized deferred");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const ok = <T>(data: T): HttpResult<T> => ({ ok: true, httpStatus: 200, data });
function harness(
  options: {
    read?: (request: HttpRequest<unknown>) => Promise<HttpResult<ReadResponse>>;
    prepare?: Companion["prepare"];
    act?: Companion["act"];
  } = {},
) {
  const processing = createTestProcessor();
  disposals.push(() => processing.dispose());
  const client: HttpClient = {
    processing,
    request: async <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
      if (options.read === undefined) throw new Error("Unexpected read");
      const result = await options.read(request);
      if (!result.ok) return result;
      const decoded = request.codec.decode(
        d.jsonObject([
          [
            "response",
            d.jsonObject([
              ["data", result.data.response.data],
              ["meta", result.data.response.meta],
            ]),
          ],
          ["pagination", result.data.pagination ?? d.jsonNull()],
        ]),
      );
      if (!decoded.ok) throw new Error(decoded.issue.expected);
      return ok(decoded.value);
    },
  };
  const unexpected = (): Promise<never> => Promise.reject(new Error("Unexpected native operation"));
  const operations = createOperationController(
    {
      connections: unexpected,
      read: unexpected,
      prepare: options.prepare ?? unexpected,
      inspect: unexpected,
      act: options.act ?? unexpected,
    },
    processing,
  );
  const controller = createWorkProgressController({ client, operations });
  disposals.push(
    () => operations.dispose(),
    () => controller.dispose(),
  );
  const selection: WorkActionContext = {
    context: context(client),
    ...target(client, true),
    detail: null,
    intent: null,
    clearIntent: () => undefined,
  };
  controller.open(selection);
  return { client, processing, operations, controller, selection };
}
function current(controller: ProgressController) {
  const draft = controller.get().drafts.find((item) => item.id === controller.get().selectedId);
  if (draft === undefined) throw new Error("Missing selected editor");
  return draft;
}
function observed(
  preparation: Preparation,
  state: Operation["state"] = { kind: "prepared_unsent" },
): Operation {
  return {
    format: "workgraph-ui-operation-1",
    operation_id: decode(d.identifier, "native-operation"),
    preparation: {
      intention_id: preparation.intention_id,
      connection: decode(d.connectionProfile, {
        id: "local",
        generation: "1",
        label: "Synthetic",
        socket: "/tmp/synthetic.sock",
      }),
      context: preparation.context,
      method: preparation.method,
      params: preparation.params,
    },
    preparation_input_hash: decode(d.digest, "b".repeat(64)),
    connection: decode(d.connectionProfile, {
      id: "local",
      generation: "1",
      label: "Synthetic",
      socket: "/tmp/synthetic.sock",
    }),
    request: d.jsonObject([
      ["jsonrpc", d.jsonString("2.0")],
      ["workgraph_api", d.jsonString("0.7")],
      ["id", d.jsonString("request-1")],
      ["method", d.jsonString(preparation.method)],
      [
        "params",
        d.jsonObject([
          ...preparation.params.fields.map((field) => [field.name, field.value] as const),
          ["mutation_id", d.jsonString("original-mutation")],
        ]),
      ],
    ]),
    journal_path: "/tmp/original.json",
    revision: decode(d.positiveDecimal, state.kind === "prepared_unsent" ? "1" : "2"),
    state,
    diagnostic: null,
    receipt_lookup_supported: true,
  };
}
describe("launch-owned Work participation", () => {
  it("an obsolete comment read rejection cannot overwrite its replacement", async () => {
    let reject!: (error: unknown) => void;
    const pending = new Promise<never>((_, fail) => {
      reject = fail;
    });
    let calls = 0;
    const h = harness({
      read: () =>
        ++calls === 1
          ? pending
          : Promise.resolve({
              ok: false,
              failure: { kind: "network", message: "Current expected failure" },
            }),
    });
    const first = h.controller.read({ kind: "comments" });
    await vi.waitFor(() => expect(calls).toBe(1));
    await h.controller.read({ kind: "comments" });
    reject(new TypeError("obsolete comment failure"));
    await first;
    expect(h.controller.get().unexpected).toBeNull();
    const page = Object.values(h.controller.get().pages).find((value) => value.kind === "failed");
    expect(page?.kind).toBe("failed");
    if (page?.kind !== "failed") throw new Error("Expected current failed page");
    expect(page.failure).toEqual({ kind: "network", message: "Current expected failure" });
  });

  it("fences a late guard read after editing, even when transport ignores cancellation", async () => {
    const delayed = deferred<HttpResult<ReadResponse>>();
    const h = harness({ read: () => delayed.promise });
    const id = h.controller.create(h.selection, "handoff.set");
    if (id === null) throw new Error("Missing editor");
    const loading = h.controller.loadGuards(id),
      draft = current(h.controller);
    if (draft.input.method !== "handoff.set") throw new Error("Wrong method");
    h.controller.edit(id, {
      ...draft.input,
      fields: { ...draft.input.fields, summary: "Keep newly typed summary" },
    });
    delayed.resolve(ok(response({ ticket: { ticket_id: "target" }, handoff: null })));
    await loading;
    expect(current(h.controller).guards.handoff).toBeUndefined();
    expect(current(h.controller).input).toMatchObject({
      fields: { summary: "Keep newly typed summary" },
    });
  });
  it("retains unsent text and original writer/membership across scope changes and rejects oversize edits visibly", () => {
    const h = harness(),
      id = h.controller.create(h.selection, "comment.add");
    if (id === null) throw new Error("Missing editor");
    h.controller.edit(id, {
      method: "comment.add",
      body: "Retained exact text",
      kind: "comment",
      replyToId: "",
    });
    h.controller.open({
      ...h.selection,
      context: { ...h.selection.context, writer: { actorId: "another", runId: null } },
      scope: { ...h.selection.scope, workspaceId: decode(d.identifier, "second") },
    });
    expect(current(h.controller).capture.writer.actorId).toBe("author");
    expect(current(h.controller).capture.projectId).toBe("actual-project");
    h.controller.edit(id, {
      method: "comment.add",
      body: "x".repeat(2097153),
      kind: "comment",
      replyToId: "",
    });
    expect(current(h.controller).issue).toMatch(/previous text was preserved/u);
    expect(current(h.controller).input).toMatchObject({ body: "Retained exact text" });
  });
  it("coalesces Post before async registration and never repeats a transport-uncertain execute", async () => {
    const gate = deferred<void>();
    let prepares = 0,
      executes = 0;
    const h = harness({
      prepare: async (prep) => {
        prepares++;
        await gate.promise;
        return ok(observed(prep));
      },
      act: () => {
        executes++;
        return Promise.resolve({
          ok: false,
          failure: { kind: "network", message: "Lost browser reply" },
        });
      },
    });
    const id = h.controller.create(h.selection, "ticket.progress");
    if (id === null) throw new Error("Missing editor");
    h.controller.edit(id, {
      method: "ticket.progress",
      body: "Exact original",
      kind: "progress",
      replyToId: "",
    });
    const first = h.controller.post(id),
      second = h.controller.post(id);
    gate.resolve();
    await Promise.all([first, second]);
    expect(prepares).toBe(1);
    expect(executes).toBe(1);
    expect(h.operations.get(id)?.phase.kind).toBe("unconfirmed");
    await h.controller.post(id);
    expect(executes).toBe(1);
    expect(current(h.controller).issue).toMatch(/already attempted/u);
  });
  it("preserves one intention after preparation failure and explicit Post retry, without executing early", async () => {
    let prepares = 0,
      executes = 0;
    const seen: Preparation[] = [];
    const h = harness({
      prepare: (prep) => {
        seen.push(prep);
        prepares++;
        return Promise.resolve(
          prepares === 1
            ? { ok: false, failure: { kind: "network", message: "Preparation reply missing" } }
            : ok(observed(prep)),
        );
      },
      act: () => {
        executes++;
        return Promise.resolve({
          ok: false,
          failure: { kind: "network", message: "Execute reply missing" },
        });
      },
    });
    const id = h.controller.create(h.selection, "ticket.progress");
    if (id === null) throw new Error("Missing editor");
    h.controller.edit(id, {
      method: "ticket.progress",
      body: "Exact original",
      kind: "progress",
      replyToId: "",
    });
    await h.controller.post(id);
    expect(executes).toBe(0);
    expect(current(h.controller).phase.kind).toBe("captured");
    await h.controller.post(id);
    expect(executes).toBe(1);
    expect(seen[1]).toEqual(seen[0]);
  });
  it("records unexpected preparation exceptions distinctly and does not leave a floating rejection", async () => {
    const fault = new Error("Unexpected test fault"),
      h = harness({ prepare: () => Promise.reject(fault) });
    const id = h.controller.create(h.selection, "ticket.progress");
    if (id === null) throw new Error("Missing editor");
    h.controller.edit(id, {
      method: "ticket.progress",
      body: "Exact original",
      kind: "progress",
      replyToId: "",
    });
    await h.controller.post(id);
    expect(current(h.controller).unexpected?.error).toBe(fault);
    expect(current(h.controller).issue).toBeNull();
    expect(h.operations.get(id)?.phase.kind).toBe("unexpected_error");
  });
  it("cancels guard reads on disposal and refuses their late publication", async () => {
    const gate = deferred<HttpResult<ReadResponse>>();
    const h = harness({ read: () => gate.promise });
    const id = h.controller.create(h.selection, "handoff.set");
    if (id === null) throw new Error("Missing editor");
    const pending = h.controller.loadGuards(id);
    h.controller.dispose();
    const before = h.controller.get();
    gate.resolve(ok(response({ ticket: { ticket_id: "target" }, handoff: null })));
    await pending;
    expect(h.controller.get()).toBe(before);
  });
  it("uses exact bounded native continuations and rejects changed selector, target, capture and offset", () => {
    const h = harness(),
      selector = { kind: "comments" } as const,
      request = invocation(h.selection, selector);
    const next = {
      workspace_id: "demo",
      target: { kind: "ticket", id: "target" },
      include_tombstones: true,
      include_archived: true,
      max_bytes: "1048576",
      limit: "25",
      offset: "1",
      at_revision: "100",
    };
    const page: ProgressPage = {
      selector,
      method: request.method,
      params: request.params,
      value: json({ items: [], offset: "0", next_offset: "1", remaining: "1" }),
      response: {
        ...response({}),
        pagination: decode(objectCodec, {
          next_request: { method: request.method, params: next },
          retry_request: { method: request.method, params: { ...next, offset: "0" } },
        }),
      },
    };
    expect(continuation(page, "next")).toEqual(json(next));
    expect(jsonField(continuation(page, "retry"), "offset")).toEqual(d.jsonString("0"));
    for (const patch of [
      { workspace_id: "other" },
      { at_revision: "101" },
      { offset: "2" },
      { include_archived: false },
      { target: { kind: "ticket", id: "another" } },
      { added_selector: "no" },
    ])
      expect(() =>
        continuation(
          {
            ...page,
            response: {
              ...page.response,
              pagination: decode(objectCodec, {
                next_request: { method: request.method, params: { ...next, ...patch } },
              }),
            },
          },
          "next",
        ),
      ).toThrow();
    expect(pageInvocation(h.selection, { kind: "attempts" }, page, "next").ok).toBe(false);
    expect(pageInvocation(h.selection, { kind: "comments", pageSize: "1" }, page, "next").ok).toBe(
      false,
    );
  });
  it("decodes actual runs-page layout with its own revision and rejects cross-ticket or duplicate records", () => {
    const h = harness(),
      selector = { kind: "attempts" } as const,
      request = invocation(h.selection, selector);
    const item = {
      attempt_id: "actual-attempt",
      revision: "1",
      run_id: "run-one",
      ticket_id: "target",
      token: "9007199254740993",
      state: "running",
      session_ids: ["session"],
      checkpoints: [],
      evidence: "",
    };
    const result: ReadResponse = {
      response: {
        data: json({ items: [item], next_offset: null, omitted: "0" }),
        meta: decode(objectCodec, { query_scope: "runs", query_revision: "9007199254740997" }),
      },
      pagination: null,
    };
    expect(validatePage(h.selection, selector, request, result).ok).toBe(true);
    for (const data of [
      { items: [{ ...item, ticket_id: "other" }], next_offset: null, omitted: "0" },
      { items: [item, item], next_offset: null, omitted: "0" },
      { items: [item], next_offset: "2", omitted: "1" },
    ])
      expect(
        validatePage(h.selection, selector, request, {
          ...result,
          response: { ...result.response, data: json(data) },
        }).ok,
      ).toBe(false);
    expect(
      validatePage(h.selection, selector, request, {
        ...result,
        response: {
          ...result.response,
          meta: decode(objectCodec, { workspace_revision: "9007199254740997" }),
        },
      }).ok,
    ).toBe(false);
  });
  it("binds exact comment histories and refuses a contradictory evidence gate", () => {
    const h = harness(),
      selector = {
        kind: "comment_history",
        commentId: decode(d.identifier, "own-comment"),
      } as const,
      request = invocation(h.selection, selector);
    const item = {
      comment_id: "own-comment",
      revision: "1",
      actor_id: "author",
      author_id: "author",
      body: "Exact message",
      kind: "comment",
      origin: "authored",
      reply_to_comment_id: null,
      tombstone: false,
      sequence: "1",
      timestamp: "fixture",
      target: { kind: "ticket", id: "target" },
    };
    const result = response({ items: [item], offset: "0", next_offset: null, remaining: "0" });
    expect(validatePage(h.selection, selector, request, result).ok).toBe(true);
    for (const row of [
      { ...item, comment_id: "other" },
      { ...item, target: { kind: "ticket", id: "other" } },
    ])
      expect(
        validatePage(
          h.selection,
          selector,
          request,
          response({ items: [row], offset: "0", next_offset: null, remaining: "0" }),
        ).ok,
      ).toBe(false);
    const gate = { kind: "review_gate" } as const,
      metadata = decode(objectCodec, { query_scope: "evidence", query_revision: "0" });
    expect(
      validatePage(h.selection, gate, invocation(h.selection, gate), {
        response: { data: json({ allowed: true, problem: null }), meta: metadata },
        pagination: null,
      }).ok,
    ).toBe(true);
    expect(
      validatePage(h.selection, gate, invocation(h.selection, gate), {
        response: { data: json({ allowed: false, problem: null }), meta: metadata },
        pagination: null,
      }).ok,
    ).toBe(false);
  });
  it("Review loads a missing handoff guard without replacing entered text and never executes", async () => {
    let reads = 0,
      prepares = 0;
    const seen: Preparation[] = [];
    const h = harness({
      read: () => {
        reads++;
        return Promise.resolve(ok(response({ ticket: { ticket_id: "target" }, handoff: null })));
      },
      prepare: (prep) => {
        prepares++;
        seen.push(prep);
        return Promise.resolve(ok(observed(prep)));
      },
    });
    const id = h.controller.create(h.selection, "handoff.set");
    if (id === null) throw new Error("Missing editor");
    const initial = current(h.controller);
    if (initial.input.method !== "handoff.set") throw new Error("Wrong input");
    h.controller.edit(id, {
      ...initial.input,
      fields: {
        ...initial.input.fields,
        summary: "Keep this exact summary",
        nextSteps: "",
        evidence: "",
      },
    });
    await h.controller.review(id);
    expect(reads).toBe(1);
    expect(prepares).toBe(1);
    expect(current(h.controller).phase.kind).toBe("captured");
    expect(jsonField(seen[0]!.params, "summary")).toEqual(d.jsonString("Keep this exact summary"));
    expect(jsonField(seen[0]!.params, "expected_revision")).toEqual(d.jsonString("0"));
    expect(h.operations.get(id)?.operation?.state.kind).toBe("prepared_unsent");
  });
  it("copies only a known rejection after explicit refresh, preserving original author and the old request", async () => {
    const h = harness({
      prepare: (prep) =>
        Promise.resolve(
          ok(
            observed(prep, {
              kind: "rejected",
              problem: decode(d.problem, { kind: "Conflict", message: "Stale guard" }),
            }),
          ),
        ),
    });
    const id = h.controller.create(h.selection, "ticket.reopen");
    if (id === null) throw new Error("Missing editor");
    h.controller.edit(id, { method: "ticket.reopen", reason: "Original reopening reason" });
    await h.controller.review(id);
    const old = h.operations.get(id);
    expect(old?.operation?.state.kind).toBe("rejected");
    expect(h.controller.copy(id, h.selection)).toBeNull();
    expect(current(h.controller).issue).toMatch(/Refresh/u);
    const fresh = {
      ...h.selection,
      ticket: { ...h.selection.ticket, revision: decode(d.decimal, "101") },
      context: { ...h.selection.context, writer: { actorId: "different", runId: null } },
    };
    const copied = h.controller.copy(id, fresh);
    expect(copied).not.toBeNull();
    expect(copied).not.toBe(id);
    expect(current(h.controller).capture.writer.actorId).toBe("author");
    expect(current(h.controller).capture.ticket.revision).toBe("101");
    expect(current(h.controller).input).toEqual({
      method: "ticket.reopen",
      reason: "Original reopening reason",
    });
    expect(h.operations.get(id)).toBe(old);
    expect(h.operations.get(copied!)).toBeUndefined();
  });
  it("repeats only the exact failed captured read instead of restarting at a fresh revision", async () => {
    const seen: unknown[] = [];
    let count = 0;
    const h = harness({
      read: (request) => {
        seen.push(request.body);
        count++;
        return Promise.resolve({
          ok: false,
          failure: { kind: "network", message: "Synthetic failed page" },
        });
      },
    });
    await h.controller.read({ kind: "comments" });
    await h.controller.read({ kind: "comments" }, "repeat");
    expect(count).toBe(2);
    expect(seen[1]).toEqual(seen[0]);
    h.controller.open({
      ...h.selection,
      ticket: { ...h.selection.ticket, revision: decode(d.decimal, "101") },
    });
    await h.controller.read({ kind: "comments" }, "repeat");
    // Current ticket metadata advancing does not discard a captured comment
    // continuation or draft. Repeating keeps its original exact request.
    expect(count).toBe(3);
    expect(seen[2]).toEqual(seen[0]);
    h.controller.open({
      ...h.selection,
      scope: {
        ...h.selection.scope,
        connection: { ...h.selection.scope.connection, socket: "/tmp/another.sock" },
      },
    });
    await h.controller.read({ kind: "comments" }, "repeat");
    expect(count).toBe(3);
    expect(h.controller.get().issue).toMatch(/No matching captured/u);
  });
  it("loads an existing handoff without async prefill and copies text only on explicit fill", async () => {
    const handoff = {
      ticket_id: "target",
      actor_id: "author",
      revision: "2",
      summary: "Existing exact summary",
      next_steps: "Existing next",
      evidence: "Existing evidence",
      objective: "Existing objective",
      completed: "",
      decisions: "",
      blockers: "",
      resource_ids: ["notes"],
      covers_through: "17",
      timestamp: "fixture",
    };
    const h = harness({
        read: () => Promise.resolve(ok(response({ ticket: { ticket_id: "target" }, handoff }))),
      }),
      id = h.controller.create(h.selection, "handoff.set");
    if (id === null) throw new Error("Missing draft");
    const draft = current(h.controller);
    if (draft.input.method !== "handoff.set") throw new Error("Wrong input");
    h.controller.edit(id, {
      ...draft.input,
      fields: { ...draft.input.fields, summary: "Keep typed text until explicit replacement" },
    });
    await h.controller.loadGuards(id);
    expect(current(h.controller).input).toMatchObject({
      fields: { summary: "Keep typed text until explicit replacement" },
    });
    h.controller.fill(id);
    expect(current(h.controller).input).toMatchObject({
      fields: { summary: "Existing exact summary", resourceIds: "notes", coversThrough: "17" },
    });
  });
  it("refuses to fill from omitted text while keeping the user's prior handoff", async () => {
    const handoff = {
      ticket_id: "target",
      actor_id: "author",
      revision: "2",
      summary: "Prefix only",
      next_steps: "",
      evidence: "",
      objective: "",
      completed: "",
      decisions: "",
      blockers: "",
      resource_ids: [],
      covers_through: "0",
      timestamp: "fixture",
    };
    const h = harness({
        read: () =>
          Promise.resolve(
            ok({
              response: {
                data: json({ ticket: { ticket_id: "target" }, handoff }),
                meta: decode(objectCodec, {
                  workspace_revision: "100",
                  budget: { truncated: true },
                }),
              },
              pagination: null,
            }),
          ),
      }),
      id = h.controller.create(h.selection, "handoff.set");
    if (id === null) throw new Error("Missing draft");
    const old = current(h.controller).input;
    await h.controller.loadGuards(id);
    h.controller.fill(id);
    expect(current(h.controller).input).toEqual(old);
    expect(current(h.controller).issue).toMatch(/clipped preview/u);
  });
  it("retains a valid whole-amendment no-progress budget result without presenting false absence", () => {
    const h = harness(),
      selector = { kind: "amendments" } as const,
      initial = invocation(h.selection, selector),
      request = {
        ...initial,
        params: d.jsonObject(
          initial.params.fields.map((field) => [
            field.name,
            field.name === "max_bytes" ? d.jsonString("4096") : field.value,
          ]),
        ),
      };
    const value = response({
      items: [],
      offset: "0",
      remaining: "1",
      next_offset: "0",
      needs_larger_budget: true,
      required_bytes: "90000",
    });
    expect(validatePage(h.selection, selector, request, value).ok).toBe(true);
    expect(
      validatePage(
        h.selection,
        selector,
        request,
        response({
          items: [],
          offset: "0",
          remaining: "1",
          next_offset: null,
          needs_larger_budget: true,
          required_bytes: "90000",
        }),
      ).ok,
    ).toBe(false);
  });
});
