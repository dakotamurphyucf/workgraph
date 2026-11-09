import type { JsonValue } from "../../../core/json";
import * as d from "../../../core/protocol/decoders";
import type {
  CellFormat,
  Column,
  ConfigDocument,
  ConfigScope,
  ContentPin,
  RenderField,
  ViewFilter,
} from "./types";
const object = d.jsonObject,
  string = d.jsonString,
  array = d.jsonArray;
export const scopeJson = (scope: ConfigScope) =>
  object([
    ["kind", string(scope.kind)],
    ...(scope.kind === "workspace" ? [] : [["id", string(scope.id)] as const]),
  ]);
export const pinJson = (pin: ContentPin) =>
  object([
    ["resource_id", string(pin.resource_id)],
    ["version", string(pin.version)],
    ["digest", string(pin.digest)],
    ["size_bytes", string(pin.size_bytes)],
  ]);
function formatJson(format: CellFormat): JsonValue {
  return object([
    ["type", string(format.type)],
    ...(format.type === "duration"
      ? [["unit", string(format.unit)] as const]
      : format.type === "enum"
        ? [
            [
              "values",
              array(
                format.values.map((entry) =>
                  object([
                    ["value", string(entry.value)],
                    ["label", string(entry.label)],
                    ["tone", string(entry.tone)],
                  ]),
                ),
              ),
            ] as const,
          ]
        : []),
  ]);
}
function fieldJson(field: RenderField) {
  return object([
    ["pointer", string(field.pointer)],
    ["label", string(field.label)],
    ["format", formatJson(field.format)],
  ]);
}
function columnJson(column: Column) {
  return object([
    ["id", string(column.id)],
    [
      "selector",
      object([
        ["kind", string(column.selector.kind)],
        column.selector.kind === "field"
          ? ["field", string(column.selector.field)]
          : ["pointer", string(column.selector.pointer)],
      ]),
    ],
    ["label", string(column.label)],
    ["format", formatJson(column.format)],
    ...(column.width === undefined ? [] : [["width", d.jsonNumber(String(column.width))] as const]),
  ]);
}
function filterJson(filter: ViewFilter) {
  return object([
    ["op", string(filter.op)],
    "pointer" in filter ? ["pointer", string(filter.pointer)] : ["field", string(filter.field)],
    filter.op === "one_of"
      ? ["values", array(filter.values)]
      : ["value", typeof filter.value === "string" ? string(filter.value) : filter.value],
  ]);
}
/** A closed encoder; arbitrary JSON is retained only in literal scalar filters. */
export function configJson(document: ConfigDocument): JsonValue {
  const version = ["config_version", d.jsonNumber("1")] as const;
  if (!("kind" in document)) return object([version, ["catalog", pinJson(document.catalog)]]);
  if (document.kind === "catalog")
    return object([
      version,
      ["kind", string("catalog")],
      [
        "entries",
        array(
          document.entries.map((entry) =>
            object([
              ["kind", string(entry.kind)],
              ["id", string(entry.id)],
              ["pin", pinJson(entry.pin)],
            ]),
          ),
        ),
      ],
    ]);
  const common = [
    version,
    ["kind", string(document.kind)] as const,
    ["id", string(document.id)] as const,
    ["title", string(document.title)] as const,
    ...(document.description === undefined
      ? []
      : [["description", string(document.description)] as const]),
  ];
  if (document.kind === "view")
    return object([
      ...common,
      ["source", string(document.source)],
      ["scope", scopeJson(document.scope)],
      ["filter_mode", string(document.filter_mode)],
      ["filters", array(document.filters.map(filterJson))],
      [
        "sort",
        array(
          document.sort.map((sort) =>
            object([
              ["field", string(sort.field)],
              ["direction", string(sort.direction)],
              ["nulls", string(sort.nulls)],
            ]),
          ),
        ),
      ],
      ["group_by", document.group_by === null ? d.jsonNull() : string(document.group_by)],
      ["presentation", string(document.presentation)],
      ["columns", array(document.columns.map(columnJson))],
      ...(document.renderer === undefined
        ? []
        : [["renderer", pinJson(document.renderer)] as const]),
    ]);
  const match = document.match,
    presentation = document.presentation;
  let body: JsonValue;
  switch (presentation.type) {
    case "fields":
      body = object([
        ["type", string("fields")],
        ["fields", array(presentation.fields.map(fieldJson))],
      ]);
      break;
    case "table":
      body = object([
        ["type", string("table")],
        ["rows", string(presentation.rows)],
        ["columns", array(presentation.columns.map(fieldJson))],
      ]);
      break;
    case "code":
      body = object([
        ["type", string("code")],
        ["pointer", string(presentation.pointer)],
        ["language", string(presentation.language)],
      ]);
      break;
    case "json":
    case "markdown":
      body = object([
        ["type", string(presentation.type)],
        ["pointer", string(presentation.pointer)],
      ]);
      break;
  }
  return object([
    ...common,
    [
      "match",
      object([
        ["entity", string(match.entity)],
        ...(match.key_prefix === undefined
          ? []
          : [["key_prefix", string(match.key_prefix)] as const]),
        ...(match.mime_type === undefined ? [] : [["mime_type", string(match.mime_type)] as const]),
        ...(match.schema === undefined
          ? []
          : [
              [
                "schema",
                object([
                  ["id", string(match.schema.id)],
                  ["version", string(match.schema.version)],
                ]),
              ] as const,
            ]),
        ...(match.root_type === undefined ? [] : [["root_type", string(match.root_type)] as const]),
      ]),
    ],
    ["presentation", body],
    ["fallback", string("generic")],
  ]);
}
