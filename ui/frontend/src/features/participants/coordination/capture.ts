import { capturedJsonWeight, isCapturedJson } from "../../../core/json/capture";
import { CoordinationInputError } from "./model";
import type { CoordinationInput } from "./types";

export const MAX_INPUT_BYTES = 4 * 1024 * 1024;
export const MAX_RETAINED_INPUT_BYTES = 16 * 1024 * 1024;
const weights = new WeakMap<CoordinationInput, number>();
export const inputWeight = (input: CoordinationInput): number =>
  weights.get(input) ?? MAX_INPUT_BYTES;
/** Copy ordinary editor records before the first await. Immutable protocol trees
 * keep their existing ownership certificate and are charged to the retained budget.
 * Alias preservation retains selected-holder membership in the copied capture. */
export function captureInput(input: CoordinationInput): CoordinationInput {
  let nodes = 0,
    characters = 0,
    bytes = 0;
  const memo = new Map<object, object>(),
    ancestors = new Set<object>(),
    charged = new Set<object>();
  const charge = (n: number) => {
    bytes += n;
    if (bytes > MAX_INPUT_BYTES)
      throw new CoordinationInputError(
        "Coordination draft exceeds its 4 MiB retained-input budget.",
      );
  };
  const visit = (value: unknown, depth: number): unknown => {
    if (isCapturedJson(value)) {
      if (!charged.has(value)) {
        charged.add(value);
        charge(capturedJsonWeight(value));
      }
      return value;
    }
    if (++nodes > 12000 || depth > 32)
      throw new CoordinationInputError("Coordination editor exceeds its bounded local shape.");
    if (typeof value === "string") {
      characters += value.length;
      if (characters > 131072)
        throw new CoordinationInputError("Coordination editor exceeds 128Ki characters.");
      charge(value.length * 2 + 8);
      return value;
    }
    if (value === null || typeof value === "boolean") {
      charge(8);
      return value;
    }
    if (typeof value !== "object")
      throw new CoordinationInputError("Coordination editor accepts plain data only.");
    if (ancestors.has(value))
      throw new CoordinationInputError("Coordination editor cannot contain a cycle.");
    const previous = memo.get(value);
    if (previous !== undefined) return previous;
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype)
      throw new CoordinationInputError("Coordination editor requires plain records and arrays.");
    charge(64);
    ancestors.add(value);
    if (Array.isArray(value)) {
      if (value.length > 1000)
        throw new CoordinationInputError("Coordination editor has too many rows.");
      const array: unknown[] = [];
      memo.set(value, array);
      for (let i = 0; i < value.length; i++) {
        const property = Object.getOwnPropertyDescriptor(value, String(i));
        if (property === undefined || !("value" in property))
          throw new CoordinationInputError("Coordination editor requires owned array entries.");
        array.push(visit(property.value, depth + 1));
      }
      ancestors.delete(value);
      return Object.freeze(array);
    }
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    memo.set(value, result);
    for (const name of Object.keys(value)) {
      const property = Object.getOwnPropertyDescriptor(value, name);
      if (property === undefined || !("value" in property))
        throw new CoordinationInputError("Coordination editor cannot contain accessors.");
      charge(name.length * 2 + 8);
      result[name] = visit(property.value, depth + 1);
    }
    ancestors.delete(value);
    return Object.freeze(result);
  };
  // Shape-preserving copy of typed local editor input; public protocol trees were
  // already certified by the bounded decoder. No unchecked tree is certified here.
  const result = visit(input, 0) as CoordinationInput;
  weights.set(result, bytes);
  return result;
}
