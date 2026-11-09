import { Icon, type IconName } from "../../../components/Icon";
import { InspectorDisclosure, InspectorIntro } from "./InspectorParts";
import { PRIORITY_LABEL } from "./labels";
import { ActorAvatar } from "../../../components/ActorAvatar";
import { clearHistoryTarget } from "../../../app/navigation";
import { workbenchRoute } from "../destinations";
import { textField } from "./fields";
import { useRef, useState } from "react";
import { Badge, Button, Select, Toolbar } from "../../../components/Primitives";
import { jsonField, type JsonValue } from "../../../core/json";
import * as d from "../../../core/protocol/decoders";
import type { Identifier } from "../../../core/protocol/types";
import { current } from "../read-model";
import { ticketCodec } from "../read-model.codec";
import type {
  Capture,
  InspectorTab,
  TicketContext,
  TicketRead,
  WorkActionContext,
  WorkActionIntent,
  WorkFeatureProps,
  WorkState,
} from "../read-model.types";
import { TICKET_STATUSES } from "../read-model.types";
import { PageButtons, Prose, ReadStatus } from "./ReadPresentation";
interface Props extends WorkFeatureProps {
  readonly state: WorkState;
  readonly ticket: Capture<TicketRead>;
  readonly detail: Capture<TicketContext> | null;
  readonly actions: WorkActionContext | null;
  readonly navigate: (ticket: Identifier | null) => void;
  readonly launch: (task: Promise<void>) => void;
  readonly offer: (ticket: Identifier, intent: WorkActionIntent) => void;
}
const TABS: readonly InspectorTab[] = [
  "activity",
  "relationships",
  "completion",
  "admission",
  "details",
];
const COMPLETION_HELP: Readonly<Record<string, readonly [string, string]>> = {
  hold: ["No active hold", "Work is not paused by a recorded hold."],
  prerequisites: [
    "Prerequisites",
    "The tickets this work depends on satisfy the completion rules.",
  ],
  children: ["Child tickets", "Required child work is finished."],
  amendment_acknowledgements: [
    "Instruction changes",
    "Required workers have acknowledged the relevant instruction revisions.",
  ],
  configured_policy: [
    "Completion policy",
    "The configured ticket and project completion requirements are satisfied.",
  ],
};
function IdLink({
  id,
  navigate,
  children,
}: {
  readonly id: Identifier;
  readonly navigate: (id: Identifier) => void;
  readonly children?: React.ReactNode;
}) {
  return (
    <Button tone="quiet" className="work-id-link" onClick={() => navigate(id)}>
      {children ?? id}
    </Button>
  );
}
const SECTION_HELP: Readonly<
  Record<string, { readonly description: string; readonly icon: IconName }>
