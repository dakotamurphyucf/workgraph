import { identifier } from "./model";
import "./participants.css";
import "../../../components/section-navigation.css";
import { ParticipantGuide, WriterContext } from "../presentation";
import { PANEL_GUIDES } from "../guides";
import { ReferenceFields, ReferenceField } from "../../discussions/ReferenceFields";
import { FormSection } from "../../discussions/FormSection";
import { ManagementPresentation } from "../../connections/management-presentation";
import { CapturedValues } from "../../connections/CapturedValues";
import { ParticipantTable } from "./ParticipantTable";
import { ActorAvatar } from "../../../components/ActorAvatar";
import { Icon } from "../../../components/Icon";
import { Dialog } from "../../../components/Dialog";
import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { Badge, Button, Field, Panel, Select, Toolbar } from "../../../components/Primitives";
import type { FeatureContext } from "../../../app/types";
import type { Identifier } from "../../../core/protocol/types";
import type { ReadState } from "../../../core/state/read-slot";
import type { OperationController } from "../../../core/state/operations";
import { failureText } from "../../connections/failure";
import { LazyDetails, OperationPanel } from "../../connections/shared";
import { readText, signalSummary } from "./codecs";
import { participantsRoute, sessionRoute } from "./navigation";
import type {
  ParticipantsController,
  ParticipantsDraft,
  ParticipantsInput,
  ParticipantsPanel,
} from "./types";

