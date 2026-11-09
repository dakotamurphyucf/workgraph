import type { ContentSource } from "../../../content/types";
import { VIEWER_LIMITS as L } from "./limits";
import type {
  Comparison,
  JsonRow,
  RasterMetadata,
  ViewerFailureKind,
  ViewerJob,
  ViewerValue,
} from "./types";
export interface ViewerRequest {
  readonly protocol: 1;
  readonly id: string;
  readonly key: string;
  readonly job: ViewerJob;
}
export type ViewerReply = { readonly protocol: 1; readonly id: string; readonly key: string } & (
  | { readonly kind: "complete"; readonly value: ViewerValue }
  | { readonly kind: "failed"; readonly failure: ViewerFailureKind; readonly message: string }
  | { readonly kind: "unexpected"; readonly message: string }
  | {
      readonly kind: "stage";
      readonly stage: "parse" | "projection" | "diff" | "headers" | "decode";
    }
);
function object(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function keys(v: Record<string, unknown>, names: string) {
  return Object.keys(v).sort().join(",") === names.split(",").sort().join(",");
}
const integer = (v: unknown, max: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;
const string = (v: unknown, max = 4096): v is string => typeof v === "string" && v.length <= max;
function source(v: unknown): v is ContentSource {
  if (
    !object(v) ||
    !keys(v, "key,label,bytes,completeness,hints") ||
    !string(v.key) ||
    !string(v.label) ||
    !(v.bytes instanceof Uint8Array) ||
    v.bytes.length > 16 * 1024 * 1024 ||
    (v.completeness !== "complete" && v.completeness !== "partial") ||
    !object(v.hints)
  )
    return false;
  return Object.entries(v.hints).every(([key, value]) =>
    key === "language" || key === "mime" || key === "filename"
      ? string(value, 1024)
      : key === "intent" && (value === "prose" || value === "code" || value === "unknown"),
  );
}
export function readRequest(v: unknown): ViewerRequest | null {
  if (
    !object(v) ||
    !keys(v, "protocol,id,key,job") ||
    v.protocol !== 1 ||
    !string(v.id, 128) ||
    !string(v.key) ||
    !object(v.job)
  )
    return null;
  const j = v.job;
  if (j.kind === "raster" && keys(j, "kind,source") && source(j.source) && j.source.key === v.key)
    return { protocol: 1, id: v.id, key: v.key, job: { kind: "raster", source: j.source } };
  if (
    j.kind === "json" &&
    keys(j, "kind,source,expanded,offset") &&
    source(j.source) &&
    j.source.key === v.key &&
    Array.isArray(j.expanded) &&
    j.expanded.length <= L.expandedPointers &&
    j.expanded.every((p) => string(p, 1025)) &&
    integer(j.offset, 100000)
  )
    return {
      protocol: 1,
      id: v.id,
      key: v.key,
      job: { kind: "json", source: j.source, expanded: j.expanded, offset: j.offset },
    };
  if (
    j.kind === "compare" &&
    keys(j, "kind,left,right,format") &&
    source(j.left) &&
    source(j.right) &&
    JSON.stringify([j.left.key, j.right.key]) === v.key &&
    (j.format === "text" || j.format === "json" || j.format === "binary" || j.format === "images")
  )
    return {
      protocol: 1,
      id: v.id,
      key: v.key,
      job: { kind: "compare", left: j.left, right: j.right, format: j.format },
    };
  return null;
}
function row(v: unknown): v is JsonRow {
  return (
    object(v) &&
    keys(v, "pointer,depth,label,type,preview,children,expanded") &&
    (v.pointer === null || string(v.pointer, 512)) &&
    integer(v.depth, 64) &&
    string(v.label, 1025) &&
    ["null", "boolean", "string", "number", "array", "object"].includes(
      typeof v.type === "string" ? v.type : "",
    ) &&
    string(v.preview, 1100) &&
    integer(v.children, 100000) &&
    typeof v.expanded === "boolean"
  );
}
function metadata(v: unknown): v is RasterMetadata {
  return (
    object(v) &&
    keys(v, "format,width,height,orientation,animated") &&
    ["png", "jpeg", "gif", "webp"].includes(typeof v.format === "string" ? v.format : "") &&
    integer(v.width, L.imageEdge) &&
    v.width > 0 &&
    integer(v.height, L.imageEdge) &&
    v.height > 0 &&
    v.width * v.height <= L.imagePixels &&
    integer(v.orientation, 8) &&
    v.orientation >= 1 &&
    typeof v.animated === "boolean"
  );
}
function comparison(v: Record<string, unknown>): v is Comparison & Record<string, unknown> {
  let textCharacters = 0;
  if (
    (v.kind === "binary" || v.kind === "images") &&
    keys(v, "kind,equal") &&
    typeof v.equal === "boolean"
  )
    return true;
  if (
    v.kind === "text" &&
    keys(v, "kind,rows") &&
    Array.isArray(v.rows) &&
    v.rows.length <= L.textLines * 2 &&
    v.rows.every(
      (r) =>
        object(r) &&
        keys(r, "kind,left,right,text") &&
        ["equal", "removed", "added"].includes(typeof r.kind === "string" ? r.kind : "") &&
        (r.left === null || integer(r.left, L.textLines)) &&
        (r.right === null || integer(r.right, L.textLines)) &&
        string(r.text, L.textBytes) &&
        (textCharacters += r.text.length) <= L.textBytes * 2,
    )
  )
    return true;
  return (
    v.kind === "json-diff" &&
    keys(v, "kind,changes,formattingOnly") &&
    typeof v.formattingOnly === "boolean" &&
    Array.isArray(v.changes) &&
    v.changes.length <= L.changes &&
    v.changes.every(
      (r) =>
        object(r) &&
        keys(r, "pointer,kind,before,after") &&
        string(r.pointer, 512) &&
        ["added", "removed", "changed"].includes(typeof r.kind === "string" ? r.kind : "") &&
        (r.before === null || string(r.before, 1100)) &&
        (r.after === null || string(r.after, 1100)),
    )
  );
}
export function readReply(v: unknown): ViewerReply | null {
  if (!object(v) || v.protocol !== 1 || !string(v.id, 128) || !string(v.key)) return null;
  if (
    v.kind === "stage" &&
    keys(v, "protocol,id,key,kind,stage") &&
    (v.stage === "parse" ||
      v.stage === "projection" ||
      v.stage === "diff" ||
      v.stage === "headers" ||
      v.stage === "decode")
  )
    return { protocol: 1, id: v.id, key: v.key, kind: "stage", stage: v.stage };
  if (
    v.kind === "failed" &&
    keys(v, "protocol,id,key,kind,failure,message") &&
    [
      "malformed",
      "unsupported",
      "budget",
      "cancelled",
      "timeout",
      "busy",
      "worker",
      "protocol",
    ].includes(typeof v.failure === "string" ? v.failure : "") &&
    string(v.message)
  )
    return {
      protocol: 1,
      id: v.id,
      key: v.key,
      kind: "failed",
      failure: v.failure as ViewerFailureKind,
      message: v.message,
    };
  if (v.kind === "unexpected" && keys(v, "protocol,id,key,kind,message") && string(v.message))
    return { protocol: 1, id: v.id, key: v.key, kind: "unexpected", message: v.message };
  if (v.kind !== "complete" || !keys(v, "protocol,id,key,kind,value") || !object(v.value))
    return null;
  const r = v.value;
  if (
    r.kind === "json" &&
    keys(r, "kind,rows,totalRows,offset") &&
    Array.isArray(r.rows) &&
    r.rows.length <= L.jsonRows &&
    r.rows.every(row) &&
    integer(r.totalRows, 100000) &&
    integer(r.offset, 100000) &&
    r.offset + r.rows.length <= r.totalRows
  )
    return {
      protocol: 1,
      id: v.id,
      key: v.key,
      kind: "complete",
      value: { kind: "json", rows: r.rows, totalRows: r.totalRows, offset: r.offset },
    };
  if (
    r.kind === "raster" &&
    keys(r, "kind,metadata,bitmap") &&
    metadata(r.metadata) &&
    typeof ImageBitmap !== "undefined" &&
    r.bitmap instanceof ImageBitmap &&
    r.bitmap.width > 0 &&
    r.bitmap.height > 0 &&
    r.bitmap.width <= L.imageEdge &&
    r.bitmap.height <= L.imageEdge &&
    r.bitmap.width * r.bitmap.height <= L.imagePixels &&
    r.bitmap.width === (r.metadata.orientation >= 5 ? r.metadata.height : r.metadata.width) &&
    r.bitmap.height === (r.metadata.orientation >= 5 ? r.metadata.width : r.metadata.height)
  )
    return {
      protocol: 1,
      id: v.id,
      key: v.key,
      kind: "complete",
      value: { kind: "raster", metadata: r.metadata, bitmap: r.bitmap },
    };
  if (comparison(r)) return { protocol: 1, id: v.id, key: v.key, kind: "complete", value: r };
  return null;
}
/** Close even a malformed/stale image reply rather than retain transferred graphics memory. */
export function closeReply(v: unknown) {
  if (
    object(v) &&
    object(v.value) &&
    typeof ImageBitmap !== "undefined" &&
    v.value.bitmap instanceof ImageBitmap
  )
    v.value.bitmap.close();
}
