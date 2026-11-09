import { identifier } from "../runs/model";
import "../../../components/section-navigation.css";
import { ParticipantGuide, WriterContext } from "../presentation";
import { ACTION_GUIDES, COORDINATION_GUIDES, TAB_ICONS } from "../guides";
import { ReferenceFields, ReferenceField } from "../../discussions/ReferenceFields";
import { FormSection } from "../../discussions/FormSection";
import { CapturedValues } from "../../connections/CapturedValues";
import { ManagementPresentation } from "../../connections/management-presentation";
import { Dialog } from "../../../components/Dialog";
import { ActorAvatar } from "../../../components/ActorAvatar";
import { recordIdentity } from "./record-identity";
import { LISTS as coordinationLists } from "./client";
import { Icon } from "../../../components/Icon";
import { clearHistoryTarget } from "../../../app/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Badge, Button, Field, Panel, Toolbar } from "../../../components/Primitives";
import { OperationPanel } from "../../connections/shared";
import { failureText } from "../../connections/failure";
import { FormFields, TargetFields } from "./FormFields";
import { poolCodec, policyCodec, reservationCodec } from "./codecs";
import { conditionRecord, pathPolicyCodec } from "./prepare";
import { blankPin } from "./form-inputs";
import { counter, CoordinationInputError } from "./model";
import { decodeAudit, proofLabel, reservationLabel } from "./records";
import type { CoordinationList } from "./client";
import type {
  CoordinationDraft,
  CoordinationFeatureProps,
  CoordinationInput,
  CoordinationPage,
  CoordinationTab,
  HolderFence,
  ParticipantsWorkspaceProps,
  ProofPin,
  ProofPinInput,
  ReservationTarget,
  ReservationTargetInput,
  WaitJob,
} from "./types";
import "./coordination.css";

const TABS: readonly [CoordinationTab, string][] = [
  ["records", "People and runs"],
  ["allocation", "Allocation rules"],
  ["reservations", "Reservations"],
  ["conditions", "Outside conditions"],
  ["recovery", "Recovery records"],
];
const DESCRIPTIONS: Readonly<Record<CoordinationTab, string>> = {
  records: "People, recorded invocations and their work.",
  allocation:
    "Define who can take a ticket, how many tickets can use a shared pool at once, and which paths a task needs.",
  reservations:
    "See which runs hold shared resources or logical paths, and manage those exact holds.",
  conditions:
    "Connect a ticket to outside work and record verified evidence when its requirement is met.",
  recovery:
    "Inspect past recoveries, or review an abandoned claim after confirming its owner stopped or was isolated.",
};
function recordKey(
  page: CoordinationPage,
  row: import("../../../core/json").JsonValue,
  index: number,
): string {
  const method = coordinationLists.find((value) => value === page.invocation.method);
  const identity = method === undefined ? null : recordIdentity(method, row);
  return JSON.stringify([
    page.scope.connection.id,
    page.scope.connection.generation,
    page.scope.workspaceId,
    method,
    identity === null ? ["invalid", index] : ["record", identity],
  ]);
}
const LISTS: Partial<Record<CoordinationTab, readonly [CoordinationList, string][]>> = {
  allocation: [
    ["allocation.pools", "Pools"],
    ["allocation.ticket_policies", "Ticket policies"],
    ["ticket.paths.list", "Path declarations"],
  ],
  reservations: [
    ["reservation.list", "Named resources"],
    ["reservation.path.list", "Logical paths"],
  ],
  conditions: [["condition.list", "Conditions"]],
  recovery: [
    ["recovery.list", "Reservation recoveries"],
    ["ticket.recovery.list", "Ticket recoveries"],
  ],
};
const ACTIONS: Partial<Record<CoordinationTab, readonly [string, string][]>> = {
  allocation: [
    ["pool", "Configure a pool"],
    ["policy", "Configure ticket eligibility"],
    ["paths", "Declare ticket paths"],
  ],
  reservations: [
    ["acquire", "Acquire reservations"],
    ["waiter", "Record advisory waiting"],
  ],
  conditions: [["condition", "Declare an outside condition"]],
};
const title = (input: CoordinationInput) =>
  ({
    pool: "Configure pool",
    policy: "Ticket eligibility",
    paths: "Ticket path declarations",
    acquire: "Acquire reservations",
    renew: "Renew captured lease",
    release: "Release captured hold",
    waiter: "Advisory waiter",
    "holder-note": "Advisory holder note",
    condition: "Outside condition",
    signal: "Record verified signal",
    recover: "Recover captured ownership",
  })[input.kind];
const targetLabel = reservationLabel;
const targetInput = (target: ReservationTarget): ReservationTargetInput =>
  target.kind === "named"
    ? { kind: "named", reservationId: target.reservation_id }
    : {
        kind: "path",
        target: {
          worktreeId: target.target.worktree_id,
          kind: target.target.kind,
          path: target.target.path,
        },
      };
