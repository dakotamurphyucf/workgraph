import { afterEach, describe, expect, it } from "vitest";
import { parseJsonText, jsonField } from "../../src/core/json";
import type { Codec } from "../../src/core/protocol/codec";
import * as d from "../../src/core/protocol/decoders";
import type { HttpClient } from "../../src/core/protocol/http";
import type {
  Captured,
  ThreadsDraft,
  ThreadsInput,
} from "../../src/features/discussions/threads/types";
import {
  capture,
  endpoint,
  preparation,
  validId,
} from "../../src/features/discussions/threads/model";
import { createTestProcessor } from "../core/processing-harness";
import {
  context as fixtureContext,
  decode as fixtureDecode,
  response as fixtureResponse,
} from "../work/actions-fixtures";
import * as codecs from "../../src/features/discussions/threads/codecs";
function decode<T>(codec: Codec<T>, value: unknown) {
  const parsed = parseJsonText(JSON.stringify(value));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return codec.decode(parsed.value.value);
}
function comment() {
  return {
    comment_id: "comment",
    target: { kind: "project", id: "project" },
    author_id: "original",
    created_at: "2026-11-07 11:00:00Z",
    reply_to_comment_id: null,
    kind: "comment",
    origin: "authored",
    revision: "2",
    serial: "9",
    sequence: "50",
    actor_id: "original",
    timestamp: "2026-11-07 11:01:00Z",
    body: "Current edited body",
    tombstone: false,
  };
}
function thread() {
  return {
    thread_id: "thread",
    revision: "3",
    board_id: "board",
    title: "Human thread title",
    participants: ["original"],
    mentions: [],
    links: [{ kind: "ticket", id: "ticket" }],
    state: "open",
    closure_policy: "manual",
    pinned: false,
    comment_ids: ["comment"],
    pinned_comment_ids: [],
    related: {
      thread_id: "thread",
      thread_revision: "3",
      discussion_serial: "9",
      messages: { items: [comment()], offset: "0", remaining: "0", next_offset: null },
    },
  };
}
function message() {
  return {
    notification_id: "3",
    sequence: "13",
    kind: "message_received",
    scope: { kind: "workspace" },
    source: { kind: "message", id: "message" },
    source_revision: "1",
    source_current_revision: "1",
    ticket_ids: ["ticket"],
    attribution: { actor_id: "original", run_id: null, timestamp: "2026-11-07 11:00:00Z" },
    body_source: {
      comment_id: "source-comment",
      revision: "1",
      serial: "2",
      actor_id: "original",
      timestamp: "2026-11-07 11:00:00Z",
      body: "Original frozen delivery body 雪",
      tombstone: false,
      version_kind: "captured",
    },
    causal_body: { comment_id: "source-comment", revision: "1" },
    request_status: null,
  };
}
function messages() {
  return {
    consumer_id: "received-browser",
    recipient: { kind: "actor", id: "recipient" },
    after: "0",
    through: "3",
    next_after: "3",
    remaining: "0",
    exclude_self: false,
    items: [message()],
  };
}
describe("native discussion projections", () => {
  it("preserves unprojected raw source and exact large revision strings", () => {
    const raw = {
      ...comment(),
      revision: "9007199254740993",
      future_source: { text: "preserved" },
    };
    const decoded = decode(codecs.comment, raw);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw Error("decode");
    expect(decoded.value.revision).toBe("9007199254740993");
    expect(jsonField(decoded.value.raw, "future_source")?.kind).toBe("object");
    expect(decoded.value.authorId).toBe("original");
    expect(decoded.value.createdAt).not.toBe(decoded.value.timestamp);
  });
  it("distinguishes board scope from supported comment/link targets and tombstone provenance", () => {
    expect(decode(codecs.scope, { kind: "ticket", id: "ticket" }).ok).toBe(false);
    expect(decode(codecs.link, { kind: "ticket", id: "ticket" }).ok).toBe(true);
    expect(decode(codecs.comment, { ...comment(), tombstone: true }).ok).toBe(false);
    const decoded = decode(codecs.comment, { ...comment(), tombstone: true, body: "" });
    expect(decoded.ok && decoded.value.authorId).toBe("original");
  });
  it("keeps nested attachment order and requires related records match exact thread revision", () => {
    const value = thread(),
      decoded = decode(codecs.thread, value);
    expect(decoded.ok && decoded.value.related?.messages.items[0]?.body).toBe(
      "Current edited body",
    );
    expect(
      decode(codecs.thread, { ...value, related: { ...value.related, thread_id: "other" } }).ok,
    ).toBe(false);
    expect(
      decode(codecs.thread, { ...value, related: { ...value.related, thread_revision: "2" } }).ok,
    ).toBe(false);
  });
  it("checks native cursor arithmetic without rounding and accepts explicit no-progress budget pages", () => {
    const page = codecs.page(codecs.comment);
    expect(
      decode(page, {
        items: [comment()],
        offset: "9007199254740993",
        remaining: "1",
        next_offset: "9007199254740994",
      }).ok,
    ).toBe(true);
    expect(
      decode(page, {
        items: [comment()],
        offset: "9007199254740993",
        remaining: "1",
        next_offset: "9007199254740993",
      }).ok,
    ).toBe(false);
    expect(decode(page, { items: [], offset: "0", remaining: "1", next_offset: "0" }).ok).toBe(
      true,
    );
    expect(decode(page, { items: [], offset: "0", remaining: "0", next_offset: "0" }).ok).toBe(
      false,
    );
  });
  it("reads original captured direct-message bytes independently from the edited current comment", () => {
    const decoded = decode(codecs.messages, messages());
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw Error("decode");
    const item = decoded.value.items[0];
    expect(item?.body?.body).toBe("Original frozen delivery body 雪");
    expect(item?.body?.revision).toBe("1");
    const current = decode(codecs.comment, comment());
    expect(current.ok && current.value.body).toBe("Current edited body");
    expect(decoded.value.consumerId).toBe("received-browser");
    expect(decoded.value.recipient).toEqual({ kind: "actor", id: "recipient" });
  });
  it("rejects malformed causal body associations or another notification kind", () => {
    const value = messages(),
      item = message();
    expect(
      decode(codecs.messages, {
        ...value,
        items: [{ ...item, causal_body: { comment_id: "other", revision: "1" } }],
      }).ok,
    ).toBe(false);
    expect(
      decode(codecs.messages, {
        ...value,
        items: [{ ...item, body_source: { ...item.body_source, revision: "2" } }],
      }).ok,
    ).toBe(false);
    expect(
      decode(codecs.messages, { ...value, items: [{ ...item, kind: "request_created" }] }).ok,
    ).toBe(false);
    expect(
      decode(codecs.messages, { ...value, items: [{ ...item, source_current_revision: "0" }] }).ok,
    ).toBe(false);
  });
  it("retains unread coverage even when after0 returns no rows, and validates actual returned serial cursor", () => {
    const value = messages();
    expect(decode(codecs.messages, { ...value, items: [], next_after: "0" }).ok).toBe(true);
    expect(decode(codecs.messages, { ...value, items: [], next_after: "3" }).ok).toBe(false);
    expect(decode(codecs.messages, { ...value, items: [message(), message()] }).ok).toBe(false);
    expect(decode(codecs.messages, { ...value, through: "2" }).ok).toBe(false);
  });
});

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});
function draft(input: ThreadsInput): ThreadsDraft {
  const processing = createTestProcessor();
  disposals.push(() => processing.dispose());
  const http: HttpClient = {
    processing,
    request: () => Promise.reject(Error("Pure model must not perform transport")),
  };
  const context = fixtureContext(http),
    scope = endpoint(context);
  return {
    id: validId("draft", "Draft"),
    context: capture(context, scope),
    endpoint: scope,
    input,
    guards: { board: undefined, thread: undefined, comment: undefined },
    editRevision: 0,
    phase: { kind: "editing" },
    issue: null,
    unexpected: null,
    posted: false,
  };
}
function captured<T>(
  value: T,
  source: ThreadsDraft,
  method: string,
  field: string,
  id: string,
): Captured<T> {
  return {
    endpoint: source.endpoint,
    invocation: {
      connection_id: source.endpoint.connectionId,
      generation: source.endpoint.generation,
      method,
      lane: "visible",
      params: d.jsonObject([
        ["workspace_id", d.jsonString(source.endpoint.workspaceId)],
        [field, d.jsonString(id)],
      ]),
    },
    response: fixtureResponse({}),
    value,
  };
}
describe("captured discussion commands", () => {
  it("keeps original actor/run and exact endpoint while binding native full board scope once", () => {
    const value = draft({
      method: "board.put",
      existing: false,
      fields: {
        id: "board",
        title: "Exact title 雪",
        scope: { kind: "project", id: "actual-project" },
      },
    });
    const prepared = preparation(value);
    expect(prepared.context).toEqual({
      workspace_id: "demo",
      project_id: "actual-project",
      writer: { actor_id: "author", run_id: "run-one" },
    });
    expect(jsonField(prepared.params, "expected_revision")).toEqual(d.jsonString("0"));
    expect(jsonField(prepared.params, "run_id")).toEqual(d.jsonString("run-one"));
    expect(new Set(prepared.params.fields.map((field) => field.name)).size).toBe(
      prepared.params.fields.length,
    );
    expect(() =>
      capture(
        {
          ...value.context,
          connection: {
            ...value.context.connection,
            generation: fixtureDecode(d.positiveDecimal, "2"),
          },
        },
        value.endpoint,
      ),
    ).toThrow("retained endpoint");
    expect(() =>
      capture({ ...value.context, writer: { actorId: null, runId: null } }, value.endpoint),
    ).toThrow("Acting author");
  });
  it("enforces native immutable board scope and thread board instead of offering an implicit move", () => {
    const value = draft({
      method: "board.put",
      existing: true,
      fields: { id: "board", title: "Changed", scope: { kind: "workspace" } },
    });
    const board = fixtureDecode(codecs.board, {
      board_id: "board",
      revision: "2",
      title: "Original",
      scope: { kind: "project", id: "actual-project" },
    });
    expect(() =>
      preparation({
        ...value,
        guards: {
          ...value.guards,
          board: captured(board, value, "board.get", "board_id", "board"),
        },
      }),
    ).toThrow("scope is immutable");
    const input: ThreadsInput = {
      method: "thread.put",
      existing: true,
      fields: {
        id: "thread",
        boardId: "another-board",
        title: "Changed",
        participants: "author",
        mentions: "",
        links: [],
        status: "open",
        closurePolicy: "manual",
        pinned: false,
      },
    };
    const edit = { ...value, input },
      threadRecord = fixtureDecode(codecs.thread, thread()),
      anotherBoard = { ...board, id: validId("another-board", "Board") };
    expect(() =>
      preparation({
        ...edit,
        guards: {
          board: captured(anotherBoard, edit, "board.get", "board_id", "another-board"),
          thread: captured(threadRecord, edit, "thread.get", "thread_id", "thread"),
          comment: undefined,
        },
      }),
    ).toThrow("board is immutable");
  });
  it("requires current original-author comment guards and forbids immutable completion evidence edits", () => {
    const value = draft({
      method: "comment.edit",
      commentId: "comment",
      body: "Deliberate exact replacement",
    });
    const source = fixtureDecode(codecs.comment, comment());
    expect(() =>
      preparation({
        ...value,
        guards: {
          ...value.guards,
          comment: captured(source, value, "comment.get", "comment_id", "comment"),
        },
      }),
    ).toThrow("original author");
    const owned = { ...source, authorId: validId("author", "Author") };
    expect(() =>
      preparation({
        ...value,
        guards: {
          ...value.guards,
          comment: captured(
            { ...owned, origin: "completion" },
            value,
            "comment.get",
            "comment_id",
            "comment",
          ),
        },
      }),
    ).toThrow("Completion evidence is immutable");
    expect(() =>
      preparation({
        ...value,
        guards: {
          ...value.guards,
          comment: captured(owned, value, "comment.history", "comment_id", "comment"),
        },
      }),
    ).toThrow("Load the captured comment");
    const prepared = preparation({
      ...value,
      guards: {
        ...value.guards,
        comment: captured(owned, value, "comment.get", "comment_id", "comment"),
      },
    });
    expect(jsonField(prepared.params, "expected_revision")).toEqual(d.jsonString("2"));
    expect(jsonField(prepared.params, "body")).toEqual(
      d.jsonString("Deliberate exact replacement"),
    );
  });
  it("attaches only a comment on the board scope and never rewrites the comment target", () => {
    const value = draft({ method: "thread.attach", threadId: "thread", commentId: "comment" }),
      board = fixtureDecode(codecs.board, {
        board_id: "board",
        revision: "1",
        title: "Board",
        scope: { kind: "project", id: "project" },
      }),
      record = fixtureDecode(codecs.thread, thread()),
      source = fixtureDecode(codecs.comment, comment());
    const guards = {
      board: captured(board, value, "board.get", "board_id", "board"),
      thread: captured(record, value, "thread.get", "thread_id", "thread"),
      comment: captured(source, value, "comment.get", "comment_id", "comment"),
    };
    const prepared = preparation({ ...value, guards });
    expect(jsonField(prepared.params, "expected_revision")).toEqual(d.jsonString("3"));
    expect(jsonField(prepared.params, "target")).toBeUndefined();
    expect(() =>
      preparation({
        ...value,
        guards: {
          ...guards,
          comment: captured(
            { ...source, target: { kind: "ticket", id: validId("ticket", "Ticket") } },
            value,
            "comment.get",
            "comment_id",
            "comment",
          ),
        },
      }),
    ).toThrow("exact scope");
    expect(() =>
      preparation({
        ...value,
        guards: {
          ...guards,
          thread: {
            ...guards.thread,
            endpoint: { ...value.endpoint, generation: fixtureDecode(d.positiveDecimal, "2") },
          },
        },
      }),
    ).toThrow("Load the captured thread");
  });
  it("freezes explicit direct routing and message identity, preserving original text without manufacturing conversation state", () => {
    const value = draft({
      method: "message.send",
      messageId: "stable-message",
      body: "Original exact body 雪",
      actorRecipients: "recipient",
      runRecipients: "recipient-run",
      teamIds: "team",
      ticketId: "ticket",
      replyToMessageId: "previous-message",
      correlationId: "correlation",
    });
    const prepared = preparation(value);
    expect(prepared.method).toBe("message.send");
    expect(jsonField(prepared.params, "message_id")).toEqual(d.jsonString("stable-message"));
    expect(jsonField(prepared.params, "body")).toEqual(d.jsonString("Original exact body 雪"));
    expect(jsonField(prepared.params, "recipients")).toEqual(
      d.jsonArray([
        d.jsonObject([
          ["kind", d.jsonString("actor")],
          ["id", d.jsonString("recipient")],
        ]),
        d.jsonObject([
          ["kind", d.jsonString("run")],
          ["id", d.jsonString("recipient-run")],
        ]),
      ]),
    );
    expect(jsonField(prepared.params, "thread_id")).toBeUndefined();
    expect(jsonField(prepared.params, "consumer_id")).toBeUndefined();
    if (value.input.method !== "message.send") throw Error("fixture");
    const input = value.input;
    expect(() =>
      preparation({
        ...value,
        input: { ...input, actorRecipients: "", runRecipients: "", teamIds: "" },
      }),
    ).toThrow("at least one");
    expect(() =>
      preparation({ ...value, input: { ...input, actorRecipients: "recipient\nrecipient" } }),
    ).toThrow("distinct IDs");
  });
});
