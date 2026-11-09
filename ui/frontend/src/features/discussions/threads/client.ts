import { jsonField, type JsonValue } from "../../../core/json";
import { createCompanion } from "../../../core/protocol/client";
import * as d from "../../../core/protocol/decoders";
import type { HttpClient, HttpResult } from "../../../core/protocol/http";
import type {
  Decimal,
  JsonObject,
  ReadInvocation,
  ReadResponse,
} from "../../../core/protocol/types";
import { HTTP_LIMITS } from "../../../core/protocol/worker/jobs";
import * as codecs from "./codecs";
import { linkJson, sameLink, text, ThreadsInputError, validId } from "./model";
import type {
  Captured,
  Board,
  Comment,
  DraftGuards,
  Endpoint,
  ReadCapture,
  Thread,
  ThreadsDraft,
  ThreadsRead,
  ThreadsValue,
} from "./types";

export const protocol = (message: string): HttpResult<never> => ({
  ok: false,
  failure: { kind: "protocol", message, issue: undefined },
});
export function record(value: JsonValue | undefined, label: string): JsonObject {
  if (value?.kind !== "object") throw new ThreadsInputError(`${label} is not an object.`);
  return value;
}
function decimal(value: JsonValue | undefined, label: string): Decimal {
  const result = d.decimal.decode(value);
  if (!result.ok) throw new ThreadsInputError(`${label} is not an exact bounded decimal.`);
  return result.value;
}
function string(value: JsonValue | undefined, label: string): string {
  if (value?.kind !== "string") throw new ThreadsInputError(`${label} is not text.`);
  return value.value;
}
export function selectorKey(selector: ThreadsRead): string {
  // Only bounded typed form fields enter this local identity, never daemon JSON.
  return JSON.stringify(selector);
}
export function invocation(endpoint: Endpoint, selector: ThreadsRead): ReadInvocation {
  const params: [string, JsonValue][] = [["workspace_id", d.jsonString(endpoint.workspaceId)]];
  let method: string;
  const add = (name: string, value: string) => params.push([name, d.jsonString(value)]);
  switch (selector.kind) {
    case "boards":
      method = "board.list";
      if (selector.scope !== null) params.push(["scope", linkJson(selector.scope)]);
      break;
    case "board":
      method = "board.get";
      add("board_id", selector.boardId);
      break;
    case "threads": {
      const f = selector.filter;
      method = f.text.trim() === "" ? "thread.list" : "thread.search";
      if (method === "thread.search") add("text", text(f.text, "Search", 512));
      if (f.scope !== null) params.push(["scope", linkJson(f.scope)]);
      if (f.boardId !== "") add("board_id", validId(f.boardId, "Board"));
      if (f.actorId !== "") add("actor_id", validId(f.actorId, "Participant"));
      if (f.status !== "all") add("state", f.status);
      params.push(["unresolved", d.jsonBoolean(f.unresolved)]);
      break;
    }
    case "thread":
      method = "thread.get";
      add("thread_id", selector.threadId);
      params.push(["include_messages", d.jsonBoolean(true)]);
      add("message_offset", "0");
      add("message_limit", "25");
      break;
    case "thread_history":
      method = "thread.history";
      add("thread_id", selector.threadId);
      break;
    case "ticket_comments":
      method = "comment.list";
      params.push(
        ["target", linkJson({ kind: "ticket", id: selector.ticketId })],
        ["include_tombstones", d.jsonBoolean(true)],
        ["include_archived", d.jsonBoolean(true)],
      );
      break;
    case "comment_history":
      method = "comment.history";
      add("comment_id", selector.commentId);
      params.push(["include_archived", d.jsonBoolean(true)]);
      break;
    case "messages": {
      const f = selector.filter;
      method = "inbox.read";
      add("consumer_id", validId(f.consumerId, "Received-message browser consumer"));
      params.push(
        [
          "recipient",
          d.jsonObject([
            ["kind", d.jsonString(f.recipient.kind)],
            ["id", d.jsonString(validId(f.recipient.id, "Recipient"))],
          ]),
        ],
        ["kinds", d.jsonArray([d.jsonString("message_received")])],
        ["exclude_self", d.jsonBoolean(f.excludeSelf)],
      );
      add("after", decimal(d.jsonString(f.after), "After"));
      if (f.through !== "") add("through", decimal(d.jsonString(f.through), "Through"));
      if (f.ticketId !== "") add("ticket_id", validId(f.ticketId, "Ticket filter"));
      add("limit", "25");
      break;
    }
  }
  if (!["board", "thread", "messages"].includes(selector.kind)) {
    add("offset", "0");
    add("limit", selector.kind === "threads" ? selector.filter.pageSize : "25");
  }
  add("max_bytes", "1048576");
  return {
    connection_id: endpoint.connectionId,
    generation: endpoint.generation,
    lane: "visible",
    method,
    params: d.jsonObject(params),
  };
}

