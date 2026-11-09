import type { Route, WriterSelection } from "../../app/types";
import type { JsonValue } from "../../core/json";
import type { HttpClient } from "../../core/protocol/http";
import type {
  ConnectionProfile,
  Decimal,
  Digest,
  Identifier,
  Preparation,
  Problem,
} from "../../core/protocol/types";
import type { ObserverContext } from "../connections/types";

/** Paths on daemon host for RPC actions, companion host for native helper actions. */
export type AdminAction =
  | {
      readonly kind: "workspace_export";
      readonly workspaceId: string;
      readonly destination: string;
    }
  | { readonly kind: "export_all"; readonly destination: string; readonly allowPartial: boolean }
  | { readonly kind: "export_cancel" | "export_retry"; readonly jobId: string }
  | { readonly kind: "workspace_restore"; readonly directory: string; readonly root: string }
  | { readonly kind: "restore_all"; readonly directory: string; readonly rootsSource: string }
  | {
      readonly kind: "restore_cancel";
      readonly targetActor: string;
      readonly targetMutation: string;
    };
export interface AdminSelection {
  readonly client: HttpClient;
  readonly connection: ConnectionProfile | null;
  readonly current: boolean;
  readonly route: Route;
  readonly writer: WriterSelection;
}
export type LocalAction =
  | { readonly kind: "migrate_0_6_2"; readonly source: string; readonly destination: string }
  | { readonly kind: "cleanup_stage"; readonly stage: string; readonly owner_token: string };
export interface LocalPlan {
  readonly intention_id: Identifier;
  readonly context: ObserverContext;
  readonly action: LocalAction;
}
export interface LocalReport {
  readonly path: string;
  readonly sha256: Digest;
  readonly byte_count: Decimal;
}
export type LocalState =
  | { readonly status: "prepared_unsent" | "running" | "canceled_unsent" }
  | { readonly status: "failed" | "outcome_unknown"; readonly problem: Problem }
  | {
      readonly status: "succeeded";
      readonly summary: JsonValue;
      readonly report: LocalReport | null;
    };
export interface LocalJob {
  readonly plan: LocalPlan;
  readonly execution_action: LocalAction;
  readonly input_hash: Digest;
  readonly revision: Decimal;
  readonly cancel_requested: boolean;
  readonly state: LocalState;
  readonly diagnostic: Problem | null;
}
export type FrozenAdmin =
  | { readonly kind: "daemon"; readonly preparation: Preparation }
  | { readonly kind: "local"; readonly plan: LocalPlan };
export interface ExportCapture {
  readonly workspace_id: Identifier;
  readonly revision: Decimal;
  readonly head: Digest | null;
  readonly history_head: Digest | null;
}
export interface ExportJob {
  readonly job_id: Identifier;
  readonly kind: "workspace" | "all";
  readonly destination: string;
  readonly captures: readonly ExportCapture[];
  readonly omitted: readonly Identifier[];
  readonly status: "running" | "completed" | "failed" | "canceled" | "interrupted";
  readonly attempt: Decimal;
  readonly cancel_requested: boolean;
  readonly error: string | null;
}

export type AdminKind = AdminAction["kind"] | LocalAction["kind"];
export type AdminFields = Readonly<
  Record<
    | "workspaceId"
    | "destination"
    | "jobId"
    | "directory"
    | "root"
    | "rootsSource"
    | "targetActor"
    | "targetMutation"
    | "source"
    | "stage"
    | "owner_token",
    string
  >
>;
export interface AdminDraft {
  readonly id: Identifier;
  readonly selection: AdminSelection;
  readonly kind: AdminKind;
  readonly fields: AdminFields;
  readonly allowPartial: boolean;
  readonly frozen: FrozenAdmin | null;
  readonly local: LocalJob | null;
  readonly pending: boolean;
  readonly issue: string | null;
  readonly unexpected: { readonly error: unknown } | null;
  readonly observation: import("../../core/state/progress-observer").ProgressStatus | undefined;
}
export type AdminTools = Readonly<
  Record<
    "directory" | "journalPath" | "socket" | "verifyDirectory" | "receiptActor" | "receiptMutation",
    string
  >
>;
export interface AdministrationState {
  readonly tools: AdminTools;
  readonly drafts: readonly AdminDraft[];
  readonly activeId: Identifier | null;
  readonly notice: string;
}
export interface AdministrationController {
  readonly get: () => AdministrationState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly editTools: (fields: Partial<AdminTools>) => boolean;
  readonly create: (
    selection: AdminSelection,
    kind: AdminKind,
    fields?: Partial<AdminFields>,
  ) => Identifier | null;
  readonly select: (id: Identifier) => void;
  readonly edit: (id: Identifier, fields: Partial<AdminFields>, allowPartial?: boolean) => boolean;
  /** Captures once, prepares once; it never executes. Failed preparation retains the exact plan. */
  readonly review: (id: Identifier) => Promise<void>;
  readonly localAction: (id: Identifier, action: "start" | "cancel" | "inspect") => Promise<void>;
  readonly adoptLocal: (job: LocalJob) => Promise<boolean>;
  readonly discard: (id: Identifier) => boolean;
  readonly dispose: () => void;
}
export interface AdministrationFeatureProps {
  readonly selection: AdminSelection;
  readonly operations: import("../../core/state/operations").OperationController;
  readonly controller: AdministrationController;
  readonly hostOnly?: boolean;
}
