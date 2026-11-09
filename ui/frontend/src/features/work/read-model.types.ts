import type { LiveReadable } from "../../core/state/live-types";
import type { ReactNode } from "react";
import type { FeatureContext, WriterSelection } from "../../app/types";
import type { JsonValue } from "../../core/json";
import type { Codec } from "../../core/protocol/codec";
import type { HttpClient } from "../../core/protocol/http";
import type {
  ConnectionProfile,
  Decimal,
  Identifier,
  JsonObject,
  ReadResponse,
} from "../../core/protocol/types";
import type { OperationController } from "../../core/state/operations";
import type { ReadState } from "../../core/state/read-slot";

export const TICKET_STATUSES = ["backlog", "todo", "in_progress", "done", "canceled"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export interface Ticket {
  readonly ticket_id: Identifier;
  readonly display_key: string;
  readonly title: string;
  readonly description: string;
  readonly acceptance_criteria: string;
  readonly revision: Decimal;
  readonly membership_revision: Decimal;
  readonly status: TicketStatus;
  readonly status_id: Identifier | null;
  readonly priority: string;
  readonly archived: boolean;
  readonly assignee_id: Identifier | null;
  readonly project_id: Identifier | null;
  readonly milestone_id: Identifier | null;
  readonly parent_ticket_id: Identifier | null;
  readonly prerequisite_ticket_ids: readonly Identifier[];
  readonly related_ticket_ids: readonly Identifier[];
  readonly label_ids: readonly Identifier[];
  readonly claim: {
    readonly actor_id: Identifier;
    readonly run_id: Identifier | null;
    readonly token: Decimal;
  } | null;
  readonly hold: {
    readonly actor_id: Identifier;
    readonly reason: string;
    readonly timestamp: string;
  } | null;
  /** Complete returned record, including fields not projected by this read-only UI. */
  readonly raw: JsonObject;
}
export interface Page<T> {
  readonly items: readonly T[];
  readonly offset: Decimal;
  readonly next_offset: Decimal | null;
  readonly remaining: Decimal;
}
export interface Assessment {
  readonly scope: "graph" | "run" | "candidate";
  readonly unknown_checks: readonly string[];
}
export interface Completion {
  readonly can_complete: boolean;
  readonly checks: readonly { readonly kind: string; readonly passed: boolean }[];
  readonly blocked_prerequisite_ids: readonly Identifier[];
  readonly blocked_prerequisite_count: Decimal;
  readonly unfinished_child_ids: readonly Identifier[];
  readonly unfinished_child_count: Decimal;
  readonly problem: { readonly kind: string; readonly message: string } | null;
  readonly policy: JsonObject;
  readonly raw: JsonObject;
}
export interface Readiness {
  readonly ready: boolean;
  readonly assessment: Assessment;
  readonly reason_count: Decimal;
  readonly reasons: readonly JsonObject[];
  readonly completion: Completion;
  readonly raw: JsonObject;
}
export interface Continuation {
  readonly method: "ticket.list" | "ticket.context" | "fact.keys";
  readonly params: JsonObject;
}
export interface PageControl {
  readonly path: string;
  readonly responsePath: string;
  readonly complete: boolean;
  readonly stop: string;
  readonly next: Continuation | null;
  readonly retry: Continuation | null;
}
export interface Capture<T> {
  readonly id: string;
  readonly value: T;
  readonly revision: Decimal;
  readonly response: ReadResponse;
  readonly partial: boolean;
  readonly controls: readonly PageControl[];
}
export interface TicketRead {
  readonly ticket: Ticket;
}
export interface TicketContext {
  readonly ticket: Ticket;
  readonly readiness: Readiness;
  readonly completion_readiness: Completion;
  readonly parent: Ticket | null;
  readonly blocker_ticket_ids: readonly Identifier[];
  /** Independent native pages; replacing one section never replaces another or the ticket header. */
  readonly sections: Readonly<Record<string, Page<JsonValue>>>;
  readonly raw: JsonObject;
}
export interface WorkScope {
  readonly connection: ConnectionProfile;
  readonly workspaceId: Identifier;
  readonly projectId: Identifier | null;
}
export interface WorkFilters {
  readonly text: string;
  readonly status: TicketStatus | "";
  readonly priority: string;
  readonly assigneeId: string;
  readonly labelId: string;
  readonly milestoneId: string;
  readonly includeArchived: boolean;
}
export type WorkGrouping = "status" | "assignee" | "priority" | "readiness";
export type InspectorTab = "details" | "relationships" | "admission" | "completion" | "activity";
/** A verified durable write revision, never a query/observed-only revision. */
export interface CommittedWorkWrite {
  readonly workspaceRevision: Decimal;
  readonly method: string;
  readonly operationId: Identifier;
}
export interface WorkState {
  readonly ownWrite: CommittedWorkWrite | null;
  readonly scope: WorkScope | null;
  readonly filters: WorkFilters;
  readonly layout: "list" | "board";
  readonly grouping: WorkGrouping;
  readonly tab: InspectorTab;
  readonly list: ReadState<Capture<Page<Ticket>>>;
  /** A successfully visited earlier list page at the same captured query/revision. */
  readonly canPageBack: boolean;
  readonly selectedId: Identifier | null;
  readonly ticket: ReadState<Capture<TicketRead>>;
  readonly context: ReadState<Capture<TicketContext>>;
  readonly readiness: ReadState<Capture<Readiness>>;
  /** Identity captured when the readiness request began; null means graph-only. */
  readonly readinessTarget: WriterSelection | null;
  readonly sections: Readonly<Record<string, ReadState<Capture<Page<JsonValue>>>>>;
  readonly assessed: Readonly<Record<string, ReadState<Capture<Readiness>>>>;
  readonly assessing: boolean;
}
export interface WorkController extends LiveReadable {
  readonly get: () => WorkState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Cancels obsolete reads on exact endpoint generation/scope change; never cancels operations. */
  readonly open: (scope: WorkScope, entityId: Identifier | null) => Promise<void>;
  readonly setFilters: (filters: WorkFilters) => Promise<void>;
  readonly setPresentation: (patch: {
    readonly layout?: "list" | "board";
    readonly grouping?: WorkGrouping;
    readonly tab?: InspectorTab;
  }) => void;
  readonly refresh: () => Promise<void>;
  /** Previous revisits an exact recorded page request; failures do not consume history.
   * Refresh, filter and endpoint/scope changes reset the trail. */
  readonly page: (kind: "previous" | "next" | "retry") => Promise<void>;
  readonly select: (ticketId: Identifier | null) => Promise<void>;
  readonly assess: (writer: WriterSelection | null) => Promise<void>;
  /** Bounded explicit assessment of loaded rows, graph scope only, at list revision. */
  readonly assessLoaded: () => Promise<void>;
  readonly section: (path: string, kind: "next" | "retry") => Promise<void>;
  readonly dispose: () => void;
}
export interface WorkControllerOptions {
  readonly client: HttpClient;
  /** Existing launch-owned notifications; no automatic read or mutation. */
  readonly operations?: OperationController;
}
export type WorkActionIntent =
  | { readonly kind: "status"; readonly status: TicketStatus }
  | { readonly kind: "readiness"; readonly target: "ready" | "blocked" };
export interface WorkActionContext {
  readonly context: FeatureContext;
  readonly scope: WorkScope;
  readonly ticket: Capture<TicketRead>;
  readonly detail: Capture<TicketContext> | null;
  readonly intent: WorkActionIntent | null;
  readonly clearIntent: () => void;
}
/** Render-time associations only. Draft creators must freeze target and writer before awaiting. */
export interface WorkCollectionContext {
  /** Creation and retained-draft actions placed by the collection toolbar. */
  readonly toolbarActions?: ReactNode;
  readonly context: FeatureContext;
  readonly scope: WorkScope;
  /** Null until the controller matches the exact route endpoint generation and scope. */
  readonly state: WorkState | null;
  readonly list: Capture<Page<Ticket>> | null;
  readonly selected: Capture<TicketRead> | null;
  readonly actions: WorkActionContext | null;
  readonly disabled: boolean;
  readonly controller: WorkController;
  /** Retains the Work or Workflow route and its explicit list filter. */
  readonly select: (ticketId: Identifier | null) => void;
  readonly offer: (ticketId: Identifier, intent: WorkActionIntent) => void;
}
export interface WorkFeatureProps {
  /** Existing creation/draft controls, placed in the compact Work toolbar. */
  readonly toolbarActions?: ReactNode;
  readonly context: FeatureContext;
  /** Required launch-owned controller; preserves query/presentation across route remounts. */
  readonly controller: WorkController;
  readonly renderQuickActions?: (context: WorkActionContext) => ReactNode;
  readonly renderActions?: (context: WorkActionContext) => ReactNode;
  readonly renderAdmissionActions?: (context: WorkActionContext) => ReactNode;
  /** Replaces only the collection pane; the actual ticket inspector stays shared. */
  readonly renderCollection?: (context: WorkCollectionContext) => ReactNode;
  readonly renderProgress?: (context: WorkActionContext) => ReactNode;
}
export interface CaptureCodec<T> {
  readonly value: Codec<T>;
  readonly sectionPaths: readonly string[];
}
