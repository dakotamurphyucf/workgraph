import type { WorkCommand } from "./types";
/** Short action-directory copy; exact requirements remain in each guarded form. */
export const ACTION_SUMMARY: Readonly<Record<WorkCommand, string>> = {
  "ticket.create": "Add a task with instructions and a place in your project.",
  "ticket.update":
    "Change the title, instructions or status. Active claimed work may need an instruction amendment instead.",
  "ticket.metadata":
    "Set priority, assignment, labels and acceptance criteria without transferring ownership.",
  "ticket.move": "Move this ticket and its children to another project, milestone or parent.",
  "ticket.archive": "Hide a ticket from everyday lists, or restore it. Its history is kept.",
  "ticket.hold": "Record why new work should wait, or remove a hold. This does not stop an agent.",
  "ticket.reopen": "Reopen completed work with a reason; dependent work will be checked again.",
  "ticket.claim": "Reserve ownership for the selected actor or run without starting a process.",
  "ticket.start": "Claim this ticket and mark work in progress when its rules allow it.",
  "ticket.renew_lease": "Extend the time-limited ownership of the current claim.",
  "ticket.release": "Give up the current claim so another eligible worker can take it.",
  "ticket.reassign":
    "Transfer the recorded claim to another actor or run under the current ownership rules.",
  "ticket.recover": "Recover interrupted ownership after recording the required recovery evidence.",
  "ticket.amendment.publish":
    "Propose changed instructions for active work and record who needs to acknowledge them.",
  "ticket.amendment.withdraw": "Withdraw an instruction change while keeping its history.",
  "ticket.amendment.acknowledge":
    "Confirm that you have read a specific version of changed instructions.",
  "ticket.paths.put":
    "Declare which files or folders this ticket expects to use and how they may be shared.",
  "ticket.hierarchy.put":
    "Choose how child tickets inherit prerequisites and affect parent completion.",
  "label.put": "Create or edit a shared tag for organizing tickets.",
  "status.put": "Create or edit a named stage within a supported lifecycle category.",
  "dependency.add": "Make another ticket a prerequisite for this work.",
  "dependency.remove": "Remove a direct prerequisite link from this ticket.",
  "dependency.waive": "Record a reason to waive a supported prerequisite rule.",
  "related.add": "Link another ticket for context without making it a prerequisite.",
  "related.remove": "Remove a contextual link without changing dependency rules.",
};
