import type { PathTargetInput, ProofPinInput } from "./types";
export const blankPath = (): PathTargetInput => ({ worktreeId: "", kind: "file", path: "" });
export function blankPin(kind: ProofPinInput["kind"] = "resource"): ProofPinInput {
  switch (kind) {
    case "resource":
      return { kind, resourceId: "", version: "", digest: "" };
    case "event":
      return { kind, sessionId: "", sequence: "" };
    case "commit":
      return { kind, repository: "", objectId: "" };
    case "checksum":
      return { kind, source: "", digest: "" };
    case "comment":
    case "amendment":
    case "contract":
    case "decision":
      return { kind, id: "", revision: "" };
  }
}
