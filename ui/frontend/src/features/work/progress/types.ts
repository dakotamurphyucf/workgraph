import type { LiveReadable } from "../../../core/state/live-types";
import type { JsonValue } from "../../../core/json";
import type { HttpClient } from "../../../core/protocol/http";
import type {
  ConnectionProfile,
  Decimal,
  Digest,
  Identifier,
  JsonObject,
  Preparation,
  ReadResponse,
} from "../../../core/protocol/types";
import type { OperationController } from "../../../core/state/operations";
import type { ReadState } from "../../../core/state/read-slot";
import type { Capture, TicketContext, TicketRead, WorkActionContext } from "../read-model.types";

export type CommentKind = "comment" | "progress" | "decision" | "blocker" | "evidence";
export type ProgressCommand =
  | "ticket.progress"
  | "comment.add"
  | "comment.edit"
  | "comment.tombstone"
  | "handoff.set"
  | "attempt.start"
  | "attempt.checkpoint"
  | "attempt.finish"
  | "ticket.finish"
  | "ticket.complete"
  | "ticket.reopen";

/** A fresh editor captures these before any read or asynchronous preparation.
 * The route project is a filter; projectId is the ticket's actual membership.
 * Switching scope/writer never changes an existing editor or pending operation. */
export interface ProgressCapture {
  readonly connection: ConnectionProfile;
  readonly workspaceId: Identifier;
  readonly projectId: Identifier | null;
  readonly writer: { readonly actorId: Identifier; readonly runId: Identifier | null };
  readonly ticket: Capture<TicketRead>;
  readonly detail: Capture<TicketContext> | null;
}

export interface HandoffFields {
  readonly summary: string;
  readonly nextSteps: string;
  readonly evidence: string;
  readonly objective: string;
  readonly completed: string;
  readonly decisions: string;
  readonly blockers: string;
  /** One resolved resource ID per line. These are links, not content-version pins. */
  readonly resourceIds: string;
  /** Explicit last planning sequence actually inspected; never inferred as read coverage. */
  readonly coversThrough: string;
}

export type ProgressInput =
  | {
      readonly method: "ticket.progress" | "comment.add";
      readonly body: string;
      readonly kind: CommentKind;
      readonly replyToId: string;
    }
  | { readonly method: "comment.edit"; readonly commentId: string; readonly body: string }
  | { readonly method: "comment.tombstone"; readonly commentId: string }
  | { readonly method: "handoff.set"; readonly fields: HandoffFields }
  | {
      readonly method: "attempt.start";
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
      readonly method: "ticket.finish";
      readonly evidence: string;
      readonly handoff: HandoffFields | null;
    }
  | { readonly method: "ticket.complete"; readonly evidence: string }
  | { readonly method: "ticket.reopen"; readonly reason: string };

export interface Handoff {
  readonly ticketId: Identifier;
  readonly actorId: Identifier;
  readonly revision: Decimal;
  readonly summary: string;
  readonly nextSteps: string;
  readonly evidence: string;
  readonly objective: string;
  readonly completed: string;
  readonly decisions: string;
  readonly blockers: string;
  readonly resourceIds: readonly Identifier[];
  readonly coversThrough: Decimal;
  readonly timestamp: string;
  readonly raw: JsonObject;
}
export interface Attempt {
  readonly id: Identifier;
  readonly revision: Decimal;
  readonly runId: Identifier;
  readonly ticketId: Identifier;
  readonly token: Decimal;
  readonly state: "running" | "waiting" | "completed" | "failed" | "cancelled";
  readonly sessionIds: readonly Identifier[];
  readonly checkpoints: readonly JsonObject[];
  readonly evidence: string;
  readonly raw: JsonObject;
}
export interface TicketComment {
  readonly id: Identifier;
  readonly revision: Decimal;
  readonly authorId: Identifier;
  readonly actorId: Identifier;
  readonly body: string;
  readonly kind: CommentKind;
  readonly origin: "authored" | "completion";
  readonly replyToId: Identifier | null;
  readonly tombstone: boolean;
  readonly sequence: Decimal;
  readonly timestamp: string;
  readonly raw: JsonObject;
}

/** Auxiliary guards belong to one editor and are never filled from a later
 * actor/route or from a list row's mutable metadata revision. */
export interface ProgressGuards {
  readonly handoff: Handoff | null | undefined;
  readonly attempt: Attempt | undefined;
  readonly comment: TicketComment | undefined;
  readonly reads: readonly ReadResponse[];
}
export interface ProgressDraft {
  readonly id: Identifier;
  readonly capture: ProgressCapture;
  readonly input: ProgressInput;
  readonly guards: ProgressGuards;
  readonly phase:
    | { readonly kind: "editing" }
    | { readonly kind: "loading" }
    | { readonly kind: "capturing" }
    | { readonly kind: "captured"; readonly preparation: Preparation };
  readonly issue: string | null;
  readonly unexpected: { readonly error: unknown } | null;
  readonly editRevision: number;
}

