import { ACTION_SUMMARY } from "./action-summaries";
import type { WorkDraft } from "./types";
import { commandDefinition } from "./commands";
const GUIDANCE: Readonly<Record<string, readonly [string, string]>> = {
  "ticket.create": [
    "Describe a clear unit of work",
    "A ticket holds instructions, discussion and progress for one task. Creating it adds it to the selected workspace and project; it does not assign an owner or start an agent. Use the optional placement section to put it under a milestone or parent ticket.",
  ],
  "ticket.update": [
    "Update the ticket’s instructions or status",
    "Change the title, description or lifecycle stage. Fields left unspecified keep their existing values. Claimed work may require an instruction amendment instead, so an active worker can acknowledge the change. Completing a ticket uses its completion checks.",
  ],
  "ticket.metadata": [
    "Organize and assign this ticket",
    "Set priority, labels or the intended assignee. Assignment is a planning choice; it does not claim the ticket or transfer current ownership. Leave fields unspecified to keep them, or choose Clear where you want to remove a value.",
  ],
  "ticket.archive": [
    "Keep the record, hide it from everyday work",
    "Archiving retains the ticket and its history while hiding it from normal lists. It does not erase the work. Use the archived filter to find it later; restoring visibility is separate from reopening a completed ticket.",
  ],
  "label.put": [
    "Create or update a workspace label",
    "Labels are reusable tags for categorizing and filtering tickets. Create a new label with a unique ID, or load an existing label and use its values to edit it. Saving the label does not automatically attach it to tickets. Archived labels remain recorded but are hidden from normal label lists.",
  ],
  "status.put": [
    "Name a stage in your workflow",
    "A custom status gives a familiar name to one of Workgraph’s lifecycle categories, such as To do or In progress. Create a new status or load one to edit it. Saving a status definition does not move tickets into it or bypass claim and completion rules. Archiving hides the definition from normal status lists.",
  ],
  "ticket.start": [
    "Take ownership and begin work",
    "Start records a claim for the selected actor and begins work if the current requirements allow it. A claim coordinates who can make protected changes; it does not launch an agent or a process.",
  ],
  "ticket.hold": [
    "Pause eligibility with a reason",
    "A hold records why this ticket should not be picked up. It does not stop an agent process. Clearing the reason removes the hold; other prerequisites and permissions still apply.",
  ],
};
export function ActionExplanation({ draft }: { readonly draft: WorkDraft }) {
  const definition = commandDefinition(draft.method),
    copy = GUIDANCE[draft.method];
  return (
    <section className="work-action-explanation">
      <h3>{copy?.[0] ?? definition.title}</h3>
      <p>{copy?.[1] ?? ACTION_SUMMARY[draft.method]}</p>
      {!copy && <p className="work-section-help">{definition.hint}</p>}
      <p>
        Review action shows the proposed changes first. Nothing is saved until you apply the
        reviewed action. Closing this editor keeps the draft available.
      </p>
    </section>
  );
}
