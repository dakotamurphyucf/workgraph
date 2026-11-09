import { CONTENT_LIMITS, PreviewBudget, RenderBudget } from "./limits";
import type { HighlightNode, RenderNode } from "./types";

/** Validate actual projected shape, including syntax nodes nested inside Markdown code blocks. */
export function assertRenderBudget(nodes: readonly RenderNode[]): void {
  const budget = new RenderBudget();
  const pending: { readonly node: RenderNode | HighlightNode; readonly depth: number }[] =
    nodes.map((node) => ({ node, depth: 0 }));
  while (pending.length) {
    const next = pending.pop();
    if (!next) continue;
    if (!budget.consume(next.depth))
      throw new PreviewBudget(
        `Rendered content exceeds ${CONTENT_LIMITS.nodes.toLocaleString()} nodes or ${CONTENT_LIMITS.depth} nesting levels.`,
      );
    const { node, depth } = next;
    switch (node.kind) {
      case "text":
        break;
      case "element":
      case "reference":
      case "token":
        for (const child of node.children) pending.push({ node: child, depth: depth + 1 });
        break;
      case "code":
        for (const child of node.tokens) pending.push({ node: child, depth: depth + 1 });
        break;
    }
  }
}
