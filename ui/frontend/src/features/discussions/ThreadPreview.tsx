import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActorAvatar } from "../../components/ActorAvatar";
import { jsonField } from "../../core/json";
import { createReadSlot } from "../../core/state/read-slot";
import { RecordedTime } from "./RecordedTime";
import { readThreadPreview } from "./thread-preview";
import type { ReadCapture, Thread, ThreadsFeatureProps } from "./threads/types";

/** Latest message is read at the list's captured communication revision. Visible
 * rows own and cancel their read; a failed preview never invents a time or body. */
export function ThreadPreview({
  thread,
  capture,
  context,
}: {
  readonly thread: Thread;
  readonly capture: ReadCapture;
  readonly context: ThreadsFeatureProps["context"];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [slot] = useState(() => createReadSlot<ReadCapture>());
  const state = useSyncExternalStore(slot.subscribe, slot.get);
  const endpoint = capture.captured.endpoint;
  const revision = jsonField(capture.captured.response.response.meta, "query_revision");
  const at = revision?.kind === "string" ? revision.value : undefined;
  const key = JSON.stringify([endpoint, at, thread.id, thread.revision, thread.commentIds.at(-1)]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || thread.commentIds.length === 0 || at === undefined) return;
    void slot
      .load(key, (signal) => readThreadPreview(context.client, endpoint, thread, at, signal))
      .catch(() => {
        /* The slot retains unexpected errors for the feature boundary. */
      });
    return () => slot.clear();
    // Captured identity owns the read, independent of parent rerenders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, key, slot, context.client]);
  if (state.kind === "unexpected_error") throw state.error;
  const captured =
    state.kind === "ready" && state.key === key ? state.value.captured.value : undefined;
  const message =
    captured?.kind === "thread" ? captured.thread.related?.messages.items.at(-1) : undefined;
  return (
    <div ref={ref} className="dc-thread-preview">
      {message ? (
        <>
          <span className="dc-preview-attribution">
            <ActorAvatar actor={message.authorId} />
            <span>{message.authorId}</span>
            <RecordedTime value={message.timestamp} compact />
          </span>
          <span className="dc-message-excerpt">
            {message.tombstone
              ? "Message content removed"
              : message.body.replace(/\s+/gu, " ").trim() || "Empty message"}
          </span>
        </>
      ) : (
        <span className="dc-message-excerpt">
          {thread.commentIds.length === 0
            ? "No messages yet"
            : state.kind === "failed"
              ? "Open this conversation to read its messages"
              : `${thread.commentIds.length} messages`}
        </span>
      )}
    </div>
  );
}
