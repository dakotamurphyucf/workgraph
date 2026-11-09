import type { EvidenceCommand, EvidenceField, EvidenceMethod, EvidenceRead } from "./types";
const field = (
  name: string,
  label: string,
  type: EvidenceField["type"] = "text",
  extra: Partial<EvidenceField> = {},
): EvidenceField => ({ name, label, type, ...extra });
const id = (name: string, label: string, optional = false) =>
  field(name, label, "identifier", { optional });
const json = (name: string, label: string, initial = "{}", optional = false, hint?: string) =>
  field(name, label, "json", { initial, optional, ...(hint === undefined ? {} : { hint }) });
const revision = field("expected_revision", "Expected object revision", "counter", {
  initial: "0",
  hint: "0 creates a new object. An existing object requires its actual current revision; this is not a workspace revision.",
});
const ticket = id("ticket_id", "Ticket ID");
const evidence = field("evidence", "Evidence and observations", "multiline");
const reviewers = json(
  "reviewers",
  "Named reviewers and reviewer roles",
  "[]",
  false,
  'Actor: {"kind":"actor","actor_id":"reviewer"}; role: {"kind":"role","name":"security","member_ids":["reviewer"]}. Attribution is cooperative, not authentication.',
);
const validators = json("validators", "Required validator names", "[]");
const enabled = field("enabled", "Enable requirements", "boolean", { initial: "true" });
const separate = field("separate_actor", "Require a different reviewer actor", "boolean", {
  initial: "true",
});
const weakening = field("weakening_reason", "Reason for weakening requirements", "multiline", {
  optional: true,
  hint: "Required by the daemon when requirements are removed, roles widened or overrides introduced.",
});
const manifest = json("manifest", "Exact manifest reference", '{"manifest_id":"","revision":"1"}');
const digest = field("expected_policy_digest", "Captured effective policy SHA-256");
const passed = field("passed", "Observed result passed", "boolean", { initial: "true" });
const version = field("schema_version", "Schema version", "counter", { initial: "1" });
const command = (
  method: EvidenceMethod,
  title: string,
  group: EvidenceCommand["group"],
  description: string,
  fields: readonly EvidenceField[],
): EvidenceCommand => ({ method, title, group, description, fields });
/** Small fixed current-API inventory, not a runtime plugin/form language. */
export const COMMANDS: readonly EvidenceCommand[] = [
  command(
    "acceptance.policy.put",
    "Edit acceptance policy and criteria",
    "policy",
    "Replaces the complete local project or ticket definition. Inherited sources and stale overrides remain visible separately. Review the before/after requirements; an override binds the exact project revision and membership revision.",
    [
      json("scope", "Policy scope"),
      revision,
      enabled,
      reviewers,
      separate,
      validators,
      json(
        "criteria",
        "Acceptance criteria",
        "[]",
        false,
        'Each row: {"key":"tests","description":"Actual checks pass","required":true}.',
      ),
      json("inherited_override", "Inherited override (explicit audited waiver)", "{}", true),
      weakening,
    ],
  ),
  command(
    "review.policy.put",
    "Edit review requirements",
    "policy",
    "Edits the canonical ticket policy's review projection while preserving its criteria and override. Requirement weakening needs an audited reason.",
    [ticket, revision, enabled, reviewers, separate, validators, weakening],
  ),
  command(
    "contract.put",
    "Publish artifact contract",
    "artifacts",
    "Pins the exact schema resource content version and digest. Required input/output names refer to manifest artifacts; resource metadata revision is not its content version.",
    [
      id("contract_id", "Contract ID"),
      revision,
      version,
      json(
        "schema",
        "Schema resource content pin",
        '{"resource_id":"","revision":"1","digest":""}',
      ),
      json("required_inputs", "Required input names", "[]"),
      json("required_outputs", "Required output names", "[]"),
    ],
  ),
  command(
    "manifest.publish",
    "Publish pinned manifest",
    "artifacts",
    "Publishes exact named inputs and outputs under the real attempt and current owner. Publishing a corrected manifest does not reuse historical reviews.",
    [
      id("manifest_id", "Manifest ID"),
      revision,
      version,
      id("attempt_id", "Actual attempt ID"),
      ticket,
      json("contract", "Exact contract reference", '{"contract_id":"","revision":"1"}'),
      json("inputs", "Named input pins", "[]"),
      json("outputs", "Named output pins", "[]"),
    ],
  ),
  command(
    "acceptance.assert",
    "Record criterion assertion",
    "review",
    "Records an actual result against an exact criterion source and current policy digest/claim. Include the current attempt/manifest when present; prose alone does not create a proof.",
    [
      ticket,
      field("token", "Actual claim token", "counter"),
      id("attempt_id", "Actual attempt ID", true),
      json("manifest", "Exact manifest reference", '{"manifest_id":"","revision":""}', true),
      digest,
      json(
        "criterion",
        "Criterion source reference",
        '{"scope":{"kind":"ticket","ticket_id":""},"policy_revision":"1","key":""}',
      ),
      passed,
      json("evidence_pins", "Exact supporting evidence pins", "[]"),
      evidence,
    ],
  ),
  command(
    "validation.add",
    "Record validator result",
    "review",
    "Records the observed external check; the browser does not execute retrieved commands. Validator name and policy digest bind this exact manifest.",
    [
      id("validation_id", "Validation ID"),
      manifest,
      id("name", "Validator name"),
      digest,
      passed,
      evidence,
    ],
  ),
  command(
    "review.submit",
    "Submit a review generation",
    "review",
    "Freezes the exact manifest in a new generation and creates a formal request. Changed generations need fresh verdicts; old requests are not silently resolved.",
    [ticket, revision, manifest, id("review_request_id", "Formal request ID (optional)", true)],
  ),
  command(
    "review.record",
    "Record independent review",
    "review",
    "Records the actual reviewer's verdict on the specified generation. Approval is one verdict, not acceptance or completion. Selecting another actor is attribution, not proof that review happened.",
    [
      id("review_id", "Review ID"),
      ticket,
      field("generation", "Submission generation", "counter"),
      field("verdict", "Verdict", "choice", {
        choices: ["approve", "request_changes"],
        initial: "request_changes",
      }),
      evidence,
      id("comment_id", "Supporting comment ID (optional)", true),
    ],
  ),
  command(
    "review.accept",
    "Accept current submission",
    "review",
    "Only the recorded submitter may accept, using the actual submission revision. The daemon rechecks current policy, ownership, manifest, validation and reviewer gates. This never finishes a ticket.",
    [ticket, revision],
  ),
  command(
    "decision.put",
    "Publish evidence-backed decision",
    "changes",
    "Keeps exact rationale/evidence pins, affected entities and superseded decisions. Existing historical versions remain available.",
    [
      id("decision_id", "Decision ID"),
      revision,
      json("scope", "Decision scope"),
      field("title", "Decision title"),
      json("rationale", "Exact rationale pin"),
      json("evidence", "Supporting pins", "[]"),
      json("affected", "Affected entities", "[]"),
      json("supersedes", "Superseded decision IDs", "[]"),
    ],
  ),
  command(
    "input.changed",
    "Declare changed input",
    "changes",
    "Records exact previous/current pins and queues reconciliation for affected consumers. Existing immutable evidence is not rewritten.",
    [json("previous", "Previous exact input pin"), json("current", "Current exact input pin")],
  ),
  command(
    "reconciliation.record",
    "Reconcile changed input",
    "changes",
    "Acknowledge, justify continued historical use, or bind a revised manifest explicitly. Live revised work requires the actual attempt owner; terminal acknowledgement does not grant replacement ownership.",
    [
      field("serial", "Reconciliation serial", "counter"),
      revision,
      json(
        "disposition",
        "Disposition",
        '{"kind":"acknowledge"}',
        false,
        'Use {"kind":"continue","reason":"…"} or {"kind":"revised","manifest":{"manifest_id":"…","revision":"…"}} where appropriate.',
      ),
    ],
  ),
  command(
    "condition.put",
    "Declare external condition",
    "conditions",
    "Binds an actual candidate artifact and operation identity. Waiting or a broad charter pin never creates authorization. Declare before signaling the observed external outcome.",
    [
      id("condition_id", "Condition ID"),
      revision,
      ticket,
      field("label", "Condition label"),
      id("operation_id", "Exact external operation ID"),
      json("artifact", "Exact candidate artifact pin"),
      field("required", "Required for completion", "boolean", { optional: true, initial: "true" }),
      json("recipients", "Recipients", "[]", true),
    ],
  ),
  command(
    "condition.signal",
    "Record external condition outcome",
    "conditions",
    "Record only an actually observed approval/result for the exact candidate, operation and declaration revision. A mismatched placeholder is not approval.",
    [
      id("signal_id", "Signal ID"),
      id("condition_id", "Condition ID"),
      revision,
      id("operation_id", "Exact external operation ID"),
      json("artifact", "Exact candidate artifact pin"),
      field("summary", "Observed outcome"),
      json("evidence", "Supporting evidence pins", "[]"),
    ],
  ),
];
export function definition(method: EvidenceMethod): EvidenceCommand {
  const found = COMMANDS.find((item) => item.method === method);
  if (found === undefined) throw new Error(`Unknown evidence command ${method}`);
  return found;
}
export const READS: readonly EvidenceRead[] = [
  "acceptance.policy.get",
  "acceptance.policy.effective",
  "acceptance.assertions",
  "review.policy.get",
  "contract.get",
  "contract.list",
  "contract.history",
  "manifest.get",
  "manifest.list",
  "manifest.history",
  "validation.list",
  "review.submission.get",
  "review.submission.list",
  "review.list",
  "decision.get",
  "decision.list",
  "decision.history",
  "reconciliation.list",
  "condition.get",
  "condition.list",
  "condition.signals",
];
