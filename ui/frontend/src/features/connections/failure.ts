import type { HttpFailure } from "../../core/protocol/http";
export function failureText(failure: HttpFailure): string {
  return failure.kind === "remote"
    ? `${failure.problem.kind}: ${failure.problem.message}`
    : failure.kind === "aborted"
      ? "Observation cancelled; no action was retried."
      : failure.message;
}
