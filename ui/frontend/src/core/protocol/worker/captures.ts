/** Immediate bounded snapshots before any asynchronous admission. Semantic validation stays in worker. */
import { captureJson } from "../../json/capture";
import type { JsonValue } from "../../json";
import type { Operation, Preparation, Problem, ConnectionProfile, DraftContext } from "../types";
export class CaptureError extends Error {}
export function jsonCapture(value: JsonValue): JsonValue {
  const result = captureJson(value);
  if (!result.ok) throw new CaptureError(result.message);
  return result.value;
}
function objectCapture(
  value: Extract<JsonValue, { kind: "object" }>,
): Extract<JsonValue, { kind: "object" }> {
  const result = jsonCapture(value);
  if (result.kind !== "object") throw new CaptureError("Expected captured JSON object.");
  return result;
}
const context = (value: DraftContext): DraftContext =>
  Object.freeze({
    workspace_id: value.workspace_id,
    project_id: value.project_id,
    writer: Object.freeze({ actor_id: value.writer.actor_id, run_id: value.writer.run_id }),
  });
const profile = (value: ConnectionProfile): ConnectionProfile =>
  Object.freeze({
    id: value.id,
    generation: value.generation,
    label: value.label,
    socket: value.socket,
  });
const problem = (value: Problem): Problem =>
  Object.freeze({
    kind: value.kind,
    message: value.message,
    details: value.details === undefined ? undefined : jsonCapture(value.details),
  });
export function capturePreparation(value: Preparation): Preparation {
  return Object.freeze({
    intention_id: value.intention_id,
    connection_id: value.connection_id,
    generation: value.generation,
    context: context(value.context),
    method: value.method,
    params: objectCapture(value.params),
  });
}
export function captureOperation(value: Operation): Operation {
  const current = value.state;
  const state: Operation["state"] =
    current.kind === "committed" || current.kind === "observed"
      ? Object.freeze({
          kind: current.kind,
          response: Object.freeze({
            data: jsonCapture(current.response.data),
            meta: objectCapture(current.response.meta),
          }),
        })
      : current.kind === "rejected" || current.kind === "outcome_unknown"
        ? Object.freeze({ kind: current.kind, problem: problem(current.problem) })
        : Object.freeze({ kind: current.kind });
  return Object.freeze({
    format: value.format,
    operation_id: value.operation_id,
    preparation: Object.freeze({
      intention_id: value.preparation.intention_id,
      context: context(value.preparation.context),
      connection: profile(value.preparation.connection),
      method: value.preparation.method,
      params: objectCapture(value.preparation.params),
    }),
    preparation_input_hash: value.preparation_input_hash,
    connection: profile(value.connection),
    request: objectCapture(value.request),
    journal_path: value.journal_path,
    revision: value.revision,
    state,
    diagnostic: value.diagnostic === null ? null : problem(value.diagnostic),
    receipt_lookup_supported: value.receipt_lookup_supported,
  });
}
