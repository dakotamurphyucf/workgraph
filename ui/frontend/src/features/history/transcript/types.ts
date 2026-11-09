import type { LiveReadable } from "../../../core/state/live-types";
import type { FeatureContext } from "../../../app/types";
import type { JsonValue } from "../../../core/json";
import type { HttpFailure } from "../../../core/protocol/http";
import type {
  Decimal,
  Digest,
  Identifier,
  JsonObject,
  Preparation,
} from "../../../core/protocol/types";
import type { ReadState } from "../../../core/state/read-slot";
import type { ProjectionResult, FormatSelection } from "../formats";

export interface EventRef {
  readonly session_id: Identifier;
  readonly sequence: Decimal;
}
export interface BlobRef {
  readonly digest: Digest;
  readonly size_bytes: Decimal;
}
export type PayloadPart =
  | { readonly kind: "payload" }
  | { readonly kind: "searchable_text" }
  | { readonly kind: "attachment"; readonly index: Decimal };
export type ScopeRef =
  | { readonly kind: "workspace" }
  | { readonly kind: "project" | "milestone" | "ticket" | "resource"; readonly id: Identifier };
export interface SessionRecord {
  readonly workspace_id: Identifier;
  readonly session_id: Identifier;
  readonly title: string;
  readonly actor_id: Identifier;
  readonly run_id: Identifier | null;
  readonly parent_event: EventRef | null;
  readonly scopes: readonly ScopeRef[];
  readonly archived: boolean;
  readonly created_at_unix_ms: string | null;
  readonly last_event_at_unix_ms: string | null;
}
export interface EventRecord {
  readonly event_ref: EventRef;
  readonly identity_hash: Digest;
  readonly actor_id: Identifier;
  readonly run_id: Identifier | null;
  readonly event: {
    readonly client_id: string;
    readonly role: string;
    readonly kind: string;
    readonly phase: string;
    readonly correlation: string | null;
    readonly provenance: JsonValue;
    readonly payload: { readonly kind: "blob"; readonly blob: BlobRef };
    readonly searchable_text: { readonly kind: "blob"; readonly blob: BlobRef } | null;
    readonly resource_versions: readonly {
      readonly resource_id: Identifier;
      readonly revision: Decimal;
    }[];
    readonly attachments: readonly BlobRef[];
  };
}
export interface HistoryCapture {
  readonly workspace_id: Identifier;
  readonly head: Digest | null;
  readonly sequence: Decimal;
  readonly sessions: readonly { readonly session_id: Identifier; readonly through: Decimal }[];
}
export interface Captured<T> {
  readonly data: T;
  readonly capture: HistoryCapture;
}
export interface DirectoryQuery {
  readonly order: "session_id" | "created_at" | "last_event_at";
  readonly includeArchived: boolean;
  readonly runId: string;
}
export interface DirectoryPage {
  readonly items: readonly SessionRecord[];
  readonly next_offset: Decimal;
  readonly has_more: boolean;
}
export interface SessionDetail {
  readonly session: SessionRecord;
  readonly through: Decimal;
}
export type WindowDirection = "before" | "after" | "around";
export interface EventWindow {
  readonly session_id: Identifier;
  readonly through: Decimal;
  readonly items: readonly EventRecord[];
  readonly has_more: boolean;
  readonly next_anchor: Decimal;
  readonly omitted_for_budget: Decimal;
}
export interface PayloadChunk {
  readonly blob: BlobRef;
  readonly offset: Decimal;
  readonly bytes_base64: string;
  readonly next_offset: Decimal;
  readonly total_bytes: Decimal;
  readonly has_more: boolean;
}
export interface PayloadItem {
  readonly event_ref: EventRef;
  readonly payload: PayloadChunk;
}
export interface PayloadBytes {
  readonly event: EventRef;
  readonly part: PayloadPart;
  readonly blob: BlobRef;
  readonly bytes: Uint8Array;
  readonly nextOffset: Decimal;
  readonly complete: boolean;
  readonly verified: boolean;
}
export interface HistoryScope {
  readonly connectionId: Identifier;
  readonly generation: Decimal;
  readonly workspaceId: Identifier;
}
export type CaptureChoice =
  { readonly kind: "current" } | { readonly kind: "pinned"; readonly head: Digest | null };
