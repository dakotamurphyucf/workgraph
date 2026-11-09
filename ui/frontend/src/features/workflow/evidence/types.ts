import type { LiveReadable } from "../../../core/state/live-types";
import type { FeatureContext } from "../../../app/types";
import type { JsonValue } from "../../../core/json";
import type { HttpClient } from "../../../core/protocol/http";
import type {
  ConnectionProfile,
  Decimal,
  Digest,
  Identifier,
  JsonObject,
  Preparation,
  Problem,
  ReadResponse,
} from "../../../core/protocol/types";
import type { OperationController } from "../../../core/state/operations";
import type { ReadState } from "../../../core/state/read-slot";

/** Evidence has its own immutable namespace capture, distinct from graph/planning revisions. */
export interface EvidenceTarget {
  readonly connection: ConnectionProfile;
  readonly workspaceId: Identifier;
  readonly ticketId: Identifier;
}
export interface EvidenceDocument {
  readonly target: EvidenceTarget;
  readonly revision: Decimal;
  readonly raw: JsonObject;
  readonly meta: JsonObject;
}
export interface EffectivePolicy {
  readonly ticket_id: Identifier;
  readonly digest: Digest;
  readonly project_id: Identifier | null;
  readonly membership_revision: Decimal;
  readonly ownership_token: Decimal | null;
  readonly sources: readonly JsonObject[];
  readonly reviewers: readonly JsonObject[];
  readonly validators: readonly string[];
  readonly criteria: readonly JsonObject[];
  readonly separate_actor: boolean;
  readonly stale_override: JsonValue;
}
export interface EvidenceCapture extends EvidenceDocument {
  readonly policy: EffectivePolicy;
  readonly localPolicy: JsonObject | null;
  readonly manifest: JsonObject | null;
  readonly submission: JsonObject | null;
  readonly assertions: readonly JsonObject[];
  readonly reviews: readonly JsonObject[];
  readonly reconciliations: readonly JsonObject[];
  readonly decisions: readonly JsonObject[];
}
export interface GateCapture extends EvidenceDocument {
  readonly allowed: boolean;
  readonly problem: Problem | null;
}
export type EvidenceMethod =
  | "acceptance.policy.put"
  | "review.policy.put"
  | "contract.put"
  | "manifest.publish"
  | "acceptance.assert"
  | "validation.add"
  | "review.submit"
  | "review.record"
  | "review.accept"
  | "decision.put"
  | "input.changed"
  | "reconciliation.record"
  | "condition.put"
  | "condition.signal";
export type EvidenceRead =
  | "acceptance.policy.get"
  | "acceptance.policy.effective"
  | "acceptance.assertions"
  | "review.policy.get"
  | "contract.get"
  | "contract.list"
  | "contract.history"
  | "manifest.get"
  | "manifest.list"
  | "manifest.history"
  | "validation.list"
  | "review.submission.get"
  | "review.submission.list"
  | "review.list"
  | "decision.get"
  | "decision.list"
  | "decision.history"
  | "reconciliation.list"
  | "condition.get"
  | "condition.list"
  | "condition.signals";
export interface EvidenceField {
  readonly name: string;
  readonly label: string;
  readonly type: "text" | "multiline" | "identifier" | "counter" | "boolean" | "json" | "choice";
  readonly optional?: boolean;
  readonly choices?: readonly string[];
  readonly hint?: string;
  readonly initial?: string;
}
export interface EvidenceCommand {
  readonly method: EvidenceMethod;
  readonly title: string;
  readonly group: "policy" | "artifacts" | "review" | "changes" | "conditions";
  readonly description: string;
  readonly fields: readonly EvidenceField[];
}
/** Structured fields retain their exact lossless source; readable row editors derive
 * typed rows once per source revision through the protocol worker. */
export interface FieldInput {
  readonly presence: "value" | "omit";
  readonly text: string;
  /** Worker-decoded display cache for this exact source; preparation parses the
   * retained source again and never trusts a caller-supplied cache as authority. */
  readonly value?: JsonValue;
}
export type EvidencePhase =
  | { readonly kind: "initializing" }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "editing" }
  | { readonly kind: "preparing" }
  | { readonly kind: "registered"; readonly preparation: Preparation };
export interface EvidenceDraft {
  readonly id: Identifier;
  readonly method: EvidenceMethod;
  readonly target: EvidenceTarget;
  readonly writer: { readonly actorId: Identifier; readonly runId: Identifier | null };
  readonly claim: {
    readonly actorId: Identifier;
    readonly runId: Identifier | null;
    readonly token: Decimal;
  } | null;
  readonly projectId: Identifier | null;
  /** Capture which seeded this editor. Refresh never rewrites it. */
  readonly base: EvidenceCapture | null;
  readonly inputs: Readonly<Record<string, FieldInput>>;
  readonly phase: EvidencePhase;
  readonly issue: string | null;
  readonly unexpected: { readonly error: unknown } | null;
}
export interface EvidenceState {
  readonly target: EvidenceTarget | null;
  readonly evidence: ReadState<EvidenceCapture>;
  readonly gate: ReadState<GateCapture>;
  readonly inspector: ReadState<ReadResponse>;
  readonly inspectorMethod: EvidenceRead | null;
  readonly drafts: readonly EvidenceDraft[];
  readonly selectedDraft: Identifier | null;
  readonly issue: string | null;
  readonly unexpected: { readonly error: unknown } | null;
}
export interface EvidenceController extends LiveReadable {
  readonly get: () => EvidenceState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Reads are superseded by exact target; existing editor and operation captures survive. */
  readonly select: (context: FeatureContext, ticketId: string) => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly inspect: (method: EvidenceRead, source: string) => Promise<void>;
  readonly continueInspection: (kind: "next_request" | "retry_request") => Promise<void>;
  readonly open: (
    context: FeatureContext,
    ticketId: string,
    method: EvidenceMethod,
  ) => Promise<Identifier | null>;
  readonly selectDraft: (id: Identifier) => void;
  readonly edit: (id: Identifier, name: string, input: FieldInput) => void;
  readonly prepare: (id: Identifier) => Promise<void>;
  readonly discard: (id: Identifier) => void;
  /** Cancels only this owner's reads/pre-admission preparation. Shared admitted writes survive. */
  readonly dispose: () => void;
}
export interface EvidenceOptions {
  readonly http: HttpClient;
  readonly operations: OperationController;
}
export interface EvidenceFeatureProps {
  readonly context: FeatureContext;
  readonly ticketId: string;
  readonly controller: EvidenceController;
  readonly operations: OperationController;
  /** Comparison provenance only; it never makes evidence a planning-atomic capture. */
  readonly graphRevision?: Decimal;
  /** Exact immutable resource association shared with Progress. The Resources
   * owner must resolve this retained generation/version, never current content. */
  readonly openEvidence?: (
    target: import("../../work/progress/types").TicketEvidenceTarget,
  ) => void;
}
