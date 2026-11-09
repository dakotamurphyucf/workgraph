import { InspectorDisclosure } from "../views/InspectorParts";
import { mergeCommentTimeline } from "./comment-timeline";
import { Prose } from "../views/ReadPresentation";
import { ActorAvatar } from "../../../components/ActorAvatar";
import { useState, type ReactNode } from "react";
import { Button, Field, Panel, Select, Toolbar } from "../../../components/Primitives";
import { jsonField, type JsonValue } from "../../../core/json";
import * as d from "../../../core/protocol/decoders";
import { failureText } from "../../connections/failure";
import { attemptCodec, commentCodec, handoffCodec, pageKey, selectorKey } from "./client";
import type { ProgressPage, ProgressRead, WorkProgressFeatureProps } from "./types";
import type { ReadState } from "../../../core/state/read-slot";
const field = (value: JsonValue | undefined, name: string) =>
  value?.kind === "object" ? jsonField(value, name) : undefined;
const text = (value: JsonValue | undefined) =>
  value?.kind === "string" ? value.value : "not returned";
const values = (value: JsonValue | undefined) => (value?.kind === "array" ? value.items : []);
function isPartial(page: ProgressPage): boolean {
  const value = field(field(page.response.response.meta, "budget"), "truncated");
  return value?.kind === "boolean" && value.value;
}
function commentTime(value: string) {
  const date = new Date(value.replace(" ", "T").replace(/(\.\d{3})\d+(?=Z$)/u, "$1"));
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(date);
}
function Plain({ value }: { readonly value: string }) {
  return (
    <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
      {value || <em>Empty text</em>}
    </p>
  );
}
function ResourcePins({
  value,
  props,
}: {
  readonly value: JsonValue | undefined;
  readonly props: WorkProgressFeatureProps;
}) {
  const artifacts = values(value);
  return (
    <>
      {artifacts.slice(0, 100).map((artifact, index) => {
        const pin = field(artifact, "pin"),
          kind = field(pin, "kind");
        if (kind?.kind !== "string" || kind.value !== "resource")
          return (
            <p key={index}>
              {text(field(artifact, "name"))}: this evidence type has no inline preview.
            </p>
          );
        const id = d.identifier.decode(field(pin, "resource_id")),
          version = d.positiveDecimal.decode(field(pin, "revision")),
          digest = d.digest.decode(field(pin, "digest"));
        if (!id.ok || !version.ok || !digest.ok)
          return (
            <p key={index}>
              Resource reference is incomplete in this response. Refresh to try loading the
              reference again.
            </p>
          );
        const selected = props.target;
        return (
          <div key={index}>
            <p>
              {text(field(artifact, "name"))} · <code>{id.value}</code> · content version{" "}
              {version.value} · SHA-256 <code>{digest.value}</code>
            </p>
            {props.openEvidence ? (
              <Button
                onClick={() =>
                  props.openEvidence?.({
                    kind: "resource_content",
                    connectionId: selected.scope.connection.id,
                    generation: selected.scope.connection.generation,
                    workspaceId: selected.scope.workspaceId,
                    resourceId: id.value,
                    version: version.value,
                    digest: digest.value,
                  })
                }
              >
                Open exact evidence version
              </Button>
            ) : (
              <p className="wg-hint">
                Exact resource navigation is not available in this build. Copy the version and
                digest above; the current resource is not a substitute.
              </p>
            )}
          </div>
        );
      })}
      {artifacts.length > 100 && <p>Showing the first 100 references.</p>}
    </>
  );
}
function commentItems(
  page: ProgressPage,
  props: WorkProgressFeatureProps,
  previous: readonly JsonValue[] = [],
): readonly JsonValue[] {
  const items = values(field(page.value, "items"));
  if (page.selector.kind !== "comments") return items;
  const decode = (item: JsonValue) => {
    const result = commentCodec.decode(item);
    if (!result.ok) throw new Error("Validated comment lost its shape");
    return result.value;
  };
  return mergeCommentTimeline(
    previous.map(decode),
    items.map(decode),
    props.controller.get().recentComments.map((item) => item.comment),
  ).map((item) => item.raw);
}
function Records({
  page,
  props,
}: {
  readonly page: ProgressPage;
  readonly props: WorkProgressFeatureProps;
}) {
  const kind = page.selector.kind;
  const target = props.target;
  const timelineKey = JSON.stringify([
    target.scope.connection.id,
    target.scope.connection.generation,
    target.scope.connection.socket,
    target.scope.workspaceId,
    target.ticket.value.ticket.ticket_id,
    kind,
  ]);
  const [timeline, setTimeline] = useState({
    key: timelineKey,
    page,
    items: values(field(page.value, "items")),
    partial: isPartial(page),
  });
  if (timeline.key !== timelineKey || timeline.page !== page)
    setTimeline({
      key: timelineKey,
      page,
      items: commentItems(page, props, timeline.key === timelineKey ? timeline.items : []),
      partial: isPartial(page) || (timeline.key === timelineKey && timeline.partial),
    });
  const comments = commentItems(page, props, timeline.key === timelineKey ? timeline.items : []);

  if (kind === "handoff" || kind === "handoff_history")
    return (
      <>
        {(kind === "handoff" ? [page.value] : values(field(page.value, "items"))).map(
          (item, index) => {
            const decoded = handoffCodec.decode(item);
            if (!decoded.ok) throw new Error("Validated handoff lost its shape");
            const value = decoded.value;
            return (
              <article key={`${value.revision}-${index}`}>
                <h4>
                  Handoff revision {value.revision} · {value.actorId}
                </h4>
                <p>
                  Coverage through inspected planning revision {value.coversThrough} ·{" "}
                  {value.timestamp}
                </p>
                <strong>Summary</strong>
                <Plain value={value.summary} />
                <strong>Next steps</strong>
                <Plain value={value.nextSteps} />
                <strong>Evidence</strong>
                <Plain value={value.evidence} />
                <details>
                  <summary>Objective, completed work, decisions and blockers</summary>
                  <strong>Objective</strong>
                  <Plain value={value.objective} />
                  <strong>Completed</strong>
                  <Plain value={value.completed} />
                  <strong>Decisions</strong>
                  <Plain value={value.decisions} />
                  <strong>Blockers</strong>
                  <Plain value={value.blockers} />
                </details>
                <p>Linked resource IDs (unversioned): {value.resourceIds.join(", ") || "none"}</p>
              </article>
            );
          },
        )}
      </>
    );
  if (kind === "attempts")
    return (
      <>
        {values(field(page.value, "items")).map((item) => {
          const decoded = attemptCodec.decode(item);
          if (!decoded.ok) throw new Error("Validated attempt lost its shape");
          const value = decoded.value;
          return (
            <article key={value.id}>
              <h4>
                {value.id} · {value.state}
              </h4>
              <p>
                Run {value.runId} · attempt revision {value.revision} · claim token {value.token}
              </p>
              <Plain value={value.evidence} />
              <p>
                {value.checkpoints.length} returned checkpoint(s) · sessions{" "}
                {value.sessionIds.join(", ") || "none"}.
              </p>
              <p className="wg-hint">
                An attempt outcome records work history. It does not complete the ticket, release
                its claim or prove an external process stopped.
              </p>
            </article>
          );
        })}
      </>
    );
  if (kind === "comments" || kind === "comment_history")
    return (
      <>
        {comments.length === 0 && (
          <p className="wg-hint">
            No conversation yet. Leave a comment to share an update or ask for input.
          </p>
        )}
        {comments.map((item, index) => {
          const decoded = commentCodec.decode(item);
          if (!decoded.ok) throw new Error("Validated comment lost its shape");
          const value = decoded.value;
          const live = props.controller
            .get()
            .recentComments.find(
              (item) => item.comment.id === value.id && item.comment.revision === value.revision,
            );
          return (
            <article
              className="work-comment-entry"
              data-kind={value.kind}
              id={`comment-${value.id}`}
              key={kind === "comments" ? value.id : `${value.id}-${value.revision}-${index}`}
            >
              <header>
                <ActorAvatar actor={value.authorId} />
                <strong>{value.authorId}</strong>
                <span className="work-comment-kind">{value.kind}</span>
                <time title={value.timestamp}>{commentTime(value.timestamp)}</time>
              </header>
              {value.replyToId && (
                <p className="work-comment-reply-to">
                  Replying to{" "}
                  <a
                    href={`#comment-${value.replyToId}`}
                    onClick={(event) => {
                      event.preventDefault();
                      document
                        .getElementById(`comment-${value.replyToId}`)
                        ?.scrollIntoView({ block: "center", behavior: "auto" });
                    }}
                  >
                    an earlier comment
                  </a>
                </p>
              )}
              {value.tombstone ? (
                <p>Message removed from normal reading. Earlier versions remain in history.</p>
              ) : (
                <div className="work-comment-prose">
                  <Prose
                    capture={`${value.id}:${value.revision}`}
                    label="Comment"
                    text={value.body}
                    partial={live?.partial ?? timeline.partial}
                  />
                </div>
              )}
              <div className="work-comment-actions">
                <div className="work-comment-reply">
                  {" "}
                  <Button
                    requiresActor
                    disabled={props.target.context.profileState !== "current"}
                    onClick={() => {
                      const id = props.controller.create(props.target, "comment.add");
                      if (id !== null)
                        props.controller.edit(id, {
                          method: "comment.add",
                          body: "",
                          kind: "comment",
                          replyToId: value.id,
                        });
                    }}
                  >
                    Reply to comment
                  </Button>
                </div>
                <details className="work-comment-details">
                  <summary>Edit and history</summary>
                  <p className="work-section-help">
                    Edit your own message or inspect the exact version in Discussions. Previous
                    revisions remain in the history; replies leave the original message intact.
                  </p>
                  <p className="work-comment-version">
                    Version {value.revision} · originally posted by {value.authorId}. Last changed
                    by {value.actorId}.
                  </p>
                  {value.origin === "completion" && (
                    <p>
                      Completion evidence is immutable. Append a correction reply to preserve its
                      history.
                    </p>
                  )}
                  <Toolbar label={`Comment ${value.id} actions`}>
                    <Button
                      requiresActor
                      disabled={
                        value.tombstone ||
                        value.origin !== "authored" ||
                        (props.target.context.writer.actorId !== null &&
                          props.target.context.writer.actorId !== value.authorId) ||
                        props.target.context.profileState !== "current"
                      }
                      onClick={() => {
                        const id = props.controller.create(props.target, "comment.edit");
                        if (id !== null)
                          props.controller.edit(id, {
                            method: "comment.edit",
                            commentId: value.id,
                            body: (live?.partial ?? timeline.partial) ? "" : value.body,
                          });
                      }}
                    >
                      Edit own comment
                    </Button>
                    <Button
                      requiresActor
                      disabled={
                        value.tombstone ||
                        value.origin !== "authored" ||
                        (props.target.context.writer.actorId !== null &&
                          props.target.context.writer.actorId !== value.authorId) ||
                        props.target.context.profileState !== "current"
                      }
                      onClick={() => {
                        const id = props.controller.create(props.target, "comment.tombstone");
                        if (id !== null)
                          props.controller.edit(id, {
                            method: "comment.tombstone",
                            commentId: value.id,
                          });
                      }}
                    >
                      Remove own comment
                    </Button>
                  </Toolbar>
                  {value.origin === "authored" &&
                    props.target.context.writer.actorId !== value.authorId && (
                      <p className="wg-hint">
                        Only the original author can edit or tombstone this comment; replies use the
                        current selected author.
                      </p>
                    )}
                  {props.openDiscussion ? (
                    <Button
                      onClick={() =>
                        props.openDiscussion?.({
                          kind: "ticket_discussion",
                          connectionId: props.target.scope.connection.id,
                          generation: props.target.scope.connection.generation,
                          workspaceId: props.target.scope.workspaceId,
                          ticketId: props.target.ticket.value.ticket.ticket_id,
                          comment: { id: value.id, revision: value.revision },
                        })
                      }
                    >
                      Open exact comment revision
                    </Button>
                  ) : (
                    <p className="wg-hint">
                      Discussion navigation is unavailable here. Exact comment ID and revision are
                      shown above; reading does not acknowledge or resolve anything.
                    </p>
                  )}
                </details>
              </div>
            </article>
          );
        })}
      </>
    );
  if (kind === "review_gate") {
    const allowed = field(page.value, "allowed"),
      problem = field(page.value, "problem");
    return (
      <>
        <p>
          <strong>
            {allowed?.kind === "boolean"
              ? allowed.value
                ? "Current evidence/review gate allows completion"
                : "Current evidence/review gate blocks completion"
              : "Gate result unavailable"}
          </strong>
        </p>
        {problem?.kind === "object" && (
          <p role="status">
            {text(field(problem, "kind"))}: {text(field(problem, "message"))}
          </p>
        )}
        <p className="wg-hint">
          This is the captured evidence gate, separate from graph prerequisites, ticket ownership
          and active-attempt rules. Native completion checks all current guards again.
        </p>
      </>
    );
  }
  if (kind === "evidence") {
    const effective = field(page.value, "effective_policy"),
      manifest = field(page.value, "manifest"),
      submission = field(page.value, "submission"),
      criteria = values(field(effective, "criteria"));
    return (
      <>
        <p>
          Evidence namespace revision {text(field(page.response.response.meta, "query_revision"))}.
          Planning revision and namespace revisions are distinct.
        </p>
        <h4>Current effective acceptance criteria</h4>
        {criteria.length === 0 ? (
          <p>
            No criteria returned. Check omission metadata before concluding none are configured.
          </p>
        ) : (
          criteria.slice(0, 200).map((criterion, index) => (
            <div key={index}>
              <Plain value={text(field(field(criterion, "criterion"), "description"))} />
            </div>
          ))
        )}
        <p>
          Submission generation {text(field(submission, "generation"))} · state{" "}
          {text(field(field(submission, "state"), "kind"))}.{" "}
          {values(field(page.value, "reviews")).length} returned reviews;{" "}
          {values(field(page.value, "assertions")).length} returned assertions.
        </p>
        <h4>Manifest inputs</h4>
        <ResourcePins value={field(manifest, "inputs")} props={props} />
        <h4>Manifest outputs</h4>
        <ResourcePins value={field(manifest, "outputs")} props={props} />
        <p className="wg-hint">
          Evidence and reviewer authoring belongs in Workflow. A current approval message alone does
          not mean the exact submitted manifest is accepted.
        </p>
      </>
    );
  }
  return (
    <p>
      {values(field(page.value, "items")).length} returned{" "}
      {kind === "amendments" ? "instruction amendments" : "amendment acknowledgements"}; immutable
      acknowledgement coverage is retained in Workgraph. Viewing these records does not acknowledge
      them.
    </p>
  );
}
const READ_HELP: Partial<Record<ProgressRead["kind"], string>> = {
  handoff:
    "The latest summary for the next worker: what is done, what remains and where to find context.",
  handoff_history: "Earlier handoffs, retained so you can trace how the plan changed.",
  attempts:
    "Recorded work sessions on this ticket, including outcomes. A record does not prove an agent is still running.",
  evidence: "The recorded material used to support completion and review decisions.",
  review_gate: "Review requirements and the evidence needed before this ticket can be finished.",
  amendments:
    "Changes to instructions made after work began. Workers may need to acknowledge a specific revision.",
  comment_history:
    "Previous versions of this message, including edits or removal from normal reading.",
  amendment_acknowledgements:
    "Recorded confirmations that workers received this exact instruction change.",
};
function ReadSection({
  selector,
  title,
  props,
  state,
}: {
  readonly selector: ProgressRead;
  readonly title: string;
  readonly props: WorkProgressFeatureProps;
  readonly state: ReadState<ProgressPage> | undefined;
}) {
  const page =
    state?.kind === "ready"
      ? state.value
      : state !== undefined && state.kind !== "idle"
        ? state.previous
        : undefined;
  const paging = page?.response.pagination;
  const has = (name: string) =>
    paging !== null && paging !== undefined && jsonField(paging, name)?.kind === "object";
  const read = (next?: "next" | "retry" | "repeat") => {
    void props.controller.read(selector, next);
  };
  const budget = field(page?.response.response.meta, "budget"),
    partial = field(budget, "truncated"),
    remaining = field(page?.value, "remaining");
  return (
    <Panel
      title={title}
      actions={
        <Button disabled={state?.kind === "loading"} onClick={() => read()}>
          {page ? "Refresh" : `Load ${title.toLowerCase()}`}
        </Button>
      }
    >
      {READ_HELP[selector.kind] && <p className="work-section-help">{READ_HELP[selector.kind]}</p>}
      {state === undefined || state.kind === "idle" ? (
        <p className="wg-hint">Use Load above to read this ticket’s records.</p>
      ) : state.kind === "loading" && page === undefined ? (
        <p role="status">Loading captured {title.toLowerCase()}…</p>
      ) : state.kind === "failed" ? (
        <div>
          <p role="alert">{failureText(state.failure)} A failed read does not prove absence.</p>
          <Button onClick={() => read("repeat")}>Retry exact failed read</Button>
        </div>
      ) : state.kind === "unexpected_error" ? (
        <Unexpected error={state.error} />
      ) : null}
      {page && (
        <>
          {partial?.kind === "boolean" && partial.value && (
            <p role="status" className="wg-hint">
              Some text or records were omitted from this response.
            </p>
          )}
          {remaining?.kind === "string" && remaining.value !== "0" && (
            <p className="wg-hint">{remaining.value} more records available.</p>
          )}
          {page.selector.kind === "comments" && props.controller.get().commentsCatchingUp && (
            <p role="status" className="wg-hint">
              Receiving more updates… Older comments remain available below.
            </p>
          )}
          {page.selector.kind === "comments" && props.controller.get().commentsIssue && (
            <p role="status" className="wg-hint">
              Updates will retry: {props.controller.get().commentsIssue}
            </p>
          )}
          <Records page={page} props={props} />
          {field(page.value, "needs_larger_budget")?.kind === "boolean" &&
            field(page.value, "required_bytes")?.kind === "string" && (
              <p role="status">
                This captured item requires {text(field(page.value, "required_bytes"))} canonical
                bytes. No item was consumed; this is not an empty collection. The method's
                configured maximum read budget is 1 MiB.
              </p>
            )}
          {page.selector.kind !== "comments" &&
            field(page.value, "items")?.kind === "array" &&
            values(field(page.value, "items")).length === 0 && (
              <p>
                No records in this returned page. Check capture and omission labels before
                concluding there are none.
              </p>
            )}
          {(has("next_request") || has("retry_request")) && (
            <Toolbar label={`${title} page controls`}>
              <Button
                disabled={
                  !has("next_request") ||
                  state?.kind === "loading" ||
                  selectorKey(selector) !== selectorKey(page.selector)
                }
                onClick={() => read("next")}
              >
                Load more {title.toLowerCase()}
              </Button>
              <Button
                disabled={
                  !has("retry_request") ||
                  state?.kind === "loading" ||
                  selectorKey(selector) !== selectorKey(page.selector)
                }
                onClick={() => read("retry")}
              >
                Retry captured {title.toLowerCase()} page
              </Button>
            </Toolbar>
          )}
        </>
      )}
    </Panel>
  );
}
function Unexpected({ error }: { readonly error: unknown }): never {
  throw error;
}
export function ProgressReads({
  props,
  pages,
  composer,
}: {
  readonly composer?: ReactNode;
  readonly props: WorkProgressFeatureProps;
  readonly pages: Readonly<Record<string, ReadState<ProgressPage>>>;
}) {
  const [commentId, setCommentId] = useState(""),
    [amendmentId, setAmendmentId] = useState(""),
    [revision, setRevision] = useState(""),
    [pageSize, setPageSize] = useState<"1" | "25">("25");
  const section = (selector: ProgressRead, title: string) => (
    <ReadSection
      key={pageKey(selector)}
      selector={{ ...selector, pageSize }}
      title={title}
      props={props}
      state={pages[pageKey(selector)]}
    />
  );
  const comment = d.identifier.decode(d.jsonString(commentId)),
    amendment = d.identifier.decode(d.jsonString(amendmentId)),
    rev = d.positiveDecimal.decode(d.jsonString(revision));
  return (
    <>
      <div className="work-conversation-flow">
        {section({ kind: "comments" }, "Conversation & updates")}
      </div>
      <div className="work-conversation-composer">{composer}</div>
      <InspectorDisclosure
        title="Handoff, attempts and evidence"
        description="Read the latest handoff, work sessions and evidence behind this ticket."
        icon="resources"
        tone="purple"
      >
        <p className="work-section-help">
          A handoff tells the next worker what happened and what to do next. Attempts record
          individual work sessions; evidence supports a claim that the work is complete. These are
          read-only views.
        </p>
        <Select
          label="Activity records per page"
          value={pageSize}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "1" || value === "25") setPageSize(value);
          }}
        >
          <option value="25">25 records</option>
          <option value="1">One record to reduce text clipping</option>
        </Select>
        <p className="wg-hint">
          Changing page size does not fetch or restart a capture. Load the desired section
          explicitly; omission labels still apply.
        </p>
        {section({ kind: "handoff" }, "Current handoff")}
        {section({ kind: "handoff_history" }, "Handoff history")}
        {section({ kind: "attempts" }, "Recorded attempts")}
        {section({ kind: "evidence" }, "Evidence context")}
        {section({ kind: "review_gate" }, "Review gate")}
        {section({ kind: "amendments" }, "Instruction amendments")}
      </InspectorDisclosure>
      <InspectorDisclosure
        title="Comment and acknowledgement history"
        description="Inspect earlier messages or see who confirmed a particular instruction change."
        icon="history"
        tone="gold"
      >
        <p className="work-section-help">
          Use Edit and history on a message for its exact version. For a different message, enter
          its ID below. An acknowledgement records that a worker has read a specific instruction
          amendment; opening this view does not acknowledge it.
        </p>
        <Field
          label="History comment ID"
          value={commentId}
          onChange={(event) => setCommentId(event.target.value)}
        />
        {comment.ok &&
          section(
            { kind: "comment_history", commentId: comment.value },
            "Comment revision history",
          )}
        <Field
          label="Acknowledgement amendment ID"
          value={amendmentId}
          onChange={(event) => setAmendmentId(event.target.value)}
        />
        <Field
          label="Acknowledgement amendment revision"
          value={revision}
          onChange={(event) => setRevision(event.target.value)}
        />
        {amendment.ok &&
          rev.ok &&
          section(
            {
              kind: "amendment_acknowledgements",
              amendmentId: amendment.value,
              revision: rev.value,
            },
            "Amendment acknowledgements",
          )}
      </InspectorDisclosure>
    </>
  );
}
