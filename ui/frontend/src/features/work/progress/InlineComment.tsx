import { useEffect, useState, useSyncExternalStore } from "react";
import { ActorAvatar } from "../../../components/ActorAvatar";
import { Button } from "../../../components/Primitives";
import type { Identifier } from "../../../core/protocol/types";
import type { WorkProgressFeatureProps } from "./types";

/** Text is retained by the existing launch-owned draft controller, never component state.
 * The first edit freezes its author and destination; Post uses the existing durable path. */
export function InlineComment(props: WorkProgressFeatureProps) {
  const state = useSyncExternalStore(props.controller.subscribe, props.controller.get);
  const [selected, setSelected] = useState<Identifier | null>(null);
  const [unexpected, setUnexpected] = useState<{ error: unknown } | null>(null);
  const target = props.target;
  const matches = (draft: (typeof state.drafts)[number]) =>
    draft.input.method === "comment.add" &&
    draft.input.replyToId === "" &&
    draft.capture.connection.id === target.scope.connection.id &&
    draft.capture.connection.generation === target.scope.connection.generation &&
    draft.capture.connection.socket === target.scope.connection.socket &&
    draft.capture.workspaceId === target.scope.workspaceId &&
    draft.capture.ticket.value.ticket.ticket_id === target.ticket.value.ticket.ticket_id;
  const draft =
    state.drafts.find((item) => item.id === selected && matches(item)) ??
    [...state.drafts].reverse().find((item) => matches(item) && item.phase.kind === "editing");
  const entry = useSyncExternalStore(props.operations.subscribe, () =>
    draft ? props.operations.get(draft.id) : undefined,
  );
  const input = draft?.input.method === "comment.add" ? draft.input : null;
  const author = draft?.capture.writer.actorId ?? target.context.writer.actorId;
  const locked = draft !== undefined && draft.phase.kind !== "editing";
  const committed = entry?.operation?.state.kind === "committed";
  const draftId = draft?.id;
  useEffect(() => {
    if (committed && draftId !== undefined) {
      void props.controller.read({ kind: "comments" });
      props.controller.close(draftId);
    }
  }, [committed, draftId, props.controller]);
  if (unexpected !== null) throw unexpected.error;
  if (draft?.unexpected !== null && draft?.unexpected !== undefined) throw draft.unexpected.error;

  const change = (body: string) => {
    const id = draft?.id ?? props.controller.create(target, "comment.add");
    if (id === null) return;
    setSelected(id);
    props.controller.edit(id, { method: "comment.add", body, kind: "comment", replyToId: "" });
    if (draft === undefined) props.controller.select(null);
  };
  return (
    <form
      className="work-inline-comment"
      aria-label="Add a ticket comment"
      onSubmit={(event) => {
        event.preventDefault();
        if (draft === undefined || locked) return;
        setSelected(draft.id);
        void props.controller.post(draft.id).catch((error: unknown) => setUnexpected({ error }));
      }}
    >
      {author === null && <Button requiresActor>Choose actor to comment</Button>}
      <textarea
        aria-label="Comment on ticket"
        rows={3}
        placeholder={
          author === null
            ? "Choose an acting actor to add a comment…"
            : "Share an update or join the conversation… Markdown is welcome."
        }
        value={input?.body ?? ""}
        disabled={
          locked ||
          (draft === undefined && (author === null || target.context.profileState !== "current"))
        }
        onChange={(event) => change(event.target.value)}
      />
      <div className="work-inline-comment-footer">
        <span>
          <ActorAvatar actor={author} />
          {draft && author !== target.context.writer.actorId ? "Draft as " : "Comment as "}
          {author ?? "no actor selected"}
        </span>
        {!locked && (
          <Button
            type="submit"
            tone="primary"
            disabled={draft === undefined || (input?.body.trim() ?? "") === ""}
          >
            Post comment
          </Button>
        )}
        {locked && (
          <Button onClick={() => draft && props.controller.select(draft.id)}>
            View saved action
          </Button>
        )}
      </div>
      {draft?.issue && (
        <p className="wg-error" role="alert">
          {draft.issue}
        </p>
      )}
      {locked && (
        <p role="status" className="wg-hint">
          {committed
            ? "Comment saved."
            : draft.phase.kind === "capturing"
              ? "Posting the original comment…"
              : "The original action is retained. View its result before creating another comment."}
        </p>
      )}
      {committed && draft && (
        <Button
          tone="quiet"
          onClick={() => {
            setSelected(null);
            props.controller.close(draft.id);
          }}
        >
          Write another comment
        </Button>
      )}
    </form>
  );
}
