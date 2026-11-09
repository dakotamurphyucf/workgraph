import { identity } from "../../discussions/threads/model";
import { requestsRoute } from "../../discussions/requests/navigation";
import type { RequestsController } from "../../discussions/requests/types";
import type { WorkActionContext } from "../read-model.types";

/** Open an editable question with the real ticket scope; never send on navigation. */
export function askAboutTicket(controller: RequestsController, target: WorkActionContext) {
  const ticket = target.ticket.value.ticket;
  const destination = {
    kind: "requests" as const,
    connectionId: target.scope.connection.id,
    generation: target.scope.connection.generation,
    workspaceId: target.scope.workspaceId,
  };
  const context = {
    ...target.context,
    route: { ...target.context.route, projectId: ticket.project_id },
  };
  const route = requestsRoute(context, destination);
  controller.open({ ...context, route }, destination);
  controller.create({
    method: "request.ask",
    fields: {
      id: identity("question"),
      kind: "clarification",
      recipients: [],
      resolverId: "",
      priority: "2",
      deadlineUnixMs: "",
      relatedIds: [],
      supersedesIds: [],
    },
    body: "",
    destination: {
      kind: "new",
      title: `${ticket.display_key}: ${ticket.title}`,
      boardId: "",
      ticketId: ticket.ticket_id,
    },
  });
  target.context.navigate(route);
}
