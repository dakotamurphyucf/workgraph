import type { JsonValue } from "../../../core/json";
import type {
  ConnectionProfile,
  Decimal,
  Digest,
  Identifier,
  Problem,
  Preparation,
} from "../../../core/protocol/types";
import type { HttpClient, HttpResult } from "../../../core/protocol/http";
import type { OperationController } from "../../../core/state/operations";
import type { ReadState } from "../../../core/state/read-slot";
import type { FeatureContext } from "../../../app/types";

/** Paths name the companion host. They are never interpreted as browser file paths or executable commands. */
export interface StageTarget {
  readonly directory: string;
}
export type OutputStream = "stdout" | "stderr";
export type OutputSelection =
  | { readonly kind: "range"; readonly offset: Decimal; readonly length: Decimal }
  | { readonly kind: "retained_tail"; readonly length: Decimal };
export interface CapturedCommand {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly output_limit: Decimal;
  readonly source_root?: string | undefined;
  readonly source_paths?: readonly string[] | undefined;
}
export type CapturedOutcome =
  | { readonly kind: "exited"; readonly code: Decimal }
  | { readonly kind: "signaled"; readonly signal: string }
  | { readonly kind: "interrupted" }
  | { readonly kind: "launch_failed"; readonly message: string };
export interface RetainedOutput {
  readonly digest: Digest;
  readonly size_bytes: Decimal;
  readonly observed_bytes: string;
  readonly observed_sha256: Digest;
  readonly eof: boolean;
  readonly truncated: boolean;
}
export type StageSnapshot = StageTarget & {
  readonly command: CapturedCommand;
  readonly owner_token: string | null;
  /** A native intent does not contain an endpoint. Its existence is never inferred to be this helper's binding. */
  readonly publication_intent: "absent" | "external" | "helper_bound";
} & (
    | { readonly kind: "unfinished" }
    | {
        readonly kind: "finished";
        readonly capture: { readonly digest: Digest; readonly size_bytes: Decimal };
        readonly outcome: CapturedOutcome;
        readonly started_unix_ms: string;
        readonly finished_unix_ms: string;
        readonly elapsed_ms: string;
        readonly source_before: JsonValue;
        readonly source_after: JsonValue;
        readonly stdout: RetainedOutput;
        readonly stderr: RetainedOutput;
      }
  );
export interface InspectedOutput {
  readonly directory: string;
  readonly capture_digest: Digest;
  readonly stream: OutputStream;
  readonly selection: OutputSelection["kind"];
  readonly retention: "prefix";
  readonly offset: Decimal;
  readonly returned_bytes: Decimal;
  readonly retained_bytes: Decimal;
  readonly omitted_retained_bytes: Decimal;
  readonly observed_bytes: string;
  readonly observed_sha256: Digest;
  readonly eof: boolean;
  readonly truncated: boolean;
  readonly at_observed_end: boolean;
  readonly text: string;
  readonly text_lossy: boolean;
  readonly data_base64: string;
  readonly source_before: JsonValue;
  readonly source_after: JsonValue;
  readonly outcome: CapturedOutcome;
}
export interface ExternalIntent extends StageTarget {
  readonly intent_digest: Digest;
  readonly saved_request: string;
  readonly request: JsonValue;
  readonly original_endpoint_recorded: false;
}
export type PublicationPlan = StageTarget & {
  readonly intention_id: Identifier;
  readonly connection: ConnectionProfile;
} & (
    | {
        readonly kind: "ui_prepared";
        readonly context: Preparation["context"];
        readonly params: {
          readonly workspace_id: Identifier;
          readonly actor_id: Identifier;
          readonly run_id?: Identifier | undefined;
          readonly mutation_id: Identifier;
          readonly resource_id: Identifier;
          readonly expected_revision: Decimal;
          readonly title: string;
          /** Absent means no link. Ticket linking is confirmed independently. */
          readonly ticket_id?: Identifier | undefined;
        };
        readonly capture_digest: Digest;
      }
    | {
        /** New cooperative operator assertion. The old file never proved this endpoint. */
        readonly kind: "operator_bound_external";
        readonly intent_digest: Digest;
      }
  );
export type PublicationLink =
  | { readonly kind: "not_requested" }
  | { readonly kind: "linked"; readonly receipt: JsonValue }
  | { readonly kind: "rejected"; readonly problem: Problem }
  | { readonly kind: "unknown"; readonly problem: Problem | null };
