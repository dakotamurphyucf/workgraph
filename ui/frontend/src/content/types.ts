import type { JsonDocument, JsonLimits, JsonResult } from "../core/json";

export type CodeLanguage =
  | "ocaml"
  | "typescript"
  | "javascript"
  | "json"
  | "bash"
  | "python"
  | "markdown"
  | "yaml"
  | "toml"
  | "html"
  | "css"
  | "diff";
export type RenderOverride = "auto" | "plain" | CodeLanguage;
export type ContentMode = "rendered" | "source" | "raw";
export interface ContentHints {
  /** Caller-validated metadata only. Payload-shaped guesses are not schema proof. */
  readonly language?: string;
  readonly mime?: string;
  readonly filename?: string;
  readonly intent?: "prose" | "code" | "unknown";
}
export interface ContentSource {
  /** Captured connection generation + immutable content/event identity; not a claim of verified digest. */
  readonly key: string;
  readonly label: string;
  /** Immutable caller-owned capture. A worker receives its own copy, never detaches these bytes. */
  readonly bytes: Uint8Array;
  readonly completeness: "complete" | "partial";
  readonly hints: ContentHints;
}
export interface FormatChoice {
  readonly kind: "markdown" | "code" | "plain" | "binary";
  readonly language: CodeLanguage | null;
  readonly via: "override" | "language" | "mime" | "filename" | "intent" | "default";
}
export type TokenTone =
  | "plain"
  | "keyword"
  | "string"
  | "number"
  | "comment"
  | "title"
  | "meta"
  | "addition"
  | "deletion";
export type HighlightNode =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "token";
      readonly tone: TokenTone;
      readonly children: readonly HighlightNode[];
    };
export type RenderTag =
  | "p"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "strong"
  | "em"
  | "del"
  | "blockquote"
  | "ul"
  | "ol"
  | "li"
  | "table"
  | "thead"
  | "tbody"
  | "tr"
  | "th"
  | "td"
  | "br"
  | "hr"
  | "code";
/** Data-only descriptors allow a later authorized typed Workgraph resolver; no URL becomes active here. */
export interface PassiveReference {
  /** Exact lexer-consumed Markdown token; target/title are parsed presentation fields. */
  readonly raw: string;
  readonly target: string;
  readonly title: string | null;
}
export type RenderNode =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "element";
      readonly tag: RenderTag;
      readonly children: readonly RenderNode[];
      readonly align: "left" | "right" | "center" | null;
      readonly start: number | null;
    }
  | {
      readonly kind: "code";
      readonly text: string;
      readonly language: CodeLanguage | null;
      readonly tokens: readonly HighlightNode[];
    }
  | {
      readonly kind: "reference";
      readonly image: boolean;
      readonly reference: PassiveReference;
      readonly children: readonly RenderNode[];
    };
export interface SourceLine {
  readonly number: number;
  readonly text: string;
  readonly omittedCharacters: number;
}
export interface TextWindow {
  readonly startLine: number;
  readonly totalLines: number;
  readonly lines: readonly SourceLine[];
}
export interface RenderRequest {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly hints: ContentHints;
  readonly override: RenderOverride;
  readonly mode: ContentMode;
  readonly startLine: number;
  readonly rawOffset: number;
}
export interface JsonDecodeRequest {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly limits?: JsonLimits;
}
export interface ContentPreview {
  readonly key: string;
  readonly byteLength: number;
  readonly format: FormatChoice;
  readonly status: "rich" | "source" | "binary" | "limited";
  readonly nodes: readonly RenderNode[];
  readonly window: TextWindow | null;
  readonly rawHex: string;
  readonly rawOffset: number;
  readonly rawLength: number;
  /** Exact decoded source, including BOM/CRLF, only within the copy budget. Never a reformatted projection. */
  readonly copyText: string | null;
  readonly diagnostics: readonly string[];
}
export type ContentJob =
  | { readonly kind: "render"; readonly request: RenderRequest }
  | { readonly kind: "json"; readonly request: JsonDecodeRequest };
export type ContentJobResult =
  | { readonly kind: "render"; readonly preview: ContentPreview }
  | { readonly kind: "json"; readonly document: JsonResult<JsonDocument> };
export type WorkerStage = "decode" | "markdown" | "highlight" | "projection";
export interface WorkerRequest {
  readonly protocol: 1;
  readonly jobId: string;
  readonly key: string;
  readonly job: ContentJob;
}
export type WorkerMessage =
  | {
      readonly protocol: 1;
      readonly jobId: string;
      readonly key: string;
      readonly kind: "stage";
      readonly stage: WorkerStage;
    }
  | {
      readonly protocol: 1;
      readonly jobId: string;
      readonly key: string;
      readonly kind: "complete";
      readonly result: ContentJobResult;
    }
  | {
      readonly protocol: 1;
      readonly jobId: string;
      readonly key: string;
      readonly kind: "failed";
      readonly failure: "budget" | "parser";
      readonly message: string;
    };
export type WorkOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly kind: "cancelled" | "timeout" | "busy" | "input" | "worker" | "protocol";
      readonly message: string;
    };
export interface ContentWorkerClient {
  /** Waiters retain the caller's immutable bytes, without copying them until
   * capacity is available. Abort cancels admission; no daemon action is retried. */
  readonly render: (
    request: RenderRequest,
    signal?: AbortSignal,
    options?: { readonly waitForCapacity?: boolean },
  ) => Promise<WorkOutcome<ContentPreview>>;
  readonly decodeJson: (
    request: JsonDecodeRequest,
    signal?: AbortSignal,
  ) => Promise<WorkOutcome<JsonResult<JsonDocument>>>;
  /** Disposes active/queued waiters and owned workers. Does not cancel daemon operations. */
  readonly dispose: () => void;
}
export interface ContentViewerProps {
  /** Compact reading chrome retains direct mode switches; language/copy/download stay in named options.
   * This changes presentation only, never bytes, parsing, admission or source ownership. */
  /** Reading chrome tucks source/display controls into a disclosure above the content. */
  /** Message chrome omits duplicate source controls during successful rendering.
   * Its containing event must retain original source/download access. Errors still expose controls. */
  readonly chrome?: "full" | "compact" | "reading" | "message";
  readonly source: ContentSource;
  readonly client?: ContentWorkerClient;
}
