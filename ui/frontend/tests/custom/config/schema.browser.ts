import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fixtureBinary } from "../../../../test-support/daemon-fixture.mjs";
import { initialQuery } from "../../../src/features/custom/config/query";
import { prepareConfigPublication } from "../../../src/features/custom/config/publication";
import { createTestProcessor } from "../../core/processing-harness";
import type { ConfigSource } from "../../../src/features/custom/config/types";
import type { JsonObject } from "../../../src/core/protocol/types";
import { view, intention, identifier, decimal } from "./fixtures";
const execute = promisify(execFile);
// Native schema parity only. No browser, schema compilation or network fetch exists in the runtime config module.
// eslint-disable-next-line no-empty-pattern
test("Config source lowering and guarded publication match fresh native schemas", async ({}, info) => {
  const processing = createTestProcessor(),
    pending = new Map<string, JsonObject[]>();
  const add = (method: string, params: JsonObject) =>
    pending.set(method, [...(pending.get(method) ?? []), params]);
  try {
    for (const source of [
      "tickets",
      "runs",
      "attempts",
      "sessions",
      "resources",
      "facts",
      "discussions",
      "activity",
    ] as const) {
      const scopes =
        source === "runs" || source === "sessions"
          ? ["workspace"]
          : source === "attempts"
            ? ["workspace", "ticket"]
            : source === "facts" || source === "resources"
              ? ["workspace", "project", "ticket", "milestone"]
              : source === "activity"
                ? ["workspace", "project", "ticket"]
                : ["workspace", "project"];
      for (const kind of scopes) {
        const scope = kind === "workspace" ? { kind } : { kind, id: "target" };
        const query = initialQuery(view(source, { scope }), identifier("demo"));
        add(query.method, query.params);
      }
    }
    const variants: readonly [ConfigSource, object][] = [
      [
        "tickets",
        {
          filters: [
            { field: "status", op: "equals", value: "backlog" },
            { field: "priority", op: "equals", value: "0" },
            { field: "text", op: "contains_text", value: "query" },
          ],
        },
      ],
      [
        "attempts",
        {
          scope: { kind: "ticket", id: "ticket" },
          filters: [
            { field: "ticket_id", op: "equals", value: "ticket" },
            { field: "target_run_id", op: "equals", value: "run" },
          ],
        },
      ],
      [
        "sessions",
        {
          sort: [{ field: "created_at", direction: "desc", nulls: "last" }],
          filters: [
            { field: "run_id", op: "equals", value: "run" },
            { field: "include_archived", op: "equals", value: false },
          ],
        },
      ],
      ["resources", { filters: [{ field: "include_archived", op: "equals", value: true }] }],
      [
        "facts",
        {
          filters: [
            { field: "key", op: "literal_prefix", value: "Case." },
            { pointer: "/value", op: "equals", value: null },
          ],
        },
      ],
      [
        "discussions",
        {
          scope: { kind: "project", id: "project" },
          filters: [
            { field: "scope", op: "equals", value: "project" },
            { field: "state", op: "equals", value: "awaiting_response" },
            { field: "actor_id", op: "equals", value: "actor" },
            { field: "board_id", op: "equals", value: "board" },
            { field: "text", op: "contains_text", value: "query" },
            { field: "unresolved", op: "equals", value: true },
          ],
        },
      ],
    ];
    for (const [source, changes] of variants) {
      const query = initialQuery(view(source, changes), identifier("demo"));
      add(query.method, query.params);
    }
    const preparation = await prepareConfigPublication(
      processing,
      intention({
        id: identifier("local"),
        generation: decimal("1"),
        label: "Local",
        socket: "/tmp/owned.sock",
      }),
    );
    add(preparation.preparation.method, preparation.preparation.params);
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    ajv.addKeyword({
      keyword: "x-maxUtf8Bytes",
      type: "string",
      validate: (max: number, text: string) => Buffer.byteLength(text) <= max,
    });
    ajv.addKeyword({
      keyword: "x-maximumDecimal",
      type: "string",
      validate: (max: string, text: string) =>
        /^(0|[1-9][0-9]*)$/u.test(text) && BigInt(text) <= BigInt(max),
    });
    const checks: object[] = [];
    for (const [method, paramsList] of pending) {
      const { stdout } = await execute(fixtureBinary(), ["schema", method], {
        timeout: 10000,
        killSignal: "SIGKILL",
        maxBuffer: 8 * 1024 * 1024,
      });
      const result = JSON.parse(stdout) as { methods: { params: object }[] };
      const schema = result.methods[0]?.params;
      if (schema === undefined) throw new Error("schema");
      const validate = ajv.compile(schema);
      for (const params of paramsList) {
        const encoded = await processing.encode(params);
        if (!encoded.ok || !encoded.value.ok) throw new Error("encode");
        const value: unknown = JSON.parse(encoded.value.value);
        expect(validate(value), `${method}: ${JSON.stringify(validate.errors)}`).toBe(true);
      }
      checks.push({ method, variants: paramsList.length });
    }
    expect(checks).toHaveLength(9);
    await info.attach("config-native-schema-parity", {
      body: JSON.stringify(checks, null, 2),
      contentType: "application/json",
    });
  } finally {
    processing.dispose();
  }
});
