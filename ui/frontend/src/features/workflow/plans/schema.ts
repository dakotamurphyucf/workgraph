import { jsonField, type JsonValue } from "../../../core/json";
import * as d from "../../../core/protocol/decoders";
import type { JsonObject } from "../../../core/protocol/types";

/** Presentation only. The executable's selected descriptor and native preflight validate values. */
export function resolveSchema(schema: JsonValue, root: JsonValue): JsonValue | null {
  let current = schema;
  const seen = new Set<string>();
  for (let depth = 0; depth < 12; depth++) {
    const ref = jsonField(current, "$ref");
    if (ref === undefined) return current;
    if (ref.kind !== "string" || !ref.value.startsWith("#/") || seen.has(ref.value)) return null;
    seen.add(ref.value);
    let found: JsonValue | undefined = root;
    for (const segment of ref.value.slice(2).split("/"))
      found =
        found === undefined
          ? undefined
          : jsonField(found, segment.replaceAll("~1", "/").replaceAll("~0", "~"));
    if (found === undefined) return null;
    const siblings =
      current.kind === "object" ? current.fields.filter((field) => field.name !== "$ref") : [];
    current =
      siblings.length === 0
        ? found
        : d.jsonObject([
            [
              "allOf",
              d.jsonArray([
                found,
                d.jsonObject(siblings.map((field) => [field.name, field.value] as const)),
              ]),
            ],
          ]);
  }
  return null;
}
export function schemaField(
  schema: JsonValue | undefined,
  name: string,
  root = schema,
  depth = 0,
): JsonValue | undefined {
  if (schema === undefined || root === undefined || depth > 16) return undefined;
  const resolved = resolveSchema(schema, root);
  if (resolved === null) return undefined;
  const direct = jsonField(resolved, name),
    values: JsonValue[] = direct === undefined ? [] : [direct];
  const all = jsonField(resolved, "allOf");
  if (all?.kind === "array")
    for (const item of all.items) {
      const found = schemaField(item, name, root, depth + 1);
      if (found !== undefined) values.push(found);
    }
  if (name === "properties" || name === "$defs") {
    const fields = new Map<string, JsonValue>();
    for (const value of values)
      if (value.kind === "object")
        for (const field of value.fields) {
          const prior = fields.get(field.name);
          fields.set(
            field.name,
            prior === undefined
              ? field.value
              : d.jsonObject([["allOf", d.jsonArray([prior, field.value])]]),
          );
        }
    return values.length === 0 ? undefined : d.jsonObject([...fields]);
  }
  if (name === "required") {
    const names = new Set<string>();
    for (const value of values)
      if (value.kind === "array")
        for (const item of value.items) if (item.kind === "string") names.add(item.value);
    return values.length === 0 ? undefined : d.jsonArray([...names].map(d.jsonString));
  }
  return values[0];
}
function literalEqual(left: JsonValue, right: JsonValue): boolean {
  if (left.kind === "string" && right.kind === "string") return left.value === right.value;
  if (left.kind === "number" && right.kind === "number") return left.lexeme === right.lexeme;
  if (left.kind === "boolean" && right.kind === "boolean") return left.value === right.value;
  return left.kind === "null" && right.kind === "null";
}
/** Native schemas use local definitions. External/cyclic/unbounded references get an explicit source fallback. */
export function expandSchema(schema: JsonValue): JsonValue | null {
  let nodes = 0;
  function visit(value: JsonValue, depth: number): JsonValue | null {
    if (++nodes > 50_000 || depth > 48) return null;
    const resolved = resolveSchema(value, schema);
    if (resolved === null) return null;
    if (resolved.kind === "array") {
      const items: JsonValue[] = [];
      for (const item of resolved.items) {
        const next = visit(item, depth + 1);
        if (next === null) return null;
        items.push(next);
      }
      return d.jsonArray(items);
    }
    if (resolved.kind === "object") {
      const fields: (readonly [string, JsonValue])[] = [];
      for (const field of resolved.fields) {
        if (field.name === "$defs") continue;
        const next = visit(field.value, depth + 1);
        if (next === null) return null;
        fields.push([field.name, next]);
      }
      return d.jsonObject(fields);
    }
    return resolved;
  }
  return visit(schema, 0);
}
export function text(value: JsonValue | undefined): string {
  return value?.kind === "string" ? value.value : "";
}
export function schemaChoices(schema: JsonValue): readonly JsonValue[] {
  const found = schemaField(schema, "oneOf") ?? schemaField(schema, "anyOf");
  return found?.kind === "array" ? found.items : [];
}
export function shape(schema: JsonValue): string {
  const type = schemaField(schema, "type");
  if (type?.kind === "string") return type.value;
  if (schemaField(schema, "properties")?.kind === "object") return "object";
  if (schemaField(schema, "items") !== undefined) return "array";
  return "unknown";
}
export function defaultValue(schema: JsonValue, depth = 0): JsonValue {
  if (depth > 12) return d.jsonNull();
  const fixed = schemaField(schema, "const");
  if (fixed !== undefined) return fixed;
  const values = schemaField(schema, "enum");
  if (values?.kind === "array" && values.items[0] !== undefined) return values.items[0];
  const choices = schemaChoices(schema),
    nullable = choices.find((choice) => shape(choice) === "null");
  if (nullable !== undefined) return d.jsonNull();
  if (choices[0] !== undefined) return defaultValue(choices[0], depth + 1);
  switch (shape(schema)) {
    case "null":
      return d.jsonNull();
    case "boolean":
      return d.jsonBoolean(false);
    case "number":
    case "integer":
      return d.jsonNumber("0");
    case "array":
      return d.jsonArray([]);
    case "object": {
      const props = schemaField(schema, "properties"),
        required = schemaField(schema, "required");
      const names = required?.kind === "array" ? required.items.map(text) : [];
      return d.jsonObject(
        props?.kind === "object"
          ? props.fields
              .filter((f) => names.includes(f.name))
              .map((f) => [f.name, defaultValue(f.value, depth + 1)] as const)
          : [],
      );
    }
    default:
      return d.jsonString("");
  }
}
export function matchesShape(schema: JsonValue, value: JsonValue): boolean {
  const fixed = schemaField(schema, "const"),
    enumeration = schemaField(schema, "enum");
  if (fixed !== undefined) return literalEqual(fixed, value);
  if (enumeration?.kind === "array" && !enumeration.items.some((item) => literalEqual(item, value)))
    return false;
  const type = shape(schema);
  if (type !== "unknown" && (type === "integer" ? "number" : type) !== value.kind) return false;
  const props = schemaField(schema, "properties");
  if (value.kind === "object" && props?.kind === "object") {
    for (const prop of props.fields) {
      const constant = schemaField(prop.value, "const"),
        enumeration = schemaField(prop.value, "enum");
      const field = jsonField(value, prop.name);
      if (constant !== undefined && (field === undefined || !literalEqual(constant, field)))
        return false;
      if (
        enumeration?.kind === "array" &&
        (field === undefined || !enumeration.items.some((item) => literalEqual(item, field)))
      )
        return false;
    }
  }
  return true;
}
export function setField(value: JsonObject, name: string, next: JsonValue | undefined): JsonObject {
  return d.jsonObject([
    ...value.fields.filter((f) => f.name !== name).map((f) => [f.name, f.value] as const),
    ...(next === undefined ? [] : [[name, next] as const]),
  ]);
}
export const label = (name: string) =>
  name.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());

