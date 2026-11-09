import { describe, expect, it } from "vitest";
import { compareSources, projectJson } from "../../../src/features/knowledge/viewers/projection";
import { readReply, readRequest } from "../../../src/features/knowledge/viewers/wire";
import type { ContentSource } from "../../../src/content/types";
const source = (text: string): ContentSource => ({
  key: text.slice(0, 100),
  label: "synthetic",
  bytes: new TextEncoder().encode(text),
  completeness: "complete",
  hints: { mime: "application/json" },
});
describe("lossless bounded projections", () => {
  it("retains huge numbers, numeric lexemes, null, string and prototype-looking keys", () => {
    const tree = projectJson(
      source(
        '{"__proto__":{"x":9007199254740993},"n":1.2300,"zero":-0,"exp":1e1000,"s":"9007199254740993","nil":null}',
      ).bytes,
      [],
      0,
    );
    expect(tree.rows.map((r) => [r.label, r.type, r.preview])).toEqual([
      ["(root)", "object", "{6 fields}"],
      ["__proto__", "object", "{1 fields}"],
      ["x", "number", "9007199254740993"],
      ["n", "number", "1.2300"],
      ["zero", "number", "-0"],
      ["exp", "number", "1e1000"],
      ["s", "string", "“9007199254740993”"],
      ["nil", "null", "null"],
    ]);
  });
  it.each(['{"x":1,"x":1}', '{"x":1,"\\u0078":2}', '{"x":"\\ud800"}', "{"])(
    "rejects malformed/ambiguous JSON %s",
    (text) => expect(() => projectJson(source(text).bytes, [], 0)).toThrow(),
  );
  it("rejects invalidUTF8/depth and limits mounted rows without silently dropping continuation", () => {
    expect(() => projectJson(new Uint8Array([0xc0, 0xaf]), [], 0)).toThrow();
    expect(() => projectJson(source("[".repeat(65) + "0" + "]".repeat(65)).bytes, [], 0)).toThrow();
    const bytes = source(
      "[" + Array.from({ length: 2200 }, (_, i) => String(i)).join(",") + "]",
    ).bytes;
    const a = projectJson(bytes, [], 0),
      b = projectJson(bytes, [], 2000);
    expect([a.rows.length, a.totalRows, b.rows.length, b.rows[0]?.label]).toEqual([
      2000,
      2201,
      201,
      "1999",
    ]);
  });
  it("bounds long numeric previews while raw lexeme remains authoritative", () => {
    const bytes = source("1".repeat(2000)).bytes,
      tree = projectJson(bytes, [], 0);
    expect(tree.rows[0]?.preview.length).toBe(1025);
    expect(tree.rows[0]?.preview.endsWith("…")).toBe(true);
    expect(
      readReply({ protocol: 1, id: "v1", key: "k", kind: "complete", value: tree }),
    ).not.toBeNull();
    expect(bytes.length).toBe(2000);
  });
  it("escapes JSON pointers and collapses/expands without evaluating property names", () => {
    const bytes = source('{"a/b":{"~":{"leaf":1}}}').bytes;
    expect(projectJson(bytes, [], 0).rows.at(-1)?.pointer).toBe("/a~1b/~0");
    expect(projectJson(bytes, ["/a~1b/~0"], 0).rows.at(-1)?.preview).toBe("1");
    expect(projectJson(bytes, ["!/a~1b"], 0).rows.length).toBe(2);
  });
  it("keeps huge keys visible but marks unaddressable bounded pointers unavailable", () => {
    const bytes = source('{"' + "x".repeat(600) + '":{"a":1}}').bytes;
    const tree = projectJson(bytes, [], 0);
    expect(tree.rows[1]?.pointer).toBeNull();
    expect(tree.rows[1]?.children).toBe(1);
    expect(tree.rows[1]?.expanded).toBe(false);
  });
  it("compares lexical numbers, missing/null and array order; object ordering alone is formatting", () => {
    const diff = compareSources(
      source('{"a":null,"n":1,"items":[1,2]}'),
      source('{"n":1.0,"items":[2,1]}'),
      "json",
    );
    expect(diff.kind).toBe("json-diff");
    if (diff.kind === "json-diff")
      expect(diff.changes.map((c) => [c.pointer, c.kind, c.before, c.after])).toEqual([
        ["/a", "removed", "null", null],
        ["/n", "changed", "1", "1.0"],
        ["/items/0", "changed", "1", "2"],
        ["/items/1", "changed", "2", "1"],
      ]);
    expect(compareSources(source('{"a":1,"b":2}'), source('{ "b":2, "a":1 }'), "json")).toEqual({
      kind: "json-diff",
      changes: [],
      formattingOnly: true,
    });
  });
  it("computes real line edits and refuses expensive or partial comparisons", () => {
    expect(compareSources(source("alpha\nbeta\n"), source("alpha\ngamma\n"), "text")).toEqual({
      kind: "text",
      rows: [
        { kind: "equal", left: 1, right: 1, text: "alpha" },
        { kind: "removed", left: 2, right: null, text: "beta" },
        { kind: "added", left: null, right: 2, text: "gamma" },
        { kind: "equal", left: 3, right: 3, text: "" },
      ],
    });
    expect(() =>
      compareSources(source("x\n".repeat(1100)), source("y\n".repeat(1100)), "text"),
    ).toThrow("one million");
    expect(() =>
      compareSources({ ...source("{}"), completeness: "partial" }, source("{}"), "json"),
    ).toThrow("partial");
  });
  it("validates own projections through closed worker wire; rejects extra keys and overlarge flat output", () => {
    const bytes = source('{"x":1}').bytes,
      value = projectJson(bytes, [], 0);
    expect(readReply({ protocol: 1, id: "v1", key: "k", kind: "complete", value })).not.toBeNull();
    expect(
      readReply({
        protocol: 1,
        id: "v1",
        key: "k",
        kind: "complete",
        value: { ...value, extra: true },
      }),
    ).toBeNull();
    expect(
      readReply({
        protocol: 1,
        id: "v1",
        key: "k",
        kind: "complete",
        value: { ...value, rows: Array(2001).fill(value.rows[0]), totalRows: 2001 },
      }),
    ).toBeNull();
    expect(
      readRequest({
        protocol: 1,
        id: "v1",
        key: "wrong",
        job: { kind: "json", source: source("{}"), expanded: [], offset: 0 },
      }),
    ).toBeNull();
  });
});