function decoded(selector: ThreadsRead, data: JsonValue): HttpResult<ThreadsValue> {
  const finish = <T>(
    result: codecsResult<T>,
    map: (value: T) => ThreadsValue,
  ): HttpResult<ThreadsValue> =>
    result.ok
      ? { ok: true, httpStatus: 200, data: map(result.value) }
      : protocol(
          `Invalid discussion record at ${result.issue.path.join("/")}: ${result.issue.expected}.`,
        );
  switch (selector.kind) {
    case "boards":
      return finish(codecs.page(codecs.board).decode(data), (page) => ({ kind: "boards", page }));
    case "board":
      return finish(codecs.board.decode(data), (board) => ({ kind: "board", board }));
    case "threads":
    case "thread_history": {
      const kind = selector.kind;
      return finish(codecs.page(codecs.thread).decode(data), (page) => ({ kind, page }));
    }
    case "thread":
      return finish(codecs.thread.decode(data), (thread) => ({ kind: "thread", thread }));
    case "ticket_comments":
    case "comment_history":
      return finish(codecs.page(codecs.comment).decode(data), (page) => ({
        kind: selector.kind,
        page,
      }));
    case "messages":
      return finish(codecs.messages.decode(data), (page) => ({ kind: "messages", page }));
  }
}
type codecsResult<T> = ReturnType<import("../../../core/protocol/codec").Codec<T>["decode"]>;

