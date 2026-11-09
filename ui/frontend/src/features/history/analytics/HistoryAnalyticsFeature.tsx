import { formatUsd } from "../usage-dashboard/model";
import { ReferenceField } from "../../discussions/ReferenceFields";
import { FormSection } from "../../discussions/FormSection";
import { Icon } from "../../../components/Icon";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ReadState } from "../../../core/state/read-slot";
import { Badge, Button, Field, Panel, Select, Toolbar } from "../../../components/Primitives";
import { routeHref } from "../../../app/navigation";
import * as d from "../../../core/protocol/decoders";
import { current } from "../transcript/controller";
import { failureText } from "../../connections/failure";
import { LazyDetails } from "../../connections/shared";
import { AnalyticsInputError, searchRoute, sessionSummary } from "./model";
import { ReportEditor } from "./ReportEditor";
import { usageQueryMatches } from "./client";
import { jsonField } from "../../../core/json";
import type {
  GroupKey,
  HistoryAnalyticsFeatureProps,
  MetricTotal,
  SearchQuery,
  UsageQuery,
  UsageTotals,
} from "./types";
import "./analytics.css";

function Status<T>({ state, label }: { readonly state: ReadState<T>; readonly label: string }) {
  if (state.kind === "unexpected_error") throw state.error;
  if (state.kind === "loading" && state.previous === undefined)
    return (
      <p role="status">
        Loading {label}…{state.previous !== undefined ? " Previous capture remains visible." : ""}
      </p>
    );
  if (state.kind === "failed")
    return (
      <p role="alert" className="wg-error">
        {label}: {failureText(state.failure)}
        {state.previous !== undefined ? " Previous capture retained; it is not fresh." : ""}
      </p>
    );
  return null;
}
function groupName(group: GroupKey): string {
  switch (group.kind) {
    case "workspace":
      return "Workspace";
    case "project":
      return `Project ${group.project_id}`;
    case "milestone":
      return `Milestone ${group.milestone_id}`;
    case "ticket":
      return `Ticket ${group.ticket_id}`;
    case "run":
      return `Run ${group.run_id}`;
    case "attempt":
      return `Attempt ${group.attempt_id}`;
    case "unassigned":
      return group.reason === "run_scope_has_no_attempt"
        ? "Unassigned: run report has no attempt"
        : group.reason === "ticket_has_no_project"
          ? "Unassigned: ticket has no project"
          : "Unassigned: ticket has no milestone";
  }
}
function Totals({ value }: { readonly value: UsageTotals }) {
  return (
    <p className="ha-totals">
      {value.observations === "0" ? (
        <strong>No reported observations; consumption unknown.</strong>
      ) : (
        <>
          <span className="ha-total">
            <strong>{BigInt(value.tokens).toLocaleString()}</strong>
            <span>Reported tokens</span>
          </span>
          <span className="ha-total">
            <strong>{BigInt(value.elapsed_ms).toLocaleString()}</strong>
            <span>Reported milliseconds</span>
          </span>
          <span className="ha-total">
            <strong>{value.observations}</strong>
            <span>Saved reports</span>
          </span>
        </>
      )}
      {value.overflow && (
        <Badge tone="warning">Token or elapsed total saturated at int64 maximum</Badge>
      )}
      {value.metric_overflow && <Badge tone="warning">Named metric saturation</Badge>}
    </p>
  );
}
function metricName(name: string): string {
  const names: Readonly<Record<string, string>> = {
    input_tokens: "Input tokens",
    output_tokens: "Output tokens",
    cached_input_tokens: "Cached input tokens",
    reasoning_output_tokens: "Reasoning tokens",
    cost_usd_micros: "Reported cost",
    estimated_cost_usd_micros: "Estimated cost",
  };
  return Object.hasOwn(names, name) ? names[name]! : name;
}
function Metrics({ items }: { readonly items: readonly MetricTotal[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Reported sample</th>
          <th>Value</th>
          <th>Unit</th>
          <th>Sources</th>
        </tr>
      </thead>
      <tbody>
        {items.map((v) => (
          <tr key={`${v.name}/${v.unit}`}>
            <td title={v.name}>{metricName(v.name)}</td>
            <td title={`${v.value} ${v.unit}`}>
              <code>
                {v.unit === "microUSD" &&
                ["cost_usd_micros", "estimated_cost_usd_micros"].includes(v.name)
                  ? formatUsd(BigInt(v.value))
                  : BigInt(v.value).toLocaleString()}
              </code>
              {v.overflow && <Badge tone="warning">Saturated</Badge>}
            </td>
            <td>
              {v.unit === "microUSD" &&
              ["cost_usd_micros", "estimated_cost_usd_micros"].includes(v.name)
                ? "USD"
                : v.unit}
            </td>
            <td>{v.samples}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
function Search({ context, selection, controller }: HistoryAnalyticsFeatureProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.get),
    page = current(state.search) ?? state.searchCapture ?? undefined;
  const [query, setQuery] = useState<SearchQuery>(state.searchQuery),
    [head, setHead] = useState(
      state.searchQuery.capture.kind === "pinned" ? (state.searchQuery.capture.head ?? "") : "",
    ),
    [captureKind, setCaptureKind] = useState<"current" | "empty" | "pinned">(
      state.searchQuery.capture.kind === "current"
        ? "current"
        : state.searchQuery.capture.head === null
          ? "empty"
          : "pinned",
    ),
    [issue, setIssue] = useState("");
  const submit = (next = false) => {
    setIssue("");
    try {
      let capture: SearchQuery["capture"] = { kind: "current" };
      if (captureKind === "empty") capture = { kind: "pinned", head: null };
      if (captureKind === "pinned") {
        const value = d.digest.decode(d.jsonString(head));
        if (!value.ok)
          throw new AnalyticsInputError("A pinned search needs a lowercase SHA-256 History head.");
        capture = { kind: "pinned", head: value.value };
      }
      controller.search({ ...query, capture }, next);
    } catch (error: unknown) {
      if (error instanceof AnalyticsInputError) setIssue(error.message);
      else throw error;
    }
  };
  return (
    <section aria-label="History search" className="ha-search">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <FormSection
          title="What are you looking for?"
          description="Enter words from a recorded prompt, reply or tool result. Search checks supplied searchable text; it does not generate an answer or contact a model."
          icon="search"
        >
          <div className="ha-searchbar">
            <Field
              label="Search retained text"
              value={query.text}
              onChange={(e) => setQuery({ ...query, text: e.currentTarget.value })}
            />
            <Button tone="primary" type="submit">
              <Icon name="search" /> Search history
            </Button>
          </div>
        </FormSection>
        <details>
          <summary>Narrow the search · session, event types and saved snapshot</summary>
          <ReferenceField
            kind="session"
            label="Search in a session"
            value={query.sessionId}
            onChange={(value) => setQuery({ ...query, sessionId: value })}
            hint="Leave empty to search all sessions in this workspace."
          />
          <label className="wg-field">
            Event kinds (one per line)
            <textarea
              aria-label="Search event kinds"
              rows={2}
              value={query.kinds.join("\n")}
              onChange={(e) =>
                setQuery({
                  ...query,
                  kinds: e.currentTarget.value === "" ? [] : e.currentTarget.value.split("\n"),
                })
              }
            />
          </label>
          <Select
            label="Search capture"
            value={captureKind}
            onChange={(e) =>
              setCaptureKind(
                e.currentTarget.value === "empty"
                  ? "empty"
                  : e.currentTarget.value === "pinned"
                    ? "pinned"
                    : "current",
              )
            }
          >
            <option value="current">Capture current History on Search</option>
            <option value="empty">Explicit empty History</option>
            <option value="pinned">Exact retained History head</option>
          </Select>
          {captureKind === "pinned" && (
            <Field
              label="Search History head"
              value={head}
              onChange={(e) => setHead(e.currentTarget.value)}
            />
          )}
          <Button
            disabled={selection.head === undefined}
            onClick={() => {
              setCaptureKind(selection.head === null ? "empty" : "pinned");
              setHead(selection.head ?? "");
            }}
          >
            Use selected transcript capture
          </Button>
          <div className="ha-grid">
            <Field
              label="Search page size"
              value={query.limit}
              onChange={(e) => setQuery({ ...query, limit: e.currentTarget.value })}
            />
            <Field
              label="Search byte budget"
              value={query.maxBytes}
              onChange={(e) => setQuery({ ...query, maxBytes: e.currentTarget.value })}
            />
          </div>
        </details>
      </form>
      {issue !== "" && (
        <p role="alert" className="wg-error">
          {issue}
        </p>
      )}
      <Status state={state.search} label="History search" />
      {state.search.kind === "failed" && page !== undefined && (
        <p>Last confirmed page retained; the search continuation has not advanced.</p>
      )}
      {page === undefined && state.search.kind !== "loading" && (
        <div className="ha-orientation">
          <Icon name="search" />
          <div>
            <h3>Find the message, then read it in context</h3>
            <p>
              Search for a distinctive phrase. Each result opens the exact saved event, with its
              original payload available alongside the readable view.
            </p>
          </div>
        </div>
      )}
      {page !== undefined && (
        <>
          <p>
            Results for <strong>{page.query.text}</strong> ·{" "}
            {page.query.sessionId === "" ? "all sessions" : `session ${page.query.sessionId}`} ·{" "}
            {page.query.kinds.length === 0 ? "all event kinds" : page.query.kinds.join(", ")}.
            Change the filters and press Search to start again.
          </p>
          <p role="status">
            {page.data.items.length} matching events on this page ·{" "}
            {page.data.index_complete
              ? "Index complete for these filters"
              : "Still indexing — some events are not searchable yet"}{" "}
            · {page.data.has_more ? "more results may be available" : "end of this search"}
          </p>
          {page.data.restart_after_indexing && (
            <p role="alert">
              {page.data.unindexed_events} events are not indexed. Restart this search explicitly
              after indexing; no continuation is available.
            </p>
          )}
          {page.data.unsearchable_events !== "0" && (
            <p>
              {page.data.unsearchable_events} events have no searchable text. Their original
              payloads remain available in History.
            </p>
          )}
          {page.data.omitted_for_budget !== "0" && (
            <p>
              {page.data.omitted_for_budget} matching record omitted at this byte boundary; native
              continuation retains the scanned position.
            </p>
          )}
          {page.data.items.length === 0 && (
            <div className="ht-empty">
              <Icon name="search" />
              <h3>No matching events on this page</h3>
              <p>
                Try fewer words or a different session. Search only includes text saved for
                indexing; the original messages remain available in Sessions.
              </p>
            </div>
          )}
          <ol className="ha-hits">
            {page.data.items.map((hit) => (
              <li key={`${hit.event_ref.session_id}/${hit.event_ref.sequence}`}>
                <a href={routeHref(searchRoute(context.route, page, hit))}>
                  {hit.event_ref.session_id} · event {hit.event_ref.sequence}
                </a>
                <p>{hit.snippet}</p>
                <small>
                  {hit.role} · {hit.kind}
                </small>
              </li>
            ))}
          </ol>
          <Button
            disabled={state.search.kind === "loading" || page.data.next === null}
            onClick={() => submit(true)}
          >
            Next search page
          </Button>
          <LazyDetails summary="Search coverage and exact source capture">
            <p>
              Connection {page.scope.connectionId} generation {page.scope.generation}; workspace{" "}
              {page.scope.workspaceId}; History head {page.capture.head ?? "empty"}. Search is
              lexical retained text, not a provider query or semantic model.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Committed through</th>
                  <th>Indexed through</th>
                </tr>
              </thead>
              <tbody>
                {page.data.coverage.map((v) => (
                  <tr key={v.session_id}>
                    <td>{v.session_id}</td>
                    <td>{v.committed_through}</td>
                    <td>{v.indexed_through}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </LazyDetails>
        </>
      )}
    </section>
  );
}
function Usage(props: HistoryAnalyticsFeatureProps) {
  const { context, controller } = props,
    state = useSyncExternalStore(controller.subscribe, controller.get),
    [query, setQuery] = useState<UsageQuery>(state.usageQuery),
    aggregate = current(state.aggregate) ?? state.aggregateCapture ?? undefined,
    records = current(state.records) ?? state.recordsCapture ?? undefined;
  const change = (patch: Partial<UsageQuery>) => setQuery({ ...query, ...patch });
  return (
    <section aria-label="Reported usage" className="ha-usage">
      <div className="ha-orientation">
        <Icon name="activity" />
        <div>
          <h3>Compare the work, then inspect its reports</h3>
          <p>
            Choose how to group consumption and apply your filters. Browse reports to see the
            original measurements, or record a new report when you have measured usage to save.
          </p>
        </div>
      </div>
      <Toolbar label="Usage views">
        <Button tone="primary" onClick={() => controller.aggregate(query)}>
          Refresh totals
        </Button>
        <Button onClick={() => controller.records()}>Browse report records</Button>
        <Button
          requiresActor
          disabled={context.profileState !== "current"}
          onClick={() => controller.newReport(context)}
        >
          <Icon name="plus" /> Report usage
        </Button>
      </Toolbar>
      {!context.writer.actorId && (
        <p className="wg-hint">
          To save a report, choose an acting actor in the bottom-left corner. You can browse and
          compare existing reports without one.
        </p>
      )}
      <details className="ha-usage-options">
        <summary>Grouping and filters</summary>
        <p>
          Start with runs to compare agent invocations, or choose projects and tickets to see where
          work was recorded. Click Refresh totals after changing a setting.
        </p>
        <div className="ha-grid">
          <Select
            label="Group reported usage by"
            value={query.group}
            onChange={(e) => {
              const group = (
                ["workspace", "project", "milestone", "ticket", "run", "attempt"] as const
              ).find((v) => v === e.currentTarget.value);
              if (group !== undefined) change({ group });
            }}
          >
            {["workspace", "project", "milestone", "ticket", "run", "attempt"].map((v) => (
              <option value={v} key={v}>
                {v}
              </option>
            ))}
          </Select>
          <Select
            label="Usage metric layout"
            value={query.layout}
            onChange={(e) =>
              change({
                layout:
                  e.currentTarget.value === "rows"
                    ? "rows"
                    : e.currentTarget.value === "totals_only"
                      ? "totals_only"
                      : "nested",
              })
            }
          >
            <option value="nested">Totals with metric details</option>
            <option value="rows">One row per metric</option>
            <option value="totals_only">Totals only</option>
          </Select>
        </div>
        <details>
          <summary>Optional scope filters and retrieval settings</summary>
          <p>
            Every selected filter must match. These filters apply to usage reports in this
            workspace; the project in the navigation bar does not automatically narrow them.
          </p>
          <div className="ha-grid">
            {(
              [
                ["projectId", "Project ID"],
                ["milestoneId", "Milestone ID"],
                ["ticketId", "Ticket ID"],
                ["runId", "Run ID"],
                ["attemptId", "Attempt ID"],
                ["actorId", "Reporting actor ID"],
              ] as const
            ).map(([key, label]) =>
              key === "projectId" || key === "milestoneId" ? (
                <Field
                  key={key}
                  label={`Usage ${label}`}
                  value={query[key]}
                  onChange={(e) => change({ [key]: e.currentTarget.value })}
                />
              ) : (
                <ReferenceField
                  key={key}
                  kind={
                    key === "actorId"
                      ? "actor"
                      : key === "runId"
                        ? "run"
                        : key === "attemptId"
                          ? "attempt"
                          : "ticket"
                  }
                  label={`Usage ${label}`}
                  value={query[key]}
                  onChange={(value) => change({ [key]: value })}
                />
              ),
            )}
            <Field
              label="Usage page size"
              value={query.limit}
              onChange={(e) => change({ limit: e.currentTarget.value })}
            />
            <Field
              label="Usage byte budget"
              value={query.maxBytes}
              onChange={(e) => change({ maxBytes: e.currentTarget.value })}
            />
          </div>
        </details>
      </details>
      <Status state={state.aggregate} label="Usage aggregate" />
      {state.aggregate.kind === "failed" && aggregate !== undefined && (
        <p>Last confirmed aggregate page retained; its continuation has not advanced.</p>
      )}
      {aggregate !== undefined && (
        <div className="ha-aggregate">
          <h4>Reported totals</h4>
          <p>
            Saved query: {aggregate.data.group_by} groups · {aggregate.data.metrics_layout} layout
            {(
              [
                "project_id",
                "milestone_id",
                "ticket_id",
                "run_id",
                "attempt_id",
                "actor_id",
              ] as const
            )
              .map((name) => {
                const v = jsonField(aggregate.invocation.params, name);
                return v?.kind === "string" ? ` · ${name}: ${v.value}` : "";
              })
              .join("")}
            .
          </p>
          {!usageQueryMatches(aggregate.invocation, props.selection.scope, query) && (
            <p role="status">
              Edited filters are not applied to these retained results. Refresh totals to apply
              them.
            </p>
          )}
          <Totals value={aggregate.data.totals} />
          <p className="wg-hint">
            Totals cover every matching saved report, including groups on other pages. Grouping uses
            the ticket membership saved at this snapshot.
          </p>
          {aggregate.data.unassigned_run_usage.observations !== "0" && (
            <details>
              <summary>Reports recorded for a run, without a specific ticket attempt</summary>
              <Totals value={aggregate.data.unassigned_run_usage} />
              <p>
                {aggregate.data.unassigned_in_totals ? "Included" : "Excluded"} in filtered totals.
                These reports describe a whole run. Workgraph does not guess how much belongs to
                each ticket or project.
              </p>
            </details>
          )}
          {aggregate.data.items.map((item, i) => (
            <section className="ha-usage-row" key={`${i}/${groupName(item.group)}`}>
              <h5>{groupName(item.group)}</h5>
              {item.kind === "metric" ? (
                <Metrics items={[item.metric]} />
              ) : (
                <>
                  <Totals value={item.totals} />
                  {item.metrics !== undefined && item.metrics.length > 0 && (
                    <Metrics items={item.metrics} />
                  )}
                  {aggregate.data.metrics_layout === "totals_only" &&
                    item.totals.metric_series !== "0" && (
                      <p>
                        {item.totals.metric_series} named series omitted by the selected totals-only
                        layout, not missing or zero.
                      </p>
                    )}
                </>
              )}
            </section>
          ))}
          {aggregate.data.needs_larger_budget && (
            <p role="alert">
              A whole group does not fit this budget. Required bytes:{" "}
              {aggregate.data.required_bytes}.{" "}
              {BigInt(aggregate.data.required_bytes ?? "0") > 1048576n
                ? "It exceeds the native maximum; choose a different explicit layout."
                : "Increase the budget and continue at this same position."}
            </p>
          )}
          <Toolbar label="Usage continuation">
            <Button
              disabled={
                state.aggregate.kind === "loading" ||
                aggregate.data.cursor === null ||
                !usageQueryMatches(aggregate.invocation, props.selection.scope, query)
              }
              onClick={() => controller.aggregate(query, true)}
            >
              Next usage page
            </Button>
            {aggregate.data.needs_larger_budget &&
              aggregate.data.required_bytes !== null &&
              BigInt(aggregate.data.required_bytes) <= 1048576n && (
                <Button
                  onClick={() => {
                    const next = {
                      ...query,
                      maxBytes: aggregate.data.required_bytes ?? query.maxBytes,
                    };
                    setQuery(next);
                    controller.aggregate(next, true);
                  }}
                >
                  Retry whole group with required budget
                </Button>
              )}
          </Toolbar>
        </div>
      )}
      <Status state={state.records} label="Usage records" />
      {state.records.kind === "failed" && records !== undefined && (
        <p>Last confirmed record page retained; its continuation has not advanced.</p>
      )}
      {records !== undefined && (
        <>
          <h3>Saved usage reports</h3>
          <p className="wg-hint">
            Each report is a permanent measurement with its author and source. These records explain
            where the totals came from.
          </p>
          {records.data.items.length === 0 && (
            <p>No usage reports have been recorded for this selection.</p>
          )}
          {records.data.items.map((v) => (
            <details key={v.usage_id}>
              <summary>
                {v.scope.kind === "run" ? `Run ${v.scope.run_id}` : `Attempt ${v.scope.attempt_id}`}{" "}
                · {v.tokens} tokens · {v.elapsed_ms} ms · {v.actor_id}
              </summary>
              <p>
                Report ID {v.usage_id}; caller timestamp: {v.timestamp}
              </p>
              <p>{v.provenance}</p>
              {v.metrics.map((m) => (
                <p key={m.name}>
                  {m.name}: <code>{m.value}</code> {m.unit}
                </p>
              ))}
            </details>
          ))}
          <p>{records.data.omitted} remaining records in this policy capture.</p>
          <Button
            disabled={records.data.next_offset === null || state.records.kind === "loading"}
            onClick={() => controller.records(true)}
          >
            Next report records
          </Button>
        </>
      )}
    </section>
  );
}
function Summary({
  history,
  controller,
  showUsage,
  showSessions,
}: HistoryAnalyticsFeatureProps & {
  readonly showUsage: () => void;
  readonly showSessions: () => void;
}) {
  const state = useSyncExternalStore(history.subscribe, history.get),
    summary = sessionSummary(state),
    [selected, setSelected] = useState("");
  if (summary === null)
    return (
      <div className="ht-empty">
        <Icon name="history" />
        <h3>Choose a session to summarize</h3>
        <p>
          Open a conversation from Sessions, then return here. You’ll see its loaded event count and
          any explicit usage reports retained in that window.
        </p>
        <Button onClick={showSessions}>Choose a session</Button>
      </div>
    );
  const reports = summary.reports.filter((v) => v.metrics.length > 0),
    report = reports.find((v) => `${v.event.session_id}/${v.event.sequence}` === selected);
  return (
    <section aria-label="Session summary" className="ha-summary">
      <div className="ha-summary-stats">
        <div>
          <Icon name="history" />
          <strong>{summary.loadedEvents}</strong>
          <span>Events loaded</span>
        </div>
        <div>
          <Icon name="list" />
          <strong>{summary.through}</strong>
          <span>Events at this snapshot</span>
        </div>
        <div>
          <Icon name="activity" />
          <strong>{reports.length}</strong>
          <span>Events with usage data</span>
        </div>
        <div>
          <Icon name={summary.archived ? "archive" : "history"} />
          <strong>{summary.archived ? "Archived" : "Open"}</strong>
          <span>{summary.archived ? "Kept for reading" : "Can accept new events"}</span>
        </div>
      </div>
      {(state.session.kind !== "ready" || state.window.kind !== "ready") && (
        <p role="status">Showing the last confirmed summary while the session refreshes.</p>
      )}
      <details>
        <summary>Window, payload and origin details</summary>
        <p>
          {summary.through} committed events at the selected head.{" "}
          {summary.declaredPayloadBytes.toString()} primary-payload bytes referenced in this window;
          these are declared sizes, not downloaded bytes or full-session storage.
        </p>
        <p>
          {summary.originatingRunId === null
            ? "Originating run unavailable."
            : `Originating run ${summary.originatingRunId}. Run usage may cover other sessions.`}
        </p>
      </details>
      {summary.originatingRunId !== null && (
        <Button
          onClick={() => {
            controller.aggregate({
              ...controller.get().usageQuery,
              group: "run",
              runId: summary.originatingRunId ?? "",
              projectId: "",
              milestoneId: "",
              ticketId: "",
              attemptId: "",
              actorId: "",
            });
            showUsage();
          }}
        >
          View originating run reports
        </Button>
      )}
      <h3>Measurements saved inside the conversation</h3>
      <p>
        These measurements came from the imported conversation, rather than Workgraph usage reports.
        Choose an event to inspect its figures. Some are running totals, so they are not added
        together. Load more of the session to include more events here.
      </p>
      {reports.length === 0 ? (
        <p>No validated metric report is loaded in this window. Usage is unknown, not zero.</p>
      ) : (
        <>
          <Select
            label="Select exact source metric report"
            value={report === undefined ? "" : selected}
            onChange={(e) => setSelected(e.currentTarget.value)}
          >
            <option value="">Choose an event with measurements</option>
            {reports.map((v) => (
              <option
                key={`${v.event.session_id}/${v.event.sequence}`}
                value={`${v.event.session_id}/${v.event.sequence}`}
              >
                Event {v.event.sequence} · {v.metrics[0]?.provenance.adapter}
              </option>
            ))}
          </Select>
          {report !== undefined && (
            <table>
              <thead>
                <tr>
                  <th>Reported metric</th>
                  <th>Exact value</th>
                  <th>Source extent</th>
                </tr>
              </thead>
              <tbody>
                {report.metrics.map((v, i) => (
                  <tr key={i}>
                    <td>{v.name}</td>
                    <td>
                      <code>{v.lexeme}</code> {v.unit}
                    </td>
                    <td>
                      <span>
                        {v.basis === "cumulative-snapshot"
                          ? "Running total reported by the source"
                          : v.basis === "breakdown"
                            ? "Part of a larger report"
                            : "Measurement reported in this event"}
                      </span>
                      <details>
                        <summary>Source scope and provenance</summary>
                        <p>
                          {v.scope.kind} · {v.basis}; source path{" "}
                          {v.provenance.path.join("/") || "(root)"}; adapter {v.provenance.adapter};
                          schema {v.provenance.schemaPin.name}@{v.provenance.schemaPin.revision}.
                        </p>
                        <p>
                          {v.snapshotKey === null
                            ? "Exact cumulative query identity unknown."
                            : `Report identity ${v.snapshotKey}`}
                          {v.possibleOverlapKey === null
                            ? ""
                            : ` Potential overlapping report group ${v.possibleOverlapKey}; not an additive identity.`}
                        </p>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
export function HistoryAnalyticsFeature(props: HistoryAnalyticsFeatureProps) {
  const state = useSyncExternalStore(props.controller.subscribe, props.controller.get);
  const tab =
    props.context.route.section?.view === "history"
      ? props.context.route.section.value
      : "sessions";
  const setTab = (value: "search" | "usage" | "summary" | "sessions") =>
    props.context.navigate({
      ...props.context.route,
      section: { view: "history", value },
    });
  const scopeKey = JSON.stringify(props.selection.scope),
    head = props.selection.head,
    session = props.selection.sessionId;
  useEffect(
    () => props.controller.select({ scope: props.selection.scope, head, sessionId: session }),
    [props.controller, scopeKey, head, session, props.selection.scope],
  );
  if (state.unexpected !== null) throw state.unexpected.error;
  const draft = state.drafts.find((v) => v.id === state.selectedDraftId);
  return (
    <div className="ha-root">
      <Panel
        title={
          tab === "search"
            ? "Search recorded text"
            : tab === "usage"
              ? "Usage reports"
              : "Session summary"
        }
      >
        {state.issue !== null && (
          <p role="alert" className="wg-error">
            {state.issue}
          </p>
        )}
        {state.selection === null || JSON.stringify(state.selection.scope) !== scopeKey ? (
          <p role="status">Selecting History tools scope…</p>
        ) : tab === "search" ? (
          <Search {...props} />
        ) : tab === "usage" ? (
          <Usage {...props} />
        ) : tab === "summary" ? (
          <Summary
            {...props}
            showUsage={() => setTab("usage")}
            showSessions={() => setTab("sessions")}
          />
        ) : null}
        {state.drafts.length > 0 && (
          <details>
            <summary>Your unfinished usage reports ({state.drafts.length})</summary>
            {state.drafts.map((v) => (
              <Button key={v.id} onClick={() => props.controller.selectReport(v.id)}>
                {v.input.usageId} · {v.context.writer.actorId}
              </Button>
            ))}
          </details>
        )}
      </Panel>
      {draft !== undefined && (
        <ReportEditor
          key={draft.id}
          context={props.context}
          draft={draft}
          controller={props.controller}
          operations={props.operations}
        />
      )}
    </div>
  );
}
