import { jsonField, type JsonValue } from "../../../core/json";
export function textField(value: JsonValue | undefined, name: string): string | null {
  const field = value?.kind === "object" ? jsonField(value, name) : undefined;
  return field?.kind === "string" ? field.value : null;
}
