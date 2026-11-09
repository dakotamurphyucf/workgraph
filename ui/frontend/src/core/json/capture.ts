import type { JsonField, JsonValue } from "./types";

const immutable = new WeakSet<object>();
const weights = new WeakMap<object, number>();
const maxWeight = 16 * 1024 * 1024;
export const capturedJsonWeight = (value: JsonValue): number => weights.get(value) ?? maxWeight;
/** Internal ownership certificate. Call only after an owned constructor froze every descendant. */
export function certifyJson<T extends JsonValue>(value: T, suppliedWeight?: number): T {
  if (!Object.isFrozen(value))
    throw new Error("JSON ownership certificate requires a frozen root.");
  immutable.add(value);
  const text = (s: string) => Math.min(maxWeight, 2 + s.length * 6);
  const weight =
    suppliedWeight ??
    (value.kind === "null"
      ? 4
      : value.kind === "boolean"
        ? 5
        : value.kind === "number"
          ? value.lexeme.length
          : value.kind === "string"
            ? text(value.value)
            : value.kind === "array"
              ? value.items.reduce(
                  (sum, item) => Math.min(maxWeight, sum + 1 + capturedJsonWeight(item)),
                  2,
                )
              : value.fields.reduce(
                  (sum, field) =>
                    Math.min(
                      maxWeight,
                      sum + 2 + text(field.name) + capturedJsonWeight(field.value),
                    ),
                  2,
                ));
  weights.set(value, Math.min(maxWeight, weight));
  return value;
}
export function isCapturedJson(value: unknown): value is JsonValue {
  return typeof value === "object" && value !== null && immutable.has(value);
}
export type JsonCapture =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly message: string };
const guidance =
  "Use processing.parse to capture large parameters before registering an intention.";

/** Synchronous admission is deliberately small; certified full-size trees return in constant time. */
export function captureJson(value: JsonValue): JsonCapture {
  if (isCapturedJson(value)) return { ok: true, value };
  let nodes = 0;
  let characters = 0;
  const ancestors = new Set<object>();
  const fail = (): never => {
    throw new CaptureFailure();
  };
  const text = (value: unknown): string => {
    if (typeof value !== "string") return fail();
    characters += value.length;
    if (characters > 16_384) return fail();
    return value;
  };
  const object = (value: unknown, names: readonly string[]): object => {
    if (typeof value !== "object" || value === null) return fail();
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return fail();
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== names.length ||
      keys.some((key) => typeof key !== "string" || !names.includes(key))
    )
      return fail();
    return value;
  };
  const data = (value: object, name: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !("value" in descriptor)) return fail();
    return descriptor.value as unknown;
  };
  const array = (value: unknown): readonly unknown[] => {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > 256
    )
      return fail();
    // Index descriptors below reject holes/accessors; extra properties cannot influence the capture.
    return value as readonly unknown[];
  };
  const visit = (input: unknown, depth: number): JsonValue => {
    nodes += 1;
    if (nodes > 256 || depth > 64 || typeof input !== "object" || input === null) return fail();
    if (ancestors.has(input)) return fail();
    // Known certified descendants need no traversal and cannot change underneath this capture.
    if (immutable.has(input)) return input as JsonValue;
    const kind = data(input, "kind");
    ancestors.add(input);
    let result: JsonValue;
    switch (kind) {
      case "null":
        object(input, ["kind"]);
        result = { kind: "null" };
        break;
      case "boolean": {
        object(input, ["kind", "value"]);
        const value = data(input, "value");
        if (typeof value !== "boolean") return fail();
        result = { kind: "boolean", value };
        break;
      }
      case "string":
        object(input, ["kind", "value"]);
        result = { kind: "string", value: text(data(input, "value")) };
        break;
      case "number":
        object(input, ["kind", "lexeme"]);
        result = { kind: "number", lexeme: text(data(input, "lexeme")) };
        break;
      case "array": {
        object(input, ["kind", "items"]);
        const source = array(data(input, "items"));
        const items: JsonValue[] = [];
        for (let index = 0; index < source.length; index += 1)
          items.push(visit(data(source, String(index)), depth + 1));
        result = { kind: "array", items: Object.freeze(items) };
        break;
      }
      case "object": {
        object(input, ["kind", "fields"]);
        const source = array(data(input, "fields"));
        const fields: JsonField[] = [];
        for (let index = 0; index < source.length; index += 1) {
          if (++nodes > 256) return fail();
          const field = object(data(source, String(index)), ["name", "value"]);
          fields.push(
            Object.freeze({
              name: text(data(field, "name")),
              value: visit(data(field, "value"), depth + 1),
            }),
          );
        }
        result = { kind: "object", fields: Object.freeze(fields) };
        break;
      }
      default:
        return fail();
    }
    ancestors.delete(input);
    return certifyJson(Object.freeze(result));
  };
  try {
    return { ok: true, value: visit(value, 0) };
  } catch (error: unknown) {
    if (!(error instanceof CaptureFailure)) throw error;
    return { ok: false, message: `Parameters need an immutable JSON capture. ${guidance}` };
  }
}
class CaptureFailure extends Error {}
