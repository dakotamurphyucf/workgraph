import { ThreadPreview } from "../ThreadPreview";
import { ActorAvatar } from "../../../components/ActorAvatar";
import { Icon } from "../../../components/Icon";
import { InlineReply } from "./InlineReply";
import { RecordedTime } from "../RecordedTime";
import { useMemo, useState } from "react";
import { Badge, Button, Panel, Toolbar } from "../../../components/Primitives";
import { ContentViewer, type ContentSource } from "../../../content";
import { jsonField } from "../../../core/json";
import type { Identifier } from "../../../core/protocol/types";
import { failureText } from "../../connections/failure";
import { LazyDetails } from "../../connections/shared";
import { complete, identity, validId } from "./model";
import { discussionRoute } from "./navigation";
import type {
  Comment,
  DiscussionTarget,
  ReadCapture,
  ThreadsFeatureProps,
  ThreadsInput,
  ThreadsRead,
} from "./types";
/** Only visible message bodies enter the shared bounded worker. Source bytes
 * remain immutable; leaving the viewport cancels browser-only rendering work. */
function Body({
  value,
  identity,
  partial,
}: {
  readonly value: string;
  readonly identity: string;
  readonly partial: boolean;
}) {
  const [tools, setTools] = useState(false);
  const source = useMemo<ContentSource>(
    () => ({
      key: identity,
      label: "Discussion body",
      bytes: new TextEncoder().encode(value),
      completeness: partial ? "partial" : "complete",
      hints: { mime: "text/markdown", intent: "prose" },
    }),
    [value, identity, partial],
  );
  return (
    <div className={`wg-discussion-body ${tools ? "wg-discussion-body--tools" : ""}`}>
      {partial && (
        <p role="status">
          Partial body preview: the captured response has omissions or incomplete budget metadata.
        </p>
      )}
      <ContentViewer source={source} chrome="compact" />
      <Button tone="quiet" aria-expanded={tools} onClick={() => setTools((value) => !value)}>
        {tools ? "Hide formatting tools" : "Formatting tools"}
      </Button>
    </div>
  );
}

