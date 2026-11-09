import { jsonField, type JsonValue } from "../../../core/json";
import type { SourcePath } from "./types";
export type ObjectValue = Extract<JsonValue, { kind: "object" }>;
export class ShapeMismatch extends Error {
  constructor(
    readonly path: SourcePath,
    readonly expected: string,
  ) {
    super(expected);
  }
}
export function mismatch(path: SourcePath, expected: string): never {
  throw new ShapeMismatch(path, expected);
}
export function object(value: JsonValue | undefined, path: SourcePath): ObjectValue {
  if (value?.kind !== "object") return mismatch(path, "object");
  return value;
}
export const field = jsonField;
export function string(value: JsonValue | undefined, path: SourcePath): string {
  if (value?.kind !== "string") return mismatch(path, "string");
  return value.value;
}
export function identifier(value: JsonValue | undefined, path: SourcePath): string {
  const result = string(value, path);
  if (!result || result.length > 1024)
    return mismatch(path, "nonempty identifier up to 1024 UTF-16 units");
  return result;
}
export function bool(value: JsonValue | undefined, path: SourcePath): boolean {
  if (value?.kind !== "boolean") return mismatch(path, "boolean");
  return value.value;
}
export function literal<const T extends string>(
  value: JsonValue | undefined,
  expected: T,
  path: SourcePath,
): T {
  if (value?.kind !== "string" || value.value !== expected)
    return mismatch(path, `literal ${expected}`);
  return expected;
}
export function enumeration<const T extends string>(
  value: JsonValue | undefined,
  choices: readonly T[],
  path: SourcePath,
): T {
  for (const choice of choices)
    if (value?.kind === "string" && value.value === choice) return choice;
  return mismatch(path, choices.join(" | "));
}
export function array(
  value: JsonValue | undefined,
  path: SourcePath,
  maximum = 256,
): readonly JsonValue[] {
  if (value?.kind !== "array" || value.items.length > maximum)
    return mismatch(path, `array up to ${maximum} entries`);
  return value.items;
}
/** JSON's number lexeme remains authoritative; counts use strict nonnegative integer syntax. */
export function integer(value: JsonValue | undefined, path: SourcePath): string {
  if (value?.kind !== "number" || !/^(?:0|[1-9][0-9]*)$/u.test(value.lexeme))
    return mismatch(path, "nonnegative integer JSON number");
  return value.lexeme;
}
export function nonnegative(value: JsonValue | undefined, path: SourcePath): string {
  if (value?.kind !== "number" || value.lexeme.startsWith("-"))
    return mismatch(path, "nonnegative JSON number");
  return value.lexeme;
}
export function nullableString(value: JsonValue | undefined, path: SourcePath): string | null {
  return value?.kind === "null" ? null : string(value, path);
}
export function optionalString(value: JsonValue | undefined, path: SourcePath): string | null {
  return value === undefined || value.kind === "null" ? null : string(value, path);
}
export function optionalIdentifier(value: JsonValue | undefined, path: SourcePath): string | null {
  return value === undefined || value.kind === "null" ? null : identifier(value, path);
}
export function eachObject(value: JsonValue | undefined, path: SourcePath): readonly ObjectValue[] {
  return array(value, path).map((entry, index) => object(entry, [...path, String(index)]));
}
export function required(value: JsonValue | undefined, path: SourcePath): JsonValue {
  return value === undefined ? mismatch(path, "retained JSON value") : value;
}
