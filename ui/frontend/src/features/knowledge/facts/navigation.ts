import type { Route } from "../../../app/types";
import { key } from "./model";
import { ownTarget } from "./client";
import type { FactSelection } from "./types";

/** A directory or exact fact link always retains its endpoint and explicit scope.
 * Only project scope sets the shell's project filter; other scopes never borrow it. */
export function factRoute(selection: FactSelection): Route {
  const target = ownTarget(selection);
  return {
    view: "facts",
    connectionId: target.connection.id,
    workspaceId: target.workspaceId,
    projectId: target.scope.kind === "project" ? target.scope.id : null,
    entityId: null,
    fact:
      selection.key === null
        ? {
            generation: target.connection.generation,
            scope: target.scope,
            key: null,
            factRevision: null,
            atRevision: null,
          }
        : {
            generation: target.connection.generation,
            scope: target.scope,
            key: key(selection.key),
            factRevision: selection.factRevision ?? null,
            atRevision: selection.atRevision ?? null,
          },
  };
}
