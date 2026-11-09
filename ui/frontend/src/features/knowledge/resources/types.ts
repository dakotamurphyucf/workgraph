import type { LiveReadable } from "../../../core/state/live-types";
import type { ReactNode } from "react";
import type { FeatureContext, WriterSelection } from "../../../app/types";
import type { ContentSource } from "../../../content/types";
import type { OperationController } from "../../../core/state/operations";
import type { HttpClient, HttpFailure } from "../../../core/protocol/http";
import type {
  ConnectionProfile,
  Decimal,
  Digest,
  Identifier,
  JsonObject,
  ReadResponse,
} from "../../../core/protocol/types";
import type { ReadState } from "../../../core/state/read-slot";

/** A native content revision; never resource metadata revision. */
export interface ResourceVersion {
  readonly revision: Decimal;
  readonly digest: Digest;
  readonly size_bytes: Decimal | null;
  readonly actor_id: Identifier;
  readonly timestamp: string;
  readonly filename: string;
  readonly mime_type: string;
}
export type ResourceTarget =
  | { readonly kind: "workspace" }
  | { readonly kind: "project"; readonly id: Identifier }
  | { readonly kind: "milestone"; readonly id: Identifier }
  | { readonly kind: "ticket"; readonly id: Identifier }
  | { readonly kind: "resource"; readonly id: Identifier };
export interface ResourceMetadata {
  /** Prose/targets may be prefix-clipped; inspect capture.partial and raw budget. */
  readonly title: string;
  readonly description: string;
  readonly filename: string;
  readonly mime_type: string;
  readonly archived: boolean;
  readonly targets: readonly ResourceTarget[];
}
export interface ResourceRecord {
  readonly resource_id: Identifier;
  readonly revision: Decimal;
  readonly metadata: ResourceMetadata;
  readonly current_version: ResourceVersion;
  readonly version_count: Decimal;
  readonly raw: JsonObject;
}
export interface ResourcePage<T> {
  readonly items: readonly T[];
  readonly offset: Decimal;
  readonly next_offset: Decimal | null;
  readonly remaining: Decimal;
}
export interface ResourceScope {
  readonly connection: ConnectionProfile;
  readonly workspaceId: Identifier;
}
export interface ResourceSelection extends ResourceScope {
  readonly resourceId: Identifier;
  /** Null follows the latest verified publication. An explicit content pin
   * freezes the bytes only; current resource metadata continues to refresh. */
  readonly content: {
    readonly version: Decimal;
    readonly expectedDigest: Digest | null;
  } | null;
}
export interface ResourceCapture<T> {
  readonly scope: ResourceScope;
  readonly value: T;
  readonly response: ReadResponse;
  readonly queryRevision: Decimal;
  readonly partial: boolean;
}
export interface ResourcePin extends ResourceScope {
  readonly resourceId: Identifier;
  readonly version: Decimal;
  readonly digest: Digest;
  readonly sizeBytes: Decimal;
  readonly filename: string;
  readonly mimeType: string;
}
export interface ResourceChunk {
  readonly resource_id: Identifier;
  readonly version: Decimal;
  readonly digest: Digest;
  readonly size_bytes: Decimal;
  readonly offset: Decimal;
  readonly data_base64: string;
  readonly chunk_digest: Digest;
  readonly next_offset: Decimal | null;
  readonly eof: boolean;
}
export interface ResourceTextRange extends Omit<ResourceChunk, "data_base64"> {
  readonly text: string;
}
export type ResourceContent =
  | { readonly kind: "idle" }
  | {
      readonly kind: "loading";
      readonly selection: ResourceSelection;
      readonly receivedBytes: number;
      readonly totalBytes: number | null;
    }
  | {
      readonly kind: "verified";
      readonly pin: ResourcePin;
      readonly blob: Blob;
      readonly source: ContentSource;
    }
  | {
      readonly kind: "failed";
      readonly selection: ResourceSelection;
      readonly message: string;
      readonly failure: HttpFailure | null;
    };
export interface ResourceDraftCapture extends ResourceScope {
  readonly writer: WriterSelection;
  readonly resourceId: Identifier;
  readonly expectedRevision: Decimal;
}
export interface ResourcesState {
  readonly scope: ResourceScope | null;
  readonly directory: ReadState<ResourceCapture<ResourcePage<ResourceRecord>>>;
  /** Actual preceding offsets for the current directory capture. */
  readonly directoryPreviousOffsets: readonly Decimal[];
  readonly metadata: ReadState<ResourceCapture<ResourceRecord>>;
  readonly versions: ReadState<ResourceCapture<ResourcePage<ResourceVersion>>>;
  readonly versionPreviousOffsets: readonly Decimal[];
  readonly content: ResourceContent;
  /** A failed passive transfer retains the last verified bytes. */
  readonly updateIssue: string | null;
  readonly includeArchived: boolean;
  readonly directoryTarget: ResourceTarget | null;
  readonly unexpected: { readonly error: unknown } | null;
}
/** Presentation association only; caller retains exact immutable bytes and pin. */
export interface ResourceContentContext {
  readonly pin: ResourcePin;
  readonly source: ContentSource;
  readonly blob: Blob;
}
export interface ResourcesFeatureProps {
  readonly context: FeatureContext;
  readonly controller: ResourcesController;
  readonly operations: OperationController;
  readonly renderContent?: (content: ResourceContentContext) => ReactNode;
}
export interface ResourceDirectoryOptions {
  readonly includeArchived?: boolean;
  readonly offset?: Decimal;
  readonly atRevision?: Decimal;
  readonly target?: ResourceTarget;
}
export interface ResourcesController extends LiveReadable {
  readonly get: () => ResourcesState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly directory: (scope: ResourceScope, options?: ResourceDirectoryOptions) => Promise<void>;
  readonly nextDirectory: () => Promise<void>;
  readonly previousDirectory: () => Promise<void>;
  /** An explicit version/digest matching already verified content retains that
   * exact viewer/Blob without another transfer. Endpoint (including socket and
   * generation), workspace, resource and content pin must all match. Unpinned
   * latest navigation and any changed pin retain ordinary fresh-read semantics. */
  readonly select: (selection: ResourceSelection) => Promise<void>;
  readonly refreshMetadata: () => Promise<void>;
  readonly versions: (offset?: Decimal) => Promise<void>;
  readonly nextVersions: () => Promise<void>;
  readonly previousVersions: () => Promise<void>;
  readonly cancelDownload: () => void;
  readonly dispose: () => void;
}
export interface ResourcesControllerOptions {
  readonly http: HttpClient;
  readonly operations: OperationController;
}
