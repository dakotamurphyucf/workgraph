import type { Route } from "../../app/types";
import * as d from "../../core/protocol/decoders";
import type { ConnectionProfile } from "../../core/protocol/types";
import type { FactSelection } from "../knowledge/facts";
export function factSelection(route: Route, connection: ConnectionProfile): FactSelection | null {
  const target = route.fact;
  if (
    target === undefined ||
    route.connectionId !== connection.id ||
    target.generation !== connection.generation
  )
    return null;
  const workspace = d.identifier.decode(d.jsonString(route.workspaceId ?? "")),
    scopeId =
      target.scope.kind === "workspace" ? null : d.identifier.decode(d.jsonString(target.scope.id)),
    revision =
      target.factRevision === null
        ? null
        : d.positiveDecimal.decode(d.jsonString(target.factRevision)),
    atRevision =
      target.atRevision === null ? null : d.decimal.decode(d.jsonString(target.atRevision));
  if (
    !workspace.ok ||
    (scopeId !== null && !scopeId.ok) ||
    (revision !== null && !revision.ok) ||
    (atRevision !== null && !atRevision.ok)
  )
    return null;
  const scope: FactSelection["scope"] =
    target.scope.kind === "workspace"
      ? { kind: "workspace" }
      : {
          kind: target.scope.kind,
          id: scopeId !== null && scopeId.ok ? scopeId.value : workspace.value,
        };
  const base = { connection, workspaceId: workspace.value, scope };
  if (target.key === null) {
    if (revision !== null || atRevision !== null) return null;
    return { ...base, key: null };
  }
  return {
    ...base,
    key: target.key,
    ...(revision === null ? {} : { factRevision: revision.value }),
    ...(atRevision === null ? {} : { atRevision: atRevision.value }),
  };
}