export type ProgressRead = (
  | { readonly kind: "handoff" }
  | { readonly kind: "handoff_history" }
  | { readonly kind: "attempts" }
  | { readonly kind: "comments" }
  | { readonly kind: "comment_history"; readonly commentId: Identifier }
  | { readonly kind: "evidence" }
  | { readonly kind: "review_gate" }
  | { readonly kind: "amendments" }
  | {
      readonly kind: "amendment_acknowledgements";
      readonly amendmentId: Identifier;
      readonly revision: Decimal;
    }
) & {
  /** One item reduces multi-record text clipping; native omission labels still apply. */ readonly pageSize?:
    "1" | "25";
};
export interface ProgressPage {
  readonly selector: ProgressRead;
  readonly method: string;
  readonly params: JsonObject;
  readonly response: ReadResponse;
  /** Whole original returned page retained. Text truncation and partial traversal
   * remain separate labels; a failed/absent page is never an empty collection. */
  readonly value: JsonValue;
}
export interface ProgressState {
  readonly drafts: readonly ProgressDraft[];
  readonly selectedId: Identifier | null;
  readonly target: WorkActionContext | null;
  readonly pages: Readonly<Record<string, ReadState<ProgressPage>>>;
  /** Bounded new comments since opening the ticket, independent of older pages. */
  readonly recentComments: readonly {
    readonly comment: TicketComment;
    readonly partial: boolean;
  }[];
  readonly commentsCatchingUp: boolean;
  readonly commentsIssue: string | null;
  readonly issue: string | null;
  readonly unexpected: { readonly error: unknown } | null;
}
export interface ProgressController extends LiveReadable {
  readonly get: () => ProgressState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Changes only the read target. Existing editors and operations survive. */
  readonly open: (target: WorkActionContext) => void;
  readonly create: (target: WorkActionContext, method: ProgressCommand) => Identifier | null;
  readonly select: (id: Identifier | null) => void;
  /** A known rejection can be copied to an explicitly refreshed capture under
   * the original writer. The original operation remains untouched. */
  readonly copy: (id: Identifier, target: WorkActionContext) => Identifier | null;
  /** Expected field/aggregate budget failures are visible and preserve prior text. */
  readonly edit: (id: Identifier, input: ProgressInput) => void;
  /** Exact guard read for the captured handoff/comment/attempt. It never silently
   * changes text or changes a frozen preparation after conflict. */
  readonly loadGuards: (id: Identifier) => Promise<void>;
  /** Explicitly use the fully loaded comment/handoff text; never an async prefill. */
  readonly fill: (id: Identifier) => void;
  /** repeat resends only the last captured read request, including its failed
   * page offset/revision. It never restarts at a fresh revision implicitly. */
  readonly read: (selector: ProgressRead, page?: "next" | "retry" | "repeat") => Promise<void>;
  /** One deliberate lifecycle review: register and prepare, never execute. */
  readonly review: (id: Identifier) => Promise<void>;
  /** Explicit simple progress/comment post: register, synced preparation, then
   * execute once. Repeated clicks coalesce; no implicit retry of unknown writes. */
  readonly post: (id: Identifier) => Promise<void>;
  readonly close: (id: Identifier) => void;
  /** Stops read owners only; admitted native writes stay service-owned. */
  readonly dispose: () => void;
}
export interface ProgressOptions {
  readonly client: HttpClient;
  readonly operations: OperationController;
}
export interface WorkProgressFeatureProps {
  readonly target: WorkActionContext;
  readonly controller: ProgressController;
  readonly operations: OperationController;
  /** Immutable association only; navigation never changes writer, acknowledges
   * delivery, resolves a request or substitutes the current resource version. */
  readonly openDiscussion?: (target: TicketDiscussionTarget) => void;
  readonly openEvidence?: (target: TicketEvidenceTarget) => void;
}

export interface ProgressNavigationScope {
  readonly connectionId: Identifier;
  readonly generation: Decimal;
  readonly workspaceId: Identifier;
}
export interface TicketDiscussionTarget extends ProgressNavigationScope {
  readonly kind: "ticket_discussion";
  readonly ticketId: Identifier;
  readonly comment: { readonly id: Identifier; readonly revision: Decimal } | null;
}
export interface TicketEvidenceTarget extends ProgressNavigationScope {
  readonly kind: "resource_content";
  readonly resourceId: Identifier;
  readonly version: Decimal;
  readonly digest: Digest;
}
