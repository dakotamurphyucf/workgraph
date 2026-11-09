import { field } from "./codecs";
import type { CoordinationRow, OverviewTone, ProjectProgress } from "./types";

/** Bounded display ratio; native complete counters remain the labels. */
export function progressPercent(progress: ProjectProgress): number {
  if (progress.total === "0") return 0;
  return Number((BigInt(progress.done) * 10000n) / BigInt(progress.total)) / 100;
}
export function coordinationPresentation(row: CoordinationRow): {
  readonly tone: OverviewTone;
  readonly label: string;
  readonly detail: string;
} {
  const metadata = row.raw.fields.find((f) => f.name === "metadata")?.value;
  switch (row.kind) {
    case "ready_work":
      return {
        tone: "ready",
        label: row.title,
        detail:
          metadata !== undefined && field(metadata, "eligibility_scope") === "run"
            ? "Admitted under the selected run checks."
            : "Graph ready · run admission not checked.",
      };
    case "allocation_blocked":
      return { tone: "blocked", label: row.title, detail: row.description };
    case "unanswered_request":
      return { tone: "question", label: "A question needs a response", detail: row.description };
    case "pending_review":
      return { tone: "claimed", label: "Work is waiting for review", detail: row.description };
    case "dependency_bottleneck":
      return {
        tone: "blocked",
        label: "A prerequisite is holding up work",
        detail: row.description,
      };
    case "active_attempt":
      return {
        tone: "working",
        label: `Recorded work on ${metadata === undefined ? "a ticket" : (field(metadata, "ticket_id") ?? "a ticket")}`,
        detail: row.description,
      };
    case "stale_run":
    case "unobserved_run":
      return { tone: "blocked", label: "Check in on a run", detail: row.description };
    case "stale_ownership":
    case "expired_ownership":
      return { tone: "blocked", label: "Ownership needs attention", detail: row.description };
    case "changed_input":
      return { tone: "blocked", label: "Inputs changed during this work", detail: row.description };
    case "budget_limit":
      return {
        tone: "blocked",
        label: "A reported budget reached its limit",
        detail: row.description,
      };
    case "runner_action":
      return { tone: "question", label: "A run needs an operator action", detail: row.description };
    case "reservation":
      return { tone: "claimed", label: "A reservation is recorded", detail: row.description };
    case "reported_usage":
      return { tone: "done", label: "Usage was reported", detail: row.description };
  }
}