export function validate(
  endpoint: Endpoint,
  selector: ThreadsRead,
  request: ReadInvocation,
  response: ReadResponse,
  httpStatus = 200,
): HttpResult<ReadCapture> {
  const result = decoded(selector, response.response.data);
  if (!result.ok) return result;
  try {
    const planning = selector.kind === "ticket_comments" || selector.kind === "comment_history";
    const revision = decimal(
      jsonField(response.response.meta, planning ? "workspace_revision" : "query_revision"),
      "Read capture",
    );
    if (
      !planning &&
      string(jsonField(response.response.meta, "query_scope"), "Read namespace") !== "communication"
    )
      return protocol("Discussion response changed its native namespace.");
    const guard = jsonField(request.params, planning ? "at_revision" : "revision");
    if (guard !== undefined && decimal(guard, "Requested capture") !== revision)
      return protocol("Discussion response changed its captured revision.");
    const value = result.data;
    if (value.kind === "board" && selector.kind === "board" && value.board.id !== selector.boardId)
      return protocol("Board response changed its identity.");
    if (value.kind === "thread" && selector.kind === "thread") {
      if (value.thread.id !== selector.threadId || value.thread.related === undefined)
        return protocol("Thread response omitted or changed its expanded messages.");
      const related = value.thread.related;
      if (
        BigInt(related.messages.items.length) >
        BigInt(decimal(jsonField(request.params, "message_limit"), "Message limit"))
      )
        return protocol("Expanded messages exceeded their requested item limit.");
      if (
        related.messages.offset !==
        decimal(jsonField(request.params, "message_offset"), "Message offset")
      )
        return protocol("Expanded messages changed offset.");
      const serial = jsonField(request.params, "discussion_serial");
      if (
        serial !== undefined &&
        decimal(serial, "Discussion capture") !== related.discussionSerial
      )
        return protocol("Expanded messages changed discussion capture.");
      if (
        new Set(related.messages.items.map((item) => item.id)).size !==
        related.messages.items.length
      )
        return protocol("Expanded messages repeated a comment.");
    }
    if (value.kind === "messages" && selector.kind === "messages") {
      const f = selector.filter,
        page = value.page;
      if (
        BigInt(page.items.length) >
        BigInt(decimal(jsonField(request.params, "limit"), "Notification limit"))
      )
        return protocol("Received-message page exceeded its requested item limit.");
      if (
        page.consumerId !== f.consumerId ||
        page.recipient.kind !== f.recipient.kind ||
        page.recipient.id !== f.recipient.id ||
        page.after !== decimal(jsonField(request.params, "after"), "Requested after") ||
        (f.through !== "" && page.through !== f.through)
      )
        return protocol("Received-message page changed consumer, recipient or interval.");
      const excludeSelf = jsonField(response.response.data, "exclude_self");
      if (excludeSelf?.kind !== "boolean" || excludeSelf.value !== f.excludeSelf)
        return protocol("Received-message page changed the self filter.");
      if (
        f.ticketId !== "" &&
        page.items.some((item) => !item.ticketIds.includes(validId(f.ticketId, "Ticket filter")))
      )
        return protocol("Received-message page changed the ticket filter.");
    }
    if ("page" in value && value.kind !== "messages") {
      if (
        BigInt(value.page.items.length) >
        BigInt(decimal(jsonField(request.params, "limit"), "Page limit"))
      )
        return protocol("Discussion page exceeded its requested item limit.");
      if (value.page.offset !== decimal(jsonField(request.params, "offset"), "Requested offset"))
        return protocol("Discussion page changed offset.");
      const keys = value.page.items.map((item) =>
        "target" in item
          ? `${item.id}:${selector.kind === "comment_history" ? item.revision : ""}`
          : `${item.id}:${selector.kind === "thread_history" ? item.revision : ""}`,
      );
      if (new Set(keys).size !== keys.length)
        return protocol("Discussion page repeated an identity/version.");
      if (value.kind === "boards" && selector.kind === "boards" && selector.scope !== null) {
        const scope = selector.scope;
        if (value.page.items.some((item) => !sameLink(item.scope, scope)))
          return protocol("Board page changed its scope filter.");
      }
      if (value.kind === "threads" && selector.kind === "threads") {
        const filter = selector.filter;
        if (
          value.page.items.some(
            (item) =>
              (filter.boardId !== "" && item.boardId !== filter.boardId) ||
              (filter.actorId !== "" &&
                ![...item.participants, ...item.mentions].includes(
                  validId(filter.actorId, "Participant or mention"),
                )) ||
              (filter.status !== "all" && item.status !== filter.status) ||
              (filter.unresolved && item.status === "resolved"),
          )
        )
          return protocol("Thread page changed a requested selector.");
      }
      if (
        value.kind === "thread_history" &&
        selector.kind === "thread_history" &&
        value.page.items.some((item) => item.id !== selector.threadId)
      )
        return protocol("Thread history changed identity.");
      if (
        (value.kind === "ticket_comments" || value.kind === "comment_history") &&
        (selector.kind === "ticket_comments" || selector.kind === "comment_history")
      ) {
        const target =
          selector.kind === "ticket_comments"
            ? { kind: "ticket" as const, id: selector.ticketId }
            : selector.target;
        if (
          value.page.items.some(
            (item) =>
              !sameLink(item.target, target) ||
              (selector.kind === "comment_history" && item.id !== selector.commentId),
          )
        )
          return protocol("Comment page changed its target or identity.");
      }
    }
    return {
      ok: true,
      httpStatus,
      data: { selector, captured: { endpoint, invocation: request, response, value } },
    };
  } catch (error: unknown) {
    if (error instanceof ThreadsInputError) return protocol(error.message);
    throw error;
  }
}

