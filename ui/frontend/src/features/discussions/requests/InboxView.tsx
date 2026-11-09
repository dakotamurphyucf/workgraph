import { useState } from "react";
import { ActorAvatar } from "../../../components/ActorAvatar";
import { Icon } from "../../../components/Icon";
import { Button, Toolbar } from "../../../components/Primitives";
import { complete } from "../threads/model";
import { RecordedTime } from "../RecordedTime";
import { RequestBody } from "./RequestBody";
import { requestsRoute } from "./navigation";
import type { InboxPage, ReadCapture, RequestsFeatureProps } from "./types";

export function InboxView({
  page,
  capture,
  props,
}: {
  readonly page: InboxPage;
  readonly capture: ReadCapture;
  readonly props: RequestsFeatureProps;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const routeTarget = props.controller.get().target;
  const selectedId =
    routeTarget?.kind === "inbox" ? routeTarget.capture?.notificationId : undefined;
  const e = capture.captured.endpoint;
  const filter = capture.selector.kind === "inbox" ? capture.selector.filter : null;
  if (filter === null) throw new Error("Inbox capture selector invariant");
  const selectedItems = page.items.filter((item) => selected.has(item.id));
  return (
    <div className="rq-inbox-feed">
      <div className="rq-inbox-feed-heading">
        <p>
          Notifications for {page.recipient.kind} <strong>{page.recipient.id}</strong>. This view
          never acknowledges on read or wait.
        </p>
        <span>
          {page.items.length} on this page
          {page.remaining !== "0" ? ` · ${page.remaining} more available` : ""}
        </span>
      </div>
      <Toolbar label="Selected Inbox notifications">
        <Button
          requiresActor
          tone="primary"
          disabled={selectedItems.length === 0}
          onClick={() =>
            props.controller.create(
              {
                method: "inbox.ack",
                consumerId: page.consumerId,
                recipient: page.recipient,
                notificationIds: selectedItems.map((item) => item.id),
              },
              { ...capture.captured, value: page },
            )
          }
        >
          Acknowledge selected for this consumer
        </Button>
        <Button tone="quiet" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>
          Clear selection
        </Button>
        {selectedItems.length > 0 && (
          <span className="rq-selection-count">{selectedItems.length} selected</span>
        )}
      </Toolbar>
      {selectedId != null && !page.items.some((item) => item.id === selectedId) && (
        <p role="status">
          Selected notification {selectedId} is unavailable in this bounded consumer capture.
          Acknowledged entries are filtered by the daemon; this is not a complete message archive.
        </p>
      )}
      {page.items.length === 0 && (
        <div className="rq-inbox-empty">
          <Icon name="discussions" />
          <h3>No unread notifications in this capture</h3>
          <p>
            New matching notifications appear in a live read. Reading or waiting never acknowledges
            a delivery.
          </p>
        </div>
      )}
      {page.items.map((item) => (
        <article
          className="rq-notification"
          key={item.id}
          aria-label={`Notification ${item.id}`}
          data-kind={item.kind}
        >
          <header>
            <label className="rq-notification-select">
              <input
                type="checkbox"
                aria-label={`Select notification ${item.id}`}
                checked={selected.has(item.id)}
                onChange={(event) =>
                  setSelected((previous) => {
                    const next = new Set(
                      page.items.filter((value) => previous.has(value.id)).map((value) => value.id),
                    );
                    if (event.target.checked) next.add(item.id);
                    else next.delete(item.id);
                    return next;
                  })
                }
              />
            </label>
            <ActorAvatar actor={item.attribution.actorId} />
            <div>
              <h3>{item.kind.replaceAll("_", " ")}</h3>
              <p>
                {item.attribution.actorId} · <RecordedTime value={item.attribution.timestamp} />
              </p>
            </div>
            {item.currentRequestStatus !== null && (
              <span className="rq-status" data-status={item.currentRequestStatus}>
                Now {item.currentRequestStatus}
              </span>
            )}
          </header>
          <div className="rq-notification-body">
            {item.capturedBody === null ? (
              <p>No causal body is included for this notification kind.</p>
            ) : item.capturedBody.tombstone ? (
              <p>The captured body is a tombstone.</p>
            ) : (
              <RequestBody
                body={item.capturedBody.body}
                identity={`${e.connectionId}:${e.generation}:${item.id}:${item.capturedBody.id}:${item.capturedBody.revision}`}
                partial={!complete(capture.captured)}
              />
            )}
          </div>
          <div className="rq-notification-actions">
            {item.source.kind === "request" && (
              <Button
                onClick={() =>
                  props.context.navigate(
                    requestsRoute(props.context, {
                      ...e,
                      kind: "request",
                      requestId: item.source.id,
                      revision: null,
                    }),
                  )
                }
              >
                Open current request
              </Button>
            )}
            <Button
              onClick={() =>
                props.context.navigate(
                  requestsRoute(props.context, {
                    ...e,
                    kind: "inbox",
                    capture: {
                      consumerId: page.consumerId,
                      recipient: page.recipient,
                      after: page.after,
                      through: page.through,
                      kinds: filter.kinds,
                      ticketId: filter.ticketId,
                      excludeSelf: page.excludeSelf,
                      notificationId: item.id,
                    },
                  }),
                )
              }
            >
              Keep captured notification link
            </Button>
          </div>
        </article>
      ))}
    </div>
  );
}
