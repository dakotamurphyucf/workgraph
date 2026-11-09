import type { Route } from "../../../app/types";
import * as d from "../../../core/protocol/decoders";
import type { CommentSelection } from "./types";
export function commentSelection(route: Route): CommentSelection | null {
  const value = route.discussion;
  if (value?.kind !== "comment") return null;
  const connection = d.identifier.decode(d.jsonString(route.connectionId ?? "")),
    workspace = d.identifier.decode(d.jsonString(route.workspaceId ?? "")),
    id = d.identifier.decode(d.jsonString(route.entityId ?? "")),
    generation = d.positiveDecimal.decode(d.jsonString(value.generation)),
    revision = d.positiveDecimal.decode(d.jsonString(value.revision));
  return connection.ok && workspace.ok && id.ok && generation.ok && revision.ok
    ? {
        connectionId: connection.value,
        generation: generation.value,
        workspaceId: workspace.value,
        commentId: id.value,
        revision: revision.value,
      }
    : null;
}
