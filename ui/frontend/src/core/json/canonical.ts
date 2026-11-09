import { parseJsonText } from "./decode";
import { stringifyJson } from "./encode";
import { DEFAULT_JSON_LIMITS, type JsonLimits, type JsonResult, type JsonValue } from "./types";

/** Unicode scalar order equals UTF-8 byte order for validated scalar strings. */
function compareNames(left: string, right: string): number {
  let a = 0;
  let b = 0;
  while (a < left.length && b < right.length) {
    const x = left.codePointAt(a);
    const y = right.codePointAt(b);
    if (x === undefined || y === undefined) throw new Error("Invalid scalar position.");
    if (x !== y) return x < y ? -1 : 1;
    a += x > 0xffff ? 2 : 1;
    b += y > 0xffff ? 2 : 1;
  }
  return a < left.length ? 1 : b < right.length ? -1 : 0;
}

function ordered(value: JsonValue): JsonValue {
  switch (value.kind) {
    case "object":
      return {
        kind: "object",
        fields: [...value.fields]
          .sort((a, b) => compareNames(a.name, b.name))
          .map((field) => ({ name: field.name, value: ordered(field.value) })),
      };
    case "array":
      return { kind: "array", items: value.items.map(ordered) };
    case "null":
    case "boolean":
    case "string":
    case "number":
      return value;
  }
}

/**
 * Identity comparison with Workgraph's decoded-key ordering. Number lexemes and
 * array order remain exact. This is not a byte-preserving source export or a hash
 * implementation. Validate and copy before sorting so cycles and oversized input
 * cannot bypass the ordinary bounds.
 */
export function canonicalJson(
  value: JsonValue,
  limits: JsonLimits = DEFAULT_JSON_LIMITS,
): JsonResult<string> {
  const encoded = stringifyJson(value, limits);
  if (!encoded.ok) return encoded;
  const parsed = parseJsonText(encoded.value, limits);
  if (!parsed.ok) return parsed;
  return stringifyJson(ordered(parsed.value.value), limits);
}
