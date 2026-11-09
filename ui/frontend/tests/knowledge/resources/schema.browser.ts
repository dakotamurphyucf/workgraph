import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import { test, expect } from "@playwright/test";
import { fixtureBinary } from "../../../../test-support/daemon-fixture.mjs";
import { createTestProcessor } from "../../core/processing-harness";
import { context, decode } from "../../work/actions-fixtures";
import type { HttpClient } from "../../../src/core/protocol/http";
import * as d from "../../../src/core/protocol/decoders";
import {
  resourcePreparation,
  type ResourceEditDraft,
} from "../../../src/features/knowledge/resources/drafts";
const execute = promisify(execFile);
// Offline executable schema parity. No browser or daemon mutation is involved.
// eslint-disable-next-line no-empty-pattern
test("all five Resource form commands preserve native attribution, guards, omission and target variants", async ({}, info) => {
  const processing = createTestProcessor(),
    ctx = context({} as HttpClient),
    ajv = new Ajv2020({ strict: false, allErrors: true }),
    pending = new Map<string, ResourceEditDraft[]>(),
    proofs: { method: string; variants: number; schemaSha256: string }[] = [];
  ajv.addKeyword({
    keyword: "x-maxUtf8Bytes",
    type: "string",
    validate: (max: number, value: string) => Buffer.byteLength(value) <= max,
  });
  ajv.addKeyword({
    keyword: "x-maximumDecimal",
    type: "string",
    validate: (max: string, value: string) =>
      /^(0|[1-9][0-9]*)$/u.test(value) && BigInt(value) <= BigInt(max),
  });
  const base: ResourceEditDraft = {
    id: decode(d.identifier, "resource-form"),
    kind: "text",
    scope: { connection: ctx.connection, workspaceId: decode(d.identifier, "demo") },
    writer: { actorId: decode(d.identifier, "author"), runId: decode(d.identifier, "run") },
    projectId: null,
    base: null,
    expectedRevision: decode(d.decimal, "9007199254740993"),
    input: {
      resourceId: "artifact",
      title: "Synthetic document",
      filename: "document.md",
      mimeType: "text/markdown",
      description: "",
      text: "# Document\n",
      changes: { title: false, filename: false, mimeType: false, description: false },
      target: { kind: "workspace", id: "" },
      archived: false,
    },
    phase: "editing",
    issue: null,
    unexpected: null,
  };
  function add(draft: ResourceEditDraft) {
    const method = resourcePreparation(draft).method;
    pending.set(method, [...(pending.get(method) ?? []), draft]);
  }
  add(base);
  add({ ...base, writer: { ...base.writer, runId: null }, input: { ...base.input, text: "" } });
  for (const key of ["title", "filename", "mimeType", "description"] as const)
    add({
      ...base,
      kind: "metadata",
      input: { ...base.input, changes: { ...base.input.changes, [key]: true } },
    });
  add({
    ...base,
    kind: "metadata",
    input: {
      ...base.input,
      description: "Replacement",
      changes: { title: true, filename: true, mimeType: true, description: true },
    },
  });
  for (const kind of ["link", "unlink"] as const)
    for (const target of ["workspace", "project", "milestone", "ticket", "resource"] as const)
      add({
        ...base,
        kind,
        input: {
          ...base.input,
          target: { kind: target, id: target === "workspace" ? "" : "target" },
        },
      });
  for (const archived of [true, false])
    add({ ...base, kind: "archive", input: { ...base.input, archived } });
  try {
    for (const [method, variants] of pending) {
      const { stdout } = await execute(fixtureBinary(), ["schema", method], {
          timeout: 10000,
          maxBuffer: 8 * 1024 * 1024,
        }),
        schema = (JSON.parse(stdout) as { methods: { params: object }[] }).methods[0]?.params;
      if (!schema) throw new Error(`Missing exact native schema: ${method}`);
      const validate = ajv.compile(schema);
      for (const variant of variants) {
        const encoded = await processing.encode(resourcePreparation(variant).params);
        if (!encoded.ok || !encoded.value.ok)
          throw new Error("Resource preparation encoding failed");
        const params: object = {
          ...(JSON.parse(encoded.value.value) as object),
          mutation_id: "resource-schema",
        };
        expect(validate(params), `${method}: ${JSON.stringify(validate.errors)}`).toBe(true);
        expect(validate({ ...params, invented_guard: "1" })).toBe(false);
      }
      proofs.push({
        method,
        variants: variants.length,
        schemaSha256: createHash("sha256").update(stdout).digest("hex"),
      });
    }
    expect(proofs).toHaveLength(5);
    await info.attach("resource-form-native-schema.json", {
      body: JSON.stringify(proofs, null, 2),
      contentType: "application/json",
    });
  } finally {
    processing.dispose();
  }
});
