import { Icon } from "../../components/Icon";
import type { ThreadsInput } from "./threads/types";
import type { RequestsInput } from "./requests/types";

/** Explain effects without changing the controller's preparation or retry semantics. */
const explanations: Readonly<Record<ThreadsInput["method"] | RequestsInput["method"], string>> = {
  "board.put":
    "A board is a home for related discussion threads. Give it a recognizable title and choose whether it belongs to the workspace or one project. Editing changes its details, not its existing messages.",
  "thread.put":
    "A thread is a conversation inside a board. Choose its title and participants, then create it and post the first message. Editing updates the thread's settings; existing messages stay in place.",
  "thread.reply":
    "Post a message to this conversation. Use Markdown for paragraphs, lists and code. A reply adds context; it does not resolve an open request.",
  "thread.attach":
    "Bring an existing comment into this thread without copying or changing its author or history. The comment must belong to the same board scope.",
  "thread.pin_message":
    "Keep an important message marked as pinned in this conversation. Unpinning removes the marker, not the message.",
  "comment.add":
    "Add a comment to the selected ticket discussion. Choose a message kind to distinguish an update, decision, blocker or evidence.",
  "comment.edit":
    "Update your own message. The new text becomes its current version; earlier versions remain in history.",
  "comment.tombstone":
    "Remove your message from the current conversation display. Its recorded history remains available. For completion evidence, post a correction instead.",
  "message.send":
    "Send a direct message to named actors, runs or teams. An actor identifies a person or agent; a run identifies one working session. Team membership is recorded when the message is sent.",
  "request.ask":
    "Ask a question that needs an accountable answer. Name the actor allowed to resolve it, and choose who should receive it. The question is saved in a discussion so the answer and context stay together.",
  "request.create":
    "Turn a comment already attached to a discussion into a tracked request. The original question is preserved, and the designated resolver can answer and close it.",
  "request.acknowledge":
    "Record that this recipient received the request. This does not take responsibility, answer it or clear a separate Inbox queue.",
  "request.accept":
    "Record that this recipient takes responsibility for following up. The designated resolver still controls the final answer, and delivery acknowledgement remains separate.",
  "request.reassign":
    "Change who is responsible for following up, or clear that assignment. Only the designated resolver can do this, and the new responsible recipient must already have received the request.",
  "request.resolve":
    "Save an optional answer and close the request together. Only its designated resolver can resolve it. The question and answer remain available afterward.",
  "request.cancel":
    "Close an open request without an answer. Its creator or designated resolver can cancel it; the discussion and history are retained.",
  "request.metadata":
    "Update this request's priority, deadline or related requests. Keep current leaves a value alone; replace or clear deliberately changes it. A deadline does not automatically close the request.",
  "inbox.ack":
    "Mark the selected notifications as handled in this recipient's reading queue. Other queues and the underlying requests are unchanged.",
  "team.put":
    "A team is a named group of actors or runs you can address together. Saving replaces its current membership. Messages already delivered keep their original recipients.",
  "subscription.put":
    "A subscription sends matching future notifications to one actor or run. Choose its scope and event types. Turning it off stops future matches without deleting past deliveries.",
};
export function ActionGuide({
  method,
  simple = false,
}: {
  readonly method: keyof typeof explanations;
  readonly simple?: boolean;
}) {
  return (
    <aside className="dc-action-guide">
      <Icon name="discussions" />
      <div>
        <strong>What this does</strong>
        <p>{explanations[method]}</p>
        <p className="dc-action-step">
          {simple
            ? "Post or Send applies this action as the author shown below."
            : "Review checks the current rules and prepares your change. Apply change saves it."}{" "}
          Closing keeps the draft in this session; Discard editor removes it.
        </p>
      </div>
    </aside>
  );
}
