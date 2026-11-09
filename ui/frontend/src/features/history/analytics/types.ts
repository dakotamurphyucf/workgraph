import type { LiveReadable } from "../../../core/state/live-types";
import type { FeatureContext, Route } from "../../../app/types";
import type { JsonValue } from "../../../core/json";
import type { HttpClient } from "../../../core/protocol/http";
import type {
  Decimal,
  Identifier,
  Preparation,
  ReadInvocation,
} from "../../../core/protocol/types";
import type { OperationController } from "../../../core/state/operations";
import type { ReadState } from "../../../core/state/read-slot";
import type { ReportedMetric } from "../formats";
import type {
  Captured,
  CaptureChoice,
  EventRef,
  HistoryController,
  HistoryScope,
  HistoryState,
} from "../transcript/types";

export interface AnalyticsSelection {
  readonly scope: HistoryScope;
  readonly sessionId: string | null;
  /** Omitted selects current; null selects the immutable empty capture. */
  readonly head: string | null | undefined;
}
export interface SearchQuery {
  readonly text: string;
  readonly sessionId: string;
  readonly kinds: readonly string[];
  readonly capture: CaptureChoice;
  readonly limit: string;
  readonly maxBytes: string;
}
export interface SearchHit {
  readonly event_ref: EventRef;
  readonly kind: string;
  readonly role: string;
  readonly byte_offset: Decimal;
  readonly snippet: string;
}
export interface SearchPage {
  readonly items: readonly SearchHit[];
  /** A scanned event, not necessarily a matching hit. Never synthesize from items. */
  readonly next: EventRef | null;
  readonly restart_after_indexing: boolean;
  readonly has_more: boolean;
  readonly coverage: readonly {
    readonly session_id: Identifier;
    readonly committed_through: Decimal;
    readonly indexed_through: Decimal;
  }[];
  readonly index_complete: boolean;
  readonly unindexed_events: Decimal;
  readonly unsearchable_events: Decimal;
  readonly omitted_for_budget: Decimal;
}
export interface MetricSample {
  readonly name: string;
  readonly unit: string;
  readonly value: string;
}
export type UsageScope =
  | { readonly kind: "run"; readonly run_id: Identifier }
  | { readonly kind: "attempt"; readonly attempt_id: Identifier };
export interface UsageRecord {
  readonly usage_id: Identifier;
  readonly scope: UsageScope;
  readonly actor_id: Identifier;
  readonly tokens: string;
  readonly elapsed_ms: string;
  readonly metrics: readonly MetricSample[];
  readonly provenance: string;
  /** Caller text, never treated as server observation or ordering. */
  readonly timestamp: string;
}
export interface UsagePage {
  readonly items: readonly UsageRecord[];
  readonly next_offset: Decimal | null;
  readonly omitted: Decimal;
}
export interface UsageTotals {
  readonly observations: Decimal;
  readonly tokens: string;
  readonly elapsed_ms: string;
  readonly overflow: boolean;
  readonly metric_series: Decimal;
  readonly metric_overflow: boolean;
}
export interface MetricTotal extends MetricSample {
  readonly samples: Decimal;
  readonly overflow: boolean;
}
export type UsageGroup = "workspace" | "project" | "milestone" | "ticket" | "run" | "attempt";
export type MetricsLayout = "rows" | "nested" | "totals_only";
export type GroupKey =
  | { readonly kind: "workspace" }
  | { readonly kind: "project"; readonly project_id: Identifier }
  | { readonly kind: "milestone"; readonly milestone_id: Identifier }
  | { readonly kind: "ticket"; readonly ticket_id: Identifier }
  | { readonly kind: "run"; readonly run_id: Identifier }
  | { readonly kind: "attempt"; readonly attempt_id: Identifier }
  | {
      readonly kind: "unassigned";
      readonly reason:
        "run_scope_has_no_attempt" | "ticket_has_no_project" | "ticket_has_no_milestone";
    };
export type UsageRow =
  | {
      readonly kind: "usage";
      readonly group: GroupKey;
      readonly totals: UsageTotals;
      readonly metrics: readonly MetricTotal[] | undefined;
    }
  | { readonly kind: "metric"; readonly group: GroupKey; readonly metric: MetricTotal };
