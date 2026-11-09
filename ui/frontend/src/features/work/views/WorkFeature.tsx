import { WorkFiltersForm } from "./WorkFilters";
import { STATUS_LABEL, PRIORITY_LABEL } from "./labels";
import { ActorAvatar } from "../../../components/ActorAvatar";
import { Icon } from "../../../components/Icon";
import { Dialog } from "../../../components/Dialog";
import { changeView, routeHref } from "../../../app/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button, Badge, StatePanel, Toolbar } from "../../../components/Primitives";
import { Inspector, SplitView } from "../../../components/ResizablePane";
import * as d from "../../../core/protocol/decoders";
import type { Identifier } from "../../../core/protocol/types";
import { workCapturePredatesWrite } from "../freshness";
import { current, workScopeKey } from "../read-model";
import type {
  Ticket,
  TicketStatus,
  WorkActionContext,
  WorkActionIntent,
  WorkFeatureProps,
  WorkScope,
  WorkState,
} from "../read-model.types";
import { TICKET_STATUSES } from "../read-model.types";
import { ReadStatus } from "./ReadPresentation";
import { TicketInspector } from "./TicketInspector";
import "./work.css";
import "./work-polish.css";
import "./work-continuity.css";
import "./ticket-refinement.css";
import "../../../components/section-navigation.css";

