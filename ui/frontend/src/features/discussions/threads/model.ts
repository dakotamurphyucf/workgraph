import type { FeatureContext } from "../../../app/types";
import { jsonField, type JsonValue } from "../../../core/json";
import * as d from "../../../core/protocol/decoders";
import type { Identifier, JsonObject, Preparation } from "../../../core/protocol/types";
import { ActionInputError, identity, validId as actionId } from "../../work/actions/model";
import type {
  Board,
  Captured,
  Comment,
  DiscussionLink,
  DiscussionScope,
  Endpoint,
  Thread,
  ThreadsDraft,
  ThreadsInput,
} from "./types";
export class ThreadsInputError extends ActionInputError {}
export const MAX_DRAFTS = 24;
export const MAX_DRAFT_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const utf8 = new TextEncoder();
export { identity };
export function validId(value: string, label: string): Identifier {
  try {
    return actionId(value, label);
  } catch (error: unknown) {
    if (error instanceof ActionInputError) throw new ThreadsInputError(error.message);
    throw error;
  }
}
export function text(value: string, label: string, maximum = 65536, nonblank = true): string {
  if (utf8.encode(value).byteLength > maximum || (nonblank && value.trim() === ""))
    throw new ThreadsInputError(
      `${label} requires ${nonblank ? "nonblank text and " : ""}at most ${maximum} UTF-8 bytes.`,
    );
  return value;
}
export function ids(source: string, label: string, maximum: number): readonly Identifier[] {
  const values = source
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length > maximum || new Set(values).size !== values.length)
    throw new ThreadsInputError(`${label} requires at most ${maximum} distinct IDs, one per line.`);
  return values.map((value) => validId(value, label));
}
export function linkJson(value: DiscussionLink): JsonObject {
  return d.jsonObject(
    value.kind === "workspace"
      ? [["kind", d.jsonString(value.kind)]]
      : [
          ["kind", d.jsonString(value.kind)],
          ["id", d.jsonString(validId(value.id, "Linked entity"))],
        ],
  );
}
export function sameLink(left: DiscussionLink, right: DiscussionLink): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "workspace" || (right.kind !== "workspace" && left.id === right.id))
  );
}
export function sameEndpoint(left: Endpoint, right: Endpoint): boolean {
  return (
    left.connectionId === right.connectionId &&
    left.generation === right.generation &&
    left.workspaceId === right.workspaceId
  );
}
export function endpoint(context: FeatureContext): Endpoint {
  return Object.freeze({
    connectionId: context.connection.id,
    generation: context.connection.generation,
    workspaceId: validId(context.route.workspaceId ?? "", "Workspace"),
  });
}
export function capture(context: FeatureContext, target: Endpoint): FeatureContext {
  if (context.profileState !== "current")
    throw new ThreadsInputError(
      "Refresh the connection directory before creating an action. Existing drafts remain unchanged.",
    );
  if (!sameEndpoint(endpoint(context), target))
    throw new ThreadsInputError(
      "This is a retained endpoint view. Select that endpoint explicitly before creating new actions; existing saved actions keep their original endpoint.",
    );
  validId(context.writer.actorId ?? "", "Acting author");
  if (context.writer.runId !== null) validId(context.writer.runId, "Acting run");
  return Object.freeze({
    ...context,
    connection: Object.freeze({ ...context.connection }),
    writer: Object.freeze({ ...context.writer }),
    route: Object.freeze(structuredClone(context.route)),
  });
}
/** Known form fields only; arbitrary JSON source is never synchronously encoded here. */
export function inputBytes(input: ThreadsInput): number {
  switch (input.method) {
    case "board.put":
      return utf8.encode(
        input.fields.id +
          input.fields.title +
          (input.fields.scope.kind === "project" ? input.fields.scope.id : ""),
      ).byteLength;
    case "thread.put":
      return utf8.encode(
        input.fields.id +
          input.fields.boardId +
          input.fields.title +
          input.fields.participants +
          input.fields.mentions +
          input.fields.links.map((value) => value.kind + value.id).join("\n"),
      ).byteLength;
    case "thread.reply":
      return utf8.encode(input.threadId + input.body + input.replyToId).byteLength;
    case "thread.attach":
    case "thread.pin_message":
      return utf8.encode(input.threadId + input.commentId).byteLength;
    case "comment.add":
      return utf8.encode(
        input.body + input.replyToId + (input.target.kind === "workspace" ? "" : input.target.id),
      ).byteLength;
    case "comment.edit":
      return utf8.encode(input.commentId + input.body).byteLength;
    case "comment.tombstone":
      return utf8.encode(input.commentId).byteLength;
    case "message.send":
      return utf8.encode(
        input.messageId +
          input.body +
          input.actorRecipients +
          input.runRecipients +
          input.teamIds +
          input.ticketId +
          input.replyToMessageId +
          input.correlationId,
      ).byteLength;
  }
}
export function complete(read: Captured<unknown>): boolean {
  const budget = jsonField(read.response.response.meta, "budget");
  if (budget?.kind !== "object") return false;
  const truncated = jsonField(budget, "truncated"),
    fields = jsonField(budget, "omitted_fields"),
    items = jsonField(budget, "omitted_items"),
    details = jsonField(budget, "details_complete");
  return (
    budget?.kind === "object" &&
    truncated?.kind === "boolean" &&
    truncated.value === false &&
    fields?.kind === "string" &&
    fields.value === "0" &&
    items?.kind === "string" &&
    items.value === "0" &&
    details?.kind === "boolean" &&
    details.value === true
  );
}
function guard<T>(
  draft: ThreadsDraft,
  value: Captured<T> | undefined,
  label: string,
  method: string,
): T {
  if (
    value === undefined ||
    !sameEndpoint(draft.endpoint, value.endpoint) ||
    value.invocation.connection_id !== draft.endpoint.connectionId ||
    value.invocation.generation !== draft.endpoint.generation ||
    value.invocation.method !== method
  )
    throw new ThreadsInputError(`Load the captured ${label} before reviewing this action.`);
  const workspace = jsonField(value.invocation.params, "workspace_id");
  if (workspace?.kind !== "string" || workspace.value !== draft.endpoint.workspaceId)
    throw new ThreadsInputError(`The loaded ${label} belongs to another workspace.`);
  return value.value;
}
export function boardGuard(draft: ThreadsDraft, id: string): Board {
  const board = guard(draft, draft.guards.board, "board", "board.get");
  if (board.id !== validId(id, "Board"))
    throw new ThreadsInputError("The loaded board belongs to another target.");
  return board;
}
export function threadGuard(draft: ThreadsDraft, id: string): Thread {
  const thread = guard(draft, draft.guards.thread, "thread", "thread.get");
  if (thread.id !== validId(id, "Thread"))
    throw new ThreadsInputError("The loaded thread belongs to another target.");
  return thread;
}
export function commentGuard(draft: ThreadsDraft, id: string): Comment {
  const comment = guard(draft, draft.guards.comment, "comment", "comment.get");
  if (comment.id !== validId(id, "Comment"))
    throw new ThreadsInputError("The loaded comment belongs to another target.");
  return comment;
}
export function scopeValue(
  value: { readonly kind: "workspace" } | { readonly kind: "project"; readonly id: string },
): DiscussionScope {
  return value.kind === "workspace"
    ? { kind: "workspace" }
    : { kind: "project", id: validId(value.id, "Project") };
}
/** Full explicit actor/run and native target fields; no hidden defaults or
 * method registry, and no UI acknowledgement or request-resolution operation. */