function initial(kind: string, run: string | null): CoordinationInput {
  switch (kind) {
    case "pool":
      return { kind, name: "", limit: "1" };
    case "policy":
      return { kind, ticketId: "", capabilities: [], pools: [], actors: { kind: "unrestricted" } };
    case "paths":
      return { kind, ticketId: "", requireReservations: false, paths: [] };
    case "acquire":
      return {
        kind,
        targetRunId: run ?? "",
        acquisition: {
          kind: "named",
          requests: [{ reservationId: "", mode: "exclusive", durationMs: "" }],
        },
      };
    case "waiter":
      return {
        kind,
        target: { kind: "named", reservationId: "" },
        targetRunId: run ?? "",
        action: { kind: "begin", durationMs: "30000", note: "" },
      };
    case "condition":
      return {
        kind,
        conditionId: `condition-${crypto.randomUUID()}`,
        ticketId: "",
        operationId: "",
        artifact: blankPin(),
        required: true,
        label: "",
        recipients: [],
      };
    default:
      throw new Error("Unknown coordination form.");
  }
}
export function ParticipantsWorkspace(props: ParticipantsWorkspaceProps) {
  const { controller, context, records } = props,
    state = useSyncExternalStore(controller.subscribe, controller.get);
  const tab =
    context.route.section?.view === "participants" ? context.route.section.value : "records";
  useEffect(() => {
    controller.select(context);
    if (controller.get().tab !== tab) controller.tab(tab);
  }, [controller, context, tab]);
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
        <div className="wg-coordination">
          <header className="pt-topbar wg-section-navigation">
            <h1>
              <Icon name="participants" />
              Participants
            </h1>
            <Toolbar label="Participants workspace">
              {TABS.map(([tab, label]) => (
                <Button
                  key={tab}
                  aria-pressed={state.tab === tab}
                  onClick={() =>
                    context.navigate({
                      ...clearHistoryTarget(context.route),
                      entityId: null,
                      section: { view: "participants", value: tab },
                    })
                  }
                >
                  <Icon name={TAB_ICONS[tab]} />
                  {label}
                </Button>
              ))}
            </Toolbar>
          </header>
          {state.tab === "records" ? (
            records
          ) : (
            <div className="pt-coordination-scroll">
              <CoordinationFeature {...props} />
            </div>
          )}
        </div>
      </ReferenceFields>
    </ManagementPresentation.Provider>
  );
}
export function CoordinationFeature({ context, controller, operations }: CoordinationFeatureProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.get),
    [contentionTarget, setContentionTarget] = useState<ReservationTargetInput>({
      kind: "named",
      reservationId: "",
    }),
    [recoveryTicket, setRecoveryTicket] = useState("");
  if (state.unexpected !== null) throw state.unexpected.error;
  const selected = state.drafts.find((draft) => draft.id === state.selectedDraftId),
    page =
      state.page.kind === "ready"
        ? state.page.value
        : state.page.kind === "idle"
          ? undefined
          : state.page.previous;
  const contention =
    state.contention.kind === "ready"
      ? state.contention.value
      : state.contention.kind === "idle"
        ? undefined
        : state.contention.previous;
  const open = (input: CoordinationInput) => controller.open(context, input);
  return (
    <div className="wg-coord-layout">
      <div className="wg-coord-primary">
        <header className="co-heading">
          <div>
            <span className="co-eyebrow">Workspace coordination</span>
            <h2>{TABS.find(([id]) => id === state.tab)?.[1] ?? "Coordination"}</h2>
            <p>{DESCRIPTIONS[state.tab]}</p>
          </div>
          <Button tone="quiet" onClick={() => controller.refresh()}>
            <Icon name="refresh" />
            Refresh records
          </Button>
        </header>
        {state.scope !== null && (
          <p className="co-scope">
            Workspace-wide · {state.scope.workspaceId}
            {state.scope.projectId !== null
              ? " · Project selection does not filter these records"
              : ""}
          </p>
        )}
        {state.tab !== "records" && (
          <ParticipantGuide
            icon={TAB_ICONS[state.tab]}
            title={COORDINATION_GUIDES[state.tab][0]}
            description={COORDINATION_GUIDES[state.tab][1]}
            example={COORDINATION_GUIDES[state.tab][2]}
          />
        )}
        <div className="co-catalog-panel">
          <Panel title="Coordination records">
            {state.issue !== null && <p role="alert">{state.issue}</p>}
            {state.scope === null ? (
              <Button
                onClick={() => {
                  const route = { ...context.route };
                  delete route.participant;
                  context.navigate({ ...route, entityId: null });
                }}
              >
                Open Coordination at current endpoint
              </Button>
            ) : (
              <>
                <Toolbar label="Record view">
                  {LISTS[state.tab]?.map(([method, label]) => (
                    <Button
                      key={method}
                      tone="quiet"
                      aria-pressed={page?.invocation.method === method}
                      onClick={() => controller.browse(method)}
                    >
                      <Icon
                        name={
                          method.includes("pool")
                            ? "participants"
                            : method.includes("path")
                              ? "resources"
                              : method.includes("recovery")
                                ? "history"
                                : "work"
                        }
                      />
                      {label}
                    </Button>
                  ))}
                </Toolbar>
                {page?.invocation.method === "condition.signals" && (
                  <div className="pt-signal-heading">
                    <div>
                      <h3>
                        <Icon name="check" /> Recorded condition signals
                      </h3>
                      <p>
                        Each signal records a verified result for an exact declaration. Return to
                        conditions to inspect or edit the requirement.
                      </p>
                    </div>
                    <Button onClick={() => controller.browse("condition.list")}>
                      Back to conditions
                    </Button>
                  </div>
                )}
                <Toolbar label="New coordination action">
                  {ACTIONS[state.tab]?.map(([kind, label]) => (
                    <Button
                      requiresActor
                      key={kind}
                      onClick={() => open(initial(kind, context.writer.runId))}
                    >
                      <Icon name="plus" />
                      {label}
                    </Button>
                  ))}
                </Toolbar>
                {state.tab === "recovery" && (
                  <FormSection
                    title="Inspect an abandoned ticket"
                    description="Choose a ticket to read its actual claim before deciding whether to recover it. Inspection changes nothing."
                    icon="search"
                    tone="amber"
                  >
                    <ReferenceField
                      kind="ticket"
                      label="Claimed ticket ID to inspect for recovery"
                      value={recoveryTicket}
                      onChange={setRecoveryTicket}
                    />
                    <Button
                      requiresActor
                      onClick={() => {
                        void controller.openTicketRecovery(context, recoveryTicket);
                      }}
                    >
                      Inspect actual ticket claim
                    </Button>
                    <p className="wg-hint">
                      Capture the old actor, optional run, token and lease revision first. Recovery
                      needs actual outside confirmation that the owner stopped or was isolated.
                    </p>
                  </FormSection>
                )}
                {state.page.kind === "loading" && page === undefined && (
                  <p role="status">Reading captured records…</p>
                )}
                {state.page.kind === "failed" && (
                  <p role="alert">{failureText(state.page.failure)}</p>
                )}
                {state.page.kind === "unexpected_error" && <Throw error={state.page.error} />}
                {page !== undefined && (
                  <>
                    <div className="co-capture-heading">
                      <span>{page.items.length} on this page</span>
                      <span>
                        {page.completeness === "complete"
                          ? "Complete capture"
                          : page.completeness === "more"
                            ? "More pages available"
                            : "Partial capture"}{" "}
                        · revision {page.revision}
                      </span>
                    </div>
                    {page.warning !== null && <p role="alert">{page.warning}</p>}
                    {page.items.length === 0 ? (
                      <div className="co-empty">
                        <Icon name="workflow" />
                        <h3>No records in this capture</h3>
                        <p>
                          {page.completeness === "complete"
                            ? state.tab === "recovery"
                              ? "No recoveries are recorded on this page. Recovery is only needed when ownership must be removed after outside confirmation."
                              : state.tab === "conditions"
                                ? "Declare a condition when a ticket depends on an outside result, such as an approval or deployment."
                                : state.tab === "reservations"
                                  ? "No matching reservation records on this page. Acquire a reservation when a run needs coordinated access to a shared resource."
                                  : "Configure a pool, ticket eligibility or path declarations when your workflow needs allocation rules."
                            : "This capture is incomplete. Continue reading before concluding that no records exist."}
                        </p>
                      </div>
                    ) : (
                      <div className="co-record-grid" data-method={page.invocation.method}>
                        {page.items.map((row, index) => (
                          <RecordRow
                            key={recordKey(page, row, index)}
                            page={page}
                            row={row}
                            index={index}
                            props={{ context, controller, operations }}
                          />
                        ))}
                      </div>
                    )}
                    {page.continuation !== null && (
                      <Button
                        disabled={state.page.kind === "loading"}
                        onClick={() => controller.next()}
                      >
                        Next captured page
                      </Button>
                    )}
                  </>
                )}
              </>
            )}
          </Panel>
        </div>
        {state.tab === "reservations" && state.scope !== null && (
          <details className="co-utility">
            <summary>
              <Icon name="participants" />
              Inspect holders and waiting runs
            </summary>
            <Panel title="Who holds or reports waiting?">
              <TargetFields value={contentionTarget} onChange={setContentionTarget} />
              <Button onClick={() => controller.inspectContention(contentionTarget)}>
                Inspect contention
              </Button>
              <p className="wg-hint">
                Actual holders and advisory waiters are distinct. No FIFO queue, automatic grant or
                inference that expiry frees ownership.
              </p>
              {state.contention.kind === "loading" && contention === undefined && (
                <p role="status">Reading captured contention…</p>
              )}
              {state.contention.kind === "failed" && (
                <p role="alert">{failureText(state.contention.failure)}</p>
              )}
              {state.contention.kind === "unexpected_error" && (
                <Throw error={state.contention.error} />
              )}
              {contention !== undefined && (
                <>
                  <p className="wg-hint">
                    Workspace revision {contention.revision} · observed{" "}
                    {friendlyTime(contention.observedUnixMs)}
                  </p>
                  {contention.warning !== null && <p role="alert">{contention.warning}</p>}
                  {contention.items.map((row) => (
                    <article
                      className="wg-coord-record"
                      key={JSON.stringify(
                        row.kind === "holder"
                          ? [
                              row.kind,
                              row.target,
                              row.holder.actor_id,
                              row.holder.run_id,
                              row.holder.token,
                            ]
                          : [row.kind, row.record.target, row.record.actor_id, row.record.run_id],
                      )}
                    >
                      {row.kind === "holder" ? (
                        <>
                          <strong>
                            <ActorAvatar actor={row.holder.actor_id} /> Actual holder:{" "}
                            {row.holder.actor_id} / {row.holder.run_id}
                          </strong>
                          <p>
                            {targetLabel(row.target)} · token {row.holder.token} · {row.holder.mode}
                          </p>
                          {row.note?.contents !== null && row.note?.contents !== undefined ? (
                            <p>
                              Advisory note: {row.note.contents.note}
                              {row.note.contents.expected_release_unix_ms !== null
                                ? ` · expected release Unix ms ${row.note.contents.expected_release_unix_ms}`
                                : ""}
                            </p>
                          ) : (
                            <p>
                              No active note is visible. An expired/cleared stored note may still
                              have a revision.
                            </p>
                          )}
                        </>
                      ) : (
                        <>
                          <strong>
                            <ActorAvatar actor={row.record.actor_id} /> Advisory waiter:{" "}
                            {row.record.actor_id} / {row.record.run_id}
                          </strong>
                          <p>
                            {targetLabel(row.record.target)} · {row.phase} · revision{" "}
                            {row.record.revision}
                          </p>
                          <p>{row.record.note}</p>
                          {row.clock_regressed && (
                            <p role="alert">
                              The observed clock regressed; elapsed time is unavailable.
                            </p>
                          )}
                          <Button
                            requiresActor
                            onClick={() =>
                              open({
                                kind: "waiter",
                                target: targetInput(row.record.target),
                                targetRunId: row.record.run_id,
                                action: {
                                  kind: "refresh",
                                  durationMs: "30000",
                                  note: row.record.note,
                                },
                              })
                            }
                          >
                            Review waiter update
                          </Button>
                        </>
                      )}
                    </article>
                  ))}
                  {contention.continuation !== null && (
                    <Button onClick={() => controller.nextContention()}>
                      Next contention page
                    </Button>
                  )}
                </>
              )}
            </Panel>
          </details>
        )}
        {state.tab === "reservations" && (
          <details className="co-utility">
            <summary>
              <Icon name="history" />
              Saved bounded waits <span>{state.waits.length} inspected this launch</span>
            </summary>
            <Panel title="Saved bounded waits">
              <p className="wg-hint">
                Saved by this companion, separately from ordinary operations. Restoring a wait never
                restarts it. Only explicit Start or Retry exact can send.
              </p>
              <Toolbar label="Saved wait pages">
                <Button disabled={state.waitsLoading} onClick={() => controller.refreshWaits()}>
                  Refresh saved waits
                </Button>
                <Button
                  disabled={state.waitsLoading || state.waitPage?.nextOffset == null}
                  onClick={() => controller.nextWaits()}
                >
                  Next saved wait
                </Button>
              </Toolbar>
              {state.waitsLoading && <p role="status">Loading one saved wait…</p>}
              {state.waitPage !== null && (
                <p className="wg-hint">
                  At last read: page offset {state.waitPage.offset}, {state.waitPage.remaining}{" "}
                  remaining. {state.waits.length} distinct jobs inspected this launch. Pages are
                  live observations, not a complete immutable catalog.
                </p>
              )}
              {state.waitPage !== null && state.waits.length === 0 && (
                <p>No saved job on the requested page.</p>
              )}
              {state.waits.map((job) => (
                <WaitCard key={job.id} job={job} props={{ context, controller, operations }} />
              ))}
            </Panel>
          </details>
        )}
      </div>
      {state.drafts.length > 0 && (
        <details className="co-utility co-drafts">
          <summary>
            <Icon name="resources" />
            Retained action drafts <span>{state.drafts.length}</span>
          </summary>
          <Toolbar label="Saved local forms">
            {state.drafts.map((draft) => (
              <Button key={draft.id} onClick={() => controller.chooseDraft(draft.id)}>
                {title(draft.input)} · {draft.phase.kind.replaceAll("_", " ")}
              </Button>
            ))}
          </Toolbar>
        </details>
      )}
      {selected !== undefined && (
        <Dialog wide title={title(selected.input)} onClose={() => controller.chooseDraft(null)}>
          <ReferenceFields
            context={context}
            endpoint={{
              connectionId: selected.scope.connection.id,
              generation: selected.scope.connection.generation,
              workspaceId: selected.scope.workspaceId,
            }}
          >
            <aside className="wg-coord-editor pt-editor" aria-label="Retained coordination forms">
              <DraftForm
                key={selected.id}
                draft={selected}
                props={{ context, controller, operations }}
              />
            </aside>
          </ReferenceFields>
        </Dialog>
      )}
    </div>
  );
}
function Throw({ error }: { readonly error: unknown }): never {
  throw error;
}
function DraftForm({
  draft,
  props,
}: {
  readonly draft: CoordinationDraft;
  readonly props: CoordinationFeatureProps;
}) {
  const [limitIssue, setLimitIssue] = useState<string | null>(null);
  const [waitLimits, setWaitLimits] = useState({
      timeoutMs: "30000",
      maxAttempts: "32",
      waitSliceMs: "1000",
    }),
    { context, controller, operations } = props;
  if (draft.unexpected !== null) throw draft.unexpected.error;
  return (
    <>
      <WriterContext
        actor={draft.writer.actor_id}
        run={draft.writer.run_id}
        workspace={draft.scope.workspaceId}
      />
      <ParticipantGuide
        icon={draft.input.kind === "recover" ? "history" : "settings"}
        title={ACTION_GUIDES[draft.input.kind][0]}
        description={ACTION_GUIDES[draft.input.kind][1]}
        example="Review prepares the exact change. Apply saves it. Closing keeps the draft under Retained action drafts; Discard removes an unsent draft."
      />
      {draft.issue !== null && <p role="alert">{draft.issue}</p>}
      {draft.phase.kind === "editing" ? (
        <>
          <div className="pt-coordination-fields">
            <FormFields
              input={draft.input}
              onChange={(input) => controller.edit(draft.id, input)}
            />
          </div>
          <Toolbar label="Review coordination action">
            <Button
              tone="primary"
              onClick={() => {
                void controller.review(draft.id);
              }}
            >
              Review change
            </Button>
            <Button onClick={() => controller.discard(draft.id)}>Discard unsent draft</Button>
          </Toolbar>
          {draft.input.kind === "acquire" && (
            <details className="pt-disclosure">
              <summary>Optional: wait briefly for a reservation</summary>
              <p>
                This separate helper waits after definite contention, keeping guards unchanged. It
                does not renew, recover, release or guarantee fairness. Once saved here, this draft
                cannot switch to ordinary execution.
              </p>
              <Field
                label="Total wait deadline (ms)"
                value={waitLimits.timeoutMs}
                onChange={(event) =>
                  setWaitLimits({ ...waitLimits, timeoutMs: event.currentTarget.value })
                }
              />
              <Field
                label="Maximum acquisition attempts"
                value={waitLimits.maxAttempts}
                onChange={(event) =>
                  setWaitLimits({ ...waitLimits, maxAttempts: event.currentTarget.value })
                }
              />
              <Field
                label="Feed wait slice (ms)"
                value={waitLimits.waitSliceMs}
                onChange={(event) =>
                  setWaitLimits({ ...waitLimits, waitSliceMs: event.currentTarget.value })
                }
              />
              <Button
                onClick={() => {
                  try {
                    setLimitIssue(null);
                    void controller.prepareWait(draft.id, {
                      timeoutMs: counter(waitLimits.timeoutMs, 300000n, 1000n),
                      maxAttempts: counter(waitLimits.maxAttempts, 100n, 1n),
                      waitSliceMs: counter(waitLimits.waitSliceMs, 25000n, 1n),
                    });
                  } catch (error) {
                    if (!(error instanceof CoordinationInputError)) throw error;
                    setLimitIssue(error.message);
                  }
                }}
              >
                Review bounded wait
              </Button>
              {limitIssue !== null && <p role="alert">{limitIssue}</p>}
            </details>
          )}
        </>
      ) : draft.phase.kind === "registered" ? (
        <OperationPanel
          applyLabel="Apply change"
          operations={operations}
          intention={draft.id}
          processing={context.client.processing}
        />
      ) : draft.phase.kind === "capturing" ? (
        <p role="status">Capturing exact guards and preparing the action…</p>
      ) : (
        <>
          <p>
            Bounded-wait path retained: {draft.phase.jobId}. This draft cannot switch to an ordinary
            operation.
          </p>
          <Button
            onClick={() => {
              void controller.actWait(draft.id, "inspect");
            }}
          >
            Inspect saved wait
          </Button>
          <Button
            onClick={() => {
              if (draft.phase.kind === "wait_prepared")
                void controller.prepareWait(draft.id, draft.phase.limits);
            }}
          >
            Recheck exact wait preparation
          </Button>
          <p className="wg-hint">
            If a preparation reply was lost, recheck the same complete plan. This does not start or
            retry acquisition.
          </p>
        </>
      )}
    </>
  );
}
function RecordRow({
  page,
  row,
  index,
  props,
}: {
  readonly page: CoordinationPage;
  readonly row: import("../../../core/protocol/types").JsonObject;
  readonly index: number;
  readonly props: CoordinationFeatureProps;
}) {
  const { context, controller } = props,
    method = page.invocation.method,
    open = (input: CoordinationInput) => controller.open(context, input);
  let body: React.ReactNode;
  if (method === "allocation.pools") {
    const decoded = poolCodec.decode(row);
    if (!decoded.ok)
      return (
        <p role="alert">This pool record could not be read. Refresh the view before editing it.</p>
      );
    const v = decoded.value;
    body = (
      <>
        <h3>
          <Icon name="participants" />
          {v.name}
        </h3>
        <p>
          {v.limit} concurrent slots · revision {v.revision}
        </p>
        <Button requiresActor onClick={() => open({ kind: "pool", name: v.name, limit: v.limit })}>
          Edit pool
        </Button>
      </>
    );
  } else if (method === "allocation.ticket_policies") {
    const decoded = policyCodec.decode(row);
    if (!decoded.ok) return <p role="alert">Malformed ticket policy.</p>;
    const v = decoded.value;
    body = (
      <>
        <h3>
          <Icon name="work" />
          Ticket {v.ticket_id}
        </h3>
        <p>
          Capabilities: {v.required_capabilities.join(", ") || "none"} · pools:{" "}
          {v.pools.join(", ") || "none"}
        </p>
        <div className="pt-actor-pills">
          {v.allowed_actor_ids === null ? (
            <span className="pt-tag">Any eligible actor</span>
          ) : (
            v.allowed_actor_ids.map((actor) => (
              <span key={actor}>
                <ActorAvatar actor={actor} />
                {actor}
              </span>
            ))
          )}
        </div>
        <p className="wg-hint">Policy revision {v.revision}</p>
        <Button
          requiresActor
          onClick={() =>
            open({
              kind: "policy",
              ticketId: v.ticket_id,
              capabilities: v.required_capabilities,
              pools: v.pools,
              actors:
                v.allowed_actor_ids === null
                  ? { kind: "unrestricted" }
                  : { kind: "allow", ids: v.allowed_actor_ids },
            })
          }
        >
          Edit eligibility
        </Button>
      </>
    );
  } else if (method === "ticket.paths.list") {
    const decoded = pathPolicyCodec.decode(row);
    if (!decoded.ok) return <p role="alert">Malformed path declaration.</p>;
    const v = decoded.value;
    body = (
      <>
        <h3>
          <Icon name="work" />
          Ticket {v.ticket_id}
        </h3>
        <p>
          {v.paths.length} logical paths · matching reservations{" "}
          {v.require_reservations ? "required" : "optional"} · revision {v.revision}
        </p>
        <ul className="pt-path-list">
          {v.paths.map((path, i) => (
            <li key={i}>
              <Icon name="resources" />
              <strong>{path.target.path}</strong>
              <span>
                {path.target.worktree_id} · {path.target.kind} · {path.mode}
              </span>
            </li>
          ))}
        </ul>
        <Button
          requiresActor
          onClick={() =>
            open({
              kind: "paths",
              ticketId: v.ticket_id,
              requireReservations: v.require_reservations,
              paths: v.paths.map((item) => ({
                mode: item.mode,
                target: {
                  worktreeId: item.target.worktree_id,
                  kind: item.target.kind,
                  path: item.target.path,
                },
              })),
            })
          }
        >
          Edit path declarations
        </Button>
      </>
    );
  } else if (method === "reservation.list" || method === "reservation.path.list") {
    const decoded = reservationCodec(method === "reservation.list" ? "named" : "path").decode(row);
    if (!decoded.ok) return <p role="alert">Malformed reservation record.</p>;
    const v = decoded.value;
    body = (
      <>
        <h3>
          <Icon name="workflow" />
          {targetLabel(v.target)}
        </h3>
        <p>
          Epoch {v.epoch} ·{" "}
          {v.holders.length === 0
            ? "No current holders in this capture"
            : `${v.holders.length} actual holder(s)`}
        </p>
        {v.holders.map((holder) => {
          const fence: HolderFence = Object.freeze({
            reservation: Object.freeze({
              scope: page.scope,
              value: v,
              response: page.response,
              namespace: page.namespace,
              revision: page.revision,
            }),
            holder,
          });
          return (
            <div key={holder.run_id} className="wg-coord-holder">
              <p>
                <span className="co-holder-identity">
                  <ActorAvatar actor={holder.actor_id} />
                  <strong>
                    {holder.actor_id} / {holder.run_id}
                  </strong>
                </span>{" "}
                · {holder.mode} · token {holder.token} · lease revision {holder.lease.revision}
              </p>
              <p>
                {holder.lease.kind === "indefinite"
                  ? "Indefinite ownership"
                  : `Timed lease ${holder.lease.durationMs}ms; recorded deadline ${friendlyTime(holder.lease.deadlineUnixMs)}`}
                . Expiry does not release this hold.
              </p>
              {holder.origin.kind === "automatic" && (
                <p>
                  Automatic claim borrowers:{" "}
                  {holder.origin.claims
                    .map((claim) => `${claim.ticket_id} / token ${claim.token}`)
                    .join(", ")}
                </p>
              )}
              <Toolbar label={`Actions for ${holder.run_id}`}>
                <Button
                  requiresActor
                  disabled={holder.lease.kind === "indefinite"}
                  onClick={() => open({ kind: "renew", fence })}
                >
                  Renew lease
                </Button>
                <Button
                  requiresActor
                  disabled={holder.origin.kind === "automatic"}
                  onClick={() => open({ kind: "release", fence })}
                >
                  Release hold
                </Button>
                <Button
                  requiresActor
                  onClick={() =>
                    open({
                      kind: "holder-note",
                      fence,
                      expectedRevision: "",
                      action: {
                        kind: "set",
                        durationMs: "30000",
                        note: "",
                        expectedReleaseUnixMs: "",
                      },
                    })
                  }
                >
                  Set advisory note
                </Button>
                <Button
                  requiresActor
                  onClick={() =>
                    open({
                      kind: "recover",
                      recovery: {
                        kind: "reservation",
                        fence,
                        recoveryId: `recovery-${crypto.randomUUID()}`,
                        confirmation: "",
                        reason: "",
                        evidence: [],
                      },
                    })
                  }
                >
                  Review guarded recovery
                </Button>
              </Toolbar>
            </div>
          );
        })}
      </>
    );
  } else if (method === "condition.list") {
    const decoded = conditionRecord.decode(row);
    if (!decoded.ok) return <p role="alert">Malformed condition record.</p>;
    const v = decoded.value,
      declaration = v.declaration;
    body = (
      <>
        <h3>
          <Icon name="milestone" />
          {declaration.label}
        </h3>
        <p>
          Ticket {declaration.ticket_id} · condition {declaration.condition_id} · declaration
          revision {declaration.revision} · {declaration.required ? "required" : "optional"}
        </p>
        <Badge tone={v.satisfied ? "accent" : "warning"}>
          {v.satisfied ? "Matching verified signal recorded" : "Awaiting matching signal"}
        </Badge>
        <p>Outside operation {declaration.operation_id}</p>
        <details>
          <summary>Exact artifact binding</summary>
          <p>{proofLabel(declaration.artifact)}</p>
        </details>
        <Toolbar label="Condition actions">
          <Button
            requiresActor
            onClick={() =>
              open({
                kind: "condition",
                conditionId: declaration.condition_id,
                ticketId: declaration.ticket_id,
                operationId: declaration.operation_id,
                artifact: pinInput(declaration.artifact),
                required: declaration.required,
                label: declaration.label,
                recipients: declaration.recipients,
              })
            }
          >
            Edit declaration
          </Button>
          <Button
            requiresActor
            onClick={() =>
              open({
                kind: "signal",
                declaration: Object.freeze({
                  scope: page.scope,
                  value: declaration,
                  response: page.response,
                  namespace: page.namespace,
                  revision: page.revision,
                }),
                signalId: `signal-${crypto.randomUUID()}`,
                evidence: [],
                summary: "",
              })
            }
          >
            Record verified signal
          </Button>
          <Button onClick={() => controller.browse("condition.signals", declaration.condition_id)}>
            View recorded signals
          </Button>
        </Toolbar>
      </>
    );
  } else {
    const audit = decodeAudit(method, row);
    body = !audit.ok ? (
      <p role="alert">This audit record could not be read. Refresh the view to try again.</p>
    ) : (
      <>
        <h3>
          <Icon name="history" />
          {audit.value.id}
        </h3>
        <p>{audit.value.binding}</p>
        <p>{audit.value.summary}</p>
        <div className="pt-audit-identity">
          <ActorAvatar actor={audit.value.actorId} />
          <span>
            Recorded by <strong>{audit.value.actorId}</strong> · {audit.value.runId ?? "No run"}
          </span>
        </div>
        {audit.value.previousOwner !== null && <p>Previous owner: {audit.value.previousOwner}</p>}
        {audit.value.guards !== null && <p className="wg-hint">{audit.value.guards}</p>}
        <details>
          <summary>Exact proof and recording time</summary>
          <p>{audit.value.timestamp}</p>
          {audit.value.evidence.length === 0 ? (
            <p>No supporting pins were recorded.</p>
          ) : (
            <ul>
              {audit.value.evidence.map((pin, i) => (
                <li key={i}>{proofLabel(pin)}</li>
              ))}
            </ul>
          )}
        </details>
      </>
    );
  }
  return (
    <article
      className="wg-coord-record co-record"
      data-record-kind={method}
      data-record-key={recordKey(page, row, index)}
    >
      {body}
    </article>
  );
}
function friendlyTime(value: string) {
  const milliseconds = BigInt(value);
  return milliseconds >= -8640000000000000n && milliseconds <= 8640000000000000n
    ? new Date(Number(milliseconds)).toLocaleString()
    : `Unix ms ${value}`;
}
function pinInput(value: ProofPin): ProofPinInput {
  switch (value.kind) {
    case "resource":
      return {
        kind: value.kind,
        resourceId: value.resource_id,
        version: value.revision,
        digest: value.digest,
      };
    case "event":
      return { kind: value.kind, sessionId: value.session_id, sequence: value.sequence };
    case "commit":
      return { kind: value.kind, repository: value.repository, objectId: value.object_id };
    case "checksum":
      return { kind: value.kind, source: value.source, digest: value.digest };
    case "comment":
      return { kind: value.kind, id: value.comment_id, revision: value.revision };
    case "amendment":
      return { kind: value.kind, id: value.amendment_id, revision: value.revision };
    case "contract":
      return { kind: value.kind, id: value.contract_id, revision: value.revision };
    case "decision":
      return { kind: value.kind, id: value.decision_id, revision: value.revision };
  }
}
function WaitCard({
  job,
  props,
}: {
  readonly job: WaitJob;
  readonly props: CoordinationFeatureProps;
}) {
  const { controller } = props,
    state = useSyncExternalStore(controller.subscribe, controller.get),
    observed = state.waitObservations.get(job.id),
    s = job.state,
    original = job.preparation,
    matches =
      state.scope !== null &&
      state.scope.connection.id === original.connection.id &&
      state.scope.connection.generation === original.connection.generation &&
      state.scope.connection.socket === original.connection.socket &&
      state.scope.workspaceId === original.context.workspace_id;
  const outcome =
    s.kind === "completed" || s.kind === "stopped" || s.kind === "outcome_unknown"
      ? s.outcome
      : null;
  return (
    <article className="wg-coord-record">
      <strong>{job.id}</strong>
      <Badge tone={s.kind === "outcome_unknown" ? "warning" : "neutral"}>
        {s.kind.replaceAll("_", " ")}
      </Badge>
      <p>
        Captured {job.preparation.connection.id} generation {job.preparation.connection.generation}{" "}
        / {job.preparation.context.workspace_id} · writer {job.preparation.context.writer.actor_id}{" "}
        / {job.preparation.context.writer.run_id ?? "none"}
      </p>
      <p className="wg-hint">
        {matches
          ? "Original target matches the current selection."
          : "Original target differs from the current selection; all wait actions retain that original target."}
      </p>
      <p className="wg-hint">
        Local revision {job.revision}; {job.limits.timeoutMs}ms absolute deadline; at most{" "}
        {job.limits.maxAttempts} acquisitions. Cancellation never releases a grant.
      </p>
      {job.cancelRequested && <p>Cancellation was requested; inspect the actual outcome.</p>}
      {job.diagnostic !== null && <p role="alert">{job.diagnostic.message}</p>}
      {s.kind === "outcome_unknown" && (
        <>
          <p role="alert">{s.problem.message}</p>
          <p>
            Exact retained journal: <code>{s.exactJournal}</code> · exchange{" "}
            {s.exchangeStarted
              ? "started (publication may have happened)"
              : "not recorded as started"}
          </p>
        </>
      )}
      {observed?.kind === "stopped" && observed.reason !== "complete" && (
        <p>
          Read-only observation stopped: {observed.reason}. The last known state is {s.kind};
          Inspect remains available.
        </p>
      )}
      <Toolbar label={`Wait actions ${job.id}`}>
        <Button
          onClick={() => {
            void controller.actWait(job.id, "inspect");
          }}
        >
          Inspect wait
        </Button>
        {s.kind === "prepared_unsent" && (
          <Button
            tone="primary"
            onClick={() => {
              void controller.actWait(job.id, "start");
            }}
          >
            Start bounded wait
          </Button>
        )}
        {(s.kind === "prepared_unsent" || s.kind === "running") && (
          <Button
            onClick={() => {
              void controller.actWait(job.id, "cancel");
            }}
          >
            Cancel wait
          </Button>
        )}
        {s.kind === "outcome_unknown" && (
          <Button
            onClick={() => {
              void controller.actWait(job.id, "retry-exact");
            }}
          >
            Retry exact retained acquisition
          </Button>
        )}
      </Toolbar>
      {outcome !== null && (
        <details className="pt-disclosure">
          <summary>Recorded wait result</summary>
          <CapturedValues value={outcome} />
        </details>
      )}
    </article>
  );
}
