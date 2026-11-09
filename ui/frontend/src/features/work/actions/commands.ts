import type { CommandDefinition, FormField, ScalarField, WorkCommand } from "./types";

const scalar = (
  name: string,
  label: string,
  type: ScalarField["type"] = "text",
  options: Omit<ScalarField, "kind" | "name" | "label" | "type"> = {},
): ScalarField => ({ kind: "scalar", name, label, type, ...options });
const identifier = (name: string, label: string, optional = false, nullable = false) =>
  scalar(name, label, "identifier", { optional, nullable });
const reason = scalar("reason", "Reason", "multiline", { nonblank: true, maxBytes: 65536 });
const title = scalar("title", "Title", "text", { nonblank: true, maxBytes: 512 });
const description = scalar("description", "Description", "multiline", { maxBytes: 65536 });
const lifecycle = ["backlog", "todo", "in_progress", "done", "canceled"] as const;
const choice = (name: string, label: string, choices: readonly string[], initial: string) =>
  scalar(name, label, "enum", { choices, initial });
const lease = scalar("lease_duration_ms", "Lease duration in milliseconds", "counter", {
  optional: true,
  positive: true,
  maximum: "86400000",
  hint: "Omit for indefinite ownership. Expiry never means a process stopped.",
});
const revisionSource = choice("_revision_source", "Create or edit", ["new", "loaded"], "new");
const definition = (
  method: WorkCommand,
  title: string,
  group: CommandDefinition["group"],
  target: CommandDefinition["target"],
  hint: string,
  fields: readonly FormField[],
): CommandDefinition => ({ method, title, group, target, hint, fields });

