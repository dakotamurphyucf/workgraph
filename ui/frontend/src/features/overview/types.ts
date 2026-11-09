import type { LiveReadable } from "../../core/state/live-types";
import type { ReactNode } from "react";
import type { FeatureContext } from "../../app/types";
import type { JsonValue } from "../../core/json";
import type { HttpClient } from "../../core/protocol/http";
import type {
  ConnectionProfile,
  Decimal,
  Identifier,
  JsonObject,
  ReadInvocation,
  ReadResponse,
} from "../../core/protocol/types";
import type { ReadState } from "../../core/state/read-slot";
import type { Readiness, TicketStatus } from "../work/read-model.types";

/** Captured endpoint and independently selected current-read filters. No actor
 * selection authenticates a caller or changes a claim. */
export interface OverviewScope {
  readonly connection: ConnectionProfile;
  readonly workspaceId: Identifier;
  readonly projectId: Identifier | null;
  readonly actorId: Identifier | null;
  readonly runId: Identifier | null;
}
export interface Observation<T> {
  readonly value: T;
  readonly invocation: ReadInvocation;
  readonly response: ReadResponse;
  readonly revision: Decimal;
  readonly partial: boolean;
}
export interface ExcerptPage<T> {
  readonly items: readonly T[];
  readonly offset: Decimal;
  readonly remaining: Decimal;
  readonly nextOffset: Decimal | null;
}
export interface TicketSummary {
  readonly ticketId: Identifier;
  readonly title: string;
  readonly status: TicketStatus;
  /** Undefined means the compact summary did not include assignment details. */
  readonly actorId?: Identifier | null;
  readonly revision: Decimal;
  readonly runId?: Identifier | null;
  readonly raw: JsonObject;
}
/** Presentation roles name native meanings; colors never substitute labels. */
export type OverviewTone = "ready" | "working" | "blocked" | "claimed" | "question" | "done";
export interface OverviewMetric {
  readonly kind: OverviewTone;
  readonly label: string;
  readonly value: Decimal;
  readonly denominator: Decimal | null;
  readonly meaning: string;
}
export interface ProjectProgress {
  readonly done: Decimal;
  readonly total: Decimal;
  readonly blocked: Decimal;
}
export type ProjectProgressSummary = Pick<OverviewSummary, "title" | "progress" | "statusCounts">;
export interface ProjectSummary {
  /** Only present when the detail was read at the parent planning revision. */
  readonly overview?: ProjectProgressSummary;
  readonly projectId: Identifier;
  readonly title: string;
  readonly description: string;
  readonly raw: JsonObject;
}
/** Complete native counters stay separate from bounded excerpts. An unavailable
 * summary has no counters; the UI explains the read state instead of inferring0. */
export interface OverviewSummary {
  readonly kind: "workspace" | "project";
  readonly title: string;
  readonly description: string;
  /** All entries derive from explicit full native counters, never visible row lengths. */
  readonly metrics: readonly OverviewMetric[];
  /** Project-only native progress. Workspace project excerpts do not imply progress. */
  readonly progress: ProjectProgress | null;
  readonly statusCounts: readonly { readonly status: TicketStatus; readonly count: Decimal }[];
  readonly projects: ExcerptPage<ProjectSummary> | null;
  readonly ready: ExcerptPage<TicketSummary> | null;
  readonly working: ExcerptPage<TicketSummary>;
  readonly blocked: ExcerptPage<TicketSummary>;
  readonly raw: JsonObject;
}
export type CoordinationKind =
  | "active_attempt"
  | "ready_work"
  | "allocation_blocked"
  | "unanswered_request"
  | "stale_run"
  | "unobserved_run"
  | "stale_ownership"
  | "expired_ownership"
  | "changed_input"
  | "pending_review"
  | "reservation"
  | "reported_usage"
  | "budget_limit"
  | "dependency_bottleneck"
  | "runner_action";
