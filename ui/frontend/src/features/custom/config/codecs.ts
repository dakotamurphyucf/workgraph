import { jsonField } from "../../../core/json";
import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type {
  CatalogConfig,
  CellFormat,
  Column,
  ConfigDocument,
  ConfigScope,
  ConfigSource,
  ContentPin,
  IndexConfig,
  JsonScalar,
  RenderField,
  RendererConfig,
  ViewConfig,
  ViewFilter,
} from "./types";
import { boundedInteger, pointerTokens } from "./values";
const utf8 = new TextEncoder();
function text(maximum: number, minimum = 0) {
  return c.refine(
    c.text,
    (value) =>
      value.length >= minimum &&
      value.length <= maximum &&
      utf8.encode(value).byteLength <= maximum,
    `text of ${minimum}..${maximum} UTF-8 bytes`,
  );
}
function choices<const T extends string>(values: readonly T[]): c.Codec<T> {
  return {
    decode: (value, path = []) => {
      const found = c.text.decode(value, path);
      if (!found.ok) return found;
      const selected = values.find((item) => item === found.value);
      return selected === undefined
        ? c.mismatch(path, `one of ${values.join(", ")}`)
        : { ok: true, value: selected };
    },
  };
}
const version: c.Codec<1> = {
  decode: (value, path = []) =>
    value?.kind === "number" && boundedInteger(value.lexeme, 1, 1) === 1
      ? { ok: true, value: 1 }
      : c.mismatch(path, "config_version literal 1"),
};
export const pointerCodec = c.refine(
  c.text,
  (value) => pointerTokens(value) !== null,
  "bounded RFC6901 pointer",
);
export const pinCodec: c.Codec<ContentPin> = c.record({
  resource_id: d.identifier,
  version: d.positiveDecimal,
  digest: d.digest,
  size_bytes: c.refine(
    d.decimal,
    (value) => BigInt(value) <= 67_108_864n,
    "native resource size at most 64 MiB",
  ),
});
export const scopeCodec: c.Codec<ConfigScope> = c.tagged<ConfigScope>("kind", {
  workspace: c.record({ kind: c.literal("workspace") }),
  project: c.record({ kind: c.literal("project"), id: d.identifier }),
  milestone: c.record({ kind: c.literal("milestone"), id: d.identifier }),
  ticket: c.record({ kind: c.literal("ticket"), id: d.identifier }),
});
const scalar: c.Codec<JsonScalar> = {
  decode: (value, path = []) =>
    value !== undefined && value.kind !== "object" && value.kind !== "array"
      ? { ok: true, value }
      : c.mismatch(path, "literal JSON scalar"),
};
const simpleFormats = [
  "text",
  "multiline",
  "boolean",
  "number",
  "bytes",
  "unix_ms",
  "json",
  "entity_ref",
  "resource_pin",
] as const;
const simpleFormat = c.record({ type: choices(simpleFormats) });
export const formatCodec: c.Codec<CellFormat> = {
  decode: (value, path = []) => {
    const type = value === undefined ? undefined : jsonField(value, "type");
    if (type?.kind !== "string") return c.mismatch([...path, "type"], "format discriminator");
    if (type.value === "duration")
      return c
        .record({ type: c.literal("duration"), unit: choices(["ns", "us", "ms", "s"]) })
        .decode(value, path);
    if (type.value === "enum")
      return c
        .refine(
          c.record({
            type: c.literal("enum"),
            values: c.array(
              c.record({
                value: text(256),
                label: text(512, 1),
                tone: choices(["neutral", "info", "success", "warning", "danger"]),
              }),
              32,
            ),
          }),
          (value) =>
            value.values.length > 0 &&
            new Set(value.values.map((row) => row.value)).size === value.values.length,
          "1..32 unique enum values",
        )
        .decode(value, path);
    return simpleFormat.decode(value, path);
  },
};
const selector = c.tagged<Column["selector"]>("kind", {
  field: c.record({ kind: c.literal("field"), field: text(96, 1) }),
  pointer: c.record({ kind: c.literal("pointer"), pointer: pointerCodec }),
});
const width: c.Codec<number> = {
  decode: (value, path = []) => {
    const n = value?.kind === "number" ? boundedInteger(value.lexeme, 80, 800) : null;
    return n === null ? c.mismatch(path, "integer width 80..800") : { ok: true, value: n };
  },
};
export const columnCodec: c.Codec<Column> = c.record({
  id: d.identifier,
  selector,
  label: text(512, 1),
  format: formatCodec,
  width: c.optional(width),
});
export const filterCodec: c.Codec<ViewFilter> = {
  decode: (value, path = []) => {
    const op = value === undefined ? undefined : jsonField(value, "op");
    if (op?.kind !== "string") return c.mismatch([...path, "op"], "filter operator");
    switch (op.value) {
      case "equals":
        return value !== undefined && jsonField(value, "pointer") !== undefined
          ? c
              .record({ pointer: pointerCodec, op: c.literal("equals"), value: scalar })
              .decode(value, path)
          : c
              .record({ field: text(96, 1), op: c.literal("equals"), value: scalar })
              .decode(value, path);
      case "one_of":
        return c
          .refine(
            c.record({ field: text(96, 1), op: c.literal("one_of"), values: c.array(scalar, 32) }),
            (value) => value.values.length > 0,
            "1..32 one_of scalar values",
          )
          .decode(value, path);
      case "literal_prefix":
      case "contains_text":
        return c
          .record({
            field: text(96, 1),
            op: choices(["literal_prefix", "contains_text"]),
            value: text(512, 1),
          })
          .decode(value, path);
      default:
        return c.mismatch([...path, "op"], "recognized literal filter operator");
    }
  },
};
const source: c.Codec<ConfigSource> = choices([
  "tickets",
  "runs",
  "attempts",
  "sessions",
  "resources",
  "facts",
  "discussions",
  "activity",
]);
export const viewCodec: c.Codec<ViewConfig> = c.record({
  config_version: version,
  kind: c.literal("view"),
  id: d.identifier,
  title: text(512, 1),
  description: c.optional(text(4096)),
  source,
  scope: scopeCodec,
  filter_mode: choices(["server", "loaded"]),
  filters: c.array(filterCodec, 8),
  sort: c.array(
    c.record({ field: text(96, 1), direction: choices(["asc", "desc"]), nulls: c.literal("last") }),
    3,
  ),
  group_by: c.nullable(text(96, 1)),
  presentation: choices(["list", "board", "table", "timeline"]),
  columns: c.refine(c.array(columnCodec, 20), (items) => items.length > 0, "1..20 columns"),
  renderer: c.optional(pinCodec),
});
const field: c.Codec<RenderField> = c.record({
  pointer: pointerCodec,
  label: text(512, 1),
  format: formatCodec,
});
const fields = c.refine(c.array(field, 32), (items) => items.length > 0, "1..32 render fields");
const tableColumns = c.refine(
  c.array(field, 16),
  (items) => items.length > 0,
  "1..16 table columns",
);
const presentation = c.tagged<RendererConfig["presentation"]>("type", {
  fields: c.record({ type: c.literal("fields"), fields }),
  table: c.record({ type: c.literal("table"), rows: pointerCodec, columns: tableColumns }),
  markdown: c.record({ type: c.literal("markdown"), pointer: pointerCodec }),
  json: c.record({ type: c.literal("json"), pointer: pointerCodec }),
  code: c.record({
    type: c.literal("code"),
    pointer: pointerCodec,
    language: choices([
      "plain",
      "ocaml",
      "typescript",
      "javascript",
      "json",
      "bash",
      "yaml",
      "markdown",
      "diff",
    ]),
  }),
});
const mime = c.refine(
  text(128, 1),
  (value) => /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?![\s\S])/u.test(value),
  "exact MIME without parameters",
);
export const rendererCodec: c.Codec<RendererConfig> = c.record({
  config_version: version,
  kind: c.literal("renderer"),
  id: d.identifier,
  title: text(512, 1),
  description: c.optional(text(4096)),
  match: c.record({
    entity: choices(["fact", "resource", "history"]),
    key_prefix: c.optional(text(128, 1)),
    mime_type: c.optional(mime),
    schema: c.optional(c.record({ id: d.identifier, version: text(64, 1) })),
    root_type: c.optional(choices(["null", "boolean", "number", "string", "array", "object"])),
  }),
  presentation,
  fallback: c.literal("generic"),
});
export const catalogCodec: c.Codec<CatalogConfig> = c.record({
  config_version: version,
  kind: c.literal("catalog"),
  entries: c.array(
    c.record({ kind: choices(["view", "renderer"]), id: d.identifier, pin: pinCodec }),
    100,
  ),
});
export const indexCodec: c.Codec<IndexConfig> = c.record({
  config_version: version,
  catalog: pinCodec,
});
/** Structural only. Activation additionally requires semantic validation and verified bytes. */
export const structureCodec: c.Codec<ConfigDocument> = {
  decode: (value, path = []) => {
    if (value?.kind !== "object") return c.mismatch(path, "config object");
    const kind = jsonField(value, "kind");
    if (kind === undefined) return indexCodec.decode(value, path);
    return c
      .tagged<ConfigDocument>("kind", {
        view: viewCodec,
        renderer: rendererCodec,
        catalog: catalogCodec,
      })
      .decode(value, path);
  },
};
