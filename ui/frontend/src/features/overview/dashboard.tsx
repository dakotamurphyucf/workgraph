import { ActivityEntry } from "../activity/ActivityEntry";
import "../activity/activity.css";
import { attentionAppearance } from "./attention-appearance";
import { canonicalJson, jsonField } from "../../core/json";
import { ActorAvatar } from "../../components/ActorAvatar";
import { ProjectProgressPanel } from "./project-progress";
import { useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "../../components/Icon";
import type { FeatureContext } from "../../app/types";
import { changeView, routeHref } from "../../app/navigation";
import { current } from "./controller";
import { field } from "./codecs";
import { coordinationPresentation } from "./dashboard-model";
import { ticketRoute, sourceRoute } from "./model";
import { Link, Provenance, Read, Sources } from "./presentation";
import type {
  CoordinationRow,
  ExcerptPage,
  OverviewController,
  OverviewMetric,
  OverviewScope,
  OverviewState,
  OverviewTone,
  TicketSummary,
} from "./types";
import "./prototype-overview.css";

const tones: Record<OverviewTone, { color: string; symbol: string }> = {
  ready: { color: "green", symbol: "◉" },
  working: { color: "yellow", symbol: "◐" },
  blocked: { color: "orange", symbol: "⊖" },
  claimed: { color: "purple", symbol: "Ⅱ" },
  question: { color: "pink", symbol: "ⓘ" },
  done: { color: "blue", symbol: "✓" },
};
export function StateIcon({ tone }: { readonly tone: OverviewTone }) {
  return (
    <span className={`status ${tones[tone].color}`} aria-hidden="true">
      {tones[tone].symbol}
    </span>
  );
}
function Metric({ metric }: { readonly metric: OverviewMetric }) {
  return (
    <div className="metric" data-tone={metric.kind} title={metric.meaning}>
      <div className="metriclabel">
        <StateIcon tone={metric.kind} />
        {metric.label}
      </div>
      <div className="metricvalue">
        {metric.value}
        {metric.denominator !== null && <small>/ {metric.denominator}</small>}
      </div>
    </div>
  );
}
function Section({
  title,
  icon,
  action,
  children,
}: {
  readonly title: string;
  readonly icon?: ReactNode;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="module">
      <div className="modulehead">
        <h3>
          {icon}
          {title}
        </h3>
        {action}
      </div>
      <div className="modulebody">{children}</div>
    </section>
  );
}
export function CoordinationCards({
  rows,
  scope,
  empty,
  ticketTitles,
  ready = false,
}: {
  readonly rows: readonly CoordinationRow[];
  readonly scope: OverviewScope;
  readonly empty: string;
  readonly ticketTitles?: ReadonlyMap<string, string>;
  readonly ready?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="panel">
      {rows.length === 0 ? (
        <p className="empty-row">{empty}</p>
      ) : (
        (expanded
          ? rows
          : [...rows]
              .sort(
                (a, b) =>
                  attentionAppearance[a.kind].priority - attentionAppearance[b.kind].priority,
              )
              .slice(0, 3)
        ).map((row) => {
          const display = coordinationPresentation(row),
            id = field(row.source, "ticket_id"),
            title = row.detail?.title ?? (id === null ? undefined : ticketTitles?.get(id)),
            visual = attentionAppearance[row.kind],
            sourceKey = canonicalJson(row.source),
            destination = sourceRoute(scope, row.source);
          if (!sourceKey.ok) throw new Error("Validated coordination source cannot be encoded");
          return (
            <div
              className={ready ? "readyrow" : "attentionrow"}
              key={`${row.kind}:${sourceKey.value}`}
            >
              <span className={`leading ${tones[display.tone].color}`}>
                <Icon name={visual.icon} />
              </span>
              <div className="grow">
                <div className="rowtitle" title={title ?? display.label}>
                  {destination === null ? (
                    (title ?? display.label)
                  ) : (
                    <Link route={destination}>{title ?? display.label}</Link>
                  )}
                </div>
                <div className="rowmeta">
                  <span className={tones[display.tone].color}>{visual.label}</span>
                  {row.detail?.byline ? (
                    <span
                      title={
                        row.detail.capture === "current_request"
                          ? "Current request details"
                          : undefined
                      }
                    >
                      {row.detail.byline}
                    </span>
                  ) : id !== null ? (
                    <span className="mono">{id}</span>
                  ) : null}
                  {ready && (
                    <span>{scope.runId === null ? "Graph ready" : "Eligible for this run"}</span>
                  )}
                  {!ready && (
                    <details className="attention-details">
                      <summary>Details</summary>
                      <p>{display.detail}</p>
                      <Sources scope={scope} sources={[row.source]} />
                    </details>
                  )}
                </div>
              </div>
              {row.detail?.actorId && <ActorAvatar actor={row.detail.actorId} />}
            </div>
          );
        })
      )}
      {rows.length > 3 && (
        <button className="section-more" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show fewer" : `View all ${rows.length} loaded items`} →
        </button>
      )}
    </div>
  );
}
function WorkingTickets({
  page,
  scope,
  claimed,
  updates,
}: {
  readonly updates: ReadonlyMap<string, string>;
  readonly page: ExcerptPage<TicketSummary>;
  readonly scope: OverviewScope;
  readonly claimed: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="panel">
      {page.items.length === 0 ? (
        <p className="empty-row">
          {claimed ? "No claimed work in this selection." : "No tickets in progress."}
        </p>
      ) : (
        (expanded ? page.items : page.items.slice(0, 3)).map((ticket) => {
          const owner = ticket.actorId;
          return (
            <div className="progressrow" key={ticket.ticketId}>
              <div className="flex">
                <ActorAvatar actor={owner ?? null} unavailable={owner === undefined} />
                <div className="grow">
                  <div className="rowtitle">
                    <Link route={ticketRoute(scope, ticket.ticketId)}>{ticket.title}</Link>
                  </div>
                  <div className="rowdetail">
                    <span className="mono">
                      {field(ticket.raw, "display_key") ?? ticket.ticketId}
                    </span>{" "}
                    · {owner ?? (owner === undefined ? "Assignment not loaded" : "Unassigned")}
                    {ticket.runId && <> · {ticket.runId}</>}
                  </div>
                </div>
              </div>
              {updates.has(ticket.ticketId) && (
                <p
                  className="updatequote"
                  title="Latest progress update in the loaded activity window"
                >
                  {updates.get(ticket.ticketId)}
                </p>
              )}
            </div>
          );
        })
      )}
      {page.items.length > 3 && (
        <button className="section-more" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show fewer" : `View all ${page.items.length} loaded tickets`} →
        </button>
      )}
      {page.remaining !== "0" && (
        <div className="empty-row">{page.remaining} more tickets in this selection.</div>
      )}
    </div>
  );
}
export function OverviewDashboard({
  state,
  scope,
  context,
  controller,
  run,
  onManage,
  onNotifications,
}: {
  readonly state: OverviewState;
  readonly scope: OverviewScope;
  readonly context: FeatureContext;
  readonly controller: OverviewController;
  readonly run: (task: Promise<void>) => void;
  readonly onManage: () => void;
  readonly onNotifications: () => void;
}) {
  const summary = current(state.summary),
    questions = current(state.questions),
    coordination = current(state.coordination),
    [descriptionOpen, setDescriptionOpen] = useState(false);
  const updates = new Map<string, string>();
  for (const entry of [
    ...(current(state.digest)?.value.entries ?? []),
    ...state.liveActivity.flatMap((frame) => frame.value.entries),
  ]) {
    const record = entry.item.record,
      target = jsonField(record, "target");
    const body = field(record, "body");
    if (
      entry.item.kind === "comment" &&
      field(record, "kind") === "progress" &&
      target?.kind === "object" &&
      field(target, "kind") === "ticket"
    ) {
      const id = field(target, "id");
      const tombstone = jsonField(record, "tombstone");
      if (id !== null) {
        if (tombstone?.kind === "boolean" && tombstone.value) updates.delete(id);
        else if (body !== null) updates.set(id, body);
      }
    }
  }
  const questionCount =
    questions === undefined
      ? null
      : (BigInt(questions.value.items.length) + BigInt(questions.value.omitted)).toString();
  const title = summary?.value.title ?? scope.projectId ?? scope.workspaceId;
  const description = summary?.value.description ?? "";
  const titles = (revision: string) =>
    new Map(
      summary === undefined || summary.revision !== revision
        ? []
        : [
            ...(summary.value.ready?.items ?? []),
            ...summary.value.working.items,
            ...summary.value.blocked.items,
          ].map((t) => [t.ticketId, t.title] as const),
    );
  const route = (view: FeatureContext["route"]["view"]) =>
    routeHref(changeView(context.route, view));
  const attention =
    coordination?.value.items.filter(
      (row) =>
        !["ready_work", "active_attempt", "reservation", "reported_usage"].includes(row.kind),
    ) ?? [];
  return (
    <div className="wg-prototype-overview">
      <header className="pagehead">
        <div className="between">
          <div className="flex">
            <span className="projecticon">
              <Icon name="facts" />
            </span>
            <h1>{title}</h1>
          </div>
          <div className="flex overview-actions">
            <button className="btn" onClick={onManage}>
              {scope.projectId === null ? "Manage workspace" : "Manage project"}
            </button>
            <button
              className="btn btn-icon"
              aria-label="Notification settings"
              title="Notification settings"
              onClick={onNotifications}
            >
              <Icon name="settings" />
            </button>
          </div>
        </div>
        {description !== "" && (
          <>
            <p className="subtitle subtitle-line" title={description}>
              {description}
            </p>
            {description.length > 180 && (
              <details
                className="prototype-description"
                open={descriptionOpen}
                onToggle={(e) => setDescriptionOpen(e.currentTarget.open)}
              >
                <summary>Project description</summary>
                <p>{description}</p>
              </details>
            )}
          </>
        )}
      </header>
      <div className="between">
        <p className="secondary">
          {questionCount === null ? (
            "Work, questions and project progress"
          ) : (
            <>
              <span className="pink">
                {questionCount} {questionCount === "1" ? "question" : "questions"}
              </span>{" "}
              need attention
              {summary !== undefined && (
                <>
                  {" "}
                  · {summary.value.metrics.find((m) => m.kind === "working")?.value ?? "—"} tickets
                  in progress ·{" "}
                  {summary.value.metrics.find((m) => m.kind === "ready")?.value ?? "—"} ready to
                  pick up
                </>
              )}
            </>
          )}
        </p>
        <button
          className="link"
          onClick={() => run(controller.refresh())}
          disabled={state.refreshing}
        >
          <Icon name="refresh" />
          {state.refreshing ? "Updating…" : "Refresh"}
        </button>
      </div>
      <Read quiet state={state.summary} label="Project totals">
        {(observed) => (
          <div
            className="metrics"
            style={{ "--metric-count": observed.value.metrics.length + 1 } as CSSProperties}
          >
            {observed.value.metrics
              .filter((m) => m.kind !== "done")
              .map((m) => (
                <Metric metric={m} key={m.kind} />
              ))}
            <div
              className="metric"
              data-tone="question"
              title="Unanswered questions; independently observed from ticket totals."
            >
              <div className="metriclabel">
                <StateIcon tone="question" />
                Questions
              </div>
              <div
                className="metricvalue"
                aria-label={questionCount === null ? "Question count unavailable" : undefined}
              >
                {questionCount ?? "—"}
              </div>
            </div>
            {observed.value.metrics
              .filter((m) => m.kind === "done")
              .map((m) => (
                <Metric metric={m} key={m.kind} />
              ))}
          </div>
        )}
      </Read>
      {state.questions.kind === "failed" && (
        <p className="overview-count-notice" role="alert">
          Question count could not refresh.{" "}
          {questionCount === null
            ? "No count is available yet."
            : "Showing the last available count."}{" "}
          Use Refresh to retry.
        </p>
      )}
      <div className="overviewgrid">
        <div>
          <Section
            title="Needs attention"
            icon={<Icon name="discussions" />}
            action={
              <a className="link" href={route("discussions")}>
                View discussions →
              </a>
            }
          >
            <Read quiet state={state.coordination} label="Attention">
              {(observed) => (
                <>
                  <CoordinationCards
                    rows={attention}
                    scope={scope}
                    empty="Nothing needs attention in this selection."
                    ticketTitles={titles(observed.revision)}
                  />
                  {observed.value.cursor !== null && (
                    <button
                      className="section-more"
                      disabled={observed.value.needsLargerBudget}
                      onClick={() => run(controller.nextCoordination())}
                    >
                      More attention items →
                    </button>
                  )}
                  {observed.value.omitted !== "0" && (
                    <p className="rowdetail">
                      {observed.value.omitted} more items beyond this page.
                    </p>
                  )}
                  {observed.value.needsLargerBudget && (
                    <p role="alert">
                      An item exceeds the current read limit. Narrow the selection or refresh.
                    </p>
                  )}
                </>
              )}
            </Read>
          </Section>
          <Section
            title={summary?.value.kind === "workspace" ? "Claimed work" : "In flight"}
            icon={<Icon name="activity" />}
            action={
              <a className="link" href={route("participants")}>
                View participants →
              </a>
            }
          >
            <Read quiet state={state.summary} label="Work in progress">
              {(observed) => (
                <WorkingTickets
                  page={observed.value.working}
                  updates={updates}
                  scope={scope}
                  claimed={observed.value.kind === "workspace"}
                />
              )}
            </Read>
          </Section>
          <Section
            title="Recent activity"
            action={
              <a className="link" href={route("activity")}>
                All activity →
              </a>
            }
          >
            <Read quiet state={state.digest} label="Activity">
              {(observed) => (
                <>
                  {[
                    ...new Map(
                      [
                        ...observed.value.entries,
                        ...state.liveActivity.flatMap((frame) => frame.value.entries),
                      ].map((entry) => [`${entry.revision}:${entry.changeIndex}`, entry]),
                    ).values(),
                  ]
                    .sort((a, b) =>
                      BigInt(a.revision) > BigInt(b.revision)
                        ? -1
                        : BigInt(a.revision) < BigInt(b.revision)
                          ? 1
                          : BigInt(a.changeIndex) > BigInt(b.changeIndex)
                            ? -1
                            : BigInt(a.changeIndex) < BigInt(b.changeIndex)
                              ? 1
                              : 0,
                    )
                    .slice(0, 4)
                    .map((entry) => (
                      <ActivityEntry
                        key={`${entry.revision}:${entry.changeIndex}`}
                        entry={entry}
                        scope={scope}
                      />
                    ))}
                  {observed.value.entries.length === 0 && state.liveActivity.length === 0 && (
                    <p className="empty-row">No activity in this window.</p>
                  )}
                  {observed.value.hasMore && (
                    <a className="link" href={route("activity")}>
                      Loaded window is partial · Open activity →
                    </a>
                  )}
                </>
              )}
            </Read>
          </Section>
        </div>
        <div>
          <Section
            title="Ready to pick up"
            icon={<Icon name="work" />}
            action={
              <a className="link" href={route("work")}>
                Open board →
              </a>
            }
          >
            <Read quiet state={state.readiness} label="Ready work">
              {(observed) => (
                <>
                  <CoordinationCards
                    rows={observed.value.items}
                    scope={scope}
                    empty="No ready work in this selection."
                    ticketTitles={titles(observed.revision)}
                    ready
                  />
                  {observed.value.hasMore && (
                    <button
                      className="section-more"
                      disabled={observed.value.needsLargerBudget}
                      onClick={() => run(controller.nextReadiness())}
                    >
                      More ready work →
                    </button>
                  )}
                  {observed.value.needsLargerBudget && (
                    <p role="alert">
                      An item exceeds the current read limit. Narrow the selection or refresh.
                    </p>
                  )}
                </>
              )}
            </Read>
          </Section>
          <Section
            title={scope.projectId === null ? "Projects" : "Project progress"}
            action={
              <a className="link" href={route("workflow")}>
                View workflow →
              </a>
            }
          >
            <Read quiet state={state.summary} label="Project progress">
              {(observed) => (
                <div className="panel">
                  {observed.value.progress !== null ? (
                    <ProjectProgressPanel summary={observed.value} />
                  ) : (
                    <>
                      {observed.value.projects?.items.map((project) =>
                        project.overview !== undefined ? (
                          <ProjectProgressPanel
                            key={project.projectId}
                            summary={project.overview}
                            href={routeHref({
                              ...context.route,
                              projectId: project.projectId,
                              entityId: null,
                            })}
                          />
                        ) : (
                          <div className="projectrow" key={project.projectId}>
                            <a
                              className="flex rowtitle"
                              href={routeHref({
                                ...context.route,
                                projectId: project.projectId,
                                entityId: null,
                              })}
                            >
                              {project.title}
                            </a>
                            <p className="rowdetail">
                              Progress unavailable for this capture. Refresh to retry.
                            </p>
                          </div>
                        ),
                      )}
                      {observed.value.projects?.items.length === 0 && (
                        <p className="empty-row">No active projects.</p>
                      )}
                      {observed.value.projects !== null &&
                        observed.value.projects.remaining !== "0" && (
                          <p className="empty-row">
                            {observed.value.projects.remaining} more projects.
                          </p>
                        )}
                    </>
                  )}
                </div>
              )}
            </Read>
          </Section>
        </div>
      </div>
      <details className="prototype-details">
        <summary>Data and capture details</summary>
        <div>
          <p>
            Totals and current eligibility are separate observations. Ready describes graph checks
            unless a run is selected. Activity shows the loaded window.
          </p>
          {summary !== undefined && (
            <Provenance observed={summary} scope={scope} context={context} label="Summary" />
          )}
          {coordination !== undefined && (
            <Provenance observed={coordination} scope={scope} context={context} label="Attention" />
          )}
          {questions !== undefined && (
            <Provenance observed={questions} scope={scope} context={context} label="Questions" />
          )}
        </div>
      </details>
    </div>
  );
}
