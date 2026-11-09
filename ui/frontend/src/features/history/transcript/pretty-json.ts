import { stringifyJson, type JsonValue } from "../../../core/json";
/** Display whitespace only: keep original field order, duplicate fields and exact
 * number lexemes. Original captured bytes are still used for download/integrity. */
export function prettyJson(value: JsonValue, level = 0): string {
  const pad = (depth: number) => "  ".repeat(depth);
  if (value.kind === "object")
    return value.fields.length === 0
      ? "{}"
      : `{\n${value.fields.map((f) => `${pad(level + 1)}${JSON.stringify(f.name)}: ${prettyJson(f.value, level + 1)}`).join(",\n")}\n${pad(level)}}`;
  if (value.kind === "array")
    return value.items.length === 0
      ? "[]"
      : `[\n${value.items.map((v) => `${pad(level + 1)}${prettyJson(v, level + 1)}`).join(",\n")}\n${pad(level)}]`;
  const encoded = stringifyJson(value);
  if (!encoded.ok) throw new Error(encoded.error.message);
  return encoded.value;
}
