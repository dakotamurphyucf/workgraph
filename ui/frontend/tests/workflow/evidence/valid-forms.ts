import { parseJsonText } from "../../../src/core/json";
import * as d from "../../../src/core/protocol/decoders";
import type { HttpClient } from "../../../src/core/protocol/http";
import type { Codec } from "../../../src/core/protocol/codec";
import type {
  EvidenceDraft,
  EvidenceMethod,
  FieldInput,
} from "../../../src/features/workflow/evidence/types";
import { definition } from "../../../src/features/workflow/evidence/commands";
import { initialInputs } from "../../../src/features/workflow/evidence/model";
function decode<T>(codec: Codec<T>, value: string): T {
  const result = codec.decode(d.jsonString(value));
  if (!result.ok) throw new Error(result.issue.expected);
  return result.value;
}
/** Fixed synthetic examples only. Production arbitrary JSON never enters JSON.parse. */
export const pinExamples = [
  { kind: "resource", resource_id: "evidence", revision: "2", digest: "a".repeat(64) },
  { kind: "event", session_id: "session", sequence: "1" },
  { kind: "commit", repository: "local-source", object_id: "b".repeat(40) },
  { kind: "checksum", source: "actual-test-result", digest: "c".repeat(64) },
  { kind: "comment", comment_id: "comment", revision: "1" },
  { kind: "amendment", amendment_id: "instruction", revision: "1" },
  { kind: "contract", contract_id: "contract", revision: "1" },
  { kind: "decision", decision_id: "decision", revision: "1" },
] as const;
export async function validDraft(http: HttpClient, method: EvidenceMethod): Promise<EvidenceDraft> {
  const scope = {
      connection: {
        id: decode(d.identifier, "local"),
        generation: decode(d.positiveDecimal, "1"),
        label: "Fixture",
        socket: "/tmp/fixture.sock",
      },
      workspaceId: decode(d.identifier, "demo"),
      ticketId: decode(d.identifier, "target"),
    },
    inputs: Record<string, FieldInput> = {
      ...(await initialInputs(http.processing, method, scope, null, new AbortController().signal)),
    };
  const fixed: Readonly<Record<string, unknown>> = {
    scope: { kind: "ticket", ticket_id: "target" },
    schema: { resource_id: "schema", revision: "1", digest: "a".repeat(64) },
    reviewers: [
      { kind: "actor", actor_id: "reviewer" },
      { kind: "role", name: "quality", member_ids: ["reviewer-two"] },
    ],
    validators: ["checks"],
    criteria: [{ key: "checks", description: "Actual checks passed", required: true }],
    inherited_override: {
      against: { scope: { kind: "project", project_id: "project" }, revision: "1" },
      membership_revision: "1",
      reviewers: [],
      validators: [],
      criteria: [],
      waive_separate_actor: false,
      reason: "Explicit audited waiver",
    },
    required_inputs: ["design"],
    required_outputs: ["source"],
    contract: { contract_id: "contract", revision: "1" },
    manifest: { manifest_id: "manifest", revision: "1" },
    inputs: [{ name: "design", pin: pinExamples[0] }],
    outputs: [{ name: "source", pin: pinExamples[3] }],
    criterion: {
      scope: { kind: "ticket", ticket_id: "target" },
      policy_revision: "1",
      key: "checks",
    },
    evidence_pins: [pinExamples[3]],
    affected: [
      { kind: "workspace" },
      { kind: "project", project_id: "project" },
      { kind: "milestone", milestone_id: "milestone" },
      { kind: "ticket", ticket_id: "target" },
      { kind: "resource", resource_id: "resource" },
    ],
    supersedes: [],
    rationale: pinExamples[3],
    previous: pinExamples[0],
    current: { ...pinExamples[0], revision: "3" },
    disposition: { kind: "continue", reason: "Verified the historical input remains appropriate" },
    artifact: pinExamples[3],
    recipients: ["reviewer"],
  };
  for (const field of definition(method).fields) {
    let value =
      field.initial ??
      (field.type === "identifier"
        ? field.name.replaceAll("_", "-")
        : field.type === "counter"
          ? "1"
          : field.type === "boolean"
            ? "true"
            : field.type === "choice"
              ? (field.choices?.[0] ?? "")
              : "Actual observed result");
    if (field.type === "json")
      value = JSON.stringify(
        field.name === "evidence" ? [pinExamples[3]] : (fixed[field.name] ?? {}),
      );
    if (field.name === "ticket_id") value = "target";
    if (field.name === "expected_policy_digest") value = "a".repeat(64);
    if (field.name === "expected_revision")
      value = method === "condition.signal" || method === "review.accept" ? "1" : "0";
    inputs[field.name] = { presence: "value", text: value };
  }
  return {
    id: decode(d.identifier, `evidence-${method.replaceAll(".", "-")}`),
    method,
    target: scope,
    writer: { actorId: decode(d.identifier, "author"), runId: decode(d.identifier, "run-one") },
    claim: {
      actorId: decode(d.identifier, "author"),
      runId: decode(d.identifier, "run-one"),
      token: decode(d.positiveDecimal, "7"),
    },
    projectId: decode(d.identifier, "project"),
    base: null,
    inputs,
    phase: { kind: "editing" },
    issue: null,
    unexpected: null,
  };
}
export function syntheticJson(source: string): unknown {
  const parsed = parseJsonText(source);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return JSON.parse(source) as unknown;
}
