import type { LiveReadable } from "../../../core/state/live-types";
import type { ReactNode } from "react";
import type { FeatureContext } from "../../../app/types";
import type { HttpClient } from "../../../core/protocol/http";
import type {
  ConnectionProfile,
  Decimal,
  Digest,
  Identifier,
  JsonObject,
  Preparation,
  PreparationSnapshot,
  Problem,
  ReadInvocation,
  ReadResponse,
} from "../../../core/protocol/types";
import type { ReadState } from "../../../core/state/read-slot";
import type { OperationController } from "../../../core/state/operations";
import type { ProgressStatus } from "../../../core/state/progress-observer";

/** Logical namespace only. This never resolves aliases or inspects host files. */
export interface PathTarget {
  readonly worktree_id: Identifier;
  readonly kind: "file" | "subtree";
  readonly path: string;
}
export type ReservationTarget =
  | { readonly kind: "named"; readonly reservation_id: Identifier }
  | { readonly kind: "path"; readonly target: PathTarget };
export type Lease = {
  readonly epoch: Decimal;
  readonly revision: Decimal;
  readonly lastUnixMs: string;
} & (
  | { readonly kind: "indefinite" }
  | { readonly kind: "timed"; readonly durationMs: string; readonly deadlineUnixMs: string }
);
export interface ClaimBorrower {
  readonly ticket_id: Identifier;
  readonly actor_id: Identifier;
  readonly run_id: Identifier;
  readonly token: Decimal;
}
export interface Holder {
  readonly actor_id: Identifier;
  readonly run_id: Identifier;
  readonly token: Decimal;
  readonly mode: "shared" | "exclusive";
  readonly lease: Lease;
  readonly origin:
    | { readonly kind: "manual" }
    | { readonly kind: "automatic"; readonly claims: readonly ClaimBorrower[] };
}
export interface Reservation {
  readonly target: ReservationTarget;
  readonly epoch: Decimal;
  readonly holders: readonly Holder[];
}
export interface Pool {
  readonly name: string;
  readonly revision: Decimal;
  readonly limit: Decimal;
}
export interface TicketPolicy {
  readonly ticket_id: Identifier;
  readonly revision: Decimal;
  readonly required_capabilities: readonly string[];
  readonly pools: readonly string[];
  /** An allowlist is positive and nonempty; null is explicitly unrestricted. */
  readonly allowed_actor_ids: readonly Identifier[] | null;
}
export interface PathPolicy {
  readonly ticket_id: Identifier;
  readonly revision: Decimal;
  readonly require_reservations: boolean;
  readonly paths: readonly { readonly target: PathTarget; readonly mode: Holder["mode"] }[];
}
export interface CoordinationScope {
  readonly connection: ConnectionProfile;
  readonly workspaceId: Identifier;
  readonly projectId: Identifier | null;
}
export interface Capture<T> {
  readonly scope: CoordinationScope;
  readonly value: T;
  readonly response: ReadResponse;
  readonly namespace: "runs" | "policy" | "planning";
  readonly revision: Decimal;
}
/** Never replace these guards by rereading a newer owner during preparation. */
export interface HolderFence {
  readonly reservation: Capture<Reservation>;
  readonly holder: Holder;
}
export interface TicketFence {
  readonly scope: CoordinationScope;
  readonly ticketId: Identifier;
  readonly ticketRevision: Decimal;
  readonly projectId: Identifier | null;
  readonly actorId: Identifier;
  readonly runId: Identifier | null;
  readonly token: Decimal;
  readonly lease: Lease;
  readonly response: ReadResponse;
}
/** Exact native pin; structured editors retain the original lossless source. */
export type ProofPin =
  | {
      readonly kind: "resource";
      readonly resource_id: Identifier;
      readonly revision: Decimal;
      readonly digest: Digest;
    }
  | { readonly kind: "event"; readonly session_id: Identifier; readonly sequence: Decimal }
  | { readonly kind: "commit"; readonly repository: string; readonly object_id: string }
  | { readonly kind: "checksum"; readonly source: string; readonly digest: Digest }
  | { readonly kind: "comment"; readonly comment_id: Identifier; readonly revision: Decimal }
  | { readonly kind: "amendment"; readonly amendment_id: Identifier; readonly revision: Decimal }
  | { readonly kind: "contract"; readonly contract_id: Identifier; readonly revision: Decimal }
  | { readonly kind: "decision"; readonly decision_id: Identifier; readonly revision: Decimal };