function TicketStateIcon({ status }: { readonly status: string }) {
  const glyph =
    status === "done"
      ? "✓"
      : status === "in_progress"
        ? "◐"
        : status === "canceled"
          ? "⊗"
          : status === "backlog"
            ? "◌"
            : status === "Graph ready"
              ? "◉"
              : status === "Blocked"
                ? "⊖"
                : "○";
  return (
    <span
      className={`work-state-icon work-state-icon--${status.replaceAll(" ", "-")}`}
      aria-hidden="true"
    >
      {glyph}
    </span>
  );
}
function id(value: string | null): Identifier | null {
  const result = d.identifier.decode(value === null ? undefined : d.jsonString(value));
  return result.ok ? result.value : null;
}
function rowGroup(ticket: Ticket, state: WorkState): string {
  switch (state.grouping) {
    case "status":
      return ticket.status;
    case "assignee":
      return ticket.assignee_id ?? "Unassigned";
    case "priority":
      return PRIORITY_LABEL[ticket.priority] ?? ticket.priority;
    case "readiness": {
      const result = current(state.assessed[ticket.ticket_id] ?? { kind: "idle" });
      return result === undefined ? "Not assessed" : result.value.ready ? "Graph ready" : "Blocked";
    }
  }
}
function groupLabel(group: string, state: WorkState) {
  return state.grouping === "status"
    ? TICKET_STATUSES.includes(group as TicketStatus)
      ? STATUS_LABEL[group as TicketStatus]
      : group
    : group;
}
function ReadinessBadge({ ticket, state }: { readonly ticket: Ticket; readonly state: WorkState }) {
  const checked = state.assessed[ticket.ticket_id];
  const result = checked ? current(checked) : undefined;
  if (checked?.kind === "unexpected_error") throw checked.error;
  return (
    <Badge tone={result?.value.ready ? "accent" : result ? "warning" : "neutral"}>
      {checked?.kind === "loading"
        ? "Assessing…"
        : checked?.kind === "failed"
          ? "Assessment unavailable"
          : result
            ? result.value.ready
              ? "Graph ready"
              : "Blocked"
            : "Not assessed"}
    </Badge>
  );
}
export function WorkFeature(props: WorkFeatureProps) {
  const { context, controller } = props,
    state = useSyncExternalStore(controller.subscribe, controller.get);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const collectionScroll = useRef<HTMLDivElement>(null);
  const [visibleGroups, setVisibleGroups] = useState<Readonly<Record<string, number>>>({});
  const listIdentity = `${state.scope ? workScopeKey(state.scope) : ""}:${JSON.stringify(state.filters)}:${state.grouping}`;
  useEffect(() => {
    if (collectionScroll.current !== null) collectionScroll.current.scrollTop = 0;
  }, [listIdentity]);
  const [unexpected, setUnexpected] = useState<{
      readonly key: string;
      readonly error: unknown;
    } | null>(null),
    [intent, setIntent] = useState<{
      readonly ticketId: Identifier;
      readonly value: WorkActionIntent;
    } | null>(null);
  const workspace = id(context.route.workspaceId),
    project = id(context.route.projectId),
    entity = id(context.route.entityId);
  const scope: WorkScope | null =
    workspace === null
      ? null
      : { connection: context.connection, workspaceId: workspace, projectId: project };
  const key = scope === null ? "no-workspace" : workScopeKey(scope);
  const launch = (task: Promise<void>) => {
    void task.catch((error: unknown) => {
      setUnexpected({ key, error });
    });
  };
  useEffect(() => {
    if (scope !== null && context.profileState === "current")
      void controller.open(scope, entity).catch((error: unknown) => {
        setUnexpected({ key, error });
      });
    // The tuple key captures the endpoint generation and route scope; open preserves an identical in-flight read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, key, entity, context.profileState]);
  const layout = context.route.section?.view === "work" ? context.route.section.value : "list";
  useEffect(() => {
    controller.setPresentation({ layout });
  }, [controller, layout]);
  if (unexpected?.key === key) throw unexpected.error;
  if (scope === null)
    return (
      <StatePanel kind="empty" title="Choose a workspace">
        <p>Select a real workspace to browse its tickets.</p>
      </StatePanel>
    );
  const matching = state.scope !== null && workScopeKey(state.scope) === key;
  const list = matching ? current(state.list) : undefined,
    selected = matching && state.selectedId === entity ? current(state.ticket) : undefined,
    detail = matching && state.selectedId === entity ? current(state.context) : undefined;
  const disabled = context.profileState !== "current";
  function navigate(ticketId: Identifier | null) {
    context.navigate({
      ...context.route,
      view: context.route.view === "workflow" ? "workflow" : "work",
      entityId: ticketId,
    });
  }
  function offer(ticketId: Identifier, value: WorkActionIntent) {
    setIntent({ ticketId, value });
    navigate(ticketId);
  }
  const actions: WorkActionContext | null =
    selected && state.selectedId === selected.value.ticket.ticket_id
      ? {
          context,
          scope,
          ticket: selected,
          detail: detail ?? null,
          intent: intent?.ticketId === state.selectedId ? intent.value : null,
          clearIntent: () => setIntent(null),
        }
      : null;
  const groups = new Map<string, Ticket[]>();
  if (state.grouping === "status") for (const status of TICKET_STATUSES) groups.set(status, []);
  if (state.grouping === "readiness")
    for (const name of ["Graph ready", "Blocked", "Not assessed"]) groups.set(name, []);
  for (const ticket of list?.value.items ?? []) {
    const group = rowGroup(ticket, state);
    const rows = groups.get(group) ?? [];
    rows.push(ticket);
    groups.set(group, rows);
  }
  function dropped(ticketId: string, group: string) {
    const ticket = list?.value.items.find((t) => t.ticket_id === ticketId);
    if (!ticket || disabled) return;
    const status = TICKET_STATUSES.find((s) => s === group);
    if (state.grouping === "status" && status) offer(ticket.ticket_id, { kind: "status", status });
    if (state.grouping === "readiness" && (group === "Graph ready" || group === "Blocked"))
      offer(ticket.ticket_id, {
        kind: "readiness",
        target: group === "Graph ready" ? "ready" : "blocked",
      });
  }
  return (
    <section className="work-feature" aria-label="Ticket workbench">
      {matching && workCapturePredatesWrite(state) && (
        <section role="status" aria-label="Captured work freshness">
          <p>
            This captured view predates your saved action ({state.ownWrite?.method}). Its counts,
            readiness and ownership describe the earlier capture.
          </p>
          <Button
            disabled={disabled || state.list.kind === "loading"}
            onClick={() => launch(controller.refresh())}
          >
            Refresh affected records
          </Button>
        </section>
      )}
      {props.renderCollection === undefined && (
        <>
          <header className="work-top-toolbar wg-section-navigation">
            <h1>
              <Icon name="board" />
              Work
              {list && (
                <span className="work-total" title="Tickets matching the current filters">
                  {(
                    BigInt(list.value.offset) +
                    BigInt(list.value.items.length) +
                    BigInt(list.value.remaining)
                  ).toString()}
                </span>
              )}
            </h1>
            <Toolbar label="Ticket presentation">
              {(["board", "list"] as const).map((layout) => (
                <Button
                  key={layout}
                  tone="quiet"
                  aria-pressed={state.layout === layout}
                  onClick={() =>
                    context.navigate({ ...context.route, section: { view: "work", value: layout } })
                  }
                >
                  <Icon name={layout} />
                  {layout === "board" ? "Board" : "List"}
                </Button>
              ))}
            </Toolbar>
            <div className="work-toolbar-end">
              <a
                className="work-toolbar-link"
                href={routeHref(changeView(context.route, "workflow"))}
              >
                <Icon name="workflow" />
                Graph
              </a>
              <Button tone="quiet" onClick={() => setFiltersOpen(true)}>
                <Icon name="filter" />
                Filter
              </Button>
              <Button
                tone="quiet"
                className="wg-icon-button"
                aria-label="Refresh tickets"
                disabled={disabled}
                onClick={() => launch(controller.refresh())}
              >
                <Icon name="refresh" />
              </Button>
              {props.toolbarActions}
            </div>
          </header>
          <div className="work-filterbar">
            <span className="work-scope-chip">
              <Icon name="facts" />
              {scope.projectId ?? "All projects"}
            </span>
            {state.filters.text !== "" && (
              <span className="work-filter-chip">Search: {state.filters.text}</span>
            )}
            {state.filters.status !== "" && (
              <span className="work-filter-chip">{STATUS_LABEL[state.filters.status]}</span>
            )}
            {(
              [
                [
                  "Priority",
                  state.filters.priority === ""
                    ? ""
                    : (PRIORITY_LABEL[state.filters.priority] ?? state.filters.priority),
                ],
                ["Assignee", state.filters.assigneeId],
                ["Label", state.filters.labelId],
                ["Milestone", state.filters.milestoneId],
              ] as const
            ).map(
              ([label, value]) =>
                value !== "" && (
                  <span className="work-filter-chip" key={label}>
                    {label}: {value}
                  </span>
                ),
            )}
            {state.filters.includeArchived && (
              <span className="work-filter-chip">Includes archived</span>
            )}
            {context.writer.actorId === null && (
              <span className="work-readonly-hint">Select an actor to edit</span>
            )}
            <label className="work-group-control">
              Group by{" "}
              <select
                aria-label="Group tickets"
                value={state.grouping}
                onChange={(event) => {
                  const value = (["status", "assignee", "priority", "readiness"] as const).find(
                    (v) => v === event.currentTarget.value,
                  );
                  if (value) controller.setPresentation({ grouping: value });
                }}
              >
                {(["status", "assignee", "priority", "readiness"] as const).map((value) => (
                  <option key={value} value={value}>
                    {value === "readiness"
                      ? "Graph readiness"
                      : value[0]?.toUpperCase() + value.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            {state.grouping === "readiness" && (
              <Button
                tone="quiet"
                disabled={disabled || state.assessing || !list}
                onClick={() => launch(controller.assessLoaded())}
              >
                {state.assessing ? "Checking…" : "Check readiness"}
              </Button>
            )}
          </div>
          {disabled && (
            <p role="status" className="work-read-error">
              Connection {context.profileState}. Previously loaded tickets remain visible.
            </p>
          )}
          {filtersOpen && (
            <Dialog
              title="Filter tickets"
              description="Narrow this project’s tickets by status, owner, priority or text."
              onClose={() => setFiltersOpen(false)}
              wide
            >
              <WorkFiltersForm
                scope={scope}
                context={context}
                key={key}
                initial={state.filters}
                disabled={disabled}
                apply={(filters) => {
                  launch(controller.setFilters(filters));
                  setFiltersOpen(false);
                }}
              />
            </Dialog>
          )}
        </>
      )}
      <SplitView
        inspector={
          entity !== null && matching ? (
            <Inspector
              initialWidth={780}
              maximumWidth={1080}
              key={entity}
              title={selected?.value.ticket.display_key ?? "Loading ticket"}
              subtitle={selected ? (selected.value.ticket.project_id ?? "No project") : entity}
              onClose={() => navigate(null)}
            >
              <ReadStatus state={state.ticket} label="Ticket instructions" />
              {selected && (
                <TicketInspector
                  {...props}
                  state={state}
                  ticket={selected}
                  detail={detail ?? null}
                  actions={actions}
                  navigate={navigate}
                  launch={launch}
                  offer={offer}
                />
              )}
            </Inspector>
          ) : undefined
        }
      >
        {props.renderCollection ? (
          props.renderCollection({
            ...(props.toolbarActions === undefined ? {} : { toolbarActions: props.toolbarActions }),
            context,
            scope,
            state: matching ? state : null,
            list: list ?? null,
            selected: selected ?? null,
            actions,
            disabled,
            controller,
            select: navigate,
            offer,
          })
        ) : (
          <div className="work-main" ref={collectionScroll}>
            {matching && <ReadStatus state={state.list} label="Ticket query" />}
            {!matching || state.list.kind === "idle" ? (
              <StatePanel kind="loading" title="Loading ticket query">
                <p>Reading the selected endpoint and workspace.</p>
              </StatePanel>
            ) : (
              list && (
                <>
                  <div className="work-list-summary">
                    <span>
                      {list.value.items.length} matching tickets
                      {list.value.remaining !== "0" ? ` · ${list.value.remaining} not loaded` : ""}
                    </span>
                  </div>
                  {list.value.items.length === 0 ? (
                    <StatePanel kind="empty" title="No tickets match this query">
                      <p>Try another search or clear filters to see more work.</p>
                    </StatePanel>
                  ) : (
                    <div className={state.layout === "board" ? "work-board" : "work-list"}>
                      {[...groups]
                        .filter(([, rows]) => state.layout === "board" || rows.length > 0)
                        .map(([group, rows]) => (
                          <section
                            key={group}
                            className="work-group"
                            aria-label={`${groupLabel(group, state)} tickets`}
                            onDragOver={(event) => {
                              if (state.grouping === "status" || state.grouping === "readiness")
                                event.preventDefault();
                            }}
                            onDrop={(event) => {
                              event.preventDefault();
                              dropped(
                                event.dataTransfer.getData("application/x-workgraph-ticket"),
                                group,
                              );
                            }}
                          >
                            <header className="work-group-heading">
                              <span>
                                <TicketStateIcon status={group} />
                                {groupLabel(group, state)}
                              </span>
                              <span title="Matching tickets in this section">{rows.length}</span>
                            </header>
                            {rows.length === 0 ? (
                              <p className="work-group-empty">No matching tickets</p>
                            ) : (
                              rows
                                .slice(
                                  0,
                                  state.layout === "board"
                                    ? rows.length
                                    : (visibleGroups[`${listIdentity}:${group}`] ?? 20),
                                )
                                .map((ticket) => (
                                  <button
                                    key={ticket.ticket_id}
                                    type="button"
                                    className={`work-ticket ${state.selectedId === ticket.ticket_id ? "is-selected" : ""}`}
                                    aria-label={`Open ${ticket.display_key}: ${ticket.title}`}
                                    aria-current={
                                      state.selectedId === ticket.ticket_id ? "true" : undefined
                                    }
                                    draggable={
                                      !disabled &&
                                      (state.grouping === "status" ||
                                        state.grouping === "readiness")
                                    }
                                    onDragStart={(event) =>
                                      event.dataTransfer.setData(
                                        "application/x-workgraph-ticket",
                                        ticket.ticket_id,
                                      )
                                    }
                                    onClick={() => navigate(ticket.ticket_id)}
                                  >
                                    <span className="work-card-top">
                                      <span className="work-ticket-key">{ticket.display_key}</span>
                                      <span className="work-ticket-area">
                                        {ticket.milestone_id ?? ticket.project_id ?? ""}
                                      </span>
                                      <ActorAvatar
                                        actor={ticket.claim?.actor_id ?? ticket.assignee_id}
                                      />
                                    </span>
                                    <span className="work-ticket-title">{ticket.title}</span>
                                    <span className="work-ticket-meta">
                                      <span className={`work-status work-status--${ticket.status}`}>
                                        <TicketStateIcon status={ticket.status} />
                                        {STATUS_LABEL[ticket.status]}
                                      </span>
                                      <span className="work-priority" title="Priority">
                                        {PRIORITY_LABEL[ticket.priority] ?? ticket.priority}
                                      </span>
                                      {ticket.hold && <Badge tone="warning">On hold</Badge>}
                                      {ticket.archived && <Badge>Archived</Badge>}
                                      {ticket.label_ids.slice(0, 1).map((label) => (
                                        <span className="work-label" key={label}>
                                          {label}
                                        </span>
                                      ))}
                                      {state.grouping === "readiness" && (
                                        <ReadinessBadge ticket={ticket} state={state} />
                                      )}
                                      <span
                                        className="work-ticket-ownership"
                                        title={
                                          ticket.claim
                                            ? `Claim owner ${ticket.claim.actor_id}`
                                            : ticket.assignee_id
                                              ? `Assigned to ${ticket.assignee_id}`
                                              : "No assigned actor"
                                        }
                                      >
                                        {ticket.claim
                                          ? "Claimed"
                                          : (ticket.assignee_id ?? "Unassigned")}
                                      </span>
                                    </span>
                                  </button>
                                ))
                            )}
                            {state.layout === "list" &&
                              rows.length > (visibleGroups[`${listIdentity}:${group}`] ?? 20) && (
                                <Button
                                  className="work-load-more"
                                  onClick={() =>
                                    setVisibleGroups((old) => ({
                                      ...old,
                                      [`${listIdentity}:${group}`]:
                                        (old[`${listIdentity}:${group}`] ?? 20) + 20,
                                    }))
                                  }
                                >
                                  Load more {groupLabel(group, state).toLowerCase()} ·{" "}
                                  {rows.length - (visibleGroups[`${listIdentity}:${group}`] ?? 20)}{" "}
                                  remaining
                                </Button>
                              )}
                          </section>
                        ))}
                    </div>
                  )}
                  {list.value.remaining !== "0" && (
                    <p role="status" className="work-read-error">
                      Some tickets could not fit in the response. Narrow the filters or refresh to
                      try again.
                    </p>
                  )}
                  <p className="work-footnote">
                    Drag a ticket to propose a status change. You review it before anything is
                    saved.
                  </p>
                </>
              )
            )}
          </div>
        )}
      </SplitView>
    </section>
  );
}
