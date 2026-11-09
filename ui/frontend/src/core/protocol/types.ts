import type { JsonValue } from "../json";

export type JsonObject = Extract<JsonValue, { kind: "object" }>;
/** Validated canonical decimal string; never converted to Number for comparisons. */
export type Decimal = string & { readonly __decimal: unique symbol };
export type Identifier = string & { readonly __identifier: unique symbol };
export type Digest = string & { readonly __digest: unique symbol };
export type ReadLane = "visible" | "history" | "search" | "wait";

export interface Problem {
  readonly kind: string;
  readonly message: string;
  readonly details: JsonValue | undefined;
}
export interface ConnectionProfile {
  readonly id: Identifier;
  readonly generation: Decimal;
  readonly label: string;
  readonly socket: string;
}
export interface PublicResponse {
  readonly data: JsonValue;
  readonly meta: JsonObject;
}
/** Captured draft selection. Actual method targets remain explicit in params. */
export interface DraftContext {
  readonly workspace_id: Identifier | null;
  readonly project_id: Identifier | null;
  readonly writer: { readonly actor_id: Identifier; readonly run_id: Identifier | null };
}
export interface Preparation {
  readonly intention_id: Identifier;
  readonly context: DraftContext;
  readonly connection_id: Identifier;
  readonly generation: Decimal;
  readonly method: string;
  /** Full captured writer/workspace/run/guards; no current-context merge after prepare. */
  readonly params: JsonObject;
}
export interface PreparationSnapshot {
  readonly intention_id: Identifier;
  readonly context: DraftContext;
  readonly connection: ConnectionProfile;
  readonly method: string;
  readonly params: JsonObject;
}
export type OperationState =
  | { readonly kind: "prepared_unsent" }
  | { readonly kind: "sending" }
  | { readonly kind: "committed"; readonly response: PublicResponse }
  | { readonly kind: "observed"; readonly response: PublicResponse }
  | { readonly kind: "rejected"; readonly problem: Problem }
  | { readonly kind: "outcome_unknown"; readonly problem: Problem };
export interface Operation {
  readonly format: "workgraph-ui-operation-1";
  readonly operation_id: Identifier;
  readonly preparation: PreparationSnapshot;
  readonly preparation_input_hash: Digest;
  readonly connection: ConnectionProfile;
  /** Exact saved JSON-RPC request is retained, not reconstituted for retries. */
  readonly request: JsonObject;
  readonly journal_path: string | null;
  readonly revision: Decimal;
  readonly state: OperationState;
  readonly diagnostic: Problem | null;
  readonly receipt_lookup_supported: boolean;
}
export interface ReadInvocation {
  readonly connection_id: Identifier;
  readonly generation: Decimal;
  readonly method: string;
  readonly params: JsonObject;
  readonly lane: ReadLane;
}
export interface ReadResponse {
  readonly response: PublicResponse;
  /** Preserve exact daemon continuation until its method-specific decoder handles it. */
  readonly pagination: JsonObject | null;
}
