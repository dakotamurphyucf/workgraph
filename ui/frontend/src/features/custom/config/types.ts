import type { JsonValue } from "../../../core/json";
import type {
  ConnectionProfile,
  Decimal,
  Digest,
  Identifier,
  Preparation,
} from "../../../core/protocol/types";
import type { HttpClient, HttpFailure } from "../../../core/protocol/http";
import type { ResourceScope } from "../../knowledge/resources/types";

/** Exact immutable content identity; version is never the resource metadata revision. */
export interface ContentPin {
  readonly resource_id: Identifier;
  readonly version: Decimal;
  readonly digest: Digest;
  readonly size_bytes: Decimal;
}
export type ConfigScope =
  | { readonly kind: "workspace" }
  | {
      readonly kind: "project" | "milestone" | "ticket";
      readonly id: Identifier;
    };
export type ConfigSource =
  "tickets" | "runs" | "attempts" | "sessions" | "resources" | "facts" | "discussions" | "activity";
export type JsonScalar = Exclude<JsonValue, { readonly kind: "object" | "array" }>;
export type CellFormat =
  | {
      readonly type:
        | "text"
        | "multiline"
        | "boolean"
        | "number"
        | "bytes"
        | "unix_ms"
        | "json"
        | "entity_ref"
        | "resource_pin";
    }
  | { readonly type: "duration"; readonly unit: "ns" | "us" | "ms" | "s" }
  | {
      readonly type: "enum";
      readonly values: readonly {
        readonly value: string;
        readonly label: string;
        readonly tone: "neutral" | "info" | "success" | "warning" | "danger";
      }[];
    };
export type ColumnSelector =
  | { readonly kind: "field"; readonly field: string }
  | { readonly kind: "pointer"; readonly pointer: string };
export interface Column {
  readonly id: Identifier;
  readonly selector: ColumnSelector;
  readonly label: string;
  readonly format: CellFormat;
  readonly width?: number | undefined;
}
export type ViewFilter =
  | { readonly pointer: string; readonly op: "equals"; readonly value: JsonScalar }
  | { readonly field: string; readonly op: "equals"; readonly value: JsonScalar }
  | { readonly field: string; readonly op: "one_of"; readonly values: readonly JsonScalar[] }
  | {
      readonly field: string;
      readonly op: "literal_prefix" | "contains_text";
      readonly value: string;
    };
export interface ViewConfig {
  readonly config_version: 1;
  readonly kind: "view";
  readonly id: Identifier;
  readonly title: string;
  readonly description?: string | undefined;
  readonly source: ConfigSource;
  readonly scope: ConfigScope;
  readonly filter_mode: "server" | "loaded";
  readonly filters: readonly ViewFilter[];
  readonly sort: readonly {
    readonly field: string;
    readonly direction: "asc" | "desc";
    readonly nulls: "last";
  }[];
  readonly group_by: string | null;
  readonly presentation: "list" | "board" | "table" | "timeline";
  readonly columns: readonly Column[];
  readonly renderer?: ContentPin | undefined;
}
export interface RenderField {
  readonly pointer: string;
  readonly label: string;
  readonly format: CellFormat;
}
export interface RendererConfig {
  readonly config_version: 1;
  readonly kind: "renderer";
  readonly id: Identifier;
  readonly title: string;
  readonly description?: string | undefined;
  readonly match: {
    readonly entity: "fact" | "resource" | "history";
    readonly key_prefix?: string | undefined;
    readonly mime_type?: string | undefined;
    readonly schema?: { readonly id: Identifier; readonly version: string } | undefined;
    readonly root_type?: JsonValue["kind"] | undefined;
  };
  readonly presentation:
    | { readonly type: "fields"; readonly fields: readonly RenderField[] }
    | { readonly type: "table"; readonly rows: string; readonly columns: readonly RenderField[] }
    | { readonly type: "markdown" | "json"; readonly pointer: string }
    | {
        readonly type: "code";
        readonly pointer: string;
        readonly language:
          | "plain"
          | "ocaml"
          | "typescript"
          | "javascript"
          | "json"
          | "bash"
          | "yaml"
          | "markdown"
          | "diff";
      };
  readonly fallback: "generic";
}
export interface CatalogConfig {
  readonly config_version: 1;
  readonly kind: "catalog";
  readonly entries: readonly {
    readonly kind: "view" | "renderer";
    readonly id: Identifier;
    readonly pin: ContentPin;
  }[];
}
/** The fourth closed shape intentionally has no kind field in the reviewed schema. */
export interface IndexConfig {
  readonly config_version: 1;
  readonly catalog: ContentPin;
}
export type ConfigDocument = ViewConfig | RendererConfig | CatalogConfig | IndexConfig;
export interface ConfigIssue {
  readonly path: readonly string[];
  readonly message: string;
}
/** An unsupported version is preserved, never coerced through the v1 editor. */
export type ConfigDecode =
  | { readonly kind: "valid"; readonly document: ConfigDocument; readonly raw: JsonValue }
  | { readonly kind: "unsupported_version"; readonly version: string; readonly raw: JsonValue }
  | { readonly kind: "invalid"; readonly issues: readonly ConfigIssue[]; readonly raw: JsonValue };
