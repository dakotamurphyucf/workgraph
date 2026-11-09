import { describe, expect, it } from "vitest";
import { createScanner } from "jsonc-parser";
import {
  DEFAULT_JSON_LIMITS,
  jsonField,
  parseJsonBytes,
  parseJsonText,
  stringifyJson,
  type JsonErrorCode,
  type JsonLimits,
  type JsonValue,
} from "../../src/core/json";

function decoded(source: string): JsonValue {
  const result = parseJsonText(source);
  if (!result.ok) throw new Error(result.error.message);
  return result.value.value;
}

function expectError(source: string, code: JsonErrorCode, limits?: JsonLimits): void {
  const result = parseJsonText(source, limits);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}

describe("lossless JSON boundary", () => {
  it("checks the pinned scanner token contract without ambient const enum imports", () => {
    const scanner = createScanner('{}[],:null true false "" 0 //x\n/*x*/?', false);
    const tokens: number[] = [];
    for (let index = 0; index < 40; index += 1) {
      const token: number = scanner.scan();
      tokens.push(token);
      if (token === 17) break;
    }
    expect(tokens).toEqual([
      1, 2, 3, 4, 5, 6, 7, 15, 8, 15, 9, 15, 10, 15, 11, 15, 12, 14, 13, 16, 17,
    ]);
  });

  it("retains source and arbitrary number lexemes through explicit reformatting", () => {
    const source =
      ' {"large":9007199254740993,"decimal":1.2300,"zero":-0,"exponent":1e1000,"string":"9007199254740993"} ';
    const result = parseJsonBytes(new TextEncoder().encode(source));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source).toBe(source);
    expect(jsonField(result.value.value, "large")).toEqual({
      kind: "number",
      lexeme: "9007199254740993",
    });
    expect(jsonField(result.value.value, "exponent")).toEqual({ kind: "number", lexeme: "1e1000" });
    expect(jsonField(result.value.value, "string")).toEqual({
      kind: "string",
      value: "9007199254740993",
    });
    expect(stringifyJson(result.value.value)).toEqual({ ok: true, value: source.trim() });
    expect(Object.isFrozen(result.value.value)).toBe(true);
  });

  it.each(['{"x":1,"x":1}', '{"x":1,"\\u0078":2}', '{"outer":{"a":null,"a":true}}'])(
    "rejects every duplicate decoded key: %s",
    (source) => expectError(source, "duplicate_key"),
  );

  it("keeps prototype-like keys, field order and absent versus null", () => {
    const value = decoded('{"__proto__":{"polluted":true},"constructor":null,"toString":false}');
    expect(jsonField(value, "constructor")).toEqual({ kind: "null" });
    expect(jsonField(value, "missing")).toBeUndefined();
    expect(jsonField(value, "__proto__")?.kind).toBe("object");
    expect(value.kind === "object" && value.fields.map((field) => field.name)).toEqual([
      "__proto__",
      "constructor",
      "toString",
    ]);
    expect(jsonField(decoded("[]"), "constructor")).toBeUndefined();
  });

  it.each([
    "",
    " ",
    '{"x":1,}',
    "//comment\n1",
    "/*comment*/null",
    "01",
    "1.",
    "+1",
    "NaN",
    "[1 2]",
    "{}{}",
    "{]",
    '"bad\nline"',
    "\ufeff{}",
  ])("rejects fault-tolerant or non-JSON input: %s", (source) =>
    expectError(source, "invalid_json"),
  );

  it("rejects invalid UTF-8, raw lone surrogates and escaped lone surrogates", () => {
    const bytes = parseJsonBytes(new Uint8Array([0x22, 0xc3, 0x28, 0x22]));
    expect(!bytes.ok && bytes.error.code).toBe("invalid_utf8");
    expectError('"\ud800"', "invalid_unicode");
    expectError('"\\ud800"', "invalid_unicode");
    expectError('{"\\udfff":0}', "invalid_unicode");
    expect(decoded('"\\ud83d\\ude00"')).toEqual({ kind: "string", value: "😀" });
    expect(decoded('"é😀"')).toEqual({ kind: "string", value: "é😀" });
  });

  it("bounds depth before the recursive parser and counts field names in node budgets", () => {
    expect(parseJsonText("[".repeat(64) + "0" + "]".repeat(64)).ok).toBe(true);
    expectError("[".repeat(65) + "0" + "]".repeat(65), "depth_limit");
    expectError("[0,1,2]", "node_limit", { ...DEFAULT_JSON_LIMITS, maxNodes: 3 });
    expectError('{"x":0}', "node_limit", { ...DEFAULT_JSON_LIMITS, maxNodes: 2 });
    expect(parseJsonText('{"x":0}', { ...DEFAULT_JSON_LIMITS, maxNodes: 3 }).ok).toBe(true);
  });

  it("uses UTF-8 byte budgets and aggregate decoded strings rather than character counts", () => {
    expectError('"é"', "byte_limit", { ...DEFAULT_JSON_LIMITS, maxBytes: 3 });
    expect(parseJsonText('"é"', { ...DEFAULT_JSON_LIMITS, maxBytes: 4 }).ok).toBe(true);
    expectError('["é","é"]', "string_limit", { ...DEFAULT_JSON_LIMITS, maxStringBytes: 3 });
    expectError('{"é":"é"}', "string_limit", { ...DEFAULT_JSON_LIMITS, maxStringBytes: 3 });
    expectError("null", "invalid_limits", { ...DEFAULT_JSON_LIMITS, maxDepth: 97 });
  });

  it("rejects UTF-8 BOM bytes and mismatched containers without accepting partial ASTs", () => {
    const bom = parseJsonBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]));
    expect(!bom.ok && bom.error.code).toBe("invalid_json");
    expectError("{]".repeat(100), "invalid_json");
    expectError("[{", "invalid_json");
    expect(parseJsonBytes(new Uint8Array(5), { ...DEFAULT_JSON_LIMITS, maxBytes: 4 }).ok).toBe(
      false,
    );
  });

  it("freezes nested parsed fields and bounds cycles in constructed trees", () => {
    const value = decoded('{"x":[1]}');
    expect(value.kind === "object" && Object.isFrozen(value.fields)).toBe(true);
    const nested = jsonField(value, "x");
    expect(nested?.kind === "array" && Object.isFrozen(nested.items)).toBe(true);
    const items: JsonValue[] = [];
    const cycle: JsonValue = { kind: "array", items };
    items.push(cycle);
    const result = stringifyJson(cycle);
    expect(!result.ok && result.error.code).toBe("depth_limit");
  });

  it("validates manually constructed values before encoding", () => {
    for (const lexeme of ["NaN", "1\n", "01", "Infinity"]) {
      expect(stringifyJson({ kind: "number", lexeme }).ok).toBe(false);
    }
    expect(stringifyJson({ kind: "string", value: "\ud800" }).ok).toBe(false);
    const duplicate: JsonValue = {
      kind: "object",
      fields: [
        { name: "x", value: { kind: "null" } },
        { name: "x", value: { kind: "null" } },
      ],
    };
    expect(stringifyJson(duplicate).ok).toBe(false);
    expect(
      stringifyJson(
        { kind: "array", items: [decoded("1"), decoded("2")] },
        { ...DEFAULT_JSON_LIMITS, maxNodes: 2 },
      ).ok,
    ).toBe(false);
  });

  it("roundtrips independently specified fixture values without interpreting numbers", () => {
    for (const source of [
      "null",
      "false",
      "[true,1e-1000,{},[]]",
      '{"a/b":"~0","empty":"","n":-123456789012345678901234567890}',
      '"\\u0000\\t\\n"',
    ]) {
      const value = decoded(source);
      const encoded = stringifyJson(value);
      expect(encoded.ok).toBe(true);
      if (encoded.ok) expect(decoded(encoded.value)).toEqual(value);
    }
  });
});
