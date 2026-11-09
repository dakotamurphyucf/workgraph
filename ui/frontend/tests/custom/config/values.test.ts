import { describe, expect, it } from "vitest";
import { parseJsonText } from "../../../src/core/json";
import {
  compareNumbers,
  compareText,
  pointerTokens,
  scalarEqual,
  selectPointer,
} from "../../../src/features/custom/config/values";
function value(text: string) {
  const r = parseJsonText(text);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.value;
}
describe("closed config selectors and exact scalar ordering", () => {
  it("uses own decoded fields, literal escapes and bounded exact array positions", () => {
    const data = value('{"__proto__":{"constructor":null},"a/b":{"~01":[900719925474099312345]}}');
    expect(selectPointer(data, "/__proto__/constructor")).toEqual({
      kind: "found",
      value: { kind: "null" },
    });
    expect(selectPointer(data, "/a~1b/~001/0")).toEqual({
      kind: "found",
      value: { kind: "number", lexeme: "900719925474099312345" },
    });
    for (const p of [
      "/a~1b/~001/00",
      "/a~1b/~001/-",
      "/a~1b/~001/900719925474099312345",
      "/toString",
    ])
      expect(selectPointer(data, p).kind).toBe("missing");
    for (const p of ["not/root", "/~2", "/~", "/".repeat(17), "/" + "é".repeat(256), "/\ud800"])
      expect(pointerTokens(p)).toBeNull();
    expect(pointerTokens("/".repeat(16))).toHaveLength(16);
  });
  it("sorts decimal values exactly but keeps typed equality lexical", () => {
    for (const [a, b, result] of [
      ["1", "1.0", 0],
      ["1e0", "1.00", 0],
      ["-0", "0", 0],
      ["900719925474099312345", "900719925474099312344", 1],
      ["1e1000000", "9e999999", 1],
      ["-1e1000000", "-9e999999", -1],
      ["0.001", "0.00101", -1],
      ["1.2300", "1.23", 0],
    ] as const) {
      expect(compareNumbers(a, b)).toBe(result);
      expect(compareNumbers(b, a)).toBe(result === 0 ? 0 : result === 1 ? -1 : 1);
    }
    for (const bad of ["01", "1e", "NaN", "Infinity", "1\n"])
      expect(compareNumbers(bad, "1")).toBeNull();
    expect(scalarEqual({ kind: "number", lexeme: "1" }, { kind: "number", lexeme: "1.0" })).toBe(
      false,
    );
    expect(scalarEqual({ kind: "null" }, { kind: "string", value: "null" })).toBe(false);
    // U+10000 sorts after U+E000 in UTF-8, unlike JS UTF-16 ordering.
    expect(compareText("\u{10000}", "\ue000")).toBe(1);
    expect(compareText("Case", "case")).toBe(-1);
  });
});
