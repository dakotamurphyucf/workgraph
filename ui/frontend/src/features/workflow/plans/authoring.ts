import { jsonField } from "../../../core/json";
import * as d from "../../../core/protocol/decoders";
import type { JsonObject } from "../../../core/protocol/types";
import type { MethodContract } from "../../advanced/types";
import { schemaField, text } from "./schema";
import { PlanInputError } from "./model";
import type { PlanDocument, PlanOperation, PlanStage, TemplatePin } from "./types";

const ATTRIBUTION = ["workspace_id", "actor_id", "run_id", "mutation_id"];
export function parameterSchema(contract: MethodContract): JsonObject {
  const fields = contract.fields.fields.filter((field) => !ATTRIBUTION.includes(field.name));
  return d.jsonObject([
    ["type", d.jsonString("object")],
    [
      "$defs",
      schemaField(contract.fields.validation_schema, "$defs") ??
        schemaField(contract.method.params, "$defs") ??
        d.jsonObject([]),
    ],
    ["properties", d.jsonObject(fields.map((field) => [field.name, field.schema] as const))],
    [
      "required",
      d.jsonArray(
        fields
          .filter((field) => field.requirement === "required")
          .map((field) => d.jsonString(field.name)),
      ),
    ],
  ]);
}
export function initialOperation(
  method: string,
  index: number,
  projectId: string | null = null,
): PlanOperation {
  const alias = `work-${index + 1}`;
  if (method === "ticket.create")
    return {
      method,
      alias,
      params: d.jsonObject([
        ["title", d.jsonString("New work")],
        ...(projectId === null ? [] : [["project_id", d.jsonString(projectId)] as const]),
      ]),
    };
  if (method === "dependency.add" || method === "dependency.remove")
    return {
      method,
      alias: null,
      params: d.jsonObject([
        ["ticket_id", d.jsonString("$work-1")],
        ["prerequisite_id", d.jsonString("")],
      ]),
    };
  if (method === "ticket.hold")
    return {
      method,
      alias: null,
      params: d.jsonObject([
        ["ticket_id", d.jsonString("$work-1")],
        ["expected_revision", d.jsonString("1")],
        ["reason", d.jsonString("Awaiting later configuration")],
      ]),
    };
  return { method, alias: null, params: d.jsonObject([]) };
}
export function initialStage(index: number, projectId: string | null = null): PlanStage {
  const create = initialOperation("ticket.create", index, projectId),
    hold = initialOperation("ticket.hold", index);
  return {
    id: `batch-${crypto.randomUUID()}`,
    title: `Batch ${index + 1}`,
    operations: [
      create,
      {
        ...hold,
        params: d.jsonObject([
          ["ticket_id", d.jsonString(`$${create.alias}`)],
          ["expected_revision", d.jsonString("1")],
          ["reason", d.jsonString("Awaiting later configuration")],
        ]),
      },
    ],
    bindings: [],
    exposure: "Created work remains held until remaining configuration is committed.",
    exposures: [
      {
        operation: 0,
        disposition: "held",
        deferred: "Review remaining configuration before release",
        templateDigest: null,
      },
    ],
  };
}
/** Reordering never silently changes an existing durable-receipt path. */
export function moveOperation(
  document: PlanDocument,
  from: number,
  operation: number,
  to: number,
  position: number,
): PlanDocument {
  const source = document.stages[from],
    destination = document.stages[to];
  if (source === undefined || destination === undefined)
    throw new PlanInputError("Choose existing source and destination batches.");
  if (
    document.stages.some((stage) =>
      stage.bindings.some(
        (binding) => binding.stage === source.id || binding.stage === destination.id,
      ),
    )
  )
    throw new PlanInputError(
      "Review/remove downstream receipt bindings before reordering their producer batches. No durable receipt path was silently retargeted.",
    );
  const selected = source.operations[operation];
  if (selected === undefined) throw new PlanInputError("Choose an existing operation.");
  if (from !== to && source.operations.length === 1)
    throw new PlanInputError(
      "Keep at least one operation in each batch, or remove the empty batch explicitly.",
    );
  const tagged = source.operations.map((value, index) => ({ value, index }));
  tagged.splice(operation, 1);
  if (from === to) {
    tagged.splice(Math.max(0, Math.min(position, tagged.length)), 0, {
      value: selected,
      index: operation,
    });
    const indices = new Map(tagged.map((entry, index) => [entry.index, index]));
    return {
      ...document,
      stages: document.stages.map((stage, index) =>
        index !== from
          ? stage
          : {
              ...stage,
              operations: tagged.map((entry) => entry.value),
              bindings: stage.bindings.map((binding) => ({
                ...binding,
                operation: indices.get(binding.operation)!,
              })),
              exposures: stage.exposures.map((entry) => ({
                ...entry,
                operation: indices.get(entry.operation)!,
              })),
            },
      ),
    };
  }
  if (destination.operations.length >= 128)
    throw new PlanInputError(
      "An explicit batch holds at most128 source operations. A template instance is never split.",
    );
  const target = Math.max(0, Math.min(position, destination.operations.length)),
    shifted = (index: number) => (index > operation ? index - 1 : index);
  const movedBindings = source.bindings
    .filter((binding) => binding.operation === operation)
    .map((binding) => ({ ...binding, operation: target }));
  const movedExposures = source.exposures
    .filter((entry) => entry.operation === operation)
    .map((entry) => ({ ...entry, operation: target }));
  return {
    ...document,
    stages: document.stages.map((stage, index) =>
      index === from
        ? {
            ...stage,
            operations: tagged.map((entry) => entry.value),
            bindings: stage.bindings
              .filter((binding) => binding.operation !== operation)
              .map((binding) => ({ ...binding, operation: shifted(binding.operation) })),
            exposures: stage.exposures
              .filter((entry) => entry.operation !== operation)
              .map((entry) => ({ ...entry, operation: shifted(entry.operation) })),
          }
        : index === to
          ? {
              ...stage,
              operations: [
                ...stage.operations.slice(0, target),
                selected,
                ...stage.operations.slice(target),
              ],
              bindings: [
                ...stage.bindings.map((binding) => ({
                  ...binding,
                  operation:
                    binding.operation >= target ? binding.operation + 1 : binding.operation,
                })),
                ...movedBindings,
              ],
              exposures: [
                ...stage.exposures.map((entry) => ({
                  ...entry,
                  operation: entry.operation >= target ? entry.operation + 1 : entry.operation,
                })),
                ...movedExposures,
              ],
            }
          : stage,
    ),
  };
}
export function instanceDocument(pin: TemplatePin, projectId: string | null = null): PlanDocument {
  return {
    format: "workgraph-ui-plan-1",
    title: `Instance of ${pin.id}`,
    stages: [
      {
        id: "instance",
        title: "Atomic native template instance",
        operations: [
          {
            method: "template.instantiate",
            alias: null,
            params: d.jsonObject([
              ["template_id", d.jsonString(pin.id)],
              ["template_revision", d.jsonString(pin.version)],
              ["instance_id", d.jsonString("")],
              ["parameters", d.jsonObject([])],
              ...(projectId === null ? [] : [["project_id", d.jsonString(projectId)] as const]),
            ]),
          },
        ],
        bindings: [],
        exposure: "One atomic instance; native expanded count and current guards decide admission.",
        exposures: [
          { operation: 0, disposition: "runnable", deferred: "", templateDigest: pin.digest },
        ],
      },
    ],
  };
}

