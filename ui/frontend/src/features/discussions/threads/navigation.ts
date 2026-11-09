import type { FeatureContext, Route } from "../../../app/types";
import * as d from "../../../core/protocol/decoders";
import { ThreadsInputError, validId } from "./model";
import type { DiscussionTarget } from "./types";
function counter(value: string) {
  const result = d.positiveDecimal.decode(d.jsonString(value));
  if (!result.ok) throw new ThreadsInputError("Discussion generation/revision is invalid.");
  return result.value;
}
function decimal(value: string) {
  const result = d.decimal.decode(d.jsonString(value));
  if (!result.ok) throw new ThreadsInputError("Notification interval is invalid.");
  return result.value;
}
export function targetFromRoute(context: FeatureContext): DiscussionTarget | undefined {
  const route = context.route,
    value = route.discussion;
  if (value === undefined) return undefined;
  const endpoint = {
    connectionId: validId(route.connectionId ?? "", "Connection"),
    generation: counter(value.generation),
    workspaceId: validId(route.workspaceId ?? "", "Workspace"),
  };
  switch (value.kind) {
    case "comment":
      return undefined; // Dedicated immutable comment destination is composed by the host.
    case "board":
      return { ...endpoint, kind: "board", boardId: validId(route.entityId ?? "", "Board") };
    case "thread":
      return { ...endpoint, kind: "thread", threadId: validId(route.entityId ?? "", "Thread") };
    case "ticket":
      return {
        ...endpoint,
        kind: "ticket_discussion",
        ticketId: validId(route.entityId ?? "", "Ticket"),
        comment:
          value.comment === null
            ? null
            : {
                id: validId(value.comment.id, "Comment"),
                revision: counter(value.comment.revision),
              },
      };
    case "messages":
      return {
        ...endpoint,
        kind: "direct_messages",
        capture:
          value.capture === null
            ? null
            : {
                consumerId: validId(value.capture.consumerId, "Consumer"),
                recipient: {
                  kind: value.capture.recipient.kind,
                  id: validId(value.capture.recipient.id, "Recipient"),
                },
                after: decimal(value.capture.after),
                through: decimal(value.capture.through),
                ticketId:
                  value.capture.ticketId === null
                    ? null
                    : validId(value.capture.ticketId, "Ticket filter"),
                excludeSelf: value.capture.excludeSelf,
                notificationId:
                  value.capture.notificationId === null
                    ? null
                    : decimal(value.capture.notificationId),
              },
      };
  }
}
export function discussionRoute(context: FeatureContext, target: DiscussionTarget): Route {
  const base = {
    view: "discussions" as const,
    connectionId: target.connectionId,
    workspaceId: target.workspaceId,
    projectId: context.route.projectId,
  };
  switch (target.kind) {
    case "board":
      return {
        ...base,
        entityId: target.boardId,
        discussion: { kind: "board", generation: target.generation },
      };
    case "thread":
      return {
        ...base,
        entityId: target.threadId,
        discussion: { kind: "thread", generation: target.generation },
      };
    case "ticket_discussion":
      return {
        ...base,
        entityId: target.ticketId,
        discussion: { kind: "ticket", generation: target.generation, comment: target.comment },
      };
    case "direct_messages":
      return {
        ...base,
        entityId: null,
        discussion: { kind: "messages", generation: target.generation, capture: target.capture },
      };
  }
}
