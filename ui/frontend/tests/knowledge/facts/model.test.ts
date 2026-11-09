import { afterEach, describe, expect, it } from "vitest";
import { jsonField, canonicalJson } from "../../../src/core/json";
import * as d from "../../../src/core/protocol/decoders";
import {
  copyInput,
  copyQuery,
  decimal,
  parseValue,
  prepareDraft,
  valueAt,
} from "../../../src/features/knowledge/facts/model";
import { factObservationCodec } from "../../../src/features/knowledge/facts/codecs";
import type { FactDraft } from "../../../src/features/knowledge/facts/types";
import { createTestProcessor } from "../../core/processing-harness";
import { decode, record, response, source, target } from "./fixtures";
const processors: ReturnType<typeof createTestProcessor>[] = [];
const processor = () => {
  const p = createTestProcessor();
  processors.push(p);
  return p;
};
afterEach(() => {
  for (const p of processors.splice(0)) p.dispose();
});
const draft = (text: string): FactDraft => ({
  id: decode(d.identifier, "draft"),
  target,
  key: "settings",
  writer: { actorId: decode(d.identifier, "author"), runId: null },
  base: {
    target,
    value: decode(factObservationCodec, record),
    response: response(record),
    revision: decimal("7"),
    partial: false,
  },
  input: { source: text, references: { kind: "preserve" } },
  method: "fact.put",
  phase: { kind: "editing" },
  current: null,
  issue: null,
  unexpected: null,
});
describe("Whole-value fact editing", () => {
  it("admits any JSON root, canonical4096 bytes and exact16 containers; whitespace is not value size", async () => {
    const p = processor();
    for (const text of [
      "null",
      "false",
      "900719925474099312345",
      '"literal"',
      "[]",
      '{"__proto__":null}',
    ])
      expect(canonicalJson(await parseValue(p, text))).toEqual(canonicalJson(source(text)));
    expect((await parseValue(p, " ".repeat(5000) + '"' + "a".repeat(4094) + '"')).kind).toBe(
      "string",
    );
    await expect(parseValue(p, '"' + "a".repeat(4095) + '"')).rejects.toThrow();
    await expect(parseValue(p, "[".repeat(17) + "null" + "]".repeat(17))).rejects.toThrow();
    expect((await parseValue(p, "[".repeat(16) + "null" + "]".repeat(16))).kind).toBe("array");
    await expect(parseValue(p, '{"a":1,"\\u0061":2}')).rejects.toThrow();
  });
  it("preserves omission vs explicit reference clearing and per-key guards vs planning revision", async () => {
    const p = processor(),
      base = draft("null");
    const kept = await prepareDraft(base, p);
    expect(jsonField(kept.params, "expected_revision")).toEqual(d.jsonString("1"));
    expect(jsonField(kept.params, "references")).toBeUndefined();
    expect(jsonField(kept.params, "value")).toEqual(d.jsonNull());
    const clear = await prepareDraft(
      { ...base, input: { source: "true", references: { kind: "replace", items: [] } } },
      p,
    );
    expect(jsonField(clear.params, "references")).toEqual(d.jsonArray([]));
    const missing = decode(factObservationCodec, {
      scope: { kind: "workspace" },
      key: "settings",
      missing: true,
    });
    expect(
      jsonField(
        (await prepareDraft({ ...base, base: { ...base.base, value: missing } }, p)).params,
        "expected_revision",
      ),
    ).toEqual(d.jsonString("0"));
    await expect(
      prepareDraft({ ...base, base: { ...base.base, partial: true } }, p),
    ).rejects.toThrow("incomplete");
    await expect(
      prepareDraft({ ...base, method: "fact.delete", base: { ...base.base, value: missing } }, p),
    ).rejects.toThrow("existing active");
  });
  it("copies reference inputs before mutation and validates literal predicates without expressions", () => {
    const refs = [{ kind: "ticket" as const, id: decode(d.identifier, "ticket") }],
      copied = copyInput({ source: "null", references: { kind: "replace", items: refs } });
    refs[0] = { kind: "ticket", id: decode(d.identifier, "changed") };
    expect(copied.references).toEqual({
      kind: "replace",
      items: [{ kind: "ticket", id: "ticket" }],
    });
    const scalar = { kind: "number" as const, lexeme: "1.0" },
      query = copyQuery({
        prefix: "Case.",
        includeDeleted: false,
        predicates: [{ pointer: "/a~1b/~0", equals: scalar }],
      });
    scalar.lexeme = "1";
    expect(query.predicates[0]?.equals).toEqual({ kind: "number", lexeme: "1.0" });
    for (const pointer of ["a", "/~2", "/".repeat(17)])
      expect(() =>
        copyQuery({
          prefix: "",
          includeDeleted: false,
          predicates: [{ pointer, equals: d.jsonNull() }],
        }),
      ).toThrow();
    expect(() =>
      copyQuery({
        prefix: "",
        includeDeleted: false,
        predicates: [{ pointer: "", equals: d.jsonObject([]) }],
      }),
    ).toThrow();
    expect(valueAt(source('{"a/b":{"~":null},"n":1.0}'), "/a~1b/~0")).toEqual(d.jsonNull());
    expect(valueAt(source('{"present":null}'), "/missing")).toBeUndefined();
  });
});
