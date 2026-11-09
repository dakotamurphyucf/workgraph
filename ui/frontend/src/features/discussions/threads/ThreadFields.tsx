import { FormSection } from "../FormSection";
import { ActorListField, ReferenceField } from "../ReferenceFields";
import { Field, Select } from "../../../components/Primitives";
import type { Comment, DiscussionLink, ThreadsInput } from "./types";
const kinds: readonly Comment["kind"][] = [
  "comment",
  "progress",
  "decision",
  "blocker",
  "evidence",
];
function Multiline({
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
  return (
    <label className="wg-field">
      {label}
      <textarea
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        rows={label.includes("Body") ? 8 : 3}
      />
      {hint && <span className="wg-hint">{hint}</span>}
    </label>
  );
}
function Scope({
  value,
  onChange,
  disabled,
}: {
  readonly value:
    { readonly kind: "workspace" } | { readonly kind: "project"; readonly id: string };
  readonly onChange: (
    value: { readonly kind: "workspace" } | { readonly kind: "project"; readonly id: string },
  ) => void;
  readonly disabled: boolean;
}) {
  return (
    <>
      <Select
        label="Board scope"
        value={value.kind}
        disabled={disabled}
        onChange={(event) =>
          onChange(
            event.target.value === "workspace"
              ? { kind: "workspace" }
              : { kind: "project", id: "" },
          )
        }
      >
        <option value="workspace">Workspace</option>
        <option value="project">Project</option>
      </Select>
      {value.kind === "project" && (
        <Field
          label="Board project ID"
          value={value.id}
          disabled={disabled}
          onChange={(event) => onChange({ kind: "project", id: event.target.value })}
        />
      )}
    </>
  );
}
export function ThreadFields({
  input,
  onChange,
  disabled,
}: {
  readonly input: ThreadsInput;
  readonly onChange: (input: ThreadsInput) => void;
  readonly disabled: boolean;
}) {
  const field = (label: string, value: string, set: (value: string) => void, hint?: string) => (
    <Field
      label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => set(event.target.value)}
      {...(hint === undefined ? {} : { hint })}
    />
  );
  const body = (value: string, set: (value: string) => void) => (
    <Multiline label="Body" value={value} onChange={set} disabled={disabled} />
  );
  const kind = (value: Comment["kind"], set: (value: Comment["kind"]) => void) => (
    <Select
      label="Message kind"
      value={value}
      disabled={disabled}
      onChange={(event) => {
        const found = kinds.find((item) => item === event.target.value);
        if (found !== undefined) set(found);
      }}
    >
      {kinds.map((item) => (
        <option key={item} value={item}>
          {item}
        </option>
      ))}
    </Select>
  );
  switch (input.method) {
    case "board.put":
      return (
        <FormSection
          title="Board details"
          description="Choose a name and a home for this collection of conversations."
          icon="board"
        >
          {field("Board title", input.fields.title, (title) =>
            onChange({ ...input, fields: { ...input.fields, title } }),
          )}
          <Scope
            value={input.fields.scope}
            disabled={disabled || input.existing}
            onChange={(scope) => onChange({ ...input, fields: { ...input.fields, scope } })}
          />
          {input.existing && (
            <p className="wg-hint">
              This board keeps its original scope. Review checks for newer changes before saving.
            </p>
          )}
          <details className="dc-form-options">
            <summary>Board identifier</summary>
            <p>
              An ID is generated for new records. Keep it unless you need a specific name for
              scripts or links.
            </p>
            {field("Board ID", input.fields.id, (id) =>
              onChange({ ...input, fields: { ...input.fields, id } }),
            )}
          </details>
        </FormSection>
      );
    case "thread.put":
      return (
        <>
          <FormSection
            title="Conversation details"
            description="Name the conversation and choose the board where people will find it."
            icon="discussions"
          >
            <ReferenceField
              kind="board"
              label="Board ID"
              value={input.fields.boardId}
              disabled={disabled || input.existing}
              onChange={(boardId) => onChange({ ...input, fields: { ...input.fields, boardId } })}
              hint="A board groups conversations. Select the board where this thread should live."
            />
            {field("Thread title", input.fields.title, (title) =>
              onChange({ ...input, fields: { ...input.fields, title } }),
            )}
          </FormSection>
          <FormSection
            title="People in this conversation"
            description="Add the people or agents involved. You can update this list later."
            icon="participants"
            tone="violet"
          >
            <ActorListField
              label="Participants"
              value={input.fields.participants}
              disabled={disabled}
              onChange={(participants) =>
                onChange({ ...input, fields: { ...input.fields, participants } })
              }
            />
          </FormSection>
          <details className="dc-form-options">
            <summary>Optional: mentions</summary>
            <p>
              Optionally call attention to people, link related work, or choose when this
              conversation closes.
            </p>
            <ActorListField
              label="Mentions"
              value={input.fields.mentions}
              disabled={disabled}
              onChange={(mentions) => onChange({ ...input, fields: { ...input.fields, mentions } })}
            />
          </details>
          <details className="dc-form-options">
            <summary>Optional: link related work</summary>
            <p>
              Connect this conversation to tickets, resources or other records. These links provide
              context.
            </p>
            <fieldset disabled={disabled} className="dc-flat-fields">
              <legend>Linked records</legend>
              {input.fields.links.map((link, index) => (
                <div key={index}>
                  <Select
                    label={`Link ${index + 1} type`}
                    value={link.kind}
                    onChange={(event) => {
                      const kind: DiscussionLink["kind"] | undefined = (
                        ["workspace", "project", "milestone", "ticket", "resource"] as const
                      ).find((value) => value === event.target.value);
                      if (kind !== undefined)
                        onChange({
                          ...input,
                          fields: {
                            ...input.fields,
                            links: input.fields.links.map((value, i) =>
                              i === index ? { kind, id: "" } : value,
                            ),
                          },
                        });
                    }}
                  >
                    <option value="workspace">Workspace</option>
                    <option value="project">Project</option>
                    <option value="milestone">Milestone</option>
                    <option value="ticket">Ticket</option>
                    <option value="resource">Resource</option>
                  </Select>
                  {link.kind !== "workspace" &&
                    (link.kind === "ticket"
                      ? (label: string, value: string, onChange: (id: string) => void) => (
                          <ReferenceField
                            kind="ticket"
                            label={label}
                            value={value}
                            onChange={onChange}
                            disabled={disabled}
                          />
                        )
                      : field)(`Link ${index + 1} ID`, link.id, (id) =>
                      onChange({
                        ...input,
                        fields: {
                          ...input.fields,
                          links: input.fields.links.map((value, i) =>
                            i === index ? { ...value, id } : value,
                          ),
                        },
                      }),
                    )}
                  <button
                    type="button"
                    onClick={() =>
                      onChange({
                        ...input,
                        fields: {
                          ...input.fields,
                          links: input.fields.links.filter((_, i) => i !== index),
                        },
                      })
                    }
                  >
                    Remove link {index + 1}
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  onChange({
                    ...input,
                    fields: {
                      ...input.fields,
                      links: [...input.fields.links, { kind: "ticket", id: "" }],
                    },
                  })
                }
              >
                Add linked record
              </button>
            </fieldset>
          </details>
          <details className="dc-form-options">
            <summary>Conversation status and closing rules</summary>
            <p>Choose how this conversation is closed and whether it should stay pinned.</p>
            <Select
              label="Thread status"
              value={input.fields.status}
              disabled={disabled}
              onChange={(event) => {
                const status = event.target.value;
                if (status === "open" || status === "awaiting_response" || status === "resolved")
                  onChange({ ...input, fields: { ...input.fields, status } });
              }}
            >
              <option value="open">Open</option>
              <option value="awaiting_response">Awaiting response</option>
              <option value="resolved">Resolved</option>
            </Select>
            <Select
              label="Closure policy"
              value={input.fields.closurePolicy}
              disabled={disabled}
              onChange={(event) => {
                const closurePolicy = event.target.value;
                if (closurePolicy === "manual" || closurePolicy === "when_all_requests_terminal")
                  onChange({ ...input, fields: { ...input.fields, closurePolicy } });
              }}
            >
              <option value="manual">Manual</option>
              <option value="when_all_requests_terminal">
                When all requests are answered or cancelled
              </option>
            </Select>
            <label>
              <input
                type="checkbox"
                checked={input.fields.pinned}
                disabled={disabled}
                onChange={(event) =>
                  onChange({ ...input, fields: { ...input.fields, pinned: event.target.checked } })
                }
              />{" "}
              Pin thread
            </label>
            <p className="wg-hint">
              Manual closure lets you choose the status. Automatic closure resolves the thread once
              every request is answered or cancelled. Open requests can prevent closing a thread.
            </p>
          </details>
          <details className="dc-form-options">
            <summary>Thread identifier</summary>
            <p>
              An ID is generated for new records. Keep it unless you need a specific name for
              scripts or links.
            </p>
            {field("Thread ID", input.fields.id, (id) =>
              onChange({ ...input, fields: { ...input.fields, id } }),
            )}
          </details>
        </>
      );
    case "thread.reply":
      return (
        <FormSection
          title="Your reply"
          description="Add to this conversation. Use the optional reply ID to respond to a particular message."
          icon="discussions"
        >
          {field("Thread ID", input.threadId, (threadId) => onChange({ ...input, threadId }))}
          {body(input.body, (value) => onChange({ ...input, body: value }))}
          {kind(input.kind, (value) => onChange({ ...input, kind: value }))}
          {field("Reply to comment ID (optional)", input.replyToId, (replyToId) =>
            onChange({ ...input, replyToId }),
          )}
        </FormSection>
      );
    case "thread.attach":
      return (
        <FormSection
          title="Attach a comment"
          description="Connect a comment already saved in the same board scope to this conversation."
          icon="discussions"
        >
          {field("Thread ID", input.threadId, (threadId) => onChange({ ...input, threadId }))}
          {field("Existing comment ID", input.commentId, (commentId) =>
            onChange({ ...input, commentId }),
          )}
          <p className="wg-hint">
            Attaches an existing comment from the same board scope. Its author, target and history
            remain unchanged.
          </p>
        </FormSection>
      );
    case "thread.pin_message":
      return (
        <FormSection
          title="Pin a message"
          description="Identify the message and choose whether to keep it pinned in the discussion."
          icon="discussions"
        >
          {field("Thread ID", input.threadId, (threadId) => onChange({ ...input, threadId }))}
          {field("Attached comment ID", input.commentId, (commentId) =>
            onChange({ ...input, commentId }),
          )}
          <label>
            <input
              type="checkbox"
              checked={input.pinned}
              disabled={disabled}
              onChange={(event) => onChange({ ...input, pinned: event.target.checked })}
            />{" "}
            Pin message
          </label>
        </FormSection>
      );
    case "comment.add":
      return (
        <FormSection
          title="Your comment"
          description="Write an update and choose a kind to help others recognize its purpose."
          icon="discussions"
        >
          {body(input.body, (value) => onChange({ ...input, body: value }))}
          {kind(input.kind, (value) => onChange({ ...input, kind: value }))}
          {field("Reply to comment ID (optional)", input.replyToId, (replyToId) =>
            onChange({ ...input, replyToId }),
          )}
        </FormSection>
      );
    case "comment.edit":
      return (
        <FormSection
          title="Edit your message"
          description="Update the current text. Earlier versions remain in the message history."
          icon="discussions"
        >
          {field("Comment ID", input.commentId, (commentId) => onChange({ ...input, commentId }))}
          {body(input.body, (value) => onChange({ ...input, body: value }))}
        </FormSection>
      );
    case "comment.tombstone":
      return (
        <FormSection
          title="Remove message content"
          description="The current message body is removed; its historical record is retained."
          icon="discussions"
        >
          {field("Comment ID", input.commentId, (commentId) => onChange({ ...input, commentId }))}
          <p role="note">
            Removes the current body through a tombstone. Historical revisions remain available.
            Completion evidence requires a correction reply instead.
          </p>
        </FormSection>
      );
    case "message.send":
      return (
        <>
          <FormSection
            title="Your message"
            description="Write what you want to share. Markdown is supported for lists, links and code."
            icon="discussions"
          >
            {body(input.body, (value) => onChange({ ...input, body: value }))}
          </FormSection>
          <FormSection
            title="Who should receive it?"
            description="Add people or agents. Use the optional section below for individual runs or teams."
            icon="participants"
            tone="violet"
          >
            <ActorListField
              label="Actor recipients"
              value={input.actorRecipients}
              disabled={disabled}
              onChange={(actorRecipients) => onChange({ ...input, actorRecipients })}
            />
          </FormSection>
          <details className="dc-form-options">
            <summary>Optional: runs and teams</summary>
            <p>
              Address a specific working session or a named team, and optionally connect the message
              to a ticket.
            </p>
            <Multiline
              label="Run recipients"
              value={input.runRecipients}
              disabled={disabled}
              onChange={(runRecipients) => onChange({ ...input, runRecipients })}
              hint="IDs, one per line."
            />
            <Multiline
              label="Recipient teams"
              value={input.teamIds}
              disabled={disabled}
              onChange={(teamIds) => onChange({ ...input, teamIds })}
              hint="Team membership is expanded and frozen by the daemon when committed."
            />
          </details>
          <FormSection
            title="Related work"
            description="Optionally link this message to a ticket so recipients have its context."
            icon="work"
            tone="green"
          >
            <ReferenceField
              kind="ticket"
              label="Related ticket ID (optional)"
              value={input.ticketId}
              disabled={disabled}
              onChange={(ticketId) => onChange({ ...input, ticketId })}
            />
          </FormSection>
          <details className="dc-form-options">
            <summary>Optional: reply and tracking IDs</summary>
            <p>
              Use these IDs when continuing an earlier direct message or connecting an external
              workflow.
            </p>
            {field("Reply to message ID (optional)", input.replyToMessageId, (replyToMessageId) =>
              onChange({ ...input, replyToMessageId }),
            )}
            {field("Correlation ID (optional)", input.correlationId, (correlationId) =>
              onChange({ ...input, correlationId }),
            )}
          </details>
          <details className="dc-form-options">
            <summary>Saved message identity</summary>
            {field("Message ID", input.messageId, (messageId) => onChange({ ...input, messageId }))}
          </details>
        </>
      );
  }
}
