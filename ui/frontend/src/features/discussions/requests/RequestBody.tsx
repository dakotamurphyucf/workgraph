import { useMemo, useState } from "react";
import { ContentViewer, type ContentSource } from "../../../content";
import { Button } from "../../../components/Primitives";
/** Shared content admission defers offscreen work while preserving completed
 * bodies and display state across scrolling and live reads. */
export function RequestBody({
  body,
  identity,
  partial = false,
}: {
  readonly body: string;
  readonly identity: string;
  readonly partial?: boolean;
}) {
  const [tools, setTools] = useState(false);
  const source = useMemo<ContentSource>(
    () => ({
      key: identity,
      label: "Request or notification body",
      bytes: new TextEncoder().encode(body),
      completeness: partial ? "partial" : "complete",
      hints: { mime: "text/markdown", intent: "prose" },
    }),
    [body, identity, partial],
  );
  return (
    <div className={`wg-discussion-body ${tools ? "wg-discussion-body--tools" : ""}`}>
      {partial && (
        <p role="status">
          This message may be shortened. Continue or retry the read to retrieve missing content.
        </p>
      )}
      <ContentViewer source={source} chrome="compact" />
      <Button tone="quiet" aria-expanded={tools} onClick={() => setTools((value) => !value)}>
        {tools ? "Hide formatting tools" : "Formatting tools"}
      </Button>
    </div>
  );
}
