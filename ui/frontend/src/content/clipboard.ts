import { useState } from "react";

interface Feedback {
  readonly owner: object;
  /** A new lifetime even when a previously selected owner is selected again. */
  readonly scope: object;
  readonly notice: string;
  readonly unexpected: { readonly error: unknown } | null;
}
interface CopyMessages {
  readonly unavailable: string;
  readonly copied: string;
}
function initial(owner: object): Feedback {
  return { owner, scope: {}, notice: "", unexpected: null };
}
/** Own clipboard outcomes by capture/node lifetime. Unexpected failures enter React's error boundary. */
export function useClipboardCopy(owner: object, messages: CopyMessages) {
  const [feedback, setFeedback] = useState(() => initial(owner));
  if (feedback.owner !== owner) setFeedback(initial(owner));
  const scope = feedback.scope;
  if (feedback.owner === owner && feedback.unexpected) throw feedback.unexpected.error;
  function publish(notice: string, unexpected: Feedback["unexpected"] = null) {
    setFeedback((current) =>
      current.scope === scope ? { ...current, notice, unexpected } : current,
    );
  }
  async function copy(text: string): Promise<void> {
    try {
      if (!navigator.clipboard) {
        publish(messages.unavailable);
        return;
      }
      await navigator.clipboard.writeText(text);
      publish(messages.copied);
    } catch (error: unknown) {
      if (error instanceof DOMException)
        publish("Clipboard permission was denied. Source remains available.");
      else publish("", { error });
    }
  }
  return { copy, notice: feedback.owner === owner ? feedback.notice : "" };
}
