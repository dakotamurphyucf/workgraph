import { STATUS_LABEL, PRIORITY_LABEL } from "./labels";
import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { Button, Field, Select } from "../../../components/Primitives";
import { Icon } from "../../../components/Icon";
import * as d from "../../../core/protocol/decoders";
import { createReadSlot } from "../../../core/state/read-slot";
import { failureText } from "../../connections/failure";
import type { FeatureContext } from "../../../app/types";
import type { ParticipantRecord } from "../../participants/runs/types";
import { readKnownActors } from "../actor-choices";
import { current, DEFAULT_WORK_FILTERS, workScopeKey } from "../read-model";
import { TICKET_STATUSES, type WorkFilters, type WorkScope } from "../read-model.types";
export function WorkFiltersForm({
  initial,
  apply,
  disabled,
  scope,
  context,
}: {
  readonly initial: WorkFilters;
  readonly apply: (filters: WorkFilters) => void;
  readonly disabled: boolean;
  readonly scope: WorkScope;
  readonly context: FeatureContext;
}) {
  const [draft, setDraft] = useState(initial),
    [error, setError] = useState("");
  const [slot] = useState(() => createReadSlot<readonly ParticipantRecord[]>());
  const actors = useSyncExternalStore(slot.subscribe, slot.get),
    key = workScopeKey(scope);
  useEffect(() => {
    if (disabled) return;
    void slot
      .load(key, (signal) => readKnownActors(context.client, scope, signal))
      .catch(() => {
        /* Slot retains unexpected failures. */
      });
    return () => slot.clear();
    // The key includes endpoint generation, socket, workspace and project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot, key, context.client, disabled]);
  if (actors.kind === "unexpected_error") throw actors.error;
  const known = current(actors) ?? [];
  function submit(event: FormEvent) {
    event.preventDefault();
    if (new TextEncoder().encode(draft.text).byteLength > 256) {
      setError("Search is too long. Use up to 256 UTF-8 bytes.");
      return;
    }
    if (
      [draft.assigneeId, draft.labelId, draft.milestoneId].some(
        (value) => value !== "" && !d.identifier.decode(d.jsonString(value)).ok,
      )
    ) {
      setError("Use letters, numbers, hyphens or underscores for identifiers.");
      return;
    }
    setError("");
    apply(draft);
  }
  return (
    <form className="work-filters work-dialog-content" onSubmit={submit} aria-label="Ticket query">
      <section className="work-form-card">
        <header>
          <Icon name="filter" />
          <div>
            <h3>Find the work you need</h3>
            <p>
              Combine these filters to narrow the board and list. This changes your view, not the
              tickets.
            </p>
          </div>
        </header>
        <div className="work-form-card-body">
          <div className="work-quick-filters" role="group" aria-label="Common filters">
            <Button onClick={() => setDraft({ ...DEFAULT_WORK_FILTERS })}>All tickets</Button>
            <Button onClick={() => setDraft({ ...DEFAULT_WORK_FILTERS, status: "todo" })}>
              To do
            </Button>
            <Button onClick={() => setDraft({ ...DEFAULT_WORK_FILTERS, status: "in_progress" })}>
              In progress
            </Button>
            <Button
              requiresActor
              disabled={false}
              title={
                context.writer.actorId === null
                  ? "Choose an acting actor in the sidebar first"
                  : "Tickets assigned to the selected actor"
              }
              onClick={() =>
                setDraft({ ...DEFAULT_WORK_FILTERS, assigneeId: context.writer.actorId ?? "" })
              }
            >
              Assigned to me
            </Button>
            <Button onClick={() => setDraft({ ...DEFAULT_WORK_FILTERS, priority: "1" })}>
              Urgent
            </Button>
          </div>
          <div className="work-filter-grid">
            <Field
              label="Search tickets"
              value={draft.text}
              placeholder="Title, instructions or acceptance criteria"
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            />
            <Select
              label="Status filter"
              value={draft.status}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  status: TICKET_STATUSES.find((s) => s === e.target.value) ?? "",
                })
              }
            >
              <option value="">All statuses</option>
              {TICKET_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
            <Select
              label="Assigned to"
              value={draft.assigneeId}
              onChange={(e) => setDraft({ ...draft, assigneeId: e.target.value })}
            >
              <option value="">Anyone</option>
              {draft.assigneeId !== "" && !known.some((a) => a.actor_id === draft.assigneeId) && (
                <option value={draft.assigneeId}>{draft.assigneeId}</option>
              )}
              {known.map((a) => (
                <option key={a.actor_id} value={a.actor_id}>
                  {a.registration?.name ?? a.actor_id}
                  {a.registration?.name && a.registration.name !== a.actor_id
                    ? ` · ${a.actor_id}`
                    : ""}
                  {a.registration?.archived ? " (archived)" : ""}
                </option>
              ))}
            </Select>
            <Select
              label="Priority filter"
              value={draft.priority}
              onChange={(e) => setDraft({ ...draft, priority: e.target.value })}
            >
              <option value="">All priorities</option>
              {Object.entries(PRIORITY_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
          <p className="wg-hint">
            Assignment is who a ticket is intended for. A claim records who is currently working on
            it.
          </p>
          {actors.kind === "loading" && !current(actors) && (
            <p className="wg-hint" role="status">
              Finding known people and agents…
            </p>
          )}
          {actors.kind === "failed" && (
            <div role="alert">
              <p>{failureText(actors.failure)} Manual IDs remain available below.</p>
              <Button
                onClick={() => {
                  void slot
                    .load(key, (signal) => readKnownActors(context.client, scope, signal))
                    .catch(() => {});
                }}
              >
                Retry actor choices
              </Button>
            </div>
          )}
        </div>
      </section>
      <details className="work-form-card work-advanced-filters">
        <summary>
          <Icon name="settings" />
          Custom filters and archived work
        </summary>
        <div className="work-form-card-body">
          <p>
            Use exact identifiers for a specific label, milestone, or an actor not yet in the
            workspace directory.
          </p>
          <div className="work-filter-grid">
            <Field
              label="Assignee ID"
              value={draft.assigneeId}
              onChange={(e) => setDraft({ ...draft, assigneeId: e.target.value })}
            />
            <Field
              label="Label ID"
              value={draft.labelId}
              onChange={(e) => setDraft({ ...draft, labelId: e.target.value })}
            />
            <Field
              label="Milestone ID"
              value={draft.milestoneId}
              onChange={(e) => setDraft({ ...draft, milestoneId: e.target.value })}
            />
          </div>
          <label className="work-checkbox">
            <input
              type="checkbox"
              checked={draft.includeArchived}
              onChange={(e) => setDraft({ ...draft, includeArchived: e.target.checked })}
            />
            Include archived tickets
          </label>
          <p className="wg-hint">
            Archived tickets are retained records hidden from normal work views. Including them here
            does not restore or reopen them.
          </p>
        </div>
      </details>
      {error && (
        <p role="alert" className="wg-error">
          {error}
        </p>
      )}
      <div className="work-dialog-footer">
        <span>Filters apply to this workspace and selected project.</span>
        <Button disabled={disabled} type="submit" tone="primary">
          Apply filters
        </Button>
      </div>
    </form>
  );
}
