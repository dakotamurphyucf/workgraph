import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import { test, expect } from "@playwright/test";
import { fixtureBinary } from "../../../../test-support/daemon-fixture.mjs";
import { COMMANDS, READS } from "../../../src/features/workflow/evidence/commands";
import { initialReadInputs, readParams } from "../../../src/features/workflow/evidence/reads";
import { preparation } from "../../../src/features/workflow/evidence/model";
import type { HttpClient } from "../../../src/core/protocol/http";
import { createTestProcessor } from "../../core/processing-harness";
import { pinExamples, syntheticJson, validDraft } from "./valid-forms";
const execute = promisify(execFile);
// Playwright requires a destructured fixture argument; this offline parity check needs no browser.
// eslint-disable-next-line no-empty-pattern
test("all evidence authoring forms and structured variants match fresh executable request schemas", async ({}, info) => {
  const processing = createTestProcessor(),
    http: HttpClient = {
      processing,
      request: () => Promise.reject(new Error("Parity must not send HTTP")),
    },
    ajv = new Ajv2020({ strict: false, allErrors: true }),
    checks: unknown[] = [];
  ajv.addKeyword({
    keyword: "x-maxUtf8Bytes",
    type: "string",
    validate: (maximum: number, value: string) => Buffer.byteLength(value) <= maximum,
  });
  ajv.addKeyword({
    keyword: "x-maximumDecimal",
    type: "string",
    validate: (maximum: string, value: string) =>
      /^(0|[1-9][0-9]*)$/u.test(value) && BigInt(value) <= BigInt(maximum),
  });
  try {
    for (const command of COMMANDS) {
      const { stdout } = await execute(fixtureBinary(), ["schema", command.method], {
          maxBuffer: 8 * 1024 * 1024,
        }),
        schema = (JSON.parse(stdout) as { methods: { params: object }[] }).methods[0]?.params;
      if (schema === undefined) throw new Error(`Missing ${command.method} schema`);
      const validate = ajv.compile(schema),
        original = await validDraft(http, command.method),
        variants = [original];
      for (const field of command.fields) {
        if (field.optional)
          variants.push({
            ...original,
            inputs: {
              ...original.inputs,
              [field.name]: {
                presence: "omit" as const,
                text: original.inputs[field.name]?.text ?? "",
              },
            },
          });
        if (["artifact", "rationale", "previous", "current"].includes(field.name))
          for (const pin of pinExamples)
            variants.push({
              ...original,
              inputs: {
                ...original.inputs,
                [field.name]: { presence: "value" as const, text: JSON.stringify(pin) },
              },
            });
        if (["inputs", "outputs"].includes(field.name))
          for (const pin of pinExamples)
            variants.push({
              ...original,
              inputs: {
                ...original.inputs,
                [field.name]: {
                  presence: "value" as const,
                  text: JSON.stringify([{ name: "artifact", pin }]),
                },
              },
            });
        if (field.name === "evidence_pins" || (field.name === "evidence" && field.type === "json"))
          for (const pin of pinExamples)
            variants.push({
              ...original,
              inputs: {
                ...original.inputs,
                [field.name]: { presence: "value" as const, text: JSON.stringify([pin]) },
              },
            });
        if (field.name === "scope")
          for (const scope of command.method === "acceptance.policy.put"
            ? [
                { kind: "ticket", ticket_id: "target" },
                { kind: "project", project_id: "project" },
              ]
            : [
                { kind: "workspace" },
                { kind: "project", project_id: "project" },
                { kind: "milestone", milestone_id: "milestone" },
                { kind: "ticket", ticket_id: "target" },
                { kind: "resource", resource_id: "resource" },
              ])
            variants.push({
              ...original,
              inputs: {
                ...original.inputs,
                scope: { presence: "value" as const, text: JSON.stringify(scope) },
              },
            });
        if (field.name === "disposition")
          for (const disposition of [
            { kind: "acknowledge" },
            { kind: "continue", reason: "Actual historical input check" },
            { kind: "revised", manifest: { manifest_id: "revised", revision: "2" } },
          ])
            variants.push({
              ...original,
              inputs: {
                ...original.inputs,
                disposition: { presence: "value" as const, text: JSON.stringify(disposition) },
              },
            });
      }
      for (const draft of variants) {
        const captured = await preparation(processing, draft, new AbortController().signal),
          encoded = await processing.encode(captured.params);
        if (!encoded.ok || !encoded.value.ok) throw new Error("Invalid fixture source");
        const value = {
          ...(syntheticJson(encoded.value.value) as object),
          mutation_id: "native-form-parity",
        };
        expect(validate(value), `${command.method}: ${JSON.stringify(validate.errors)}`).toBe(true);
        expect(validate({ ...(value as object), unexpected_field: true })).toBe(false);
      }
      checks.push({ method: command.method, variants: variants.length, passed: true });
    }
    for (const method of READS) {
      const { stdout } = await execute(fixtureBinary(), ["schema", method], {
          maxBuffer: 8 * 1024 * 1024,
        }),
        schema = (JSON.parse(stdout) as { methods: { params: object }[] }).methods[0]?.params;
      if (schema === undefined) throw new Error(`Missing read schema ${method}`);
      const validate = ajv.compile(schema),
        params = readParams(method, "demo", "target", {
          ...initialReadInputs,
          objectId: "record",
          version: "1",
          manifestId: "manifest",
          manifestRevision: "1",
          scopeId: "target",
          reviewerId: "reviewer",
        }),
        encoded = await processing.encode(params);
      if (!encoded.ok || !encoded.value.ok) throw new Error("Invalid read selector fixture");
      expect(
        validate(syntheticJson(encoded.value.value)),
        `${method}: ${JSON.stringify(validate.errors)}`,
      ).toBe(true);
      checks.push({ method, variants: 1, passed: true });
    }
    await info.attach("native-request-schema-parity", {
      body: JSON.stringify(checks, null, 2),
      contentType: "application/json",
    });
  } finally {
    processing.dispose();
  }
});
