import type { JsonValue } from "../../../core/json";
import { pinCodec } from "./codecs";
import type {
  CellFormat,
  ContentPin,
  RendererChoice,
  RendererConfig,
  RendererSubject,
} from "./types";
import { boundedInteger, compareNumbers, integerNumber, selectPointer } from "./values";
export interface RegisteredRenderer {
  readonly pin: ContentPin;
  readonly renderer: RendererConfig;
}
export function samePin(a: ContentPin, b: ContentPin): boolean {
  return (
    a.resource_id === b.resource_id &&
    a.version === b.version &&
    a.digest === b.digest &&
    a.size_bytes === b.size_bytes
  );
}
function matches(renderer: RendererConfig, subject: RendererSubject): boolean {
  const match = renderer.match;
  return (
    match.entity === subject.entity &&
    (match.key_prefix === undefined ||
      (subject.key !== undefined && subject.key.startsWith(match.key_prefix))) &&
    (match.mime_type === undefined ||
      (subject.mimeType !== undefined &&
        subject.mimeType.trim().toLowerCase() === match.mime_type.toLowerCase())) &&
    (match.schema === undefined ||
      (subject.schema?.id === match.schema.id &&
        subject.schema.version === match.schema.version)) &&
    (match.root_type === undefined || subject.value.kind === match.root_type)
  );
}
/** Explicit immutable selection wins. Ambiguity is visible and never resolved by registration order. */
export function chooseRenderer(
  registered: readonly RegisteredRenderer[],
  subject: RendererSubject,
  explicit?: ContentPin,
): RendererChoice {
  if (explicit !== undefined) {
    const chosen = registered.find((entry) => samePin(entry.pin, explicit));
    return chosen === undefined
      ? { kind: "generic", reason: "explicit_unavailable", candidates: [] }
      : { kind: "renderer", ...chosen };
  }
  const candidates = registered.filter((entry) => matches(entry.renderer, subject));
  const single = candidates.length === 1 ? candidates[0] : undefined;
  return single === undefined
    ? {
        kind: "generic",
        reason: candidates.length === 0 ? "none" : "ambiguous",
        candidates: candidates.map((entry) => entry.pin),
      }
    : { kind: "renderer", ...single };
}
export type CellResult =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "enum";
      readonly text: string;
      readonly tone: "neutral" | "info" | "success" | "warning" | "danger";
    }
  | { readonly kind: "json"; readonly value: JsonValue }
  | { readonly kind: "pin"; readonly pin: ContentPin }
  | { readonly kind: "entity"; readonly entity: string; readonly id: string | null }
  | { readonly kind: "unavailable"; readonly message: string; readonly raw: JsonValue | null };
const unavailable = (raw: JsonValue | null, message: string): CellResult => ({
  kind: "unavailable",
  message,
  raw,
});
/** Fixed passive cell output only: no component, HTML, URL or executable format can be supplied. */
export function formatCell(value: JsonValue | undefined, format: CellFormat): CellResult {
  if (value === undefined)
    return unavailable(null, "Selected field is missing. Inspect Raw source.");
  const wrong = () =>
    unavailable(value, `Selected value cannot use ${format.type} format. Inspect Raw source.`);
  switch (format.type) {
    case "json":
      return { kind: "json", value };
    case "text":
    case "multiline":
      return value.kind === "string" ? { kind: "text", text: value.value } : wrong();
    case "boolean":
      return value.kind === "boolean"
        ? { kind: "text", text: value.value ? "true" : "false" }
        : wrong();
    case "number":
      return value.kind === "number" ? { kind: "text", text: value.lexeme } : wrong();
    case "bytes":
      return value.kind === "number" &&
        integerNumber(value.lexeme) &&
        compareNumbers(value.lexeme, "0") !== -1
        ? { kind: "text", text: `${value.lexeme} bytes` }
        : wrong();
    case "duration":
      return value.kind === "number"
        ? { kind: "text", text: `${value.lexeme} ${format.unit}` }
        : wrong();
    case "unix_ms": {
      const ms =
        value.kind === "number"
          ? boundedInteger(value.lexeme, -8_640_000_000_000_000, 8_640_000_000_000_000)
          : null;
      return ms === null ? wrong() : { kind: "text", text: new Date(ms).toISOString() };
    }
    case "enum": {
      const selected =
        value.kind === "string"
          ? format.values.find((entry) => entry.value === value.value)
          : undefined;
      return selected === undefined
        ? wrong()
        : { kind: "enum", text: selected.label, tone: selected.tone };
    }
    case "resource_pin": {
      const pin = pinCodec.decode(value);
      return pin.ok ? { kind: "pin", pin: pin.value } : wrong();
    }
    case "entity_ref": {
      if (value.kind !== "object") return wrong();
      const kind = value.fields.find((field) => field.name === "kind")?.value;
      const id = value.fields.find((field) => field.name === "id")?.value;
      if (kind?.kind === "string" && kind.value === "workspace" && value.fields.length === 1)
        return { kind: "entity", entity: "workspace", id: null };
      return value.fields.length === 2 &&
        kind?.kind === "string" &&
        ["project", "milestone", "ticket", "resource"].includes(kind.value) &&
        id?.kind === "string" &&
        /^[A-Za-z0-9_-]{1,96}(?![\s\S])/u.test(id.value)
        ? { kind: "entity", entity: kind.value, id: id.value }
        : wrong();
    }
  }
}
export function pointerCell(value: JsonValue, pointer: string, format: CellFormat): CellResult {
  const selected = selectPointer(value, pointer);
  return selected.kind === "invalid"
    ? unavailable(value, selected.message)
    : formatCell(selected.kind === "found" ? selected.value : undefined, format);
}
