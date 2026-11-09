import { expect, it } from "vitest";
import {
  chooseRenderer,
  formatCell,
  pointerCell,
} from "../../../src/features/custom/config/render";
import { decodeConfigValue } from "../../../src/features/custom/config/decode";
import { parseJsonText } from "../../../src/core/json";
import * as d from "../../../src/core/protocol/decoders";
import type { ContentPin, RendererConfig } from "../../../src/features/custom/config/types";
function resource(value: string) {
  const p = d.identifier.decode(d.jsonString(value));
  if (!p.ok) throw new Error("id");
  return p.value;
}
function pin(id: string): ContentPin {
  const n = d.decimal.decode(d.jsonString("1")),
    h = d.digest.decode(d.jsonString("a".repeat(64)));
  if (!n.ok || !h.ok) throw new Error("pin");
  return { resource_id: resource(id), version: n.value, digest: h.value, size_bytes: n.value };
}
function renderer(id: string): RendererConfig {
  const parsed = parseJsonText(
    JSON.stringify({
      config_version: 1,
      kind: "renderer",
      id,
      title: id,
      match: { entity: "fact", key_prefix: "Case.", root_type: "object" },
      presentation: { type: "json", pointer: "" },
      fallback: "generic",
    }),
  );
  if (!parsed.ok) throw new Error("parse");
  const decoded = decodeConfigValue(parsed.value.value);
  if (
    decoded.kind !== "valid" ||
    !("kind" in decoded.document) ||
    decoded.document.kind !== "renderer"
  )
    throw new Error("renderer");
  return decoded.document;
}
it("never chooses ambiguous or wrong-target renderers implicitly and honors exact explicit pins", () => {
  const a = { pin: pin("a"), renderer: renderer("a") },
    b = { pin: pin("b"), renderer: renderer("b") };
  const subject = { entity: "fact" as const, key: "Case.result", value: d.jsonObject([]) };
  expect(chooseRenderer([a, b], subject)).toMatchObject({
    kind: "generic",
    reason: "ambiguous",
    candidates: [a.pin, b.pin],
  });
  expect(chooseRenderer([b, a], subject, a.pin)).toMatchObject({ kind: "renderer", pin: a.pin });
  expect(chooseRenderer([a], { ...subject, key: "case.result" })).toMatchObject({
    kind: "generic",
    reason: "none",
  });
  expect(
    chooseRenderer([a], subject, {
      ...a.pin,
      size_bytes: pin("z").version,
      version: pin("z").version,
      resource_id: resource("missing"),
    }),
  ).toMatchObject({ kind: "generic", reason: "explicit_unavailable" });
});
it("keeps exact numeric lexemes and passive data while explaining missing/wrong-kind cells", () => {
  expect(formatCell(d.jsonNumber("9007199254740993.2300"), { type: "number" })).toEqual({
    kind: "text",
    text: "9007199254740993.2300",
  });
  expect(formatCell(d.jsonString("<script>alert(1)</script>"), { type: "text" })).toEqual({
    kind: "text",
    text: "<script>alert(1)</script>",
  });
  expect(formatCell(d.jsonNull(), { type: "text" }).kind).toBe("unavailable");
  expect(
    pointerCell(d.jsonObject([["present", d.jsonNull()]]), "/missing", { type: "json" }),
  ).toMatchObject({ kind: "unavailable", raw: null });
  expect(
    pointerCell(d.jsonObject([["present", d.jsonNull()]]), "/present", { type: "json" }),
  ).toMatchObject({ kind: "json", value: { kind: "null" } });
  expect(formatCell(d.jsonNumber("0"), { type: "unix_ms" })).toEqual({
    kind: "text",
    text: "1970-01-01T00:00:00.000Z",
  });
  expect(formatCell(d.jsonNumber("8640000000000001"), { type: "unix_ms" }).kind).toBe(
    "unavailable",
  );
});
it("admits only native planning entity refs and integral nonnegative byte counts", () => {
  expect(
    formatCell(d.jsonObject([["kind", d.jsonString("workspace")]]), { type: "entity_ref" }),
  ).toEqual({ kind: "entity", entity: "workspace", id: null });
  expect(
    formatCell(
      d.jsonObject([
        ["kind", d.jsonString("actor")],
        ["id", d.jsonString("actor")],
      ]),
      { type: "entity_ref" },
    ).kind,
  ).toBe("unavailable");
  expect(formatCell(d.jsonNumber("-1"), { type: "bytes" }).kind).toBe("unavailable");
  expect(formatCell(d.jsonNumber("1.5"), { type: "bytes" }).kind).toBe("unavailable");
  expect(formatCell(d.jsonNumber("9007199254740993"), { type: "bytes" })).toEqual({
    kind: "text",
    text: "9007199254740993 bytes",
  });
});
