import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parseJsonText } from "../../../src/core/json";
import { structureCodec } from "../../../src/features/custom/config/codecs";
import { decodeConfigSource } from "../../../src/features/custom/config/decode";
import { createTestProcessor } from "../../core/processing-harness";
import { createHash } from "node:crypto";
function raw(text: string) {
  const r = parseJsonText(text);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.value;
}
it("matches every reviewed structural variant without runtime schema compilation", () => {
  const schemaSource = readFileSync(
    new URL("./reviewed-schema.source.txt", import.meta.url),
    "utf8",
  );
  expect(createHash("sha256").update(schemaSource).digest("hex")).toBe(
    "78f72e53362fece940bbb48265b3bde4ac0bcae9acf419112708fc3152dbdbc5",
  );
  const schema: object = JSON.parse(schemaSource) as object;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(schema);
  const formats = [
    "text",
    "multiline",
    "boolean",
    "number",
    "bytes",
    "unix_ms",
    "json",
    "entity_ref",
    "resource_pin",
  ].map((type) => ({ type }));
  const durations = ["ns", "us", "ms", "s"].map((unit) => ({ type: "duration", unit }));
  const enumValue = {
    type: "enum",
    values: ["neutral", "info", "success", "warning", "danger"].map((tone) => ({
      value: tone,
      label: tone,
      tone,
    })),
  };
  const presentations = [
    { type: "json", pointer: "" },
    { type: "markdown", pointer: "/a~1b" },
    ...[
      "plain",
      "ocaml",
      "typescript",
      "javascript",
      "json",
      "bash",
      "yaml",
      "markdown",
      "diff",
    ].map((language) => ({ type: "code", pointer: "", language })),
    {
      type: "table",
      rows: "",
      columns: [{ pointer: "/n", label: "N", format: { type: "number" } }],
    },
    ...[...formats, ...durations, enumValue].map((format) => ({
      type: "fields",
      fields: [{ pointer: "", label: "Value", format }],
    })),
  ];
  for (const presentation of presentations) {
    const value = {
      config_version: 1,
      kind: "renderer",
      id: "fixture",
      title: "Fixture",
      match: { entity: "fact" },
      presentation,
      fallback: "generic",
    };
    const text = JSON.stringify(value);
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    expect(structureCodec.decode(raw(text)).ok).toBe(true);
  }
  const examples: unknown = JSON.parse(
    readFileSync(new URL("./reviewed-examples.json", import.meta.url), "utf8"),
  );
  if (!Array.isArray(examples)) throw new Error("examples");
  for (const example of examples) {
    expect(validate(example)).toBe(true);
    expect(structureCodec.decode(raw(JSON.stringify(example))).ok).toBe(true);
  }
  expect(
    structureCodec.decode(
      raw(
        '{"config_version":1.0,"catalog":{"resource_id":"catalog","version":"1","digest":"' +
          "a".repeat(64) +
          '","size_bytes":"0"}}',
      ),
    ).ok,
  ).toBe(true);
});
it("bounds raw activation and preserves unsupported content while rejecting duplicates and invalid Unicode", async () => {
  const processing = createTestProcessor();
  try {
    for (const source of [
      '{"config_version":1,"config_version":2}',
      '{"config_version":1,"\\u0063onfig_version":2}',
      '"\\ud800"',
      '{"config_version":1,}',
      "/*comment*/{}",
      '"' + "x".repeat(65536) + '"',
    ]) {
      const result = await decodeConfigSource(processing, source);
      expect(result).toMatchObject({ ok: true, value: { kind: "invalid_json" } });
    }
    expect(await decodeConfigSource(processing, Uint8Array.of(0xc3, 0x28))).toMatchObject({
      ok: true,
      value: { kind: "invalid_json" },
    });
    const future = await decodeConfigSource(
      processing,
      '{"config_version":2,"future":{"unknown":9007199254740993}}',
    );
    expect(future).toMatchObject({ ok: true, value: { kind: "unsupported_version" } });
  } finally {
    processing.dispose();
  }
});
