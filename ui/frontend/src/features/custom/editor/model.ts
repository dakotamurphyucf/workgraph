import { jsonField, type JsonValue } from "../../../core/json";
import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type { Decimal, Identifier } from "../../../core/protocol/types";
import type { ReadState } from "../../../core/state/read-slot";
import {
  CONFIG_LIMITS,
  configJson,
  type ConfigDecode,
  type ConfigScope,
  type RendererConfig,
  type ViewConfig,
} from "../config";
import { decodeConfigValue } from "../config/decode";
import type { CustomTarget, PersonalDocument, PersonalSavePlan, PersonalSettings } from "./types";
export const privateLimits = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxDepth: 64,
  maxNodes: 100000,
  maxStringBytes: 2 * 1024 * 1024,
});
export function id(value: string): Identifier {
  const result = d.identifier.decode(d.jsonString(value));
  if (!result.ok) throw new Error("Invalid application-owned identifier.");
  return result.value;
}
export const newId = (prefix: string) => id(`${prefix}-${crypto.randomUUID()}`);
export function counter(value: string): Decimal {
  const result = d.decimal.decode(d.jsonString(value));
  if (!result.ok) throw new Error("Invalid application-owned counter.");
  return result.value;
}
export function current<T>(state: ReadState<T>): T | undefined {
  return state.kind === "ready" ? state.value : "previous" in state ? state.previous : undefined;
}
export function targetKey(target: CustomTarget): string {
  return JSON.stringify([
    target.connection.id,
    target.connection.generation,
    target.connection.socket,
    target.workspaceId,
  ]);
}
export function defaultView(documentId: Identifier, scope: ConfigScope): ViewConfig {
  const source = scope.kind === "workspace" || scope.kind === "project" ? "tickets" : "facts";
  const field = source === "tickets" ? "title" : "key";
  return {
    config_version: 1,
    kind: "view",
    id: documentId,
    title: "Untitled view",
    source,
    scope,
    filter_mode: "server",
    filters: [],
    sort: [],
    group_by: null,
    presentation: "table",
    columns: [
      {
        id: id("main"),
        label: source === "tickets" ? "Title" : "Key",
        selector: { kind: "field", field },
        format: { type: "text" },
      },
    ],
  };
}
export function defaultRenderer(id: Identifier): RendererConfig {
  return {
    config_version: 1,
    kind: "renderer",
    id,
    title: "Untitled renderer",
    match: { entity: "fact", root_type: "object" },
    presentation: {
      type: "fields",
      fields: [{ pointer: "", label: "Value", format: { type: "json" } }],
    },
    fallback: "generic",
  };
}
export function editable(
  decoded: ConfigDecode | { readonly kind: "invalid_json"; readonly message: string } | null,
): ViewConfig | RendererConfig | null {
  return decoded?.kind === "valid" &&
    "kind" in decoded.document &&
    (decoded.document.kind === "view" || decoded.document.kind === "renderer")
    ? decoded.document
    : null;
}
export function sameDocuments(
  left: readonly PersonalDocument[],
  right: readonly PersonalDocument[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (document, index) =>
        document.id === right[index]?.id && document.source === right[index]?.source,
    )
  );
}
export function planSaved(plan: PersonalSavePlan, observed: PersonalSettings): boolean {
  return (
    BigInt(observed.revision) === BigInt(plan.expectedRevision) + 1n &&
    observed.selectedId === plan.selectedId &&
    sameDocuments(observed.documents, plan.documents)
  );
}
export function replaceDocument(
  documents: readonly PersonalDocument[],
  document: PersonalDocument,
): readonly PersonalDocument[] {
  const found = documents.some((item) => item.id === document.id);
  return Object.freeze(
    found
      ? documents.map((item) => (item.id === document.id ? document : item))
      : [...documents, document],
  );
}
export function decodeDocument(value: JsonValue): ConfigDecode {
  return decodeConfigValue(value);
}
export const portableCodec = c.refine(
  c.record({
    settings_version: c.refine(
      c.raw,
      (value) => value.kind === "number" && value.lexeme === "1",
      "settings_version1",
    ),
    documents: c.array(
      c.record({
        id: d.identifier,
        source: c.refine(
          c.text,
          (source) => new TextEncoder().encode(source).byteLength <= CONFIG_LIMITS.maxBytes,
          "source ≤64 KiB",
        ),
      }),
      25,
    ),
    selected_id: c.nullable(d.identifier),
  }),
  (value) =>
    new Set(value.documents.map((document) => document.id)).size === value.documents.length &&
    (value.selected_id === null ||
      value.documents.some((document) => document.id === value.selected_id)),
  "portable unique IDs and existing selection",
);
/** Export only this allowlist. Author-entered source may itself contain private data. */
export function portableJson(
  documents: readonly PersonalDocument[],
  selectedId: Identifier | null,
): JsonValue {
  return d.jsonObject([
    ["settings_version", d.jsonNumber("1")],
    [
      "documents",
      d.jsonArray(
        documents.map((document) =>
          d.jsonObject([
            ["id", d.jsonString(document.id)],
            ["source", d.jsonString(document.source)],
          ]),
        ),
      ),
    ],
    ["selected_id", selectedId === null ? d.jsonNull() : d.jsonString(selectedId)],
  ]);
}
export function documentId(decoded: ConfigDecode): Identifier | null {
  const result = d.identifier.decode(jsonField(decoded.raw, "id"));
  return result.ok ? result.value : null;
}
export const asJson = (document: ViewConfig | RendererConfig) => configJson(document);

/** An explicit payload declaration informs matching only; it is not schema validation. */
export function declaredSchema(value: JsonValue): {
  readonly schema: { readonly id: Identifier; readonly version: string } | undefined;
  readonly message: string | null;
} {
  const declaration = value.kind === "object" ? jsonField(value, "schema") : undefined;
  if (declaration === undefined) return { schema: undefined, message: null };
  const codec = c.record({
    id: d.identifier,
    version: c.refine(
      c.text,
      (text) => {
        const bytes = new TextEncoder().encode(text).byteLength;
        return bytes >= 1 && bytes <= 64;
      },
      "schema version 1..64 UTF-8 bytes",
    ),
  });
  const decoded = codec.decode(declaration);
  return decoded.ok
    ? { schema: decoded.value, message: null }
    : {
        schema: undefined,
        message:
          "The explicit schema declaration is invalid. Schema-based matching is unavailable; original source is unchanged.",
      };
}
