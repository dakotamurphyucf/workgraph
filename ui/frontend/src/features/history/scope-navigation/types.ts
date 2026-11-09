import type {
  ConnectionProfile,
  Decimal,
  Identifier,
  ReadResponse,
} from "../../../core/protocol/types";
import type { HistoryNavigationTarget } from "../transcript";

/** Recorded association only. A read obtains a current planning record at this
 * retained endpoint; this target does not capture historical planning state. */
export interface PlanningTarget {
  readonly connectionId: Identifier;
  readonly generation: Decimal;
  readonly workspaceId: Identifier;
  readonly kind: "workspace" | "project" | "milestone" | "ticket";
  readonly id: Identifier;
}
export type HistoryPlanningTarget = Extract<HistoryNavigationTarget, { readonly kind: "scope" }>;
export interface PlanningRecord {
  readonly kind: PlanningTarget["kind"];
  readonly id: Identifier;
  readonly title: string;
  readonly summary: string;
  readonly description: string;
  readonly instructions: string;
  readonly acceptance: string;
  readonly revision: Decimal;
  readonly archived: boolean;
  readonly status: string | null;
  /** Returned association, never inferred from the source session or breadcrumb. */
  readonly projectId: Identifier | null;
  readonly targetDate: string | null;
}
export interface PlanningCapture {
  readonly target: PlanningTarget;
  readonly connection: ConnectionProfile;
  readonly record: PlanningRecord;
  readonly response: ReadResponse;
}
