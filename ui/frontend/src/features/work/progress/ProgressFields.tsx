import { useId } from "react";
import { Field, Select } from "../../../components/Primitives";
import { EMPTY_HANDOFF } from "./model";
import type { CommentKind, HandoffFields, ProgressInput } from "./types";
function Text({
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
  const id = useId();
  return (
    <div className="wg-field">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        rows={4}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint && <p className="wg-hint">{hint}</p>}
    </div>
  );
}
function HandoffFieldsForm({
  value,
  change,
  disabled,
  nested = false,
}: {
  readonly value: HandoffFields;
  readonly change: (value: HandoffFields) => void;
  readonly disabled: boolean;
  readonly nested?: boolean;
}) {
  const update = (key: keyof HandoffFields, text: string) => change({ ...value, [key]: text });
  return (
    <fieldset disabled={disabled}>
      <legend>{nested ? "Completion handoff" : "Replace handoff"}</legend>
      <Text
        label="Handoff summary"
        value={value.summary}
        disabled={disabled}
        onChange={(text) => update("summary", text)}
      />
      <Text
        label="Next steps"
        value={value.nextSteps}
        disabled={disabled}
        onChange={(text) => update("nextSteps", text)}
      />
      {!nested && (
        <Text
          label="Handoff evidence"
          value={value.evidence}
          disabled={disabled}
          onChange={(text) => update("evidence", text)}
        />
      )}
      <Text
        label="Objective"
        value={value.objective}
        disabled={disabled}
        onChange={(text) => update("objective", text)}
      />
      <Text
        label="Completed work"
        value={value.completed}
        disabled={disabled}
        onChange={(text) => update("completed", text)}
      />
      <Text
        label="Decisions"
        value={value.decisions}
        disabled={disabled}
        onChange={(text) => update("decisions", text)}
      />
      <Text
        label="Blockers"
        value={value.blockers}
        disabled={disabled}
        onChange={(text) => update("blockers", text)}
      />
      <Text
        label="Linked resource IDs"
        value={value.resourceIds}
        disabled={disabled}
        onChange={(text) => update("resourceIds", text)}
        hint="One resolved ID per line. These links do not pin an immutable content version."
      />
      <Field
        label="Inspected planning revision"
        value={value.coversThrough}
        disabled={disabled}
        onChange={(event) => update("coversThrough", event.target.value)}
        hint="Enter only the last planning revision actually inspected. Zero claims no coverage; merely opening a view does not acknowledge instructions."
      />
    </fieldset>
  );
}
export function ProgressFields({
  input,
  change,
  disabled,
}: {
  readonly input: ProgressInput;
  readonly change: (value: ProgressInput) => void;
  readonly disabled: boolean;
}) {
  const body = (value: string, update: (value: string) => void, label = "Message") => (
    <Text
      label={label}
      value={value}
      disabled={disabled}
      onChange={update}
      hint="Markdown is supported. Write a message before posting (up to 65,536 UTF-8 bytes)."
    />
  );
  const attempt = (value: string, update: (value: string) => void) => (
    <Field
      label="Attempt ID"
      value={value}
      disabled={disabled}
      onChange={(event) => update(event.target.value)}
    />
  );
  switch (input.method) {
    case "ticket.progress":
    case "comment.add":
      return (
        <>
          {body(input.body, (text) => change({ ...input, body: text }))}
          <Select
            label="Message kind"
            value={input.kind}
            disabled={disabled}
            onChange={(event) => {
              const kind: CommentKind | undefined = (
                ["comment", "progress", "decision", "blocker", "evidence"] as const
              ).find((item) => item === event.target.value);
              if (kind !== undefined) change({ ...input, kind });
            }}
          >
            {["comment", "progress", "decision", "blocker", "evidence"].map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </Select>
          {input.method === "comment.add" && (
            <details className="work-secondary-details">
              <summary>
                {input.replyToId
                  ? "Reply target — already selected"
                  : "Reply to a specific comment (optional)"}
              </summary>
              <p className="work-section-help">
                Replies stay in this ticket’s conversation and link to the original message. Keep
                the selected target unless you intend to reply to a different comment.
              </p>
              <Field
                label="Reply to comment ID (optional)"
                value={input.replyToId}
                disabled={disabled}
                onChange={(event) => change({ ...input, replyToId: event.target.value })}
              />
            </details>
          )}
        </>
      );
    case "comment.edit":
    case "comment.tombstone":
      return (
        <>
          <Field
            label="Comment ID"
            value={input.commentId}
            disabled={disabled}
            onChange={(event) => change({ ...input, commentId: event.target.value })}
          />
          {input.method === "comment.edit" &&
            body(input.body, (text) => change({ ...input, body: text }), "Edited message")}
        </>
      );
    case "handoff.set":
      return (
        <HandoffFieldsForm
          value={input.fields}
          change={(fields) => change({ ...input, fields })}
          disabled={disabled}
        />
      );
    case "attempt.start":
      return (
        <>
          {attempt(input.attemptId, (text) => change({ ...input, attemptId: text }))}
          <Text
            label="Conversation session IDs"
            value={input.sessionIds}
            disabled={disabled}
            onChange={(sessionIds) => change({ ...input, sessionIds })}
            hint="One existing session ID per line; records associations only and does not launch an agent."
          />
        </>
      );
    case "attempt.checkpoint":
      return (
        <>
          {attempt(input.attemptId, (text) => change({ ...input, attemptId: text }))}
          <Select
            label="Checkpoint kind"
            value={input.checkpointKind}
            disabled={disabled}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "resource" || value === "handoff")
                change({ ...input, checkpointKind: value });
            }}
          >
            <option value="resource">Immutable resource content version</option>
            <option value="handoff">Ticket handoff revision</option>
          </Select>
          <Field
            label="Checkpoint target ID"
            value={input.targetId}
            disabled={disabled}
            onChange={(event) => change({ ...input, targetId: event.target.value })}
          />
          <Field
            label="Checkpoint content version or handoff revision"
            value={input.revision}
            disabled={disabled}
            onChange={(event) => change({ ...input, revision: event.target.value })}
          />
        </>
      );
    case "attempt.finish":
      return (
        <>
          {attempt(input.attemptId, (text) => change({ ...input, attemptId: text }))}
          <Select
            label="Attempt outcome"
            value={input.state}
            disabled={disabled}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "completed" || value === "failed" || value === "cancelled")
                change({ ...input, state: value });
            }}
          >
            <option value="completed">Completed attempt</option>
            <option value="failed">Failed attempt</option>
            <option value="cancelled">Cancelled attempt</option>
          </Select>
          {body(
            input.evidence,
            (evidence) => change({ ...input, evidence }),
            "Attempt outcome evidence",
          )}
        </>
      );
    case "ticket.finish":
      return (
        <>
          {body(
            input.evidence,
            (evidence) => change({ ...input, evidence }),
            "Completion evidence",
          )}
          <label>
            <input
              type="checkbox"
              checked={input.handoff !== null}
              disabled={disabled}
              onChange={(event) =>
                change({ ...input, handoff: event.target.checked ? EMPTY_HANDOFF : null })
              }
            />
            Include a completion handoff
          </label>
          {input.handoff !== null && (
            <HandoffFieldsForm
              value={input.handoff}
              change={(handoff) => change({ ...input, handoff })}
              disabled={disabled}
              nested
            />
          )}
        </>
      );
    case "ticket.complete":
      return body(
        input.evidence,
        (evidence) => change({ ...input, evidence }),
        "Completion evidence",
      );
    case "ticket.reopen":
      return (
        <>
          <p>
            Reopen this exact ticket revision. Reopening does not acquire a claim or restart a
            recorded attempt.
          </p>
          {body(input.reason, (reason) => change({ ...input, reason }), "Reopening reason")}
        </>
      );
  }
}
