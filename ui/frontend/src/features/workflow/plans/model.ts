import { jsonField, type JsonValue } from "../../../core/json";
import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type { Decimal, Identifier, JsonObject } from "../../../core/protocol/types";
import type {
  DurableStageReceipt,
  PlanCapture,
  PlanDocument,
  PlanOperation,
  PlanStage,
  Preflight,
  ReceiptBinding,
  TemplatePin,
  TemplatePreview,
  StageExposure,
} from "./types";

export const PLAN_LIMITS = Object.freeze({
  drafts: 32,
  sourceBytes: 4 * 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
  stages: 32,
  operations: 128,
});
export class PlanInputError extends Error {}
const short = c.refine(
  c.text,
  (v) => new TextEncoder().encode(v).byteLength <= 512,
  "at most 512 UTF-8 bytes",
);
const localId = c.refine(c.text, (v) => /^[A-Za-z0-9_-]{1,96}$/.test(v), "local ASCII identifier");
const path = c.refine(
  c.array(
    c.refine(c.text, (v) => v.length <= 256, "bounded pointer segment"),
    16,
  ),
  (v) => v.length > 0,
  "nonempty JSON pointer path",
);
const index: c.Codec<number> = {
  decode(value, path = []) {
    if (
      value?.kind !== "number" ||
      !/^(0|[1-9][0-9]{0,2})$/.test(value.lexeme) ||
      Number(value.lexeme) >= PLAN_LIMITS.operations
    )
      return c.mismatch(path, "operation index 0..127");
    return { ok: true, value: Number(value.lexeme) };
  },
};
const operation: c.Codec<PlanOperation> = c.record({
  method: c.refine(c.text, (v) => v.length <= 128, "bounded method text"),
  params: c.object,
  alias: c.nullable(short),
});
const binding: c.Codec<ReceiptBinding> = c.record({
  operation: index,
  path,
  stage: short,
  receiptPath: path,
});
const disposition: c.Codec<"held" | "runnable"> = {
  decode(value, path = []) {
    return value?.kind === "string" && (value.value === "held" || value.value === "runnable")
      ? { ok: true, value: value.value }
      : c.mismatch(path, "held or declared runnable intent");
  },
};
const exposure: c.Codec<StageExposure> = c.record({
  operation: index,
  disposition,
  deferred: c.refine(
    c.text,
    (v) => new TextEncoder().encode(v).byteLength <= 4096,
    "deferred obligations at most4096bytes",
  ),
  templateDigest: c.nullable(d.digest),
});
const stage: c.Codec<PlanStage> = c.record({
  id: short,
  title: short,
  operations: c.refine(
    c.array(operation, PLAN_LIMITS.operations),
    (v) => v.length > 0,
    "at least one native operation",
  ),
  bindings: c.array(binding, 512),
  exposure: c.refine(
    c.text,
    (v) => new TextEncoder().encode(v).byteLength <= 4096,
    "exposure review at most 4096 bytes",
  ),
  exposures: c.array(exposure, 128),
});
const documentCodec: c.Codec<PlanDocument> = c.record({
  format: c.literal("workgraph-ui-plan-1"),
  title: short,
  stages: c.refine(
    c.array(stage, PLAN_LIMITS.stages),
    (v) => v.length > 0,
    "at least one explicit stage",
  ),
});