export function CommentCard({
  value,
  props,
  capture,
  historical = false,
  threadId,
}: {
  readonly value: Comment;
  readonly props: ThreadsFeatureProps;
  readonly capture: ReadCapture;
  readonly historical?: boolean;
  readonly threadId?: Identifier;
}) {
  const e = capture.captured.endpoint,
    controller = props.controller;
  const create = (input: ThreadsInput) => controller.create(input);
  const navigate = (target: DiscussionTarget) =>
    props.context.navigate(discussionRoute(props.context, target));
  const own = props.context.writer.actorId === value.authorId;
  return (
    <article
      className="wg-comment"
      data-kind={value.kind}
      aria-label={`Comment ${value.id} revision ${value.revision}`}
    >
      <header className="wg-comment-heading">
        <ActorAvatar actor={value.authorId} />
        <strong>{value.authorId}</strong>
        <RecordedTime value={value.createdAt} />
        {value.kind !== "comment" && <Badge>{value.kind}</Badge>}
        {historical && <Badge>Historical revision {value.revision}</Badge>}
        {value.tombstone && <Badge>Removed</Badge>}
        {value.revision !== "1" && (
          <span className="wg-hint">
            Edited <RecordedTime value={value.timestamp} /> by {value.actorId}
          </span>
        )}
      </header>
      {value.tombstone ? (
        <p>This revision is a tombstone. Earlier history remains available.</p>
      ) : (
        <Body
          value={value.body}
          identity={`${e.connectionId}:${e.generation}:${value.id}:${value.revision}`}
          partial={!complete(capture.captured)}
        />
      )}
      <Toolbar label={`Actions for comment ${value.id}`}>
        {threadId !== undefined ? (
          <Button
            requiresActor
            onClick={() =>
              create({
                method: "thread.reply",
                threadId,
                body: "",
                kind: "comment",
                replyToId: value.id,
              })
            }
          >
            Reply
          </Button>
        ) : (
          <Button
            requiresActor
            onClick={() =>
              create({
                method: "comment.add",
                target: value.target,
                body: "",
                kind: "comment",
                replyToId: value.id,
              })
            }
          >
            Reply
          </Button>
        )}
        <details className="wg-comment-actions">
          <summary>More actions</summary>
          <p>
            Edit your message or see its earlier versions. Removing it keeps the recorded history.
          </p>
          <div className="wg-toolbar">
            {own && value.origin === "authored" && !value.tombstone && !historical && (
              <>
                <Button
                  requiresActor
                  onClick={() =>
                    create({ method: "comment.edit", commentId: value.id, body: value.body })
                  }
                >
                  Edit own comment
                </Button>
                <Button
                  requiresActor
                  onClick={() => create({ method: "comment.tombstone", commentId: value.id })}
                >
                  Remove own comment
                </Button>
              </>
            )}
            <Button
              onClick={() => {
                void controller.read({
                  kind: "comment_history",
                  commentId: value.id,
                  target: value.target,
                  selectedRevision: null,
                });
              }}
            >
              Comment history
            </Button>
            {value.target.kind === "ticket" && (
              <Button
                onClick={() =>
                  navigate({
                    ...e,
                    kind: "ticket_discussion",
                    ticketId:
                      value.target.kind === "ticket"
                        ? value.target.id
                        : validId("unreachable", "Ticket"),
                    comment: { id: value.id, revision: value.revision },
                  })
                }
              >
                Open exact comment version
              </Button>
            )}
            {threadId !== undefined && (
              <Button
                requiresActor
                onClick={() =>
                  create({
                    method: "thread.pin_message",
                    threadId,
                    commentId: value.id,
                    pinned: true,
                  })
                }
              >
                Pin message
              </Button>
            )}
          </div>
        </details>
      </Toolbar>
    </article>
  );
}
function Rows({
  capture,
  props,
}: {
  readonly capture: ReadCapture;
  readonly props: ThreadsFeatureProps;
}) {
  const value = capture.captured.value,
    e = capture.captured.endpoint;
  const open = (target: DiscussionTarget) =>
    props.context.navigate(discussionRoute(props.context, target));
  if (value.kind === "boards")
    return (
      <>
        {value.page.items.length === 0 && (
          <div className="dc-collection-empty">
            <Icon name="board" />
            <strong>No boards here yet</strong>
            <p>
              Boards group conversations by topic. Create one for a project, or use a workspace
              board for shared discussion.
            </p>
          </div>
        )}
        {value.page.items.map((board) => (
          <article
            className="dc-list-row dc-board-row"
            data-selected={
              props.context.route.discussion?.kind === "board" &&
              props.context.route.entityId === board.id
            }
            key={board.id}
          >
            <h3>
              <Button onClick={() => open({ ...e, kind: "board", boardId: board.id })}>
                <Icon name="board" />
                <span>{board.title || board.id}</span>
              </Button>
            </h3>
            <p>
              {board.scope.kind === "workspace" ? "Workspace board" : `Project ${board.scope.id}`}
            </p>
          </article>
        ))}
      </>
    );
  if (value.kind === "board")
    return (
      <>
        <header className="dc-board-heading">
          <span className="dc-page-symbol">
            <Icon name="board" />
          </span>
          <div>
            <span className="dc-eyebrow">Discussion board</span>
            <h2>{value.board.title}</h2>
          </div>
        </header>
        <p className="dc-board-intro">
          A board keeps related conversations together. Choose a thread from the list to read or
          reply, or start a new conversation in this board.
        </p>
        <p>
          {value.board.scope.kind === "workspace"
            ? "Workspace board"
            : `Project ${value.board.scope.id}`}
        </p>
        <Button
          requiresActor
          onClick={() =>
            props.controller.create({
              method: "board.put",
              existing: true,
              fields: { id: value.board.id, title: value.board.title, scope: value.board.scope },
            })
          }
        >
          Edit board
        </Button>
        <Button
          requiresActor
          tone="primary"
          onClick={() =>
            props.controller.create({
              method: "thread.put",
              existing: false,
              fields: {
                id: identity("thread"),
                boardId: value.board.id,
                title: "",
                participants: props.context.writer.actorId ?? "",
                mentions: "",
                links: [],
                status: "open",
                closurePolicy: "manual",
                pinned: false,
              },
            })
          }
        >
          Start a thread in this board
        </Button>
      </>
    );
  if (value.kind === "threads" || value.kind === "thread_history")
    return (
      <>
        {value.page.items.length === 0 && (
          <div className="dc-collection-empty">
            <Icon name="discussions" />
            <strong>No matching threads</strong>
            <p>Start a conversation in a board, or adjust your filters to find existing threads.</p>
          </div>
        )}
        {value.page.items.map((thread) => (
          <article
            className="dc-list-row dc-thread-row"
            data-selected={
              props.context.route.discussion?.kind === "thread" &&
              props.context.route.entityId === thread.id
            }
            key={`${thread.id}:${thread.revision}`}
          >
            <h3>
              <Button onClick={() => open({ ...e, kind: "thread", threadId: thread.id })}>
                <Icon name="discussions" />
                <span>{thread.title || thread.id}</span>
              </Button>
            </h3>
            <p>
              <span className="dc-thread-status" data-status={thread.status}>
                {thread.status.replaceAll("_", " ")}
              </span>{" "}
              · {thread.pinned ? "Pinned · " : ""}
              {thread.commentIds.length} messages
              <span className="dc-preview-participants" title={thread.participants.join(", ")}>
                {thread.participants.slice(0, 3).map((actor) => (
                  <span className="dc-person" key={actor}>
                    <ActorAvatar actor={actor} />
                  </span>
                ))}
              </span>
              {thread.participants.length > 3 && ` +${thread.participants.length - 3}`}
              {thread.participants.length === 0 && "No named participants"}
              {value.kind === "thread_history" ? ` · metadata revision ${thread.revision}` : ""}
            </p>
            {value.kind === "threads" && (
              <ThreadPreview thread={thread} capture={capture} context={props.context} />
            )}
          </article>
        ))}
      </>
    );
  if (value.kind === "thread") {
    const thread = value.thread,
      related = thread.related;
    return (
      <>
        <header className="dc-conversation-heading">
          <span className="dc-eyebrow">Discussion</span>
          <h2>{thread.title}</h2>
          <p>
            <span className="dc-thread-status" data-status={thread.status}>
              {thread.status.replaceAll("_", " ")}
            </span>{" "}
            {thread.pinned && <Badge>Pinned</Badge>}
          </p>
          <div className="dc-people">
            {thread.participants.map((actor) => (
              <span className="dc-person" key={actor}>
                <ActorAvatar actor={actor} />
                {actor}
              </span>
            ))}
          </div>
          {thread.mentions.length > 0 && <p>Mentions: {thread.mentions.join(", ")}</p>}
        </header>
        <details className="dc-thread-options">
          <summary>Manage this conversation</summary>
          <p>
            Edit its title or participants, attach an existing comment, or inspect previous changes.
            Replies appear below.
          </p>
          <Toolbar label="Thread actions">
            <Button
              requiresActor
              onClick={() =>
                props.controller.create({
                  method: "thread.reply",
                  threadId: thread.id,
                  body: "",
                  kind: "comment",
                  replyToId: "",
                })
              }
            >
              Write reply
            </Button>
            <Button
              requiresActor
              onClick={() =>
                props.controller.create({
                  method: "thread.put",
                  existing: true,
                  fields: {
                    id: thread.id,
                    boardId: thread.boardId,
                    title: thread.title,
                    participants: thread.participants.join("\n"),
                    mentions: thread.mentions.join("\n"),
                    links: thread.links.map((link) => ({
                      ...link,
                      id: link.kind === "workspace" ? "" : link.id,
                    })),
                    status: thread.status,
                    closurePolicy: thread.closurePolicy,
                    pinned: thread.pinned,
                  },
                })
              }
            >
              Edit thread
            </Button>
            <Button
              requiresActor
              onClick={() =>
                props.controller.create({
                  method: "thread.attach",
                  threadId: thread.id,
                  commentId: "",
                })
              }
            >
              Attach existing comment
            </Button>
            <Button
              onClick={() => {
                void props.controller.read({ kind: "thread_history", threadId: thread.id });
              }}
            >
              Thread metadata history
            </Button>
          </Toolbar>
        </details>

        {related?.messages.items.map((comment) => (
          <div key={comment.id}>
            {thread.pinnedCommentIds.includes(comment.id) && <Badge>Pinned message</Badge>}
            <CommentCard value={comment} props={props} capture={capture} threadId={thread.id} />
            {thread.pinnedCommentIds.includes(comment.id) && (
              <Button
                requiresActor
                onClick={() =>
                  props.controller.create({
                    method: "thread.pin_message",
                    threadId: thread.id,
                    commentId: comment.id,
                    pinned: false,
                  })
                }
              >
                Unpin message {comment.id}
              </Button>
            )}
          </div>
        ))}
        {related?.messages.items.length === 0 && <p>No messages returned in this page.</p>}
        <InlineReply
          key={`${e.connectionId}:${e.generation}:${e.workspaceId}:${thread.id}`}
          props={props}
          threadId={thread.id}
        />

        <LazyDetails summary="About this conversation">
          <p className="dc-conversation-note">
            Messages follow attachment order. This view shows current comment versions; immutable
            captured request or direct-message bodies are separate.
          </p>
          <p>
            Board {thread.boardId} · metadata revision {thread.revision} · closure{" "}
            {thread.closurePolicy} · discussion serial {related?.discussionSerial ?? "not expanded"}
          </p>
          {thread.links.map((link, index) => (
            <p key={index}>
              {link.kind}
              {link.kind !== "workspace" ? `: ${link.id}` : ""}
              {link.kind === "ticket" && (
                <Button
                  onClick={() =>
                    open({ ...e, kind: "ticket_discussion", ticketId: link.id, comment: null })
                  }
                >
                  Open ticket discussion
                </Button>
              )}
            </p>
          ))}
        </LazyDetails>
        {props.renderRequests?.(e, { ...capture.captured, value: thread })}
      </>
    );
  }
  if (value.kind === "ticket_comments" || value.kind === "comment_history") {
    const selected =
      capture.selector.kind === "comment_history" ? capture.selector.selectedRevision : null;
    const items =
      selected === null
        ? value.page.items
        : value.page.items.filter((comment) => comment.revision === selected);
    return (
      <>
        {value.kind === "ticket_comments" && (
          <p className="wg-hint">Comments follow native ID order, not chronological order.</p>
        )}
        {selected !== null && items.length === 0 && (
          <p role="status">
            Requested historical revision {selected} is not in this returned page.{" "}
            {value.page.nextOffset === null && complete(capture.captured)
              ? "It is unavailable in this complete history; no current version was substituted."
              : value.page.nextOffset !== null
                ? "Continue the same captured history to look for it; no current version was substituted."
                : "This response has omissions or incomplete capture metadata. Refresh the bounded history before concluding the revision is unavailable; no current version was substituted."}
          </p>
        )}
        {items.map((comment) => (
          <CommentCard
            key={`${comment.id}:${comment.revision}`}
            value={comment}
            props={props}
            capture={capture}
            historical={value.kind === "comment_history"}
          />
        ))}
      </>
    );
  }
  if (value.kind !== "messages") throw new Error("Unhandled validated discussion projection");
  const selectedTarget = props.controller.get().target;
  const notification =
    selectedTarget?.kind === "direct_messages"
      ? (selectedTarget.capture?.notificationId ?? null)
      : null;
  const messages =
    notification === null
      ? value.page.items
      : value.page.items.filter((item) => item.notificationId === notification);
  return (
    <>
      {notification !== null && messages.length === 0 && (
        <p role="status">
          The requested captured notification {notification} is not in this page.{" "}
          {value.page.remaining !== "0"
            ? "Continue this exact interval; no other notification was substituted."
            : "It is unavailable for this consumer in the captured interval; no other notification was substituted."}
        </p>
      )}
      <div className="dc-received-feed-heading">
        <p>
          Delivered to {value.page.recipient.kind} <strong>{value.page.recipient.id}</strong>
        </p>
        <span>{messages.length} on this page · activity order</span>
      </div>
      <p className="dc-received-capture-note">
        Original delivery bodies are preserved, including after source edits. This view never marks
        messages handled; external acknowledgements for this reading queue can still remove entries.
        This is a received-message view, not a complete conversation archive.
      </p>
      {messages.map((message) => (
        <article
          className="dc-received-message wg-comment"
          key={message.notificationId}
          aria-label={`Received message ${message.messageId}`}
        >
          <header className="dc-received-sender">
            <ActorAvatar actor={message.actorId} />
            <div>
              <h3>Message from {message.actorId}</h3>
              <p>
                <RecordedTime value={message.timestamp} />
                {message.runId !== null ? ` · run ${message.runId}` : ""}
              </p>
            </div>
            <Badge>Direct message</Badge>
          </header>
          {message.body === null ? (
            <p>Captured body is unavailable. No current comment was substituted.</p>
          ) : message.body.tombstone ? (
            <p>Captured body is a tombstone.</p>
          ) : (
            <Body
              value={message.body.body}
              identity={`${e.connectionId}:${e.generation}:${message.notificationId}:captured`}
              partial={!complete(capture.captured)}
            />
          )}
          <Toolbar label={`Message ${message.messageId} actions`}>
            <Button
              requiresActor
              onClick={() =>
                props.controller.create({
                  method: "message.send",
                  messageId: crypto.randomUUID(),
                  body: "",
                  actorRecipients: message.actorId,
                  runRecipients: "",
                  teamIds: "",
                  ticketId: message.ticketIds.length === 1 ? (message.ticketIds[0] ?? "") : "",
                  replyToMessageId: message.messageId,
                  correlationId: "",
                })
              }
            >
              Reply with direct message
            </Button>
            <Button
              onClick={() =>
                open({
                  ...e,
                  kind: "direct_messages",
                  capture: {
                    consumerId: value.page.consumerId,
                    recipient: value.page.recipient,
                    after: value.page.after,
                    through: value.page.through,
                    ticketId:
                      capture.selector.kind === "messages" &&
                      capture.selector.filter.ticketId !== ""
                        ? validId(capture.selector.filter.ticketId, "Ticket filter")
                        : null,
                    excludeSelf:
                      capture.selector.kind === "messages"
                        ? capture.selector.filter.excludeSelf
                        : false,
                    notificationId: message.notificationId,
                  },
                })
              }
            >
              Open exact received-message capture
            </Button>
            {message.body !== null && message.ticketIds.length === 1 && (
              <Button
                onClick={() => {
                  const ticket = message.ticketIds[0];
                  if (ticket !== undefined && message.body !== null)
                    open({
                      ...e,
                      kind: "ticket_discussion",
                      ticketId: ticket,
                      comment: { id: message.body.commentId, revision: message.body.revision },
                    });
                }}
              >
                Open captured comment version
              </Button>
            )}
          </Toolbar>
        </article>
      ))}
      {value.page.items.length === 0 && (
        <p>No unread received messages matched this explicit consumer, recipient and interval.</p>
      )}
    </>
  );
}
const titles: Readonly<Record<ThreadsRead["kind"], string>> = {
  boards: "Boards",
  board: "Selected board",
  threads: "Threads",
  thread: "Conversation",
  thread_history: "Thread metadata history",
  ticket_comments: "Ticket discussion",
  comment_history: "Comment history",
  messages: "Received messages",
};
function continuation(capture: ReadCapture, kind: "next" | "retry"): boolean {
  let metadata = capture.captured.response.pagination;
  if (metadata === null) return false;
  if (capture.selector.kind === "thread") {
    const sections = jsonField(metadata, "sections");
    const section =
      sections?.kind === "array"
        ? sections.items.find((item) => {
            const path = jsonField(item, "path");
            return path?.kind === "string" && path.value === "/data/related/messages";
          })
        : undefined;
    if (section?.kind !== "object") return false;
    metadata = section;
  }
  const value = jsonField(metadata, kind === "next" ? "next_request" : "retry_request");
  return value?.kind === "object";
}
export function ThreadRead({
  kind,
  props,
}: {
  readonly kind: ThreadsRead["kind"];
  readonly props: ThreadsFeatureProps;
}) {
  const [unexpected, setUnexpected] = useState<{ error: unknown } | null>(null),
    state = props.controller.get().reads.get(kind);
  if (unexpected !== null) throw unexpected.error;
  if (state?.kind === "unexpected_error") throw state.error;
  if (state === undefined || state.kind === "idle") return null;
  const capture = state.kind === "ready" ? state.value : state.previous;
  const savedSelector = props.controller.get().selectors.get(kind);
  const run = (selector: ThreadsRead, page?: "next" | "retry" | "repeat") => {
    void props.controller.read(selector, page).catch((error: unknown) => setUnexpected({ error }));
  };
  return (
    <section className="dc-read" data-read-kind={kind}>
      <Panel
        title={titles[kind]}
        actions={
          state.kind === "loading" && capture === undefined ? <Badge>Loading</Badge> : undefined
        }
      >
        {state.kind === "failed" && (
          <p role="alert" className="wg-error">
            {failureText(state.failure)}{" "}
            {capture !== undefined && "Previous captured page remains below."}
          </p>
        )}
        {capture !== undefined && (
          <>
            {!complete(capture.captured) && (
              <p role="status">
                Some content may be missing or shortened. Continue to the next page or retry before
                treating these results as complete.
              </p>
            )}
            <Rows capture={capture} props={props} />
            <Toolbar label={`${titles[kind]} pagination`}>
              {continuation(capture, "next") && (
                <Button
                  disabled={state.kind === "loading"}
                  onClick={() => run(capture.selector, "next")}
                >
                  Next {kind === "thread" ? "messages" : "page"}
                </Button>
              )}
              {continuation(capture, "retry") && (
                <Button
                  disabled={state.kind === "loading"}
                  onClick={() => run(capture.selector, "retry")}
                >
                  Retry this page
                </Button>
              )}
            </Toolbar>
            <Toolbar label={`${titles[kind]} refresh`}>
              <Button
                tone="quiet"
                disabled={state.kind === "loading"}
                onClick={() => run(capture.selector)}
              >
                Refresh
              </Button>
            </Toolbar>
          </>
        )}
        {capture === undefined && state.kind === "failed" && savedSelector !== undefined && (
          <Button onClick={() => run(savedSelector, "repeat")}>Repeat exact failed read</Button>
        )}
        {capture === undefined && state.kind === "loading" && (
          <p role="status">Loading discussion…</p>
        )}
      </Panel>
    </section>
  );
}