export interface Condition {
  readonly condition_id: Identifier;
  readonly revision: Decimal;
  readonly ticket_id: Identifier;
  readonly operation_id: Identifier;
  readonly artifact: ProofPin;
  readonly required: boolean;
  readonly label: string;
  readonly creator: Identifier;
  readonly creator_run: Identifier | null;
  readonly recipients: readonly Identifier[];
}
/** Editor values are untrusted strings until the model validates them. */
export interface PathTargetInput {
  readonly worktreeId: string;
  readonly kind: "file" | "subtree";
  readonly path: string;
}
export type ReservationTargetInput =
  | { readonly kind: "named"; readonly reservationId: string }
  | { readonly kind: "path"; readonly target: PathTargetInput };
export type ProofPinInput =
  | {
      readonly kind: "resource";
      readonly resourceId: string;
      readonly version: string;
      readonly digest: string;
    }
  | { readonly kind: "event"; readonly sessionId: string; readonly sequence: string }
  | { readonly kind: "commit"; readonly repository: string; readonly objectId: string }
  | { readonly kind: "checksum"; readonly source: string; readonly digest: string }
  | {
      readonly kind: "comment" | "amendment" | "contract" | "decision";
      readonly id: string;
      readonly revision: string;
    };
export interface AcquisitionSettings {
  readonly mode: Holder["mode"];
  /** Empty is indefinite; entered milliseconds are validated before admission. */
  readonly durationMs: string;
}
/** One atomic native batch; named and path requests cannot be silently split. */
export type AcquisitionInput =
  | {
      readonly kind: "named";
      readonly requests: readonly (AcquisitionSettings & { readonly reservationId: string })[];
    }
  | {
      readonly kind: "paths";
      readonly requests: readonly (AcquisitionSettings & { readonly target: PathTargetInput })[];
    };
export type RecoveryInput = {
  readonly recoveryId: string;
  /** Blank until the operator supplies an actual outside observation. */
  readonly confirmation: "" | "stopped" | "isolated";
  readonly reason: string;
  readonly evidence: readonly ProofPinInput[];
} & (
  | { readonly kind: "reservation"; readonly fence: HolderFence }
  | {
      readonly kind: "ticket";
      readonly fence: TicketFence;
      readonly disposition: "preserve_status" | "requeue";
    }
);
export type CoordinationInput =
  | { readonly kind: "pool"; readonly name: string; readonly limit: string }
  | {
      readonly kind: "policy";
      readonly ticketId: string;
      readonly capabilities: readonly string[];
      readonly pools: readonly string[];
      readonly actors:
        | { readonly kind: "unrestricted" }
        | { readonly kind: "allow"; readonly ids: readonly string[] };
    }
  | {
      readonly kind: "paths";
      readonly ticketId: string;
      readonly requireReservations: boolean;
      readonly paths: readonly {
        readonly target: PathTargetInput;
        readonly mode: Holder["mode"];
      }[];
    }
  | {
      readonly kind: "acquire";
      readonly targetRunId: string;
      readonly acquisition: AcquisitionInput;
    }
  | { readonly kind: "renew" | "release"; readonly fence: HolderFence }
  | {
      readonly kind: "waiter";
      readonly target: ReservationTargetInput;
      readonly targetRunId: string;
      readonly action:
        | { readonly kind: "begin" | "refresh"; readonly durationMs: string; readonly note: string }
        | { readonly kind: "close"; readonly reason: string };
    }
  | {
      readonly kind: "holder-note";
      /** Explicit when expired/cleared notes are hidden by contention reads. */
      readonly expectedRevision: string;
      readonly fence: HolderFence;
      readonly action:
        | {
            readonly kind: "set";
            readonly durationMs: string;
            readonly note: string;
            readonly expectedReleaseUnixMs: string;
          }
        | { readonly kind: "clear" };
    }
  | {
      readonly kind: "condition";
      readonly conditionId: string;
      readonly ticketId: string;
      readonly operationId: string;
      readonly artifact: ProofPinInput;
      readonly required: boolean;
      readonly label: string;
      readonly recipients: readonly string[];
    }
  | {
      readonly kind: "signal";
      readonly declaration: Capture<Condition>;
      readonly signalId: string;
      readonly evidence: readonly ProofPinInput[];
      readonly summary: string;
    }
  | { readonly kind: "recover"; readonly recovery: RecoveryInput };
