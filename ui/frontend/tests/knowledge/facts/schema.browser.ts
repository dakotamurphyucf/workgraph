import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import { test, expect } from "@playwright/test";
import { fixtureBinary } from "../../../../test-support/daemon-fixture.mjs";
import { jsonField } from "../../../src/core/json";
import * as d from "../../../src/core/protocol/decoders";
import type { HttpClient, HttpRequest, HttpResult } from "../../../src/core/protocol/http";
import type { JsonObject } from "../../../src/core/protocol/types";
import { createFactsClient } from "../../../src/features/knowledge/facts/client";
import { factObservationCodec } from "../../../src/features/knowledge/facts/codecs";
import { decimal, identifier, prepareDraft } from "../../../src/features/knowledge/facts/model";
import type { FactDraft, FactScope } from "../../../src/features/knowledge/facts/types";
import { createTestProcessor } from "../../core/processing-harness";
import { decode, record, response, target } from "./fixtures";
const execute = promisify(execFile);
// Offline request-schema parity; it never opens a browser or sends a daemon mutation.
// eslint-disable-next-line no-empty-pattern
test("Facts structured/raw authoring and selectors match fresh native request schemas", async ({}, info) => {
  const processing = createTestProcessor(),
    pending = new Map<string, JsonObject[]>(),
    ajv = new Ajv2020({ strict: false, allErrors: true }),
    checks: { method: string; variants: number }[] = [];
  const save = (method: string, params: JsonObject) => {
    const values = pending.get(method) ?? [];
    values.push(params);
    pending.set(method, values);
  };
  const http: HttpClient = {
    processing,
    request: <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
      const body = request.body,
        method = body === undefined ? undefined : jsonField(body, "method"),
        params = body === undefined ? undefined : jsonField(body, "params");
      if (method?.kind !== "string" || params?.kind !== "object")
        throw new Error("Expected fact invocation");
      save(method.value, params);
      return Promise.resolve({ ok: false, failure: { kind: "aborted" } });
    },
  };
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
  try {
    const scopes: FactScope[] = [
        { kind: "workspace" },
        { kind: "project", id: identifier("project") },
        { kind: "milestone", id: identifier("milestone") },
        { kind: "ticket", id: identifier("ticket") },
      ],
      api = createFactsClient(http);
    for (const scope of scopes) {
      const captured = { ...target, scope };
      for (const source of [
        "null",
        "true",
        "900719925474099312345",
        "1.0",
        '"literal $value"',
        "[1,null]",
        '{"__proto__":{"constructor":null}}',
      ]) {
        const draft: FactDraft = {
          id: identifier("draft"),
          target: captured,
          key: "settings",
          writer: { actorId: identifier("author"), runId: null },
          base: {
            target: captured,
            value: decode(factObservationCodec, { ...record, scope }),
            revision: decimal("7"),
            response: response(record),
            partial: false,
          },
          input: { source, references: { kind: "preserve" } },
          method: "fact.put",
          phase: { kind: "editing" },
          current: null,
          issue: null,
          unexpected: null,
        };
        save("fact.put", (await prepareDraft(draft, processing)).params);
        if (source === "null") {
          for (const refs of [
            [],
            [
              { kind: "ticket" as const, id: "ticket" },
              { kind: "resource" as const, id: "proof" },
            ],
          ])
            save(
              "fact.put",
              (
                await prepareDraft(
                  {
                    ...draft,
                    writer: { actorId: identifier("author"), runId: identifier("run") },
                    input: { source, references: { kind: "replace", items: refs } },
                  },
                  processing,
                )
              ).params,
            );
          save(
            "fact.delete",
            (await prepareDraft({ ...draft, method: "fact.delete" }, processing)).params,
          );
        }
      }
      for (const predicates of [
        [],
        [{ pointer: "/literal~1key/~0", equals: d.jsonNull() }],
        [{ pointer: "", equals: d.jsonNumber("1.0") }],
      ] as const) {
        await api.keys(captured, { prefix: "Case.", includeDeleted: true, predicates });
        await api.keys(
          captured,
          { prefix: "", includeDeleted: false, predicates },
          { offset: decimal("100"), atRevision: decimal("7") },
        );
      }
      await api.multiGet(captured, ["missing", "settings", "missing"]);
      await api.multiGet(captured, ["a", "b"], { offset: decimal("1"), atRevision: decimal("7") });
      await api.history(captured, "settings");
      await api.history(captured, "settings", { offset: decimal("1"), atRevision: decimal("7") });
      await api.references(captured, { kind: "ticket", id: identifier("ticket") });
      await api.references(
        captured,
        { kind: "resource", id: identifier("proof") },
        { offset: decimal("100"), atRevision: decimal("7") },
      );
    }
    for (const [method, variants] of pending) {
      const { stdout } = await execute(fixtureBinary(), ["schema", method], {
          timeout: 10000,
          killSignal: "SIGKILL",
          maxBuffer: 8 * 1024 * 1024,
        }),
        schema = (JSON.parse(stdout) as { methods: { params: object }[] }).methods[0]?.params;
      if (schema === undefined) throw new Error(`Missing ${method}`);
      const validate = ajv.compile(schema);
      for (const params of variants) {
        const encoded = await processing.encode(params);
        if (!encoded.ok || !encoded.value.ok)
          throw new Error("Invalid bounded selector/preparation");
        const value: unknown = JSON.parse(encoded.value.value);
        expect(validate(value), `${method}: ${JSON.stringify(validate.errors)}`).toBe(true);
        expect(validate({ ...(value as object), unexpected_field: true })).toBe(false);
      }
      checks.push({ method, variants: variants.length });
    }
    expect(checks).toHaveLength(6);
    await info.attach("facts-native-schema-parity", {
      body: JSON.stringify(checks, null, 2),
      contentType: "application/json",
    });
  } finally {
    processing.dispose();
  }
});
