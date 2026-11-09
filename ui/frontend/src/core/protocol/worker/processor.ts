/** Pure worker-only algorithms. Importing this in a unit harness is explicit test injection. */
import {
  canonicalJson,
  parseJsonBytes,
  parseJsonText,
  stringifyJson,
  type JsonValue,
} from "../../json";
import * as d from "../decoders";
import { contextJson, preparationJson } from "../client";
import type { Operation } from "../types";
import { projectCapturedPayload } from "../../../features/history/formats/registry";
import type { ProcessingJob } from "./jobs";
import { HTTP_LIMITS, OPERATION_LIMITS } from "./jobs";
import type { HttpDecode, OperationObservation, PreparationAdmission } from "./types";
const j = d.jsonString;
function operationJson(operation: Operation): JsonValue {
  const profile = (value: Operation["connection"]) =>
    d.jsonObject([
      ["id", j(value.id)],
      ["generation", j(value.generation)],
      ["label", j(value.label)],
      ["socket", j(value.socket)],
    ]);
  const problem = (value: NonNullable<Operation["diagnostic"]>) =>
    d.jsonObject([
      ["kind", j(value.kind)],
      ["message", j(value.message)],
      ...(value.details === undefined ? [] : [["details", value.details] as const]),
    ]);
  const state = operation.state;
  return d.jsonObject([
    ["format", j(operation.format)],
    ["operation_id", j(operation.operation_id)],
    [
      "preparation",
      d.jsonObject([
        ["intention_id", j(operation.preparation.intention_id)],
        ["context", contextJson(operation.preparation.context)],
        ["connection", profile(operation.preparation.connection)],
        ["method", j(operation.preparation.method)],
        ["params", operation.preparation.params],
      ]),
    ],
    ["preparation_input_hash", j(operation.preparation_input_hash)],
    ["connection", profile(operation.connection)],
    ["request", operation.request],
    ["journal_path", operation.journal_path === null ? d.jsonNull() : j(operation.journal_path)],
    ["revision", j(operation.revision)],
    [
      "state",
      d.jsonObject([
        ["kind", j(state.kind)],
        ...(state.kind === "committed" || state.kind === "observed"
          ? [
              [
                "response",
                d.jsonObject([
                  ["data", state.response.data],
                  ["meta", state.response.meta],
                ]),
              ] as const,
            ]
          : state.kind === "rejected" || state.kind === "outcome_unknown"
            ? [["problem", problem(state.problem)] as const]
            : []),
      ]),
    ],
    ["diagnostic", operation.diagnostic === null ? d.jsonNull() : problem(operation.diagnostic)],
    ["receipt_lookup_supported", d.jsonBoolean(operation.receipt_lookup_supported)],
  ]);
}
async function identity(
  domain: "preparation" | "request" | "receipt",
  canonical: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`workgraph-ui:${domain}:v1\0${canonical}`),
  );
  return `${domain}:${bytes.byteLength}:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
async function admission(
  preparation: ProcessingJob & { kind: "admit" },
): Promise<PreparationAdmission> {
  const canonical = canonicalJson(preparationJson(preparation.preparation), HTTP_LIMITS);
  if (!canonical.ok) return { ok: false, message: canonical.error.message };
  const parsed = parseJsonText(canonical.value, HTTP_LIMITS);
  if (!parsed.ok) throw new Error("Canonical preparation failed its own parser");
  const decoded = d.preparation.decode(parsed.value.value);
  return decoded.ok
    ? {
        ok: true,
        preparation: decoded.value,
        identity: await identity("preparation", canonical.value),
      }
    : { ok: false, message: `Invalid preparation: ${decoded.issue.expected}` };
}
export async function processJob(job: ProcessingJob): Promise<unknown> {
  switch (job.kind) {
    case "parse":
      return typeof job.source === "string"
        ? parseJsonText(job.source, job.limits)
        : parseJsonBytes(job.source, job.limits);
    case "encode":
      return (job.canonical ? canonicalJson : stringifyJson)(job.value, job.limits);
    case "http": {
      const document = parseJsonBytes(
        job.bytes,
        job.budget === "operation" ? OPERATION_LIMITS : HTTP_LIMITS,
      );
      let result: HttpDecode;
      if (!document.ok) result = { ok: false, message: document.error.message, issue: undefined };
      else if (job.operation) {
        const validated = d.envelope(d.operation).decode(document.value.value);
        result = validated.ok
          ? { ok: true, value: document.value.value }
          : { ok: false, message: "Invalid companion operation response.", issue: validated.issue };
      } else result = { ok: true, value: document.value.value };
      return result;
    }
    case "admit":
      return admission(job);
    case "observe": {
      const encoded = stringifyJson(operationJson(job.operation), OPERATION_LIMITS);
      if (!encoded.ok)
        return { ok: false, message: encoded.error.message } satisfies OperationObservation;
      const parsed = parseJsonText(encoded.value, OPERATION_LIMITS);
      if (!parsed.ok) throw new Error("Encoded observation failed its own parser");
      const operation = d.operation.decode(parsed.value.value);
      if (!operation.ok)
        return {
          ok: false,
          message: `Invalid operation: ${operation.issue.expected}`,
        } satisfies OperationObservation;
      const request = canonicalJson(operation.value.request, OPERATION_LIMITS);
      const state = operation.value.state;
      const receipt =
        state.kind === "committed" || state.kind === "observed"
          ? canonicalJson(
              d.jsonObject([
                ["data", state.response.data],
                ["meta", state.response.meta],
              ]),
              OPERATION_LIMITS,
            )
          : null;
      if (!request.ok || (receipt !== null && !receipt.ok))
        return {
          ok: false,
          message: "Operation identity exceeds its full protocol bounds.",
        } satisfies OperationObservation;
      const admitted = await admission({
        kind: "admit",
        preparation: {
          intention_id: operation.value.preparation.intention_id,
          context: operation.value.preparation.context,
          connection_id: operation.value.connection.id,
          generation: operation.value.connection.generation,
          method: operation.value.preparation.method,
          params: operation.value.preparation.params,
        },
      });
      if (!admitted.ok) return admitted;
      return {
        ok: true,
        preparationIdentity: admitted.identity,
        operation: operation.value,
        requestIdentity: await identity("request", request.value),
        receiptIdentity: receipt === null ? null : await identity("receipt", receipt.value),
      } satisfies OperationObservation;
    }
    case "project":
      return projectCapturedPayload(job.capture, job.selection);
  }
}
