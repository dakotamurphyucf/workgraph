import type { Route } from "../../../app/types";
import { validIdentifier } from "../../../app/navigation";
import * as d from "../../../core/protocol/decoders";
import type { Decimal, Identifier } from "../../../core/protocol/types";
import type { HistoryNavigationTarget } from "../../history/transcript";
import type { ParticipantsSessionTarget } from "./types";

export function participantsRoute(target: {
  readonly connectionId: Identifier;
  readonly generation: Decimal;
  readonly workspaceId: Identifier;
  readonly kind: "actor" | "run" | "attempt";
  readonly id: Identifier;
}): Route {
  return {
    view: "participants",
    connectionId: target.connectionId,
    workspaceId: target.workspaceId,
    projectId: null,
    entityId: target.id,
    participant: { kind: target.kind, generation: target.generation },
  };
}
/** Availability and handler use this same exact association. No writer is selected. */
export function canOpenHistoryRun(target: HistoryNavigationTarget): boolean {
  return (
    target.kind === "run" &&
    validIdentifier(target.connectionId) &&
    validIdentifier(target.workspaceId) &&
    validIdentifier(target.runId) &&
    d.positiveDecimal.decode(d.jsonString(target.generation)).ok
  );
}
export function historyRunRoute(
  target: Extract<HistoryNavigationTarget, { readonly kind: "run" }>,
): Route {
  if (!canOpenHistoryRun(target)) throw new Error("Invalid exact originating-run association.");
  return participantsRoute({ ...target, id: target.runId });
}
/** Session-at-capture links do not fabricate event 1 or replace an empty head. */
export function sessionRoute(target: ParticipantsSessionTarget): Route {
  return {
    view: "history",
    connectionId: target.connection.id,
    workspaceId: target.workspaceId,
    projectId: null,
    entityId: target.sessionId,
    history: { generation: target.connection.generation, head: target.head },
  };
}
