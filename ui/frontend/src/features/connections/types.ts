import type { ReactNode } from "react";
import type { ConnectionsRenderContext, FeatureContext } from "../../app/types";
import type { JsonValue } from "../../core/json";
import type {
  ConnectionProfile,
  Decimal,
  Digest,
  Identifier,
  JsonObject,
  Preparation,
  Problem,
  PublicResponse,
} from "../../core/protocol/types";
import type { ConnectionDraftStore } from "./store";
import type { OperationController } from "../../core/state/operations";

export interface ObserverContext {
  readonly workspace_id: Identifier | null;
  readonly project_id: Identifier | null;
  readonly writer: { readonly actor_id: Identifier; readonly run_id: Identifier | null } | null;
}
export interface LaunchPlan {
  readonly intention_id: Identifier;
  readonly connection: ConnectionProfile;
  readonly context: ObserverContext;
  readonly registry: string;
  readonly log: string;
  readonly timeout_seconds: Decimal;
}
export type LaunchState =
  | { readonly status: "prepared_unsent" }
  | { readonly status: "starting" }
  | { readonly status: "outcome_unknown"; readonly problem: Problem }
  | {
      readonly status: "ready";
      readonly observation:
        "existing_endpoint" | "startup_attempt_observed_ready" | "observed_competition";
      readonly ownership: "unknown";
      readonly listing: PublicResponse;
    };
export interface Launch {
  readonly plan: LaunchPlan;
  readonly executable: string;
  readonly input_hash: Digest;
  readonly revision: Decimal;
  readonly state: LaunchState;
  readonly diagnostic: Problem | null;
}
export interface DaemonCapabilities {
  readonly available: boolean;
  readonly executable: string;
  readonly version: string | null;
  readonly problem: Problem | null;
}
export interface ConnectionManagerProps extends ConnectionsRenderContext {
  /** Offline administration remains usable before any daemon connection exists. */
  readonly renderAdministration?: () => ReactNode;
  readonly operations: OperationController;
  readonly store: ConnectionDraftStore;
}
export interface LifecycleFeatureProps {
  /** Omit for the full administration surface; focused dialogs select one directory. */
  readonly section?: "workspace" | "project" | "milestone";
  readonly context: FeatureContext;
  readonly operations: OperationController;
  readonly store: ConnectionDraftStore;
}
export type LifecycleAction =
  | {
      readonly kind: "workspace_create";
      readonly id: string;
      readonly name: string;
      readonly root: string;
    }
  | { readonly kind: "workspace_register"; readonly root: string }
  | {
      readonly kind: "workspace_open" | "workspace_close" | "workspace_unregister";
      readonly id: string;
    }
  | {
      readonly kind: "workspace_edit";
      readonly id: string;
      readonly revision: string;
      readonly name: string;
      readonly summary: string;
      readonly description: string;
      readonly instructions: string;
    }
  | {
      readonly kind: "workspace_archive";
      readonly id: string;
      readonly revision: string;
      readonly archived: boolean;
    }
  | {
      readonly kind: "project_create";
      readonly id: string;
      readonly title: string;
      readonly description: string;
    }
  | {
      readonly kind: "project_edit";
      readonly id: string;
      readonly revision: string;
      readonly title: string;
      readonly summary: string;
      readonly description: string;
      readonly acceptance: string;
      readonly priority: string;
      readonly status: string;
    }
  | {
      readonly kind: "project_archive";
      readonly id: string;
      readonly revision: string;
      readonly archived: boolean;
    }
  | {
      readonly kind: "project_finish";
      readonly id: string;
      readonly revision: string;
      readonly evidence: string;
      readonly summary: string;
      readonly nextSteps: string;
    }
  | {
      readonly kind: "milestone_create";
      readonly id: string;
      readonly project: string;
      readonly title: string;
      readonly description: string;
      readonly date: string;
    }
  | {
      readonly kind: "milestone_edit";
      readonly id: string;
      readonly revision: string;
      readonly title: string;
      readonly description: string;
      readonly status: string;
    }
  | {
      readonly kind: "milestone_archive";
      readonly id: string;
      readonly revision: string;
      readonly archived: boolean;
    }
  | {
      readonly kind: "milestone_schedule";
      readonly id: string;
      readonly revision: string;
      readonly date: string;
    }
  | { readonly kind: "daemon_stop" };
export interface FrozenAction {
  readonly label: string;
  readonly preparation: Preparation;
}
export interface EntityRow {
  readonly id: Identifier;
  readonly title: string;
  readonly revision: Decimal | null;
  readonly archived: boolean | null;
  readonly status: string | null;
  readonly root: string | null;
  readonly open: boolean | null;
  readonly date: string | null;
  /** Complete lossless daemon object retained; consumed projection fields never replace it. */
  readonly raw: JsonObject;
}
export interface EntityPage {
  readonly rows: readonly EntityRow[];
  readonly raw: JsonValue;
  readonly partial: boolean;
  readonly continuation: JsonObject | null;
}