export function decodePlanShape(value: JsonValue): PlanDocument {
  const result = documentCodec.decode(value);
  if (!result.ok)
    throw new PlanInputError(`${result.issue.path.join(".")}: expected ${result.issue.expected}.`);
  return result.value;
}
export function decodePlan(value: JsonValue): PlanDocument {
  return validatePlan(decodePlanShape(value));
}
/** Structural drafts can remain editable while an exposure/binding needs review. */
export function validatePlan(plan: PlanDocument): PlanDocument {
  const previous = new Set<string>();
  if (plan.title.trim() === "") throw new PlanInputError("Give this workflow a nonblank name.");
  for (const [stageIndex, stage] of plan.stages.entries()) {
    if (!localId.decode(d.jsonString(stage.id)).ok || stage.title.trim() === "")
      throw new PlanInputError("Each batch needs a local ASCII ID and nonblank title.");
    if (previous.has(stage.id)) throw new PlanInputError("Every stage must have a unique ID.");
    if (plan.stages.length > 1 && stage.exposure.trim() === "")
      throw new PlanInputError("Review the partial-commit exposure of every explicit stage.");
    const aliases = new Set<string>(),
      destinations = new Set<string>();
    for (const op of stage.operations) {
      if (!/^[a-z][a-z0-9_.]{0,127}$/.test(op.method) || op.method === "transaction.apply")
        throw new PlanInputError("Choose a native non-nested planning method.");
      if (op.alias !== null && !localId.decode(d.jsonString(op.alias)).ok)
        throw new PlanInputError(
          "Aliases need1..96 ASCII letters, digits, underscores or hyphens.",
        );
      if (op.alias !== null && aliases.has(op.alias))
        throw new PlanInputError("Creation aliases must be unique within each atomic stage.");
      if (op.alias !== null) aliases.add(op.alias);
      for (const name of ["workspace_id", "actor_id", "run_id", "mutation_id"])
        if (jsonField(op.params, name) !== undefined)
          throw new PlanInputError(
            `Operation params must omit ${name}; attribution belongs to the captured batch.`,
          );
    }
    for (const binding of stage.bindings) {
      if (!previous.has(binding.stage))
        throw new PlanInputError("Receipt bindings must name a preceding committed stage.");
      if (binding.operation >= stage.operations.length)
        throw new PlanInputError("Receipt binding operation does not exist.");
      const destination = JSON.stringify([binding.operation, binding.path]);
      if (destinations.has(destination))
        throw new PlanInputError("Two receipt bindings cannot replace the same field.");
      destinations.add(destination);
      // Require the destination to exist before any asynchronous work. Replacement
      // never creates an accidental field or changes captured attribution.
      pointer(stage.operations[binding.operation]!.params, binding.path);
    }
    const exposures = new Map<number, StageExposure>();
    for (const declaration of stage.exposures) {
      const op = stage.operations[declaration.operation];
      if (
        exposures.has(declaration.operation) ||
        op === undefined ||
        !["ticket.create", "template.instantiate"].includes(op.method)
      )
        throw new PlanInputError(
          "One unambiguous exposure declaration may name each ticket creation operation.",
        );
      if (declaration.disposition === "runnable" && declaration.deferred.trim() !== "")
        throw new PlanInputError(
          "Deferred links or gates require held exposure; runnable is only a declared intent for fully configured work.",
        );
      if (op.method === "template.instantiate" && declaration.templateDigest === null)
        throw new PlanInputError("Every instance preview needs its exact template content digest.");
      exposures.set(declaration.operation, declaration);
    }
    stage.operations.forEach((op, index) => {
      if (
        (op.method === "template.instantiate" ||
          (stageIndex < plan.stages.length - 1 && op.method === "ticket.create")) &&
        !exposures.has(index)
      )
        throw new PlanInputError(
          "Declare held or runnable exposure for each staged ticket creation and pin every template instance.",
        );
    });
    previous.add(stage.id);
  }
  return plan;
}
function stringField(value: JsonObject, field: string): string | null {
  const found = jsonField(value, field);
  return found?.kind === "string" ? found.value : null;
}
export interface InstanceExposurePreview {
  /** Same immutable materialized input object, never a cached different revision. */
  readonly input: JsonObject;
  readonly mode: "literal" | "native-alias";
  readonly tickets: readonly Identifier[];
}
/** Check final materialized effects after receipt substitutions, never token occurrence.
 * Runnable is an explicit reviewed intent, not proven readiness or complete gates. */