export interface UsageAggregate {
  readonly basis: "externally_reported";
  readonly membership_basis: "current_capture";
  readonly group_by: UsageGroup;
  readonly metrics_layout: MetricsLayout;
  readonly totals: UsageTotals;
  readonly unassigned_run_usage: UsageTotals;
  readonly unassigned_in_totals: boolean;
  readonly unassigned_scope: "run_and_actor_filters";
  readonly items: readonly UsageRow[];
  readonly cursor: string | null;
  readonly has_more: boolean;
  readonly needs_larger_budget: boolean;
  readonly required_bytes: Decimal | null;
}
export interface UsageQuery {
  readonly group: UsageGroup;
  readonly layout: MetricsLayout;
  readonly projectId: string;
  readonly milestoneId: string;
  readonly ticketId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly actorId: string;
  readonly limit: string;
  readonly maxBytes: string;
}
export interface PlanningCapture<T> {
  readonly data: T;
  readonly revision: Decimal;
  readonly raw: JsonValue;
  readonly meta: JsonValue;
  readonly invocation: ReadInvocation;
}
export interface SearchCapture extends Captured<SearchPage> {
  readonly query: SearchQuery;
  readonly scope: HistoryScope;
}
export interface UsageInput {
  readonly usageId: string;
  readonly scopeKind: "run" | "attempt";
  readonly scopeId: string;
  readonly tokens: string;
  readonly elapsedMs: string;
  readonly metrics: readonly MetricSample[];
  readonly provenance: string;
  readonly timestamp: string;
}
export interface UsageDraft {
  readonly id: Identifier;
  readonly context: FeatureContext;
  readonly input: UsageInput;
  readonly frozen: Preparation | null;
  readonly pending: boolean;
  readonly issue: string | null;
  readonly unexpected: { readonly error: unknown } | null;
}
export interface HistoryAnalyticsState {
  readonly selection: AnalyticsSelection | null;
  readonly searchQuery: SearchQuery;
  readonly search: ReadState<SearchCapture>;
  readonly searchCapture: SearchCapture | null;
  readonly usageQuery: UsageQuery;
  readonly aggregate: ReadState<PlanningCapture<UsageAggregate>>;
  readonly aggregateCapture: PlanningCapture<UsageAggregate> | null;
  readonly records: ReadState<PlanningCapture<UsagePage>>;
  readonly recordsCapture: PlanningCapture<UsagePage> | null;
  readonly drafts: readonly UsageDraft[];
  readonly selectedDraftId: Identifier | null;
  readonly issue: string | null;
  readonly unexpected: { readonly error: unknown } | null;
}
/** Launch-owned. Selection changes cancel reads; original report intentions survive. */
export interface HistoryAnalyticsController extends LiveReadable {
  readonly get: () => HistoryAnalyticsState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly select: (selection: AnalyticsSelection) => void;
  readonly search: (query: SearchQuery, next?: boolean) => void;
  readonly aggregate: (query: UsageQuery, next?: boolean) => void;
  readonly records: (next?: boolean) => void;
  readonly newReport: (context: FeatureContext) => void;
  readonly editReport: (id: Identifier, input: UsageInput) => void;
  readonly selectReport: (id: Identifier | null) => void;
  readonly discardReport: (id: Identifier) => void;
  readonly reviewReport: (id: Identifier) => Promise<void>;
  readonly dispose: () => void;
}
export interface HistoryAnalyticsOptions {
  readonly http: HttpClient;
  readonly operations: OperationController;
}
export interface HistoryAnalyticsFeatureProps {
  readonly context: FeatureContext;
  readonly selection: AnalyticsSelection;
  readonly history: HistoryController;
  readonly controller: HistoryAnalyticsController;
  readonly operations: OperationController;
}
export interface SelectedMetricReport {
  readonly event: EventRef;
  readonly metrics: readonly ReportedMetric[];
}
export interface SessionSummary {
  readonly title: string;
  readonly through: Decimal;
  readonly archived: boolean;
  readonly originatingRunId: Identifier | null;
  readonly loadedEvents: number;
  readonly declaredPayloadBytes: bigint;
  readonly reports: readonly SelectedMetricReport[];
}
export type SummaryProjection = (state: HistoryState) => SessionSummary | null;
export type SearchNavigation = (route: Route, capture: SearchCapture, hit: SearchHit) => Route;
