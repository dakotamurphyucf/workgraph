import { jsonField, type JsonValue } from "../../core/json";
import type { FieldDescriptor } from "./types";
export type JsonObject = Extract<JsonValue, { kind: "object" }>;
export type { ParameterFieldEdit as FieldInput } from "./types";
export type InputResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };
/** Presentation hint only. Full schema validation remains the executable's responsibility. */
export function fieldType(field: FieldDescriptor): string {
  const resolve = (schema: JsonValue): string => {
    const type = jsonField(schema, "type");
    if (type?.kind === "string") return type.value;
    const all = jsonField(schema, "allOf");
    if (all?.kind === "array") {
      const types = all.items.map(resolve).filter((t) => t !== "json");
      if (types.length > 0 && types.every((t) => t === types[0])) return types[0] ?? "json";
    }
    return "json";
  };
  return resolve(field.schema);
}
