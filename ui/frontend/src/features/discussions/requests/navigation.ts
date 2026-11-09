import { clearHistoryTarget } from "../../../app/navigation";
import type { FeatureContext, Route } from "../../../app/types";
import { notificationKinds } from "./codecs";
import { id, integer, RequestsInputError } from "./model";
import type { NotificationKind, RequestsTarget } from "./types";
function kinds(values: readonly string[]): readonly NotificationKind[] {
  return values.map((value) => {
    const kind = notificationKinds.find((kind) => kind === value);
    if (kind === undefined) throw new RequestsInputError("Unknown captured notification kind.");
    return kind;
  });
}
export function targetFromRoute(context: FeatureContext): RequestsTarget | null {
  const value = context.route.requests;
  if (value === undefined) return null;
  const common = {
    connectionId: id(context.route.connectionId ?? "", "Connection"),
    generation: integer(value.generation, "Endpoint generation", true),
    workspaceId: id(context.route.workspaceId ?? "", "Workspace"),
  };
  switch (value.kind) {
    case "requests":
      return { ...common, kind: "requests" };
    case "request":
      return {
        ...common,
        kind: "request",
        requestId: id(value.requestId, "Request"),
        revision:
          value.revision === null ? null : integer(value.revision, "Request snapshot", true),
      };
    case "routing":
      return {
        ...common,
        kind: "routing",
        entity:
          value.entity === null
            ? null
            : { kind: value.entity.kind, id: id(value.entity.id, "Configuration") },
      };
    case "inbox":
      return {
        ...common,
        kind: "inbox",
        capture:
          value.capture === null
            ? null
            : {
                consumerId: value.capture.consumerId,
                recipient: value.capture.recipient,
                after: value.capture.after,
                through: value.capture.through,
                kinds: kinds(value.capture.kinds),
                ticketId: value.capture.ticketId ?? "",
                excludeSelf: value.capture.excludeSelf,
                notificationId:
                  value.capture.notificationId === null
                    ? null
                    : integer(value.capture.notificationId, "Notification", true),
              },
      };
  }
}
export function requestsRoute(context: FeatureContext, target: RequestsTarget): Route {
  const route = {
    ...clearHistoryTarget(context.route),
    view: "discussions" as const,
    connectionId: target.connectionId,
    workspaceId: target.workspaceId,
    entityId: null,
  };
  switch (target.kind) {
    case "requests":
      return { ...route, requests: { kind: "requests", generation: target.generation } };
    case "request":
      return {
        ...route,
        requests: {
          kind: "request",
          generation: target.generation,
          requestId: target.requestId,
          revision: target.revision,
        },
      };
    case "routing":
      return {
        ...route,
        requests: { kind: "routing", generation: target.generation, entity: target.entity },
      };
    case "inbox":
      return {
        ...route,
        requests: {
          kind: "inbox",
          generation: target.generation,
          capture:
            target.capture === null
              ? null
              : {
                  ...target.capture,
                  ticketId: target.capture.ticketId === "" ? null : target.capture.ticketId,
                },
        },
      };
    case "thread_requests":
      throw new RequestsInputError(
        "Thread Requests use the exact existing thread route and embedded Requests section.",
      );
  }
}
