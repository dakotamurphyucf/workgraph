import { afterEach, describe, expect, it } from "vitest";
import { jsonField, type JsonValue } from "../../src/core/json";
import * as c from "../../src/core/protocol/codec";
import * as d from "../../src/core/protocol/decoders";
import type { Companion } from "../../src/core/protocol/client";
import type { HttpClient, HttpRequest, HttpResult } from "../../src/core/protocol/http";
import type { Operation, Preparation, ReadResponse } from "../../src/core/protocol/types";
import { createOperationController } from "../../src/core/state/operations";
import { continued, invocation, validate } from "../../src/features/discussions/threads/client";
import { createThreadsController } from "../../src/features/discussions/threads/controller";
import { endpoint, validId } from "../../src/features/discussions/threads/model";
import type {
  DiscussionTarget,
  ReadCapture,
  ThreadsController,
  ThreadsRead,
} from "../../src/features/discussions/threads/types";
import { createTestProcessor } from "../core/processing-harness";
import { context, decode, json, response } from "../work/actions-fixtures";
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
  const http: HttpClient = {
    processing,
    request: async <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
      if (options.read === undefined) throw new Error("Unexpected native read");
      const result = await options.read(request);
      if (!result.ok) return result;
      const parsed = request.codec.decode(
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
      if (!parsed.ok) throw new Error(parsed.issue.expected);
      return ok(parsed.value);
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
  const controller = createThreadsController({ http, operations });
  disposals.push(
    () => controller.dispose(),
    () => operations.dispose(),
    () => processing.dispose(),
  );
  const selection = context(http);
  controller.open(selection);
  return { http, processing, operations, controller, selection };
}
function current(controller: ThreadsController) {
  const draft = controller
    .get()
    .drafts.find((value) => value.id === controller.get().selectedDraftId);
  if (draft === undefined) throw new Error("Missing editor");
  return draft;
}
function comment(body = "Original current body", revision = "1") {
  return {
    comment_id: "comment",
    target: { kind: "ticket", id: "ticket" },
    author_id: "author",
    created_at: "2026-11-07 11:00:00Z",
    reply_to_comment_id: null,
    kind: "comment",
    origin: "authored",
    revision,
    serial: "3",
    sequence: "50",
    actor_id: "author",
    timestamp: "2026-11-07 11:01:00Z",
    body,
    tombstone: false,
  };
}
function communication(data: unknown): ReadResponse {
  return {
    ...response(data),
    response: {
      data: json(data),
      meta: decode(c.object, { query_scope: "communication", query_revision: "9007199254740993" }),
    },
  };
}
function observed(
  preparation: Preparation,
  state: Operation["state"] = { kind: "prepared_unsent" },
): Operation {
  const connection = decode(d.connectionProfile, {
    id: "local",
    generation: "1",
    label: "Synthetic",
    socket: "/tmp/synthetic.sock",
  });
  return {
    format: "workgraph-ui-operation-1",
    operation_id: validId("native-operation", "Operation"),
    preparation: {
      intention_id: preparation.intention_id,
      connection,
      context: preparation.context,
      method: preparation.method,
      params: preparation.params,
    },
    preparation_input_hash: decode(d.digest, "b".repeat(64)),
    connection,
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
function captured(
  h: ReturnType<typeof harness>,
  selector: ThreadsRead,
  result: ReadResponse,
): ReadCapture {
  const e = endpoint(h.selection),
    request = invocation(e, selector),
    value = validate(e, selector, request, result);
  if (!value.ok) throw new Error(value.failure.kind);
  return value.data;
}
function continuationPage(
  h: ReturnType<typeof harness>,
  selector: ThreadsRead,
  data: unknown,
  params: unknown,
  nested = false,
): ReadCapture {
  const value = captured(h, selector, communication(data));
  const request = { method: value.captured.invocation.method, params };
  const metadata = nested
    ? { sections: [{ path: "/data/related/messages", next_request: request, retry_request: null }] }
    : { next_request: request, retry_request: null };
  return {
    ...value,
    captured: {
      ...value.captured,
      response: { ...value.captured.response, pagination: decode(c.object, metadata) },
    },
  };
}
const baseThread = {
  thread_id: "thread",
  revision: "2",
  board_id: "board",
  title: "A conversation",
  participants: [],
  mentions: [],
  links: [],
  state: "open",
  closure_policy: "manual",
  pinned: false,
  comment_ids: ["comment"],
  pinned_comment_ids: [],
};

describe("native discussion read contracts", () => {
  it("updates the retained-endpoint warning without resetting the selected discussion", () => {
    const h = harness();
    const selected: DiscussionTarget = {
      ...endpoint(h.selection),
      kind: "thread",
      threadId: validId("thread", "Thread"),
    };
    h.controller.open(h.selection, selected);
    const original = h.controller.get();
    h.controller.open(
      {
        ...h.selection,
        connection: {
          ...h.selection.connection,
          generation: decode(d.positiveDecimal, "2"),
          socket: "/tmp/replacement.sock",
        },
      },
      selected,
    );
    expect(h.controller.get().historicalGeneration).toBe(true);
    expect(h.controller.get().target).toBe(original.target);
    expect(h.controller.get().reads).toBe(original.reads);
    h.controller.open(h.selection, selected);
    expect(h.controller.get().historicalGeneration).toBe(false);
    expect(h.controller.get().target).toBe(original.target);
  });

  it("builds exact current-only selectors without inventing a ticket filter for thread.search", () => {
    const h = harness(),
      e = endpoint(h.selection);
    const request = invocation(e, {
      kind: "threads",
      filter: {
        scope: { kind: "project", id: validId("project", "Project") },
        boardId: "board",
        actorId: "author",
        status: "awaiting_response",
        unresolved: true,
        text: "current topic",
        pageSize: "1",
      },
    });
    expect(request.method).toBe("thread.search");
    expect(request.params.fields.map((field) => field.name)).toEqual([
      "workspace_id",
      "text",
      "scope",
      "board_id",
      "actor_id",
      "state",
      "unresolved",
      "offset",
      "limit",
      "max_bytes",
    ]);
    expect(
      invocation(e, { kind: "thread", threadId: validId("thread", "Thread") }).params.fields.map(
        (field) => field.name,
      ),
    ).toEqual([
      "workspace_id",
      "thread_id",
      "include_messages",
      "message_offset",
      "message_limit",
      "max_bytes",
    ]);
  });
  it("retains communication capture beyond JS integers and rejects changed selectors or guard", async () => {
    const h = harness(),
      selector: ThreadsRead = {
        kind: "boards",
        scope: { kind: "project", id: validId("project", "Project") },
      };
    const data = {
      items: [
        {
          board_id: "board",
          revision: "1",
          title: "Board",
          scope: { kind: "project", id: "project" },
        },
      ],
      offset: "0",
      remaining: "1",
      next_offset: "1",
    };
    const params = {
      workspace_id: "demo",
      scope: { kind: "project", id: "project" },
      offset: "1",
      limit: "25",
      max_bytes: "1048576",
      revision: "9007199254740993",
    };
    const page = continuationPage(h, selector, data, params),
      result = await continued(h.http, page, "next");
    expect(result.ok && jsonField(result.data.params, "revision")).toEqual(
      d.jsonString("9007199254740993"),
    );
    for (const altered of [
      { ...params, revision: "9007199254740992" },
      { ...params, scope: { kind: "workspace" } },
      { ...params, workspace_id: "other" },
      { ...params, offset: "2" },
      { ...params, ticket_id: "invented" },
      { ...params, max_bytes: "1048577" },
    ])
      expect(
        (await continued(h.http, continuationPage(h, selector, data, altered), "next")).ok,
      ).toBe(false);
  });
  it("requires nested native message section, original communication revision and discussion serial", async () => {
    const h = harness(),
      selector: ThreadsRead = { kind: "thread", threadId: validId("thread", "Thread") };
    const data = {
      ...baseThread,
      related: {
        thread_id: "thread",
        thread_revision: "2",
        discussion_serial: "100",
        messages: { items: [comment()], offset: "0", remaining: "1", next_offset: "1" },
      },
    };
    const params = {
      workspace_id: "demo",
      thread_id: "thread",
      include_messages: true,
      message_offset: "1",
      message_limit: "25",
      max_bytes: "1048576",
      revision: "9007199254740993",
      discussion_serial: "100",
    };
    expect(
      (await continued(h.http, continuationPage(h, selector, data, params, true), "next")).ok,
    ).toBe(true);
    expect(
      (
        await continued(
          h.http,
          continuationPage(h, selector, data, { ...params, discussion_serial: "101" }, true),
          "next",
        )
      ).ok,
    ).toBe(false);
    expect((await continued(h.http, continuationPage(h, selector, data, params), "next")).ok).toBe(
      false,
    );
  });
  it("validates current and historical record association and exact returned page offset", () => {
    const h = harness(),
      e = endpoint(h.selection),
      selector: ThreadsRead = {
        kind: "comment_history",
        commentId: validId("comment", "Comment"),
        target: { kind: "ticket", id: validId("ticket", "Ticket") },
        selectedRevision: decode(d.positiveDecimal, "1"),
      },
      request = invocation(e, selector);
    const page = (items: unknown[], offset = "0") =>
      response({ items, offset, remaining: "0", next_offset: null });
    expect(validate(e, selector, request, page([comment()])).ok).toBe(true);
    for (const value of [
      page([{ ...comment(), comment_id: "other" }]),
      page([{ ...comment(), target: { kind: "ticket", id: "other" } }]),
      page([comment(), comment()]),
      page([comment()], "1"),
    ])
      expect(validate(e, selector, request, value).ok).toBe(false);
  });
  it("rejects altered inbox consumer, interval, recipient and self/ticket filtering", () => {
    const h = harness(),
      e = endpoint(h.selection),
      selector: ThreadsRead = {
        kind: "messages",
        filter: {
          consumerId: "browser",
          recipient: { kind: "run", id: "reader" },
          after: "10",
          through: "20",
          ticketId: "ticket",
          excludeSelf: true,
        },
      },
      request = invocation(e, selector);
    const data = {
      consumer_id: "browser",
      recipient: { kind: "run", id: "reader" },
      after: "10",
      through: "20",
      next_after: "10",
      remaining: "0",
      exclude_self: true,
      items: [],
    };
    expect(validate(e, selector, request, communication(data)).ok).toBe(true);
    for (const altered of [
      { consumer_id: "actionable" },
      { recipient: { kind: "actor", id: "reader" } },
      { through: "21" },
      { after: "0" },
      { exclude_self: false },
    ])
      expect(validate(e, selector, request, communication({ ...data, ...altered })).ok).toBe(false);
  });
});

describe("launch-owned discussions", () => {
  it("restores all pinned message filters rather than inheriting current recipient/filter or author", async () => {
    let body: JsonValue | undefined;
    const h = harness({
      read: (request) => {
        body = request.body;
        return Promise.resolve<HttpResult<ReadResponse>>({
          ok: false,
          failure: { kind: "network", message: "Synthetic offline" },
        });
      },
    });
    h.controller.messageFilter({
      consumerId: "live",
      recipient: { kind: "actor", id: "current" },
      after: "0",
      through: "",
      ticketId: "live-ticket",
      excludeSelf: false,
    });
    const target: DiscussionTarget = {
      ...endpoint(h.selection),
      kind: "direct_messages",
      capture: {
        consumerId: validId("original-browser", "Consumer"),
        recipient: { kind: "run", id: validId("original-run", "Recipient") },
        after: decode(d.decimal, "10"),
        through: decode(d.decimal, "20"),
        ticketId: validId("original-ticket", "Ticket"),
        excludeSelf: true,
        notificationId: null,
      },
    };
    h.controller.open({ ...h.selection, writer: { actorId: "other-writer", runId: null } }, target);
    const filter = h.controller.get().messageFilter;
    expect(filter).toEqual({
      consumerId: "original-browser",
      recipient: { kind: "run", id: "original-run" },
      after: "10",
      through: "20",
      ticketId: "original-ticket",
      excludeSelf: true,
    });
    h.controller.messageFilter({ ...filter, ticketId: "live-ticket", excludeSelf: false });
    expect(h.controller.get().messageFilter).toEqual(filter);
    await h.controller.read({ kind: "messages", filter });
    if (body === undefined) throw new Error("Missing captured HTTP body");
    const encoded = await h.processing.encode(body);
    expect(encoded.ok && encoded.value.ok && encoded.value.value).toContain('"through":"20"');
    const previous = body;
    await h.controller.read({ kind: "messages", filter: { ...filter, ticketId: "live-ticket" } });
    expect(body).toBe(previous);
  });
  it("retains original unsent input/writer across actor and same-ID endpoint switches; retained endpoints cannot start new actions", () => {
    const h = harness(),
      id = h.controller.create({
        method: "comment.add",
        target: { kind: "ticket", id: validId("ticket", "Ticket") },
        body: "Original draft 雪",
        kind: "comment",
        replyToId: "",
      });
    expect(id).not.toBeNull();
    h.controller.open({ ...h.selection, writer: { actorId: "second", runId: null } });
    expect(current(h.controller).context.writer).toEqual({ actorId: "author", runId: "run-one" });
    const second = {
      ...h.selection,
      connection: { ...h.selection.connection, generation: decode(d.positiveDecimal, "2") },
    };
    h.controller.open(second, {
      ...endpoint(h.selection),
      kind: "ticket_discussion",
      ticketId: validId("ticket", "Ticket"),
      comment: null,
    });
    expect(h.controller.get().historicalGeneration).toBe(true);
    expect(
      h.controller.create({ method: "comment.edit", commentId: "comment", body: "New" }),
    ).toBeNull();
    expect(current(h.controller).input).toMatchObject({ body: "Original draft 雪" });
  });
  it("fences delayed current record reads after typing/discard even when transport ignores cancellation", async () => {
    const delayed = deferred<HttpResult<ReadResponse>>(),
      h = harness({ read: () => delayed.promise });
    const id = h.controller.create({
      method: "comment.edit",
      commentId: "comment",
      body: "My text",
    });
    if (id === null) throw new Error("Missing draft");
    const pending = h.controller.loadGuards(id);
    h.controller.edit(id, {
      method: "comment.edit",
      commentId: "comment",
      body: "More recent text",
    });
    delayed.resolve(ok(response(comment())));
    await pending;
    expect(current(h.controller).guards.comment).toBeUndefined();
    expect(current(h.controller).input).toMatchObject({ body: "More recent text" });
    const again = h.controller.loadGuards(id);
    h.controller.close(id);
    await again;
    expect(h.controller.get().drafts).toHaveLength(0);
  });
  it("coalesces Post before async register and preserves its exact identity on a failed prepare without sending", async () => {
    const delayed = deferred<HttpResult<Operation>>();
    let prepares = 0;
    const h = harness({
        prepare: async () => {
          prepares++;
          return delayed.promise;
        },
      }),
      id = h.controller.create({
        method: "comment.add",
        target: { kind: "ticket", id: validId("ticket", "Ticket") },
        body: "One original post",
        kind: "comment",
        replyToId: "",
      });
    if (id === null) throw new Error("Missing draft");
    const first = h.controller.post(id),
      second = h.controller.post(id);
    await expect.poll(() => prepares).toBe(1);
    h.controller.edit(id, {
      method: "comment.add",
      target: { kind: "ticket", id: validId("ticket", "Ticket") },
      body: "Must not replace pending text",
      kind: "comment",
      replyToId: "",
    });
    delayed.resolve({
      ok: false,
      failure: { kind: "network", message: "Unconfirmed preparation" },
    });
    await Promise.all([first, second]);
    expect(h.operations.list()).toHaveLength(1);
    expect(current(h.controller).phase.kind).toBe("captured");
    expect(current(h.controller).input).toMatchObject({ body: "One original post" });
    expect(current(h.controller).posted).toBe(false);
    h.controller.open({ ...h.selection, writer: { actorId: "new-author", runId: null } });
    expect(h.operations.get(id)?.preparation.context.writer).toEqual({
      actor_id: "author",
      run_id: "run-one",
    });
  });
  it("executes simple Post only once and keeps lost-reply recovery in the shared original operation", async () => {
    let saved: Preparation | undefined,
      executions = 0;
    const h = harness({
      prepare: (preparation) => {
        saved = preparation;
        return Promise.resolve(ok(observed(preparation)));
      },
      act: () => {
        executions++;
        if (saved === undefined) throw new Error("Missing prepared identity");
        return Promise.resolve(
          ok(
            observed(saved, {
              kind: "outcome_unknown",
              problem: decode(d.problem, {
                kind: "Outcome_unknown",
                message: "Synthetic lost acknowledgement",
              }),
            }),
          ),
        );
      },
    });
    const id = h.controller.create({
      method: "comment.add",
      target: { kind: "ticket", id: validId("ticket", "Ticket") },
      body: "One exact post",
      kind: "comment",
      replyToId: "",
    });
    if (id === null) throw new Error("Missing draft");
    await h.controller.post(id);
    expect(executions).toBe(1);
    expect(current(h.controller).posted).toBe(true);
    expect(h.operations.get(id)?.operation?.state.kind).toBe("outcome_unknown");
    await h.controller.post(id);
    await h.controller.review(id);
    expect(executions).toBe(1);
    expect(h.operations.list()).toHaveLength(1);
  });
  it("keeps oversized input as expected validation and preserves prior draft text", () => {
    const h = harness(),
      id = h.controller.create({ method: "comment.edit", commentId: "comment", body: "Keep" });
    if (id === null) throw new Error("Missing draft");
    h.controller.edit(id, {
      method: "comment.edit",
      commentId: "comment",
      body: "x".repeat(2 * 1024 * 1024 + 1),
    });
    expect(current(h.controller).input).toMatchObject({ body: "Keep" });
    expect(current(h.controller).issue).toContain("budget");
    expect(current(h.controller).unexpected).toBeNull();
  });
});

describe("discussion scope ownership", () => {
  it("keeps the surrounding project collection scoped when opening a specific thread", () => {
    const h = harness();
    h.controller.open(h.selection, {
      ...endpoint(h.selection),
      kind: "thread",
      threadId: validId("discussion", "Thread"),
    });
    expect(h.controller.get().filter.scope).toEqual({ kind: "project", id: "list-project" });
    expect(h.controller.get().target).toMatchObject({ kind: "thread", threadId: "discussion" });
  });
  it("defaults ordinary lists to selected project and resets them on project switch/back while preserving drafts", () => {
    const h = harness();
    expect(h.controller.get().filter.scope).toEqual({ kind: "project", id: "list-project" });
    const id = h.controller.create({
      method: "comment.edit",
      commentId: "comment",
      body: "Retain exact draft",
    });
    h.controller.filter({ ...h.controller.get().filter, text: "project-specific search" });
    h.controller.open({
      ...h.selection,
      route: { ...h.selection.route, projectId: "second-project" },
    });
    expect(h.controller.get().filter).toMatchObject({
      scope: { kind: "project", id: "second-project" },
      text: "",
    });
    h.controller.open(h.selection);
    expect(h.controller.get().filter.scope).toEqual({ kind: "project", id: "list-project" });
    expect(h.controller.get().selectedDraftId).toBe(id);
    expect(current(h.controller).input).toMatchObject({ body: "Retain exact draft" });
  });
  it("ignores late reads after a project switch even when the native transport ignores its signal", async () => {
    const delayed = deferred<HttpResult<ReadResponse>>(),
      h = harness({ read: () => delayed.promise });
    const pending = h.controller.read({ kind: "boards", scope: h.controller.get().filter.scope });
    h.controller.open({
      ...h.selection,
      route: { ...h.selection.route, projectId: "second-project" },
    });
    delayed.resolve(
      ok(communication({ items: [], offset: "0", remaining: "0", next_offset: null })),
    );
    await pending;
    expect(h.controller.get().reads.size).toBe(0);
    expect(h.controller.get().filter.scope).toEqual({ kind: "project", id: "second-project" });
  });
  it("keeps exact targets and their original message filters independent of changed project breadcrumbs", () => {
    const h = harness(),
      target: DiscussionTarget = {
        ...endpoint(h.selection),
        kind: "direct_messages",
        capture: {
          consumerId: validId("original", "Consumer"),
          recipient: { kind: "actor", id: validId("recipient", "Recipient") },
          after: decode(d.decimal, "0"),
          through: decode(d.decimal, "10"),
          ticketId: null,
          excludeSelf: false,
          notificationId: null,
        },
      };
    h.controller.open(h.selection, target);
    const original = h.controller.get();
    h.controller.open(
      {
        ...h.selection,
        route: { ...h.selection.route, projectId: "other" },
        writer: { actorId: "other", runId: null },
      },
      target,
    );
    expect(h.controller.get().target).toEqual(original.target);
    expect(h.controller.get().messageFilter).toEqual(original.messageFilter);
  });
  it("reports invalid recipient/counter fields as expected read failures rather than unexpected exceptions", async () => {
    const h = harness();
    await h.controller.read({
      kind: "messages",
      filter: { ...h.controller.get().messageFilter, recipient: { kind: "actor", id: "" } },
    });
    expect(h.controller.get().reads.get("messages")).toMatchObject({
      kind: "failed",
      failure: { kind: "input" },
    });
  });
});

describe("conversation selection keeps collection reads", () => {
  it("retains an in-flight collection and its filters across thread selection, but clears it for another project", async () => {
    const delayed = deferred<HttpResult<ReadResponse>>();
    const h = harness({ read: () => delayed.promise });
    const filter = { ...h.controller.get().filter, text: "review", boardId: "board" };
    h.controller.filter(filter);
    const pending = h.controller.read({ kind: "threads", filter });
    const before = h.controller.get().reads.get("threads");
    h.controller.open(h.selection, {
      ...endpoint(h.selection),
      kind: "thread",
      threadId: validId("first", "Thread"),
    });
    expect(h.controller.get().reads.get("threads")).toBe(before);
    expect(h.controller.get().filter).toEqual(filter);
    delayed.resolve(
      ok(communication({ items: [], offset: "0", remaining: "0", next_offset: null })),
    );
    await pending;
    expect(h.controller.get().reads.get("threads")?.kind).toBe("ready");
    const loaded = h.controller.get().reads.get("threads");
    h.controller.open(h.selection, {
      ...endpoint(h.selection),
      kind: "thread",
      threadId: validId("second", "Thread"),
    });
    expect(h.controller.get().reads.get("threads")).toBe(loaded);
    // A retained slot must still refresh after the detail target changes.
    await h.controller.refreshLive(new AbortController().signal);
    expect(h.controller.get().reads.get("threads")?.kind).toBe("ready");
    h.controller.open({ ...h.selection, route: { ...h.selection.route, projectId: "other" } });
    expect(h.controller.get().reads.size).toBe(0);
    expect(h.controller.get().filter.text).toBe("");
  });
});

it("All discussions clears a board filter after visiting a thread in that board", () => {
  const h = harness();
  h.controller.open(h.selection, {
    ...endpoint(h.selection),
    kind: "board",
    boardId: validId("board", "Board"),
  });
  expect(h.controller.get().filter.boardId).toBe("board");
  h.controller.open(h.selection, {
    ...endpoint(h.selection),
    kind: "thread",
    threadId: validId("thread", "Thread"),
  });
  expect(h.controller.get().filter.boardId).toBe("board");
  h.controller.open(h.selection);
  expect(h.controller.get().filter.boardId).toBe("");
  expect(h.controller.get().filter.scope).toEqual({ kind: "project", id: "list-project" });
});
