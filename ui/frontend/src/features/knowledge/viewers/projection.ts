import { DEFAULT_JSON_LIMITS, parseJsonBytes, type JsonValue } from "../../../core/json";
import { VIEWER_LIMITS as L, ViewerProblem } from "./limits";
import type { ContentSource } from "../../../content/types";
import type { Comparison, JsonChange, JsonRow, JsonTree, TextDiffRow } from "./types";
export function complete(source: ContentSource) {
  if (source.completeness !== "complete")
    throw new ViewerProblem(
      "unsupported",
      "This source is partial. Rich structured preview requires the complete verified publication; Raw and bounded source remain available.",
    );
}
export function jsonValue(bytes: Uint8Array): JsonValue {
  const result = parseJsonBytes(bytes, DEFAULT_JSON_LIMITS);
  if (!result.ok)
    throw new ViewerProblem(
      ["byte_limit", "depth_limit", "node_limit", "string_limit"].includes(result.error.code)
        ? "budget"
        : "malformed",
      result.error.message,
    );
  return result.value.value;
}
const escaped = (token: string) => token.replaceAll("~", "~0").replaceAll("/", "~1");
export function pointerChild(parent: string, token: string): string {
  return `${parent}/${escaped(token)}`;
}
function clipped(text: string): string {
  let end = Math.min(text.length, 1024);
  if (
    end > 0 &&
    end < text.length &&
    text.charCodeAt(end - 1) >= 0xd800 &&
    text.charCodeAt(end - 1) <= 0xdbff
  )
    end--;
  return text.slice(0, end) + (end < text.length ? "…" : "");
}
export function preview(value: JsonValue): string {
  switch (value.kind) {
    case "null":
      return "null";
    case "boolean":
      return String(value.value);
    case "number":
      return clipped(value.lexeme);
    case "string":
      return `“${clipped(value.value)}”`;
    case "array":
      return `[${value.items.length} items]`;
    case "object":
      return `{${value.fields.length} fields}`;
  }
}
export function projectJson(
  bytes: Uint8Array,
  expanded: readonly string[],
  offset: number,
): JsonTree {
  return projectJsonValue(jsonValue(bytes), expanded, offset);
}
export function projectJsonValue(
  value: JsonValue,
  expanded: readonly string[],
  offset: number,
): JsonTree {
  const open = new Set(expanded),
    rows: JsonRow[] = [];
  let count = 0;
  function walk(v: JsonValue, pointer: string, depth: number, label: string) {
    const n = v.kind === "array" ? v.items.length : v.kind === "object" ? v.fields.length : 0;
    const admissible = depth < 16 && new TextEncoder().encode(pointer).length <= 512;
    const isOpen =
      n > 0 && admissible && (depth < 2 ? !open.has(`!${pointer}`) : open.has(pointer));
    if (count >= offset && rows.length < L.jsonRows)
      rows.push({
        pointer: admissible ? pointer : null,
        depth,
        label: clipped(label),
        type: v.kind,
        preview: preview(v),
        children: n,
        expanded: isOpen,
      });
    count++;
    if (!isOpen) return;
    if (v.kind === "array")
      v.items.forEach((item, index) =>
        walk(item, pointerChild(pointer, String(index)), depth + 1, String(index)),
      );
    if (v.kind === "object")
      v.fields.forEach((field) =>
        walk(field.value, pointerChild(pointer, field.name), depth + 1, field.name),
      );
  }
  walk(value, "", 0, "(root)");
  return { kind: "json", rows, totalRows: count, offset };
}
function decodeText(bytes: Uint8Array): string {
  if (bytes.length > L.textBytes)
    throw new ViewerProblem(
      "budget",
      "Text comparison is limited to 256KiB per side. Use the independently pinned Source/Raw panes and verified downloads for larger files.",
    );
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof TypeError)
      throw new ViewerProblem("malformed", "Text comparison requires valid UTF-8 on both sides.");
    throw error;
  }
}
function textDiff(left: Uint8Array, right: Uint8Array): Comparison {
  const a = decodeText(left).split("\n"),
    b = decodeText(right).split("\n"),
    cells = (a.length + 1) * (b.length + 1);
  if (a.length > L.textLines || b.length > L.textLines || cells > L.comparisonCells)
    throw new ViewerProblem(
      "budget",
      "Text comparison exceeds 10000 lines or one million comparison cells. Both pinned sources remain available side by side.",
    );
  const cols = b.length + 1,
    table = new Uint32Array(cells);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i * cols + j] =
        a[i] === b[j]
          ? 1 + table[(i + 1) * cols + j + 1]!
          : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
  const rows: TextDiffRow[] = [];
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      rows.push({ kind: "equal", left: i + 1, right: j + 1, text: a[i]! });
      i++;
      j++;
    } else if (
      i < a.length &&
      (j === b.length || table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!)
    ) {
      rows.push({ kind: "removed", left: i + 1, right: null, text: a[i]! });
      i++;
    } else {
      rows.push({ kind: "added", left: null, right: j + 1, text: b[j]! });
      j++;
    }
  }
  return { kind: "text", rows };
}
function jsonDiff(left: Uint8Array, right: Uint8Array): Comparison {
  const a = jsonValue(left),
    b = jsonValue(right),
    changes: JsonChange[] = [];
  function add(pointer: string, before: JsonValue | undefined, after: JsonValue | undefined) {
    if (new TextEncoder().encode(pointer).length > 512 || pointer.split("/").length > 17)
      throw new ViewerProblem(
        "budget",
        "A changed JSON path exceeds the bounded 16-token/512-byte pointer limit. Exact sources remain available.",
      );
    if (changes.length >= L.changes)
      throw new ViewerProblem(
        "budget",
        "JSON comparison exceeds 2000 changed paths. Exact sources remain available.",
      );
    changes.push({
      pointer,
      kind: before === undefined ? "added" : after === undefined ? "removed" : "changed",
      before: before === undefined ? null : preview(before),
      after: after === undefined ? null : preview(after),
    });
  }
  function walk(x: JsonValue, y: JsonValue, path: string) {
    if (x.kind === "object" && y.kind === "object") {
      const ys = new Map(y.fields.map((f) => [f.name, f.value]));
      for (const field of x.fields) {
        const v = ys.get(field.name);
        if (v === undefined) add(pointerChild(path, field.name), field.value, undefined);
        else {
          walk(field.value, v, pointerChild(path, field.name));
          ys.delete(field.name);
        }
      }
      for (const [key, v] of ys) add(pointerChild(path, key), undefined, v);
      return;
    }
    if (x.kind === "array" && y.kind === "array") {
      for (let i = 0; i < Math.max(x.items.length, y.items.length); i++) {
        const av = x.items[i],
          bv = y.items[i],
          p = pointerChild(path, String(i));
        if (av === undefined || bv === undefined) add(p, av, bv);
        else walk(av, bv, p);
      }
      return;
    }
    const equal =
      x.kind === y.kind &&
      (x.kind === "null" ||
        (x.kind === "number" && y.kind === "number" && x.lexeme === y.lexeme) ||
        (x.kind === "string" && y.kind === "string" && x.value === y.value) ||
        (x.kind === "boolean" && y.kind === "boolean" && x.value === y.value));
    if (!equal) add(path, x, y);
  }
  walk(a, b, "");
  return {
    kind: "json-diff",
    changes,
    formattingOnly: changes.length === 0 && !equalBytes(left, right),
  };
}
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
export function compareSources(
  left: ContentSource,
  right: ContentSource,
  format: "text" | "json" | "binary" | "images",
): Comparison {
  complete(left);
  complete(right);
  if (format === "binary" || format === "images")
    return { kind: format, equal: equalBytes(left.bytes, right.bytes) };
  return format === "text" ? textDiff(left.bytes, right.bytes) : jsonDiff(left.bytes, right.bytes);
}
