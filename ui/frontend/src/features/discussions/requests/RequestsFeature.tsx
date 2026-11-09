import { useActorGate } from "../../../components/ActorAccess";
import "../../../components/section-navigation.css";
import { ReferencePicker } from "../ReferencePicker";
import { ReferenceFields } from "../ReferenceFields";
import { RecipientPicker } from "../RecipientPicker";
import { ActionGuide } from "../ActionGuide";
import { ActorAvatar } from "../../../components/ActorAvatar";
import { ManagementPresentation } from "../../connections/management-presentation";
import "../discussion-continuity.css";
import { ResizablePane } from "../../../components/ResizablePane";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "../../../components/Icon";
import { Dialog } from "../../../components/Dialog";
import { ObservationNotice } from "../../../components/ObservationNotice";
import { Badge, Button, Field, Panel, Select, Toolbar } from "../../../components/Primitives";
import type { ManagedAction } from "../../../core/state/operations";
import { failureText } from "../../connections/failure";
import { LazyDetails, OperationPanel } from "../../connections/shared";
import { endpoint, identity, sameEndpoint } from "../threads/model";
import { requestKinds } from "./codecs";
import { Kinds, RecipientField, RequestFields } from "./RequestFields";
import { RequestRead } from "./RequestReads";
import { defaultFilter } from "./controller";
import { id, integer } from "./model";
import { requestsRoute, targetFromRoute } from "./navigation";
import type {
  EditableRecipient,
  RequestFields as Fields,
  RequestsDraft,
  RequestsFeatureProps,
  RequestsInput,
  RequestsTarget,
} from "./types";
const labels: Readonly<Record<RequestsInput["method"], string>> = {
  "request.ask": "Ask a question",
  "request.create": "Create request from attached comment",
  "request.acknowledge": "Acknowledge delivery",
  "request.accept": "Accept responsibility",
  "request.reassign": "Reassign responsibility",
  "request.resolve": "Answer and resolve",
  "request.cancel": "Cancel request",
  "request.metadata": "Edit request metadata",
  "inbox.ack": "Acknowledge selected notifications",
  "team.put": "Team configuration",
  "subscription.put": "Subscription configuration",
};
function Editor({
  draft,
  props,
}: {
  readonly draft: RequestsDraft;
  readonly props: RequestsFeatureProps;
}) {
  const [issue, setIssue] = useState(""),
    [unexpected, setUnexpected] = useState<{ error: unknown } | null>(null);
  const managed = useSyncExternalStore(props.operations.subscribe, () =>
    props.operations.get(draft.id),
  );
  if (draft.unexpected !== null) throw draft.unexpected.error;
  if (unexpected !== null) throw unexpected.error;
  if (managed?.phase.kind === "unexpected_error") throw managed.phase.error;
  const operation = managed?.operation,
    pending = managed?.phase.kind === "pending",
    locked = draft.phase.kind === "capturing" || draft.phase.kind === "captured",
    original = draft.context.writer,
    changed =
      original.actorId !== props.context.writer.actorId ||
      original.runId !== props.context.writer.runId;
  const perform = (action: ManagedAction) => {
    setIssue("");
    void props.operations
      .act(draft.id, action)
      .then((result) => {
        if (!result.ok) setIssue(failureText(result.failure));
      })
      .catch((error: unknown) => setUnexpected({ error }));
  };
  return (
    <Dialog title={labels[draft.input.method]} wide onClose={() => props.controller.select(null)}>
      <ManagementPresentation value={true}>
        <div className="dc-editor">
          <ActionGuide method={draft.input.method} />
          <p className="dc-editor-author">
            <ActorAvatar actor={original.actorId} /> Acting author{" "}
            <strong>{original.actorId}</strong>
            {original.runId !== null ? ` · run ${original.runId}` : ""}{" "}
            {changed && <Badge tone="warning">Original writer retained after switch</Badge>}
          </p>
          <div className="dc-editor-fields">
            <ReferenceFields context={props.context} endpoint={draft.endpoint}>
              <RequestFields
                input={draft.input}
                onChange={(input) => props.controller.edit(draft.id, input)}
                disabled={locked}
              />
            </ReferenceFields>
          </div>
          {draft.issue !== null && (
            <p role="alert" className="wg-error">
              {draft.issue}
            </p>
          )}
          {issue !== "" && (
            <p role="alert" className="wg-error">
              {issue}
            </p>
          )}
          {managed?.phase.kind === "unconfirmed" && (
            <p role="alert">
              Unconfirmed {managed.phase.action}: {failureText(managed.phase.failure)}. The original
              identity is retained; no automatic retry occurs.
            </p>
          )}
          {draft.phase.kind === "loading" && (
            <p role="status">Loading the current record; entered text stays unchanged.</p>
          )}
          {draft.phase.kind === "capturing" && <p role="status">Preparing this captured action…</p>}
          {operation != null && (
            <p role="status">
              Saved action: <strong>{operation.state.kind}</strong>
            </p>
          )}
          {operation?.state.kind === "sending" && (
            <ObservationNotice status={managed?.observation} />
          )}
          <Toolbar label="Request action controls">
            {!locked && (
              <Button
                tone="primary"
                disabled={pending || draft.phase.kind === "loading"}
                onClick={() => {
                  void props.controller.review(draft.id);
                }}
              >
                Review
              </Button>
            )}
            {locked && operation == null && (
              <Button
                disabled={pending || draft.phase.kind === "capturing"}
                onClick={() => {
                  void props.controller.review(draft.id);
                }}
              >
                Retry same preparation
              </Button>
            )}
            {operation?.state.kind === "prepared_unsent" && (
              <Button tone="primary" disabled={pending} onClick={() => perform("execute")}>
                Apply change
              </Button>
            )}
            {operation != null && (
              <Button disabled={pending} onClick={() => perform("inspect")}>
                Inspect saved action
              </Button>
            )}
            {!locked && "existing" in draft.input && draft.input.existing && (
              <>
                <Button
                  disabled={draft.phase.kind === "loading"}
                  onClick={() => {
                    void props.controller.loadGuards(draft.id);
                  }}
                >
                  Load current configuration
                </Button>
                <Button
                  disabled={draft.phase.kind === "loading"}
                  onClick={() => props.controller.fill(draft.id)}
                >
                  Copy loaded configuration
                </Button>
              </>
            )}
            <Button onClick={() => props.controller.select(null)}>Keep draft and close</Button>
            <Button
              disabled={draft.phase.kind === "capturing"}
              onClick={() => props.controller.close(draft.id)}
            >
              Discard editor
            </Button>
          </Toolbar>
          {operation?.state.kind === "committed" && (
            <p>
              Committed with the original writer. Refresh the reading surface for a new current
              capture.
            </p>
          )}
          {(operation?.state.kind === "rejected" ||
            operation?.state.kind === "outcome_unknown") && (
            <p role="alert">
              {operation.state.problem.kind}: {operation.state.problem.message}
              {operation.state.kind === "outcome_unknown"
                ? ". Outcome is uncertain. Inspect or deliberately retry only this exact saved request."
                : ". Rejected; create a separate new draft deliberately to refresh current guards."}
            </p>
          )}

          {managed !== undefined && (
            <LazyDetails summary="Saved action and recovery">
              <OperationPanel
                operations={props.operations}
                intention={draft.id}
                processing={props.context.client.processing}
              />
            </LazyDetails>
          )}
        </div>
      </ManagementPresentation>
    </Dialog>
  );
}
function Filters({ props }: { readonly props: RequestsFeatureProps }) {
  const filter = props.controller.get().filter,
    set = props.controller.filter;
  const field = (
    label: string,
    value: string,
    key: keyof Pick<
      typeof filter,
      | "threadId"
      | "ticketId"
      | "resolverId"
      | "priority"
      | "overdueAtUnixMs"
      | "relatedToId"
      | "supersedesId"
      | "supersededById"
    >,
  ) => (
    <Field
      label={label}
      value={value}
      onChange={(event) => set({ ...filter, [key]: event.target.value })}
    />
  );
  return (
    <details>
      <summary>More filters</summary>
      <p>
        Choose which questions appear here. Use the shortcuts above for common views; these fields
        narrow the results further.
      </p>
      <Select
        label="Request scope"
        value={filter.scope?.kind ?? "all"}
        onChange={(event) =>
          set({
            ...filter,
            scope:
              event.target.value === "workspace"
                ? { kind: "workspace" }
                : event.target.value === "project"
                  ? { kind: "project", id: props.context.route.projectId ?? "" }
                  : null,
          })
        }
      >
        <option value="all">All workspace scopes</option>
        <option value="workspace">Workspace discussions only</option>
        <option value="project">One project</option>
      </Select>
      {filter.scope?.kind === "project" && (
        <Field
          label="Request project ID"
          value={filter.scope.id}
          onChange={(event) => {
            const value = event.target.value;
            set({ ...filter, scope: { kind: "project", id: value } });
          }}
        />
      )}
      {field("Discussion filter", filter.threadId, "threadId")}
      {field("Ticket filter", filter.ticketId, "ticketId")}
      {field("Resolver filter", filter.resolverId, "resolverId")}
      <Select
        label="Request kind filter"
        value={filter.kind}
        onChange={(event) => {
          const kind = requestKinds.find((kind) => kind === event.target.value);
          set({ ...filter, kind: kind ?? "all" });
        }}
      >
        <option value="all">All kinds</option>
        {requestKinds.map((kind) => (
          <option key={kind} value={kind}>
            {kind.replaceAll("_", " ")}
          </option>
        ))}
      </Select>
      <details>
        <summary>Priority, deadlines and related requests</summary>
        {field("Priority filter", filter.priority, "priority")}
        {field("Overdue at Unix milliseconds", filter.overdueAtUnixMs, "overdueAtUnixMs")}
        {field("Related to request", filter.relatedToId, "relatedToId")}
        {field("Supersedes request", filter.supersedesId, "supersedesId")}
        {field("Superseded by request", filter.supersededById, "supersededById")}
      </details>
      <label>
        <input
          type="checkbox"
          checked={filter.openOnly}
          onChange={(event) => set({ ...filter, openOnly: event.target.checked })}
        />
        Open only
      </label>
      <label>
        <input
          type="checkbox"
          checked={filter.unanswered}
          onChange={(event) => set({ ...filter, unanswered: event.target.checked })}
        />
        Delivery not yet acknowledged
      </label>
      {(["recipient", "responsible"] as const).map((key) => (
        <div key={key}>
          <label>
            <input
              type="checkbox"
              checked={filter[key] !== null}
              onChange={(event) =>
                set({ ...filter, [key]: event.target.checked ? { kind: "actor", id: "" } : null })
              }
            />
            Filter by {key}
          </label>
          {filter[key] !== null && (
            <RecipientField
              label={`${key} filter`}
              value={filter[key]}
              onChange={(value) => set({ ...filter, [key]: value })}
            />
          )}
        </div>
      ))}
      <Button
        onClick={() => {
          void props.controller.read({ kind: "requests", filter });
        }}
      >
        Apply request filters
      </Button>
    </details>
  );
}
function InboxControls({ props }: { readonly props: RequestsFeatureProps }) {
  const state = props.controller.get(),
    filter = state.inboxFilter,
    pinned = state.target?.kind === "inbox" && state.target.capture !== null;
  return (
    <section className="rq-inbox-controls" aria-label="Inbox selection">
      <header className="rq-inbox-tip">
        <span className="rq-inbox-symbol">
          <Icon name="participants" />
        </span>
        <div>
          <h3>Whose inbox would you like to see?</h3>
          <p>
            Choose a person or agent, or a specific run. This changes the notifications you read,
            not who you act as.
          </p>
        </div>
      </header>
      <fieldset disabled={pinned} className="rq-inbox-settings">
        <legend>Inbox recipient and filters</legend>
        <div className="rq-recipient-row">
          <RecipientField
            label="Inbox recipient"
            actorInput={
              <RecipientPicker
                context={props.context}
                endpoint={state.endpoint ?? endpoint(props.context)}
                label="Inbox recipient ID"
                value={filter.recipient.id}
                disabled={pinned}
                onChange={(id) =>
                  props.controller.inboxFilter({
                    ...filter,
                    recipient: { ...filter.recipient, id },
                  })
                }
              />
            }
            value={filter.recipient}
            onChange={(recipient) => props.controller.inboxFilter({ ...filter, recipient })}
          />
        </div>
        <div className="rq-recipient-shortcuts">
          {props.context.writer.actorId !== null && (
            <span className="rq-current-actor">
              <ActorAvatar actor={props.context.writer.actorId} />
              <span>
                Acting as <strong>{props.context.writer.actorId}</strong>
              </span>
            </span>
          )}
          <Button
            tone="quiet"
            requiresActor
            disabled={false}
            onClick={() =>
              props.controller.inboxFilter({
                ...filter,
                recipient: { kind: "actor", id: props.context.writer.actorId ?? "" },
              })
            }
          >
            Use current actor as recipient
          </Button>
          {props.context.writer.runId !== null && (
            <Button
              onClick={() =>
                props.controller.inboxFilter({
                  ...filter,
                  recipient: { kind: "run", id: props.context.writer.runId ?? "" },
                })
              }
            >
              Use current run as recipient
            </Button>
          )}
        </div>
        <details className="rq-inbox-advanced">
          <summary>Filters and reading options</summary>
          <p>
            A consumer is a named reading queue for this recipient. Acknowledging a notification
            clears it only for that consumer; other consumers keep their own unread state.
          </p>
          <Field
            label="Inbox consumer ID"
            value={filter.consumerId}
            onChange={(event) =>
              props.controller.inboxFilter({ ...filter, consumerId: event.target.value })
            }
          />
          <Field
            label="After notification"
            value={filter.after}
            onChange={(event) =>
              props.controller.inboxFilter({ ...filter, after: event.target.value })
            }
          />
          <Field
            label="Through notification (optional)"
            value={filter.through}
            onChange={(event) =>
              props.controller.inboxFilter({ ...filter, through: event.target.value })
            }
          />
          <ReferencePicker
            context={props.context}
            endpoint={state.endpoint ?? endpoint(props.context)}
            kind="ticket"
            label="Inbox ticket filter"
            value={filter.ticketId}
            disabled={pinned}
            onChange={(ticketId) => props.controller.inboxFilter({ ...filter, ticketId })}
          />
          <Kinds
            values={filter.kinds}
            onChange={(kinds) => props.controller.inboxFilter({ ...filter, kinds })}
          />
          <label>
            <input
              type="checkbox"
              checked={filter.excludeSelf}
              onChange={(event) =>
                props.controller.inboxFilter({ ...filter, excludeSelf: event.target.checked })
              }
            />
            Exclude self
          </label>
        </details>
      </fieldset>
      <Toolbar label="Inbox reads">
        <Button
          tone="primary"
          disabled={filter.recipient.id.trim() === ""}
          onClick={() => {
            void props.controller.read({ kind: "inbox", filter, wait: false });
          }}
        >
          <Icon name="activity" />
          Read Inbox
        </Button>
        <Button
          onClick={() => {
            void props.controller.read({ kind: "inbox", filter, wait: true });
          }}
        >
          Wait for new notifications
        </Button>
        <span className="rq-read-help">
          Wait checks once for up to 25 seconds. Neither action marks anything handled.
        </span>
      </Toolbar>
      {pinned && (
        <p>
          This captured link keeps the original recipient, consumer, filters and through boundary.
          Open a new Inbox view to change them.
        </p>
      )}
    </section>
  );
}
export function RequestsFeature(props: RequestsFeatureProps) {
  const allowNewAction = useActorGate();
  const [titleSearch, setTitleSearch] = useState({ scope: "", text: "" });
  const { context, controller } = props,
    state = useSyncExternalStore(controller.subscribe, controller.get);
  const titleScope = JSON.stringify([
    context.route.connectionId,
    context.connection.generation,
    context.route.workspaceId,
    context.route.projectId,
  ]);
  const titleFilter = titleSearch.scope === titleScope ? titleSearch.text : "";
  const setTitleFilter = (text: string) => setTitleSearch({ scope: titleScope, text });
  const target = useMemo<RequestsTarget | null>(() => {
    if (props.target !== undefined) return props.target;
    const selected = targetFromRoute(context);
    if (selected !== null) return selected;
    if (context.route.discussion?.kind === "thread" && context.route.entityId !== null)
      return {
        connectionId: id(context.route.connectionId ?? "", "Connection"),
        workspaceId: id(context.route.workspaceId ?? "", "Workspace"),
        generation: integer(context.route.discussion.generation, "Generation", true),
        kind: "thread_requests",
        threadId: id(context.route.entityId, "Discussion"),
      };
    return null;
  }, [props.target, context]);
  const openedController = useRef<RequestsFeatureProps["controller"] | null>(null);
  useEffect(() => {
    controller.open(context, target, openedController.current !== controller);
    openedController.current = controller;
  }, [controller, context, target]);
  const routeKey = JSON.stringify([
    context.route.connectionId,
    context.route.workspaceId,
    context.route.projectId,
    context.connection.generation,
  ]);
  const ready =
    state.endpoint !== null &&
    sameEndpoint(state.endpoint, target ?? endpoint(context)) &&
    JSON.stringify(state.target) === JSON.stringify(target);
  useEffect(() => {
    if (!ready || controller.get() !== state) return;
    if (
      (target?.kind === "requests" || target?.kind === "request") &&
      !state.selectors.has("requests")
    )
      void controller.read({ kind: "requests", filter: state.filter });
    if (target?.kind === "request") {
      if (target.revision === null && !state.selectors.has("request"))
        void controller.read({ kind: "request", requestId: target.requestId });
      if (target.revision !== null && !state.selectors.has("history"))
        void controller.read({
          kind: "history",
          requestId: target.requestId,
          selectedRevision: target.revision,
        });
    }
    if (
      target?.kind === "inbox" &&
      (target.capture !== null ||
        (state.inboxFilter.recipient.kind === "actor" &&
          state.inboxFilter.recipient.id === context.writer.actorId)) &&
      state.inboxFilter.recipient.id.trim() !== "" &&
      !state.selectors.has("inbox")
    )
      void controller.read({ kind: "inbox", filter: state.inboxFilter, wait: false });
    if (target?.kind === "routing") {
      if (!state.selectors.has("teams")) void controller.read({ kind: "teams" });
      if (!state.selectors.has("subscriptions"))
        void controller.read({ kind: "subscriptions", recipient: null });
      if (target.entity?.kind === "team" && !state.selectors.has("team"))
        void controller.read({ kind: "team", teamId: target.entity.id });
      if (target.entity?.kind === "subscription" && !state.selectors.has("subscription"))
        void controller.read({ kind: "subscription", subscriptionId: target.entity.id });
    }
  }, [ready, target, state, controller, context.writer.actorId]);
  useEffect(() => {
    if (
      !ready ||
      target?.kind !== "request" ||
      target.revision === null ||
      state.selectors.has("historical_comment")
    )
      return;
    const slot = state.reads.get("history");
    if (slot?.kind !== "ready" || slot.value.captured.value.kind !== "history") return;
    const snapshot = slot.value.captured.value.page.items.find(
      (value) => value.id === target.requestId && value.revision === target.revision,
    );
    if (snapshot !== undefined)
      void controller.read({ kind: "historical_comment", pin: snapshot.question });
  }, [ready, target, state.reads, state.selectors, controller]);
  if (state.unexpected !== null) throw state.unexpected.error;
  // Selection changes must not unmount the collection. Only the detail pane waits
  // for its new target; endpoint changes still hide all previous captures.
  if (state.endpoint === null || !sameEndpoint(state.endpoint, target ?? endpoint(context)))
    return <p role="status">Opening discussions…</p>;
  const e = state.endpoint,
    selected = state.drafts.find((draft) => draft.id === state.selectedDraftId),
    navigate = (target: RequestsTarget) => context.navigate(requestsRoute(context, target));
  const fields = (): Fields => ({
    id: identity("question"),
    kind: "clarification",
    recipients: [],
    resolverId: context.writer.actorId ?? "",
    priority: "2",
    deadlineUnixMs: "",
    relatedIds: [],
    supersedesIds: [],
  });
  const create = (input: RequestsInput) => {
    if (!allowNewAction()) return null;
    return controller.create(input);
  };
  const recipient: EditableRecipient = { kind: "actor", id: context.writer.actorId ?? "" };
  const pane =
    target?.kind === "inbox"
      ? "inbox"
      : target?.kind === "routing"
        ? "routing"
        : target?.kind === "requests" || target?.kind === "request"
          ? "requests"
          : "discussions";
  return (
    <div className="wg-discussions-feature" data-pane={pane} key={routeKey}>
      <header className="dc-topbar wg-section-navigation">
        <h1>
          <Icon name="discussions" />
          Discussions
        </h1>
        <Toolbar label="Discussions sections">
          <Button
            tone="quiet"
            aria-pressed={pane === "discussions"}
            onClick={() =>
              context.navigate({
                view: "discussions",
                connectionId: e.connectionId,
                workspaceId: e.workspaceId,
                projectId: context.route.projectId,
                entityId: null,
              })
            }
          >
            <Icon name="discussions" />
            Discussions
          </Button>
          <Button
            tone="quiet"
            aria-pressed={pane === "requests"}
            onClick={() => navigate({ ...e, kind: "requests" })}
          >
            <Icon name="discussions" />
            Requests
          </Button>
          <Button
            tone="quiet"
            aria-pressed={pane === "inbox"}
            onClick={() => navigate({ ...e, kind: "inbox", capture: null })}
          >
            <Icon name="activity" />
            Inbox
          </Button>
          <Button
            tone="quiet"
            aria-pressed={pane === "routing"}
            onClick={() => navigate({ ...e, kind: "routing", entity: null })}
          >
            <Icon name="participants" />
            Routing
          </Button>
        </Toolbar>
        <Button
          tone="primary"
          onClick={() =>
            create({
              method: "request.ask",
              fields: fields(),
              body: "",
              destination: { kind: "new", title: "", boardId: "", ticketId: "" },
            })
          }
        >
          <Icon name="plus" />
          Ask a question
        </Button>
      </header>
      <div className="dc-section-intro" data-section={pane}>
        <span className="dc-section-intro-icon" aria-hidden="true">
          <Icon
            name={
              pane === "routing" ? "participants" : pane === "inbox" ? "activity" : "discussions"
            }
          />
        </span>
        <div>
          <strong>
            {pane === "discussions"
              ? "Keep the conversation connected"
              : pane === "requests"
                ? "Turn questions into clear decisions"
                : pane === "inbox"
                  ? "Catch up on updates addressed to you"
                  : "Choose who hears about what"}
          </strong>
          <p>
            {pane === "discussions"
              ? "Browse shared conversations in Threads, organize them by topic in Boards, or read direct deliveries in Received messages. Open a conversation to read its messages and reply."
              : pane === "requests"
                ? "A request is a question assigned to an actor—the person or agent responsible for answering it. See what is still open, read the original question, and follow responsibility and the final answer."
                : pane === "inbox"
                  ? "See notifications for the actor selected in the app, or choose another recipient. Opening an item does not mark it handled; acknowledge it when you have dealt with the update."
                  : "Use teams to group people and agents, and subscriptions to send them notifications about selected work. These settings control future delivery; they do not give anyone permission to change tickets."}
          </p>
        </div>
      </div>
      {state.historicalGeneration && (
        <p role="status">
          Retained endpoint generation {e.generation}; current profile generation is{" "}
          {context.connection.generation}. Existing drafts keep their original endpoint.
        </p>
      )}
      {state.issue !== null && (
        <p role="alert" className="wg-error">
          {state.issue}
        </p>
      )}
      {pane === "discussions" ? (
        props.renderDiscussions({
          renderRequests: (scope, thread) => (
            <details className="dc-linked-requests">
              <summary>Questions in this conversation</summary>
              <p>
                A request tracks a question that needs an answer from a specific actor. Ask here to
                keep it connected to this thread.
              </p>
              <Panel title="Requests in this discussion">
                <Button
                  onClick={() =>
                    create({
                      method: "request.ask",
                      fields: fields(),
                      body: "",
                      destination: { kind: "thread", threadId: thread?.value.id ?? "" },
                    })
                  }
                >
                  Ask in this discussion
                </Button>
                <Button
                  onClick={() => {
                    if (thread !== null)
                      void controller.read({
                        kind: "requests",
                        filter: { ...state.filter, scope: null, threadId: thread.value.id },
                      });
                  }}
                >
                  Read discussion requests
                </Button>
                <Button onClick={() => navigate({ ...scope, kind: "requests" })}>
                  Open Requests
                </Button>
                {thread !== null &&
                  state.selectors.get("requests")?.kind === "requests" &&
                  (() => {
                    const slot = state.reads.get("requests");
                    const capture =
                      slot?.kind === "ready"
                        ? slot.value
                        : slot && "previous" in slot
                          ? slot.previous
                          : undefined;
                    return (
                      capture?.selector.kind === "requests" &&
                      capture.selector.filter.threadId === thread.value.id &&
                      sameEndpoint(capture.captured.endpoint, scope)
                    );
                  })() && <RequestRead kind="requests" props={props} />}
              </Panel>
            </details>
          ),
          renderInbox: (scope) => (
            <Button onClick={() => navigate({ ...scope, kind: "inbox", capture: null })}>
              Open actionable Inbox
            </Button>
          ),
        })
      ) : pane === "requests" ? (
        <div className="rq-workspace" data-selected={target?.kind === "request"}>
          <ResizablePane
            id="wg-request-collection"
            label="request collection"
            side="start"
            initialWidth={420}
            minimum={320}
            maximum={560}
            className="rq-collection-pane"
          >
            <aside className="rq-collection" aria-label="Requests collection">
              <div className="rq-collection-tools">
                <Toolbar label="Request shortcuts">
                  <Button
                    tone="quiet"
                    onClick={() => {
                      const filter = defaultFilter(context);
                      controller.filter(filter);
                      setTitleFilter("");
                      void controller.read({ kind: "requests", filter });
                    }}
                  >
                    All
                  </Button>
                  <Button
                    tone="quiet"
                    aria-pressed={state.filter.openOnly}
                    onClick={() => {
                      const filter = { ...state.filter, openOnly: !state.filter.openOnly };
                      controller.filter(filter);
                      void controller.read({ kind: "requests", filter });
                    }}
                  >
                    Open only
                  </Button>
                  <Button
                    tone="quiet"
                    requiresActor
                    disabled={false}
                    onClick={() => {
                      const filter = { ...state.filter, resolverId: context.writer.actorId ?? "" };
                      controller.filter(filter);
                      void controller.read({ kind: "requests", filter });
                    }}
                  >
                    Assigned to me
                  </Button>
                </Toolbar>
                <Field
                  label="Filter loaded request titles"
                  placeholder="Filter this page by title…"
                  value={titleFilter}
                  onChange={(event) => setTitleFilter(event.currentTarget.value)}
                />
                <Filters props={props} />
              </div>
              <RequestRead kind="requests" props={props} titleFilter={titleFilter} />
            </aside>
          </ResizablePane>
          <main className="rq-detail" aria-label="Selected request">
            {!ready ? (
              <p role="status">Opening request…</p>
            ) : target?.kind === "request" ? (
              <>
                <Button
                  tone="quiet"
                  className="dc-back"
                  onClick={() => navigate({ ...e, kind: "requests" })}
                >
                  ← All requests
                </Button>
                <RequestRead
                  kind={target.revision === null ? "request" : "history"}
                  props={props}
                />
                {target.revision === null && <RequestRead kind="history" props={props} />}
                <RequestRead kind="historical_comment" props={props} />
              </>
            ) : (
              <div className="dc-empty-conversation">
                <Icon name="discussions" />
                <h2>Make the next decision together</h2>
                <p>
                  Choose a request to read the question, see who is responsible, and answer it.
                  Questions keep their original text and a record of the resolution.
                </p>
                <Button
                  onClick={() =>
                    create({
                      method: "request.create",
                      fields: fields(),
                      threadId: "",
                      commentId: "",
                      teams: [],
                      correlationId: "",
                      replyToId: "",
                    })
                  }
                >
                  Create from attached comment
                </Button>
              </div>
            )}
          </main>
        </div>
      ) : pane === "inbox" ? (
        <div className="rq-utility-scroll">
          <div className="rq-utility-page">
            <header className="rq-utility-heading">
              <div className="rq-page-icon">
                <Icon name="discussions" />
              </div>
              <div>
                <h2>Inbox</h2>
                <p>
                  Read what needs your attention, then acknowledge the notifications you have
                  handled.
                </p>
              </div>
            </header>
            <InboxControls props={props} />
            <RequestRead kind="inbox" props={props} />
          </div>
        </div>
      ) : (
        <div className="rq-utility-scroll">
          <div className="rq-utility-page rq-routing">
            <header className="rq-utility-heading">
              <div className="rq-page-icon">
                <Icon name="workflow" />
              </div>
              <div>
                <h2>Notification routing</h2>
                <p>
                  Choose who receives future updates. Existing request deliveries keep their
                  original recipients.
                </p>
              </div>
            </header>
            <Toolbar label="Routing configuration">
              <Button
                onClick={() =>
                  create({
                    method: "team.put",
                    existing: false,
                    teamId: identity("team"),
                    title: "",
                    members: [],
                  })
                }
              >
                Create team
              </Button>
              <Button
                onClick={() =>
                  create({
                    method: "subscription.put",
                    existing: false,
                    subscriptionId: identity("subscription"),
                    recipient,
                    filter: { scope: null, threadId: "", kinds: [] },
                    active: true,
                  })
                }
              >
                Create subscription
              </Button>
            </Toolbar>
            <section className="rq-routing-section">
              <header>
                <Icon name="participants" />
                <div>
                  <h3>Teams</h3>
                  <p>
                    Named groups of actors or runs. Team members are expanded when a request is
                    delivered.
                  </p>
                </div>
              </header>
              <RequestRead kind="teams" props={props} />
              {state.selectors.has("team") && (
                <details className="dc-routing-details" open>
                  <summary>Selected team details</summary>
                  <RequestRead kind="team" props={props} />
                </details>
              )}
            </section>
            <section className="rq-routing-section">
              <header>
                <Icon name="activity" />
                <div>
                  <h3>Subscriptions</h3>
                  <p>
                    Send matching future notifications to an actor or run. Scope, thread and
                    event-kind filters control what is delivered.
                  </p>
                </div>
              </header>
              <RequestRead kind="subscriptions" props={props} />
              {state.selectors.has("subscription") && (
                <details className="dc-routing-details" open>
                  <summary>Selected subscription details</summary>
                  <RequestRead kind="subscription" props={props} />
                </details>
              )}
            </section>
          </div>
        </div>
      )}
      {state.drafts.length > 0 && (
        <details className="dc-draft-drawer">
          <summary>Retained request actions ({state.drafts.length})</summary>
          <ul>
            {state.drafts.map((draft) => (
              <li key={draft.id}>
                <Button onClick={() => controller.select(draft.id)}>
                  {labels[draft.input.method]} · original writer {draft.context.writer.actorId}
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {selected !== undefined && <Editor draft={selected} props={props} />}
    </div>
  );
}