export interface CoordinationDraft {
  readonly id: Identifier;
  readonly scope: CoordinationScope;
  readonly writer: Preparation["context"]["writer"];
  readonly input: CoordinationInput;
  readonly phase:
    | { readonly kind: "editing" }
    | { readonly kind: "capturing" }
    | {
        readonly kind: "wait_prepared";
        readonly preparation: Preparation;
        readonly jobId: Identifier;
        readonly limits: WaitLimits;
      }
    | { readonly kind: "registered"; readonly preparation: Preparation };
  readonly issue: string | null;
  readonly unexpected: { readonly error: unknown } | null;
}
export type CoordinationTab = "records" | "allocation" | "reservations" | "conditions" | "recovery";
export interface CoordinationPage {
  readonly scope: CoordinationScope;
  readonly invocation: ReadInvocation;
  readonly response: ReadResponse;
  readonly items: readonly JsonObject[];
  readonly revision: Decimal;
  readonly namespace: "runs" | "policy";
  readonly continuation: ReadInvocation | null;
  readonly completeness: "complete" | "more" | "partial";
  readonly warning: string | null;
}
export interface WaitLimits {
  readonly timeoutMs: Decimal;
  readonly maxAttempts: Decimal;
  readonly waitSliceMs: Decimal;
}
/** Independent explicit native helper job, not a second ordinary Operation owner. */
export interface WaitJob {
  readonly id: Identifier;
  readonly inputHash: Digest;
  readonly preparation: PreparationSnapshot;
  readonly limits: WaitLimits;
  readonly revision: Decimal;
  readonly cancelRequested: boolean;
  readonly state:
    | { readonly kind: "prepared_unsent" }
    | {
        readonly kind: "running";
        readonly attempts: Decimal;
        readonly latestJournal: string | null;
      }
    | { readonly kind: "completed"; readonly outcome: JsonObject }
    | { readonly kind: "stopped"; readonly outcome: JsonObject }
    | { readonly kind: "canceled_unsent" }
    | {
        readonly kind: "outcome_unknown";
        readonly problem: Problem;
        readonly exactJournal: string | null;
        readonly exchangeStarted: boolean;
        readonly outcome: JsonObject | null;
      };
  readonly diagnostic: Problem | null;
}
export type ContentionRow =
  | {
      readonly kind: "waiter";
      readonly record: {
        readonly target: ReservationTarget;
        readonly actor_id: Identifier;
        readonly run_id: Identifier;
        readonly revision: Decimal;
        readonly started_unix_ms: string;
        readonly updated_unix_ms: string;
        readonly expires_unix_ms: string;
        readonly note: string;
        readonly state:
          { readonly kind: "waiting" } | { readonly kind: "closed"; readonly reason: string };
      };
      readonly run_status: string;
      readonly phase: "waiting" | "closed" | "expired" | "run_terminal";
      readonly elapsed_ms: string | null;
      readonly clock_regressed: boolean;
      readonly advisory: true;
    }
  | {
      readonly kind: "holder";
      readonly target: ReservationTarget;
      readonly holder: Holder;
      readonly note: {
        readonly target: ReservationTarget;
        readonly actor_id: Identifier;
        readonly run_id: Identifier;
        readonly token: Decimal;
        readonly revision: Decimal;
        readonly updated_unix_ms: string;
        readonly contents: {
          readonly note: string;
          readonly expires_unix_ms: string;
          readonly expected_release_unix_ms: string | null;
        } | null;
      } | null;
      readonly note_clock_regressed: boolean;
      readonly advisory: true;
    };
