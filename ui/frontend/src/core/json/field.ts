import type { JsonValue } from "./types";

/** Own decoded fields only. Undefined means absent; JSON null remains a value. */
export function jsonField(value: JsonValue, name: string): JsonValue | undefined {
  if (value.kind !== "object") return undefined;
  return value.fields.find((field) => field.name === name)?.value;
}