export function variantLabel(schema: JsonValue, name: string, index: number): string {
  const props = schemaField(schema, "properties"),
    kind = props === undefined ? undefined : jsonField(props, "kind"),
    fixed = kind === undefined ? undefined : schemaField(kind, "const"),
    enumeration = kind === undefined ? undefined : schemaField(kind, "enum");
  const tag = text(fixed) || (enumeration?.kind === "array" ? text(enumeration.items[0]) : "");
  if (tag === "actor") return "Named actor";
  if (tag === "role") return "Reviewer role";
  if (tag !== "") return label(tag);
  const type = shape(schema);
  if (name === "Allowed actor ids")
    return type === "null"
      ? "Unrestricted actors"
      : type === "array"
        ? "Explicit actor allowlist"
        : type;
  if (name === "Parent" && type === "null") return "No parent";
  return (
    text(schemaField(schema, "title")) ||
    text(schemaField(schema, "description")).slice(0, 96) ||
    (type === "null" ? "Explicit null" : type === "unknown" ? `Variant ${index + 1}` : label(type))
  );
}
/** Choosing a shape never silently drops fields unknown to the current descriptor. */
export function chooseVariant(schema: JsonValue, current: JsonValue): JsonValue {
  const defaults = defaultValue(schema);
  if (defaults.kind !== "object" || current.kind !== "object") return defaults;
  const props = schemaField(schema, "properties");
  return d.jsonObject([
    ...current.fields
      .filter((field) => !defaults.fields.some((next) => next.name === field.name))
      .map((field) => [field.name, field.value] as const),
    ...defaults.fields.map((field) => {
      const property = props === undefined ? undefined : jsonField(props, field.name),
        fixed = property === undefined ? undefined : schemaField(property, "const"),
        enumeration = property === undefined ? undefined : schemaField(property, "enum");
      const discriminant =
        fixed !== undefined || (enumeration?.kind === "array" && enumeration.items.length === 1);
      return [
        field.name,
        discriminant ? field.value : (jsonField(current, field.name) ?? field.value),
      ] as const;
    }),
  ]);
}
