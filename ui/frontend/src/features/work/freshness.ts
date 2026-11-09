import { COMMANDS } from "./actions/commands";
import { jsonField } from "../../core/json";
import * as d from "../../core/protocol/decoders";
import type { ManagedOperation } from "../../core/state/operations";
import type { Capture, CommittedWorkWrite, WorkScope, WorkState } from "./read-model.types";

const planningWrites: ReadonlySet<string> = new Set([
  ...COMMANDS.map((command) => command.method),
  "ticket.finish",
  "ticket.complete",
  "transaction.apply",
  "template.instantiate",
]);

/** Only durable planning writes at the identical endpoint and validated actual params workspace
 * can invalidate captures. Navigation context is retained attribution, never a target fallback. */
export function committedWorkWrite(
  scope: WorkScope,
  entries: readonly ManagedOperation[],
): CommittedWorkWrite | null {
  let latest: CommittedWorkWrite | null = null;
  for (const { operation } of entries) {
    if (
      operation?.state.kind !== "committed" ||
      !planningWrites.has(operation.preparation.method) ||
      operation.connection.id !== scope.connection.id ||
      operation.connection.generation !== scope.connection.generation ||
      operation.connection.socket !== scope.connection.socket
    )
      continue;
    const workspace = d.identifier.decode(jsonField(operation.preparation.params, "workspace_id"));
    if (!workspace.ok || workspace.value !== scope.workspaceId) continue;
    const durable = jsonField(operation.state.response.meta, "durable");
    if (durable?.kind !== "boolean" || !durable.value) continue;
    const revision = d.decimal.decode(
      jsonField(operation.state.response.meta, "workspace_revision"),
    );
    if (!revision.ok) continue;
    if (latest === null || BigInt(revision.value) > BigInt(latest.workspaceRevision))
      latest = {
        workspaceRevision: revision.value,
        method: operation.preparation.method,
        operationId: operation.operation_id,
      };
  }
  return latest;
}
export function capturePredatesWrite(
  capture: Capture<unknown> | undefined,
  write: CommittedWorkWrite | null,
): boolean {
  return (
    capture !== undefined &&
    write !== null &&
    BigInt(capture.revision) < BigInt(write.workspaceRevision)
  );
}
/** Previous captures remain visibly stale during failed/loading refresh as well. */
export function workCapturePredatesWrite(state: WorkState): boolean {
  const captures = [
    state.list,
    state.ticket,
    state.context,
    state.readiness,
    ...Object.values(state.sections),
    ...Object.values(state.assessed),
  ];
  return captures.some((slot) =>
    capturePredatesWrite(
      slot.kind === "ready" ? slot.value : slot.kind === "idle" ? undefined : slot.previous,
      state.ownWrite,
    ),
  );
}