export function validateExposure(
  stage: PlanStage,
  operations: readonly PlanOperation[],
  instances: ReadonlyMap<number, InstanceExposurePreview>,
): void {
  for (const declaration of stage.exposures) {
    const op = operations[declaration.operation];
    if (op === undefined) throw new PlanInputError("Exposure operation is absent.");
    const instance = instances.get(declaration.operation);
    if (
      op.method === "template.instantiate" &&
      (instance === undefined || instance.input !== op.params)
    )
      throw new PlanInputError(
        "Instance preview belongs to different materialized inputs. Review the exact template pin, instance, parameters and placement again.",
      );
    if (declaration.disposition !== "held") continue;
    if (instance?.mode === "native-alias")
      throw new PlanInputError(
        "Held instance verification needs literal placement. Create the placement entity in an earlier explicit stage, then bind its committed receipt. Same-batch aliases remain available for native runnable-intent plans; provisional IDs are never substituted.",
      );
    const explicit = stringField(op.params, "ticket_id");
    const targets: readonly (readonly string[])[] =
      op.method === "template.instantiate"
        ? (instance?.tickets ?? []).map((ticket) => [ticket])
        : [
            [
              ...(op.alias === null ? [] : [`$${op.alias}`]),
              ...(explicit === null ? [] : [explicit]),
            ],
          ];
    if (targets.length === 0 || targets.some((target) => target.length === 0))
      throw new PlanInputError("Held work needs an alias or exact native-created ticket identity.");
    for (const target of targets) {
      let held = false;
      for (const mutation of operations.slice(declaration.operation + 1)) {
        if (
          mutation.method === "ticket.hold" &&
          target.includes(stringField(mutation.params, "ticket_id") ?? "")
        )
          held = (stringField(mutation.params, "reason")?.trim().length ?? 0) > 0;
      }
      if (!held)
        throw new PlanInputError(
          "Declared held exposure requires a final nonempty hold on every created ticket in this same atomic batch. A later clear or redirected binding does not protect it.",
        );
    }
  }
}
export function pointer(value: JsonValue, segments: readonly string[]): JsonValue {
  let current = value;
  for (const segment of segments) {
    const next =
      current.kind === "object"
        ? jsonField(current, segment)
        : current.kind === "array" && /^(0|[1-9][0-9]*)$/.test(segment)
          ? current.items[Number(segment)]
          : undefined;
    if (next === undefined)
      throw new PlanInputError("JSON pointer does not name a retained value.");
    current = next;
  }
  return current;
}
function replace(value: JsonValue, segments: readonly string[], replacement: JsonValue): JsonValue {
  const first = segments[0];
  if (first === undefined) return replacement;
  if (value.kind === "object")
    return d.jsonObject(
      value.fields.map((field) => [
        field.name,
        field.name === first ? replace(field.value, segments.slice(1), replacement) : field.value,
      ]),
    );
  if (value.kind === "array")
    return d.jsonArray(
      value.items.map((item, i) =>
        String(i) === first ? replace(item, segments.slice(1), replacement) : item,
      ),
    );
  throw new PlanInputError("Receipt binding destination is not a collection.");
}
export function operationJson(op: PlanOperation): JsonObject {
  return d.jsonObject([
    ["method", d.jsonString(op.method)],
    ["params", op.params],
    ...(op.alias === null ? [] : [["as", d.jsonString(op.alias)] as const]),
  ]);
}
/** Native receipts, never preflight generated IDs, are the only later-stage inputs. */
export function materializeStage(
  plan: PlanDocument,
  selected: string,
  receipts: readonly DurableStageReceipt[],
): readonly PlanOperation[] {
  const index = plan.stages.findIndex((s) => s.id === selected),
    stage = plan.stages[index];
  if (stage === undefined) throw new PlanInputError("Select an existing stage.");
  const committed = new Map<string, JsonValue>();
  for (const prior of plan.stages.slice(0, index)) {
    const receipt = receipts.find((r) => r.stage.stageId === prior.id);
    const durable =
      receipt?.operation.state.kind === "committed"
        ? jsonField(receipt.operation.state.response.meta, "durable")
        : undefined;
    if (
      receipt?.operation.state.kind !== "committed" ||
      durable?.kind !== "boolean" ||
      durable.value !== true
    )
      throw new PlanInputError(
        "Resolve every preceding saved batch to a durable committed receipt before reviewing this stage. Unstarted batches remain unstarted.",
      );
    committed.set(prior.id, receipt.operation.state.response.data);
  }
  const result = [...stage.operations];
  for (const binding of stage.bindings) {
    const receipt = committed.get(binding.stage);
    if (receipt === undefined)
      throw new PlanInputError("A preceding durable receipt is unavailable.");
    const value = pointer(receipt, binding.receiptPath);
    if (value.kind !== "string")
      throw new PlanInputError(
        "A receipt binding must select an exact native ID or decimal-string guard.",
      );
    if (!d.identifier.decode(value).ok && !d.decimal.decode(value).ok)
      throw new PlanInputError(
        "Receipt bindings accept native identifier or decimal guard strings, never arbitrary payload text.",
      );
    const op = result[binding.operation];
    if (op === undefined) throw new PlanInputError("Receipt binding operation does not exist.");
    const params = replace(op.params, binding.path, value);
    if (params.kind !== "object")
      throw new PlanInputError("Operation params must remain an object.");
    result[binding.operation] = { ...op, params };
  }
  return Object.freeze(result);
}
export function stageParams(
  capture: PlanCapture,
  operations: readonly PlanOperation[],
): JsonObject {
  return d.jsonObject([
    ["workspace_id", d.jsonString(capture.context.workspace_id)],
    ["actor_id", d.jsonString(capture.context.writer.actor_id)],
    ...(capture.context.writer.run_id === null
      ? []
      : [["run_id", d.jsonString(capture.context.writer.run_id)] as const]),
    ["operations", d.jsonArray(operations.map(operationJson))],
  ]);
}
export const preflightCodec: c.Codec<Preflight> = {
  decode(value, path = []) {
    const result = c
      .record({
        validation: c.literal("domain_preparation"),
        workspace_revision: d.decimal,
        proposed_revision: d.decimal,
        operation_count: d.positiveDecimal,
        generated_ids: c.array(
          c.record({
            kind: c.refine(
              c.text,
              (v) => ["project", "milestone", "ticket", "comment", "resource"].includes(v),
              "native ID kind",
            ),
            id: d.identifier,
          }),
          128,
        ),
        staged_blob_count: d.decimal,
        staged_blob_bytes: d.decimal,
      })
      .decode(value, path);
    if (!result.ok) return result;
    const r = result.value;
    if (
      BigInt(r.operation_count) > 128n ||
      BigInt(r.proposed_revision) !== BigInt(r.workspace_revision) + 1n ||
      r.generated_ids.length > Number(r.operation_count) ||
      (r.staged_blob_count === "0" && r.staged_blob_bytes !== "0") ||
      value?.kind !== "object"
    )
      return c.mismatch(path, "coherent native domain-preparation summary");
    return {
      ok: true,
      value: {
        baseRevision: r.workspace_revision,
        proposedRevision: r.proposed_revision,
        expandedOperationCount: r.operation_count,
        generatedIds: r.generated_ids,
        stagedBlobCount: r.staged_blob_count,
        stagedBlobBytes: r.staged_blob_bytes,
        raw: value,
      },
    };
  },
};
export const templateCodec: c.Codec<TemplatePin> = {
  decode(value, path = []) {
    const r = c
      .record({
        template_id: d.identifier,
        template_revision: d.positiveDecimal,
        digest: d.digest,
        spec: c.object,
      })
      .decode(value, path);
    if (!r.ok) return r;
    if (value?.kind !== "object") return c.mismatch(path, "complete public template");
    return {
      ok: true,
      value: {
        id: r.value.template_id,
        version: r.value.template_revision,
        digest: r.value.digest,
        spec: r.value.spec,
        raw: value,
      },
    };
  },
};
export const templatePreviewCodec: c.Codec<TemplatePreview> = {
  decode(value, path = []) {
    const r = c
      .record({ template: templateCodec, instance: c.object, request: c.object })
      .decode(value, path);
    if (!r.ok) return r;
    const method = jsonField(r.value.request, "method"),
      params = jsonField(r.value.request, "params");
    if (
      method?.kind !== "string" ||
      method.value !== "template.instantiate" ||
      params?.kind !== "object"
    )
      return c.mismatch(path, "frozen native template.instantiate preview");
    return {
      ok: true,
      value: {
        template: r.value.template,
        instance: r.value.instance,
        request: { method: "template.instantiate", params },
      },
    };
  },
};
export function captureKey(capture: PlanCapture): string {
  return JSON.stringify([
    capture.connection.id,
    capture.connection.generation,
    capture.context.workspace_id,
    capture.context.project_id,
    capture.context.writer.actor_id,
    capture.context.writer.run_id,
  ]);
}
export function planJson(plan: PlanDocument): JsonObject {
  return d.jsonObject([
    ["format", d.jsonString(plan.format)],
    ["title", d.jsonString(plan.title)],
    [
      "stages",
      d.jsonArray(
        plan.stages.map((s) =>
          d.jsonObject([
            ["id", d.jsonString(s.id)],
            ["title", d.jsonString(s.title)],
            [
              "operations",
              d.jsonArray(
                s.operations.map((o) =>
                  d.jsonObject([
                    ["method", d.jsonString(o.method)],
                    ["params", o.params],
                    ["alias", o.alias === null ? d.jsonNull() : d.jsonString(o.alias)],
                  ]),
                ),
              ),
            ],
            [
              "bindings",
              d.jsonArray(
                s.bindings.map((b) =>
                  d.jsonObject([
                    ["operation", d.jsonNumber(String(b.operation))],
                    ["path", d.jsonArray(b.path.map(d.jsonString))],
                    ["stage", d.jsonString(b.stage)],
                    ["receiptPath", d.jsonArray(b.receiptPath.map(d.jsonString))],
                  ]),
                ),
              ),
            ],
            ["exposure", d.jsonString(s.exposure)],
            [
              "exposures",
              d.jsonArray(
                s.exposures.map((e) =>
                  d.jsonObject([
                    ["operation", d.jsonNumber(String(e.operation))],
                    ["disposition", d.jsonString(e.disposition)],
                    ["deferred", d.jsonString(e.deferred)],
                    [
                      "templateDigest",
                      e.templateDigest === null ? d.jsonNull() : d.jsonString(e.templateDigest),
                    ],
                  ]),
                ),
              ),
            ],
          ]),
        ),
      ),
    ],
  ]);
}
export function stageJson(stage: PlanStage): JsonObject {
  const encoded = jsonField(
    planJson({ format: "workgraph-ui-plan-1", title: stage.title, stages: [stage] }),
    "stages",
  );
  const item = encoded?.kind === "array" ? encoded.items[0] : undefined;
  if (item?.kind !== "object") throw new Error("Plan stage encoding invariant");
  return item;
}
export function checkedId(value: string): Identifier {
  const result = d.identifier.decode(d.jsonString(value));
  if (!result.ok) throw new PlanInputError("A valid native identifier is required.");
  return result.value;
}
export function checkedRevision(value: string): Decimal {
  const result = d.decimal.decode(d.jsonString(value));
  if (!result.ok) throw new PlanInputError("Use a canonical decimal revision.");
  return result.value;
}