export const COMMANDS: readonly CommandDefinition[] = [
  definition(
    "ticket.create",
    "Create ticket",
    "ticket",
    "new",
    "Create in this captured workspace. Placement is explicit; no claim or attempt is started.",
    [
      identifier("ticket_id", "Ticket ID (optional)", true),
      title,
      description,
      identifier("project_id", "Project", true),
      identifier("milestone_id", "Milestone", true),
      identifier("parent_ticket_id", "Parent ticket", true),
    ],
  ),
  definition(
    "ticket.update",
    "Edit instructions or lifecycle",
    "ticket",
    "ticket",
    "Uses the captured ticket revision. Claimed work requires release or an instruction amendment. Completion uses evidence through the progress workflow.",
    [
      { ...title, optional: true },
      { ...description, optional: true },
      scalar("status", "Lifecycle", "enum", {
        optional: true,
        choices: lifecycle.filter((value) => value !== "done"),
      }),
    ],
  ),
  definition(
    "ticket.metadata",
    "Edit metadata and assignment",
    "ticket",
    "ticket",
    "Assignment is separate from claim ownership. Omitted fields preserve values; Clear sends explicit null only where supported.",
    [
      scalar("priority", "Priority (0 unspecified, 1 urgent, 2 high, 3 normal, 4 low)", "counter", {
        optional: true,
        maximum: "4",
      }),
      identifier("assignee_id", "Assigned actor", true, true),
      scalar("label_ids", "Label IDs, one per line", "multiline", {
        optional: true,
        maxBytes: 4194304,
      }),
      scalar("acceptance_criteria", "Acceptance criteria", "multiline", {
        optional: true,
        maxBytes: 65536,
      }),
      identifier("status_id", "Named status", true, true),
    ],
  ),
  definition(
    "ticket.move",
    "Move ticket and descendants",
    "ticket",
    "ticket",
    "Moving updates descendant placement. Actual target membership and ticket revision are captured; route project is only a list filter.",
    [
      identifier("project_id", "Destination project", false, true),
      identifier("milestone_id", "Destination milestone", false, true),
      identifier("parent_ticket_id", "Destination parent", false, true),
    ],
  ),
  definition(
    "ticket.archive",
    "Archive or restore ticket",
    "ticket",
    "ticket",
    "Retains the ticket and its history. Hard deletion is unsupported.",
    [scalar("archived", "Archived", "boolean", { initial: "true" })],
  ),
  definition(
    "ticket.hold",
    "Set or lift a hold",
    "ticket",
    "ticket",
    "A hold affects eligibility. Clear explicitly lifts it; it does not stop any process.",
    [{ ...reason, nullable: true }],
  ),
  definition(
    "ticket.reopen",
    "Reopen completed work",
    "ticket",
    "ticket",
    "Native reopening rules and dependent reassessment remain authoritative; a reason is recorded.",
    [reason],
  ),
  definition(
    "ticket.claim",
    "Claim ticket",
    "ownership",
    "ticket",
    "Acquire logical ownership under current admission checks without starting an attempt.",
    [lease],
  ),
  definition(
    "ticket.start",
    "Start work",
    "ownership",
    "ticket",
    "Claim atomically. An optional attempt requires a captured registered run; choosing an actor never creates one.",
    [
      lease,
      identifier("attempt_id", "Attempt ID (optional)", true),
      scalar("initial_note", "Initial note", "multiline", {
        optional: true,
        nonblank: true,
        maxBytes: 65536,
      }),
    ],
  ),
  definition(
    "ticket.renew_lease",
    "Renew own timed claim",
    "ownership",
    "ticket",
    "Uses the captured owner, token and lease revision. Server clock and expiry checks are authoritative.",
    [],
  ),
  definition(
    "ticket.release",
    "Release own claim",
    "ownership",
    "ticket",
    "Returns work to Todo and cancels active attempts with release evidence. This never terminates a process.",
    [],
  ),
  definition(
    "ticket.reassign",
    "Transfer or release a claim",
    "ownership",
    "ticket",
    "Requires an existing claim and no active attempt. A fresh fence is allocated. Clear claimant releases ownership; assignment metadata is unchanged.",
    [
      identifier("claimant_id", "New claimant", false, true),
      identifier("claimant_run_id", "New claimant run", true),
      reason,
    ],
  ),
  definition(
    "ticket.recover",
    "Recover an expired claim",
    "ownership",
    "ticket",
    "Only after you have actually stopped or isolated the prior execution. Exact old actor/run, token and lease revision are retained; the daemon verifies expiry. No process is stopped by this UI.",
    [
      identifier("recovery_id", "Recovery audit ID"),
      choice(
        "confirmation",
        "External execution confirmation",
        ["stopped", "isolated"],
        "isolated",
      ),
      choice(
        "disposition",
        "Ticket disposition",
        ["preserve_status", "requeue"],
        "preserve_status",
      ),
      { ...reason, maxBytes: 4096 },
      choice(
        "confirmed",
        "I have actually stopped or isolated the prior execution",
        ["no", "yes"],
        "no",
      ),
      { kind: "pins", name: "evidence", label: "Exact evidence pins (optional)", maxRows: 100 },
    ],
  ),
  definition(
    "dependency.add",
    "Add prerequisite",
    "relationships",
    "ticket",
    "Prerequisites may belong to another project. Native cycle/readiness validation is authoritative; this method has no expected_revision parameter.",
    [identifier("prerequisite_id", "Prerequisite ticket ID")],
  ),
  definition(
    "dependency.remove",
    "Remove prerequisite",
    "relationships",
    "ticket",
    "Remove only the explicitly selected edge. This method has no expected_revision parameter.",
    [identifier("prerequisite_id", "Prerequisite ticket ID")],
  ),
  definition(
    "dependency.waive",
    "Waive or restore prerequisite blocking",
    "relationships",
    "ticket",
    "Preserves the edge and records a reason. Clear removes the waiver.",
    [identifier("prerequisite_id", "Prerequisite ticket ID"), { ...reason, nullable: true }],
  ),
  definition(
    "related.add",
    "Link related ticket",
    "relationships",
    "ticket",
    "Load the other ticket before capture. Both actual ticket revisions are guarded; cross-project relationships are supported.",
    [identifier("related_id", "Related ticket ID")],
  ),
  definition(
    "related.remove",
    "Unlink related ticket",
    "relationships",
    "ticket",
    "Load the other ticket before capture. Both actual ticket revisions are guarded.",
    [identifier("related_id", "Related ticket ID")],
  ),
  definition(
    "ticket.amendment.publish",
    "Publish instruction amendment",
    "guardrails",
    "ticket",
    "Attributed immutable instructions can change without rewriting a claimed ticket. A new amendment uses revision zero; load an existing ID before adding a revision.",
    [
      revisionSource,
      identifier("amendment_id", "Amendment ID"),
      title,
      choice("source_kind", "Instruction source", ["text", "resource"], "text"),
      scalar("source_body", "Instruction text", "multiline", { maxBytes: 65536 }),
      identifier("resource_id", "Resource ID", true),
      scalar("resource_revision", "Resource version", "counter", {
        optional: true,
        positive: true,
      }),
      scalar("resource_digest", "Resource SHA-256", "text", { optional: true, maxBytes: 64 }),
      scalar("require_ack", "Require current claimant acknowledgement", "boolean", {
        initial: "true",
      }),
      {
        kind: "amendments",
        name: "supersedes",
        label: "Exact superseded amendments (optional)",
        maxRows: 32,
      },
    ],
  ),
  definition(
    "ticket.amendment.withdraw",
    "Withdraw instruction amendment",
    "guardrails",
    "ticket",
    "Load the exact amendment first. Withdrawal retains immutable history and requires a reason.",
    [identifier("amendment_id", "Amendment ID"), reason],
  ),
  definition(
    "ticket.amendment.acknowledge",
    "Acknowledge exact amendment",
    "guardrails",
    "ticket",
    "Load the exact amendment revision first. Only the captured current claim owner/token can acknowledge it.",
    [identifier("amendment_id", "Amendment ID")],
  ),
  definition(
    "ticket.paths.put",
    "Edit required logical paths",
    "guardrails",
    "ticket",
    "Load the current policy revision. No claim or nonterminal attempt may remain. Logical paths coordinate ownership; they do not enforce filesystem access.",
    [
      {
        ...revisionSource,
        initial: "loaded",
        hint: "New explicitly sends revision zero; it does not assert absence. Loaded requires a complete policy capture.",
      },
      scalar("require_reservations", "Require reservations on acquisition", "boolean", {
        initial: "true",
      }),
      { kind: "paths", name: "declarations", label: "Required paths", maxRows: 100 },
    ],
  ),
  definition(
    "ticket.hierarchy.put",
    "Edit hierarchy rules",
    "guardrails",
    "ticket",
    "Load the stored policy first. Absent policy remains distinct from explicit defaults; edits record a reason.",
    [
      choice(
        "descendant_prerequisites",
        "Descendant prerequisite rules",
        ["independent", "inherit"],
        "independent",
      ),
      choice(
        "child_completion",
        "Child completion rule",
        ["all_done", "done_or_canceled"],
        "all_done",
      ),
      reason,
    ],
  ),
  definition(
    "label.put",
    "Create or edit reusable label",
    "ticket",
    "workflow",
    "Workspace metadata. Load an existing label to bind its revision, or explicitly create a new ID under revision zero.",
    [
      revisionSource,
      identifier("label_id", "Label ID"),
      scalar("name", "Name", "text", { nonblank: true, maxBytes: 512 }),
      { ...description, optional: true },
      scalar("archived", "Archived", "boolean", { optional: true }),
    ],
  ),
  definition(
    "status.put",
    "Create or edit named status",
    "ticket",
    "workflow",
    "Workspace metadata. A status category does not bypass claimed-work or completion rules when assigned to a ticket.",
    [
      revisionSource,
      identifier("status_id", "Status ID"),
      scalar("name", "Name", "text", { nonblank: true, maxBytes: 512 }),
      choice("category", "Lifecycle category", lifecycle, "todo"),
      scalar("archived", "Archived", "boolean", { optional: true }),
    ],
  ),
];

export function commandDefinition(method: WorkCommand): CommandDefinition {
  const found = COMMANDS.find((item) => item.method === method);
  if (found === undefined) throw new Error(`Missing closed command definition: ${method}`);
  return found;
}
