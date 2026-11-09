import { useState } from "react";
import { Dialog } from "../../../components/Dialog";
import { Button, Select } from "../../../components/Primitives";
import { PRIORITY_LABEL } from "../views/labels";
import type { WorkActionContext } from "../read-model.types";
import type { WorkActionsFeatureProps, WorkCommand } from "./types";

/** Shortcuts only populate ordinary guarded drafts; choosing a value never writes. */
export function QuickTicketActions({
  target,
  props,
}: {
  readonly target: WorkActionContext;
  readonly props: WorkActionsFeatureProps;
}) {
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [unexpected, setUnexpected] = useState<{ error: unknown } | null>(null);
  if (unexpected) throw unexpected.error;
  const [priority, setPriority] = useState(target.ticket.value.ticket.priority);
  const ticket = target.ticket.value.ticket;
  const disabled = target.context.profileState !== "current";
  const open = (method: WorkCommand) =>
    props.controller.open(target.context, method, { scope: target.scope, ticket: target.ticket });
  return (
    <div className="work-quick-actions" aria-label="Quick ticket actions">
      <Button
        requiresActor
        disabled={disabled}
        onClick={() => {
          setPriority(ticket.priority);
          setPriorityOpen(true);
        }}
      >
        Priority · {PRIORITY_LABEL[ticket.priority] ?? ticket.priority}
      </Button>
      <Button requiresActor disabled={disabled} onClick={() => open("ticket.metadata")}>
        Assign / labels
      </Button>
      <Button requiresActor disabled={disabled} onClick={() => open("ticket.update")}>
        Edit ticket
      </Button>
      <Button
        requiresActor
        disabled={disabled}
        onClick={() => {
          const id = open("ticket.hold");
          if (id && ticket.hold)
            props.controller.edit(id, "reason", { kind: "scalar", presence: "null", text: "" });
        }}
      >
        {ticket.hold ? "Lift hold" : "Put on hold"}
      </Button>
      {props.askTicket && (
        <Button requiresActor disabled={disabled} onClick={() => props.askTicket?.(target)}>
          Ask a question
        </Button>
      )}
      {priorityOpen && (
        <Dialog
          title="Set ticket priority"
          description={`${ticket.display_key} · ${ticket.title}`}
          onClose={() => setPriorityOpen(false)}
        >
          <div className="work-dialog-content">
            <section className="work-action-explanation">
              <h3>Make the next priority clear</h3>
              <p>
                Priority helps people choose what to work on. It does not change the ticket’s
                status, assignment or claim. Continue to review this change before applying it.
              </p>
            </section>
            <Select
              label="Ticket priority"
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
            >
              {Object.entries(PRIORITY_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
            <div className="wg-form-actions">
              <Button onClick={() => setPriorityOpen(false)}>Cancel</Button>
              <Button
                tone="primary"
                requiresActor
                disabled={disabled}
                onClick={() => {
                  const id = open("ticket.metadata");
                  if (id) {
                    props.controller.edit(id, "priority", {
                      kind: "scalar",
                      presence: "value",
                      text: priority,
                    });
                    setPriorityOpen(false);
                    void props.controller
                      .review(id)
                      .catch((error: unknown) => setUnexpected({ error }));
                  }
                }}
              >
                Review priority change
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
