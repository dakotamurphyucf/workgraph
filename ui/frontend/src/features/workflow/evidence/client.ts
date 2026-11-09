import { jsonField } from "../../../core/json";
import { createCompanion } from "../../../core/protocol/client";
import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type { HttpClient, HttpResult } from "../../../core/protocol/http";
import type { JsonObject, ReadResponse } from "../../../core/protocol/types";
import type { EffectivePolicy, EvidenceCapture, EvidenceTarget, GateCapture } from "./types";

/** Daemon records preserve unprojected fields. Only consumed fields are projected;
 * these are not closed companion DTOs and raw lossless bytes remain available. */
export function fields<S extends Readonly<Record<string, c.Codec<unknown>>>>(
  shape: S,
): c.Codec<{ readonly [K in keyof S]: S[K] extends c.Codec<infer T> ? T : never }> {
  const codec = c.record(shape),
    names = new Set(Object.keys(shape));
  return {
    decode(value, path = []) {
      return value?.kind === "object"
        ? codec.decode(
            { kind: "object", fields: value.fields.filter((item) => names.has(item.name)) },
            path,
          )
        : c.mismatch(path, "object");
    },
  };
}
const scope = c.tagged<
  | {
      readonly kind: "ticket";
      readonly ticket_id: import("../../../core/protocol/types").Identifier;
    }
  | {
      readonly kind: "project";
      readonly project_id: import("../../../core/protocol/types").Identifier;
    }
>("kind", {
  ticket: c.record({ kind: c.literal("ticket"), ticket_id: d.identifier }),
  project: c.record({ kind: c.literal("project"), project_id: d.identifier }),
});
const source = c.record({ scope, revision: d.positiveDecimal });
const criterion = c.record({
  reference: c.record({ scope, policy_revision: d.positiveDecimal, key: d.identifier }),
  criterion: c.record({ key: d.identifier, description: c.text, required: c.boolean }),
});
const rawObjects = c.array(c.object, 100000);
export const policyCodec: c.Codec<EffectivePolicy> = fields({
  ticket_id: d.identifier,
  digest: d.digest,
  project_id: c.nullable(d.identifier),
  membership_revision: d.positiveDecimal,
  ownership_token: c.nullable(d.positiveDecimal),
  sources: rawObjects,
  reviewers: rawObjects,
  validators: c.array(c.text, 200),
  criteria: rawObjects,
  separate_actor: c.boolean,
  stale_override: c.raw,
});
const contextCodec = fields({
  ticket_id: d.identifier,
  effective_policy: policyCodec,
  policy: c.nullable(c.object),
  manifest: c.nullable(c.object),
  submission: c.nullable(c.object),
  assertions: rawObjects,
  reviews: rawObjects,
  reconciliations: rawObjects,
  decisions: rawObjects,
});
const gateCodec = fields({ allowed: c.boolean, problem: c.nullable(d.problem) });
const metaCodec = fields({ query_revision: d.decimal, query_scope: c.literal("evidence") });
export const claimCodec = fields({ ticket: c.object });
const invalid = (message: string): HttpResult<never> => ({
  ok: false,
  failure: { kind: "protocol", message, issue: undefined },
});
export function decodeCapture(
  target: EvidenceTarget,
  result: ReadResponse,
): HttpResult<EvidenceCapture> {
  const decoded = contextCodec.decode(result.response.data),
    meta = metaCodec.decode(result.response.meta);
  if (!decoded.ok || !meta.ok)
    return invalid(
      "Evidence response is missing its typed record or exact evidence namespace revision.",
    );
  const value = decoded.value;
  if (value.ticket_id !== target.ticketId || value.effective_policy.ticket_id !== target.ticketId)
    return invalid("Evidence response belongs to another ticket.");
  // Validate every field used by readable source/criterion controls; never silently
  // turn malformed source identity into an empty policy.
  const policy = jsonField(result.response.data, "effective_policy");
  if (
    policy?.kind !== "object" ||
    result.response.data.kind !== "object" ||
    !c.array(source, 2).decode(jsonField(policy, "sources")).ok ||
    !c.array(criterion, 200).decode(jsonField(policy, "criteria")).ok
  )
    return invalid("Malformed effective policy source or criterion reference.");
  return {
    ok: true,
    httpStatus: 200,
    data: Object.freeze({
      target,
      revision: meta.value.query_revision,
      raw: result.response.data,
      meta: result.response.meta,
      policy: value.effective_policy,
      localPolicy: value.policy,
      manifest: value.manifest,
      submission: value.submission,
      assertions: value.assertions,
      reviews: value.reviews,
      reconciliations: value.reconciliations,
      decisions: value.decisions,
    }),
  };
}
export function decodeGate(target: EvidenceTarget, result: ReadResponse): HttpResult<GateCapture> {
  const decoded = gateCodec.decode(result.response.data),
    meta = metaCodec.decode(result.response.meta);
  if (!decoded.ok || !meta.ok || result.response.data.kind !== "object")
    return invalid("Malformed review gate response.");
  if (decoded.value.allowed && decoded.value.problem !== null)
    return invalid("Allowed review gate unexpectedly contains a blocking problem.");
  return {
    ok: true,
    httpStatus: 200,
    data: Object.freeze({
      target,
      revision: meta.value.query_revision,
      raw: result.response.data,
      meta: result.response.meta,
      ...decoded.value,
    }),
  };
}
export function createEvidenceClient(http: HttpClient) {
  const companion = createCompanion(http);
  const read = (target: EvidenceTarget, method: string, params: JsonObject, signal: AbortSignal) =>
    companion.read(
      {
        connection_id: target.connection.id,
        generation: target.connection.generation,
        method,
        params,
        lane: "visible",
      },
      signal,
    );
  const params = (target: EvidenceTarget) =>
    d.jsonObject([
      ["workspace_id", d.jsonString(target.workspaceId)],
      ["ticket_id", d.jsonString(target.ticketId)],
      ["max_bytes", d.jsonString("1048576")],
    ]);
  return {
    read,
    context: async (
      target: EvidenceTarget,
      signal: AbortSignal,
    ): Promise<HttpResult<EvidenceCapture>> => {
      const result = await read(target, "evidence.context", params(target), signal);
      return result.ok ? decodeCapture(target, result.data) : result;
    },
    gate: async (target: EvidenceTarget, signal: AbortSignal): Promise<HttpResult<GateCapture>> => {
      const result = await read(target, "review.gate", params(target), signal);
      return result.ok ? decodeGate(target, result.data) : result;
    },
    ticket: async (
      target: EvidenceTarget,
      signal: AbortSignal,
    ): Promise<HttpResult<JsonObject>> => {
      const result = await read(target, "ticket.read", params(target), signal);
      if (!result.ok) return result;
      const value = claimCodec.decode(result.data.response.data);
      if (!value.ok) return invalid("Malformed ticket ownership capture.");
      const ticketId = d.identifier.decode(jsonField(value.value.ticket, "ticket_id"));
      return ticketId.ok && ticketId.value === target.ticketId
        ? { ok: true, httpStatus: result.httpStatus, data: value.value.ticket }
        : invalid("Ticket ownership capture changed the requested ticket.");
    },
  };
}