export function preparation(draft: ThreadsDraft): Preparation {
  const { input, context } = draft,
    actorId = validId(context.writer.actorId ?? "", "Captured author"),
    runId = context.writer.runId === null ? null : validId(context.writer.runId, "Captured run");
  const fields: [string, JsonValue][] = [
    ["workspace_id", d.jsonString(draft.endpoint.workspaceId)],
    ["actor_id", d.jsonString(actorId)],
  ];
  const put = (key: string, value: string) => fields.push([key, d.jsonString(value)]);
  const putIds = (key: string, value: readonly Identifier[]) =>
    fields.push([key, d.jsonArray(value.map(d.jsonString))]);
  if (runId !== null) put("run_id", runId);
  let projectId: Identifier | null = null;
  const boardScope = (board: Board) => {
    projectId = board.scope.kind === "project" ? board.scope.id : null;
  };
  const thread = (id: string) => {
    const value = threadGuard(draft, id),
      board = boardGuard(draft, value.boardId);
    boardScope(board);
    put("thread_id", value.id);
    put("expected_revision", value.revision);
    return value;
  };
  switch (input.method) {
    case "board.put": {
      const value = scopeValue(input.fields.scope),
        id = validId(input.fields.id, "Board");
      if (input.existing) {
        const old = boardGuard(draft, id);
        if (!sameLink(old.scope, value))
          throw new ThreadsInputError(
            "An existing board's scope is immutable. Create a new board to use another scope.",
          );
        put("expected_revision", old.revision);
      } else put("expected_revision", "0");
      put("board_id", id);
      put("title", text(input.fields.title, "Board title", 512));
      fields.push(["scope", linkJson(value)]);
      projectId = value.kind === "project" ? value.id : null;
      break;
    }
    case "thread.put": {
      const value = input.fields,
        board = boardGuard(draft, value.boardId);
      boardScope(board);
      const id = validId(value.id, "Thread");
      if (input.existing) {
        const old = threadGuard(draft, id);
        if (old.boardId !== board.id)
          throw new ThreadsInputError(
            "An existing thread's board is immutable. Create a new thread to use another board.",
          );
        put("expected_revision", old.revision);
      } else put("expected_revision", "0");
      put("thread_id", id);
      put("board_id", board.id);
      put("title", text(value.title, "Thread title", 512));
      putIds("participants", ids(value.participants, "Participants", 1000));
      putIds("mentions", ids(value.mentions, "Mentions", 1000));
      if (value.links.length > 100)
        throw new ThreadsInputError("A thread supports at most100 linked entities.");
      const links = value.links.map((item): DiscussionLink =>
        item.kind === "workspace"
          ? { kind: "workspace" }
          : { kind: item.kind, id: validId(item.id, "Linked entity") },
      );
      const keys = links.map(
        (item) => item.kind + (item.kind === "workspace" ? "" : `:${item.id}`),
      );
      if (new Set(keys).size !== keys.length)
        throw new ThreadsInputError("Thread entity links must be distinct.");
      fields.push(["links", d.jsonArray(links.map(linkJson))]);
      put("state", value.status);
      put("closure_policy", value.closurePolicy);
      fields.push(["pinned", d.jsonBoolean(value.pinned)]);
      break;
    }
    case "thread.reply":
      thread(input.threadId);
      put("body", text(input.body, "Reply"));
      put("kind", input.kind);
      if (input.replyToId !== "") put("reply_to_id", validId(input.replyToId, "Reply parent"));
      break;
    case "thread.attach": {
      const value = thread(input.threadId),
        board = boardGuard(draft, value.boardId),
        comment = commentGuard(draft, input.commentId);
      if (!sameLink(comment.target, board.scope))
        throw new ThreadsInputError(
          "The comment must target this board's exact scope; attaching never moves or rewrites its original target.",
        );
      put("comment_id", comment.id);
      break;
    }
    case "thread.pin_message":
      thread(input.threadId);
      put("comment_id", validId(input.commentId, "Attached comment"));
      fields.push(["pinned", d.jsonBoolean(input.pinned)]);
      break;
    case "comment.add":
      fields.push(["target", linkJson(input.target)]);
      put("body", text(input.body, "Message"));
      put("kind", input.kind);
      if (input.target.kind === "project") projectId = input.target.id;
      if (input.replyToId !== "") put("reply_to_id", validId(input.replyToId, "Reply parent"));
      break;
    case "comment.edit":
    case "comment.tombstone": {
      const comment = commentGuard(draft, input.commentId);
      if (comment.origin !== "authored")
        throw new ThreadsInputError(
          "Completion evidence is immutable. Append a correction reply instead.",
        );
      if (comment.authorId !== actorId)
        throw new ThreadsInputError(
          "Only this comment's original author can edit or tombstone it; selecting an actor does not authenticate anyone.",
        );
      if (comment.tombstone)
        throw new ThreadsInputError(
          "This comment is already tombstoned. Read its retained history or append a new comment.",
        );
      put("comment_id", comment.id);
      put("expected_revision", comment.revision);
      if (comment.target.kind === "project") projectId = comment.target.id;
      if (input.method === "comment.edit") put("body", text(input.body, "Edited message"));
      break;
    }
    case "message.send": {
      const actors = ids(input.actorRecipients, "Actor recipients", 256),
        runs = ids(input.runRecipients, "Run recipients", 256),
        teams = ids(input.teamIds, "Teams", 256);
      if (actors.length + runs.length + teams.length === 0)
        throw new ThreadsInputError("Choose at least one actor, run or team recipient.");
      put("message_id", validId(input.messageId, "Message identity"));
      put("body", text(input.body, "Direct message"));
      fields.push([
        "recipients",
        d.jsonArray([
          ...actors.map((id) =>
            d.jsonObject([
              ["kind", d.jsonString("actor")],
              ["id", d.jsonString(id)],
            ]),
          ),
          ...runs.map((id) =>
            d.jsonObject([
              ["kind", d.jsonString("run")],
              ["id", d.jsonString(id)],
            ]),
          ),
        ]),
      ]);
      putIds("teams", teams);
      if (input.ticketId !== "") put("ticket_id", validId(input.ticketId, "Linked ticket"));
      if (input.replyToMessageId !== "")
        put("reply_to_message_id", validId(input.replyToMessageId, "Reply message"));
      if (input.correlationId !== "")
        put("correlation_id", text(input.correlationId, "Correlation", 512));
      break;
    }
  }
  if (new Set(fields.map(([key]) => key)).size !== fields.length)
    throw new Error("Discussion command contains duplicate parameter fields.");
  return Object.freeze({
    intention_id: draft.id,
    connection_id: draft.endpoint.connectionId,
    generation: draft.endpoint.generation,
    method: input.method,
    context: {
      workspace_id: draft.endpoint.workspaceId,
      project_id: projectId,
      writer: { actor_id: actorId, run_id: runId },
    },
    params: d.jsonObject(fields),
  });
}