export interface KnownPublication {
  readonly publication: JsonValue;
  readonly link: PublicationLink;
}
export interface PublicationSummary {
  readonly plan: PublicationPlan;
  readonly revision: Decimal;
  readonly state_kind: PublicationJob["state"]["kind"];
  readonly publication_known: boolean;
  readonly link_kind: PublicationLink["kind"] | null;
  readonly diagnostic: Problem | null;
}
export interface PublicationJob {
  readonly plan: PublicationPlan;
  readonly input_hash: Digest;
  readonly revision: Decimal;
  readonly saved_request: string | null;
  readonly native_request: JsonValue | null;
  readonly intent_digest: Digest | null;
  readonly diagnostic: Problem | null;
  readonly state:
    | { readonly kind: "prepared_unsent" }
    | { readonly kind: "running"; readonly previous: KnownPublication | null }
    | ({ readonly kind: "published" } & KnownPublication)
    | { readonly kind: "outcome_unknown"; readonly diagnostic: Problem }
    | { readonly kind: "local_save_incomplete"; readonly diagnostic: Problem }
    | { readonly kind: "failed_unsent"; readonly diagnostic: Problem };
}
export interface ExecutionClient {
  readonly inspectStage: (
    target: StageTarget,
    signal: AbortSignal,
  ) => Promise<HttpResult<StageSnapshot>>;
  readonly inspectOutput: (
    target: StageTarget & { readonly capture_digest: Digest },
    stream: OutputStream,
    selection: OutputSelection,
    signal: AbortSignal,
  ) => Promise<HttpResult<InspectedOutput>>;
  readonly inspectIntent: (
    target: StageTarget,
    signal: AbortSignal,
  ) => Promise<HttpResult<ExternalIntent>>;
  readonly prepare: (
    plan: PublicationPlan,
    signal?: AbortSignal,
  ) => Promise<HttpResult<PublicationJob>>;
  readonly start: (id: Identifier) => Promise<HttpResult<PublicationJob>>;
  readonly retryExact: (id: Identifier) => Promise<HttpResult<PublicationJob>>;
  readonly recover: (id: Identifier) => Promise<HttpResult<PublicationJob>>;
  readonly inspect: (id: Identifier, signal: AbortSignal) => Promise<HttpResult<PublicationJob>>;
  readonly list: (
    offset: Decimal,
    signal: AbortSignal,
  ) => Promise<
    HttpResult<{
      readonly items: readonly PublicationSummary[];
      readonly next_offset: Decimal | null;
      readonly total: Decimal;
    }>
  >;
  readonly cleanup: (
    target: StageTarget & { readonly owner_token: string },
    signal?: AbortSignal,
  ) => Promise<HttpResult<{ readonly directory: string; readonly cleaned: true }>>;
}
export interface LocalEvidenceOptions {
  readonly http: HttpClient;
  readonly operations: OperationController;
}
/** The optional context supplies a real publish target; local inspection remains available without fabricating one. */
export interface LocalEvidenceFeatureProps {
  readonly context: FeatureContext | null;
  readonly controller: LocalEvidenceController;
}
export interface LocalEvidenceController {
  readonly get: () => LocalEvidenceState;
  readonly setDirectory: (directory: string) => void;
  readonly inspectStage: () => Promise<void>;
  readonly inspectOutput: (stream: OutputStream, selection: OutputSelection) => Promise<void>;
  readonly inspectIntent: () => Promise<void>;
  readonly newPublication: (context: FeatureContext) => void;
  readonly edit: (fields: Partial<PublicationFields>) => void;
  readonly review: () => Promise<void>;
  readonly finishSaving: (id?: Identifier) => Promise<void>;
  readonly associate: (connection: ConnectionProfile) => Promise<void>;
  readonly act: (
    id: Identifier,
    action: "start" | "retryExact" | "recover" | "inspect",
  ) => Promise<void>;
  readonly loadSaved: (offset?: Decimal) => Promise<void>;
  readonly cleanup: () => Promise<void>;
  readonly download: () => Promise<void>;
  readonly cancelDownload: () => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispose: () => void;
}
/** Initial typed owner contract. Body implementation will refine draft actions without nullable phase/preparation contradictions. */
export interface LocalEvidenceState {
  readonly directory: string;
  readonly stage: ReadState<StageSnapshot>;
  readonly output: ReadState<InspectedOutput>;
  readonly selectedStream: OutputStream;
  readonly jobs: readonly PublicationJob[];
  readonly diagnostic: string | null;
  readonly intent: ReadState<ExternalIntent>;
  readonly saved: ReadState<{
    readonly items: readonly PublicationSummary[];
    readonly next_offset: Decimal | null;
    readonly total: Decimal;
  }>;
  readonly draft: LocalDraft | null;
  readonly notice: LocalNotice | null;
  readonly busy: boolean;
  readonly unexpected: { readonly error: unknown } | null;
  readonly uncertain: ReadonlySet<Identifier>;
  readonly observations: ReadonlyMap<
    Identifier,
    import("../../../core/state/progress-observer").ProgressStatus
  >;
  readonly download:
    | { readonly kind: "idle" }
    | { readonly kind: "running"; readonly received: number; readonly total: number }
    | { readonly kind: "ready"; readonly blob: Blob; readonly filename: string }
    | { readonly kind: "failed"; readonly message: string };
}

export interface PublicationFields {
  readonly resourceId: string;
  readonly expectedRevision: string;
  readonly title: string;
  readonly ticketId: string;
}
export type LocalDraft =
  | {
      readonly kind: "editing";
      readonly id: Identifier;
      readonly connection: ConnectionProfile;
      readonly context: Preparation["context"];
      readonly stage: Extract<StageSnapshot, { readonly kind: "finished" }>;
      readonly fields: PublicationFields;
    }
  | { readonly kind: "captured"; readonly plan: PublicationPlan; readonly pending: boolean };
export type LocalNotice =
  | { readonly kind: "message"; readonly message: string }
  | {
      readonly kind: "request_failure";
      readonly failure: import("../../../core/protocol/http").HttpFailure;
      readonly uncertain: boolean;
    };
