import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import native from "./native-transaction.fixture.json";
import { stringifyJson } from "../../../src/core/json";
import * as d from "../../../src/core/protocol/decoders";
import { decode } from "../../work/actions-fixtures";
import { operationJson, stageParams } from "../../../src/features/workflow/plans/model";
import type { PlanCapture, PlanOperation } from "../../../src/features/workflow/plans/types";

// Captured from actual d6520097 daemon executable: `workgraph schema transaction.apply`.
// The maintained browser test independently validates against its actual binary as well.
const capture: PlanCapture = {
  connection: decode(d.connectionProfile, {
    id: "local",
    generation: "1",
    label: "Synthetic",
    socket: "/tmp/synthetic-plans.sock",
  }),
  context: {
    workspace_id: decode(d.identifier, "demo"),
    project_id: decode(d.identifier, "release"),
    writer: { actor_id: decode(d.identifier, "fixture-author"), run_id: null },
  },
};
export const wireOperations: readonly PlanOperation[] = [
  {
    method: "ticket.create",
    alias: "work",
    params: d.jsonObject([
      ["ticket_id", d.jsonString("work")],
      ["title", d.jsonString("Create with explicit alias")],
      ["project_id", d.jsonString("release")],
    ]),
  },
  {
    method: "ticket.hold",
    alias: null,
    params: d.jsonObject([
      ["ticket_id", d.jsonString("$work")],
      ["expected_revision", d.jsonString("1")],
      ["reason", d.jsonString("Later obligations")],
    ]),
  },
];
function closed(value: ReturnType<typeof d.jsonObject>): Record<string, unknown> {
  const encoded = stringifyJson(value);
  if (!encoded.ok) throw new Error("Synthetic wire encoding failed");
  return JSON.parse(encoded.value) as Record<string, unknown>;
}
describe("exact native transaction operation wire", () => {
  it("projects local creation aliases to native as and emits no nullable internal alias fields", () => {
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(native),
      params = { ...closed(stageParams(capture, wireOperations)), mutation_id: "wire-fixture" };
    expect(validate(params), JSON.stringify(validate.errors)).toBe(true);
    expect(closed(operationJson(wireOperations[0]!))).toEqual({
      method: "ticket.create",
      params: { ticket_id: "work", title: "Create with explicit alias", project_id: "release" },
      as: "work",
    });
    const incorrect = {
      ...params,
      operations: [
        { method: "ticket.create", params: closed(wireOperations[0]!.params), alias: "work" },
        closed(operationJson(wireOperations[1]!)),
      ],
    };
    expect(validate(incorrect)).toBe(false);
  });
});
