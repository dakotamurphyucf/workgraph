import type { IconName } from "../../components/Icon";
import type { CoordinationKind } from "./types";

/** Labels accompany every color. Priority orders only the returned capture. */
export const attentionAppearance: Record<
  CoordinationKind,
  { readonly icon: IconName; readonly label: string; readonly priority: number }
> = {
  unanswered_request: { icon: "discussions", label: "Question", priority: 0 },
  runner_action: { icon: "connection", label: "Operator action", priority: 1 },
  pending_review: { icon: "check", label: "Review", priority: 2 },
  changed_input: { icon: "refresh", label: "Inputs changed", priority: 3 },
  expired_ownership: { icon: "history", label: "Expired claim", priority: 4 },
  stale_ownership: { icon: "participants", label: "Check ownership", priority: 5 },
  stale_run: { icon: "history", label: "Check in", priority: 6 },
  unobserved_run: { icon: "participants", label: "Not observed", priority: 7 },
  budget_limit: { icon: "activity", label: "Budget limit", priority: 8 },
  allocation_blocked: { icon: "board", label: "Blocked", priority: 9 },
  dependency_bottleneck: { icon: "workflow", label: "Dependency", priority: 10 },
  ready_work: { icon: "work", label: "Ready", priority: 11 },
  active_attempt: { icon: "activity", label: "In progress", priority: 12 },
  reservation: { icon: "saved", label: "Reserved", priority: 13 },
  reported_usage: { icon: "activity", label: "Reported usage", priority: 14 },
};
