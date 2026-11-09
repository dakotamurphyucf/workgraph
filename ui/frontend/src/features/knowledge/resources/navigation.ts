import { routeHref, validIdentifier } from "../../../app/navigation";
import type { Route } from "../../../app/types";
export interface ResourceNavigationTarget {
  readonly connectionId: string;
  readonly generation: string;
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly content: { readonly version: string; readonly expectedDigest: string | null } | null;
}
/** The pin supplies its own endpoint/workspace. A project's list filter is not
 * evidence scope and is deliberately absent from a cross-feature target. */
export function resourceRoute(target: ResourceNavigationTarget): Route {
  const route: Route = {
    view: "resources",
    connectionId: target.connectionId,
    workspaceId: target.workspaceId,
    projectId: null,
    entityId: target.resourceId,
    resource: { generation: target.generation, content: target.content },
  };
  routeHref(route);
  return route;
}
export function canOpenResource(target: ResourceNavigationTarget): boolean {
  const counter = (value: string) =>
    /^[1-9][0-9]{0,18}(?![\s\S])/u.test(value) && BigInt(value) <= 4611686018427387903n;
  return (
    [target.connectionId, target.workspaceId, target.resourceId].every(validIdentifier) &&
    counter(target.generation) &&
    (target.content === null ||
      (counter(target.content.version) &&
        (target.content.expectedDigest === null ||
          /^[a-f0-9]{64}(?![\s\S])/u.test(target.content.expectedDigest))))
  );
}
