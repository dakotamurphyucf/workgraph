import { FormSection } from "../FormSection";
import { ReferenceField } from "../ReferenceFields";
import type { ReactNode } from "react";
import { Button, Field, Select } from "../../../components/Primitives";
import { notificationKinds, requestKinds } from "./codecs";
import type {
  EditableRecipient,
  NotificationKind,
  RequestFields as Fields,
  RequestsInput,
} from "./types";
export function Multiline({
  label,
  value,
  onChange,
  disabled = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
}) {
  return (
    <label className="wg-field">
      {label}
      <textarea
        aria-label={label}
        value={value}
        disabled={disabled}
        rows={label === "Question" || label === "Answer" ? 7 : 3}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
export function RecipientField({
  label,
  value,
  onChange,
  disabled = false,
  actorInput,
}: {
  readonly actorInput?: ReactNode;
  readonly label: string;
  readonly value: EditableRecipient;
  readonly onChange: (value: EditableRecipient) => void;
  readonly disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="dc-recipient-editor">
      <legend>{label}</legend>
      <Select
        label={`${label} kind`}
        value={value.kind}
        onChange={(event) =>
          onChange({ ...value, kind: event.target.value === "run" ? "run" : "actor" })
        }
      >
        <option value="actor">Actor</option>
        <option value="run">Run</option>
      </Select>
      {value.kind === "actor" ? (
        (actorInput ?? (
          <ReferenceField
            kind="actor"
            label={`${label} ID`}
            value={value.id}
            disabled={disabled}
            onChange={(id) => onChange({ ...value, id })}
          />
        ))
      ) : (
        <Field
          label={`${label} ID`}
          value={value.id}
          onChange={(event) => onChange({ ...value, id: event.target.value })}
        />
      )}
    </fieldset>
  );
}
function Recipients({
  label,
  values,
  onChange,
  disabled,
}: {
  readonly label: string;
  readonly values: readonly EditableRecipient[];
  readonly onChange: (value: readonly EditableRecipient[]) => void;
  readonly disabled: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="dc-recipient-list">
      <legend>{label}</legend>
      {values.length === 0 && (
        <p className="dc-empty-field">No recipients added yet. Add a person, agent or run below.</p>
      )}
      {values.map((value, index) => (
        <div key={index} className="dc-recipient-list-row">
          <RecipientField
            label={`${label} ${index + 1}`}
            value={value}
            onChange={(value) =>
              onChange(values.map((old, position) => (position === index ? value : old)))
            }
          />
          <Button onClick={() => onChange(values.filter((_, position) => position !== index))}>
            Remove recipient {index + 1}
          </Button>
        </div>
      ))}
      <Button onClick={() => onChange([...values, { kind: "actor", id: "" }])}>
        Add {label.toLowerCase()}
      </Button>
    </fieldset>
  );
}
export function Kinds({
  values,
  onChange,
  disabled = false,
}: {
  readonly values: readonly NotificationKind[];
  readonly onChange: (values: readonly NotificationKind[]) => void;
  readonly disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="dc-kind-options">
      <legend>Notification kinds (none means all)</legend>
      {notificationKinds.map((kind) => (
        <label key={kind}>
          <input
            type="checkbox"
            checked={values.includes(kind)}
            onChange={(event) =>
              onChange(
                event.target.checked ? [...values, kind] : values.filter((value) => value !== kind),
              )
            }
          />
          {kind.replaceAll("_", " ")}
        </label>
      ))}
    </fieldset>
  );
}
const split = (value: string) =>
  value
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
export function RequestFields({
  input,
  onChange,
  disabled,
}: {
  readonly input: RequestsInput;
  readonly onChange: (input: RequestsInput) => void;
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
  const reference = (
    kind: "ticket" | "board" | "thread" | "actor",
    label: string,
    value: string,
    set: (value: string) => void,
    hint?: string,
  ) => (
    <ReferenceField
      kind={kind}
      label={label}
      value={value}
      disabled={disabled}
      onChange={set}
      {...(hint === undefined ? {} : { hint })}
    />
  );
  const multiline = (label: string, value: string, set: (value: string) => void) => (
    <Multiline label={label} value={value} disabled={disabled} onChange={set} />
  );
  const common = (values: Fields, set: (value: Fields) => void) => (
    <>
      <FormSection
        title="Who can answer?"
        description="Choose the request type and the actor allowed to resolve it. Delivery is configured separately below."
        icon="participants"
        tone="violet"
      >
        <Select
          label="Question kind"
          value={values.kind}
          disabled={disabled}
          onChange={(event) => {
            const kind = requestKinds.find((kind) => kind === event.target.value);
            if (kind !== undefined) set({ ...values, kind });
          }}
        >
          {requestKinds.map((kind) => (
            <option key={kind} value={kind}>
              {kind.replaceAll("_", " ")}
            </option>
          ))}
        </Select>
        {reference(
          "actor",
          "Designated resolver",
          values.resolverId,
          (resolverId) => set({ ...values, resolverId }),
          "Only this actor may resolve or reassign the request. This does not deliver the question: add at least one direct recipient separately, including the resolver if they should receive it.",
        )}
      </FormSection>
      <FormSection
        title="Who should receive it?"
        description="Add everyone who needs to see this question. Naming a resolver alone does not notify them."
        icon="discussions"
        tone="green"
      >
        <Button
          tone="quiet"
          disabled={
            disabled ||
            !values.resolverId.trim() ||
            values.recipients.some(
              (recipient) => recipient.kind === "actor" && recipient.id === values.resolverId,
            )
          }
          onClick={() =>
            set({
              ...values,
              recipients: [...values.recipients, { kind: "actor", id: values.resolverId }],
            })
          }
        >
          Also notify the resolver
        </Button>
        <Recipients
          label="Direct recipients"
          values={values.recipients}
          disabled={disabled}
          onChange={(recipients) => set({ ...values, recipients })}
        />
      </FormSection>
      <details className="dc-form-options">
        <summary>Optional: priority, deadline and request links</summary>
        <p>
          Use these when the request needs scheduling or links to earlier questions. The generated
          ID can usually stay unchanged.
        </p>
        {field("Request ID", values.id, (id) => set({ ...values, id }))}
        {field("Priority 0–4", values.priority, (priority) => set({ ...values, priority }))}
        {field(
          "Deadline Unix milliseconds",
          values.deadlineUnixMs,
          (deadlineUnixMs) => set({ ...values, deadlineUnixMs }),
          "Optional exact timestamp; passing a deadline does not resolve the request.",
        )}
        {multiline("Related request IDs, one per line", values.relatedIds.join("\n"), (value) =>
          set({ ...values, relatedIds: split(value) }),
        )}
        {multiline(
          "Superseded request IDs, one per line",
          values.supersedesIds.join("\n"),
          (value) => set({ ...values, supersedesIds: split(value) }),
        )}
      </details>
    </>
  );
  switch (input.method) {
    case "request.ask":
      return (
        <>
          <FormSection
            title="Your question"
            description="Describe what you need to know and include enough context for someone to answer."
            icon="discussions"
          >
            {multiline("Question", input.body, (body) => onChange({ ...input, body }))}
          </FormSection>
          {common(input.fields, (fields) => onChange({ ...input, fields }))}
          <FormSection
            title="Where the conversation lives"
            description="Create a discussion or use an existing one. A linked ticket or board determines where the question appears."
            icon="board"
            tone="blue"
          >
            <Select
              label="Question destination"
              value={input.destination.kind}
              disabled={disabled}
              onChange={(event) =>
                onChange({
                  ...input,
                  destination:
                    event.target.value === "thread"
                      ? { kind: "thread", threadId: "" }
                      : { kind: "new", title: "", boardId: "", ticketId: "" },
                })
              }
            >
              <option value="new">New discussion</option>
              <option value="thread">Existing discussion</option>
            </Select>
            {input.destination.kind === "thread" ? (
              reference("thread", "Discussion ID", input.destination.threadId, (threadId) =>
                onChange({ ...input, destination: { kind: "thread", threadId } }),
              )
            ) : (
              <>
                {field("Discussion title", input.destination.title, (title) => {
                  if (input.destination.kind === "new")
                    onChange({ ...input, destination: { ...input.destination, title } });
                })}
                {reference(
                  "board",
                  "Destination board ID (optional)",
                  input.destination.boardId,
                  (boardId) => {
                    if (input.destination.kind === "new")
                      onChange({ ...input, destination: { ...input.destination, boardId } });
                  },
                )}
                {reference(
                  "ticket",
                  "Linked ticket ID (optional)",
                  input.destination.ticketId,
                  (ticketId) => {
                    if (input.destination.kind === "new")
                      onChange({ ...input, destination: { ...input.destination, ticketId } });
                  },
                )}
                <p>
                  {input.destination.boardId === "" && input.destination.ticketId === ""
                    ? "Destination: the workspace's default discussion board. The selected project breadcrumb does not set this question's scope."
                    : "The chosen board or ticket determines where this question appears. Review that destination before applying."}
                </p>
              </>
            )}
          </FormSection>
        </>
      );
    case "request.create":
      return (
        <>
          <FormSection
            title="Use an existing question"
            description="Choose the discussion, then enter the ID of the comment already attached to it. That comment becomes the question; its text is preserved."
            icon="discussions"
          >
            {reference("thread", "Discussion ID", input.threadId, (threadId) =>
              onChange({ ...input, threadId }),
            )}
            {field("Attached question comment ID", input.commentId, (commentId) =>
              onChange({ ...input, commentId }),
            )}
          </FormSection>
          {common(input.fields, (fields) => onChange({ ...input, fields }))}
          <details className="dc-form-options">
            <summary>Optional: teams and tracking</summary>
            <p>Notify a team or connect this request to an external workflow.</p>
            {multiline("Team IDs, one per line", input.teams.join("\n"), (value) =>
              onChange({ ...input, teams: split(value) }),
            )}
            <p>
              Team members are expanded and frozen by the daemon when applied. Current team
              configuration is a preview, not a delivery guarantee.
            </p>
            {field("Correlation (optional)", input.correlationId, (correlationId) =>
              onChange({ ...input, correlationId }),
            )}
            {field("Reply-to request (optional)", input.replyToId, (replyToId) =>
              onChange({ ...input, replyToId }),
            )}
          </details>
        </>
      );
    case "request.acknowledge":
    case "request.accept":
      return (
        <FormSection
          title="Recipient and request"
          description="Confirm which request and delivery recipient this action applies to."
          tone="violet"
        >
          {field("Request ID", input.requestId, (requestId) => onChange({ ...input, requestId }))}
          <RecipientField
            label="Frozen recipient"
            value={input.recipient}
            disabled={disabled}
            onChange={(recipient) => onChange({ ...input, recipient })}
          />
          <p>
            {input.method === "request.acknowledge"
              ? "Acknowledge delivery for this recipient. This does not accept responsibility or acknowledge an Inbox consumer."
              : "Accept responsibility as this frozen recipient. This does not resolve the request or acknowledge delivery."}
          </p>
        </FormSection>
      );
    case "request.reassign":
      return (
        <FormSection
          title="Responsibility"
          description="Choose a recipient who already received the request, or clear the current assignment."
          tone="violet"
        >
          {field("Request ID", input.requestId, (requestId) => onChange({ ...input, requestId }))}
          <label>
            <input
              type="checkbox"
              disabled={disabled}
              checked={input.recipient === null}
              onChange={(event) =>
                onChange({
                  ...input,
                  recipient: event.target.checked ? null : { kind: "actor", id: "" },
                })
              }
            />
            Clear accepted responsibility
          </label>
          {input.recipient !== null && (
            <RecipientField
              label="New responsible recipient"
              value={input.recipient}
              disabled={disabled}
              onChange={(recipient) => onChange({ ...input, recipient })}
            />
          )}
          <p>
            Only the designated resolver can reassign to a frozen delivery recipient. The designated
            resolver itself stays unchanged.
          </p>
        </FormSection>
      );
    case "request.resolve":
      return (
        <FormSection
          title="Answer and close"
          description="Write the answer to keep with this request. Review the request ID before saving."
          tone="violet"
        >
          {multiline("Answer", input.body, (body) => onChange({ ...input, body }))}
          {field("Request ID", input.requestId, (requestId) => onChange({ ...input, requestId }))}
          <p>
            An optional answer is attached atomically with resolution. Only the designated resolver
            can resolve this request.
          </p>
        </FormSection>
      );
    case "request.cancel":
      return (
        <FormSection
          title="Cancel this request"
          description="Cancellation closes the request without deleting its conversation or history."
          tone="violet"
        >
          {field("Request ID", input.requestId, (requestId) => onChange({ ...input, requestId }))}
          <p>
            Cancel this open request as its creator or designated resolver. Its recorded history
            remains available.
          </p>
        </FormSection>
      );
    case "request.metadata":
      return (
        <FormSection
          title="Request settings"
          description="Choose which values to keep and which to change. Only the changes you select will be saved."
          tone="violet"
        >
          {field("Request ID", input.requestId, (requestId) => onChange({ ...input, requestId }))}
          <Select
            label="Priority change"
            value={input.priority.kind}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...input,
                priority:
                  event.target.value === "keep" ? { kind: "keep" } : { kind: "value", value: "2" },
              })
            }
          >
            <option value="keep">Keep current</option>
            <option value="value">Set priority</option>
          </Select>
          {input.priority.kind === "value" &&
            field("New priority 0–4", input.priority.value, (value) =>
              onChange({ ...input, priority: { kind: "value", value } }),
            )}
          <Select
            label="Deadline change"
            value={input.deadlineUnixMs.kind}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...input,
                deadlineUnixMs:
                  event.target.value === "keep"
                    ? { kind: "keep" }
                    : event.target.value === "clear"
                      ? { kind: "clear" }
                      : { kind: "value", value: "" },
              })
            }
          >
            <option value="keep">Keep current</option>
            <option value="clear">Clear deadline</option>
            <option value="value">Set deadline</option>
          </Select>
          {input.deadlineUnixMs.kind === "value" &&
            field("New deadline Unix milliseconds", input.deadlineUnixMs.value, (value) =>
              onChange({ ...input, deadlineUnixMs: { kind: "value", value } }),
            )}
          {(["relatedIds", "supersedesIds"] as const).map((key) => (
            <div key={key}>
              <Select
                label={`${key === "relatedIds" ? "Related" : "Superseded"} requests change`}
                value={input[key].kind}
                disabled={disabled}
                onChange={(event) =>
                  onChange({
                    ...input,
                    [key]:
                      event.target.value === "keep"
                        ? { kind: "keep" }
                        : { kind: "value", value: [] },
                  })
                }
              >
                <option value="keep">Keep current</option>
                <option value="value">Replace list (empty clears)</option>
              </Select>
              {input[key].kind === "value" &&
                multiline(
                  `${key === "relatedIds" ? "Related" : "Superseded"} replacement IDs`,
                  input[key].value.join("\n"),
                  (value) => onChange({ ...input, [key]: { kind: "value", value: split(value) } }),
                )}
            </div>
          ))}
        </FormSection>
      );
    case "inbox.ack":
      return (
        <FormSection
          title="Mark notifications handled"
          description="Confirm the recipient and reading queue for the selected notifications."
          tone="violet"
        >
          {field("Actionable consumer ID", input.consumerId, (consumerId) =>
            onChange({ ...input, consumerId }),
          )}
          <RecipientField
            label="Inbox recipient"
            value={input.recipient}
            disabled={disabled}
            onChange={(recipient) => onChange({ ...input, recipient })}
          />
          <p>
            {input.notificationIds.length} explicitly selected notification(s). This acknowledgement
            affects only this consumer and recipient; it does not accept or resolve requests.
          </p>
        </FormSection>
      );
    case "team.put":
      return (
        <>
          <FormSection
            title="Team details"
            description="Give this group a name people will recognize when choosing who to notify."
            icon="participants"
            tone="violet"
          >
            {field("Team title", input.title, (title) => onChange({ ...input, title }))}
          </FormSection>
          <FormSection
            title="Team members"
            description="Add the actors or working runs that should receive future messages addressed to this team."
            icon="participants"
            tone="green"
          >
            <Recipients
              label="Team members"
              values={input.members}
              disabled={disabled}
              onChange={(members) => onChange({ ...input, members })}
            />
            <p>
              Replaces this team's current configuration. Previously frozen request deliveries stay
              unchanged.
            </p>
          </FormSection>
          <details className="dc-form-options">
            <summary>Team identifier and edit mode</summary>
            <p>
              Use a new ID to create a team. Updating an existing team replaces its current
              configuration after review.
            </p>
            <label>
              <input
                type="checkbox"
                disabled={disabled}
                checked={input.existing}
                onChange={(event) => onChange({ ...input, existing: event.target.checked })}
              />
              Update existing team
            </label>
            {field("Team ID", input.teamId, (teamId) => onChange({ ...input, teamId }))}
          </details>
        </>
      );
    case "subscription.put":
      return (
        <>
          <FormSection
            title="Who receives notifications?"
            description="This actor or run owns the subscription. Saving uses the acting identity shown above."
            icon="participants"
            tone="violet"
          >
            <RecipientField
              label="Subscription recipient"
              value={input.recipient}
              disabled={disabled}
              onChange={(recipient) => onChange({ ...input, recipient })}
            />
          </FormSection>
          <FormSection
            title="What should they follow?"
            description="Choose all discussions, workspace-level conversations, or one project. Optionally narrow this to a single discussion."
            icon="filter"
          >
            <Select
              label="Subscription scope"
              value={input.filter.scope?.kind ?? "all"}
              disabled={disabled}
              onChange={(event) =>
                onChange({
                  ...input,
                  filter: {
                    ...input.filter,
                    scope:
                      event.target.value === "workspace"
                        ? { kind: "workspace" }
                        : event.target.value === "project"
                          ? { kind: "project", id: "" }
                          : null,
                  },
                })
              }
            >
              <option value="all">All scopes</option>
              <option value="workspace">Workspace discussions only</option>
              <option value="project">One project</option>
            </Select>
            {input.filter.scope?.kind === "project" &&
              field("Subscription project ID", input.filter.scope.id, (id) =>
                onChange({ ...input, filter: { ...input.filter, scope: { kind: "project", id } } }),
              )}
            {reference(
              "thread",
              "Subscription discussion ID (optional)",
              input.filter.threadId,
              (threadId) => onChange({ ...input, filter: { ...input.filter, threadId } }),
            )}
          </FormSection>
          <details className="dc-form-options">
            <summary>Optional: choose notification types</summary>
            <p>
              Leave the selection empty to receive all matching event types, or choose only the
              updates you need.
            </p>
            <Kinds
              values={input.filter.kinds}
              disabled={disabled}
              onChange={(kinds) => onChange({ ...input, filter: { ...input.filter, kinds } })}
            />
          </details>
          <FormSection
            title="Delivery"
            description="Control whether this subscription matches future activity. Past notifications remain available."
            icon="discussions"
            tone="green"
          >
            <label>
              <input
                type="checkbox"
                disabled={disabled}
                checked={input.active}
                onChange={(event) => onChange({ ...input, active: event.target.checked })}
              />
              Active for future notifications
            </label>
            <p>
              Only this subscription recipient's acting actor/run can update it. Existing
              subscriptions retain their recipient; changes apply to future deliveries.
            </p>
          </FormSection>
          <details className="dc-form-options">
            <summary>Subscription identifier and edit mode</summary>
            <p>
              Keep the generated ID for a new subscription. Updating an existing subscription
              retains its recipient.
            </p>
            <label>
              <input
                type="checkbox"
                disabled={disabled}
                checked={input.existing}
                onChange={(event) => onChange({ ...input, existing: event.target.checked })}
              />
              Update existing subscription
            </label>
            {field("Subscription ID", input.subscriptionId, (subscriptionId) =>
              onChange({ ...input, subscriptionId }),
            )}
          </details>
        </>
      );
  }
}
