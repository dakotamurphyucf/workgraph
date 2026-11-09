import { mergeCommentTimeline } from "./comment-timeline";
import { ActorAvatar } from "../../../components/ActorAvatar";
import { jsonField } from "../../../core/json";
import { commentCodec, pageKey } from "./client";
import type { ProgressDraft, WorkProgressFeatureProps } from "./types";

/** Quote only content already read for this draft's exact endpoint and ticket. */
export function ReplyContext({
  draft,
  props,
}: {
  readonly draft: ProgressDraft;
  readonly props: WorkProgressFeatureProps;
}) {
  if (draft.input.method !== "comment.add" || !draft.input.replyToId) return null;
  const state = props.controller.get(),
    target = state.target,
    capture = draft.capture;
  const same =
    target !== null &&
    target.scope.connection.id === capture.connection.id &&
    target.scope.connection.generation === capture.connection.generation &&
    target.scope.connection.socket === capture.connection.socket &&
    target.scope.workspaceId === capture.workspaceId &&
    target.ticket.value.ticket.ticket_id === capture.ticket.value.ticket.ticket_id;
  const id = draft.input.replyToId;
  const slot = same ? state.pages[pageKey({ kind: "comments" })] : undefined;
  const page =
    slot?.kind === "ready" ? slot.value : slot && slot.kind !== "idle" ? slot.previous : undefined;
  const raw = page?.value.kind === "object" ? jsonField(page.value, "items") : undefined;
  const loaded =
    raw?.kind === "array"
      ? raw.items.map((item) => {
          const result = commentCodec.decode(item);
          if (!result.ok) throw new Error("Validated reply context lost its comment shape");
          return result.value;
        })
      : [];
  const comment = mergeCommentTimeline(
    loaded,
    same ? state.recentComments.map((item) => item.comment) : [],
  ).find((item) => item.id === id);
  return (
    <aside className="work-reply-context">
      <strong>In reply to {comment?.authorId ?? "an earlier comment"}</strong>
      {comment ? (
        <>
          <span>
            <ActorAvatar actor={comment.authorId} /> Message preview
          </span>
          <blockquote>
            {comment.tombstone ? "This message was removed from normal reading." : comment.body}
          </blockquote>
        </>
      ) : (
        <p>
          The original message is not in the currently loaded page. Its reply link is retained; you
          can inspect the target below.
        </p>
      )}
    </aside>
  );
}
