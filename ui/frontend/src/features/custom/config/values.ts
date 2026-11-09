import { jsonField, type JsonValue } from "../../../core/json";
import type { JsonScalar, PointerSelection } from "./types";
const utf8 = new TextEncoder();
export function pointerTokens(pointer: string): readonly string[] | null {
  if (pointer.length > 512 || utf8.encode(pointer).byteLength > 512) return null;
  for (const char of pointer) {
    const code = char.codePointAt(0);
    if (code === undefined || (code >= 0xd800 && code <= 0xdfff)) return null;
  }
  if (pointer === "") return Object.freeze([]);
  if (!pointer.startsWith("/")) return null;
  const parts = pointer.slice(1).split("/");
  if (parts.length > 16 || parts.some((part) => /~(?:[^01]|$)/u.test(part))) return null;
  return Object.freeze(parts.map((part) => part.replace(/~1/gu, "/").replace(/~0/gu, "~")));
}
export function selectPointer(value: JsonValue, pointer: string): PointerSelection {
  const tokens = pointerTokens(pointer);
  if (tokens === null)
    return {
      kind: "invalid",
      message: "Use an RFC6901 pointer of at most 16 tokens and 512 UTF-8 bytes.",
    };
  let current = value;
  for (const token of tokens) {
    if (current.kind === "object") {
      const child = jsonField(current, token);
      if (child === undefined) return { kind: "missing" };
      current = child;
    } else if (current.kind === "array") {
      if (!/^(0|[1-9][0-9]*)(?![\s\S])/u.test(token)) return { kind: "missing" };
      const position = BigInt(token);
      if (position >= BigInt(current.items.length)) return { kind: "missing" };
      // Conversion follows the exact bound against an actual bounded array.
      const child = current.items[Number(position)];
      if (child === undefined) return { kind: "missing" };
      current = child;
    } else return { kind: "missing" };
  }
  return { kind: "found", value: current };
}
export function scalarEqual(a: JsonScalar, b: JsonScalar): boolean {
  switch (a.kind) {
    case "null":
      return b.kind === "null";
    case "boolean":
      return b.kind === "boolean" && a.value === b.value;
    case "string":
      return b.kind === "string" && a.value === b.value;
    // Equality is lexical, matching the native fact predicate contract.
    case "number":
      return b.kind === "number" && a.lexeme === b.lexeme;
  }
}
interface ExactNumber {
  readonly sign: -1 | 0 | 1;
  readonly digits: string;
  readonly magnitude: bigint;
}
function exactNumber(lexeme: string): ExactNumber | null {
  if (lexeme.length > 65536) return null;
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?(?![\s\S])/u.exec(lexeme);
  if (match === null) return null;
  const integer = match[2],
    fraction = match[3] ?? "";
  if (integer === undefined) return null;
  const digits = (integer + fraction).replace(/^0+/u, "");
  if (digits === "") return { sign: 0, digits: "0", magnitude: 0n };
  return {
    sign: match[1] === "-" ? -1 : 1,
    digits,
    magnitude: BigInt(digits.length) + BigInt(match[4] ?? "0") - BigInt(fraction.length),
  };
}
/** Bounded decimal ordering without floating conversion, exponentiation or expanded zeros. */
export function compareNumbers(a: string, b: string): -1 | 0 | 1 | null {
  const left = exactNumber(a),
    right = exactNumber(b);
  if (left === null || right === null) return null;
  if (left.sign !== right.sign) return left.sign < right.sign ? -1 : 1;
  if (left.sign === 0) return 0;
  let order: -1 | 0 | 1 = 0;
  if (left.magnitude !== right.magnitude) order = left.magnitude < right.magnitude ? -1 : 1;
  else
    for (let i = 0; i < Math.max(left.digits.length, right.digits.length); i++) {
      const l = left.digits[i] ?? "0",
        r = right.digits[i] ?? "0";
      if (l !== r) {
        order = l < r ? -1 : 1;
        break;
      }
    }
  return left.sign === -1 ? (order === 0 ? 0 : order === -1 ? 1 : -1) : order;
}
/** Case-sensitive UTF-8 byte ordering, independent of locale and UTF-16 ordering. */
export function compareText(a: string, b: string): -1 | 0 | 1 {
  const left = utf8.encode(a),
    right = utf8.encode(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const l = left[i],
      r = right[i];
    if (l !== undefined && r !== undefined && l !== r) return l < r ? -1 : 1;
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}

export function integerNumber(lexeme: string): boolean {
  const value = exactNumber(lexeme);
  if (value === null) return false;
  if (value.sign === 0) return true;
  const power = value.magnitude - BigInt(value.digits.length);
  if (power >= 0n) return true;
  const places = -power;
  return (
    places <= BigInt(value.digits.length) &&
    /^0*$/u.test(value.digits.slice(value.digits.length - Number(places)))
  );
}
/** Convert a UI integer only after proving integrality and the exact small range. */
export function boundedInteger(lexeme: string, minimum: number, maximum: number): number | null {
  const value = exactNumber(lexeme);
  if (value === null || !Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum))
    return null;
  const power = value.magnitude - BigInt(value.digits.length);
  if (value.sign !== 0 && power < 0n) {
    const places = -power;
    if (places > BigInt(value.digits.length)) return null;
    const suffix = value.digits.slice(value.digits.length - Number(places));
    if (!/^0*$/u.test(suffix)) return null;
  }
  const lower = compareNumbers(lexeme, String(minimum)),
    upper = compareNumbers(lexeme, String(maximum));
  if (lower === null || upper === null || lower === -1 || upper === 1) return null;
  return Number(lexeme);
}
