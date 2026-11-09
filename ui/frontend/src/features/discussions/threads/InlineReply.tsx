import { useState, useSyncExternalStore } from "react";
import { ActorAvatar } from "../../../components/ActorAvatar";
import { Button } from "../../../components/Primitives";
import type { Identifier } from "../../../core/protocol/types";
import type { ThreadsFeatureProps } from "./types";

/** A first edit creates an ordinary controller-owned draft with its original
 * writer/endpoint. Passive thread updates never recreate or rebase that draft. */
export function InlineReply({
  props,
  threadId,
}: {
  readonly props: ThreadsFeatureProps;
  readonly threadId: Identifier;
}) {
  const [id, setId] = useState<Identifier | null>(null);
  const state = useSyncExternalStore(props.controller.subscribe, props.controller.get);
  const managed = useSyncExternalStore(props.operations.subscribe, () =>
    id === null ? undefined : props.operations.get(id),
  );
  const draft = state.drafts.find((value) => value.id === id);
  if (draft?.unexpected) throw draft.unexpected.error;
  if (managed?.phase.kind === "unexpected_error") throw managed.phase.error;
  const reply = draft?.input.method === "thread.reply" ? draft.input : undefined;
  const writer = draft?.context.writer ?? props.context.writer;
  const saved = managed?.operation?.state.kind;
  const locked =
    draft?.posted === true ||
    draft?.phase.kind === "capturing" ||
    draft?.phase.kind === "captured" ||
    managed?.phase.kind === "pending";
  const changed =
    draft !== undefined &&
    (draft.context.writer.actorId !== props.context.writer.actorId ||
      draft.context.writer.runId !== props.context.writer.runId);
  function edit(body: string) {
    if (locked) return;
    if (id === null || draft === undefined) {
      const created = props.controller.create({
        method: "thread.reply",
        threadId,
        body,
        kind: "comment",
        replyToId: "",
      });
      if (created !== null) {
        setId(created);
        props.controller.select(null);
      }
    } else if (reply) props.controller.edit(id, { ...reply, body });
  }
  return (
    <section className="dc-inline-reply" aria-label="Reply to discussion">
      <div className="dc-reply-author">
        <ActorAvatar actor={writer.actorId} />
        <span>{writer.actorId ?? "Select an acting actor to reply"}</span>
        {changed && <span className="dc-writer-warning">Original author retained</span>}
      </div>
      {writer.actorId === null && <Button requiresActor>Choose actor to reply</Button>}
      <textarea
        aria-label="Reply to thread"
        placeholder="Write a reply… Markdown is supported."
        rows={4}
        value={reply?.body ?? ""}
        disabled={locked || writer.actorId === null}
        onChange={(event) => edit(event.currentTarget.value)}
      />
      {draft?.issue && (
        <p role="alert" className="wg-error">
          {draft.issue}
        </p>
      )}
      {state.issue && draft === undefined && (
        <p role="alert" className="wg-error">
          {state.issue}
        </p>
      )}
      <footer>
        <span>
          {saved === "committed"
            ? "Reply posted"
            : saved === "outcome_unknown"
              ? "Outcome uncertain — inspect the saved reply"
              : managed?.phase.kind === "unconfirmed"
                ? "Reply outcome needs inspection"
                : locked
                  ? "Saved reply retained"
                  : "Replies are shared with this discussion."}
        </span>
        {saved === "committed" ? (
          <Button tone="primary" onClick={() => setId(null)}>
            Write another reply
          </Button>
        ) : (
          <Button
            tone="primary"
            disabled={id === null || !reply?.body.trim() || locked}
            onClick={() => {
              if (id !== null) void props.controller.post(id);
            }}
          >
            Post reply
          </Button>
        )}
        {id !== null && (
          <Button tone="quiet" onClick={() => props.controller.select(id)}>
            {locked ? "Inspect saved reply" : "Open full editor"}
          </Button>
        )}
      </footer>
    </section>
  );
}