const ACTIONS: readonly {
  method: ParticipantsInput["method"];
  label: string;
  hint: string;
}[] = [
  {
    method: "actor.put",
    label: "Register or edit a person or agent",
    hint: "Register or update a person or agent in the workspace catalog. This is a cooperative identity, not an authenticated credential.",
  },
  {
    method: "run.register",
    label: "Register a run",
    hint: "Record a real invocation already started by a person or harness. Registration does not launch a process. Its actor, objective, capabilities and external references are immutable.",
  },
  {
    method: "run.transition",
    label: "Record a run state",
    hint: "Update recorded coordination state. This does not start, stop or inspect an operating-system process.",
  },
  {
    method: "run.observe",
    label: "Record an observation",
    hint: "Record when the run was observed. Use the actual observation time; this is not a process-liveness check.",
  },
  {
    method: "run.heartbeat",
    label: "Send an advisory heartbeat",
    hint: "One explicit observation only. It never renews a claim or reservation, and is not proof of an operating-system process.",
  },
  {
    method: "run.link_session",
    label: "Associate a session",
    hint: "Add an explicit session association to the recorded run. History-attributed sessions are included separately in the captured union.",
  },
  {
    method: "attempt.start",
    label: "Start a recorded attempt",
    hint: "Record an attempt by the actual actor and run holding this ticket claim. This does not launch an agent.",
  },
  {
    method: "attempt.checkpoint",
    label: "Add an attempt checkpoint",
    hint: "Pin an exact published resource version or handoff revision as a checkpoint.",
  },
  {
    method: "attempt.finish",
    label: "Finish a recorded attempt",
    hint: "Record completion, failure or cancellation with supporting evidence.",
  },
  {
    method: "run.action_acknowledge",
    label: "Acknowledge a runner action",
    hint: "The harness performs any external effect. This only acknowledges a recorded child-run request with evidence.",
  },
  {
    method: "run.budget_put",
    label: "Set run attention limits",
    hint: "Set allocation bounds and externally reported attention limits. Empty means no limit. Reported spending is a lower bound, not measured process usage.",
  },
];
const PANELS: readonly { value: ParticipantsPanel; label: string }[] = [
  { value: "actors", label: "People and agents" },
  { value: "catalog", label: "Actor catalog" },
  { value: "runs", label: "Recorded runs" },
  { value: "attempts", label: "Attempts" },
  { value: "actor-overview", label: "Actor overview" },
  { value: "coordinator", label: "Coordination overview" },
  { value: "actions", label: "Runner actions" },
  { value: "budget", label: "Run limits" },
  { value: "budget-attention", label: "Attention signals" },
  { value: "heartbeat", label: "Advisory heartbeat" },
];
function SourceArea({
  label,
  value,
  onChange,
  disabled,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
  readonly hint?: string;
}) {
  const id = useId();
  return (
    <div className="wg-field">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        aria-label={label}
        value={value}
        disabled={disabled}
        rows={4}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {hint && <p className="wg-hint">{hint}</p>}
    </div>
  );
}
function DraftFields({
  draft,
  controller,
}: {
  readonly draft: ParticipantsDraft;
  readonly controller: ParticipantsController;
}) {
  const input = draft.input,
    disabled = draft.phase.kind !== "editing",
    update = (input: ParticipantsInput) => controller.edit(draft.id, input),
    field = (label: string, value: string, onChange: (value: string) => void, hint?: string) => (
      <Field
        label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
        {...(hint === undefined ? {} : { hint })}
      />
    );
  const reference = (
    kind: "actor" | "run" | "attempt" | "ticket",
    label: string,
    value: string,
    onChange: (value: string) => void,
    hint?: string,
  ) => (
    <ReferenceField
      kind={kind}
      label={label}
      value={value}
      onChange={onChange}
      disabled={disabled}
      {...(hint === undefined ? {} : { hint })}
    />
  );
  const area = (label: string, value: string, onChange: (value: string) => void, hint?: string) => (
    <SourceArea
      label={label}
      value={value}
      disabled={disabled}
      onChange={onChange}
      {...(hint === undefined ? {} : { hint })}
    />
  );
  switch (input.method) {
    case "actor.put":
      return (
        <>
          {reference("actor", "Actor ID", input.actorId, (value) =>
            update({ ...input, actorId: value }),
          )}
          {field("Display name", input.name, (value) => update({ ...input, name: value }))}
          <Select
            label="Actor kind"
            value={input.actorKind}
            disabled={disabled}
            onChange={(event) =>
              update({
                ...input,
                actorKind: event.currentTarget.value === "person" ? "person" : "agent",
              })
            }
          >
            <option value="person">Person</option>
            <option value="agent">Agent</option>
          </Select>
          <label>
            <input
              type="checkbox"
              checked={input.archived}
              disabled={disabled}
              onChange={(event) => update({ ...input, archived: event.currentTarget.checked })}
            />{" "}
            Archive this identity in the catalog
          </label>
          <p className="wg-hint">
            Archiving preserves authored history and marks the catalog entry inactive. It does not
            remove permissions or stop a running agent.
          </p>
        </>
      );
    case "run.register":
      return (
        <>
          {field("Existing invocation ID", input.runId, (value) =>
            update({ ...input, runId: value }),
          )}
          {area("Invocation objective", input.objective, (value) =>
            update({ ...input, objective: value }),
          )}
          {area(
            "Immutable capabilities",
            input.capabilities,
            (value) => update({ ...input, capabilities: value }),
            "One capability per line; leave empty for none.",
          )}
          <details className="pt-disclosure">
            <summary>Parent run and external references (optional)</summary>
            <p className="wg-hint">
              Link this run to an existing parent, or describe the process and working directory
              managed by your runner. These registration details cannot be edited later.
            </p>
            <div className="pt-field-stack">
              {reference("run", "Parent run ID (optional)", input.parentRunId, (value) =>
                update({ ...input, parentRunId: value }),
              )}
              <Select
                label="When the parent stops"
                value={input.parentStopPolicy}
                disabled={disabled}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  update({
                    ...input,
                    parentStopPolicy:
                      value === "request_cancel"
                        ? value
                        : value === "request_wait"
                          ? value
                          : "continue",
                  });
                }}
              >
                <option value="continue">Continue independently</option>
                <option value="request_cancel">Request cancellation</option>
                <option value="request_wait">Request waiting</option>
              </Select>
              {field(
                "External process reference (optional)",
                input.processRef,
                (value) => update({ ...input, processRef: value }),
                "A descriptive reference supplied by the harness; never a launch command.",
              )}
              {field("Worktree reference (optional)", input.worktreeRef, (value) =>
                update({ ...input, worktreeRef: value }),
              )}
            </div>
          </details>
        </>
      );
    case "run.transition":
      return (
        <>
          {reference("run", "Target run ID", input.runId, (value) =>
            update({ ...input, runId: value }),
          )}
          <Select
            label="Recorded state"
            value={input.status}
            disabled={disabled}
            onChange={(event) => {
              const value = event.currentTarget.value;
              update({
                ...input,
                status:
                  value === "waiting" ||
                  value === "completed" ||
                  value === "failed" ||
                  value === "cancelled"
                    ? value
                    : "running",
              });
            }}
          >
            {["running", "waiting", "completed", "failed", "cancelled"].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
          {area(
            "State evidence",
            input.evidence,
            (value) => update({ ...input, evidence: value }),
            "Required for a terminal state. The daemon checks active attempts and allowed transitions.",
          )}
        </>
      );
    case "run.observe":
      return (
        <>
          {reference("run", "Target run ID", input.runId, (value) =>
            update({ ...input, runId: value }),
          )}
          {field(
            "Observed Unix milliseconds",
            input.observedUnixMs,
            (value) => update({ ...input, observedUnixMs: value }),
            "Exact nonnegative int64 time from the actual observation; not automatically replaced with now.",
          )}
        </>
      );
    case "run.heartbeat":
      return reference("run", "Target run ID", input.runId, (value) =>
        update({ ...input, runId: value }),
      );
    case "run.link_session":
      return (
        <>
          {reference("run", "Target run ID", input.runId, (value) =>
            update({ ...input, runId: value }),
          )}
          {field("Session ID", input.sessionId, (value) => update({ ...input, sessionId: value }))}
        </>
      );
    case "attempt.start":
      return (
        <>
          {reference("run", "Target run ID", input.runId, (value) =>
            update({ ...input, runId: value }),
          )}
          {reference("ticket", "Claimed ticket ID", input.ticketId, (value) =>
            update({ ...input, ticketId: value }),
          )}
          {field("New attempt ID", input.attemptId, (value) =>
            update({ ...input, attemptId: value }),
          )}
          {area(
            "Associated session IDs",
            input.sessionIds,
            (value) => update({ ...input, sessionIds: value }),
            "Optional, one per line. Review checks the actual actor, run and ticket claim token.",
          )}
        </>
      );
    case "attempt.checkpoint":
      return (
        <>
          {reference("attempt", "Attempt ID", input.attemptId, (value) =>
            update({ ...input, attemptId: value }),
          )}
          <Select
            label="Checkpoint source"
            value={input.checkpointKind}
            disabled={disabled}
            onChange={(event) =>
              update({
                ...input,
                checkpointKind: event.currentTarget.value === "handoff" ? "handoff" : "resource",
              })
            }
          >
            <option value="resource">Published resource version</option>
            <option value="handoff">Ticket handoff revision</option>
          </Select>
          {field(
            input.checkpointKind === "resource" ? "Resource ID" : "Handoff ticket ID",
            input.targetId,
            (value) => update({ ...input, targetId: value }),
          )}
          {field(
            "Exact source revision",
            input.revision,
            (value) => update({ ...input, revision: value }),
            "Use the resource content version, or the handoff revision; never a resource metadata revision.",
          )}
        </>
      );
    case "attempt.finish":
      return (
        <>
          {reference("attempt", "Attempt ID", input.attemptId, (value) =>
            update({ ...input, attemptId: value }),
          )}
          <Select
            label="Attempt outcome"
            value={input.state}
            disabled={disabled}
            onChange={(event) => {
              const value = event.currentTarget.value;
              update({
                ...input,
                state: value === "failed" || value === "cancelled" ? value : "completed",
              });
            }}
          >
            {["completed", "failed", "cancelled"].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
          {area("Completion evidence", input.evidence, (value) =>
            update({ ...input, evidence: value }),
          )}
        </>
      );
    case "run.action_acknowledge":
      return (
        <>
          {reference("run", "Requested child run ID", input.childRunId, (value) =>
            update({ ...input, childRunId: value }),
          )}
          {area("Action acknowledgement evidence", input.evidence, (value) =>
            update({ ...input, evidence: value }),
          )}
        </>
      );
    case "run.budget_put":
      return (
        <>
          {reference("run", "Target run ID", input.runId, (value) =>
            update({ ...input, runId: value }),
          )}
          {field(
            "Maximum attempts",
            input.maxAttempts,
            (value) => update({ ...input, maxAttempts: value }),
            "Positive whole number, or empty for no limit.",
          )}
          {field("Maximum active attempts", input.maxActiveAttempts, (value) =>
            update({ ...input, maxActiveAttempts: value }),
          )}
          {field("Reported token attention limit", input.reportedTokenLimit, (value) =>
            update({ ...input, reportedTokenLimit: value }),
          )}
          {field("Reported elapsed milliseconds limit", input.reportedElapsedMsLimit, (value) =>
            update({ ...input, reportedElapsedMsLimit: value }),
          )}
        </>
      );
  }
}
function ReadStatus<T>({ state }: { readonly state: ReadState<T> }) {
  if (state.kind === "unexpected_error") throw state.error;
  if (state.kind === "loading" && state.previous === undefined)
    return <p role="status">Reading captured records…</p>;
  if (state.kind === "failed") return <p role="alert">{failureText(state.failure)}</p>;
  return null;
}
function ready<T>(state: ReadState<T>): T | undefined {
  return state.kind === "ready"
    ? state.value
    : state.kind === "loading" || state.kind === "failed"
      ? state.previous
      : undefined;
}
function observedTime(value: string | null): string {
  if (value === null) return "No recorded observation";
  const millis = BigInt(value);
  return millis <= 8640000000000000n
    ? new Date(Number(millis)).toLocaleString()
    : "Recorded time outside the browser calendar range";
}
export function ParticipantsFeature({
  context,
  controller,
  operations,
}: {
  readonly context: FeatureContext;
  readonly controller: ParticipantsController;
  readonly operations: OperationController;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.get, controller.get),
    [filtersOpen, setFiltersOpen] = useState(false),
    [actionsOpen, setActionsOpen] = useState(false);
  useEffect(() => controller.select(context), [context, controller]);
  if (state.unexpected !== null) throw state.unexpected.error;
  const page = ready(state.page),
    detail = ready(state.detail),
    sessions = ready(state.sessions),
    draft = state.drafts.find((item) => item.id === state.selectedDraftId),
    scope = state.target;
  const selectedRun = detail?.value.kind === "run" ? detail.value.run : undefined,
    selectedAttempt = detail?.value.kind === "attempt" ? detail.value.attempt : undefined;
  const open = (kind: "actor" | "run" | "attempt", id: Identifier) => {
    if (scope !== null)
      context.navigate({
        ...participantsRoute({
          connectionId: scope.connection.id,
          generation: scope.connection.generation,
          workspaceId: scope.workspaceId,
          kind,
          id,
        }),
        projectId: scope.projectId,
      });
  };
  let rows: ReactNode = null;
  if (page !== undefined) {
    const value = page.rows;
    switch (value.kind) {
      case "actors":
      case "catalog":
      case "runs":
      case "attempts":
        rows = <ParticipantTable rows={value} onOpen={open} />;
        break;
      case "actions":
        rows = value.items.map((item) => (
          <article className="wg-list-item" key={`${item.parent_run_id}:${item.child_run_id}`}>
            <h3>
              Child run{" "}
              <Button onClick={() => open("run", item.child_run_id)}>{item.child_run_id}</Button>
            </h3>
            <p>
              Parent {item.parent_run_id} requests{" "}
              {item.policy === "request_cancel"
                ? "cancellation"
                : item.policy === "request_wait"
                  ? "waiting"
                  : "independent continuation"}
              .
            </p>
            <p className="wg-hint">
              A recorded request for the harness. It is not an OS process action.
            </p>
          </article>
        ));
        break;
      case "overview":
        rows = value.items.map((item, index) => (
          <article className="wg-list-item" key={index}>
            <h3>{readText(item, "kind").replaceAll("_", " ") || "Coordination signal"}</h3>
            <p>{signalSummary(item)}</p>
            <details className="pt-disclosure">
              <summary>Signal details</summary>
              <CapturedValues value={item} />
            </details>
          </article>
        ));
        break;
      case "record":
        rows = (
          <>
            <p>
              {state.panel === "heartbeat"
                ? "Advisory observation only. It does not renew ownership or prove that a process is running."
                : "Allocation bounds and externally reported attention limits. These are not a measured process-spending total."}
            </p>
            <CapturedValues value={value.value} />
          </>
        );
        break;
    }
    if ((value.kind === "actions" || value.kind === "overview") && value.items.length === 0)
      rows = <p>No records in this captured page.</p>;
  }
  if (context.route.workspaceId === null) return <p>Select a workspace to view participants.</p>;
  return (
    <ManagementPresentation.Provider value={true}>
      <ReferenceFields
        context={context}
        endpoint={{
          connectionId: context.connection.id,
          generation: context.connection.generation,
          workspaceId: identifier(context.route.workspaceId),
        }}
      >
        <section className="wg-participant-records" aria-label="Participants">
          <div className="pt-browsebar">
            <Toolbar label="Common participant views">
              {(
                [
                  ["runs", "Runs"],
                  ["actors", "People and agents"],
                  ["attempts", "Attempts"],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  tone="quiet"
                  aria-pressed={state.panel === value}
                  onClick={() => controller.panel(value)}
                >
                  <Icon name={PANEL_GUIDES[value].icon} />
                  {label}
                </Button>
              ))}
            </Toolbar>
            <Toolbar label="Participant controls">
              <Button tone="quiet" onClick={() => setFiltersOpen(true)}>
                <Icon name="filter" />
                Views & filters
              </Button>
              <Button tone="quiet" onClick={controller.refresh} aria-label="Refresh records">
                <Icon name="refresh" />
              </Button>
              <Button requiresActor onClick={() => setActionsOpen(true)}>
                <Icon name="plus" />
                Record a change
              </Button>
            </Toolbar>
          </div>
          <div className="pt-content">
            {state.historicalGeneration && (
              <p role="status" className="wg-warning">
                Viewing retained endpoint generation {scope?.connection.generation}. New writes
                require an explicitly selected current target.
              </p>
            )}
            {state.issue && <p role="alert">{state.issue}</p>}
            {filtersOpen && (
              <Dialog
                wide
                title="Participant views and filters"
                onClose={() => setFiltersOpen(false)}
              >
                <div className="pt-filter-editor">
                  {state.issue && (
                    <p role="status" className="pt-filter-guidance">
                      {state.issue}
                    </p>
                  )}
                  <FormSection
                    title="Choose a view"
                    description="Start with people, runs or attempts. The focused views below help you inspect a particular worker, limit or coordination signal."
                    icon="filter"
                  >
                    <div className="pt-view-grid">
                      {PANELS.map((panel) => (
                        <Button
                          key={panel.value}
                          aria-pressed={state.panel === panel.value}
                          onClick={() => controller.panel(panel.value)}
                        >
                          <Icon name={PANEL_GUIDES[panel.value].icon} />
                          <span>
                            <strong>{panel.label}</strong>
                            <small>{PANEL_GUIDES[panel.value].description}</small>
                          </span>
                        </Button>
                      ))}
                    </div>
                  </FormSection>
                  <FormSection
                    title="Narrow the results"
                    description={
                      ["budget", "heartbeat", "actor-overview"].includes(state.panel)
                        ? "Choose the identity this view should inspect, then apply the filters."
                        : "These filters affect the selected view only. Empty optional fields include all matching records."
                    }
                    icon="search"
                    tone="violet"
                  >
                    {["actor-overview", "coordinator"].includes(state.panel) && (
                      <>
                        <ReferenceField
                          kind="actor"
                          label="Actor filter / overview actor"
                          value={state.filter.actorId}
                          onChange={(value) =>
                            controller.filter({ ...state.filter, actorId: value })
                          }
                        />
                      </>
                    )}
                    {["attempts", "actor-overview", "coordinator", "budget", "heartbeat"].includes(
                      state.panel,
                    ) && (
                      <>
                        <ReferenceField
                          kind="run"
                          label="Run filter / limits run"
                          value={state.filter.runId}
                          onChange={(value) => controller.filter({ ...state.filter, runId: value })}
                        />
                      </>
                    )}
                    {state.panel === "attempts" && (
                      <>
                        <ReferenceField
                          kind="ticket"
                          label="Attempt ticket filter"
                          value={state.filter.ticketId}
                          onChange={(value) =>
                            controller.filter({ ...state.filter, ticketId: value })
                          }
                        />
                      </>
                    )}
                    {["attempts", "actor-overview", "coordinator", "budget", "heartbeat"].includes(
                      state.panel,
                    ) && <Button onClick={controller.refresh}>Apply read filters</Button>}
                    {!["attempts", "actor-overview", "coordinator", "budget", "heartbeat"].includes(
                      state.panel,
                    ) && (
                      <p>This view shows workspace-wide records and has no additional filters.</p>
                    )}
                  </FormSection>
                  <Button onClick={() => setFiltersOpen(false)}>Done</Button>
                </div>
              </Dialog>
            )}

            <header className="pt-page-heading">
              <div>
                <h2>
                  {PANELS.find((panel) => panel.value === state.panel)?.label ?? "Participants"}
                </h2>
                <p className="wg-hint">
                  {state.panel === "actor-overview" || state.panel === "coordinator"
                    ? scope?.projectId === null
                      ? "Overview across this workspace."
                      : `Overview filtered to project ${scope?.projectId ?? "unselected"}.`
                    : "Workspace-wide records. A project breadcrumb does not filter this catalog."}
                </p>
              </div>
              {page && page.rows.kind !== "record" && (
                <span className="pt-tag">
                  {page.rows.items.length} on this page
                  {page.rows.kind === "runs"
                    ? ` · ${page.rows.items.filter((run) => run.status === "running").length} recorded running`
                    : ""}
                </span>
              )}
            </header>
            <ParticipantGuide
              title={PANELS.find((panel) => panel.value === state.panel)?.label ?? "Participants"}
              {...PANEL_GUIDES[state.panel]}
            />
            <ReadStatus state={state.detail} />
            {detail && (
              <Dialog
                wide
                onClose={() => {
                  const route = { ...context.route, entityId: null };
                  delete route.participant;
                  context.navigate(route);
                }}
                title={
                  detail.value.kind === "run"
                    ? `Run ${detail.value.run.run_id}`
                    : `Attempt ${detail.value.attempt.attempt_id}`
                }
              >
                <div className="pt-detail">
                  {detail.value.kind === "run" ? (
                    <>
                      <div className="pt-run-summary">
                        <ActorAvatar actor={detail.value.run.actor_id} />
                        <div>
                          <Button tone="quiet" onClick={() => open("actor", selectedRun!.actor_id)}>
                            {detail.value.run.actor_id}
                          </Button>
                          <span>Recorded actor · revision {detail.value.run.revision}</span>
                        </div>
                        <span className="pt-state" data-state={detail.value.run.status}>
                          {detail.value.run.status}
                        </span>
                      </div>
                      <p className="pt-run-objective">{detail.value.run.objective}</p>
                      <dl className="pt-run-properties">
                        <div>
                          <dt>Last recorded observation</dt>
                          <dd>{observedTime(detail.value.run.last_observed_unix_ms)}</dd>
                        </div>
                        <div>
                          <dt>Capabilities</dt>
                          <dd>
                            <div className="pt-capabilities">
                              {detail.value.run.capabilities.map((value) => (
                                <span className="pt-tag" key={value}>
                                  {value}
                                </span>
                              ))}
                              {detail.value.run.capabilities.length === 0 && "None declared"}
                            </div>
                          </dd>
                        </div>
                        <div>
                          <dt>Parent run</dt>
                          <dd>
                            {detail.value.run.parent_run_id ? (
                              <Button
                                tone="quiet"
                                onClick={() => open("run", selectedRun!.parent_run_id!)}
                              >
                                {detail.value.run.parent_run_id}
                              </Button>
                            ) : (
                              "None"
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>If the parent stops</dt>
                          <dd>
                            {detail.value.run.parent_stop_policy === "continue"
                              ? "Continue independently"
                              : detail.value.run.parent_stop_policy === "request_cancel"
                                ? "Request cancellation from the runner"
                                : "Request waiting from the runner"}
                          </dd>
                        </div>
                        <div>
                          <dt>Worktree reference</dt>
                          <dd>{detail.value.run.worktree_ref ?? "Not supplied"}</dd>
                        </div>
                        <div>
                          <dt>Process reference</dt>
                          <dd>{detail.value.run.process_ref ?? "Not supplied"}</dd>
                        </div>
                      </dl>
                      {detail.value.run.evidence && (
                        <section className="pt-detail-section">
                          <h3>
                            <Icon name="check" /> Recorded outcome
                          </h3>
                          <p>{detail.value.run.evidence}</p>
                        </section>
                      )}
                      <ReadStatus state={state.sessions} />
                      {detail.value.run.session_associations.total === "0" ? (
                        <p>No sessions associated at this captured History head.</p>
                      ) : (
                        <>
                          <h3>Associated sessions</h3>
                          <p>
                            {detail.value.run.session_associations.total} associated at the captured
                            History head.
                          </p>
                          <Toolbar label="Captured run sessions">
                            {(sessions?.session_ids ?? detail.value.run.session_ids).map((id) => (
                              <Button
                                key={id}
                                onClick={() =>
                                  context.navigate(
                                    sessionRoute({
                                      connection: detail.target.connection,
                                      workspaceId: detail.target.workspaceId,
                                      sessionId: id,
                                      head:
                                        sessions === undefined
                                          ? selectedRun!.session_associations.history_head
                                          : sessions.history_head,
                                    }),
                                  )
                                }
                              >
                                {id}
                              </Button>
                            ))}
                          </Toolbar>
                          {BigInt(
                            sessions?.remaining ?? detail.value.run.session_associations.omitted,
                          ) > 0n && (
                            <p role="status">
                              {sessions?.remaining ?? detail.value.run.session_associations.omitted}{" "}
                              session associations remain beyond this page.
                            </p>
                          )}
                          {(sessions === undefined
                            ? detail.value.run.session_associations.next_request
                            : sessions.next_request) !== null && (
                            <Button
                              onClick={controller.nextSessions}
                              disabled={
                                state.sessions.kind === "loading" ||
                                (sessions === undefined
                                  ? detail.value.run.session_associations.next_request === null
                                  : sessions.next_request === null)
                              }
                            >
                              Next session associations
                            </Button>
                          )}
                          <LazyDetails summary="Session association capture">
                            <p className="wg-hint">
                              {sessions
                                ? `${sessions.remaining} remain after this page`
                                : `${detail.value.run.session_associations.omitted} beyond this preview`}
                              . Session links retain the exact head, including an empty capture.
                            </p>
                          </LazyDetails>
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      <ParticipantGuide
                        title="Work on a claimed ticket"
                        icon="work"
                        description="An attempt ties one run’s work to a particular ticket claim. Checkpoints retain exact evidence that another worker can pick up."
                        example="The outcome below is recorded by the worker. Ticket completion is a separate action with its own requirements."
                      />
                      <Badge>{detail.value.attempt.state}</Badge>
                      <p>
                        Run{" "}
                        <Button onClick={() => open("run", selectedAttempt!.run_id)}>
                          {detail.value.attempt.run_id}
                        </Button>{" "}
                        · ticket {detail.value.attempt.ticket_id} · claim token{" "}
                        {detail.value.attempt.token}
                      </p>
                      <p>{detail.value.attempt.evidence || "No completion evidence recorded."}</p>
                      <h3 className="pt-form-heading">
                        <Icon name="resources" /> Saved checkpoints
                      </h3>
                      {detail.value.attempt.checkpoints.length === 0 && (
                        <p className="pt-empty-inline">
                          No checkpoints saved for this attempt yet.
                        </p>
                      )}
                      <ul>
                        {detail.value.attempt.checkpoints.map((item, index) => (
                          <li key={index}>
                            {item.kind === "resource"
                              ? `Resource ${item.resource_id} content version ${item.revision}`
                              : `Ticket ${item.ticket_id} handoff revision ${item.revision}`}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              </Dialog>
            )}
            <div className="pt-list-panel">
              <Panel
                title={PANELS.find((panel) => panel.value === state.panel)?.label ?? "Participants"}
              >
                {state.page.kind === "failed" &&
                state.page.previous === undefined &&
                state.page.failure.kind === "remote" &&
                state.page.failure.problem.kind === "Not_found" &&
                (state.panel === "budget" || state.panel === "heartbeat") ? (
                  <div className="pt-empty">
                    <Icon name={PANEL_GUIDES[state.panel].icon} />
                    <h3>No saved record for this view</h3>
                    <p>
                      Check the selected run. Run limits and heartbeat observations appear only
                      after someone records them.
                    </p>
                    <p className="wg-hint">{state.page.failure.problem.message}</p>
                    <Button onClick={() => setFiltersOpen(true)}>Choose a run</Button>
                    <Button requiresActor onClick={() => setActionsOpen(true)}>
                      Record a change
                    </Button>
                  </div>
                ) : (
                  <ReadStatus state={state.page} />
                )}
                {rows}
                {page && (
                  <>
                    {page.completeness !== "complete" && (
                      <p role="status">
                        {page.stopReason ?? "More records are available at this capture."}
                      </p>
                    )}
                    {(page.retry !== null || page.continuation !== null) && (
                      <Toolbar label="Captured page continuation">
                        {page.retry !== null && (
                          <Button
                            disabled={state.page.kind === "loading"}
                            onClick={() => controller.continuePage("retry")}
                          >
                            Retry captured page with a larger byte budget
                          </Button>
                        )}
                        {page.continuation !== null && (
                          <Button
                            disabled={state.page.kind === "loading"}
                            onClick={() => controller.continuePage("next")}
                          >
                            Next captured page
                          </Button>
                        )}
                      </Toolbar>
                    )}
                  </>
                )}
              </Panel>
            </div>
            <aside className="pt-observation-note">
              <Icon name="participants" />
              <div>
                <strong>Workgraph records coordination</strong>
                <p>
                  Your harness owns agent processes and checkouts. Recorded state and observations
                  do not prove whether a process is currently running or stopped.
                </p>
              </div>
            </aside>
            {actionsOpen && (
              <Dialog
                wide
                title="Record a participant change"
                onClose={() => setActionsOpen(false)}
              >
                <div className="pt-action-picker">
                  <p className="pt-dialog-intro">
                    Choose what you want to record. Each action opens a form, then a review before
                    anything is applied. Workgraph records coordination; your agent or runner
                    performs the actual work.
                  </p>
                  {(
                    [
                      ["People", "actor."],
                      ["Runs and observations", "run."],
                      ["Ticket attempts", "attempt."],
                    ] as const
                  ).map(([label, prefix]) => (
                    <section className="pt-action-group" key={prefix}>
                      <h3>
                        <Icon
                          name={
                            prefix === "actor."
                              ? "participants"
                              : prefix === "run."
                                ? "activity"
                                : "work"
                          }
                        />
                        {label}
                      </h3>
                      <div className="pt-action-grid">
                        {ACTIONS.filter((item) => item.method.startsWith(prefix)).map((item) => (
                          <Button
                            requiresActor
                            key={item.method}
                            disabled={state.historicalGeneration}
                            onClick={() => {
                              controller.open(context, item.method);
                              setActionsOpen(false);
                            }}
                          >
                            <span>
                              <strong>{item.label}</strong>
                              <small>{item.hint}</small>
                            </span>
                            <Icon name="chevron" />
                          </Button>
                        ))}
                      </div>
                    </section>
                  ))}
                  {state.drafts.length > 0 && (
                    <Toolbar label="Retained participant drafts">
                      {state.drafts.map((item) => (
                        <Button
                          key={item.id}
                          onClick={() => {
                            controller.chooseDraft(item.id);
                            setActionsOpen(false);
                          }}
                          aria-pressed={draft?.id === item.id}
                        >
                          {ACTIONS.find((action) => action.method === item.input.method)?.label} ·{" "}
                          {item.phase.kind}
                        </Button>
                      ))}
                    </Toolbar>
                  )}
                </div>
              </Dialog>
            )}
            {draft && (
              <Dialog
                wide
                title={
                  ACTIONS.find((item) => item.method === draft.input.method)?.label ??
                  "Participant change"
                }
                onClose={() => controller.chooseDraft(null)}
              >
                <ReferenceFields
                  context={context}
                  endpoint={{
                    connectionId: draft.capture.target.connection.id,
                    generation: draft.capture.target.connection.generation,
                    workspaceId: draft.capture.target.workspaceId,
                  }}
                >
                  <section className="pt-editor" aria-label="Participant change draft">
                    <WriterContext
                      actor={draft.capture.writer.actorId}
                      run={draft.capture.writer.runId}
                      workspace={draft.capture.target.workspaceId}
                    />
                    <FormSection
                      title={
                        ACTIONS.find((item) => item.method === draft.input.method)?.label ??
                        "Participant change"
                      }
                      description={
                        ACTIONS.find((item) => item.method === draft.input.method)?.hint ??
                        "Review before applying."
                      }
                      icon={
                        draft.input.method.startsWith("actor")
                          ? "participants"
                          : draft.input.method.startsWith("attempt")
                            ? "work"
                            : "activity"
                      }
                    >
                      <DraftFields draft={draft} controller={controller} />
                    </FormSection>
                    <p className="pt-editor-help">
                      Review checks the current record and prepares your change. Apply saves it.
                      Closing this window keeps the draft under Record a change; Discard removes an
                      unsent draft.
                    </p>
                    {draft.issue && <p role="alert">{draft.issue}</p>}
                    {draft.unexpected !== null && <Unexpected error={draft.unexpected.error} />}
                    <Toolbar label="Review participant change">
                      <Button
                        tone="primary"
                        disabled={draft.phase.kind !== "editing"}
                        onClick={() => void controller.review(draft.id)}
                      >
                        {draft.phase.kind === "capturing" ? "Capturing guards…" : "Review change"}
                      </Button>
                      <Button
                        disabled={draft.phase.kind !== "editing"}
                        onClick={() => controller.discard(draft.id)}
                      >
                        Discard unsent draft
                      </Button>
                    </Toolbar>
                    {draft.phase.kind === "registered" && (
                      <OperationPanel
                        applyLabel="Apply change"
                        intention={draft.id}
                        operations={operations}
                        processing={context.client.processing}
                      />
                    )}
                  </section>
                </ReferenceFields>
              </Dialog>
            )}
          </div>
        </section>
      </ReferenceFields>
    </ManagementPresentation.Provider>
  );
}
function Unexpected({ error }: { readonly error: unknown }): never {
  throw error;
}