export type PointerSelection =
  | { readonly kind: "found"; readonly value: JsonValue }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly message: string };
export interface RendererSubject {
  readonly entity: RendererConfig["match"]["entity"];
  readonly key?: string;
  readonly mimeType?: string;
  /** Only an explicit decoded schema declaration, never inferred from content. */
  readonly schema?: { readonly id: Identifier; readonly version: string } | undefined;
  readonly value: JsonValue;
}
export type RendererChoice =
  | { readonly kind: "renderer"; readonly renderer: RendererConfig; readonly pin: ContentPin }
  | {
      readonly kind: "generic";
      readonly reason: "none" | "ambiguous" | "explicit_unavailable";
      readonly candidates: readonly ContentPin[];
    };
export interface VerifiedConfig {
  readonly scope: ResourceScope;
  readonly pin: ContentPin;
  readonly blob: Blob;
  readonly decoded: ConfigDecode | { readonly kind: "invalid_json"; readonly message: string };
}
export type ConfigReadResult =
  | { readonly ok: true; readonly capture: VerifiedConfig }
  | {
      readonly ok: false;
      readonly kind:
        "input" | "unavailable" | "integrity" | "cancelled" | "timeout" | "busy" | "protocol";
      readonly message: string;
      readonly failure: HttpFailure | null;
    };
/** One loader owns its transfer. Reading config never changes another viewer's selection. */
export interface ConfigStore {
  readonly read: (
    scope: ResourceScope,
    pin: ContentPin,
    signal?: AbortSignal,
  ) => Promise<ConfigReadResult>;
  readonly dispose: () => void;
}
export interface ConfigStoreOptions {
  readonly http: HttpClient;
}
/** Metadata guard and latest content pin are captured independently. Null proves a complete missing lookup. */
export type PublicationBase =
  | { readonly kind: "missing" }
  | {
      readonly kind: "existing";
      readonly scope: ResourceScope;
      readonly link:
        { readonly kind: "workspace" } | { readonly kind: "project"; readonly id: Identifier };
      readonly resourceId: Identifier;
      readonly metadataRevision: Decimal;
      readonly versionCount: Decimal;
      readonly content: ContentPin;
      readonly linked: boolean;
    };
export interface ConfigPublicationCapture {
  readonly connection: ConnectionProfile;
  readonly workspaceId: Identifier;
  readonly writer: { readonly actorId: Identifier; readonly runId: Identifier | null };
  readonly link:
    { readonly kind: "workspace" } | { readonly kind: "project"; readonly id: Identifier };
  readonly index: { readonly scope: ConfigScope; readonly expectedRevision: Decimal };
  readonly documentBase: PublicationBase;
  readonly catalogBase: PublicationBase;
  readonly catalog:
    { readonly kind: "new" } | { readonly kind: "existing"; readonly capture: VerifiedConfig };
}
export interface ConfigPublicationIntention {
  /** IDs generated exactly once before any asynchronous preparation. */
  readonly intentionId: Identifier;
  readonly documentResourceId: Identifier;
  readonly catalogResourceId: Identifier;
  readonly capture: ConfigPublicationCapture;
  readonly document: ViewConfig | RendererConfig;
}
export interface PreparedConfigPublication {
  readonly intention: ConfigPublicationIntention;
  readonly documentPin: ContentPin;
  readonly catalogPin: ContentPin;
  readonly preparation: Preparation;
}
