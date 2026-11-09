import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import { test, expect } from "@playwright/test";
import { fixtureBinary } from "../../../../test-support/daemon-fixture.mjs";
import * as d from "../../../src/core/protocol/decoders";
import { stringifyJson } from "../../../src/core/json";
import { planningInvocation } from "../../../src/features/history/scope-navigation/client";
const execute = promisify(execFile);
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Native object required");
  return Object.fromEntries(Object.entries(value));
}
function id(value: string) {
  const result = d.identifier.decode(d.jsonString(value));
  if (!result.ok) throw new Error("Invalid fixture ID");
  return result.value;
}
// Playwright requires the empty dependency pattern for this offline-only test.
// eslint-disable-next-line no-empty-pattern
test("all four planning reads use actual canonical executable catalog methods and request schemas", async ({}, info) => {
  const result = await execute(fixtureBinary(), ["methods", "--output", "json"], {
    timeout: 30000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const catalog = object(JSON.parse(result.stdout));
  if (!Array.isArray(catalog.methods)) throw new Error("Native methods missing");
  const methods = catalog.methods.map(object),
    tested: string[] = [],
    ajv = new Ajv2020({ strict: false, allErrors: true });
  const generation = d.positiveDecimal.decode(d.jsonString("1"));
  if (!generation.ok) throw new Error("Invalid generation");
  for (const kind of ["workspace", "project", "milestone", "ticket"] as const) {
    const invocation = planningInvocation({
      connectionId: id("local"),
      generation: generation.value,
      workspaceId: id("demo"),
      kind,
      id: id(kind === "workspace" ? "demo" : "target"),
    });
    const descriptor = methods.find((method) => method.name === invocation.method);
    expect(descriptor).toBeDefined();
    if (!descriptor) throw new Error("Noncanonical executable method");
    expect(descriptor.mode).toBe("read");
    const validate = ajv.compile(object(descriptor.params)),
      encoded = stringifyJson(invocation.params);
    if (!encoded.ok) throw new Error(encoded.error.message);
    expect(validate(JSON.parse(encoded.value)), JSON.stringify(validate.errors)).toBe(true);
    tested.push(invocation.method);
  }
  expect(tested).toEqual(["workspace.get", "project.get", "milestone.get", "ticket.read"]);
  expect(methods.some((method) => method.name === "ticket.get")).toBe(false);
  await info.attach("actual-executable-planning-schema-parity", {
    contentType: "application/json",
    body: JSON.stringify({
      tested,
      canonicalAliasAbsent: "ticket.get",
      nativeMethods: methods.length,
    }),
  });
});
