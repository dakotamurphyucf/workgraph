import { certifyJson } from "./capture";
import {
  createScanner,
  parseTree,
  printParseErrorCode,
  type Node,
  type ParseError,
} from "jsonc-parser";
import {
  DEFAULT_JSON_LIMITS,
  type JsonDocument,
  type JsonError,
  type JsonField,
  type JsonLimits,
  type JsonResult,
  type JsonValue,
} from "./types";

const encoder = new TextEncoder();

// jsonc-parser 3.3.1 declares ambient const enums, which cannot be imported under
// isolatedModules/verbatimModuleSyntax. Keep its pinned scanner token contract
// here, without weakening compiler settings or consuming rounded numeric values.
const SyntaxKind = {
  OpenBraceToken: 1,
  CloseBraceToken: 2,
  OpenBracketToken: 3,
  CloseBracketToken: 4,
  CommaToken: 5,
  ColonToken: 6,
  NullKeyword: 7,
  TrueKeyword: 8,
  FalseKeyword: 9,
  StringLiteral: 10,
  NumericLiteral: 11,
  LineCommentTrivia: 12,
  BlockCommentTrivia: 13,
  LineBreakTrivia: 14,
  Trivia: 15,
  Unknown: 16,
  EOF: 17,
} as const;

function failure<T>(code: JsonError["code"], message: string, utf16Offset?: number): JsonResult<T> {
  return {
    ok: false,
    error: utf16Offset === undefined ? { code, message } : { code, message, utf16Offset },
  };
}

/** Finds unpaired UTF-16 surrogates, including those decoded from JSON escapes. */
export function invalidScalarOffset(text: string): number | undefined {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return index;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return index;
    }
  }
  return undefined;
}

function validateLimits(limits: JsonLimits): JsonResult<undefined> {
  const values = [limits.maxBytes, limits.maxDepth, limits.maxNodes, limits.maxStringBytes];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 1) || limits.maxDepth > 96) {
    return failure(
      "invalid_limits",
      "JSON limits must be positive safe integers; depth cannot exceed 96.",
    );
  }
  return { ok: true, value: undefined };
}

/** Bound the parser's allocation and stack before it constructs a fault-tolerant AST. */
function scanWithinLimits(source: string, limits: JsonLimits): JsonResult<undefined> {
  const scanner = createScanner(source, false);
  const containers: number[] = [];
  let nodes = 0;
  let stringBytes = 0;
  for (;;) {
    const token: number = scanner.scan();
    const offset = scanner.getTokenOffset();
    const scanError: number = scanner.getTokenError();
    if (scanError !== 0) {
      return failure("invalid_json", "Invalid JSON token.", offset);
    }
    if (token === SyntaxKind.EOF) break;
    switch (token) {
      case SyntaxKind.OpenBraceToken:
      case SyntaxKind.OpenBracketToken:
        containers.push(token);
        nodes += 1;
        if (containers.length > limits.maxDepth) {
          return failure(
            "depth_limit",
            `JSON exceeds ${limits.maxDepth} nested containers.`,
            offset,
          );
        }
        break;
      case SyntaxKind.CloseBraceToken:
      case SyntaxKind.CloseBracketToken:
        if (
          containers.pop() !==
          (token === SyntaxKind.CloseBraceToken
            ? SyntaxKind.OpenBraceToken
            : SyntaxKind.OpenBracketToken)
        ) {
          return failure("invalid_json", "Mismatched closing container.", offset);
        }
        break;
      case SyntaxKind.StringLiteral: {
        nodes += 1;
        const value = scanner.getTokenValue();
        if (invalidScalarOffset(value) !== undefined) {
          return failure(
            "invalid_unicode",
            "JSON strings must contain Unicode scalar values.",
            offset,
          );
        }
        stringBytes += encoder.encode(value).byteLength;
        if (stringBytes > limits.maxStringBytes) {
          return failure("string_limit", "Decoded JSON strings exceed the byte budget.", offset);
        }
        break;
      }
      case SyntaxKind.NumericLiteral:
      case SyntaxKind.NullKeyword:
      case SyntaxKind.TrueKeyword:
      case SyntaxKind.FalseKeyword:
        nodes += 1;
        break;
      case SyntaxKind.LineCommentTrivia:
      case SyntaxKind.BlockCommentTrivia:
      case SyntaxKind.Unknown:
        return failure(
          "invalid_json",
          "Comments and unknown JSON tokens are not supported.",
          offset,
        );
      case SyntaxKind.CommaToken:
      case SyntaxKind.ColonToken:
      case SyntaxKind.LineBreakTrivia:
      case SyntaxKind.Trivia:
        break;
      default:
        return failure("invalid_json", "Unsupported scanner token.", offset);
    }
    if (nodes > limits.maxNodes) {
      return failure("node_limit", "JSON values and field names exceed the node budget.", offset);
    }
  }
  if (containers.length !== 0) return failure("invalid_json", "Unclosed JSON container.");
  return { ok: true, value: undefined };
}

