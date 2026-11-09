import { jsonField, type JsonValue } from "../../../core/json";
import { ActionInputError } from "../../work/actions/model";
import * as d from "../../../core/protocol/decoders";
import type { Identifier, Preparation } from "../../../core/protocol/types";
import { complete, sameEndpoint } from "../threads/model";
import { scope as scopeCodec } from "../threads/codecs";
import type { Captured, Recipient } from "../threads/types";
import { notificationKinds, unixMs } from "./codecs";
import type {
  CurrentRequest,
  EditableRecipient,
  RequestsDraft,
  RequestFields,
  RequestsInput,
} from "./types";
export class RequestsInputError extends ActionInputError {}
const utf8 = new TextEncoder();
export const MAX_DRAFTS = 24;
export const MAX_DRAFT_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
/** Only bounded, typed editor fields enter this local budget. */
export function inputBytes(input: RequestsInput): number {
  return utf8.encode(JSON.stringify(input)).byteLength;
}
export function id(value: string, label: string): Identifier {
  const result = d.identifier.decode(d.jsonString(value));
  if (!result.ok)
    throw new RequestsInputError(`${label} must be an ASCII identifier of 1–96 characters.`);
  return result.value;
}
export function text(value: string, label: string, maximum = 65536, required = true): string {
  if ((required && value.trim() === "") || utf8.encode(value).byteLength > maximum)
    throw new RequestsInputError(
      `${label} ${required ? "must be nonblank and " : ""}must fit within ${maximum} UTF-8 bytes.`,
    );
  return value;
}
export function integer(value: string, label: string, positive = false) {
  const result = (positive ? d.positiveDecimal : d.decimal).decode(d.jsonString(value));
  if (!result.ok)
    throw new RequestsInputError(
      `${label} must be an exact ${positive ? "positive " : ""}daemon counter.`,
    );
  return result.value;
}
export function timestamp(value: string, label: string): string {
  if (!unixMs.decode(d.jsonString(value)).ok)
    throw new RequestsInputError(
      `${label} must be canonical nonnegative Unix milliseconds within signed int64.`,
    );
  return value;
}
export function sameRecipient(a: EditableRecipient, b: EditableRecipient): boolean {
  return a.kind === b.kind && a.id === b.id;
}
export function recipient(value: EditableRecipient): Recipient {
  return { kind: value.kind, id: id(value.id, "Recipient") };
}
function recipientJson(value: EditableRecipient) {
  const valid = recipient(value);
  return d.jsonObject([
    ["kind", d.jsonString(valid.kind)],
    ["id", d.jsonString(valid.id)],
  ]);
}
function recipients(values: readonly EditableRecipient[], maximum = 1000) {
  if (values.length > maximum)
    throw new RequestsInputError(`At most ${maximum} recipients may be entered.`);
  const seen = new Set<string>();
  return values.map(recipient).filter((value) => {
    const key = `${value.kind}:${value.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function recipientArray(values: readonly EditableRecipient[]) {
  return d.jsonArray(recipients(values).map(recipientJson));
}
function ids(values: readonly string[], label: string, maximum: number) {
  if (values.length > maximum)
    throw new RequestsInputError(`${label} admits at most ${maximum} IDs.`);
  return [...new Set(values.map((value) => id(value, label)))];
}
function idArray(values: readonly string[], label: string, maximum: number) {
  return d.jsonArray(ids(values, label, maximum).map(d.jsonString));
}
function writer(draft: RequestsDraft) {
  return {
    actor: id(draft.context.writer.actorId ?? "", "Original acting author"),
    run:
      draft.context.writer.runId === null
        ? null
        : id(draft.context.writer.runId, "Original acting run"),
  };
}
function requireRecipient(draft: RequestsDraft, value: EditableRecipient) {
  const original = writer(draft),
    expected = value.kind === "actor" ? original.actor : original.run;
  recipient(value);
  if (expected !== value.id)
    throw new RequestsInputError(
      "The original writer must match this explicit actor or run recipient. Changing the current selection does not retarget an existing action.",
    );
}
function guard<T>(
  draft: RequestsDraft,
  capture: Captured<T> | undefined,
  methods: readonly string[],
  label: string,
  requireComplete = true,
): T {
  const workspace =
    capture === undefined ? undefined : jsonField(capture.invocation.params, "workspace_id");
  if (
    capture === undefined ||
    !sameEndpoint(draft.endpoint, capture.endpoint) ||
    capture.invocation.connection_id !== draft.endpoint.connectionId ||
    capture.invocation.generation !== draft.endpoint.generation ||
    !methods.includes(capture.invocation.method) ||
    workspace?.kind !== "string" ||
    workspace.value !== draft.endpoint.workspaceId
  )
    throw new RequestsInputError(
      `Load the current ${label} at this action's original endpoint before reviewing.`,
    );
  if (requireComplete && !complete(capture))
    throw new RequestsInputError(
      `The loaded ${label} is partial. Load a complete current record before reviewing.`,
    );
  return capture.value;
}
export function requestGuard(draft: RequestsDraft, requestId: string): CurrentRequest {
  const result = guard(draft, draft.guards.request, ["request.get"], "request");
  const requested =
    draft.guards.request && jsonField(draft.guards.request.invocation.params, "request_id");
  if (
    result.id !== id(requestId, "Request") ||
    requested?.kind !== "string" ||
    requested.value !== result.id
  )
    throw new RequestsInputError("The current request guard belongs to another request.");
  if (result.status.kind !== "open")
    throw new RequestsInputError(
      "This request is terminal. Its history remains readable; create a new action only from an explicit current state.",
    );
  return result;
}
function threadGuard(draft: RequestsDraft, threadId: string) {
  const result = guard(draft, draft.guards.thread, ["thread.get"], "thread");
  const requested =
    draft.guards.thread && jsonField(draft.guards.thread.invocation.params, "thread_id");
  if (
    result.id !== id(threadId, "Thread") ||
    requested?.kind !== "string" ||
    requested.value !== result.id
  )
    throw new RequestsInputError("The thread guard belongs to another thread.");
  return result;
}
function fields(value: RequestFields, add: (name: string, value: JsonValue) => void) {
  add("request_id", d.jsonString(id(value.id, "Request")));
  add("kind", d.jsonString(value.kind));
  add("resolver_id", d.jsonString(id(value.resolverId, "Designated resolver")));
  add("recipients", recipientArray(value.recipients));
  const priority = integer(value.priority, "Priority");
  if (BigInt(priority) > 4n) throw new RequestsInputError("Priority must be 0–4.");
  add("priority", d.jsonString(priority));
  if (value.deadlineUnixMs !== "")
    add("deadline_unix_ms", d.jsonString(timestamp(value.deadlineUnixMs, "Deadline")));
  add("related_request_ids", idArray(value.relatedIds, "Related request", 32));
  add("supersedes_request_ids", idArray(value.supersedesIds, "Superseded request", 32));
}
/** Known bounded form fields only. No raw daemon JSON or large response object is
 * synchronously encoded here. Shared operations own materialization and retry. */
export function preparation(draft: RequestsDraft): Preparation {
  const original = writer(draft),
    entries: [string, JsonValue][] = [
      ["workspace_id", d.jsonString(draft.endpoint.workspaceId)],
      ["actor_id", d.jsonString(original.actor)],
    ];
  if (original.run !== null) entries.push(["run_id", d.jsonString(original.run)]);
  const add = (name: string, value: JsonValue) => entries.push([name, value]);
  const value = draft.input;
  switch (value.method) {
    case "request.ask": {
      fields(value.fields, add);
      if (value.fields.recipients.length === 0)
        throw new RequestsInputError(
          "Choose at least one direct actor or run recipient for this question.",
        );
      add("body", d.jsonString(text(value.body, "Question")));
      if (value.destination.kind === "thread") {
        const thread = threadGuard(draft, value.destination.threadId);
        add("thread_id", d.jsonString(thread.id));
        add("expected_thread_revision", d.jsonString(thread.revision));
      } else {
        add("title", d.jsonString(text(value.destination.title, "Discussion title", 512)));
        if (value.destination.boardId !== "")
          add("board_id", d.jsonString(id(value.destination.boardId, "Board")));
        if (value.destination.ticketId !== "")
          add("ticket_id", d.jsonString(id(value.destination.ticketId, "Linked ticket")));
      }
      break;
    }
    case "request.create": {
      fields(value.fields, add);
      const thread = threadGuard(draft, value.threadId),
        comment = guard(draft, draft.guards.comment, ["comment.get"], "attached comment");
      if (
        comment.id !== id(value.commentId, "Question comment") ||
        !thread.commentIds.includes(comment.id)
      )
        throw new RequestsInputError(
          "Choose an actual attached comment from this captured thread.",
        );
      if (value.fields.recipients.length === 0 && value.teams.length === 0)
        throw new RequestsInputError("Choose at least one direct recipient or team.");
      add("thread_id", d.jsonString(thread.id));
      add("comment_id", d.jsonString(comment.id));
      add("teams", idArray(value.teams, "Team", 1000));
      if (value.correlationId !== "")
        add("correlation_id", d.jsonString(text(value.correlationId, "Correlation", 128)));
      if (value.replyToId !== "")
        add("reply_to_request_id", d.jsonString(id(value.replyToId, "Reply-to request")));
      break;
    }
    case "request.acknowledge":
    case "request.accept":
    case "request.reassign":
    case "request.resolve":
    case "request.cancel":
    case "request.metadata": {
      const current = requestGuard(draft, value.requestId);
      add("request_id", d.jsonString(current.id));
      add("expected_revision", d.jsonString(current.revision));
      if (value.method === "request.acknowledge" || value.method === "request.accept") {
        requireRecipient(draft, value.recipient);
        const delivery = current.deliveries.find((item) =>
          sameRecipient(item.recipient, value.recipient),
        );
        if (delivery === undefined)
          throw new RequestsInputError(
            "This actor or run is not among the request's frozen deliveries.",
          );
        if (value.method === "request.acknowledge" && delivery.acknowledged !== null)
          throw new RequestsInputError("Delivery was already acknowledged for this recipient.");
        if (value.method === "request.accept" && current.responsibility.kind !== "unaccepted")
          throw new RequestsInputError(
            "Responsibility is already accepted. Only the designated resolver can reassign it.",
          );
        add("recipient", recipientJson(value.recipient));
      } else if (value.method === "request.reassign" || value.method === "request.resolve") {
        if (original.actor !== current.resolverId)
          throw new RequestsInputError(
            "Only the original action's designated resolver can resolve or reassign this request. Other participants can post context without resolving it.",
          );
        if (value.method === "request.reassign") {
          const nextRecipient = value.recipient;
          if (
            nextRecipient !== null &&
            !current.deliveries.some((item) => sameRecipient(item.recipient, nextRecipient))
          )
            throw new RequestsInputError(
              "Responsibility may only be assigned to a frozen delivery recipient.",
            );
          add(
            "recipient",
            value.recipient === null ? d.jsonNull() : recipientJson(value.recipient),
          );
        } else if (value.body !== "") add("body", d.jsonString(text(value.body, "Answer")));
      } else {
        if (original.actor !== current.created.actorId && original.actor !== current.resolverId)
          throw new RequestsInputError(
            "Only this request's creator or designated resolver may cancel or edit its metadata.",
          );
        if (value.method === "request.metadata") {
          if (value.priority.kind === "value") {
            const priority = integer(value.priority.value, "Priority");
            if (BigInt(priority) > 4n) throw new RequestsInputError("Priority must be 0–4.");
            add("priority", d.jsonString(priority));
          }
          if (value.deadlineUnixMs.kind === "clear") add("deadline_unix_ms", d.jsonNull());
          else if (value.deadlineUnixMs.kind === "value")
            add(
              "deadline_unix_ms",
              d.jsonString(timestamp(value.deadlineUnixMs.value, "Deadline")),
            );
          if (value.relatedIds.kind === "value")
            add("related_request_ids", idArray(value.relatedIds.value, "Related request", 32));
          if (value.supersedesIds.kind === "value")
            add(
              "supersedes_request_ids",
              idArray(value.supersedesIds.value, "Superseded request", 32),
            );
        }
      }
      break;
    }
    case "inbox.ack": {
      requireRecipient(draft, value.recipient);
      const consumer = id(value.consumerId, "Actionable Inbox consumer");
      if (consumer.startsWith("ui-received-"))
        throw new RequestsInputError(
          "Received-message browsing consumers are read-only. Use a separate actionable Inbox consumer.",
        );
      const inbox = guard(
        draft,
        draft.guards.inbox,
        ["inbox.read", "inbox.wait"],
        "Inbox page",
        false,
      );
      if (inbox.consumerId !== consumer || !sameRecipient(inbox.recipient, value.recipient))
        throw new RequestsInputError(
          "These notifications were captured for a different consumer or recipient.",
        );
      if (
        value.notificationIds.length === 0 ||
        value.notificationIds.length > 100 ||
        new Set(value.notificationIds).size !== value.notificationIds.length ||
        value.notificationIds.some((selected) => !inbox.items.some((item) => item.id === selected))
      )
        throw new RequestsInputError(
          "Select 1–100 distinct notifications from the captured Inbox page.",
        );
      add("consumer_id", d.jsonString(consumer));
      add("recipient", recipientJson(value.recipient));
      add("notification_ids", d.jsonArray(value.notificationIds.map(d.jsonString)));
      break;
    }
    case "team.put": {
      const teamId = id(value.teamId, "Team");
      let revision = "0";
      if (value.existing) {
        const team = guard(draft, draft.guards.team, ["team.get"], "team");
        if (team.id !== teamId)
          throw new RequestsInputError("The current team guard belongs to another team.");
        revision = team.revision;
      }
      add("team_id", d.jsonString(teamId));
      add("expected_revision", d.jsonString(revision));
      add("title", d.jsonString(text(value.title, "Team title", 512)));
      add("members", recipientArray(value.members));
      break;
    }
    case "subscription.put": {
      const subscriptionId = id(value.subscriptionId, "Subscription");
      requireRecipient(draft, value.recipient);
      let revision = "0";
      if (value.existing) {
        const subscription = guard(
          draft,
          draft.guards.subscription,
          ["subscription.get"],
          "subscription",
        );
        if (
          subscription.id !== subscriptionId ||
          !sameRecipient(subscription.recipient, value.recipient)
        )
          throw new RequestsInputError(
            "The subscription recipient is immutable; load the matching current subscription.",
          );
        revision = subscription.revision;
      }
      const filter: [string, JsonValue][] = [],
        kinds = [...new Set(value.filter.kinds)];
      if (
        kinds.length > notificationKinds.length ||
        kinds.some((kind) => !notificationKinds.includes(kind))
      )
        throw new RequestsInputError("Choose supported notification kinds, or none for all kinds.");
      if (value.filter.scope !== null) {
        const scope =
          value.filter.scope.kind === "workspace"
            ? d.jsonObject([["kind", d.jsonString("workspace")]])
            : d.jsonObject([
                ["kind", d.jsonString("project")],
                ["id", d.jsonString(id(value.filter.scope.id, "Project scope"))],
              ]);
        if (!scopeCodec.decode(scope).ok)
          throw new RequestsInputError("Invalid subscription scope.");
        filter.push(["scope", scope]);
      }
      if (value.filter.threadId !== "")
        filter.push(["thread_id", d.jsonString(id(value.filter.threadId, "Thread filter"))]);
      filter.push(["kinds", d.jsonArray(kinds.map(d.jsonString))]);
      add("subscription_id", d.jsonString(subscriptionId));
      add("expected_revision", d.jsonString(revision));
      add("recipient", recipientJson(value.recipient));
      add("filter", d.jsonObject(filter));
      add("active", d.jsonBoolean(value.active));
      break;
    }
  }
  if (new Set(entries.map(([name]) => name)).size !== entries.length)
    throw new Error("Duplicate typed Requests parameter");
  return {
    intention_id: draft.id,
    connection_id: draft.endpoint.connectionId,
    generation: draft.endpoint.generation,
    method: value.method,
    params: d.jsonObject(entries),
    context: {
      workspace_id: draft.endpoint.workspaceId,
      project_id:
        draft.context.route.projectId === null
          ? null
          : id(draft.context.route.projectId, "Selected project"),
      writer: { actor_id: original.actor, run_id: original.run },
    },
  };
}
