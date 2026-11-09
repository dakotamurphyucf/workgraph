import { Lexer } from "marked";
import { decodeHTMLStrict } from "entities";
import { parseJsonBytes } from "../core/json";
import { CONTENT_LIMITS, phase, PreviewBudget, RenderBudget } from "./limits";
import { assertRenderBudget } from "./render-budget";
import { highlightCode } from "./highlight";
import { languageHint, resolveFormat } from "./languages";
import type {
  CodeLanguage,
  ContentJob,
  ContentJobResult,
  ContentPreview,
  HighlightNode,
  RenderNode,
  RenderRequest,
  RenderTag,
  TextWindow,
  WorkerStage,
} from "./types";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: unknown): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : {};
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
function hasBinaryControls(source: string): boolean {
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code < 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13) return true;
  }
  return false;
}
function sourceWindow(source: string, startLine: number): TextWindow {
  const lines = [];
  let number = 0;
  let start = 0;
  let available = CONTENT_LIMITS.windowCharacters;
  for (let index = 0; index <= source.length; index += 1) {
    if (index !== source.length && source.charCodeAt(index) !== 10) continue;
    if (number >= startLine && lines.length < CONTENT_LIMITS.sourceLines && available > 0) {
      let end = Math.min(index, start + CONTENT_LIMITS.lineCharacters, start + available);
      if (end < index && end > start && /[\uD800-\uDBFF]/u.test(source[end - 1] ?? "")) end -= 1;
      const displayed = source.slice(start, end);
      lines.push({ number, text: displayed, omittedCharacters: index - end });
      available -= displayed.length;
    }
    number += 1;
    start = index + 1;
  }
  return { startLine, totalLines: number, lines };
}
function hexWindow(bytes: Uint8Array, offset: number): string {
  const rows = [];
  for (
    let index = offset;
    index < Math.min(bytes.length, offset + CONTENT_LIMITS.rawBytes);
    index += 16
  ) {
    const row = bytes.subarray(index, Math.min(bytes.length, index + 16));
    const hex = Array.from(row, (value) => value.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(row, (value) =>
      value >= 32 && value <= 126 ? String.fromCharCode(value) : ".",
    ).join("");
    rows.push(`${index.toString(16).padStart(8, "0")}  ${hex.padEnd(47, " ")}  ${ascii}`);
  }
  return rows.join("\n");
}
function markup(
  source: string,
  stage: (value: WorkerStage) => void,
  diagnostics: string[],
): readonly RenderNode[] {
  stage("markdown");
  const tokens: readonly unknown[] = phase(() =>
    Lexer.lex(source, { gfm: true, breaks: false, pedantic: false, silent: false }),
  );
  stage("projection");
  const budget = new RenderBudget();
  let highlightedBytes = 0;
  function consume(depth: number) {
    if (!budget.consume(depth))
      throw new PreviewBudget(
        `Markdown exceeds ${CONTENT_LIMITS.nodes.toLocaleString()} nodes or ${CONTENT_LIMITS.depth} nesting levels.`,
      );
  }
  function element(
    tag: RenderTag,
    children: readonly RenderNode[],
    depth: number,
    align: "left" | "right" | "center" | null = null,
    start: number | null = null,
  ): RenderNode {
    consume(depth);
    return { kind: "element", tag, children, align, start };
  }
  function literal(value: string, depth: number, entities = true): RenderNode {
    consume(depth);
    return { kind: "text", text: entities ? decodeHTMLStrict(value) : value };
  }
  function children(value: unknown, depth: number): readonly RenderNode[] {
    return list(value).flatMap((token) => project(token, depth + 1));
  }
  function code(value: string, language: CodeLanguage | null, depth: number): RenderNode {
    consume(depth);
    let tokens: readonly HighlightNode[] = [{ kind: "text", text: value }];
    const bytes = new TextEncoder().encode(value).byteLength;
    highlightedBytes += bytes;
    if (
      language &&
      highlightedBytes <= CONTENT_LIMITS.highlightBytes &&
      value.split("\n").length <= CONTENT_LIMITS.highlightLines
    ) {
      stage("highlight");
      tokens = highlightCode(value, language);
      stage("projection");
      const pending = [...tokens];
      while (pending.length) {
        const token = pending.pop();
        consume(depth);
        if (token?.kind === "token") pending.push(...token.children);
      }
    } else if (language)
      diagnostics.push("Some code exceeds the highlighting budget and remains plain code.");
    return { kind: "code", text: value, language, tokens };
  }
  function project(value: unknown, depth: number): readonly RenderNode[] {
    const token = object(value);
    const type = token.type;
    switch (type) {
      case "space":
        return [];
      case "text":
        return Array.isArray(token.tokens)
          ? children(token.tokens, depth)
          : [literal(text(token.text), depth)];
      case "checkbox":
        return [literal(token.checked === true ? "[x] " : "[ ] ", depth, false)];
      case "escape":
        return [literal(text(token.text), depth, false)];
      case "html":
        return [literal(text(token.raw), depth, false)];
      case "paragraph":
        return [element("p", children(token.tokens, depth), depth)];
      case "heading": {
        const level = token.depth;
        const tag =
          level === 1
            ? "h1"
            : level === 2
              ? "h2"
              : level === 3
                ? "h3"
                : level === 4
                  ? "h4"
                  : level === 5
                    ? "h5"
                    : "h6";
        return [element(tag, children(token.tokens, depth), depth)];
      }
      case "strong":
      case "em":
      case "del":
        return [element(type, children(token.tokens, depth), depth)];
      case "blockquote":
        return [element("blockquote", children(token.tokens, depth), depth)];
      case "codespan":
        return [element("code", [literal(text(token.text), depth + 1, false)], depth)];
      case "code":
        return [code(text(token.text), languageHint(text(token.lang)), depth)];
      case "br":
      case "hr":
        return [element(type, [], depth)];
      case "list": {
        const ordered = token.ordered === true;
        const start =
          typeof token.start === "number" &&
          Number.isSafeInteger(token.start) &&
          token.start >= 0 &&
          token.start <= 999_999_999
            ? token.start
            : null;
        return [
          element(
            ordered ? "ol" : "ul",
            list(token.items).map((item) => {
              const entry = object(item);
              const nodes = children(entry.tokens, depth + 1);
              return element("li", nodes, depth + 1);
            }),
            depth,
            null,
            ordered ? start : null,
          ),
        ];
      }
      case "link":
      case "image":
        consume(depth);
        return [
          {
            kind: "reference",
            image: type === "image",
            reference: {
              raw: text(token.raw),
              target: text(token.href),
              title: typeof token.title === "string" ? token.title : null,
            },
            children: Array.isArray(token.tokens)
              ? children(token.tokens, depth)
              : [literal(text(token.text), depth + 1)],
          },
        ];
      case "table": {
        const row = (cells: unknown, header: boolean) =>
          element(
            "tr",
            list(cells).map((cell) => {
              const entry = object(cell);
              const align =
                entry.align === "left" || entry.align === "right" || entry.align === "center"
                  ? entry.align
                  : null;
              return element(
                header ? "th" : "td",
                children(entry.tokens, depth + 3),
                depth + 2,
                align,
              );
            }),
            depth + 1,
          );
        return [
          element(
            "table",
            [
              element("thead", [row(token.header, true)], depth + 1),
              element(
                "tbody",
                list(token.rows).map((cells) => row(cells, false)),
                depth + 1,
              ),
            ],
            depth,
          ),
        ];
      }
      case "def":
        return [];
      default:
        diagnostics.push("An unsupported Markdown token is shown literally.");
        return [literal(text(token.raw), depth, false)];
    }
  }
  return phase(() => {
    const nodes = tokens.flatMap((token) => project(token, 0));
    assertRenderBudget(nodes);
    return nodes;
  });
}
export function renderContent(
  request: RenderRequest,
  stage: (value: WorkerStage) => void = () => {},
): ContentPreview {
  const { bytes } = request;
  const rawOffset = Math.min(request.rawOffset, bytes.length);
  const base = {
    key: request.key,
    byteLength: bytes.length,
    rawHex: hexWindow(bytes, rawOffset),
    rawOffset,
    rawLength: Math.min(CONTENT_LIMITS.rawBytes, bytes.length - rawOffset),
  };
  const format = resolveFormat(request.hints, request.override);
  if (request.mode === "raw")
    return {
      ...base,
      format,
      status: format.kind === "binary" ? "binary" : "source",
      nodes: [],
      window: null,
      copyText: null,
      diagnostics: [],
    };
  stage("decode");
  let source: string;
  try {
    source = phase(() => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch (error: unknown) {
    if (error instanceof TypeError)
      return {
        ...base,
        format: { kind: "binary", language: null, via: "default" },
        status: "binary",
        nodes: [],
        window: null,
        copyText: null,
        diagnostics: ["Bytes are not valid UTF-8. Raw byte access is retained."],
      };
    throw error;
  }
  if (format.kind === "binary" || hasBinaryControls(source))
    return {
      ...base,
      format: { ...format, kind: "binary", language: null },
      status: "binary",
      nodes: [],
      window: null,
      copyText: null,
      diagnostics: ["Binary content is not rendered as prose. Raw bytes remain available."],
    };
  const window = phase(() => sourceWindow(source, request.startLine));
  const copyText = bytes.length <= CONTENT_LIMITS.richBytes ? source : null;
  const diagnostics: string[] = [];
  const fallback = (reason: string): ContentPreview => ({
    ...base,
    format,
    status: "limited",
    nodes: [],
    window,
    copyText,
    diagnostics: [reason],
  });
  if (bytes.length > CONTENT_LIMITS.richBytes || window.totalLines > CONTENT_LIMITS.richLines)
    return fallback(
      `Rich preview exceeds ${CONTENT_LIMITS.richBytes.toLocaleString()} bytes or ${CONTENT_LIMITS.richLines.toLocaleString()} lines. Showing a source window; download retains every byte.`,
    );
  if (format.kind === "plain")
    return { ...base, format, status: "source", nodes: [], window, copyText, diagnostics };
  try {
    if (request.mode === "rendered" && format.kind === "markdown")
      return {
        ...base,
        format,
        status: "rich",
        // A UTF-8 BOM is encoding metadata for Markdown presentation only.
        // Exact copy/raw/source still retain the original leading code point.
        nodes: markup(source.startsWith("\uFEFF") ? source.slice(1) : source, stage, diagnostics),
        window,
        copyText,
        diagnostics: [...new Set(diagnostics)],
      };
    const language = format.language;
    if (
      bytes.length > CONTENT_LIMITS.highlightBytes ||
      window.totalLines > CONTENT_LIMITS.highlightLines
    )
      return fallback(
        `Highlighting exceeds ${CONTENT_LIMITS.highlightBytes.toLocaleString()} bytes or ${CONTENT_LIMITS.highlightLines.toLocaleString()} lines. Showing unmodified source instead.`,
      );
    stage("highlight");
    const tokens: readonly HighlightNode[] = language
      ? highlightCode(source, language)
      : [{ kind: "text", text: source }];
    const nodes: readonly RenderNode[] = [{ kind: "code", text: source, language, tokens }];
    assertRenderBudget(nodes);
    return {
      ...base,
      format,
      status: "rich",
      nodes,
      window,
      copyText,
      diagnostics,
    };
  } catch (error: unknown) {
    if (error instanceof PreviewBudget) return fallback(error.message);
    throw error;
  }
}
export function processContentJob(
  job: ContentJob,
  stage: (value: WorkerStage) => void = () => {},
): ContentJobResult {
  if (job.kind === "render") return { kind: "render", preview: renderContent(job.request, stage) };
  stage("decode");
  return {
    kind: "json",
    document: phase(() => parseJsonBytes(job.request.bytes, job.request.limits)),
  };
}
