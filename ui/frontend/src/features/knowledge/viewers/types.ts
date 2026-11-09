import type { ContentSource } from "../../../content/types";
import type { HttpClient } from "../../../core/protocol/http";
import type { Decimal } from "../../../core/protocol/types";
import type { ResourceContentContext, ResourcePin } from "../resources/types";

/** JSON pointers are escaped RFC6901 paths, never JavaScript property expressions. */
export interface JsonRow {
  readonly pointer: string | null;
  readonly depth: number;
  readonly label: string;
  readonly type: "null" | "boolean" | "string" | "number" | "array" | "object";
  readonly preview: string;
  readonly children: number;
  readonly expanded: boolean;
}
export interface JsonTree {
  readonly kind: "json";
  readonly rows: readonly JsonRow[];
  readonly totalRows: number;
  readonly offset: number;
}
export interface RasterMetadata {
  readonly format: "png" | "jpeg" | "gif" | "webp";
  readonly width: number;
  readonly height: number;
  readonly orientation: number;
  readonly animated: boolean;
}
/** The receiver owns and closes this single static poster. No image URL is created. */
export interface RasterPreview {
  readonly kind: "raster";
  readonly metadata: RasterMetadata;
  readonly bitmap: ImageBitmap;
}
export interface TextDiffRow {
  readonly kind: "equal" | "removed" | "added";
  readonly left: number | null;
  readonly right: number | null;
  readonly text: string;
}
export interface JsonChange {
  readonly pointer: string;
  readonly kind: "added" | "removed" | "changed";
  readonly before: string | null;
  readonly after: string | null;
}
export type Comparison =
  | { readonly kind: "binary"; readonly equal: boolean }
  | { readonly kind: "images"; readonly equal: boolean }
  | { readonly kind: "text"; readonly rows: readonly TextDiffRow[] }
  | {
      readonly kind: "json-diff";
      readonly changes: readonly JsonChange[];
      readonly formattingOnly: boolean;
    };
export type ViewerFailureKind =
  "malformed" | "unsupported" | "budget" | "cancelled" | "timeout" | "busy" | "worker" | "protocol";
export type ViewerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: ViewerFailureKind; readonly message: string };
export type ViewerJob =
  | {
      readonly kind: "json";
      readonly source: ContentSource;
      readonly expanded: readonly string[];
      readonly offset: number;
    }
  | { readonly kind: "raster"; readonly source: ContentSource }
  | {
      readonly kind: "compare";
      readonly left: ContentSource;
      readonly right: ContentSource;
      readonly format: "text" | "json" | "binary" | "images";
    };
export type ViewerValue = JsonTree | RasterPreview | Comparison;
export interface ViewerWorker {
  readonly json: (
    source: ContentSource,
    expanded: readonly string[],
    offset: number,
    signal?: AbortSignal,
  ) => Promise<ViewerResult<JsonTree>>;
  readonly raster: (
    source: ContentSource,
    signal?: AbortSignal,
  ) => Promise<ViewerResult<RasterPreview>>;
  readonly compare: (
    left: ContentSource,
    right: ContentSource,
    format: "text" | "json" | "binary" | "images",
    signal?: AbortSignal,
  ) => Promise<ViewerResult<Comparison>>;
  readonly dispose: () => void;
}
export type ComparisonState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly owner: string; readonly version: Decimal }
  | {
      readonly kind: "ready";
      readonly owner: string;
      readonly content: ResourceContentContext;
    }
  | { readonly kind: "failed"; readonly owner: string; readonly message: string };
export interface RichViewerState {
  readonly comparison: ComparisonState;
  readonly unexpected: { readonly owner: string; readonly error: unknown } | null;
}
/** One launch-owned comparison download. Components own their abortable render jobs. */
export interface RichViewerController {
  readonly worker: ViewerWorker;
  readonly get: () => RichViewerState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly compareVersion: (left: ResourcePin, version: Decimal) => Promise<void>;
  readonly clearComparison: () => void;
  readonly dispose: () => void;
}
export interface RichViewerOptions {
  readonly http: HttpClient;
}
export interface ResourceViewerProps {
  readonly http?: import("../../../core/protocol/http").HttpClient;
  readonly content: ResourceContentContext;
  readonly controller: RichViewerController;
}
