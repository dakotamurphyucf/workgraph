import type { FeatureContext } from "../../../app/types";
import type {
  JsonObject,
  Decimal,
  Digest,
  Identifier,
  Problem,
} from "../../../core/protocol/types";
import type { ResourceCapture, ResourceRecord, ResourceScope, ResourceVersion } from "./types";
export interface ResourceStage {
  readonly stage_id: Identifier;
  readonly digest: Digest;
  readonly size_bytes: Decimal;
  readonly received: Decimal;
  readonly status: "incoming" | "sealed" | "abandoned";
  readonly source_retained: boolean;
  readonly intention_id: Identifier | null;
  readonly diagnostic: Problem | null;
}
export type PublicationLink =
  | { readonly kind: "not_requested" }
  | { readonly kind: "unresolved"; readonly problem: Problem | null }
  | { readonly kind: "committed"; readonly response: JsonObject };
export interface PublishedUpload {
  readonly kind: "published";
  readonly publication: {
    readonly data: {
      readonly resource_id: Identifier;
      readonly revision: Decimal;
      readonly version: ResourceVersion;
    };
    readonly meta: JsonObject;
  };
  readonly link: PublicationLink;
}
export type UploadPhase =
  | { readonly kind: "local_save_incomplete" | "prepared_unsent" }
  | { readonly kind: "running"; readonly previous: PublishedUpload | null }
  | { readonly kind: "rejected" | "outcome_unknown"; readonly problem: Problem }
  | PublishedUpload;
export interface ResourceUploadJob {
  readonly intention_id: Identifier;
  readonly plan: JsonObject;
  readonly native_plan: JsonObject;
  readonly saved_request: JsonObject;
  readonly journal_path: string;
  readonly input_hash: Digest;
  readonly revision: Decimal;
  readonly phase: UploadPhase;
  readonly diagnostic: Problem | null;
}
export interface UploadInput {
  readonly resourceId: string;
  readonly title: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly ticketId: string;
}
export interface UploadDraft {
  readonly id: Identifier;
  readonly stageId: Identifier;
  readonly scope: ResourceScope;
  readonly writer: { readonly actorId: Identifier; readonly runId: Identifier | null };
  readonly projectId: Identifier | null;
  readonly expectedRevision: Decimal;
  readonly input: UploadInput;
  readonly file: File | null;
  readonly phase: "editing" | "staging" | "interrupted" | "sealed" | "preparing" | "prepared";
  readonly received: number;
  readonly digest: Digest | null;
  readonly issue: string | null;
  readonly unexpected: { readonly error: unknown } | null;
}
export interface UploadPage<T> {
  readonly items: readonly T[];
  readonly next_offset: Decimal | null;
  readonly offset: Decimal;
  readonly remaining: Decimal;
}
export interface StagePage extends UploadPage<ResourceStage> {
  readonly retained_bytes: Decimal;
  readonly maximum_retained_bytes: Decimal;
  readonly incoming_count: Decimal;
}
export interface UploadState {
  readonly drafts: readonly UploadDraft[];
  readonly selectedId: Identifier | null;
  readonly stages: StagePage | null;
  readonly jobs: UploadPage<ResourceUploadJob> | null;
  readonly selectedJob: ResourceUploadJob | null;
  readonly loading: boolean;
  readonly issue: string | null;
  readonly unexpected: { readonly error: unknown } | null;
}
export interface ResourceUploadController {
  readonly get: () => UploadState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly open: (
    context: FeatureContext,
    scope: ResourceScope,
    base?: ResourceCapture<ResourceRecord>,
  ) => void;
  readonly edit: (id: Identifier, input: UploadInput, file?: File) => void;
  readonly choose: (id: Identifier | null) => void;
  readonly stage: (id: Identifier) => Promise<void>;
  readonly cancelStaging: (id: Identifier) => void;
  readonly prepare: (id: Identifier) => Promise<void>;
  readonly inspect: (id: Identifier) => Promise<void>;
  /** Read the selected transfer without changing selection or replaying a write. */
  readonly observe: (id: Identifier, signal: AbortSignal) => Promise<void>;
  readonly finishSaving: (id: Identifier) => Promise<void>;
  readonly act: (id: Identifier, action: "start" | "retry-exact" | "recover") => Promise<void>;
  readonly inventory: (offset?: Decimal, stageOffset?: Decimal) => Promise<void>;
  readonly abandon: (id: Identifier) => Promise<void>;
  readonly close: (id: Identifier) => void;
  readonly dispose: () => void;
}
