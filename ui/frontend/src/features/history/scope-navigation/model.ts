import { routeHref, validIdentifier } from "../../../app/navigation";
import * as d from "../../../core/protocol/decoders";
import type { PlanningTarget, HistoryPlanningTarget } from "./types";

export function canOpenPlanningScope(
  target: import("../transcript").HistoryNavigationTarget,
): boolean {
  return (
    target.kind === "scope" &&
    target.scope.kind !== "resource" &&
    validIdentifier(target.connectionId) &&
    validIdentifier(target.workspaceId) &&
    (target.scope.kind === "workspace" || validIdentifier(target.scope.id)) &&
    d.positiveDecimal.decode(d.jsonString(target.generation)).ok
  );
}
/** Capture a fresh immutable value; never read live browser selection later. */
export function planningTarget(target: HistoryPlanningTarget): PlanningTarget {
  if (!canOpenPlanningScope(target) || target.scope.kind === "resource")
    throw new Error("Unsupported or invalid recorded planning association.");
  return Object.freeze({
    connectionId: target.connectionId,
    generation: target.generation,
    workspaceId: target.workspaceId,
    kind: target.scope.kind,
    id: target.scope.kind === "workspace" ? target.workspaceId : target.scope.id,
  });
}
export function planningKey(target: PlanningTarget): string {
  return JSON.stringify([
    target.connectionId,
    target.generation,
    target.workspaceId,
    target.kind,
    target.id,
  ]);
}

/** No implicit project ancestry: only a project target selects a project. */
export function planningRoute(target: PlanningTarget): import("../../../app/types").Route {
  if (target.kind === "workspace" && target.id !== target.workspaceId)
    throw new Error("Workspace association must name its captured workspace.");
  const route: import("../../../app/types").Route = {
    view: target.kind === "ticket" ? "work" : "overview",
    connectionId: target.connectionId,
    workspaceId: target.workspaceId,
    projectId: target.kind === "project" ? target.id : null,
    entityId: target.kind === "workspace" ? null : target.id,
    planning: { kind: target.kind, generation: target.generation },
  };
  routeHref(route);
  return route;
}
export function planningTargetFromRoute(
  route: import("../../../app/types").Route,
): PlanningTarget | null {
  if (route.planning === undefined || route.connectionId === null || route.workspaceId === null)
    return null;
  const connection = d.identifier.decode(d.jsonString(route.connectionId)),
    workspace = d.identifier.decode(d.jsonString(route.workspaceId)),
    generation = d.positiveDecimal.decode(d.jsonString(route.planning.generation)),
    id = d.identifier.decode(
      d.jsonString(
        route.planning.kind === "workspace" ? route.workspaceId : (route.entityId ?? ""),
      ),
    );
  if (!connection.ok || !workspace.ok || !generation.ok || !id.ok) return null;
  const target = Object.freeze({
    connectionId: connection.value,
    workspaceId: workspace.value,
    generation: generation.value,
    kind: route.planning.kind,
    id: id.value,
  });
  planningRoute(target);
  return target;
}