function buildValue(node: Node, source: string): JsonResult<JsonValue> {
  switch (node.type) {
    case "null":
      return { ok: true, value: certifyJson(Object.freeze({ kind: "null" })) };
    case "boolean":
      return {
        ok: true,
        value: certifyJson(
          Object.freeze({
            kind: "boolean",
            value: source.slice(node.offset, node.offset + node.length) === "true",
          }),
        ),
      };
    case "number":
      // Never read node.value: the parser converts numeric literals to IEEE-754.
      return {
        ok: true,
        value: certifyJson(
          Object.freeze({
            kind: "number",
            lexeme: source.slice(node.offset, node.offset + node.length),
          }),
        ),
      };
    case "string": {
      const value: unknown = node.value;
      if (typeof value !== "string")
        return failure("invalid_json", "Invalid string AST.", node.offset);
      return { ok: true, value: certifyJson(Object.freeze({ kind: "string", value })) };
    }
    case "array": {
      const items: JsonValue[] = [];
      for (const child of node.children ?? []) {
        const result = buildValue(child, source);
        if (!result.ok) return result;
        items.push(result.value);
      }
      return {
        ok: true,
        value: certifyJson(Object.freeze({ kind: "array", items: Object.freeze(items) })),
      };
    }
    case "object": {
      const fields: JsonField[] = [];
      const names = new Set<string>();
      for (const property of node.children ?? []) {
        const key = property.children?.[0];
        const child = property.children?.[1];
        const name: unknown = key?.value;
        if (
          property.type !== "property" ||
          key?.type !== "string" ||
          typeof name !== "string" ||
          child === undefined
        ) {
          return failure("invalid_json", "Invalid property AST.", property.offset);
        }
        if (names.has(name)) {
          return failure("duplicate_key", "Duplicate decoded JSON field name.", key.offset);
        }
        names.add(name);
        const result = buildValue(child, source);
        if (!result.ok) return result;
        fields.push(Object.freeze({ name, value: result.value }));
      }
      return {
        ok: true,
        value: certifyJson(Object.freeze({ kind: "object", fields: Object.freeze(fields) })),
      };
    }
    case "property":
      return failure("invalid_json", "Unexpected standalone property AST.", node.offset);
  }
}

function parseValidatedText(
  source: string,
  byteLength: number,
  limits: JsonLimits,
): JsonResult<JsonDocument> {
  const scanned = scanWithinLimits(source, limits);
  if (!scanned.ok) return scanned;
  const errors: ParseError[] = [];
  const tree = parseTree(source, errors, {
    disallowComments: true,
    allowTrailingComma: false,
    allowEmptyContent: false,
  });
  const first = errors[0];
  if (first !== undefined)
    return failure("invalid_json", printParseErrorCode(first.error), first.offset);
  if (tree === undefined) return failure("invalid_json", "A JSON value is required.");
  const result = buildValue(tree, source);
  if (!result.ok) return result;
  return { ok: true, value: Object.freeze({ source, byteLength, value: result.value }) };
}

/** Strict UTF-8 + JSON decoding. Source is retained; malformed data never becomes a partial trusted tree. */
export function parseJsonBytes(
  bytes: Uint8Array,
  limits: JsonLimits = DEFAULT_JSON_LIMITS,
): JsonResult<JsonDocument> {
  const validLimits = validateLimits(limits);
  if (!validLimits.ok) return validLimits;
  if (bytes.byteLength > limits.maxBytes)
    return failure("byte_limit", "JSON exceeds the input byte budget.");
  let source: string;
  try {
    // Preserve a BOM in the source so strict JSON rejects it rather than silently discarding bytes.
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error: unknown) {
    if (error instanceof TypeError) return failure("invalid_utf8", "Payload is not valid UTF-8.");
    throw error;
  }
  return parseValidatedText(source, bytes.byteLength, limits);
}

/** Form/source text counterpart. Reject lone surrogates before TextEncoder could replace them. */
export function parseJsonText(
  source: string,
  limits: JsonLimits = DEFAULT_JSON_LIMITS,
): JsonResult<JsonDocument> {
  const validLimits = validateLimits(limits);
  if (!validLimits.ok) return validLimits;
  if (source.length > limits.maxBytes)
    return failure("byte_limit", "JSON exceeds the input byte budget.");
  const invalid = invalidScalarOffset(source);
  if (invalid !== undefined)
    return failure("invalid_unicode", "Source contains an unpaired surrogate.", invalid);
  const byteLength = encoder.encode(source).byteLength;
  if (byteLength > limits.maxBytes)
    return failure("byte_limit", "JSON exceeds the input byte budget.");
  return parseValidatedText(source, byteLength, limits);
}
