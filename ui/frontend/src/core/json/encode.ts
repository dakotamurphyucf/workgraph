import { invalidScalarOffset, parseJsonText } from "./decode";
import {
  DEFAULT_JSON_LIMITS,
  type JsonError,
  type JsonLimits,
  type JsonResult,
  type JsonValue,
} from "./types";

const numberPattern = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?(?![\s\S])/u;

/**
 * Compact reformat, preserving number lexemes and field order. This is not the
 * original source: use JsonDocument.source for byte-preserving copy/download.
 * Publicly constructed values are validated too; cycles hit the depth budget.
 */
export function stringifyJson(
  value: JsonValue,
  limits: JsonLimits = DEFAULT_JSON_LIMITS,
): JsonResult<string> {
  // Reuse the decoder's limit validation before recursion or allocation.
  const validatedLimits = parseJsonText("0", limits);
  if (!validatedLimits.ok) return validatedLimits;
  const pieces: string[] = [];
  let characters = 0;
  let nodes = 0;
  let error: JsonError | undefined;
  const fail = (code: JsonError["code"], message: string): void => {
    error ??= { code, message };
  };
  const append = (piece: string): void => {
    characters += piece.length;
    if (characters > limits.maxBytes) fail("byte_limit", "JSON exceeds the output byte budget.");
    if (error === undefined) pieces.push(piece);
  };
  const string = (text: string): void => {
    if (text.length > limits.maxBytes) {
      fail("byte_limit", "JSON string exceeds the output byte budget.");
    } else if (invalidScalarOffset(text) !== undefined) {
      fail("invalid_unicode", "JSON strings must contain Unicode scalar values.");
    } else {
      // JSON.stringify is safe for a single validated string, never an arbitrary value tree.
      append(JSON.stringify(text));
    }
  };
  const visit = (current: JsonValue, depth: number): void => {
    if (error !== undefined) return;
    nodes += 1;
    if (nodes > limits.maxNodes) {
      fail("node_limit", "JSON values and field names exceed the node budget.");
      return;
    }
    if (current.kind === "array" || current.kind === "object") {
      if (depth >= limits.maxDepth) {
        fail("depth_limit", "JSON exceeds the nested container budget.");
        return;
      }
    }
    switch (current.kind) {
      case "null":
        append("null");
        break;
      case "boolean":
        append(current.value ? "true" : "false");
        break;
      case "string":
        string(current.value);
        break;
      case "number":
        if (!numberPattern.test(current.lexeme))
          fail("invalid_json", "Invalid JSON number lexeme.");
        else append(current.lexeme);
        break;
      case "array":
        append("[");
        for (const [index, item] of current.items.entries()) {
          if (error !== undefined) break;
          if (index > 0) append(",");
          visit(item, depth + 1);
        }
        append("]");
        break;
      case "object": {
        const names = new Set<string>();
        append("{");
        for (const [index, field] of current.fields.entries()) {
          if (error !== undefined) break;
          if (names.has(field.name)) {
            fail("duplicate_key", "Duplicate decoded JSON field name.");
            break;
          }
          names.add(field.name);
          nodes += 1;
          if (index > 0) append(",");
          string(field.name);
          append(":");
          visit(field.value, depth + 1);
        }
        append("}");
        break;
      }
    }
  };
  visit(value, 0);
  if (error !== undefined) return { ok: false, error };
  const source = pieces.join("");
  // Verify exact UTF-8 and aggregate decoded-string budgets on the final encoding.
  const validated = parseJsonText(source, limits);
  if (!validated.ok) return validated;
  return { ok: true, value: source };
}
