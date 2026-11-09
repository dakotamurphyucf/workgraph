/** Lossless JSON values. Object fields retain order and never use JS prototypes. */
export type JsonValue =
  | { readonly kind: "null" }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly lexeme: string }
  | { readonly kind: "array"; readonly items: readonly JsonValue[] }
  | { readonly kind: "object"; readonly fields: readonly JsonField[] };

export interface JsonField {
  readonly name: string;
  readonly value: JsonValue;
}

/** A retained source is authoritative; serializing its value is an explicit reformat. */
export interface JsonDocument {
  readonly source: string;
  readonly byteLength: number;
  readonly value: JsonValue;
}

export interface JsonLimits {
  readonly maxBytes: number;
  /** Nested containers including root. Content defaults64; companion wrappers may use96. */
  readonly maxDepth: number;
  /** Counts each value and each object field name. */
  readonly maxNodes: number;
  /** Aggregate UTF-8 bytes in decoded strings and object field names. */
  readonly maxStringBytes: number;
}

export type JsonErrorCode =
  | "invalid_limits"
  | "invalid_utf8"
  | "invalid_unicode"
  | "invalid_json"
  | "duplicate_key"
  | "byte_limit"
  | "depth_limit"
  | "node_limit"
  | "string_limit";

export interface JsonError {
  readonly code: JsonErrorCode;
  readonly message: string;
  /** UTF-16 source offset, when available. Never a protocol byte offset. */
  readonly utf16Offset?: number;
}

export type JsonResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: JsonError };

export const DEFAULT_JSON_LIMITS: JsonLimits = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  maxDepth: 64,
  maxNodes: 100_000,
  maxStringBytes: 4 * 1024 * 1024,
});
