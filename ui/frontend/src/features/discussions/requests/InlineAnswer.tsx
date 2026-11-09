import { useState, useSyncExternalStore } from "react";
import { ActorAvatar } from "../../../components/ActorAvatar";
import { Button } from "../../../components/Primitives";
import type { Identifier } from "../../../core/protocol/types";
import type { RequestsFeatureProps } from "./types";

/** A controller-owned answer keeps its original writer through live reads and
 * actor changes. Review opens the existing guarded preparation/recovery editor. */
export function InlineAnswer({
  props,
  requestId,
  resolverId,
}: {
  readonly props: RequestsFeatureProps;
  readonly requestId: Identifier;
  readonly resolverId: Identifier;
}) {
  const [id, setId] = useState<Identifier | null>(null);
  const state = useSyncExternalStore(props.controller.subscribe, props.controller.get);
  const draft = state.drafts.find((value) => value.id === id);
  if (draft?.unexpected) throw draft.unexpected.error;
  const answer = draft?.input.method === "request.resolve" ? draft.input : undefined;
  const writer = draft?.context.writer ?? props.context.writer;
  const locked = draft?.phase.kind === "capturing" || draft?.phase.kind === "captured";
  const changed =
    draft !== undefined &&
    (writer.actorId !== props.context.writer.actorId ||
      writer.runId !== props.context.writer.runId);
  return (
    <section className="dc-inline-reply" aria-label="Answer this request">
      <div className="dc-reply-author">
        <ActorAvatar actor={writer.actorId} />
        <span>Answer as {writer.actorId ?? "an acting actor"}</span>
        {changed && <span className="dc-writer-warning">Original author retained</span>}
      </div>
      {writer.actorId === null && <Button requiresActor>Choose actor to answer</Button>}
      <textarea
        aria-label="Answer to request"
        placeholder="Write an answer… Markdown is supported."
        rows={4}
        value={answer?.body ?? ""}
        disabled={locked || writer.actorId === null}
        onChange={(event) => {
          const body = event.currentTarget.value;
          if (draft === undefined) {
            const created = props.controller.create({ method: "request.resolve", requestId, body });
            if (created !== null) {
              setId(created);
              props.controller.select(null);
            }
          } else if (answer && id !== null) props.controller.edit(id, { ...answer, body });
        }}
      />
      {draft?.issue && <p role="alert">{draft.issue}</p>}
      {draft === undefined && state.issue && <p role="alert">{state.issue}</p>}
      <footer>
        <span>
          Resolver: {resolverId}. Review checks the current request and permissions before applying.
        </span>
        <Button
          tone="primary"
          disabled={id === null || !answer?.body.trim()}
          onClick={() => {
            if (id !== null) {
              props.controller.select(id);
              if (!locked) void props.controller.review(id);
            }
          }}
        >
          {locked ? "Inspect saved answer" : "Review answer & resolve"}
        </Button>
      </footer>
    </section>
  );
}