/** The daemon supplies the only continuation. Validate association and capture,
 * then retain its exact parameters; never regenerate a cursor from UI state. */
export async function continued(
  http: HttpClient,
  previous: ReadCapture,
  page: "next" | "retry",
  signal?: AbortSignal,
): Promise<HttpResult<ReadInvocation>> {
  try {
    const capture = previous.captured,
      old = capture.invocation;
    let metadata = capture.response.pagination;
    if (metadata === null) return protocol("This read has no native continuation.");
    if (previous.selector.kind === "thread") {
      const sections = jsonField(metadata, "sections");
      if (sections?.kind !== "array")
        return protocol("Expanded messages lack native section continuation.");
      const section = sections.items.find((item) => {
        const path = jsonField(item, "path");
        return path?.kind === "string" && path.value === "/data/related/messages";
      });
      metadata = record(section, "Expanded message continuation");
    }
    const saved = record(
      jsonField(metadata, page === "next" ? "next_request" : "retry_request"),
      "Saved continuation",
    );
    if (string(jsonField(saved, "method"), "Continuation method") !== old.method)
      return protocol("Continuation changed its method.");
    const params = record(jsonField(saved, "params"), "Continuation parameters");
    const messages = previous.selector.kind === "messages",
      nested = previous.selector.kind === "thread";
    const planning =
      previous.selector.kind === "ticket_comments" || previous.selector.kind === "comment_history";
    const mutable = new Set(
      messages
        ? ["after", "through", "max_bytes"]
        : nested
          ? ["message_offset", "revision", "discussion_serial", "max_bytes"]
          : ["offset", planning ? "at_revision" : "revision", "max_bytes"],
    );
    const fixed = (object: JsonObject) =>
      d.jsonObject(
        object.fields
          .filter((field) => !mutable.has(field.name))
          .map((field) => [field.name, field.value]),
      );
    const a = await http.processing.encode(fixed(old.params), {
      canonical: true,
      limits: HTTP_LIMITS,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!a.ok)
      return a.failure.kind === "aborted"
        ? { ok: false, failure: { kind: "aborted" } }
        : protocol(a.failure.message);
    const b = await http.processing.encode(fixed(params), {
      canonical: true,
      limits: HTTP_LIMITS,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!b.ok)
      return b.failure.kind === "aborted"
        ? { ok: false, failure: { kind: "aborted" } }
        : protocol(b.failure.message);
    if (!a.value.ok || !b.value.ok || a.value.value !== b.value.value)
      return protocol("Continuation changed its captured selectors.");
    const budget = BigInt(decimal(jsonField(params, "max_bytes"), "Continuation budget"));
    if (budget < 4096n || budget > 1048576n)
      return protocol("Continuation exceeded its native byte budget.");
    const value = capture.value;
    if (messages && value.kind === "messages") {
      const expected = page === "next" ? value.page.nextAfter : value.page.after;
      if (
        decimal(jsonField(params, "after"), "Continued after") !== expected ||
        decimal(jsonField(params, "through"), "Continued through") !== value.page.through
      )
        return protocol("Continuation changed its notification interval.");
    } else {
      const revision = decimal(
        jsonField(
          capture.response.response.meta,
          planning ? "workspace_revision" : "query_revision",
        ),
        "Original capture",
      );
      if (
        decimal(jsonField(params, planning ? "at_revision" : "revision"), "Continued revision") !==
        revision
      )
        return protocol("Continuation changed native revision.");
      const selected =
        value.kind === "thread"
          ? value.thread.related?.messages
          : "page" in value && value.kind !== "messages"
            ? value.page
            : undefined;
      if (selected === undefined) return protocol("Continuation has no associated page.");
      const expected = page === "next" ? selected.nextOffset : selected.offset;
      if (
        expected === null ||
        decimal(jsonField(params, nested ? "message_offset" : "offset"), "Continued offset") !==
          expected
      )
        return protocol("Continuation changed page offset.");
      if (
        value.kind === "thread" &&
        value.thread.related !== undefined &&
        decimal(jsonField(params, "discussion_serial"), "Continued discussion") !==
          value.thread.related.discussionSerial
      )
        return protocol("Continuation changed discussion activity capture.");
    }
    return { ok: true, httpStatus: 200, data: { ...old, params } };
  } catch (error: unknown) {
    if (error instanceof ThreadsInputError) return protocol(error.message);
    throw error;
  }
}
export async function read(
  http: HttpClient,
  endpoint: Endpoint,
  selector: ThreadsRead,
  request: ReadInvocation,
  signal: AbortSignal,
): Promise<HttpResult<ReadCapture>> {
  const result = await createCompanion(http).read(request, signal);
  return result.ok ? validate(endpoint, selector, request, result.data, result.httpStatus) : result;
}

export async function loadGuards(
  http: HttpClient,
  draft: ThreadsDraft,
  signal: AbortSignal,
): Promise<HttpResult<DraftGuards>> {
  const e = draft.endpoint,
    input = draft.input;
  let guards = draft.guards;
  async function get<T>(
    method: string,
    key: string,
    id: string,
    codec: import("../../../core/protocol/codec").Codec<T>,
  ): Promise<HttpResult<Captured<T>>> {
    const request: ReadInvocation = {
      connection_id: e.connectionId,
      generation: e.generation,
      lane: "visible",
      method,
      params: d.jsonObject([
        ["workspace_id", d.jsonString(e.workspaceId)],
        [key, d.jsonString(validId(id, key))],
        ["max_bytes", d.jsonString("1048576")],
        ...(method === "comment.get"
          ? [["include_archived", d.jsonBoolean(true)] as [string, JsonValue]]
          : []),
      ]),
    };
    const result = await createCompanion(http).read(request, signal);
    if (!result.ok) return result;
    const value = codec.decode(result.data.response.data);
    if (!value.ok) return protocol(`Invalid current guard: ${value.issue.expected}.`);
    return {
      ok: true,
      httpStatus: result.httpStatus,
      data: { endpoint: e, invocation: request, response: result.data, value: value.value },
    };
  }
  let threadId: string | undefined, boardId: string | undefined, commentId: string | undefined;
  switch (input.method) {
    case "board.put":
      if (input.existing) boardId = input.fields.id;
      break;
    case "thread.put":
      boardId = input.fields.boardId;
      if (input.existing) threadId = input.fields.id;
      break;
    case "thread.reply":
    case "thread.attach":
    case "thread.pin_message":
      threadId = input.threadId;
      if (input.method === "thread.attach") commentId = input.commentId;
      break;
    case "comment.edit":
    case "comment.tombstone":
      commentId = input.commentId;
      break;
    case "comment.add":
    case "message.send":
      break;
  }
  if (threadId !== undefined) {
    const result = await get<Thread>("thread.get", "thread_id", threadId, codecs.thread);
    if (!result.ok) return result;
    if (result.data.value.id !== threadId)
      return protocol("Current thread guard changed identity.");
    guards = { ...guards, thread: result.data };
    boardId = result.data.value.boardId;
  }
  if (boardId !== undefined) {
    const result = await get<Board>("board.get", "board_id", boardId, codecs.board);
    if (!result.ok) return result;
    if (result.data.value.id !== boardId) return protocol("Current board guard changed identity.");
    guards = { ...guards, board: result.data };
  }
  if (commentId !== undefined) {
    const result = await get<Comment>("comment.get", "comment_id", commentId, codecs.comment);
    if (!result.ok) return result;
    if (result.data.value.id !== commentId)
      return protocol("Current comment guard changed identity.");
    guards = { ...guards, comment: result.data };
  }
  return { ok: true, httpStatus: 200, data: guards };
}
