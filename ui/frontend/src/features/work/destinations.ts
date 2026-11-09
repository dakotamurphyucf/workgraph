import type { FeatureContext, Route } from "../../app/types";
import { routeHref } from "../../app/navigation";
import type { ConnectionProfile, Identifier } from "../../core/protocol/types";

/** Immutable endpoint provenance survives navigation/reload; no current endpoint substitution. */
export function workbenchRoute(
  connection: ConnectionProfile,
  workspaceId: Identifier,
  ticketId: Identifier,
  view: "work" | "workflow" = "work",
): Route {
  const route: Route = {
    view,
    connectionId: connection.id,
    workspaceId,
    projectId: null,
    entityId: ticketId,
    workbench: { generation: connection.generation, socket: connection.socket },
  };
  routeHref(route);
  return route;
}
/** Both independently fetched retained profile and current directory selection must agree. */
export function matchesWorkbench(context: FeatureContext, retained: ConnectionProfile): boolean {
  return (
    context.profileState === "current" &&
    context.route.workbench !== undefined &&
    retained.id === context.route.connectionId &&
    retained.generation === context.route.workbench.generation &&
    retained.id === context.connection.id &&
    retained.generation === context.connection.generation &&
    retained.socket === context.connection.socket &&
    retained.socket === context.route.workbench.socket
  );
}