export interface SessionTarget {
  readonly sessionId: Identifier;
  readonly capture: CaptureChoice;
  readonly sequence?: Decimal;
  readonly generation?: Decimal;
}
export interface HistoryDraft {
  readonly context: FeatureContext;
  readonly kind: "create" | "archive" | "import";
  readonly sessionId: string;
  readonly title: string;
  readonly source: string;
  readonly preparation: Preparation | null;
  readonly pending: boolean;
  readonly issue: string | null;
  /** Explicitly imported current-format input batches; no provider conversion or cross-batch transaction. */
  readonly batches: readonly (readonly JsonObject[])[];
  readonly batchIndex: number;
}
export type TransferState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "loading";
      readonly received: number;
      readonly total: number;
      readonly label: string;
      readonly origin: string;
    }
  | {
      readonly kind: "complete";
      readonly blob: Blob;
      readonly digest: Digest;
      readonly label: string;
      readonly origin: string;
    }
  | { readonly kind: "failed"; readonly message: string };
export interface HistoryState {
  readonly scope: HistoryScope | null;
  readonly historicalGeneration: boolean;
  readonly query: DirectoryQuery;
  readonly directory: ReadState<Captured<DirectoryPage>>;
  readonly session: ReadState<Captured<SessionDetail>>;
  readonly window: ReadState<Captured<EventWindow>>;
  readonly payloadBatch: ReadState<Captured<readonly PayloadItem[]>>;
  readonly payloads: ReadonlyMap<string, PayloadBytes>;
  readonly projections: ReadonlyMap<string, ProjectionResult>;
  readonly projecting: boolean;
  readonly payloadFailure: HttpFailure | null;
  readonly expanding: boolean;
  readonly selectedPart: string | null;
  /** Follow new appends only when the reader is at the loaded end. */
  readonly followLatest: boolean;
  readonly loadingMore: boolean;
  readonly readingEvents: boolean;
  readonly format: FormatSelection;
  readonly draft: HistoryDraft | null;
  readonly transfer: TransferState;
  readonly unexpected: { readonly error: unknown } | null;
}
/** Launch-owned; selection aborts only browser reads. Drafts retain their original context. */
export interface HistoryController extends LiveReadable {
  readonly get: () => HistoryState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly select: (context: FeatureContext) => void;
  readonly directory: (query: DirectoryQuery, next?: boolean) => void;
  readonly open: (sessionId: Identifier) => void;
  readonly window: (direction: WindowDirection, anchor: Decimal) => void;
  /** Keep the displayed window fixed while current metadata continues to update. No writes or reads. */
  readonly pauseFollowing: () => void;
  readonly setFollowing: (follow: boolean) => void;
  /** Append chronological pages; all drains the captured bound and is cancellable. */
  readonly loadMore: (all?: boolean) => void;
  readonly cancelLoadMore: () => void;
  readonly refresh: () => void;
  readonly expand: (event: EventRecord, part: PayloadPart, complete?: boolean) => void;
  readonly cancelExpansion: () => void;
  readonly setFormat: (format: FormatSelection) => void;
  readonly newDraft: (
    context: FeatureContext,
    kind: HistoryDraft["kind"],
    sessionId?: string,
  ) => void;
  readonly editDraft: (
    patch: Partial<Pick<HistoryDraft, "sessionId" | "title" | "source">>,
  ) => void;
  readonly discardDraft: () => void;
  readonly reviewDraft: () => Promise<void>;
  readonly nextImportBatch: () => void;
  readonly download: (event: EventRecord, part: PayloadPart) => void;
  readonly cancelDownload: () => void;
  readonly dispose: () => void;
}

export type HistoryNavigationTarget = Readonly<HistoryScope> &
  (
    | { readonly kind: "run"; readonly runId: Identifier }
    | {
        readonly kind: "resource-version";
        readonly resourceId: Identifier;
        readonly contentVersion: Decimal;
      }
    | { readonly kind: "scope"; readonly scope: ScopeRef }
  );
