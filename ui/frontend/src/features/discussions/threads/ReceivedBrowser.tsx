import { RecipientPicker } from "../RecipientPicker";
import { Icon } from "../../../components/Icon";
import { Button, Field, Select, Toolbar } from "../../../components/Primitives";
import { endpoint } from "./model";
import { ThreadRead } from "./ThreadReads";
import type { MessageFilter, ThreadsFeatureProps } from "./types";

/** Recipient choice belongs to the reader, independently of the acting writer.
 * Retained links keep their exact interval; this browser never acknowledges. */
export function ReceivedBrowser({
  props,
  filter,
  pinned,
  onRead,
}: {
  readonly props: ThreadsFeatureProps;
  readonly filter: MessageFilter;
  readonly pinned: boolean;
  readonly onRead: () => void;
}) {
  const { controller, context } = props;
  const state = controller.get();
  const actor = context.writer.actorId;
  const change = (patch: Partial<MessageFilter>) =>
    controller.messageFilter({ ...filter, ...patch });
  return (
    <div className="dc-received-scroll">
      <div className="dc-received-page">
        <header className="dc-received-heading">
          <span className="dc-received-icon">
            <Icon name="discussions" />
          </span>
          <div>
            <h2>Received messages</h2>
            <p>
              Read direct messages delivered to an actor or run, and reply as your selected author.
            </p>
          </div>
        </header>
        <form
          className="dc-recipient-form"
          onSubmit={(event) => {
            event.preventDefault();
            onRead();
          }}
        >
          <fieldset disabled={pinned} className="dc-recipient-fields">
            <legend>Choose who received the messages</legend>
            <div className="dc-recipient-row">
              <Select
                label="Recipient kind"
                value={filter.recipient.kind}
                onChange={(event) => {
                  const kind = event.target.value;
                  if (kind === "actor" || kind === "run")
                    change({ recipient: { ...filter.recipient, kind } });
                }}
              >
                <option value="actor">Actor</option>
                <option value="run">Run</option>
              </Select>
              {filter.recipient.kind === "actor" ? (
                <RecipientPicker
                  context={context}
                  endpoint={state.endpoint ?? endpoint(context)}
                  label="Recipient ID"
                  value={filter.recipient.id}
                  disabled={pinned}
                  onChange={(id) => change({ recipient: { ...filter.recipient, id } })}
                />
              ) : (
                <Field
                  label="Recipient ID"
                  placeholder="Enter a run ID"
                  value={filter.recipient.id}
                  onChange={(event) =>
                    change({ recipient: { ...filter.recipient, id: event.target.value } })
                  }
                />
              )}
              <Button
                type="button"
                tone="quiet"
                requiresActor
                onClick={() => {
                  if (actor !== null) change({ recipient: { kind: "actor", id: actor } });
                }}
              >
                Use current actor as recipient
              </Button>
            </div>
            <details className="dc-received-filters">
              <summary>Ticket, interval and reading queue</summary>
              <div className="dc-received-filter-grid">
                <Field
                  label="Related ticket filter (optional)"
                  value={filter.ticketId}
                  onChange={(event) => change({ ticketId: event.target.value })}
                />
                <Field
                  label="After notification"
                  value={filter.after}
                  onChange={(event) => change({ after: event.target.value })}
                />
                <Field
                  label="Received-message browser consumer"
                  value={filter.consumerId}
                  readOnly
                  hint="A separate read-only queue. Reading here leaves the actionable Inbox untouched."
                />
              </div>
              <label>
                <input
                  type="checkbox"
                  checked={filter.excludeSelf}
                  onChange={(event) => change({ excludeSelf: event.target.checked })}
                />{" "}
                Exclude recipient's own actions
              </label>
            </details>
          </fieldset>
          {pinned ? (
            <p className="dc-received-capture-note">
              Retained interval ({filter.after}, {filter.through}] and original filters. Choose
              Received messages above to start a new query.
            </p>
          ) : (
            <p className="dc-received-capture-note">
              Changing your acting author does not change this recipient.
            </p>
          )}
          <Toolbar label="Received-message query">
            <Button type="submit" tone="primary">
              {pinned ? "Read retained interval" : "Read received messages"}
            </Button>
            {props.renderInbox?.(state.endpoint ?? endpoint(context))}
          </Toolbar>
        </form>
        <ThreadRead kind="messages" props={props} />
        {!state.reads.has("messages") && (
          <div className="dc-received-start">
            <Icon name="participants" />
            <h3>Choose a recipient to begin</h3>
            <p>
              Your acting author is used for replies. You can browse another actor or run without
              becoming that recipient.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
