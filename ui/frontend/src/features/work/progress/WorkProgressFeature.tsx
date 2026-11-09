import { ManagementPresentation } from "../../connections/management-presentation";
import { ReplyContext } from "./ReplyContext";
import { InspectorDisclosure } from "../views/InspectorParts";
import { ActorAvatar } from "../../../components/ActorAvatar";
import { InlineComment } from "./InlineComment";
import { pageKey } from "./client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Dialog } from "../../../components/Dialog";
import { Badge, Button, Toolbar } from "../../../components/Primitives";
import { OperationPanel } from "../../connections/shared";
import { failureText } from "../../connections/failure";
import { ObservationNotice } from "../../../components/ObservationNotice";
import { ProgressFields } from "./ProgressFields";
import { ProgressReads } from "./ProgressReads";
import type { ProgressCommand, ProgressDraft, WorkProgressFeatureProps } from "./types";
const COMMANDS: readonly {
  readonly method: ProgressCommand;
  readonly label: string;
  readonly hint: string;
}[] = [
  {
    method: "ticket.progress",
    label: "Post owner progress",
    hint: "Share a work update as the current claim owner. The ticket stays at its current status.",
  },
  {
    method: "comment.add",
    label: "Post ticket comment",
    hint: "Join the conversation as the selected actor. You do not need to claim the ticket.",
  },
  {
    method: "comment.edit",
    label: "Edit own comment",
    hint: "Revise a message you wrote. Earlier versions remain available in history.",
  },
  {
    method: "comment.tombstone",
    label: "Remove own comment",
    hint: "Remove your message from normal reading. Its previous versions remain in history.",
  },
  {
    method: "handoff.set",
    label: "Save handoff",
    hint: "Leave a summary and next steps for the next worker. Saving replaces the previous handoff; blank fields clear old values.",
  },
  {
    method: "attempt.start",
    label: "Start recorded attempt",
    hint: "Record a new work session for the run that owns this ticket. This records history; it does not start an agent.",
  },
  {
    method: "attempt.checkpoint",
    label: "Pin attempt checkpoint",
    hint: "Attach a specific resource version or handoff to the active work session, so later readers can inspect the same evidence.",
  },
  {
    method: "attempt.finish",
    label: "Finish recorded attempt",
    hint: "Record how a work session ended. This does not finish the ticket, release its claim or stop an agent.",
  },
  {
    method: "ticket.finish",
    label: "Finish ticket",
    hint: "Atomically completes the ticket and matching active attempts, clears ownership, and can save a handoff. Current prerequisites, children, amendments and configured acceptance gates are checked again.",
  },
  {
    method: "ticket.complete",
    label: "Complete ticket without handoff",
    hint: "Completes the ticket and active attempts under the current claim. Use Finish ticket when you also need a handoff; completing is different from finishing only one attempt.",
  },
  {
    method: "ticket.reopen",
    label: "Reopen ticket",
    hint: "Reopens the captured completed ticket revision as unclaimed Todo. Prior evidence, attempts and handoff history remain; a new claim and attempt require explicit actions.",
  },
];
function Editor({
  draft,
  props,
}: {
  readonly draft: ProgressDraft;
  readonly props: WorkProgressFeatureProps;
}) {
  const [unexpected, setUnexpected] = useState<{ readonly error: unknown } | null>(null),
    [actionIssue, setActionIssue] = useState("");
  const entry = useSyncExternalStore(props.operations.subscribe, () =>
    props.operations.get(draft.id),
  );
  if (draft.unexpected !== null) throw draft.unexpected.error;
  if (unexpected !== null) throw unexpected.error;
  if (entry?.phase.kind === "unexpected_error") throw entry.phase.error;
  const locked = draft.phase.kind === "capturing" || draft.phase.kind === "captured",
    simple = draft.input.method === "ticket.progress" || draft.input.method === "comment.add",
    definition = COMMANDS.find((item) => item.method === draft.input.method),
    capture = draft.capture,
    ticket = capture.ticket.value.ticket,
    operation = entry?.operation,
    pending = entry?.phase.kind === "pending";
  const unconfirmedWrite =
    entry?.phase.kind === "unconfirmed" &&
    (entry.phase.action === "execute" || entry.phase.action === "retry") &&
    operation?.state.kind !== "committed" &&
    operation?.state.kind !== "observed" &&
    operation?.state.kind !== "rejected";
  const record =
    draft.input.method === "handoff.set"
      ? "handoff"
      : draft.input.method === "comment.edit" || draft.input.method === "comment.tombstone"
        ? "comment"
        : draft.input.method === "attempt.checkpoint" || draft.input.method === "attempt.finish"
          ? "attempt"
          : null;
  const run = (promise: Promise<void>) => {
    void promise.catch((error: unknown) => setUnexpected({ error }));
  };
  const act = (action: "execute" | "inspect") => {
    setActionIssue("");
    void props.operations
      .act(draft.id, action)
      .then((result) => {
        if (!result.ok) setActionIssue(failureText(result.failure));
      })
      .catch((error: unknown) => setUnexpected({ error }));
  };
  const ownerAction =
    draft.input.method !== "comment.add" &&
    draft.input.method !== "comment.edit" &&
    draft.input.method !== "comment.tombstone" &&
    draft.input.method !== "ticket.reopen";
  const wrongOwner =
    ownerAction &&
    (ticket.claim === null
      ? draft.input.method !== "handoff.set"
      : ticket.claim.actor_id !== capture.writer.actorId ||
        ticket.claim.run_id !== capture.writer.runId);
  return (
    <>
      <p>
        <strong>
          {ticket.display_key}: {ticket.title}
        </strong>
      </p>
      <p className="work-message-author">
        <ActorAvatar actor={capture.writer.actorId} /> Writing as{" "}
        <strong>{capture.writer.actorId}</strong>
        {capture.writer.runId && <> · run {capture.writer.runId}</>}.{" "}
        {props.target.context.writer.actorId !== capture.writer.actorId ||
        props.target.context.writer.runId !== capture.writer.runId
          ? "The current writer is different; this editor keeps its original author."
          : ""}
      </p>
      <section className="work-action-explanation">
        <h3>
          {draft.input.method === "comment.add" && draft.input.replyToId
            ? "Reply to this conversation"
            : (definition?.label ?? "Update this message")}
        </h3>
        <p>
          {draft.input.method === "comment.add"
            ? "Your message is added to this ticket’s conversation under the author shown above. Posting does not claim the ticket, change its status or resolve a question."
            : draft.input.method === "comment.edit"
              ? "Save a revised version of your own message. Its earlier text remains available in history. Load the current message before reviewing the edit."
              : draft.input.method === "comment.tombstone"
                ? "Remove this message from normal reading while retaining its historical revisions. Only its original author can do this."
                : definition?.hint}
        </p>
      </section>
      {wrongOwner && (
        <p role="alert" className="wg-error">
          The original writer does not match the captured claim. Choose the owner or acquire
          ownership explicitly, then open a new composer. Assignment does not transfer a claim.
        </p>
      )}
      {draft.issue &&
        operation?.state.kind !== "committed" &&
        operation?.state.kind !== "observed" && (
          <p role="alert" className="wg-error">
            {draft.issue}
          </p>
        )}
      {actionIssue && <p role="alert">{actionIssue}</p>}
      {(draft.phase.kind === "loading" || draft.phase.kind === "capturing") && (
        <p role="status">
          {draft.phase.kind === "loading"
            ? "Loading the current record…"
            : "Preparing the original action…"}
        </p>
      )}
      <ReplyContext draft={draft} props={props} />
      <form
        aria-label={`${definition?.label ?? draft.input.method} form`}
        onSubmit={(event) => {
          event.preventDefault();
          run(simple ? props.controller.post(draft.id) : props.controller.review(draft.id));
        }}
      >
        <ProgressFields
          input={draft.input}
          change={(input) => props.controller.edit(draft.id, input)}
          disabled={locked}
        />
        {record !== null && !locked && (
          <Button
            disabled={draft.phase.kind === "loading"}
            onClick={() => run(props.controller.loadGuards(draft.id))}
          >
            Load current {record}
          </Button>
        )}
        {!locked &&
          ((draft.input.method === "handoff.set" &&
            draft.guards.handoff !== undefined &&
            draft.guards.handoff !== null) ||
            (draft.input.method === "comment.edit" && draft.guards.comment !== undefined)) && (
            <Button
              disabled={draft.phase.kind === "loading"}
              onClick={() => props.controller.fill(draft.id)}
            >
              Use loaded {record} text
            </Button>
          )}
        {!locked && (
          <Button type="submit" tone="primary" disabled={draft.phase.kind === "loading"}>
            {simple ? "Post" : "Review action"}
          </Button>
        )}
      </form>
      {entry !== undefined && (
        <section aria-label="Original action outcome">
          <p role="status" aria-live="polite">
            <Badge>
              {pending
                ? "Working…"
                : unconfirmedWrite
                  ? "Write unconfirmed"
                  : operation?.state.kind === "committed"
                    ? "Committed"
                    : operation?.state.kind === "observed"
                      ? "Observed"
                      : operation?.state.kind === "prepared_unsent"
                        ? "Ready to apply"
                        : operation?.state.kind === "sending"
                          ? "Pending"
                          : operation?.state.kind === "rejected"
                            ? "Rejected"
                            : operation?.state.kind === "outcome_unknown"
                              ? "Outcome unknown"
                              : "Preparation unconfirmed"}
            </Badge>
          </p>
          {operation?.state.kind === "prepared_unsent" && !simple && !unconfirmedWrite && (
            <>
              <p>
                Prepared for {ticket.display_key} as {capture.writer.actorId}. Your message and
                original target remain shown above. Apply sends this exact saved request once.
              </p>
              <Button tone="primary" disabled={pending} onClick={() => act("execute")}>
                Apply action
              </Button>
            </>
          )}
          {unconfirmedWrite && (
            <Button disabled={pending} onClick={() => act("inspect")}>
              Inspect original action
            </Button>
          )}
          {operation?.state.kind === "sending" && <ObservationNotice status={entry.observation} />}
          {(operation?.state.kind === "rejected" ||
            operation?.state.kind === "outcome_unknown") && (
            <p role="alert">
              {operation.state.problem.kind}: {operation.state.problem.message}.{" "}
              {operation.state.kind === "outcome_unknown"
                ? "Preserve this original action. Inspection and exact retry are available below; creating another request can duplicate work."
                : "Refresh the affected record and create a new reviewed draft. This saved request remains unchanged."}
            </p>
          )}
          {entry.phase.kind === "unconfirmed" && (
            <p role="alert">
              {failureText(entry.phase.failure)}.{" "}
              {entry.phase.action === "prepare"
                ? "Preparation is unconfirmed. This composer has not requested execution; keep this original intention for preparation recovery."
                : entry.phase.action === "execute" || entry.phase.action === "retry"
                  ? "The write reply is unconfirmed. Inspect the original action before an explicit exact retry."
                  : "This observation failed; the retained operation outcome above remains unchanged."}
            </p>
          )}
          {operation?.state.kind === "committed" && (
            <p>
              {simple
                ? "Your original message was saved."
                : "This original action committed. Refresh the ticket to inspect its current state."}
            </p>
          )}
        </section>
      )}
      {entry !== undefined && !unconfirmedWrite && (
        <ManagementPresentation value={true}>
          <OperationPanel
            operations={props.operations}
            intention={draft.id}
            processing={props.target.context.client.processing}
          />
        </ManagementPresentation>
      )}

      {operation?.state.kind === "rejected" && (
        <>
          <p className="wg-hint">
            Refresh the selected ticket first. Copying opens a new editable intention with the same
            text and original author; the rejected request is retained.
          </p>
          <Button onClick={() => props.controller.copy(draft.id, props.target)}>
            Copy to refreshed ticket
          </Button>
        </>
      )}
      <Toolbar label="Participation editor lifetime">
        <Button onClick={() => props.controller.select(null)}>Hide editor; keep draft</Button>
        <Button
          disabled={draft.phase.kind === "capturing"}
          onClick={() => props.controller.close(draft.id)}
        >
          {entry === undefined ? "Discard unsent draft" : "Close editor; keep saved action"}
        </Button>
      </Toolbar>
    </>
  );
}
export function WorkProgressFeature(props: WorkProgressFeatureProps) {
  const state = useSyncExternalStore(props.controller.subscribe, props.controller.get);
  useEffect(() => {
    props.controller.open(props.target);
    if (props.controller.get().pages[pageKey({ kind: "comments" })] === undefined)
      void props.controller.read({ kind: "comments" });
  }, [props.controller, props.target]);
  if (state.unexpected !== null) throw state.unexpected.error;
  const selected = state.drafts.find((item) => item.id === state.selectedId),
    target = props.target,
    owned = state.target,
    same =
      owned !== null &&
      owned.scope.connection.id === target.scope.connection.id &&
      owned.scope.connection.generation === target.scope.connection.generation &&
      owned.scope.connection.socket === target.scope.connection.socket &&
      owned.scope.workspaceId === target.scope.workspaceId &&
      owned.ticket.value.ticket.ticket_id === target.ticket.value.ticket.ticket_id,
    canCreate = target.context.profileState === "current";
  return (
    <section aria-label="Ticket participation and completion">
      {state.issue && (
        <p role="alert" className="wg-error">
          {state.issue}
        </p>
      )}
      {!canCreate && (
        <p className="wg-hint">
          Choose a current profile and acting actor to open a new composer. Existing editors retain
          their original writer.
        </p>
      )}
      {same ? (
        <ProgressReads props={props} pages={state.pages} composer={<InlineComment {...props} />} />
      ) : (
        <p role="status">Selecting the exact activity capture…</p>
      )}
      <InspectorDisclosure
        title="Progress, handoff and other actions"
        description="Record work, prepare a handoff, or complete and reopen this ticket."
        icon="activity"
        tone="green"
      >
        <p className="work-section-help">
          A comment joins the conversation. Owner progress, attempts and completion record work
          under the ticket’s claim. Choose an action to see its requirements before saving anything.
        </p>
        <div className="work-action-cards" aria-label="Participation composers">
          {COMMANDS.map((item) => (
            <Button
              key={item.method}
              requiresActor
              disabled={!canCreate}
              onClick={() => props.controller.create(target, item.method)}
            >
              <strong>{item.label}</strong>
              <span>{item.hint}</span>
            </Button>
          ))}
        </div>
        {state.drafts.length > 0 && (
          <section className="work-draft-list">
            <h4>Resume a message or work update</h4>
            <p>
              These drafts belong to this browser session. Each keeps the ticket and author it was
              started with.
            </p>
            {state.drafts.map((draft) => (
              <Button key={draft.id} onClick={() => props.controller.select(draft.id)}>
                <ActorAvatar actor={draft.capture.writer.actorId} />
                <span>
                  <strong>
                    {COMMANDS.find((item) => item.method === draft.input.method)?.label ??
                      draft.input.method}
                  </strong>
                  <small>
                    {draft.capture.ticket.value.ticket.display_key} · {draft.capture.writer.actorId}{" "}
                    · {draft.phase.kind}
                  </small>
                </span>
              </Button>
            ))}
          </section>
        )}
      </InspectorDisclosure>
      {selected && (
        <Dialog
          key={selected.id}
          title={
            selected.input.method === "comment.add" && selected.input.replyToId
              ? "Reply to comment"
              : (COMMANDS.find((item) => item.method === selected.input.method)?.label ??
                selected.input.method)
          }
          description="Write your update below. Closing keeps it in this browser session so you can resume it later."
          wide
          onClose={() => props.controller.select(null)}
        >
          <div className="work-dialog-content">
            <Editor draft={selected} props={props} />
          </div>
        </Dialog>
      )}
    </section>
  );
}
