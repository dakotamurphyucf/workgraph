import { ActorAvatar } from "../../../components/ActorAvatar";
import { Icon } from "../../../components/Icon";
import { InlineAnswer } from "./InlineAnswer";
import { RecordedTime } from "../RecordedTime";
import { RequestWaitPanel } from "./wait/RequestWaitPanel";
import { InboxView } from "./InboxView";
import { jsonField } from "../../../core/json";
import { Badge, Button, Panel, Toolbar } from "../../../components/Primitives";
import { failureText } from "../../connections/failure";
import { LazyDetails } from "../../connections/shared";
import { discussionRoute } from "../threads/navigation";
import { complete } from "../threads/model";
import { RequestBody } from "./RequestBody";
import { selectorKey } from "./client";
import { requestsRoute } from "./navigation";
import type {
  CurrentRequest,
  ReadCapture,
  RequestRecord,
  RequestsFeatureProps,
  RequestsInput,
  RequestsRead,
} from "./types";
export function RequestRecordView({
  value,
  capture,
  props,
  historical = false,
  current = null,
}: {
  readonly value: RequestRecord;
  readonly capture: ReadCapture;
  readonly props: RequestsFeatureProps;
  readonly historical?: boolean;
  readonly current?: CurrentRequest | null;
}) {
  const e = capture.captured.endpoint,
    create = (input: RequestsInput) => props.controller.create(input);
  const recipient =
    props.context.writer.runId === null
      ? { kind: "actor" as const, id: props.context.writer.actorId ?? "" }
      : { kind: "run" as const, id: props.context.writer.runId };
  const editable = !historical;
  const list = props.controller.get().reads.get("requests");
  const listed = list?.kind === "ready" ? list.value.captured.value : undefined;
  const title =
    listed?.kind === "requests"
      ? listed.page.items.find((item) => item.id === value.id)?.threadSummary.title
      : undefined;
  return (
    <article className="rq-record" aria-label={`Request ${value.id} revision ${value.revision}`}>
      <header className="rq-record-heading">
        <div className="dc-eyebrow">
          <span className="rq-status" data-status={value.status.kind}>
            {value.status.kind} request
          </span>{" "}
          {value.kind.replaceAll("_", " ")}
          {historical ? ` · historical revision ${value.revision}` : ""}
        </div>
        <h2>{title ?? `Request ${value.id}`}</h2>
        <p>
          <ActorAvatar actor={value.created.actorId} /> {value.created.actorId} asked{" "}
          {value.resolverId} · <RecordedTime value={value.created.timestamp} />
        </p>
      </header>
      <div className="rq-responsibility" data-status={value.status.kind}>
        <Icon name="discussions" />
        <div>
          <strong>
            {value.status.kind === "open"
              ? `Waiting for ${value.resolverId} to resolve`
              : value.status.kind === "resolved"
                ? "This request is resolved"
                : "This request was cancelled"}
          </strong>
          <p>
            {value.responsibility.kind === "accepted"
              ? `Responsibility accepted by ${value.responsibility.recipient.id}.`
              : "Responsibility has not been accepted."}{" "}
            Delivery acknowledgement is tracked separately.
          </p>
        </div>
        {editable && value.status.kind === "open" && value.responsibility.kind === "unaccepted" && (
          <Button
            requiresActor
            tone="quiet"
            onClick={() => create({ method: "request.accept", requestId: value.id, recipient })}
          >
            Accept responsibility
          </Button>
        )}
      </div>
      {current !== null ? (
        <>
          <div className="rq-message">
            <header>
              <ActorAvatar actor={value.created.actorId} />
              <strong>{value.created.actorId}</strong>
              <Badge>Question</Badge>
              <RecordedTime value={value.created.timestamp} />
            </header>
            <RequestBody
              body={current.questionBody.body}
              identity={`${e.connectionId}:${e.generation}:${value.question.id}:${value.question.revision}`}
              partial={!complete(capture.captured)}
            />
          </div>
          {current.related?.messages.items
            .filter(
              (message) =>
                message.id !== value.question.id && message.id !== current.answerBody?.id,
            )
            .map((message) => (
              <div className="rq-message" key={message.id}>
                <header>
                  <ActorAvatar actor={message.authorId} />
                  <strong>{message.authorId}</strong>
                  <Badge>{message.kind}</Badge>
                  <RecordedTime value={message.timestamp} />
                </header>
                {message.tombstone ? (
                  <p>This comment was removed.</p>
                ) : (
                  <RequestBody
                    body={message.body}
                    identity={`${e.connectionId}:${e.generation}:${message.id}:${message.revision}`}
                    partial={!complete(capture.captured)}
                  />
                )}
              </div>
            ))}
          {current.answerBody !== null && (
            <>
              <div className="rq-message rq-answer">
                <header>
                  <ActorAvatar actor={current.answerBody.authorId} />
                  <strong>{current.answerBody.authorId}</strong>
                  <Badge>Answer</Badge>
                  <RecordedTime value={current.answerBody.timestamp} />
                </header>
                <RequestBody
                  body={current.answerBody.body}
                  identity={`${e.connectionId}:${e.generation}:${current.answerBody.id}:${current.answerBody.revision}`}
                  partial={!complete(capture.captured)}
                />
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <p>
            This request snapshot pins its original bodies. Load an exact version; current text is
            never substituted.
          </p>
          <Toolbar label="Historical request bodies">
            <Button
              onClick={() => {
                void props.controller.read({ kind: "historical_comment", pin: value.question });
              }}
            >
              Load original question
            </Button>
            {value.status.kind === "resolved" && value.status.answer !== null && (
              <Button
                onClick={() => {
                  if (value.status.kind === "resolved" && value.status.answer !== null)
                    void props.controller.read({
                      kind: "historical_comment",
                      pin: value.status.answer,
                    });
                }}
              >
                Load original answer
              </Button>
            )}
          </Toolbar>
        </>
      )}
      {editable && value.status.kind === "open" && (
        <InlineAnswer
          key={`${e.connectionId}:${e.generation}:${e.workspaceId}:${value.id}`}
          props={props}
          requestId={value.id}
          resolverId={value.resolverId}
        />
      )}
      <details className="rq-actions">
        <summary>Request actions</summary>
        <Toolbar label={`Actions for request ${value.id}`}>
          <Button
            onClick={() =>
              props.context.navigate(
                discussionRoute(props.context, { ...e, kind: "thread", threadId: value.threadId }),
              )
            }
          >
            Open current discussion
          </Button>
          <Button onClick={() => props.onReply({ ...e, threadId: value.threadId })}>
            Reply with context
          </Button>
          <Button
            onClick={() =>
              props.context.navigate(
                requestsRoute(props.context, {
                  ...e,
                  kind: "request",
                  requestId: value.id,
                  revision: null,
                }),
              )
            }
          >
            {historical ? "Open current request" : "Open request"}
          </Button>
          <Button
            onClick={() => {
              void props.controller.read({
                kind: "history",
                requestId: value.id,
                selectedRevision: null,
              });
            }}
          >
            Request history
          </Button>
          {editable && value.status.kind === "open" && (
            <>
              <Button
                requiresActor
                onClick={() =>
                  create({ method: "request.acknowledge", requestId: value.id, recipient })
                }
              >
                Acknowledge delivery
              </Button>
              <Button
                requiresActor
                onClick={() => create({ method: "request.accept", requestId: value.id, recipient })}
              >
                Accept responsibility
              </Button>
              <Button
                requiresActor
                onClick={() => create({ method: "request.resolve", requestId: value.id, body: "" })}
              >
                Answer and resolve
              </Button>
              <Button
                requiresActor
                onClick={() =>
                  create({ method: "request.reassign", requestId: value.id, recipient: null })
                }
              >
                Reassign responsibility
              </Button>
              <Button
                requiresActor
                onClick={() =>
                  create({
                    method: "request.metadata",
                    requestId: value.id,
                    priority: { kind: "keep" },
                    deadlineUnixMs: { kind: "keep" },
                    relatedIds: { kind: "keep" },
                    supersedesIds: { kind: "keep" },
                  })
                }
              >
                Edit request metadata
              </Button>
              <Button
                requiresActor
                onClick={() => create({ method: "request.cancel", requestId: value.id })}
              >
                Cancel request
              </Button>
            </>
          )}
        </Toolbar>
      </details>
      {!historical && current !== null && capture.selector.kind === "request" && (
        <details className="rq-wait">
          <summary>Wait for resolution with a time limit</summary>
          <RequestWaitPanel
            controller={props.controller.waiter}
            endpoint={e}
            requestId={value.id}
          />
        </details>
      )}
      <details>
        <summary>Deliveries and responsibility</summary>
        <p>
          Delivery acknowledgement is separate from accepting responsibility and Inbox
          acknowledgement.
        </p>
        <ul>
          {value.deliveries.map((delivery) => (
            <li key={`${delivery.recipient.kind}:${delivery.recipient.id}`}>
              {delivery.recipient.kind} {delivery.recipient.id} —{" "}
              {delivery.acknowledged === null
                ? "delivery not acknowledged"
                : `delivery acknowledged by ${delivery.acknowledged.actorId}`}
            </li>
          ))}
        </ul>
      </details>
      <LazyDetails summary="Request details">
        <p>
          The question and answer show the exact versions pinned by this request. Other discussion
          comments show their current versions in attachment order.
        </p>
        {current?.related &&
          current.related.currentQuestion.revision !== value.question.revision && (
            <p>
              The question comment was edited later; this request retains its original version{" "}
              {value.question.revision}.
            </p>
          )}
        <p>
          Request {value.id} revision {value.revision} · discussion {value.threadId} · endpoint{" "}
          {e.connectionId} generation {e.generation}
        </p>
        <p>
          Deadline {value.deadlineUnixMs ?? "none"} · priority {value.priority} · related{" "}
          {value.relatedIds.join(", ") || "none"} · supersedes{" "}
          {value.supersedesIds.join(", ") || "none"}
        </p>
      </LazyDetails>
    </article>
  );
}
export function RequestRead({
  kind,
  props,
  titleFilter = "",
}: {
  readonly kind: RequestsRead["kind"];
  readonly props: RequestsFeatureProps;
  readonly titleFilter?: string;
}) {
  const state = props.controller.get(),
    slot = state.reads.get(kind),
    selector = state.selectors.get(kind);
  const capture =
    slot?.kind === "ready"
      ? slot.value
      : slot !== undefined && "previous" in slot
        ? slot.previous
        : undefined;
  const value = capture?.captured.value;
  const next =
    value === undefined
      ? false
      : value.kind === "inbox"
        ? value.page.remaining !== "0"
        : value.kind === "request"
          ? value.request.related?.messages.nextOffset !== null &&
            value.request.related?.messages.nextOffset !== undefined
          : "page" in value && value.page.nextOffset !== null;
  const pagination = capture?.captured.response.pagination;
  const retry =
    pagination !== null &&
    pagination !== undefined &&
    jsonField(pagination, "retry_request")?.kind === "object";
  if (slot?.kind === "unexpected_error") throw slot.error;
  if (selector === undefined) return null;
  return (
    <section className="rq-read" data-read-kind={kind} aria-label={`${kind} results`}>
      {slot?.kind === "loading" && capture === undefined && (
        <p role="status">Loading {kind.replaceAll("_", " ")}…</p>
      )}
      {slot?.kind === "failed" && (
        <p role="alert" className="wg-error">
          {failureText(slot.failure)}
        </p>
      )}
      {capture !== undefined && selectorKey(capture.selector) !== selectorKey(selector) && (
        <p role="status">
          Showing the previous captured results while the changed selectors load or remain
          unavailable. Their original recipient and filters stay attached.
        </p>
      )}
      {capture !== undefined && (
        <>
          {!complete(capture.captured) && (
            <p role="status">
              Partial capture: omitted fields/items or incomplete coverage metadata. Empty results
              do not establish absence.
            </p>
          )}
          <ReadValue capture={capture} props={props} titleFilter={titleFilter} />
        </>
      )}
      <details className="rq-read-tools">
        <summary>Refresh options</summary>
        <Toolbar label={`${kind} read controls`}>
          <Button
            disabled={slot?.kind === "loading"}
            onClick={() => {
              void props.controller.read(selector);
            }}
          >
            Refresh
          </Button>
          {slot !== undefined && (
            <Button
              disabled={slot.kind === "loading"}
              onClick={() => {
                void props.controller.read(selector, "repeat");
              }}
            >
              Re-read this snapshot
            </Button>
          )}
        </Toolbar>
      </details>
      <Toolbar label={`${kind} page controls`}>
        {capture !== undefined && (
          <>
            {next && (
              <Button
                disabled={slot?.kind === "loading"}
                onClick={() => {
                  void props.controller.read(selector, "next");
                }}
              >
                Next page
              </Button>
            )}
            {retry && (
              <Button
                disabled={slot?.kind === "loading"}
                onClick={() => {
                  void props.controller.read(selector, "retry");
                }}
              >
                Retry this page
              </Button>
            )}
          </>
        )}
      </Toolbar>
    </section>
  );
}
function ReadValue({
  capture,
  props,
  titleFilter,
}: {
  readonly capture: ReadCapture;
  readonly props: RequestsFeatureProps;
  readonly titleFilter: string;
}) {
  const value = capture.captured.value,
    e = capture.captured.endpoint;
  const identity = `${e.connectionId}:${e.generation}:${capture.captured.invocation.method}`;
  switch (value.kind) {
    case "requests":
      return (
        <>
          {value.page.items.length === 0 && (
            <p>
              No matching requests on this page. Ask a question or change the filters to find other
              requests.
            </p>
          )}
          {value.page.items
            .filter((item) =>
              item.threadSummary.title.toLowerCase().includes(titleFilter.toLowerCase()),
            )
            .map((item) => (
              <article
                className="rq-list-row"
                data-selected={
                  props.controller.get().target?.kind === "request" &&
                  props.context.route.requests?.kind === "request" &&
                  props.context.route.requests.requestId === item.id
                }
                key={item.id}
              >
                <Button
                  tone="quiet"
                  onClick={() =>
                    props.context.navigate(
                      requestsRoute(props.context, {
                        ...e,
                        kind: "request",
                        requestId: item.id,
                        revision: null,
                      }),
                    )
                  }
                >
                  <span className="rq-list-icon" data-status={item.status.kind}>
                    {item.status.kind === "resolved"
                      ? "✓"
                      : item.status.kind === "cancelled"
                        ? "−"
                        : "?"}
                  </span>
                  <span>
                    <span className="dc-preview-title-line">
                      <strong>{item.threadSummary.title}</strong>
                      <RecordedTime
                        value={
                          item.status.kind === "open"
                            ? item.created.timestamp
                            : item.status.attribution.timestamp
                        }
                        compact
                      />
                    </span>
                    <span className="rq-list-meta">
                      <ActorAvatar actor={item.created.actorId} /> {item.created.actorId} →{" "}
                      <ActorAvatar actor={item.resolverId} /> {item.resolverId}
                    </span>
                    <span className="rq-list-meta">
                      <span className="rq-status" data-status={item.status.kind}>
                        {item.status.kind}
                      </span>{" "}
                      · {item.kind.replaceAll("_", " ")}
                      {item.status.kind === "open"
                        ? ` · Waiting for ${item.resolverId}`
                        : item.status.kind === "resolved"
                          ? " · Answered"
                          : " · Closed without an answer"}
                    </span>
                  </span>
                </Button>
              </article>
            ))}
          {titleFilter && <p>Title filtering applies to this loaded page.</p>}
          <p>
            {value.page.items.length} requests on this page
            {value.page.remaining !== "0" ? ` · ${value.page.remaining} more available` : ""}
          </p>
        </>
      );
    case "request":
      return (
        <RequestRecordView
          value={value.request}
          current={value.request}
          capture={capture}
          props={props}
        />
      );
    case "history": {
      const wanted = capture.selector.kind === "history" ? capture.selector.selectedRevision : null,
        items =
          wanted === null
            ? value.page.items
            : value.page.items.filter((item) => item.revision === wanted);
      return (
        <>
          {wanted !== null && items.length === 0 && (
            <p role="status">
              Exact request snapshot {wanted} is unavailable in the bounded captured history. No
              current snapshot was substituted. Continue the captured history or open current
              explicitly.
            </p>
          )}
          {items.map((item) => (
            <div key={`${item.id}:${item.revision}`}>
              <Button
                onClick={() =>
                  props.context.navigate(
                    requestsRoute(props.context, {
                      ...e,
                      kind: "request",
                      requestId: item.id,
                      revision: item.revision,
                    }),
                  )
                }
              >
                Link to request revision {item.revision}
              </Button>
              <RequestRecordView value={item} capture={capture} props={props} historical />
            </div>
          ))}
          <p>
            {value.page.remaining} further history snapshots remain under this communication
            capture.
          </p>
        </>
      );
    }
    case "historical_comment": {
      const pin = capture.selector.kind === "historical_comment" ? capture.selector.pin : null,
        items =
          pin === null
            ? []
            : value.page.items.filter(
                (item) => item.id === pin.id && item.revision === pin.revision,
              );
      return (
        <>
          {items.length === 0 && (
            <p role="status">
              This exact original body is unavailable in the bounded captured history. Current text
              was not substituted.
            </p>
          )}
          {items.map((item) => (
            <article key={`${item.id}:${item.revision}`}>
              <h3>
                Original body · {item.id} revision {item.revision}
              </h3>
              {item.tombstone ? (
                <p>This exact revision is a tombstone.</p>
              ) : (
                <RequestBody
                  body={item.body}
                  identity={`${identity}:${item.id}:${item.revision}`}
                  partial={!complete(capture.captured)}
                />
              )}
            </article>
          ))}
        </>
      );
    }
    case "inbox":
      return (
        <InboxView
          key={`${identity}:${e.workspaceId}:${selectorKey(capture.selector)}:${value.page.after}`}
          page={value.page}
          capture={capture}
          props={props}
        />
      );
    case "teams":
      return (
        <div className="rq-routing-grid">
          {value.page.items.length === 0 && (
            <p>No teams yet. Create a team to address a group of people or agents together.</p>
          )}
          {value.page.items.map((team) => (
            <article key={team.id} className="rq-routing-card">
              <header>
                <span className="rq-card-icon">
                  <Icon name="participants" />
                </span>
                <div>
                  <h3>{team.title}</h3>
                  <p>{team.members.length} current members</p>
                </div>
              </header>
              <div className="rq-members">
                {team.members.slice(0, 5).map((member) => (
                  <span key={`${member.kind}:${member.id}`}>
                    <ActorAvatar actor={member.id} />
                    {member.id}
                  </span>
                ))}
                {team.members.length > 5 && (
                  <details>
                    <summary>{team.members.length - 5} more members</summary>
                    {team.members.slice(5).map((member) => (
                      <span className="dc-person" key={`${member.kind}:${member.id}`}>
                        <ActorAvatar actor={member.id} />
                        {member.id}
                      </span>
                    ))}
                  </details>
                )}
              </div>
              <div className="rq-card-actions">
                <Button
                  requiresActor
                  onClick={() =>
                    props.controller.create({
                      method: "team.put",
                      existing: true,
                      teamId: team.id,
                      title: team.title,
                      members: team.members,
                    })
                  }
                >
                  Edit team
                </Button>
              </div>
            </article>
          ))}
        </div>
      );
    case "team":
      return (
        <Panel title={value.team.title}>
          <p>
            Current members:{" "}
            {value.team.members.map((member) => `${member.kind} ${member.id}`).join(", ") || "none"}
            . Frozen past request deliveries stay unchanged.
          </p>
          <Button
            requiresActor
            onClick={() =>
              props.controller.create({
                method: "team.put",
                existing: true,
                teamId: value.team.id,
                title: value.team.title,
                members: value.team.members,
              })
            }
          >
            Edit current team
          </Button>
        </Panel>
      );
    case "subscriptions":
      return (
        <div className="rq-routing-grid">
          {value.page.items.length === 0 && (
            <p>
              No subscriptions yet. Create one to send matching future updates to an actor or run.
            </p>
          )}
          {value.page.items.map((sub) => (
            <article key={sub.id} className="rq-routing-card">
              <header>
                <span className="rq-card-icon">
                  <Icon name="activity" />
                </span>
                <div>
                  <h3>{sub.id}</h3>
                  <p>
                    <span className="rq-subscription-status" data-active={sub.active}>
                      {sub.active ? "Active" : "Inactive"}
                    </span>{" "}
                    · {sub.recipient.kind} {sub.recipient.id}
                  </p>
                </div>
              </header>
              <p className="rq-routing-filter">
                {sub.filter.scope === null
                  ? "All workspace scopes"
                  : sub.filter.scope.kind === "workspace"
                    ? "Workspace discussions"
                    : `Project ${sub.filter.scope.id}`}
                {sub.filter.threadId ? ` · Thread ${sub.filter.threadId}` : ""}
              </p>
              <p className="rq-routing-filter">
                {sub.filter.kinds.length === 0
                  ? "All notification kinds"
                  : sub.filter.kinds.map((kind) => kind.replaceAll("_", " ")).join(", ")}
              </p>
              <div className="rq-card-actions">
                <Button
                  requiresActor
                  onClick={() =>
                    props.controller.create({
                      method: "subscription.put",
                      existing: true,
                      subscriptionId: sub.id,
                      recipient: sub.recipient,
                      filter: {
                        scope: sub.filter.scope,
                        threadId: sub.filter.threadId ?? "",
                        kinds: sub.filter.kinds,
                      },
                      active: sub.active,
                    })
                  }
                >
                  Edit subscription
                </Button>
              </div>
            </article>
          ))}
        </div>
      );
    case "subscription":
      return (
        <Panel title={`Subscription ${value.subscription.id}`}>
          <p>
            {value.subscription.active ? "Active for future deliveries" : "Inactive"} ·{" "}
            {value.subscription.recipient.kind} {value.subscription.recipient.id}
          </p>
          <Button
            requiresActor
            onClick={() =>
              props.controller.create({
                method: "subscription.put",
                existing: true,
                subscriptionId: value.subscription.id,
                recipient: value.subscription.recipient,
                filter: {
                  scope: value.subscription.filter.scope,
                  threadId: value.subscription.filter.threadId ?? "",
                  kinds: value.subscription.filter.kinds,
                },
                active: value.subscription.active,
              })
            }
          >
            Edit current subscription
          </Button>
          <p>
            Scope: {value.subscription.filter.scope?.kind ?? "all scopes"}. Events:{" "}
            {value.subscription.filter.kinds.map((kind) => kind.replaceAll("_", " ")).join(", ") ||
              "all types"}
            .
          </p>
        </Panel>
      );
  }
}