export interface CoordinationRow {
  /** Planning detail matches the parent capture. Requests use explicitly
   * independently current communication detail, while still open. */
  readonly detail?: {
    readonly title: string;
    readonly actorId: Identifier | null;
    readonly byline: string;
    readonly capture: "planning" | "current_request";
  };
  readonly kind: CoordinationKind;
  readonly source: JsonObject;
  readonly title: string;
  readonly description: string;
  readonly readiness: Readiness | null;
  readonly raw: JsonObject;
}
export interface CoordinationPage {
  /** Nonnegative int64 milliseconds; separate from daemon counter range. */
  readonly observedUnixMs: string;
  readonly items: readonly CoordinationRow[];
  readonly cursor: string | null;
  readonly omitted: Decimal;
  readonly needsLargerBudget: boolean;
  readonly requiredBytes: Decimal | null;
  readonly raw: JsonObject;
}
export type AttentionKind = "ticket" | "fact" | "readiness" | "communication";
export interface AttentionFilter {
  readonly kinds: readonly AttentionKind[];
  /** Communication is included only with both an explicit consumer and captured
   * actor/run recipient. This reader never acknowledges notifications. */
  readonly recipient: { readonly kind: "actor" | "run"; readonly id: Identifier } | null;
  readonly consumerId: string;
  readonly excludeSelf: boolean;
}
export interface AttentionRow {
  readonly kind:
    | "ticket_changed"
    | "fact_changed"
    | "readiness_invalidated"
    | "hierarchy_policy_changed"
    | "communication_group";
  readonly revision: Decimal;
  readonly changeIndex: Decimal;
  readonly title: string;
  readonly notificationIds: readonly Decimal[];
  readonly raw: JsonObject;
}
export interface AttentionPage {
  readonly through: Decimal;
  readonly cursor: string;
  readonly items: readonly AttentionRow[];
  readonly hasMore: boolean;
  readonly needsLargerBudget: boolean;
  readonly requiredBytes: Decimal | null;
  readonly readiness: ReadinessPage | null;
  readonly raw: JsonObject;
}
/** Current eligibility is an independent snapshot, not activity history. */
export interface ReadinessPage {
  readonly revision: Decimal;
  /** Nonnegative int64 milliseconds; separate from daemon counter range. */
  readonly observedUnixMs: string;
  readonly items: readonly CoordinationRow[];
  readonly cursor: string | null;
  readonly hasMore: boolean;
  readonly needsLargerBudget: boolean;
  readonly requiredBytes: Decimal | null;
}
export interface DigestQuery {
  readonly ticketId: string;
  readonly after: string;
  readonly limit: string;
  readonly maxBytes: string;
}
export interface DigestItem {
  readonly kind: string;
  readonly summary: string;
  readonly sources: readonly JsonObject[];
  readonly clipped: readonly {
    readonly field: string;
    readonly originalBytes: Decimal;
    readonly omittedBytes: Decimal;
  }[];
  readonly record: JsonObject;
  readonly raw: JsonObject;
}
export interface DigestEntry {
  readonly revision: Decimal;
  readonly changeIndex: Decimal;
  readonly category: string;
  readonly item: DigestItem;
}
export interface ActivityDigest {
  readonly capture: {
    readonly after: Decimal;
    readonly afterChangeIndex: Decimal | null;
    readonly through: Decimal;
    readonly lineage: string;
  };
  readonly entries: readonly DigestEntry[];
  readonly outstandingRequests: readonly DigestItem[];
  readonly counts: readonly {
    readonly section: string;
    readonly total: Decimal;
    readonly returned: Decimal;
    readonly omitted: Decimal;
  }[];
  readonly cursor: string;
  readonly hasMore: boolean;
  readonly raw: JsonObject;
}
export type OverviewIssue = { readonly kind: "input"; readonly message: string };
export interface OverviewState {
  /** One continuous owner-controlled barrier across the complete current-check sequence. */
  readonly refreshing: boolean;
  readonly scope: OverviewScope | null;
  readonly currentProfile: boolean;
  readonly summary: ReadState<Observation<OverviewSummary>>;
  readonly coordination: ReadState<Observation<CoordinationPage>>;
  /** Native unanswered-request selection, independent current capture. Its full
   * count is returned whole rows plus the native omitted tail, never a loaded
   * mixed-kind subset presented as a total. */
  readonly questions: ReadState<Observation<CoordinationPage>>;
  readonly attention: ReadState<Observation<AttentionPage>>;
  readonly readiness: ReadState<Observation<ReadinessPage>>;
  readonly digest: ReadState<Observation<ActivityDigest>>;
  /** New changes since the opened timeline, each retaining its own exact capture. */
  readonly liveActivity: readonly Observation<ActivityDigest>[];
  readonly liveActivityRead: ReadState<Observation<ActivityDigest>>;
  readonly attentionFilter: AttentionFilter;
  readonly digestQuery: DigestQuery;
  readonly waiting: boolean;
  readonly issue: OverviewIssue | null;
}
export interface OverviewController extends LiveReadable {
  readonly get: () => OverviewState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Same endpoint/filter retains captures on route remount. Scope changes cancel
   * obsolete reads and foreground waits; there are no writes to cancel. */
  readonly open: (context: FeatureContext) => Promise<void>;
  /** Capture attention first, then obtain separately labelled CURRENT summaries
   * and readiness. A failed capture never invents a wait cursor. */
  readonly refresh: () => Promise<void>;
  readonly setAttentionFilter: (filter: AttentionFilter) => Promise<void>;
  readonly nextAttention: () => Promise<void>;
  readonly nextReadiness: () => Promise<void>;
  readonly nextCoordination: () => Promise<void>;
  readonly setDigestQuery: (query: DigestQuery) => Promise<void>;
  readonly nextDigest: () => Promise<void>;
  /** One explicit bounded wait, at most25s, only after a consumed captured cursor.
   * No automatic loop/retry/acknowledgement or readiness-history inference. */
  readonly wait: () => Promise<void>;
  readonly stop: () => void;
  readonly pause: () => void;
  readonly dispose: () => void;
}
export interface OverviewControllerOptions {
  readonly http: HttpClient;
}
export type OverviewManagementSection = "project" | "milestone" | "workspace" | "maintenance";
export interface OverviewFeatureProps {
  readonly context: FeatureContext;
  readonly controller: OverviewController;
  /** Preserve the existing explicit lifecycle/administration surface beneath the
   * attention summary, without merging its mutation/retry policy. */
  readonly renderManagement?: (section: OverviewManagementSection) => ReactNode;
}
export interface ActivityFeatureProps {
  readonly context: FeatureContext;
  readonly controller: OverviewController;
}
export interface OverviewLink {
  readonly label: string;
  readonly route: import("../../app/types").Route;
  readonly provenance: JsonValue;
}
