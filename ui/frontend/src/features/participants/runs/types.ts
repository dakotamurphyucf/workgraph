import type { LiveReadable } from "../../../core/state/live-types";
import type { FeatureContext } from "../../../app/types";
import type { HttpClient } from "../../../core/protocol/http";
import type {
  ConnectionProfile,
  Decimal,
  Digest,
  Identifier,
  JsonObject,
  Preparation,
  ReadInvocation,
  ReadResponse,
} from "../../../core/protocol/types";
import type { OperationController } from "../../../core/state/operations";
import type { ReadState } from "../../../core/state/read-slot";

export type RecordedState = "running" | "waiting" | "completed" | "failed" | "cancelled";
export type ParentStopPolicy = "continue" | "request_cancel" | "request_wait";
export interface ActorRecord {
  readonly actor_id: Identifier;
  readonly name: string;
  readonly kind: "person" | "agent";
  readonly revision: Decimal;
  readonly archived: boolean;
}
/** Retained authorship is a past observation, never an OS process claim. */
export interface ParticipantRecord {
  readonly actor_id: Identifier;
  readonly registration: ActorRecord | null;
  readonly observed: { readonly first_revision: Decimal; readonly last_revision: Decimal } | null;
  readonly sources: readonly ("catalog" | "activity" | "fact" | "comment" | "request" | "run")[];
}
export type Checkpoint =
  | { readonly kind: "resource"; readonly resource_id: Identifier; readonly revision: Decimal }
  | { readonly kind: "handoff"; readonly ticket_id: Identifier; readonly revision: Decimal };
export interface RunRecord {
  readonly run_id: Identifier;
  readonly revision: Decimal;
  readonly actor_id: Identifier;
  readonly parent_run_id: Identifier | null;
  readonly parent_stop_policy: ParentStopPolicy;
  readonly objective: string;
  /** Immutable registration metadata. Editing a run cannot replace capabilities. */
  readonly capabilities: readonly string[];
  readonly process_ref: string | null;
  readonly worktree_ref: string | null;
  readonly status: RecordedState;
  /** Canonical nonnegative int64 milliseconds, distinct from daemon counters. */
  readonly last_observed_unix_ms: string | null;
  readonly evidence: string;
  readonly session_ids: readonly Identifier[];
  readonly session_associations: {
    readonly basis: "explicit_and_history_run";
    readonly history_head: Digest | null;
    readonly explicit_session_ids: readonly Identifier[];
    readonly total: Decimal;
    readonly omitted: Decimal;
    readonly next_request: SessionContinuation | null;
  };
}
export interface AttemptRecord {
  readonly attempt_id: Identifier;
  readonly revision: Decimal;
  readonly run_id: Identifier;
  readonly ticket_id: Identifier;
  readonly token: Decimal;
  readonly state: RecordedState;
  readonly session_ids: readonly Identifier[];
  readonly checkpoints: readonly Checkpoint[];
  readonly evidence: string;
}
export interface RunnerAction {
  readonly parent_run_id: Identifier;
  readonly child_run_id: Identifier;
  readonly policy: ParentStopPolicy;
}
/** Exact association cursor. The head is explicit, including empty history. */
export interface SessionContinuation {
  readonly method: "run.sessions";
  readonly params: {
    readonly workspace_id: Identifier;
    readonly target_run_id: Identifier;
    readonly head: Digest | null;
    readonly expected_run_revision: Decimal;
    readonly after_session_id: Identifier;
    readonly limit: Decimal;
    readonly max_bytes: Decimal;
  };
}
export interface SessionPage {
  readonly run_id: Identifier;
  readonly run_revision: Decimal;
  readonly history_head: Digest | null;
  readonly session_ids: readonly Identifier[];
  readonly total: Decimal;
  readonly remaining: Decimal;
  readonly next_after_session_id: Identifier | null;
  readonly next_request: SessionContinuation | null;
  readonly has_more: boolean;
}
export type ParticipantsSelection =
  | { readonly kind: "none" }
  | { readonly kind: "actor"; readonly actorId: Identifier }
  | { readonly kind: "run"; readonly runId: Identifier }
  | { readonly kind: "attempt"; readonly attemptId: Identifier };
export interface ParticipantsTarget {
  readonly connection: ConnectionProfile;
  readonly workspaceId: Identifier;
  /** Display filter only; attempts retain their actual ticket membership. */
  readonly projectId: Identifier | null;
  readonly selection: ParticipantsSelection;
}
export type ParticipantsPanel =
  | "actors"
  | "catalog"
  | "runs"
  | "attempts"
  | "actor-overview"
  | "coordinator"
  | "actions"
  | "budget"
  | "budget-attention"
  | "heartbeat";
export type ParticipantsReadMethod =
  | "actor.list"
  | "participant.list"
  | "actor.overview"
  | "run.list"
  | "run.get"
  | "attempt.list"
  | "attempt.get"
  | "coordinator.overview"
  | "run.actions"
  | "run.budget_get"
  | "run.budget_attention"
  | "run.heartbeat_get"
  | "run.sessions";
export type PageRows =
  | { readonly kind: "actors"; readonly items: readonly ParticipantRecord[] }
  | { readonly kind: "catalog"; readonly items: readonly ActorRecord[] }
  | { readonly kind: "runs"; readonly items: readonly RunRecord[] }
  | { readonly kind: "attempts"; readonly items: readonly AttemptRecord[] }
  | { readonly kind: "actions"; readonly items: readonly RunnerAction[] }
  | { readonly kind: "overview"; readonly items: readonly JsonObject[] }
  | { readonly kind: "record"; readonly value: JsonObject };