export function templateSourceOperation(document: PlanDocument | null): PlanOperation | null {
  if (document?.stages.length !== 1 || document.stages[0]?.operations.length !== 1) return null;
  const op = document.stages[0].operations[0]!;
  return op.method === "resource.put_text" &&
    text(jsonField(op.params, "filename")) === "template.json" &&
    text(jsonField(op.params, "mime_type")) === "application/json"
    ? op
    : null;
}
export function templateSourceDocument(specSource: string): PlanDocument {
  return {
    format: "workgraph-ui-plan-1",
    title: "Untitled template source",
    stages: [
      {
        id: "template-source",
        title: "Unregistered template source",
        operations: [
          {
            method: "resource.put_text",
            alias: null,
            params: d.jsonObject([
              ["resource_id", d.jsonString(`template-${crypto.randomUUID()}`)],
              ["expected_revision", d.jsonString("0")],
              ["title", d.jsonString("Untitled template")],
              ["filename", d.jsonString("template.json")],
              ["mime_type", d.jsonString("application/json")],
              ["text", d.jsonString(specSource)],
            ]),
          },
        ],
        bindings: [],
        exposure:
          "Source only. Build a separate native canonical publication draft before registration.",
        exposures: [],
      },
    ],
  };
}
export function initialTemplateSpec(): JsonObject {
  return d.jsonObject([
    ["parameters", d.jsonArray([])],
    [
      "nodes",
      d.jsonArray([
        d.jsonObject([
          ["alias", d.jsonString("work")],
          ["title", d.jsonString("New work")],
          ["description", d.jsonString("")],
          ["depends_on", d.jsonArray([])],
          ["parent", d.jsonNull()],
          ["capabilities", d.jsonArray([])],
          ["allowed_actor_ids", d.jsonNull()],
          ["reviewers", d.jsonArray([])],
          ["separate_actor", d.jsonBoolean(false)],
        ]),
      ]),
    ],
  ]);
}
