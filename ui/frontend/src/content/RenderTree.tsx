import { createElement } from "react";
import { Button } from "../components/Primitives";
import { useClipboardCopy } from "./clipboard";
import type { HighlightNode, RenderNode } from "./types";

function Highlight({ nodes }: { readonly nodes: readonly HighlightNode[] }) {
  return nodes.map((node, index) =>
    node.kind === "text" ? (
      node.text
    ) : (
      <span key={index} className={`wg-syntax-${node.tone}`}>
        <Highlight nodes={node.children} />
      </span>
    ),
  );
}
function CodeBlock({ node }: { readonly node: Extract<RenderNode, { kind: "code" }> }) {
  const { copy, notice } = useClipboardCopy(node, {
    unavailable: "Clipboard is unavailable. Use Source to select text.",
    copied: "Code block copied",
  });
  return (
    <div className="wg-code-block">
      <div className="wg-code-header">
        <span>{node.language ?? "Code · plain text"}</span>
        <Button
          tone="quiet"
          onClick={() => {
            void copy(node.text);
          }}
          aria-label="Copy code block"
        >
          Copy code
        </Button>
      </div>
      <pre>
        <code>
          <Highlight nodes={node.tokens} />
        </code>
      </pre>
      {notice && (
        <p role="status" className="wg-hint">
          {notice}
        </p>
      )}
    </div>
  );
}
/** Only our closed DTO is consumed. No HTML string, arbitrary attribute spread, href/src or external content. */
export function RenderTree({ nodes }: { readonly nodes: readonly RenderNode[] }) {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case "text":
        return node.text;
      case "code":
        return <CodeBlock node={node} key={index} />;
      case "reference":
        return (
          <span
            key={index}
            className={`wg-content-reference ${node.image ? "wg-content-reference--image" : ""}`}
          >
            <span>
              {node.image ? "Image reference: " : ""}
              <RenderTree nodes={node.children} />
            </span>
            <span className="wg-content-reference-target"> ({node.reference.target})</span>
          </span>
        );
      case "element":
        return createElement(
          node.tag,
          {
            key: index,
            ...(node.align ? { className: `wg-align-${node.align}` } : {}),
            ...(node.tag === "ol" && node.start !== null ? { start: node.start } : {}),
          },
          node.tag === "br" || node.tag === "hr" ? undefined : <RenderTree nodes={node.children} />,
        );
    }
  });
}
