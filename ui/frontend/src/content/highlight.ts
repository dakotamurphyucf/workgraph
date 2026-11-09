import { createLowlight } from "lowlight";
import ocaml from "highlight.js/lib/languages/ocaml";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import markdown from "highlight.js/lib/languages/markdown";
import yaml from "highlight.js/lib/languages/yaml";
import ini from "highlight.js/lib/languages/ini";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import { CONTENT_LIMITS, phase, PreviewBudget, RenderBudget } from "./limits";
import type { CodeLanguage, HighlightNode, TokenTone } from "./types";

// Explicit static local imports: no autodetection, remote grammar or runtime registration from data.
const highlighter = createLowlight({
  ocaml,
  typescript,
  javascript,
  json,
  bash,
  python,
  markdown,
  yaml,
  toml: ini,
  xml,
  css,
  diff,
});
const tones: Readonly<Record<string, TokenTone>> = {
  keyword: "keyword",
  literal: "keyword",
  built_in: "keyword",
  string: "string",
  regexp: "string",
  attr: "title",
  attribute: "title",
  name: "title",
  title: "title",
  section: "title",
  selector: "title",
  number: "number",
  symbol: "number",
  comment: "comment",
  quote: "comment",
  meta: "meta",
  addition: "addition",
  deletion: "deletion",
};
export function highlightCode(text: string, language: CodeLanguage): readonly HighlightNode[] {
  const tree = phase(() => highlighter.highlight(language, text));
  const budget = new RenderBudget();
  function project(value: unknown, depth: number): HighlightNode {
    if (!budget.consume(depth))
      throw new PreviewBudget(
        `Highlighted output exceeds ${CONTENT_LIMITS.nodes.toLocaleString()} nodes or ${CONTENT_LIMITS.depth} nesting levels.`,
      );
    if (typeof value !== "object" || value === null) throw new Error("Invalid highlighter node.");
    if (
      "type" in value &&
      value.type === "text" &&
      "value" in value &&
      typeof value.value === "string"
    )
      return { kind: "text", text: value.value };
    if (
      "type" in value &&
      value.type === "element" &&
      "tagName" in value &&
      value.tagName === "span" &&
      "children" in value &&
      Array.isArray(value.children)
    ) {
      let tone: TokenTone = "plain";
      if (
        "properties" in value &&
        typeof value.properties === "object" &&
        value.properties !== null &&
        "className" in value.properties &&
        Array.isArray(value.properties.className)
      ) {
        for (const name of value.properties.className) {
          if (typeof name === "string") {
            const category = name.replace(/^hljs-/u, "");
            if (Object.hasOwn(tones, category)) tone = tones[category] ?? "plain";
          }
        }
      }
      return {
        kind: "token",
        tone,
        children: value.children.map((child: unknown) => project(child, depth + 1)),
      };
    }
    throw new Error("Unsupported highlighter output; source remains available.");
  }
  const projected = tree.children.map((child) => project(child, 0));
  function literal(items: readonly HighlightNode[]): string {
    return items
      .map((node) => (node.kind === "text" ? node.text : literal(node.children)))
      .join("");
  }
  if (literal(projected) !== text) throw new Error("Highlighter changed source text.");
  return projected;
}
