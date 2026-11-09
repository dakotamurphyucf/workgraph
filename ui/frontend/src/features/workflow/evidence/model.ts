import { jsonField, type JsonValue } from "../../../core/json";
import * as d from "../../../core/protocol/decoders";
import type { FeatureContext } from "../../../app/types";
import type { Identifier, JsonObject, Preparation } from "../../../core/protocol/types";
import type { ProtocolProcessor } from "../../../core/protocol/worker";
import { HTTP_LIMITS } from "../../../core/protocol/worker/jobs";
import { definition } from "./commands";
import type {
  EvidenceCapture,
  EvidenceDraft,
  EvidenceMethod,
  EvidenceTarget,
  FieldInput,
} from "./types";

export class EvidenceInputError extends Error {}
export const MAX_DRAFT_BYTES = 4 * 1024 * 1024,
  MAX_TOTAL_BYTES = 16 * 1024 * 1024,
  MAX_DRAFTS = 24;
export function identifier(value: string): Identifier {
  const result = d.identifier.decode(d.jsonString(value));
  if (!result.ok)
    throw new EvidenceInputError(
      "Choose an actual ASCII identifier (letters, numbers, underscores or hyphens, at most 96 characters).",
    );
  return result.value;
}
export function target(context: FeatureContext, ticketId: string): EvidenceTarget {
  if (context.profileState !== "current")
    throw new EvidenceInputError("Refresh the connection directory before capturing a new target.");
  if (context.route.workspaceId === null)
    throw new EvidenceInputError("Select the actual workspace first.");
  return Object.freeze({
    connection: Object.freeze({ ...context.connection }),
    workspaceId: identifier(context.route.workspaceId),
    ticketId: identifier(ticketId),
  });
}
export function targetKey(value: EvidenceTarget): string {
  return JSON.stringify([
    value.connection.id,
    value.connection.generation,
    value.workspaceId,
    value.ticketId,
  ]);
}
export function sameTarget(left: EvidenceTarget, right: EvidenceTarget): boolean {
  return targetKey(left) === targetKey(right);
}
export function inputBytes(inputs: Readonly<Record<string, FieldInput>>): number {
  return Object.entries(inputs).reduce(
    (sum, [name, value]) =>
      sum +
      new TextEncoder().encode(name).byteLength +
      new TextEncoder().encode(value.text).byteLength,
    0,
  );
}
export function text(value: JsonValue | undefined): string {
  return value?.kind === "string" ? value.value : "";
}
export function nullableObject(value: JsonValue | undefined): JsonObject | null {
  return value?.kind === "object" ? value : null;
}
export function objectFields(value: JsonObject): readonly (readonly [string, JsonValue])[] {
  return value.fields.map(({ name, value: item }) => [name, item]);
}
export async function encoded(
  processing: ProtocolProcessor,
  value: JsonValue,
  signal: AbortSignal,
): Promise<string> {
  const result = await processing.encode(value, { signal, limits: HTTP_LIMITS });
  if (!result.ok) throw new EvidenceInputError(`${result.failure.kind}: ${result.failure.message}`);
  if (!result.value.ok) throw new EvidenceInputError(result.value.error.message);
  return result.value.value;
}
export async function parsedObject(
  processing: ProtocolProcessor,
  source: string,
  signal: AbortSignal,
): Promise<JsonObject> {
  const result = await processing.parse(source, { signal, limits: HTTP_LIMITS });
  if (!result.ok) throw new EvidenceInputError(`${result.failure.kind}: ${result.failure.message}`);
  if (!result.value.ok) throw new EvidenceInputError(result.value.error.message);
  const value = result.value.value.value;
  if (value.kind !== "object") throw new EvidenceInputError("Enter one complete JSON object.");
  return value;
}
/** Seed only actual captured values, never guessed revisions or current-head pins. */
export async function initialInputs(
  processing: ProtocolProcessor,
  method: EvidenceMethod,
  scope: EvidenceTarget,
  base: EvidenceCapture | null,
  signal: AbortSignal,
): Promise<Readonly<Record<string, FieldInput>>> {
  const inputs: Record<string, FieldInput> = Object.create(null) as Record<string, FieldInput>;
  for (const field of definition(method).fields)
    inputs[field.name] = Object.freeze({
      presence: field.optional ? "omit" : "value",
      text: field.initial ?? "",
    });
  const set = async (name: string, value: JsonValue | undefined) => {
    if (value === undefined || inputs[name] === undefined) return;
    const field = definition(method).fields.find((item) => item.name === name);
    inputs[name] = Object.freeze({
      presence: "value",
      text:
        field?.type === "json"
          ? await encoded(processing, value, signal)
          : value.kind === "boolean"
            ? String(value.value)
            : text(value),
    });
  };
  await set("ticket_id", d.jsonString(scope.ticketId));
  if (method === "acceptance.policy.put" || method === "decision.put")
    await set(
      "scope",
      d.jsonObject([
        ["kind", d.jsonString("ticket")],
        ["ticket_id", d.jsonString(scope.ticketId)],
      ]),
    );
  if (base !== null) {
    if (method === "acceptance.policy.put" && base.localPolicy !== null)
      for (const name of [
        "scope",
        "enabled",
        "reviewers",
        "separate_actor",
        "validators",
        "criteria",
        "inherited_override",
      ])
        if (jsonField(base.localPolicy, name)?.kind !== "null")
          await set(name, jsonField(base.localPolicy, name));
    if (
      (method === "acceptance.policy.put" || method === "review.policy.put") &&
      base.localPolicy !== null
    ) {
      await set("expected_revision", jsonField(base.localPolicy, "revision"));
      if (method === "review.policy.put")
        for (const name of ["enabled", "reviewers", "separate_actor", "validators"])
          await set(name, jsonField(base.localPolicy, name));
    }
    await set("expected_policy_digest", d.jsonString(base.policy.digest));
    if (method === "acceptance.assert" && base.policy.ownership_token !== null)
      await set("token", d.jsonString(base.policy.ownership_token));
    if (base.manifest !== null) {
      const manifestRef = d.jsonObject([
        ["manifest_id", jsonField(base.manifest, "manifest_id") ?? d.jsonString("")],
        ["revision", jsonField(base.manifest, "revision") ?? d.jsonString("")],
      ]);
      await set("manifest", manifestRef);
      if (method === "manifest.publish")
        for (const name of [
          "manifest_id",
          "schema_version",
          "attempt_id",
          "contract",
          "inputs",
          "outputs",
        ])
          await set(name, jsonField(base.manifest, name));
      if (method === "manifest.publish")
        await set("expected_revision", jsonField(base.manifest, "revision"));
      if (method === "acceptance.assert")
        await set("attempt_id", jsonField(base.manifest, "attempt_id"));
    }
    if (base.submission !== null) {
      if (method === "review.submit" || method === "review.accept")
        await set("expected_revision", jsonField(base.submission, "revision"));
      if (method === "review.record")
        await set("generation", jsonField(base.submission, "generation"));
    }
  }
  // Sequential initialization avoids an editor's structured rows flooding the
  // shared bounded worker queue when they mount together.
  for (const field of definition(method).fields) {
    const input = inputs[field.name];
    if (field.type !== "json" || input === undefined) continue;
    const parsed = await processing.parse(input.text, { signal, limits: HTTP_LIMITS });
    if (!parsed.ok) throw new EvidenceInputError(parsed.failure.message);
    if (!parsed.value.ok) throw new EvidenceInputError(parsed.value.error.message);
    inputs[field.name] = Object.freeze({ ...input, value: parsed.value.value.value });
  }
  return Object.freeze(inputs);
}
export async function preparation(
  processing: ProtocolProcessor,
  draft: EvidenceDraft,
  signal: AbortSignal,
): Promise<Preparation> {
  const fields: (readonly [string, JsonValue])[] = [
    ["workspace_id", d.jsonString(draft.target.workspaceId)],
    ["actor_id", d.jsonString(draft.writer.actorId)],
  ];
  if (draft.writer.runId !== null) fields.push(["run_id", d.jsonString(draft.writer.runId)]);
  for (const field of definition(draft.method).fields) {
    const input = draft.inputs[field.name];
    if (input === undefined) throw new EvidenceInputError(`Missing ${field.label}.`);
    if (input.presence === "omit") {
      if (!field.optional) throw new EvidenceInputError(`${field.label} is required.`);
      continue;
    }
    if (field.name === "ticket_id" && input.text !== draft.target.ticketId)
      throw new EvidenceInputError(
        "This editor is bound to its captured ticket. Open a new editor for a different ticket.",
      );
    let value: JsonValue;
    if (field.type === "json") {
      const result = await processing.parse(input.text, { signal, limits: HTTP_LIMITS });
      if (!result.ok) throw new EvidenceInputError(`${field.label}: ${result.failure.message}`);
      if (!result.value.ok)
        throw new EvidenceInputError(`${field.label}: ${result.value.error.message}`);
      value = result.value.value.value;
    } else if (field.type === "boolean") {
      if (input.text !== "true" && input.text !== "false")
        throw new EvidenceInputError(`${field.label} must be true or false.`);
      value = d.jsonBoolean(input.text === "true");
    } else {
      if (field.type === "counter" && !d.decimal.decode(d.jsonString(input.text)).ok)
        throw new EvidenceInputError(`${field.label} must be an exact canonical decimal counter.`);
      if (field.type === "identifier") identifier(input.text);
      if (field.type === "choice" && !field.choices?.includes(input.text))
        throw new EvidenceInputError(`Choose ${field.label}.`);
      value = d.jsonString(input.text);
    }
    fields.push([field.name, value]);
  }
  const params = d.jsonObject(fields);
  // Validate the entire ordinary request budget, not only each editor field.
  await encoded(processing, params, signal);
  return Object.freeze({
    intention_id: draft.id,
    connection_id: draft.target.connection.id,
    generation: draft.target.connection.generation,
    context: Object.freeze({
      workspace_id: draft.target.workspaceId,
      project_id: draft.projectId,
      writer: Object.freeze({ actor_id: draft.writer.actorId, run_id: draft.writer.runId }),
    }),
    method: draft.method,
    params,
  });
}
