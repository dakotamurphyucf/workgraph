import type { JsonDocument, JsonResult, JsonValue } from "../../../core/json";

export type AdapterId =
  | "conversation.item.v1"
  | "claude.code.transcript.v1"
  | "anthropic.messages.request.v1"
  | "openai.responses.input.v1"
  | "anthropic.messages.response.v1"
  | "openai.responses.object.v1"
  | "openai.responses.event.v1"
  | "openai.chat-completions.object.v1"
  | "claude.agent-sdk.message.v1"
  | "codex.rollout-jsonl.7cdb219.v1";
export type FormatSelection = "auto" | "generic" | AdapterId;
export type SourcePath = readonly string[];
/** A caller report, never inferred from arbitrary role/model/vendor strings. */
export interface ProducerClaim {
  readonly name: string;
  readonly revision: string;
}
export interface CapturedPayload {
  /** Caller-owned immutable connection/generation/capture/event identity. */
  readonly captureId: string;
  /** Stable connection generation + workspace + logical session/collection identity; excludes mutable head/event ID. */
  readonly scopeId: readonly [
    connectionId: string,
    connectionGeneration: string,
    workspaceId: string,
    collectionId: string,
  ];
  /** Opaque event metadata. No timestamp/provider semantics are inferred here. */
  readonly metadata: JsonValue;
  /** Immutable caller-owned original bytes; retained by identity, never rewritten/detached. */
  readonly bytes: Uint8Array;
  readonly completeness: "complete" | "partial";
  readonly producer: ProducerClaim | null;
}
export interface AdapterDescriptor {
  readonly id: AdapterId;
  readonly label: string;
  readonly schemaPin: ProducerClaim;
  readonly sources: readonly string[];
}
export interface Provenance {
  readonly captureId: string;
  readonly adapter: AdapterId;
  readonly schemaPin: ProducerClaim;
  readonly path: SourcePath;
}
export interface Reported<T> {
  readonly value: T;
  readonly provenance: Provenance;
}
interface ItemBase {
  readonly provenance: Provenance;
  /** Original parsed subtree remains available; authoritative original bytes remain on capture. */
  readonly raw: JsonValue;
}
export type ProjectedItem =
  | (ItemBase & {
      readonly kind: "text";
      readonly text: string;
      readonly role: string | null;
      readonly phase: string | null;
      readonly interpretation:
        | "message"
        | "summary"
        | "refusal"
        | "retained-reasoning"
        | "reported-result"
        | "reported-error";
    })
  | (ItemBase & {
      readonly kind: "tool-call";
      readonly callId: string;
      readonly name: string;
      /** String arguments stay strings; no guessed JSON parse or tool invocation. */
      readonly arguments: JsonValue;
    })
  | (ItemBase & {
      readonly kind: "tool-result";
      readonly callId: string | null;
      readonly content: JsonValue;
      readonly reportedError: boolean | null;
    })
  | (ItemBase & {
      readonly kind: "opaque-reasoning";
      readonly retention: "signature" | "encrypted" | "redacted";
      /** Opaque retained value, never interpreted as missing reasoning text. */
      readonly opaque: JsonValue;
    })
  | (ItemBase & {
      readonly kind: "marker";
      readonly label: string;
      readonly reportedStatus: string | null;
    })
  | (ItemBase & {
      readonly kind: "unsupported";
      readonly reason: string;
    });
export type MetricName =
  | "input_tokens"
  | "output_tokens"
  | "total_tokens"
  | "cache_read_tokens"
  | "cache_creation_tokens"
  | "reasoning_tokens"
  | "model_round_trips"
  | "duration_ms"
  | "api_duration_ms"
  | "estimated_cost_usd";
export interface ReportedMetric {
  readonly name: MetricName;
  /** Original JSON number lexeme, never converted to JavaScript Number. */
  readonly lexeme: string;
  readonly unit: "tokens" | "model-round-trips" | "milliseconds" | "USD";
  readonly basis: "snapshot" | "breakdown" | "report" | "cumulative-snapshot";
  readonly scope:
    | {
        readonly kind: "response";
        readonly family:
          "anthropic.messages" | "openai.responses" | "openai.chat-completions" | "codex.rollout";
        readonly id: string;
      }
    | {
        readonly kind: "sdk-result";
        readonly family: "claude.agent-sdk";
        readonly sessionId: string;
        readonly resultId: string;
      }
    | {
        readonly kind: "sdk-query-pipeline";
        readonly family: "claude.agent-sdk";
        readonly sessionId: string;
        readonly queryId: null;
        readonly reportedByResultId: string;
      };
  /** Exact source extent; no claim of complete captured-session coverage. */
  readonly coverage:
    | "reported-response"
    | "reported-result-duration-extent-not-inferred"
    | "reported-result-model-round-trips"
    | "reported-main-agent-only-usage-per-turn-in-streaming"
    | "reported-query-pipeline-cumulative-query-boundary-unknown";
  readonly provenance: Provenance;
  /** Duplicate reports with this exact source identity overlap; never automatically sum distinct keys either. */
  readonly snapshotKey: string | null;
  /** Potential cumulative overlap only; session ID does not establish a query()/clear boundary. */
  readonly possibleOverlapKey: string | null;
}
export interface FormatProjection {
  readonly items: readonly ProjectedItem[];
  readonly metrics: readonly ReportedMetric[];
  readonly model: Reported<string> | null;
  readonly sourceTime: Reported<{
    readonly format: "unix-seconds" | "source-string";
    readonly exact: string;
  }> | null;
  readonly sourceSequence: Reported<string> | null;
  readonly identity: Reported<string> | null;
  readonly reportedStatus: Reported<string> | null;
  readonly reportedError: Reported<boolean> | null;
  readonly warnings: readonly string[];
}
export interface ValidationIssue {
  readonly adapter: AdapterId;
  readonly path: SourcePath;
  readonly expected: string;
}
interface ResultBase {
  readonly capture: CapturedPayload;
  readonly selection: FormatSelection;
  readonly document: JsonResult<JsonDocument> | null;
}
export type ProjectionResult =
  | (ResultBase & {
      readonly status: "recognized";
      readonly adapter: AdapterDescriptor;
      readonly recognition: "validated-shape" | "producer-pinned";
      readonly projection: FormatProjection;
    })
  | (ResultBase & {
      readonly status: "generic";
      readonly reason: "explicit-generic";
    })
  | (ResultBase & {
      readonly status: "unsupported";
      readonly reason:
        | "partial"
        | "byte-budget"
        | "invalid-json"
        | "parse-budget"
        | "schema-mismatch"
        | "no-adapter"
        | "producer-mismatch";
      readonly issues: readonly ValidationIssue[];
    })
  | (ResultBase & {
      readonly status: "ambiguous";
      readonly candidates: readonly AdapterDescriptor[];
      readonly reason: "multiple-validated-shapes";
    });