> = {
  "/data/children": {
    icon: "workflow",
    description:
      "Smaller tasks grouped under this ticket. The completion policy decides whether these must finish first.",
  },
  "/data/related": {
    icon: "work",
    description:
      "Tickets linked for context. These links do not block work or change when this ticket can start.",
  },
  "/data/resources": {
    icon: "resources",
    description:
      "Documents and files attached to this ticket, such as research, implementation notes and supporting material.",
  },
};
function Section({
  path,
  label,
  props,
}: {
  readonly path: string;
  readonly label: string;
  readonly props: Props;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const { state, detail, context, controller, launch } = props,
    override = state.sections[path],
    capture = override ? current(override) : undefined;
  const page = capture?.value ?? detail?.value.sections[path];
  const control =
    (capture ?? detail)?.controls.find((p) => p.path === path) ??
    capture?.controls.find((p) => p.path === "/data");
  return (
    <section className="work-context-section" data-section={path}>
      <header>
        <h3>
          {SECTION_HELP[path] && <Icon name={SECTION_HELP[path].icon} />}
          {label}
        </h3>
        {page && (
          <span className="wg-hint">
            {page.items.length} loaded · {page.remaining} remaining
          </span>
        )}
      </header>
      {SECTION_HELP[path] && <p className="work-section-help">{SECTION_HELP[path].description}</p>}
      {override && <ReadStatus state={override} label={label} />}
      {page === undefined ? (
        <p className="wg-hint">This section has not been captured.</p>
      ) : page.items.length === 0 ? (
        <p className="work-section-empty">No entries in this captured page.</p>
      ) : (
        <ol className="work-context-list">
          {page.items.map((value, index) => {
            const ticket = ticketCodec.decode(value),
              resourceMetadata =
                path === "/data/resources" && value.kind === "object"
                  ? jsonField(value, "metadata")
                  : undefined,
              key =
                textField(value, "comment_id") ??
                textField(value, "thread_id") ??
                textField(value, "request_id") ??
                textField(value, "sequence") ??
                `${path}:${page.offset}:${index}`,
              title =
                textField(resourceMetadata, "title") ??
                textField(value, "title") ??
                textField(value, "summary") ??
                textField(value, "body") ??
                textField(value, "reason") ??
                textField(value, "kind") ??
                textField(value, "key") ??
                `Entry ${BigInt(page.offset) + BigInt(index) + 1n}`;
            return (
              <li key={key}>
                {ticket.ok ? (
                  <IdLink id={ticket.value.ticket_id} navigate={props.navigate}>
                    {ticket.value.display_key} · {ticket.value.title}
                  </IdLink>
                ) : (
                  <>
                    <div className="work-entry-summary">
                      {title.length > 240 ? `${title.slice(0, 240)}…` : title}
                    </div>
                    {textField(resourceMetadata, "description") && (
                      <p className="work-section-help">
                        {textField(resourceMetadata, "description")}
                      </p>
                    )}
                    <div className="work-entry-meta">
                      {textField(resourceMetadata, "filename") && (
                        <span>{textField(resourceMetadata, "filename")}</span>
                      )}
                      {textField(value, "actor_id") && (
                        <ActorAvatar actor={textField(value, "actor_id")} />
                      )}
                      {["actor_id", "timestamp"].map((name) => {
                        const text = textField(value, name);
                        return text === null ? null : (
                          <span key={name}>
                            {name.replaceAll("_", " ")}: <code>{text}</code>
                          </span>
                        );
                      })}
                    </div>
                  </>
                )}
                {textField(value, "body") && (
                  <Button
                    tone="quiet"
                    aria-expanded={expanded === key}
                    onClick={() => setExpanded(expanded === key ? null : key)}
                  >
                    {expanded === key ? "Hide message" : "Read full message"}
                  </Button>
                )}
                {expanded === key && (
                  <>
                    {textField(value, "body") && (
                      <Prose
                        text={textField(value, "body") ?? ""}
                        capture={key}
                        label="Entry body"
                        partial={detail?.partial ?? false}
                      />
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {page && (
        <PageButtons
          control={control}
          disabled={context.profileState !== "current" || override?.kind === "loading"}
          load={(kind) => launch(controller.section(path, kind))}
        />
      )}
    </section>
  );
}
function PolicySources({ value, props }: { readonly value: JsonValue; readonly props: Props }) {
  const sources = value.kind === "object" ? jsonField(value, "sources") : undefined;
  if (sources?.kind !== "array") return null;
  return (
    <section>
      <h3>Policy sources</h3>
      {sources.items.map((source, index) => {
        const scope = source.kind === "object" ? jsonField(source, "scope") : undefined;
        const kind = textField(scope, "kind"),
          target = textField(scope, kind === "ticket" ? "ticket_id" : "project_id"),
          revision = textField(source, "revision");
        const parsed = target === null ? null : d.identifier.decode(d.jsonString(target));
        return (
          <div key={index}>
            {parsed?.ok && kind === "ticket" ? (
              <IdLink id={parsed.value} navigate={props.navigate}>
                Source ticket {parsed.value} · policy revision {revision ?? "not reported"}
              </IdLink>
            ) : parsed?.ok && kind === "project" ? (
              <Button
                tone="quiet"
                onClick={() =>
                  props.context.navigate({
                    ...props.context.route,
                    view: "overview",
                    projectId: parsed.value,
                    entityId: null,
                  })
                }
              >
                Source project {parsed.value} · policy revision {revision ?? "not reported"}
              </Button>
            ) : (
              <p className="wg-hint">
                Additional policy source {index + 1}; no direct navigation is available.
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
}
function Reason({ value, props }: { readonly value: JsonValue; readonly props: Props }) {
  const kind = textField(value, "kind") ?? "unknown",
    prerequisite =
      textField(value, "prerequisite_ticket_id") ??
      (kind === "prerequisite" ? textField(value, "ticket_id") : null),
    ancestor = textField(value, "ancestor_ticket_id");
  const prerequisiteId =
      prerequisite === null ? null : d.identifier.decode(d.jsonString(prerequisite)),
    ancestorId = ancestor === null ? null : d.identifier.decode(d.jsonString(ancestor));
  const details = value.kind === "object" ? jsonField(value, "details") : undefined;
  return (
    <li>
      <strong>{kind.replaceAll("_", " ")}</strong>
      {prerequisiteId?.ok && (
        <>
          {" "}
          ·{" "}
          <IdLink id={prerequisiteId.value} navigate={props.navigate}>
            Prerequisite {prerequisiteId.value}
          </IdLink>
        </>
      )}
      {ancestorId?.ok && (
        <p>
          Inherited rule ·{" "}
          <IdLink id={ancestorId.value} navigate={props.navigate}>
            Open source parent {ancestorId.value}
          </IdLink>
        </p>
      )}
      {kind === "hold" && <p>{textField(details, "reason")}</p>}
      {kind === "claimed" && (
        <p>Claimed by {textField(details, "actor_id")} · ownership is separate from assignment.</p>
      )}
      {kind === "missing_candidate_capability" && (
        <p>Missing declared capability: {textField(value, "capability")}</p>
      )}
    </li>
  );
}
export function TicketInspector(props: Props) {
  const sections = useRef<HTMLDivElement>(null);
  const show = (tab: InspectorTab) => {
    props.controller.setPresentation({ tab });
    sections.current?.scrollIntoView({ block: "start", behavior: "instant" });
  };
  const {
      context,
      controller,
      state,
      ticket: captured,
      detail,
      actions,
      navigate,
      launch,
      offer,
    } = props,
    ticket = captured.value.ticket;
  const [target, setTarget] = useState(ticket.status);
  const ready = current(state.readiness),
    assessment = ready?.value;
  const completion = detail?.value.completion_readiness ?? assessment?.completion;
  const graph = detail?.value.readiness;
  const selectedWriter = state.readinessTarget;
  const assessmentLabel =
    assessment === undefined
      ? "Readiness assessment not captured"
      : assessment.assessment.scope === "graph"
        ? "Graph assessment"
        : assessment?.assessment.scope === "run"
          ? `Run assessment · ${selectedWriter?.runId ?? "unknown run"}`
          : `Candidate assessment · ${selectedWriter?.actorId ?? "unknown actor"} · no capabilities supplied`;
  const navigateView = (view: "resources" | "discussions" | "facts") =>
    context.navigate({ ...clearHistoryTarget(context.route), view, entityId: null });
  return (
    <div className="work-ticket-inspector">
      {(captured.partial || detail?.partial) && (
        <Badge tone="warning">Partial ticket context — some information is not loaded</Badge>
      )}
      <h1 className="work-inspector-title">{ticket.title}</h1>
      <div className="work-inspector-summary">
        <span className={`work-inspector-status work-inspector-status--${ticket.status}`}>
          <span aria-hidden="true">
            {ticket.status === "done" ? "✓" : ticket.status === "in_progress" ? "◐" : "○"}
          </span>
          {ticket.status === "todo"
            ? "To do"
            : ticket.status === "in_progress"
              ? "In progress"
              : ticket.status[0]?.toUpperCase() + ticket.status.slice(1)}
        </span>

        {ticket.archived && <Badge>Archived</Badge>}
        {ticket.hold && <Badge tone="warning">On hold</Badge>}
        <Button tone="quiet" onClick={() => show("activity")}>
          Comments & updates
        </Button>
        {actions && props.renderActions?.(actions)}
      </div>
      {actions && props.renderQuickActions?.(actions)}
      <dl className="work-properties work-primary-properties">
        <div>
          <dt>Assignee</dt>
          <dd className="work-property-actor">
            <ActorAvatar actor={ticket.assignee_id} />
            {ticket.assignee_id ?? "Unassigned"}
          </dd>
        </div>
        <div>
          <dt>Claim owner</dt>
          <dd>
            {ticket.claim ? (
              <span
                className="work-property-actor"
                title={`Run ${ticket.claim.run_id ?? "none"} · token ${ticket.claim.token}`}
              >
                <ActorAvatar actor={ticket.claim.actor_id} />
                {ticket.claim.actor_id}
              </span>
            ) : (
              "Unclaimed"
            )}
          </dd>
        </div>
        <div>
          <dt>Priority</dt>
          <dd>{PRIORITY_LABEL[ticket.priority] ?? ticket.priority}</dd>
        </div>
        <div>
          <dt>Milestone</dt>
          <dd>{ticket.milestone_id ?? "None"}</dd>
        </div>
      </dl>
      <div className={`work-readiness-callout ${graph?.ready ? "is-ready" : "is-blocked"}`}>
        <strong>
          {ticket.hold
            ? "On hold"
            : graph
              ? graph.ready
                ? "Graph ready"
                : "Waiting on recorded requirements"
              : "Readiness not loaded"}
        </strong>
        <p>
          {ticket.hold
            ? ticket.hold.reason
            : graph
              ? graph.ready
                ? "Its recorded dependencies allow work to begin. Starting work still checks the selected actor’s eligibility."
                : `${graph.reason_count} recorded reason${graph.reason_count === "1" ? " prevents" : "s prevent"} this ticket from being graph ready.`
              : "Read the current ticket checks before choosing the next action."}
        </p>
        <Button tone="quiet" onClick={() => show("admission")}>
          Inspect readiness
        </Button>
        <Button tone="quiet" onClick={() => show("completion")}>
          {completion?.can_complete ? "Completion checks pass" : "View completion checks"}
        </Button>
      </div>
      <section className="work-ticket-description">
        <h3>Description</h3>
        <Prose
          capture={captured.id}
          label="Ticket instructions"
          text={ticket.description}
          partial={captured.partial}
        />
      </section>
      <div
        ref={sections}
        className="work-inspector-tabs"
        role="group"
        aria-label="Ticket inspector sections"
      >
        {TABS.map((tab) => (
          <Button
            key={tab}
            aria-pressed={state.tab === tab}
            onClick={() => controller.setPresentation({ tab })}
          >
            {
              {
                activity: "Conversation",
                relationships: "Links",
                completion: "Completion",
                admission: "Who can work",
                details: "Details",
              }[tab]
            }
          </Button>
        ))}
      </div>
      <ReadStatus state={state.context} label="Ticket context" />
      {state.tab === "details" && (
        <div className="work-tab-content" data-tab="details">
          <InspectorIntro
            icon="work"
            title="Ticket details"
            description="Review what success means, how this ticket is organized, and any hold that pauses new work."
          />
          <section>
            <h3>Acceptance criteria</h3>
            <p className="work-section-help">
              The outcome this ticket is expected to achieve. Use these requirements when preparing
              evidence and reviewing the finished work.
            </p>
            <Prose
              capture={captured.id}
              label="Acceptance criteria"
              text={ticket.acceptance_criteria}
              partial={captured.partial}
            />
          </section>
          {ticket.hold && (
            <section>
              <h3>Hold</h3>
              <p>{ticket.hold.reason}</p>
              <p className="wg-hint">
                Declared by {ticket.hold.actor_id} · {ticket.hold.timestamp}
              </p>
            </section>
          )}
          <dl className="work-properties">
            <div>
              <dt>Custom status ID</dt>
              <dd>{ticket.status_id ?? "Default category"}</dd>
            </div>
            <div>
              <dt>Milestone</dt>
              <dd>{ticket.milestone_id ?? "None"}</dd>
            </div>
            <div>
              <dt>Labels</dt>
              <dd>{ticket.label_ids.join(", ") || "None"}</dd>
            </div>
          </dl>
          <section className="work-action-offer">
            <h3>Ticket actions</h3>
            <p className="wg-hint">
              Status is authored. Readiness is computed from recorded rules. Action forms prepare
              exact guarded operations.
            </p>
            <Select
              label="Proposed status"
              value={target}
              onChange={(e) => {
                const status = TICKET_STATUSES.find((s) => s === e.target.value);
                if (status) setTarget(status);
              }}
            >
              {TICKET_STATUSES.map((s) => (
                <option value={s} key={s}>
                  {s.replaceAll("_", " ")}
                </option>
              ))}
            </Select>
            <Button
              disabled={context.profileState !== "current"}
              onClick={() => offer(ticket.ticket_id, { kind: "status", status: target })}
            >
              Review status change
            </Button>
          </section>
        </div>
      )}
      {state.tab === "relationships" && (
        <div className="work-tab-content" data-tab="links">
          <InspectorIntro
            icon="workflow"
            title="How this ticket connects"
            description="Prerequisites must finish before this work is ready. A parent groups work; related tickets and resources provide context without blocking it."
          />
          <section>
            <h3>Parent ticket</h3>
            {ticket.parent_ticket_id ? (
              <IdLink id={ticket.parent_ticket_id} navigate={navigate}>
                {detail?.value.parent?.title ?? ticket.parent_ticket_id}
              </IdLink>
            ) : (
              <p className="wg-hint">No parent.</p>
            )}
            <p className="wg-hint">Parent membership is distinct from prerequisites.</p>
          </section>
          <section>
            <h3>Waiting on</h3>
            <p className="work-section-help">
              These direct dependencies must satisfy their completion rules before this ticket is
              ready.
            </p>
            {ticket.prerequisite_ticket_ids.length === 0 ? (
              <p className="wg-hint">No direct prerequisite links.</p>
            ) : (
              ticket.prerequisite_ticket_ids.map((id) => (
                <div key={id}>
                  <IdLink id={id} navigate={navigate} />
                  <span className="wg-hint"> · Direct blocking rule</span>
                </div>
              ))
            )}
          </section>
          <section>
            <h3>Inherited blocking rules</h3>
            {detail?.value.parent && (
              <div>
                <p className="wg-hint">
                  Direct source-parent declarations (including satisfied prerequisites):
                </p>
                {detail.value.parent.prerequisite_ticket_ids.map((id) => (
                  <div key={id}>
                    <IdLink id={id} navigate={navigate} />
                    <span className="wg-hint"> · declared at </span>
                    <IdLink id={detail.value.parent!.ticket_id} navigate={navigate}>
                      {detail.value.parent!.ticket_id}
                    </IdLink>
                  </div>
                ))}
              </div>
            )}
            {graph ? (
              graph.reasons.filter((r) => textField(r, "kind") === "inherited_prerequisite")
                .length === 0 ? (
                <p className="wg-hint">
                  No inherited prerequisite blockers reported in this capture.
                </p>
              ) : (
                <ul>
                  {graph.reasons
                    .filter((r) => textField(r, "kind") === "inherited_prerequisite")
                    .map((r, i) => (
                      <Reason key={i} value={r} props={props} />
                    ))}
                </ul>
              )
            ) : (
              <p className="wg-hint">
                Read context to inspect inherited blockers and source parents.
              </p>
            )}
            <p className="wg-hint">
              An inherited rule is changed at its source parent. This blocker view does not
              enumerate already-satisfied inherited rules.
            </p>
          </section>
          <Section path="/data/children" label="Child tickets" props={props} />
          <Section path="/data/related" label="Related tickets" props={props} />
          {!detail?.value.sections["/data/related"] && (
            <section>
              <h3>Related ticket IDs</h3>
              {ticket.related_ticket_ids.map((id) => (
                <IdLink key={id} id={id} navigate={navigate} />
              ))}
              {ticket.related_ticket_ids.length === 0 && (
                <p className="wg-hint">No related links.</p>
              )}
            </section>
          )}
          <Section path="/data/resources" label="Linked resources" props={props} />
        </div>
      )}
      {state.tab === "admission" && (
        <div className="work-tab-content" data-tab="admission">
          <InspectorIntro
            icon="participants"
            title="Can I work on this ticket?"
            description="Check dependencies first, then check the selected actor or run against the ticket’s rules. These checks read the current state; they do not assign or claim work."
          />
          <div className="work-candidate">
            <ActorAvatar actor={context.writer.actorId} />
            <div>
              <strong>{context.writer.actorId ?? "Choose an acting actor"}</strong>
              <p>
                {context.writer.runId
                  ? `Run: ${context.writer.runId}`
                  : "No run selected. Actor-only checks may leave capability checks unknown."}
              </p>
            </div>
          </div>
          <section>
            <h3>1. Check readiness</h3>
            <p className="work-section-help">
              Check dependencies for the ticket alone, or include the selected actor’s eligibility
              and ownership rules. A passing check is a current observation, not a reservation.
            </p>
            <p className="work-assessment-label">{assessmentLabel}</p>
            <ReadStatus state={state.readiness} label="Readiness" />
            {ready && (
              <>
                <Badge tone={assessment?.ready ? "accent" : "warning"}>
                  {assessment?.ready
                    ? assessment.assessment.scope === "graph"
                      ? "Graph ready"
                      : "Known admission checks pass"
                    : "Blocked"}
                </Badge>
                <p className="wg-hint">
                  This result is for the identity shown above. It does not authenticate the acting
                  actor or transfer claim ownership.
                </p>
                {assessment && assessment.assessment.unknown_checks.length > 0 && (
                  <p className="work-read-error">
                    Unknown checks:{" "}
                    {assessment.assessment.unknown_checks.join(", ").replaceAll("_", " ")}
                  </p>
                )}
                {assessment && (
                  <ul className="work-reasons">
                    {assessment.reasons.map((reason, index) => (
                      <Reason key={index} value={reason} props={props} />
                    ))}
                  </ul>
                )}
              </>
            )}
            <Toolbar label="Readiness assessment">
              <Button
                disabled={context.profileState !== "current"}
                onClick={() => launch(controller.assess(null))}
              >
                Check dependencies
              </Button>
              <Button
                requiresActor
                disabled={context.profileState !== "current"}
                onClick={() => launch(controller.assess(context.writer))}
              >
                {context.writer.runId
                  ? `Check run ${context.writer.runId}`
                  : context.writer.actorId
                    ? `Check eligibility for ${context.writer.actorId}`
                    : "Select actor for assessment"}
              </Button>
            </Toolbar>
          </section>
          <section>
            <h3>2. Start work when you are ready</h3>
            <p className="work-section-help">
              Starting work claims this ticket for the selected actor or run and changes its status.
              The daemon checks the rules again when you apply the action. Assignment alone does not
              grant ownership.
            </p>
            <Toolbar label="Work on this ticket">
              {actions && props.renderAdmissionActions?.(actions)}
              <Button onClick={() => show("activity")}>Record progress or handoff</Button>
            </Toolbar>
          </section>
        </div>
      )}
      {state.tab === "completion" && (
        <div className="work-tab-content" data-tab="completion">
          <InspectorIntro
            icon="check"
            title="What is needed to finish?"
            description="Completion checks bring together prerequisites, child tickets and the project’s rules. Passing these checks does not mark the ticket done; completion remains an explicit action."
          />
          <section>
            <h3>Completion gates</h3>
            {actions && context.route.view !== "workflow" && (
              <Button
                onClick={() =>
                  context.navigate(
                    workbenchRoute(
                      actions.scope.connection,
                      actions.scope.workspaceId,
                      ticket.ticket_id,
                      "workflow",
                    ),
                  )
                }
              >
                Open review and evidence
              </Button>
            )}
            {completion ? (
              <>
                <p>
                  {completion.can_complete
                    ? "All five recorded completion checks pass. Completion still requires an explicit guarded action."
                    : (completion.problem?.message ?? "A recorded completion gate is unmet.")}
                </p>
                <ul className="work-checks">
                  {completion.checks.map((check) => (
                    <li key={check.kind}>
                      <span className={check.passed ? "work-pass" : "work-unmet"}>
                        {check.passed ? "✓" : "○"}
                      </span>
                      <span>
                        <strong>
                          {COMPLETION_HELP[check.kind]?.[0] ?? check.kind.replaceAll("_", " ")}
                        </strong>
                        <small className="work-check-description">
                          {COMPLETION_HELP[check.kind]?.[1]}
                        </small>
                      </span>
                      <Badge tone={check.passed ? "neutral" : "warning"}>
                        {check.passed ? "Passed" : "Unmet"}
                      </Badge>
                    </li>
                  ))}
                </ul>
                <p>
                  Unfinished children: {completion.unfinished_child_count} · blocked prerequisites:{" "}
                  {completion.blocked_prerequisite_count}
                </p>
                {[...completion.unfinished_child_ids, ...completion.blocked_prerequisite_ids].map(
                  (id, i) => (
                    <IdLink key={`${id}:${i}`} id={id} navigate={navigate} />
                  ),
                )}
                <PolicySources value={completion.policy} props={props} />
              </>
            ) : (
              <p className="wg-hint">Completion checks have not been captured.</p>
            )}
          </section>
          {detail && (
            <>
              <Section
                path="/data/pending_amendment_acknowledgements"
                label="Pending amendment acknowledgements"
                props={props}
              />
            </>
          )}
        </div>
      )}
      {state.tab === "activity" && (
        <>
          {actions && props.renderProgress?.(actions)}
          <InspectorDisclosure
            title="Linked discussions and ticket history"
            description="Follow questions, instruction changes and other records connected to this ticket."
            icon="discussions"
            tone="pink"
          >
            <p className="work-section-help">
              The conversation above contains ticket comments. These additional records explain
              decisions, ownership changes and linked discussions. Reading them does not acknowledge
              a notification or resolve a question.
            </p>
            <Section path="/data/updates" label="Progress updates" props={props} />
            <Section path="/data/communication/threads" label="Discussion threads" props={props} />
            <Section
              path="/data/communication/requests"
              label="Questions and requests"
              props={props}
            />
            <Section path="/data/amendments" label="Instruction amendments" props={props} />
            <Section path="/data/attempts" label="Execution attempts" props={props} />
            <Section path="/data/recoveries" label="Recoveries" props={props} />
            <Section
              path="/data/activity_since_handoff"
              label="Activity since handoff"
              props={props}
            />
            <Section path="/data/fact_keys" label="Attributed fact keys" props={props} />
            <Toolbar label="Related knowledge views">
              <Button onClick={() => navigateView("facts")}>Open Facts</Button>
              <Button onClick={() => navigateView("resources")}>Open Resources</Button>
              <Button onClick={() => navigateView("discussions")}>Open Discussions</Button>
            </Toolbar>
          </InspectorDisclosure>
        </>
      )}
      {actions?.intent && (
        <section className="work-action-offer" role="status">
          <p className="wg-hint">
            For {ticket.display_key} · {ticket.ticket_id} · captured ticket revision{" "}
            {ticket.revision}
          </p>
          <h3>
            {actions.intent.kind === "status"
              ? `Proposed status: ${actions.intent.status.replaceAll("_", " ")}`
              : "Readiness action required"}
          </h3>
          <p>
            {actions.intent.kind === "readiness"
              ? "Readiness cannot be dragged into a new state. Inspect the blocking rule, claim availability, hold or prerequisite at its source; use the corresponding guarded action."
              : "This proposal has not changed the ticket. Review the exact captured revision and action form before preparing it."}
          </p>
          {!props.renderActions && (
            <p className="wg-hint">Guarded ticket action forms are not available in this build.</p>
          )}
          <Button tone="quiet" onClick={actions.clearIntent}>
            Dismiss proposal
          </Button>
        </section>
      )}
    </div>
  );
}
