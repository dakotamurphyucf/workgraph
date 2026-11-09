import type { FeatureContext } from "../../../app/types";
import type { HttpClient } from "../../../core/protocol/http";
import type {
  ConnectionProfile,
  Decimal,
  Digest,
  DraftContext,
  Identifier,
  JsonObject,
  Operation,
} from "../../../core/protocol/types";
import type { OperationController } from "../../../core/state/operations";

export type PlansView = "templates" | "drafts";
export interface PlanCapture {
  readonly connection: ConnectionProfile;
  readonly context: DraftContext & { readonly workspace_id: Identifier };
}
/** A native transaction operation. Aliases name unpublished local references. */
export interface PlanOperation {
  readonly method: string;
  readonly params: JsonObject;
  readonly alias: string | null;
}
/** Explicit later-stage substitution from a committed, durable native receipt.
 * Both paths are JSON pointer segments. No provisional preflight ID is eligible. */
export interface ReceiptBinding {
  readonly operation: number;
  readonly path: readonly string[];
  readonly stage: string;
  readonly receiptPath: readonly string[];
}
export interface PlanStage {
  readonly id: string;
  readonly title: string;
  readonly operations: readonly PlanOperation[];
  readonly bindings: readonly ReceiptBinding[];
  /** Explicit exposure review; independent commits never imply whole-plan atomicity. */
  readonly exposure: string;
  readonly exposures: readonly StageExposure[];
}
export interface StageExposure {
  readonly operation: number;
  /** Declared intent, never an assertion of graph readiness or gate completeness. */
  readonly disposition: "held" | "runnable";
  readonly deferred: string;
  readonly templateDigest: Digest | null;
}
export interface PlanDocument {
  readonly format: "workgraph-ui-plan-1";
  readonly title: string;
  /** Explicit ordered boundaries; never automatically split an atomic instance. */
  readonly stages: readonly PlanStage[];
}
export interface Preflight {
  readonly baseRevision: Decimal;
  readonly proposedRevision: Decimal;
  /** Exact native expanded-limit accumulator at the captured staged state, not source length. */
  readonly expandedOperationCount: Decimal;
  readonly generatedIds: readonly { readonly kind: string; readonly id: Identifier }[];
  readonly stagedBlobCount: Decimal;
  readonly stagedBlobBytes: Decimal;
  /** Exact preflight source survives independently from any durable response. */
  readonly raw: JsonObject;
}
export interface FrozenStage {
  readonly stageId: string;
  readonly sourceRevision: number;
  readonly stageIndex: number;
  readonly sourceStage: JsonObject;
  readonly hash: Digest;
  readonly reviewHash: Digest;
  readonly params: JsonObject;
  readonly preview: Preflight;
  readonly intentionId: Identifier;
  readonly prepared: boolean;
  readonly captured: boolean;
  readonly operationId: Identifier | null;
  readonly requestHash: Digest | null;
  readonly preparationHash: Digest | null;
}
export interface TemplatePin {
  readonly id: Identifier;
  readonly version: Decimal;
  readonly digest: Digest;
  readonly spec: JsonObject;
  readonly raw: JsonObject;
}
export interface TemplatePreview {
  readonly template: TemplatePin;
  readonly instance: JsonObject;
  readonly request: { readonly method: "template.instantiate"; readonly params: JsonObject };
}
export type PlanTask = "parsing" | "preflight" | "preparing" | "template" | "restoring";
export interface PlanDraft {
  readonly id: Identifier;
  readonly capture: PlanCapture;
  readonly source: string;
  readonly sourceBytes: number;
  readonly revision: number;
  readonly parsedRevision: number | null;
  readonly structuredRevision: number | null;
  readonly document: PlanDocument | null;
  readonly templateSpec: JsonObject | null;
  readonly templateSpecRevision: number | null;
  readonly frozen: readonly FrozenStage[];
  readonly snapshots: readonly PlanSnapshot[];
  readonly active: PlanTask | null;
  readonly issue: string | null;
  readonly unexpected: { readonly error: unknown } | null;
  readonly persisted: "pending" | "saved" | "unavailable";
  /** Storage diagnostics never own or clear an active native preparation. */
  readonly persistenceFailure: { readonly revision: number; readonly error: unknown } | null;
}
export interface PlanSnapshot {
  readonly revision: number;
  readonly source: string;
  readonly sourceBytes: number;
  readonly hash: Digest;
}
export interface PlansState {
  readonly drafts: readonly PlanDraft[];
  readonly selectedId: Identifier | null;
  readonly templates: readonly TemplatePin[];
  readonly templateRevision: Decimal | null;
  readonly nextTemplateOffset: Decimal | null;
  readonly templateScope: string | null;
  readonly templateBusy: boolean;
  readonly templateIssue: string | null;
  readonly templatePreview: {
    readonly capture: PlanCapture;
    readonly value: TemplatePreview;
  } | null;
  readonly issue: string | null;
  readonly unexpected: { readonly error: unknown } | null;
}
export interface PlansController {
  readonly get: () => PlansState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly create: (context: FeatureContext, source?: string) => Identifier | null;
  /** A null selection returns to the draft library without deleting local recovery. */
  readonly select: (id: Identifier | null) => void;
  readonly copy: (id: Identifier) => Identifier | null;
  readonly edit: (id: Identifier, source: string) => void;
  readonly parse: (id: Identifier) => Promise<void>;
  /** Applies only to the same source revision captured before asynchronous encoding. */
  readonly replaceDocument: (id: Identifier, document: PlanDocument) => Promise<void>;
  readonly replaceTemplateSpec: (id: Identifier, spec: JsonObject) => Promise<void>;
  readonly createTemplateSource: (context: FeatureContext) => Promise<Identifier | null>;
  readonly createInstance: (
    context: FeatureContext,
    pin: TemplatePin,
  ) => Promise<Identifier | null>;
  /** Explicit read-only helper preview creates a separate canonical publication draft. */
  readonly canonicalizeTemplate: (id: Identifier) => Promise<Identifier | null>;
  readonly preview: (id: Identifier, stageId: string, baseRevision?: Decimal) => Promise<void>;
  readonly prepare: (id: Identifier, stageId: string) => Promise<void>;
  /** Only observes saved native journals. Never executes, retries or recovers. */
  readonly restoreOperations: (id: Identifier) => Promise<void>;
  readonly loadTemplates: (context: FeatureContext, more?: boolean) => Promise<void>;
  readonly previewTemplate: (
    context: FeatureContext,
    pin: TemplatePin,
    params: JsonObject,
  ) => Promise<void>;
  readonly publishTemplate: (
    context: FeatureContext,
    params: JsonObject,
  ) => Promise<Identifier | null>;
  readonly importDraft: (source: string) => Promise<Identifier | null>;
  readonly exportDraft: (id: Identifier) => Promise<string | null>;
  readonly draftFromTemplatePreview: () => Promise<Identifier | null>;
  readonly remove: (id: Identifier) => void;
  readonly dispose: () => void;
}
export interface DraftStorage {
  /** Versioned export text; decoding remains bounded and worker-owned. */
  readonly load: () => Promise<readonly string[]>;
  readonly put: (id: Identifier, value: string) => Promise<void>;
  readonly remove: (id: Identifier) => Promise<void>;
  readonly dispose: () => void;
}
export interface PlansControllerOptions {
  readonly http: HttpClient;
  readonly operations: OperationController;
  readonly storage?: DraftStorage;
  readonly newId?: () => string;
}
export interface PlansFeatureProps {
  readonly context: FeatureContext;
  readonly controller: PlansController;
  readonly operations: OperationController;
  readonly view: PlansView;
}
export interface DurableStageReceipt {
  readonly stage: FrozenStage;
  readonly operation: Operation;
}
