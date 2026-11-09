import type { FeatureContext } from "../../app/types";
import type { JsonValue } from "../../core/json";
import type { HttpClient, HttpResult } from "../../core/protocol/http";
import type {
  ConnectionProfile,
  Identifier,
  ReadLane,
  ReadResponse,
} from "../../core/protocol/types";
import type {
  ManagedOperation,
  ManagedResult,
  OperationController,
  ManagedAction,
} from "../../core/state/operations";
import type { ReadState } from "../../core/state/read-slot";
export interface CatalogMethod {
  readonly name: string;
  readonly mode: "read" | "write" | "mutation";
  readonly tier: "core" | "advanced";
  readonly summary: string;
}
export interface DiscoveryEntry {
  readonly name: string;
  readonly kind: "helper" | "workflow";
  readonly summary: string;
  readonly use_when: string;
  readonly capability: string;
  readonly effect: string | null;
  readonly next: string;
  readonly reference: string;
  readonly tier: string | null;
  readonly related: readonly string[];
  readonly search_terms: readonly string[];
  readonly steps: readonly string[];
}
export interface Capability {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly groups: readonly string[];
  readonly reference: string;
}
export interface Catalog {
  readonly methods: readonly CatalogMethod[];
  readonly helpers: readonly DiscoveryEntry[];
  readonly workflows: readonly DiscoveryEntry[];
  readonly capabilities: readonly Capability[];
}
export interface FieldDescriptor {
  readonly name: string;
  readonly requirement: "required" | "optional" | "conditional";
  readonly summary: string;
  readonly descriptions: readonly string[];
  readonly schema: JsonValue;
  readonly json_argument: readonly string[];
}
export interface MethodContract {
  readonly method: CatalogMethod & { readonly params: JsonValue; readonly result: JsonValue };
  readonly help: string;
  readonly fields: {
    readonly method: string;
    readonly summary: string;
    readonly schema_dialect: string;
    readonly guidance: string;
    readonly fields: readonly FieldDescriptor[];
    readonly validation_schema: JsonValue;
  };
}
export interface HostSurface {
  readonly name: string;
  readonly summary: string;
  readonly command: string;
  readonly guidance: string;
  readonly reference: string;
}
export interface DraftSelection {
  readonly connection: ConnectionProfile;
  readonly workspaceId: string | null;
  readonly projectId: string | null;
  readonly actorId: string | null;
  readonly runId: string | null;
}
export interface ParameterFieldEdit {
  readonly presence: "omit" | "null" | "value";
  readonly text: string;
}
export type ParameterState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly value: import("./parameters").ParsedParameters }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "unexpected_error"; readonly error: unknown };
export interface AdvancedDraft {
  readonly id: Identifier;
  readonly contract: MethodContract;
  readonly selection: DraftSelection;
  /** Exact user-edited source. Never silently merges changed selection. */ readonly source: string;
  readonly parameters: ParameterState;
  readonly preparing: boolean;
  readonly preparationError: { readonly error: unknown } | null;
  readonly reading: boolean;
  readonly fieldEdits: Readonly<Record<string, ParameterFieldEdit>>;
  readonly fieldErrors: Readonly<Record<string, string>>;
  readonly locked: boolean;
  readonly lane: ReadLane;
  readonly read: ReadState<ReadResponse>;
}
export interface AdvancedState {
  readonly catalog: ReadState<Catalog>;
  readonly selectedMethod: string | null;
  readonly contract: ReadState<MethodContract>;
  readonly drafts: readonly AdvancedDraft[];
  readonly activeDraftId: Identifier | null;
  readonly notice: string;
}
export interface AdvancedController {
  readonly get: () => AdvancedState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly loadCatalog: () => Promise<
    HttpResult<Catalog> | { readonly ok: false; readonly superseded: true }
  >;
  readonly selectMethod: (
    name: string,
  ) => Promise<HttpResult<MethodContract> | { readonly ok: false; readonly superseded: true }>;
  readonly createDraft: (context: FeatureContext) => Identifier | null;
  /** Clone retains original captured selection; explicit new draft captures current selection. */
  readonly cloneDraft: (id: Identifier) => Identifier | null;
  readonly selectDraft: (id: Identifier) => void;
  readonly editSource: (id: Identifier, source: string) => boolean;
  readonly stageField: (id: Identifier, name: string, input: ParameterFieldEdit) => boolean;
  /** True commits a new source; its asynchronous validation state remains explicit. */
  readonly applyField: (id: Identifier, name: string) => Promise<boolean>;
  readonly validateParameters: (id: Identifier) => Promise<boolean>;
  readonly fillScopeFields: (id: Identifier) => Promise<boolean>;
  readonly discardFieldEdits: (id: Identifier) => void;
  readonly setLane: (id: Identifier, lane: ReadLane) => void;
  readonly runRead: (id: Identifier) => Promise<void>;
  readonly continueRead: (id: Identifier, kind: "next_request" | "retry_request") => Promise<void>;
  readonly cancelRead: (id: Identifier) => void;
  readonly prepare: (id: Identifier) => Promise<ManagedResult | null>;
  readonly act: (id: Identifier, action: ManagedAction) => Promise<ManagedResult>;
  readonly operation: (id: Identifier) => ManagedOperation | undefined;
  /** Closes the editor; an admitted intention remains in shared operations and native journal. */
  readonly discardDraft: (id: Identifier) => boolean;
  /** Only aborts read observations; admitted writes remain owned by shared operations. */
  readonly dispose: () => void;
}
export interface AdvancedOptions {
  readonly client: HttpClient;
  readonly operations: OperationController;
  readonly newId?: () => string;
}
export interface AdvancedFeatureProps {
  readonly context: FeatureContext;
  readonly operations: OperationController;
  readonly controller: AdvancedController;
}
