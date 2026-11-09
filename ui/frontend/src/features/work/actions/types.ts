import type { FeatureContext } from "../../../app/types";
import type { ReactNode } from "react";
import type { HttpClient } from "../../../core/protocol/http";
import type {
  ConnectionProfile,
  Decimal,
  Identifier,
  JsonObject,
  Preparation,
  ReadResponse,
} from "../../../core/protocol/types";
import type { OperationController } from "../../../core/state/operations";
import type {
  Capture,
  TicketRead,
  WorkActionContext,
  WorkCollectionContext,
  WorkController,
  WorkScope,
} from "../read-model.types";

/** Fixed current-schema command inventory. Read descriptors and transport actions are separate. */
export type WorkCommand =
  | "ticket.create"
  | "ticket.update"
  | "ticket.metadata"
  | "ticket.move"
  | "ticket.archive"
  | "ticket.hold"
  | "ticket.reopen"
  | "ticket.claim"
  | "ticket.start"
  | "ticket.renew_lease"
  | "ticket.release"
  | "ticket.reassign"
  | "ticket.recover"
  | "ticket.amendment.publish"
  | "ticket.amendment.withdraw"
  | "ticket.amendment.acknowledge"
  | "ticket.paths.put"
  | "ticket.hierarchy.put"
  | "label.put"
  | "status.put"
  | "dependency.add"
  | "dependency.remove"
  | "dependency.waive"
  | "related.add"
  | "related.remove";
export type CommandGroup = "ticket" | "relationships" | "guardrails" | "ownership";
export type FieldPresence = "omit" | "null" | "value";
export interface ScalarInput {
  readonly kind: "scalar";
  readonly presence: FieldPresence;
  /** Decimal counters remain source strings throughout editing and publication. */
  readonly text: string;
}
export interface PathRow {
  readonly worktreeId: string;
  readonly kind: "file" | "subtree";
  readonly path: string;
  readonly mode: "exclusive" | "shared";
}
export interface PinRow {
  readonly kind:
    | "resource"
    | "event"
    | "commit"
    | "checksum"
    | "comment"
    | "amendment"
    | "contract"
    | "decision";
  readonly identity: string;
  readonly revision: string;
  readonly digest: string;
  readonly source: string;
}
export type FormInput =
  | ScalarInput
  | { readonly kind: "paths"; readonly rows: readonly PathRow[] }
  | { readonly kind: "pins"; readonly rows: readonly PinRow[] }
  | {
      readonly kind: "amendments";
      readonly rows: readonly { readonly amendmentId: string; readonly revision: string }[];
    };
export type ScalarType = "text" | "multiline" | "identifier" | "counter" | "boolean" | "enum";
export interface ScalarField {
  readonly kind: "scalar";
  readonly name: string;
  readonly label: string;
  readonly type: ScalarType;
  readonly optional?: boolean;
  readonly nullable?: boolean;
  readonly nonblank?: boolean;
  readonly positive?: boolean;
  readonly maxBytes?: number;
  readonly maximum?: string;
  readonly choices?: readonly string[];
  readonly hint?: string;
  readonly initial?: string;
}
export type FormField =
  | ScalarField
  | {
      readonly kind: "paths" | "pins" | "amendments";
      readonly name: string;
      readonly label: string;
      readonly maxRows: number;
      readonly hint?: string;
    };
export interface CommandDefinition {
  readonly method: WorkCommand;
  readonly title: string;
  readonly group: CommandGroup;
  readonly target: "ticket" | "new" | "workflow";
  readonly hint: string;
  readonly fields: readonly FormField[];
}
export interface ActionCapture {
  readonly connection: ConnectionProfile;
  readonly workspaceId: Identifier;
  /** Actual target project. The route project is only a list filter. */
  readonly projectId: Identifier | null;
  readonly writer: { readonly actorId: Identifier; readonly runId: Identifier | null };
  readonly ticket: Capture<TicketRead> | null;
}
export interface WorkTarget {
  readonly scope: WorkScope;
  readonly ticket: Capture<TicketRead>;
}
export interface AuxiliaryCapture {
  readonly id: string;
  readonly kind: "present";
  readonly method: string;
  readonly params: JsonObject;
  readonly response: ReadResponse;
}
export type DraftPhase =
  | { readonly kind: "editing" }
  | { readonly kind: "loading"; readonly method: string }
  | { readonly kind: "capturing" }
  | { readonly kind: "captured"; readonly preparation: Preparation };
export interface WorkDraft {
  readonly id: Identifier;
  readonly method: WorkCommand;
  readonly capture: ActionCapture;
  readonly inputs: Readonly<Record<string, FormInput>>;
  readonly auxiliary: Readonly<Record<string, AuxiliaryCapture>>;
  readonly phase: DraftPhase;
  readonly issue: string | null;
  readonly unexpected: { readonly error: unknown } | null;
  readonly editRevision: number;
}
export interface WorkActionsState {
  readonly drafts: readonly WorkDraft[];
  readonly selectedId: Identifier | null;
  readonly issue: string | null;
  readonly unexpected: { readonly error: unknown } | null;
}
export interface WorkActionsController {
  readonly get: () => WorkActionsState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Captures endpoint/writer/actual ticket before any await. Never rebases an existing draft. */
  readonly open: (
    context: FeatureContext,
    method: WorkCommand,
    target: WorkTarget | null,
  ) => Identifier | null;
  readonly select: (id: Identifier | null) => void;
  readonly edit: (id: Identifier, field: string, value: FormInput) => void;
  /** Explicit auxiliary reads capture actual policy/related/amendment revisions, not user guesses. */
  readonly load: (id: Identifier, page?: "next" | "retry") => Promise<void>;
  /** Explicitly replace editable fields with validated loaded values; never happens on background completion. */
  readonly fill: (id: Identifier) => void;
  /** Captures one immutable reviewed command; transport execution remains a separate explicit action. */
  readonly prepare: (id: Identifier) => Promise<void>;
  /** One deliberate Review captures and prepares that same intention, never executes it.
   * Close/disposal and concurrent clicks cannot start a second preparation; failures retain
   * the original identity and require explicit inspection/recovery rather than automatic retry. */
  readonly review: (id: Identifier) => Promise<void>;
  /** Closes an editor only; registered intentions and native journals remain owned by operations. */
  readonly close: (id: Identifier) => void;
  readonly dispose: () => void;
}
export interface WorkActionsOptions {
  readonly client: HttpClient;
  readonly operations: OperationController;
}
export interface WorkActionsFeatureProps {
  /** Open a ticket-linked question in the existing communication workflow. */
  readonly askTicket?: (target: WorkActionContext) => void;
  readonly context: FeatureContext;
  readonly readController: WorkController;
  readonly controller: WorkActionsController;
  readonly operations: OperationController;
  readonly renderProgress?: (target: WorkActionContext) => ReactNode;
  readonly renderCollection?: (capture: WorkCollectionContext) => ReactNode;
  readonly renderInspectorSections?: (target: WorkActionContext) => ReactNode;
}
export interface ClaimFence {
  readonly actorId: Identifier;
  readonly runId: Identifier | null;
  readonly token: Decimal;
  readonly leaseRevision: Decimal;
  readonly deadlineUnixMs: string | null;
  readonly lastUnixMs: string;
}
