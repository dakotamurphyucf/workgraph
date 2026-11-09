import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "../../components/Primitives";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { ReferencePicker } from "../discussions/ReferencePicker";
import { RecipientPicker } from "../discussions/RecipientPicker";
import { createReadSlot } from "../../core/state/read-slot";
import { useLiveSlot } from "../../core/state/live-registry";
import { captureScope, identifier, OverviewInputError, scopeKey } from "../overview/model";
import { Read } from "../overview/presentation";
import type { ActivityFeatureProps } from "../overview/types";
import { createActivityClient } from "./client";
import { ActivityScrollAnchor } from "./ActivityScrollAnchor";
import { AuditRow } from "./AuditRow";
import { auditDate } from "./model";
import type { ActivityFilter, AuditEvent, AuditPosition, AuditWindow } from "./types";
import "./activity.css";
import "./activity-design.css";

/** A new endpoint/workspace/project unmounts all old captures and filter drafts. */
export function ActivityFeature({ context }: ActivityFeatureProps) {
  return <ActivityFeed key={scopeKey(captureScope(context))} context={context} />;
}
function ActivityFeed({ context }: Pick<ActivityFeatureProps, "context">) {
  // The parent key already identifies every scope field. Connection/status
  // refreshes may recreate FeatureContext without changing this scope; they
  // must not clear the read slot and unmount expanded audit rows.
  const [scope] = useState(() => captureScope(context));
  const api = useMemo(() => createActivityClient(context.client), [context.client]);
  const slot = useMemo(() => createReadSlot<AuditWindow>(), []);
  const state = useSyncExternalStore(slot.subscribe, slot.get);
  const [filter, setFilter] = useState<ActivityFilter>({ ticketId: "", actorId: "" });
  const [editor, setEditor] = useState(filter);
  const [guideOpen, setGuideOpen] = useState(false);
  const endpoint = {
    connectionId: scope.connection.id,
    generation: scope.connection.generation,
    workspaceId: scope.workspaceId,
  };
  const clearFilters = () => {
    setFilter({ ticketId: "", actorId: "" });
    setPosition(null);
  };
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [issue, setIssue] = useState<string | null>(null);
  const [position, setPosition] = useState<AuditPosition | null>(null);
  const [reload, setReload] = useState(0);
  useLiveSlot(slot);
  useEffect(() => () => slot.clear(), [slot]);
  useEffect(() => {
    const key = JSON.stringify([
      scopeKey(scope),
      filter,
      position?.revision,
      position?.end.toString(),
      position?.total.toString(),
    ]);
    const before = slot.get();
    void slot
      .load(key, (signal) => api.window(scope, filter, position, signal), {
        live: position === null,
        background: before.kind !== "idle" && before.key === key,
      })
      .catch(() => {
        // The read slot publishes the original exception. Read rethrows it.
      });
  }, [api, scope, filter, position, reload, slot]);
  const latest = () => {
    setPosition(null);
    setReload((n) => n + 1);
  };
  return (
    <div className="ac-feature" data-feature="activity">
      <div className="ac-scroll">
        <div className="ac-content">
          <header className="ac-page-heading">
            <div>
              <span className="ac-eyebrow">
                <Icon name="activity" /> The story of your work
              </span>
              <h1>Activity</h1>
              <p>
                See who changed what, follow progress, and revisit the decisions behind the work.
              </p>
            </div>
            <div className="ac-heading-actions">
              <Button tone="quiet" onClick={() => setGuideOpen(true)}>
                How activity works
              </Button>
              <Button
                onClick={() => {
                  setEditor(filter);
                  setIssue(null);
                  setFiltersOpen(true);
                }}
              >
                <Icon name="filter" />
                Filters
              </Button>
              <Button tone="quiet" aria-label="Show latest activity" onClick={latest}>
                <Icon name="refresh" /> Latest
              </Button>
            </div>
          </header>
          <div className="ac-feed-toolbar" aria-label="Activity scope">
            <div className="ac-scope-label">
              <Icon name="activity" />
              <strong>
                {filter.ticketId
                  ? "Ticket activity"
                  : scope.projectId
                    ? "Project activity"
                    : "Workspace activity"}
              </strong>
              <span>Newest first</span>
            </div>
            <div className="ac-quick-filters">
              {context.writer.actorId && (
                <Button
                  tone="quiet"
                  aria-pressed={filter.actorId === context.writer.actorId}
                  onClick={() => {
                    setFilter({
                      ...filter,
                      actorId:
                        filter.actorId === context.writer.actorId ? "" : context.writer.actorId!,
                    });
                    setPosition(null);
                  }}
                >
                  <Icon name="participants" />
                  My activity
                </Button>
              )}
              {(filter.ticketId || filter.actorId) && (
                <Button tone="quiet" onClick={clearFilters}>
                  Clear filters
                </Button>
              )}
            </div>
          </div>
          {(filter.ticketId || filter.actorId) && (
            <div className="ac-filter-chips">
              {filter.ticketId && (
                <span>
                  <Icon name="work" />
                  Ticket · {filter.ticketId}
                  <button
                    aria-label="Remove ticket filter"
                    onClick={() => {
                      setFilter({ ...filter, ticketId: "" });
                      setPosition(null);
                    }}
                  >
                    <Icon name="close" />
                  </button>
                </span>
              )}
              {filter.actorId && (
                <span>
                  <Icon name="participants" />
                  Actor · {filter.actorId}
                  <button
                    aria-label="Remove actor filter"
                    onClick={() => {
                      setFilter({ ...filter, actorId: "" });
                      setPosition(null);
                    }}
                  >
                    <Icon name="close" />
                  </button>
                </span>
              )}
              {filter.ticketId && (
                <p>
                  Ticket activity is searched across the workspace, even when a project is selected.
                </p>
              )}
            </div>
          )}
          {position !== null && (
            <div className="ac-history-notice">
              Viewing earlier activity at a saved capture.{" "}
              <button onClick={latest}>Return to live activity →</button>
            </div>
          )}
          <Read state={state} label="activity" quiet>
            {(window) => {
              const rows = [...window.events].reverse();
              return (
                <>
                  <ActivityTimeline
                    key={JSON.stringify([filter, position?.revision, position?.end.toString()])}
                    events={window.events}
                    scope={scope}
                  />
                  {rows.length === 0 && (
                    <div className="ac-empty">
                      <Icon name="activity" />
                      <h3>
                        {filter.ticketId || filter.actorId
                          ? "No matching activity"
                          : "Your activity starts here"}
                      </h3>
                      <p>
                        {position !== null
                          ? "There are no matching records in this saved capture. Return to live activity to check for new changes."
                          : filter.ticketId || filter.actorId
                            ? "Try another ticket or actor, or clear the filters to see more changes."
                            : "Create a ticket, share a comment, or save a resource. Recorded changes will appear here automatically."}
                      </p>
                      {(filter.ticketId || filter.actorId) && (
                        <Button onClick={clearFilters}>Clear filters</Button>
                      )}
                    </div>
                  )}
                  <footer className="ac-audit-footer">
                    <span>
                      <i data-live={position === null} />
                      {position === null ? "Live activity" : "Saved history"} · {rows.length}{" "}
                      recorded events · r{window.revision}
                    </span>
                    <div>
                      {position !== null && window.end < window.total && (
                        <Button
                          tone="quiet"
                          disabled={state.kind === "loading"}
                          onClick={() =>
                            setPosition({
                              revision: window.revision,
                              total: window.total,
                              end:
                                window.end + 25n < window.total ? window.end + 25n : window.total,
                            })
                          }
                        >
                          Newer activity
                        </Button>
                      )}
                      {window.start > 0n && (
                        <Button
                          tone="quiet"
                          disabled={state.kind === "loading"}
                          onClick={() =>
                            setPosition({
                              revision: window.revision,
                              total: window.total,
                              end: window.start,
                            })
                          }
                        >
                          Earlier activity <Icon name="chevron" />
                        </Button>
                      )}
                    </div>
                  </footer>
                </>
              );
            }}
          </Read>
        </div>
      </div>
      {guideOpen && (
        <Dialog
          title="How activity works"
          description="A running record of the changes people and agents make in this workspace."
          onClose={() => setGuideOpen(false)}
        >
          <div className="ac-guide">
            <section>
              <Icon name="activity" />
              <div>
                <h3>Follow the latest changes</h3>
                <p>
                  The newest records appear first and update automatically while you are viewing
                  live activity. Times use your device’s time zone. Open details and your reading
                  position stay in place as new records arrive.
                </p>
              </div>
            </section>
            <section>
              <Icon name="filter" />
              <div>
                <h3>Find the work that matters</h3>
                <p>
                  The selected project limits this feed. Filters let you follow a specific ticket
                  across the workspace, a contributor, or both. “My activity” uses the actor
                  selected in the app.
                </p>
              </div>
            </section>
            <section>
              <Icon name="history" />
              <div>
                <h3>Revisit earlier work</h3>
                <p>
                  Earlier activity opens a saved capture so new writes do not move the pages you are
                  browsing. Use Newer activity to move forward, or Return to live activity to resume
                  updates.
                </p>
              </div>
            </section>
            <section>
              <Icon name="list" />
              <div>
                <h3>Understand a record</h3>
                <p>
                  One saved operation can contain several changes. Expand Details to see them all,
                  with the original contributor, time and run. Ticket and run links open their
                  current views; the activity record itself stays historical. A ticket snapshot
                  describes its state at that moment, not which individual fields changed.
                </p>
              </div>
            </section>
          </div>
        </Dialog>
      )}
      {filtersOpen && (
        <Dialog
          title="Filter activity"
          wide
          description="Explore recorded changes by ticket or by the actor who made them. Choosing a ticket searches that ticket across the workspace."
          onClose={() => setFiltersOpen(false)}
        >
          <form
            className="ac-filter-form"
            onSubmit={(event) => {
              event.preventDefault();
              try {
                if (editor.ticketId) identifier(editor.ticketId, "Ticket");
                if (editor.actorId) identifier(editor.actorId, "Actor");
                setFilter(editor);
                setPosition(null);
                setFiltersOpen(false);
              } catch (error) {
                if (!(error instanceof OverviewInputError)) throw error;
                setIssue(error.message);
              }
            }}
          >
            <section className="ac-filter-section" data-tone="blue">
              <header>
                <Icon name="work" />
                <div>
                  <h3>Follow a ticket</h3>
                  <p>
                    See its recorded changes in one place. Leave this empty to use the current
                    project or workspace.
                  </p>
                </div>
              </header>
              <ReferencePicker
                context={context}
                endpoint={endpoint}
                kind="ticket"
                label="Ticket (optional)"
                value={editor.ticketId}
                onChange={(ticketId) => setEditor({ ...editor, ticketId })}
              />
            </section>
            <section className="ac-filter-section" data-tone="purple">
              <header>
                <Icon name="participants" />
                <div>
                  <h3>Focus on a contributor</h3>
                  <p>
                    An actor is the person or agent who made a change, not necessarily the ticket’s
                    assignee. Choose a registered actor or enter an ID from an older record.
                  </p>
                </div>
              </header>
              <RecipientPicker
                context={context}
                endpoint={endpoint}
                label="Actor (optional)"
                value={editor.actorId}
                onChange={(actorId) => setEditor({ ...editor, actorId })}
              />
              {editor.actorId && (
                <Button tone="quiet" onClick={() => setEditor({ ...editor, actorId: "" })}>
                  Include all actors
                </Button>
              )}
            </section>
            <p className="ac-form-hint">
              Both filters apply together. These choices only change what you see; they do not
              change your acting identity or any saved work.
            </p>
            {issue && <p role="alert">{issue}</p>}
            <div className="ac-form-actions">
              <Button tone="quiet" onClick={() => setEditor({ ticketId: "", actorId: "" })}>
                Reset fields
              </Button>
              <Button onClick={() => setFiltersOpen(false)}>Cancel</Button>
              <Button tone="primary" type="submit">
                Apply filters
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}

/** Explicitly opened immutable records stay mounted when they leave the latest
 * window. Ownership is this exact filter/capture; a deliberate navigation resets
 * it. Retain the first opened page too, so removing rows below the reader cannot
 * clamp the scroll offset. Closing all details releases that page. */
function ActivityTimeline({
  events,
  scope,
}: {
  readonly events: readonly AuditEvent[];
  readonly scope: ReturnType<typeof captureScope>;
}) {
  const [reading, setReading] = useState<{
    readonly opened: ReadonlyMap<string, AuditEvent>;
    readonly window: readonly AuditEvent[];
  }>({ opened: new Map(), window: [] });
  const { opened } = reading;
  const merged = new Map(events.map((event) => [event.revision, event]));
  for (const event of reading.window) merged.set(event.revision, event);
  for (const event of opened.values()) merged.set(event.revision, event);
  const rows = [...merged.values()].sort((a, b) =>
    BigInt(a.revision) < BigInt(b.revision) ? 1 : BigInt(a.revision) > BigInt(b.revision) ? -1 : 0,
  );
  const retained = rows.length - events.length;
  return (
    <>
      <ActivityScrollAnchor>
        {rows.map((event, i) => {
          const date = auditDate(event.timestamp),
            previous = rows[i - 1];
          const day =
            date?.toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
              year: "numeric",
            }) ?? "Date unavailable";
          const previousDate = previous === undefined ? null : auditDate(previous.timestamp);
          const grouped = i === 0 || date?.toDateString() !== previousDate?.toDateString();
          return (
            <div key={event.revision}>
              {grouped && <h3 className="ac-day-heading">{day}</h3>}
              <AuditRow
                event={event}
                scope={scope}
                onOpenChange={(open) =>
                  setReading((previous) => {
                    const next = new Map(previous.opened);
                    if (open) next.set(event.revision, event);
                    else next.delete(event.revision);
                    return {
                      opened: next,
                      window:
                        next.size === 0
                          ? []
                          : previous.opened.size === 0
                            ? events
                            : previous.window,
                    };
                  })
                }
              />
            </div>
          );
        })}
      </ActivityScrollAnchor>

      {retained > 0 && (
        <p className="ac-retained-notice">
          {retained} older {retained === 1 ? "record stays" : "records stay"} visible to preserve
          your reading position while details are open. The latest activity continues above; use
          Earlier activity to browse intervening records.
        </p>
      )}
    </>
  );
}