export interface ParticipantsPage {
  readonly target: ParticipantsTarget;
  readonly invocation: ReadInvocation;
  readonly response: ReadResponse;
  readonly rows: PageRows;
  /** Daemon namespaces/cursors retain their exact raw capture, independently of entity guards. */
  readonly revision: Decimal | null;
  readonly historyHead: Digest | null | undefined;
  readonly continuation: ReadInvocation | null;
  readonly retry: ReadInvocation | null;
  readonly completeness: "complete" | "more" | "partial";
  readonly stopReason: string | null;
}
export interface ParticipantsDetail {
  readonly target: ParticipantsTarget;
  readonly response: ReadResponse;
  readonly value:
    | { readonly kind: "run"; readonly run: RunRecord }
    | { readonly kind: "attempt"; readonly attempt: AttemptRecord };
}
export interface ParticipantsCapture {
  /** Copied synchronously before any ownership/guard read. */
  readonly target: ParticipantsTarget;
  readonly writer: { readonly actorId: Identifier; readonly runId: Identifier | null };
}
/** Ordinary authoring uses labeled fields and bounded rows, not a JSON form engine. */
export type ParticipantsInput =
  | {
      readonly method: "actor.put";
      readonly actorId: string;
      readonly name: string;
      readonly actorKind: "person" | "agent";
      readonly archived: boolean;
    }
  | {
      readonly method: "run.register";
      readonly runId: string;
      readonly objective: string;
      readonly capabilities: string;
      readonly parentRunId: string;
      readonly parentStopPolicy: ParentStopPolicy;
      readonly processRef: string;
      readonly worktreeRef: string;
    }
  | {
      readonly method: "run.transition";
      readonly runId: string;
      readonly status: RecordedState;
      readonly evidence: string;
    }
  | { readonly method: "run.observe"; readonly runId: string; readonly observedUnixMs: string }
  | { readonly method: "run.heartbeat"; readonly runId: string }
  | { readonly method: "run.link_session"; readonly runId: string; readonly sessionId: string }
  | {
      readonly method: "attempt.start";
      readonly runId: string;
      readonly ticketId: string;
      readonly attemptId: string;
      readonly sessionIds: string;
    }
  | {
      readonly method: "attempt.checkpoint";
      readonly attemptId: string;
      readonly checkpointKind: "resource" | "handoff";
      readonly targetId: string;
      readonly revision: string;
    }
  | {
      readonly method: "attempt.finish";
      readonly attemptId: string;
      readonly state: "completed" | "failed" | "cancelled";
      readonly evidence: string;
    }
  | {
      readonly method: "run.action_acknowledge";
      readonly childRunId: string;
      readonly evidence: string;
    }
  | {
      readonly method: "run.budget_put";
      readonly runId: string;
      /** Empty is explicit no limit, never omission/preserve. */
      readonly maxAttempts: string;
      readonly maxActiveAttempts: string;
      readonly reportedTokenLimit: string;
      readonly reportedElapsedMsLimit: string;
    };
export interface ParticipantsDraft {
  readonly id: Identifier;
  readonly capture: ParticipantsCapture;
  readonly input: ParticipantsInput;
  readonly phase:
    | { readonly kind: "editing" }
    | { readonly kind: "capturing" }
    | { readonly kind: "registered"; readonly preparation: Preparation };
  readonly issue: string | null;
  readonly unexpected: { readonly error: unknown } | null;
}
export interface ParticipantsState {
  readonly target: ParticipantsTarget | null;
  readonly historicalGeneration: boolean;
  readonly panel: ParticipantsPanel;
  readonly filter: { readonly actorId: string; readonly runId: string; readonly ticketId: string };
  readonly page: ReadState<ParticipantsPage>;
  readonly detail: ReadState<ParticipantsDetail>;
  readonly sessions: ReadState<SessionPage>;
  readonly drafts: readonly ParticipantsDraft[];
  readonly selectedDraftId: Identifier | null;
  readonly issue: string | null;
  readonly unexpected: { readonly error: unknown } | null;
}
export interface ParticipantsController extends LiveReadable {
  readonly get: () => ParticipantsState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Resolve retained generation first; a missing profile never falls back current. */
  readonly select: (
    context: FeatureContext,
    selection?: ParticipantsSelection,
    generation?: Decimal,
  ) => void;
  readonly panel: (panel: ParticipantsPanel) => void;
  readonly filter: (filter: ParticipantsState["filter"]) => void;
  readonly refresh: () => void;
  readonly continuePage: (kind: "next" | "retry") => void;
  readonly nextSessions: () => void;
  readonly open: (context: FeatureContext, method: ParticipantsInput["method"]) => void;
  readonly edit: (id: Identifier, input: ParticipantsInput) => void;
  readonly chooseDraft: (id: Identifier | null) => void;
  readonly discard: (id: Identifier) => void;
  readonly review: (id: Identifier) => Promise<void>;
  /** Abort only owned reads/guard jobs; admitted service writes remain owned by operations. */
  readonly dispose: () => void;
}
export interface ParticipantsOptions {
  readonly http: HttpClient;
  readonly operations: OperationController;
}
/** An association opens one exact captured session; no event number is fabricated. */
export interface ParticipantsSessionTarget {
  readonly connection: ConnectionProfile;
  readonly workspaceId: Identifier;
  readonly sessionId: Identifier;
  readonly head: Digest | null;
}
