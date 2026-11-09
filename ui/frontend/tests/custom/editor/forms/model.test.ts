import { suggestedSetup } from "../../../../src/features/custom/editor/forms/presets";
import { describe, it, expect } from "vitest";
import { parseJsonText, jsonField, type JsonValue } from "../../../../src/core/json";
import * as d from "../../../../src/core/protocol/decoders";
import { decodeConfigValue } from "../../../../src/features/custom/config/decode";
import {
  arrayEdit,
  at,
  change,
  numberText,
  pathKey,
  textAt,
  variant,
} from "../../../../src/features/custom/editor/forms/model";
import type { FormDraft } from "../../../../src/features/custom/editor/forms";
const json = (source: string): JsonValue => {
  const parsed = parseJsonText(source);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value.value;
};
const draft = (source: string): FormDraft => ({ candidate: json(source), text: {}, errors: [] });
describe("controlled lossless form drafts", () => {
  it("preserves nested future fields and prototype-looking names on an unrelated change", () => {
    const initial = draft(
      '{"title":"Old","scope":{"kind":"project","id":"p","future":{"n":9007199254740993}},"__proto__":{"constructor":false}}',
    );
    const next = change(initial, ["title"], d.jsonString("New"));
    expect(at(next.candidate, ["scope"])).toBe(at(initial.candidate, ["scope"]));
    expect(at(next.candidate, ["__proto__"])).toBe(at(initial.candidate, ["__proto__"]));
    expect(at(initial.candidate, ["title"])).toEqual(d.jsonString("Old"));
    expect(Object.getPrototypeOf(next.text)).toBe(Object.prototype);
  });
  it("retains incomplete negative/exponent/empty input without changing representable JSON", () => {
    for (const text of ["-", "1e", "", "01", "1."]) {
      const before = draft('{"n":7}'),
        next = numberText(before, ["n"], text);
      expect(textAt(next, ["n"])).toBe(text);
      expect(at(next.candidate, ["n"])).toEqual(d.jsonNumber("7"));
      expect(next.errors).toHaveLength(1);
    }
  });
  it("commits exact large numeric lexemes and clears only the repaired error", () => {
    let next = numberText(draft('{"n":7,"m":8}'), ["n"], "-");
    next = numberText(next, ["m"], "1e");
    next = numberText(next, ["n"], "9007199254740993.0e+12");
    expect(at(next.candidate, ["n"])).toEqual(d.jsonNumber("9007199254740993.0e+12"));
    expect(next.errors.map((i) => i.path)).toEqual([["m"]]);
  });
  it("moves unfinished numeric text and errors with reordered/deleted array rows", () => {
    let next = numberText(
      draft('{"columns":[{"width":80},{"width":160},{"width":200}],"other":0}'),
      ["columns", 1, "width"],
      "1e",
    );
    next = numberText(next, ["other"], "-");
    next = arrayEdit(next, ["columns"], [1, 0, 2]);
    expect(textAt(next, ["columns", 0, "width"])).toBe("1e");
    expect(next.errors.map((i) => i.path)).toContainEqual(["columns", "0", "width"]);
    next = arrayEdit(next, ["columns"], [1, 2]);
    expect(next.text).toEqual({ "/other": "-" });
    expect(next.errors.map((i) => i.path)).toEqual([["other"]]);
  });
  it("type changes clear only owned descendant text, preserving sibling edits and future union keys", () => {
    let next = numberText(
      draft(
        '{"match":{"schema":{"id":"s","version":"1","future":true}},"filter":{"value":8,"future":null},"other":0}',
      ),
      ["filter", "value"],
      "-",
    );
    next = numberText(next, ["other"], "1e");
    next = variant(next, ["filter"], ["value"], [["value", d.jsonNull()]]);
    expect(next.text).toEqual({ "/other": "1e" });
    expect(at(next.candidate, ["filter", "future"])).toEqual(d.jsonNull());
    expect(at(next.candidate, ["match", "schema", "future"])).toEqual(d.jsonBoolean(true));
  });
  it("distinguishes omitted optional field, explicit empty string and null", () => {
    const a = draft("{}"),
      b = change(a, ["description"], d.jsonString("")),
      c = change(b, ["description"], d.jsonNull()),
      e = change(c, ["description"], undefined);
    expect(jsonField(a.candidate, "description")).toBeUndefined();
    expect(at(b.candidate, ["description"])).toEqual(d.jsonString(""));
    expect(at(c.candidate, ["description"])).toEqual(d.jsonNull());
    expect(at(e.candidate, ["description"])).toBeUndefined();
  });
  it("escaping supports slash/tilde paths without conflating neighboring fields", () => {
    const initial = draft('{"a/b":{"~n":1},"a":{"b":2}}'),
      next = numberText(initial, ["a/b", "~n"], "-");
    expect(pathKey(["a/b", "~n"])).toBe("/a~1b/~0n");
    expect(textAt(next, ["a/b", "~n"])).toBe("-");
    expect(textAt(next, ["a", "b"])).toBe("2");
  });
  it("unknown versions and unknown closed fields remain decoder failures, never sanitized", () => {
    const unknown = draft('{"config_version":99,"kind":"view","future":null}');
    expect(decodeConfigValue(unknown.candidate).kind).toBe("unsupported_version");
    const known = change(unknown, ["config_version"], d.jsonNumber("1"));
    expect(decodeConfigValue(known.candidate).kind).toBe("invalid");
    expect(at(known.candidate, ["future"])).toEqual(d.jsonNull());
  });
});

describe("explicit suggested source setup", () => {
  it.each([
    "tickets",
    "runs",
    "attempts",
    "sessions",
    "resources",
    "facts",
    "discussions",
    "activity",
  ] as const)("builds valid %s columns without replacing identity", (source) => {
    const initial = draft(
      JSON.stringify({
        config_version: 1,
        kind: "view",
        id: "my-view",
        title: "My work",
        source,
        scope: { kind: "project", id: "p" },
        filter_mode: "loaded",
        filters: [],
        sort: [],
        group_by: null,
        presentation: "table",
        columns: [],
      }),
    );
    const result = suggestedSetup(initial, source);
    const decoded = decodeConfigValue(result.candidate);
    expect(decoded.kind, JSON.stringify(decoded)).toBe("valid");
    expect(at(result.candidate, ["id"])).toEqual(d.jsonString("my-view"));
    expect(at(result.candidate, ["title"])).toEqual(d.jsonString("My work"));

    if (source === "sessions")
      expect(at(result.candidate, ["columns", 1, "format", "type"])).toEqual(
        d.jsonString("unix_ms"),
      );
    expect(at(initial.candidate, ["columns"])).toEqual(d.jsonArray([]));
  });
});

it("suggested setup preserves unknown fields for repair instead of silently accepting or deleting them", () => {
  const initial = draft(
    '{"id":"view","source":"runs","future":{"n":9007199254740993},"scope":{"kind":"project","id":"p","future":"retained"}}',
  );
  const next = suggestedSetup(initial, "runs");
  expect(at(next.candidate, ["future"])).toBe(at(initial.candidate, ["future"]));
  expect(at(next.candidate, ["scope", "future"])).toEqual(d.jsonString("retained"));
  expect(at(next.candidate, ["scope", "kind"])).toEqual(d.jsonString("workspace"));
  expect(at(next.candidate, ["scope", "id"])).toBeUndefined();
  expect(decodeConfigValue(next.candidate).kind).toBe("invalid");
});