export interface ContentionPage {
  readonly scope: CoordinationScope;
  readonly target: ReservationTarget;
  readonly invocation: ReadInvocation;
  readonly response: ReadResponse;
  readonly revision: Decimal;
  readonly observedUnixMs: string;
  readonly items: readonly ContentionRow[];
  readonly continuation: ReadInvocation | null;
  readonly incomplete: boolean;
  readonly warning: string | null;
}
/** One explicit companion-local list page; retained jobs are separate observations. */
export interface WaitPage {
  readonly offset: Decimal;
  readonly remaining: Decimal;
  readonly nextOffset: Decimal | null;
}
export interface CoordinationState {
  readonly scope: CoordinationScope | null;
  readonly tab: CoordinationTab;
  readonly page: ReadState<CoordinationPage>;
  readonly contention: ReadState<ContentionPage>;
  readonly drafts: readonly CoordinationDraft[];
  readonly selectedDraftId: Identifier | null;
  readonly waits: readonly WaitJob[];
  readonly waitPage: WaitPage | null;
  readonly waitsLoading: boolean;
  readonly waitObservations: ReadonlyMap<Identifier, ProgressStatus>;
  readonly issue: string | null;
  readonly unexpected: { readonly error: unknown } | null;
}
export interface CoordinationController extends LiveReadable {
  readonly get: () => CoordinationState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly select: (context: FeatureContext) => void;
  readonly tab: (tab: CoordinationTab) => void;
  readonly refresh: () => void;
  readonly refreshWaits: () => void;
  readonly nextWaits: () => void;
  readonly next: () => void;
  readonly inspectContention: (target: ReservationTargetInput) => void;
  readonly nextContention: () => void;
  readonly browse: (method: import("./client").CoordinationList, conditionId?: string) => void;
  readonly openTicketRecovery: (context: FeatureContext, ticketId: string) => Promise<void>;
  readonly open: (context: FeatureContext, input: CoordinationInput) => void;
  readonly edit: (id: Identifier, input: CoordinationInput) => void;
  readonly review: (id: Identifier) => Promise<void>;
  /** Null closes the form without discarding its captured writer or saved action. */
  readonly chooseDraft: (id: Identifier | null) => void;
  readonly discard: (id: Identifier) => void;
  /** Alternate Review for an unregistered acquisition editor, or deduplicating
   * recheck of its retained exact plan. This controller locks a draft to one path;
   * helper IDs and ordinary operation IDs occupy separate service-local namespaces. */
  readonly prepareWait: (id: Identifier, limits: WaitLimits) => Promise<void>;
  readonly actWait: (
    id: Identifier,
    action: "start" | "inspect" | "cancel" | "retry-exact",
  ) => Promise<void>;
  readonly dispose: () => void;
}
export interface CoordinationOptions {
  readonly http: HttpClient;
  readonly operations: OperationController;
}
export interface CoordinationFeatureProps {
  readonly context: FeatureContext;
  readonly controller: CoordinationController;
  readonly operations: OperationController;
}
export interface ParticipantsWorkspaceProps extends CoordinationFeatureProps {
  readonly records: ReactNode;
}
