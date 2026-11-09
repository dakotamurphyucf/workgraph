import { describe, expect, it } from "vitest";
import native from "./native-fields.fixture.json";
import {
  initialOperation,
  initialStage,
  initialTemplateSpec,
  instanceDocument,
  moveOperation,
  parameterSchema,
} from "../../../src/features/workflow/plans/authoring";
import { decodePlan, planJson, templateCodec } from "../../../src/features/workflow/plans/model";
import {
  schemaField,
  defaultValue,
  chooseVariant,
} from "../../../src/features/workflow/plans/schema";
import * as d from "../../../src/core/protocol/decoders";
import { jsonField } from "../../../src/core/json";
import type { MethodContract } from "../../../src/features/advanced/types";
import { json, decode } from "../../work/actions-fixtures";

const pin = decode(templateCodec, {
  template_id: "canonical",
  template_revision: "3",
  digest: "a".repeat(64),
  spec: { parameters: [], nodes: [] },
});
describe("explicit unpublished workflow authoring", () => {
  it("keeps source operation fields aligned with captured native descriptors and original placement", () => {
    const create = initialOperation("ticket.create", 0, "release");
    const fields = native["ticket.create"].fields.map((field) => field.name);
    expect(create.params.fields.every((field) => fields.includes(field.name))).toBe(true);
    expect(jsonField(create.params, "project_id")).toEqual(d.jsonString("release"));
    const document = instanceDocument(pin, "release"),
      op = document.stages[0]!.operations[0]!;
    expect(op.method).toBe("template.instantiate");
    expect(
      op.params.fields.every((field) =>
        native["template.instantiate"].fields.some((native) => native.name === field.name),
      ),
    ).toBe(true);
    expect(jsonField(op.params, "bindings")).toBeUndefined();
    expect(document.stages[0]!.exposures[0]?.templateDigest).toBe(pin.digest);
  });
  it("moves consumer binding/exposure indices with their operations and refuses silent producer retargeting", () => {
    const stage = initialStage(0),
      document = {
        format: "workgraph-ui-plan-1" as const,
        title: "Explicit",
        stages: [
          {
            ...stage,
            bindings: [
              {
                operation: 1,
                path: ["ticket_id"],
                stage: "previous",
                receiptPath: ["results", "0", "data", "ticket_id"],
              },
            ],
          },
        ],
      };
    const moved = moveOperation(document, 0, 1, 0, 0);
    expect(moved.stages[0]!.operations[0]!.method).toBe("ticket.hold");
    expect(moved.stages[0]!.bindings[0]?.operation).toBe(0);
    expect(moved.stages[0]!.exposures[0]?.operation).toBe(1);
    expect(document.stages[0]!.bindings[0]?.operation).toBe(1);
    expect(() =>
      moveOperation(
        {
          ...document,
          stages: [
            stage,
            {
              ...initialStage(1),
              bindings: [
                {
                  operation: 0,
                  path: ["ticket_id"],
                  stage: stage.id,
                  receiptPath: ["results", "0", "data", "ticket_id"],
                },
              ],
            },
          ],
        },
        0,
        0,
        0,
        1,
      ),
    ).toThrow(/No durable receipt path was silently retargeted/);
  });
  it("requires explicit repair of later obligations when creating another independent batch", () => {
    const one = initialStage(0, "release"),
      two = initialStage(1, "release");
    expect(one.operations).toHaveLength(2);
    expect(one.exposures[0]?.disposition).toBe("held");
    expect(two.exposure).not.toBe("");
    expect(() =>
      moveOperation(
        { format: "workgraph-ui-plan-1", title: "Two", stages: [one, two] },
        0,
        0,
        1,
        0,
      ),
    ).not.toThrow();
  });
  it("uses exact native template structure and chooses null only on explicit default creation", () => {
    const spec = initialTemplateSpec(),
      schema = json(
        native["template.register"].fields.find((field) => field.name === "spec")!.schema,
      ),
      props = schemaField(schema, "properties"),
      node = schemaField(jsonField(props!, "nodes"), "items"),
      nodeProps = schemaField(node, "properties");
    const actual = jsonField(spec, "nodes");
    if (actual?.kind !== "array" || actual.items[0]?.kind !== "object")
      throw new Error("Missing default source node");
    expect(
      actual.items[0].fields.every((field) => jsonField(nodeProps!, field.name) !== undefined),
    ).toBe(true);
    expect(defaultValue(jsonField(nodeProps!, "parent")!)).toEqual(d.jsonNull());
    expect(defaultValue(jsonField(nodeProps!, "allowed_actor_ids")!)).toEqual(d.jsonNull());
  });
  it("keeps unknown fields while choosing a reviewer shape, never replacing on read", () => {
    const schema = json({
      type: "object",
      properties: {
        kind: { const: "role", type: "string" },
        name: { type: "string" },
        member_ids: { type: "array", items: { type: "string" } },
      },
      required: ["kind", "name", "member_ids"],
    });
    const value = json({ kind: "actor", actor_id: "previous", unknown: "preserved" }),
      changed = chooseVariant(schema, value);
    expect(jsonField(changed, "kind")).toEqual(d.jsonString("role"));
    expect(jsonField(changed, "unknown")).toEqual(d.jsonString("preserved"));
    expect(jsonField(changed, "actor_id")).toEqual(d.jsonString("previous"));
  });
  it("filters all attribution fields from native operation forms without dropping method fields", () => {
    const descriptor = native["request.ask"],
      contract = {
        method: {
          name: "request.ask",
          mode: "mutation",
          tier: "core",
          summary: "Native fixture",
          params: json(descriptor.validation_schema),
          result: d.jsonObject([]),
        },
        help: "",
        fields: {
          method: "request.ask",
          summary: "",
          schema_dialect: "",
          guidance: "",
          fields: descriptor.fields.map((field) => ({
            ...field,
            schema: json(field.schema),
            requirement: field.requirement as "required" | "optional" | "conditional",
          })),
          validation_schema: json(descriptor.validation_schema),
        },
      } satisfies MethodContract;
    const schema = parameterSchema(contract),
      props = schemaField(schema, "properties");
    expect(jsonField(props!, "body")).toBeDefined();
    for (const name of ["workspace_id", "actor_id", "run_id", "mutation_id"])
      expect(jsonField(props!, name)).toBeUndefined();
  });
  it("retains incomplete structural names for form repair while semantic review remains blocked", () => {
    expect(() =>
      decodePlan(planJson({ format: "workgraph-ui-plan-1", title: "", stages: [initialStage(0)] })),
    ).toThrow(/nonblank name/);
  });
});
