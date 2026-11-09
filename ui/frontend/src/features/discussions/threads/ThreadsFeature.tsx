import { useActorGate } from "../../../components/ActorAccess";
import { ReferenceFields } from "../ReferenceFields";
import { ActionGuide } from "../ActionGuide";
import { ActorAvatar } from "../../../components/ActorAvatar";
import { ManagementPresentation } from "../../connections/management-presentation";
import "../discussion-continuity.css";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ResizablePane } from "../../../components/ResizablePane";
import { Icon } from "../../../components/Icon";
import { Dialog } from "../../../components/Dialog";
import { ObservationNotice } from "../../../components/ObservationNotice";
import { Badge, Button, Field, Panel, Select, Toolbar } from "../../../components/Primitives";
import type { ManagedAction } from "../../../core/state/operations";
import { failureText } from "../../connections/failure";
import { LazyDetails, OperationPanel } from "../../connections/shared";
import { endpoint, identity, ThreadsInputError, validId } from "./model";
import { discussionRoute, targetFromRoute } from "./navigation";
import { ThreadFields } from "./ThreadFields";
import { ThreadRead } from "./ThreadReads";
import { ReceivedBrowser } from "./ReceivedBrowser";
import type {
  DiscussionTarget,
  ThreadsDraft,
  ThreadsFeatureProps,
  ThreadsInput,
  ThreadsRead,
} from "./types";
const labels: Readonly<Record<ThreadsInput["method"], string>> = {
  "board.put": "Board details",
  "thread.put": "Thread details",
  "thread.reply": "Write reply",
  "thread.attach": "Attach existing comment",
  "thread.pin_message": "Pin message",
  "comment.add": "Write ticket comment",
  "comment.edit": "Edit own comment",
  "comment.tombstone": "Remove own comment",
  "message.send": "Send direct message",
};
function Editor({
  draft,
  props,
}: {
  readonly draft: ThreadsDraft;
  readonly props: ThreadsFeatureProps;
}) {
  const [unexpected, setUnexpected] = useState<{ error: unknown } | null>(null),
    [issue, setIssue] = useState("");
  const managed = useSyncExternalStore(props.operations.subscribe, () =>
    props.operations.get(draft.id),
  );
  if (draft.unexpected !== null) throw draft.unexpected.error;
  if (unexpected !== null) throw unexpected.error;
  if (managed?.phase.kind === "unexpected_error") throw managed.phase.error;
  const operation = managed?.operation,
    pending = managed?.phase.kind === "pending",
    locked = draft.phase.kind === "capturing" || draft.phase.kind === "captured",
    simple = ["comment.add", "thread.reply", "message.send"].includes(draft.input.method);
  const perform = (action: ManagedAction) => {
    setIssue("");
    void props.operations
      .act(draft.id, action)
      .then((result) => {
        if (!result.ok) setIssue(failureText(result.failure));
      })
      .catch((error: unknown) => setUnexpected({ error }));
  };
  const currentWriter = props.context.writer,
    original = draft.context.writer,
    changed = currentWriter.actorId !== original.actorId || currentWriter.runId !== original.runId;
  const target =
    draft.input.method === "board.put"
      ? `Board ${draft.input.fields.id || "to be named"}`
      : draft.input.method === "thread.put"
        ? `Thread ${draft.input.fields.id || "to be named"}`
        : "threadId" in draft.input
          ? `Thread ${draft.input.threadId}`
          : "commentId" in draft.input
            ? `Comment ${draft.input.commentId}`
            : draft.input.method === "comment.add"
              ? `Ticket discussion ${draft.input.target.kind === "workspace" ? "workspace" : draft.input.target.id}`
              : "Direct recipients below";
  return (
    <Dialog title={labels[draft.input.method]} wide onClose={() => props.controller.select(null)}>
      <ManagementPresentation value={true}>
        <div className="dc-editor">
          <ActionGuide method={draft.input.method} simple={simple} />
          <p className="dc-editor-author">
            <ActorAvatar actor={original.actorId} /> {target} · acting author{" "}
            <strong>{original.actorId}</strong>
            {changed && <Badge tone="warning">Original writer retained after switch</Badge>}
          </p>
          <div className="dc-editor-fields">
            <ReferenceFields context={props.context} endpoint={draft.endpoint}>
              <ThreadFields
                input={draft.input}
                disabled={locked}
                onChange={(input) => props.controller.edit(draft.id, input)}
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
              Unconfirmed {managed.phase.action}: {failureText(managed.phase.failure)}. Preserve
              this original action; no automatic retry occurs.
            </p>
          )}
          {draft.phase.kind === "loading" && (
            <p role="status">Loading the current record… Your typed text will not be replaced.</p>
          )}
          {draft.phase.kind === "capturing" && <p role="status">Preparing this original action…</p>}
          {operation !== undefined && operation !== null && (
            <p role="status">
              Saved action: <strong>{operation.state.kind}</strong>
            </p>
          )}
          {operation?.state.kind === "sending" && (
            <ObservationNotice status={managed?.observation} />
          )}{" "}
          {(operation?.state.kind === "rejected" ||
            operation?.state.kind === "outcome_unknown") && (
            <p role="alert">
              {operation.state.problem.kind}: {operation.state.problem.message}
              {operation.state.kind === "outcome_unknown"
                ? ". Outcome is uncertain; inspect or retry only this exact saved request."
                : ". This action was rejected. A deliberate new draft can refresh current guards; this saved request remains unchanged."}
            </p>
          )}
          {operation?.state.kind === "committed" && (
            <p>
              Committed with the original acting author. Refresh the discussion to read the new
              current capture.
            </p>
          )}
          <Toolbar label="Discussion action controls">
            {!locked && (
              <Button
                tone="primary"
                disabled={draft.phase.kind === "loading" || pending}
                onClick={() => {
                  void (simple
                    ? props.controller.post(draft.id)
                    : props.controller.review(draft.id));
                }}
              >
                {simple
                  ? draft.input.method === "message.send"
                    ? "Send message"
                    : "Post"
                  : "Review"}
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
            {operation !== undefined && operation !== null && (
              <Button disabled={pending} onClick={() => perform("inspect")}>
                Inspect saved action
              </Button>
            )}
            {!locked &&
              (("existing" in draft.input && draft.input.existing) ||
                draft.input.method === "comment.edit" ||
                draft.input.method === "comment.tombstone") && (
                <>
                  <Button
                    disabled={draft.phase.kind === "loading"}
                    onClick={() => {
                      void props.controller.loadGuards(draft.id);
                    }}
                  >
                    Load current{" "}
                    {draft.input.method === "board.put"
                      ? "board"
                      : draft.input.method === "thread.put"
                        ? "thread"
                        : "comment"}
                  </Button>
                  {draft.input.method !== "comment.tombstone" && (
                    <Button
                      disabled={draft.phase.kind === "loading"}
                      onClick={() => props.controller.fill(draft.id)}
                    >
                      Copy loaded values into editor
                    </Button>
                  )}
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
function initial(
  method: ThreadsInput["method"],
  target: DiscussionTarget | null,
  props: ThreadsFeatureProps,
): ThreadsInput {
  const threadId = target?.kind === "thread" ? target.threadId : "",
    boardId = target?.kind === "board" ? target.boardId : "";
  switch (method) {
    case "board.put":
      return {
        method,
        existing: false,
        fields: {
          id: identity("board"),
          title: "",
          scope:
            props.context.route.projectId === null
              ? { kind: "workspace" }
              : { kind: "project", id: props.context.route.projectId },
        },
      };
    case "thread.put":
      return {
        method,
        existing: false,
        fields: {
          id: identity("thread"),
          boardId,
          title: "",
          participants: props.context.writer.actorId ?? "",
          mentions: "",
          links: [],
          status: "open",
          closurePolicy: "manual",
          pinned: false,
        },
      };
    case "thread.reply":
      return { method, threadId, body: "", kind: "comment", replyToId: "" };
    case "thread.attach":
      return { method, threadId, commentId: "" };
    case "thread.pin_message":
      return { method, threadId, commentId: "", pinned: true };
    case "comment.add":
      if (target?.kind !== "ticket_discussion")
        throw new ThreadsInputError("Open a ticket discussion before writing a ticket comment.");
      return {
        method,
        target: { kind: "ticket", id: target.ticketId },
        body: "",
        kind: "comment",
        replyToId: "",
      };
    case "comment.edit":
      return { method, commentId: "", body: "" };
    case "comment.tombstone":
      return { method, commentId: "" };
    case "message.send":
      return {
        method,
        messageId: identity("message"),
        body: "",
        actorRecipients: "",
        runRecipients: "",
        teamIds: "",
        ticketId: "",
        replyToMessageId: "",
        correlationId: "",
      };
  }
}
/** Default tailored discussion host. Every composer belongs to the application
 * controller, including unsent text before registration; reads are disposable. */
export function ThreadsFeature(props: ThreadsFeatureProps) {
  const allowNewAction = useActorGate();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [ticketOpen, setTicketOpen] = useState(false);
  const { context, controller } = props,
    state = useSyncExternalStore(controller.subscribe, controller.get),
    [ticketId, setTicketId] = useState(""),
    [localIssue, setLocalIssue] = useState(""),
    [unexpected, setUnexpected] = useState<{ error: unknown } | null>(null);
  const resolved = useMemo(() => {
    try {
      return { target: props.target ?? targetFromRoute(context), issue: null };
    } catch (error: unknown) {
      if (error instanceof ThreadsInputError) return { target: undefined, issue: error.message };
      throw error;
    }
  }, [props.target, context]);
  const target = resolved.target;
  const targetKey = JSON.stringify(target ?? null),
    opened = useRef<string | null>(null);
  useEffect(() => {
    if (resolved.issue === null) controller.open(context, target);
  }, [controller, context, target, resolved.issue]);
  useEffect(() => {
    if (resolved.issue !== null) return;
    const current = controller.get(),
      e = current.endpoint,
      key = JSON.stringify([e, targetKey, target === undefined ? context.route.projectId : null]);
    if (e === null || opened.current === key) return;
    opened.current = key;
    const run = (selector: ThreadsRead) => {
      void controller.read(selector).catch((error: unknown) => setUnexpected({ error }));
    };
    if (target?.kind !== "direct_messages") {
      if (!current.selectors.has("boards")) run({ kind: "boards", scope: current.filter.scope });
      if (!current.selectors.has("threads")) run({ kind: "threads", filter: current.filter });
    }
    if (target?.kind === "board") {
      run({ kind: "board", boardId: target.boardId });
    } else if (target?.kind === "thread") run({ kind: "thread", threadId: target.threadId });
    else if (target?.kind === "ticket_discussion") {
      run({ kind: "ticket_comments", ticketId: target.ticketId });
      if (target.comment !== null)
        run({
          kind: "comment_history",
          commentId: target.comment.id,
          target: { kind: "ticket", id: target.ticketId },
          selectedRevision: target.comment.revision,
        });
    } else if (target?.kind === "direct_messages") {
      if (target.capture !== null) run({ kind: "messages", filter: current.messageFilter });
    }
  }, [controller, targetKey, target, state.endpoint, resolved.issue, context.route.projectId]);
  if (resolved.issue !== null)
    return (
      <Panel title="Discussion link unavailable">
        <p role="alert">{resolved.issue}</p>
      </Panel>
    );
  if (unexpected !== null) throw unexpected.error;
  if (state.unexpected !== null) throw state.unexpected.error;
  const effective = state.endpoint ?? endpoint(context),
    selected = state.drafts.find((draft) => draft.id === state.selectedDraftId),
    received = target?.kind === "direct_messages";
  const open = (next: DiscussionTarget) => context.navigate(discussionRoute(context, next));
  const run = (selector: ThreadsRead) => {
    void controller.read(selector).catch((error: unknown) => setUnexpected({ error }));
  };
  const create = (method: ThreadsInput["method"]) => {
    if (!allowNewAction()) return;
    setLocalIssue("");
    try {
      controller.create(initial(method, target ?? null, props));
    } catch (error: unknown) {
      if (error instanceof ThreadsInputError) setLocalIssue(error.message);
      else setUnexpected({ error });
    }
  };
  const filter = state.filter,
    messages = state.messageFilter,
    pinned = target?.kind === "direct_messages" && target.capture !== null;
  return (
    <section
      className="dc-threads"
      aria-label="Discussions"
      data-selected={target?.kind === "thread" || target?.kind === "ticket_discussion"}
      data-board-selected={target?.kind === "board"}
    >
      {state.historicalGeneration && (
        <p role="status">
          This link retains connection generation {effective.generation}. If the endpoint is no
          longer available, reads fail explicitly; the current generation is not substituted.
          Existing saved actions keep their original target.
        </p>
      )}
      {state.unavailable !== null && <p role="alert">{state.unavailable}</p>}
      {(state.issue !== null || localIssue !== "") && (
        <p role="alert" className="wg-error">
          {state.issue ?? localIssue}
        </p>
      )}
      <div className="dc-browsebar">
        <Toolbar label="Discussion views">
          <Button
            tone="quiet"
            aria-pressed={!received}
            onClick={() =>
              context.navigate({
                view: "discussions",
                connectionId: context.route.connectionId,
                workspaceId: context.route.workspaceId,
                projectId: context.route.projectId,
                entityId: null,
              })
            }
          >
            <Icon name="board" />
            Boards and threads
          </Button>
          <Button
            tone="quiet"
            aria-pressed={received}
            onClick={() => open({ ...effective, kind: "direct_messages", capture: null })}
          >
            <Icon name="discussions" />
            Received messages
          </Button>
        </Toolbar>
        <div className="dc-create-actions">
          {!received && (
            <Button tone="quiet" onClick={() => create("board.put")}>
              <Icon name="board" />
              Create board
            </Button>
          )}
          <Button onClick={() => create(received ? "message.send" : "thread.put")}>
            <Icon name="plus" />
            {received ? "New direct message" : "New thread"}
          </Button>
          <details className="dc-more-menu">
            <summary aria-label="More discussion actions">•••</summary>
            <div>
              {!received && (
                <Button onClick={() => create("message.send")}>New direct message</Button>
              )}
              <Button onClick={() => setTicketOpen(true)}>Open a ticket discussion</Button>
              {target?.kind === "ticket_discussion" && (
                <Button onClick={() => create("comment.add")}>Write ticket comment</Button>
              )}
            </div>
          </details>
        </div>
      </div>
      {ticketOpen && (
        <Dialog title="Open a ticket discussion" onClose={() => setTicketOpen(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              try {
                open({
                  ...effective,
                  kind: "ticket_discussion",
                  ticketId: validId(ticketId, "Ticket"),
                  comment: null,
                });
                setTicketOpen(false);
              } catch (error) {
                if (error instanceof ThreadsInputError) setLocalIssue(error.message);
                else setUnexpected({ error });
              }
            }}
          >
            <Field
              label="Ticket discussion ID"
              value={ticketId}
              onChange={(event) => setTicketId(event.currentTarget.value)}
            />
            {localIssue && <p role="alert">{localIssue}</p>}
            <Button tone="primary" type="submit">
              Open ticket discussion
            </Button>
          </form>
        </Dialog>
      )}
      {received ? (
        <ReceivedBrowser
          props={props}
          filter={messages}
          pinned={pinned}
          onRead={() => run({ kind: "messages", filter: messages })}
        />
      ) : (
        <div className="wg-discussions-layout">
          <ResizablePane
            id="wg-discussion-collection"
            label="discussion collection"
            side="start"
            initialWidth={420}
            minimum={320}
            maximum={560}
            className="wg-discussions-pane"
          >
            <aside className="wg-discussions-master" aria-label="Discussion collection">
              <div className="dc-collection-heading">
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    run({ kind: "threads", filter });
                  }}
                >
                  <Field
                    label="Search thread titles"
                    placeholder="Filter thread titles…"
                    value={filter.text}
                    onChange={(event) =>
                      controller.filter({ ...filter, text: event.currentTarget.value })
                    }
                  />
                </form>
                <Button
                  tone="quiet"
                  aria-label="Filter boards and threads"
                  onClick={() => setFiltersOpen(true)}
                >
                  <Icon name="filter" />
                </Button>
              </div>
              {filtersOpen && (
                <Dialog
                  title="Filter discussions"
                  description="Narrow the collection by board, participant or status. Filters only change what you see; they do not change any conversation."
                  onClose={() => setFiltersOpen(false)}
                >
                  <div className="dc-editor">
                    <Panel title="Browse threads">
                      <Select
                        label="Thread scope"
                        value={filter.scope?.kind ?? "all"}
                        onChange={(event) =>
                          controller.filter({
                            ...filter,
                            scope:
                              event.target.value === "all"
                                ? null
                                : event.target.value === "workspace"
                                  ? { kind: "workspace" }
                                  : {
                                      kind: "project",
                                      id: validId(
                                        context.route.projectId ?? "",
                                        "Selected project",
                                      ),
                                    },
                          })
                        }
                      >
                        <option value="all">All scopes</option>
                        <option value="workspace">Workspace</option>
                        <option value="project" disabled={context.route.projectId === null}>
                          Selected project
                        </option>
                      </Select>
                      <Field
                        label="Board filter"
                        value={filter.boardId}
                        onChange={(event) =>
                          controller.filter({ ...filter, boardId: event.target.value })
                        }
                      />
                      <Field
                        label="Participant or mention filter"
                        value={filter.actorId}
                        onChange={(event) =>
                          controller.filter({ ...filter, actorId: event.target.value })
                        }
                      />
                      <Select
                        label="Thread status filter"
                        value={filter.status}
                        onChange={(event) => {
                          const status = event.target.value;
                          if (
                            status === "all" ||
                            status === "open" ||
                            status === "awaiting_response" ||
                            status === "resolved"
                          )
                            controller.filter({ ...filter, status });
                        }}
                      >
                        <option value="all">All statuses</option>
                        <option value="open">Open</option>
                        <option value="awaiting_response">Awaiting response</option>
                        <option value="resolved">Resolved</option>
                      </Select>
                      <label>
                        <input
                          type="checkbox"
                          checked={filter.unresolved}
                          onChange={(event) =>
                            controller.filter({ ...filter, unresolved: event.target.checked })
                          }
                        />{" "}
                        Unresolved only
                      </label>
                      <Button
                        onClick={() => {
                          run({ kind: "boards", scope: filter.scope });
                          run({ kind: "threads", filter });
                          setFiltersOpen(false);
                        }}
                      >
                        Apply discussion filters
                      </Button>
                    </Panel>
                  </div>
                </Dialog>
              )}
              <Toolbar label="Thread shortcuts">
                <Button
                  tone="quiet"
                  aria-pressed={!filter.unresolved && filter.actorId === ""}
                  onClick={() => {
                    const next = {
                      ...filter,
                      unresolved: false,
                      actorId: "",
                      status: "all" as const,
                    };
                    controller.filter(next);
                    run({ kind: "threads", filter: next });
                  }}
                >
                  All threads
                </Button>
                <Button
                  tone="quiet"
                  aria-pressed={filter.unresolved}
                  onClick={() => {
                    const next = { ...filter, unresolved: true, status: "all" as const };
                    controller.filter(next);
                    run({ kind: "threads", filter: next });
                  }}
                >
                  Unresolved
                </Button>
                <Button
                  tone="quiet"
                  requiresActor
                  disabled={false}
                  aria-pressed={
                    context.writer.actorId !== null && filter.actorId === context.writer.actorId
                  }
                  onClick={() => {
                    if (context.writer.actorId !== null) {
                      const next = { ...filter, actorId: context.writer.actorId };
                      controller.filter(next);
                      run({ kind: "threads", filter: next });
                    }
                  }}
                >
                  With me
                </Button>
              </Toolbar>
              <ThreadRead kind="boards" props={props} />
              <ThreadRead kind="threads" props={props} />
            </aside>
          </ResizablePane>
          <div className="wg-discussions-detail" aria-label="Selected discussion">
            {target !== undefined && (
              <Button
                tone="quiet"
                className="dc-back"
                onClick={() =>
                  context.navigate({
                    view: "discussions",
                    connectionId: context.route.connectionId,
                    workspaceId: context.route.workspaceId,
                    projectId: context.route.projectId,
                    entityId: null,
                  })
                }
              >
                ← All discussions
              </Button>
            )}
            {target === undefined && (
              <div className="dc-empty-conversation">
                <Icon name="discussions" />
                <h2>Your shared conversations</h2>
                <p>
                  Choose a thread to read messages and reply. Use Requests for questions that need
                  an accountable answer, or Inbox to review deliveries.
                </p>
                <Button onClick={() => create("thread.put")}>Start a thread</Button>
              </div>
            )}
            {target?.kind === "board" && <ThreadRead kind="board" props={props} />}
            {target?.kind === "thread" && (
              <>
                <ThreadRead kind="thread" props={props} />
                {state.reads.has("thread_history") && (
                  <details className="dc-history-disclosure" open>
                    <summary>Earlier conversation settings</summary>
                    <p>
                      These are previous titles, participants and settings. Open a thread to read
                      its current conversation.
                    </p>
                    <ThreadRead kind="thread_history" props={props} />
                  </details>
                )}
              </>
            )}
            {target?.kind === "ticket_discussion" && (
              <ThreadRead kind="ticket_comments" props={props} />
            )}
            {state.reads.has("comment_history") && (
              <details className="dc-history-disclosure" open>
                <summary>Earlier message versions</summary>
                <p>Recorded versions keep the original author and text for each edit.</p>
                <ThreadRead kind="comment_history" props={props} />
              </details>
            )}
          </div>
        </div>
      )}
      {state.drafts.length > 0 && (
        <details className="dc-draft-drawer">
          <summary>Retained discussion drafts ({state.drafts.length})</summary>
          <Toolbar label="Retained discussion drafts">
            {state.drafts.map((draft) => (
              <Button key={draft.id} onClick={() => controller.select(draft.id)}>
                {labels[draft.input.method]} · {draft.context.writer.actorId} · {draft.phase.kind}
              </Button>
            ))}
          </Toolbar>
        </details>
      )}
      {selected !== undefined && <Editor key={selected.id} draft={selected} props={props} />}
    </section>
  );
}
