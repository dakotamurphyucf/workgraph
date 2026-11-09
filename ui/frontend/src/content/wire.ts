import type { JsonDocument, JsonError, JsonLimits, JsonResult, JsonValue } from "../core/json";
import { CONTENT_LIMITS, RenderBudget } from "./limits";
import { CODE_LANGUAGES } from "./languages";
import type {
  CodeLanguage,
  ContentHints,
  ContentJob,
  ContentJobResult,
  ContentPreview,
  FormatChoice,
  HighlightNode,
  RenderNode,
  RenderTag,
  TextWindow,
  TokenTone,
  WorkerMessage,
  WorkerRequest,
  WorkerStage,
} from "./types";

class InvalidWire extends Error {}
function fail(): never {
  throw new InvalidWire("Invalid content worker message.");
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key))) return fail();
  return value;
}
function string(value: unknown, maximum = CONTENT_LIMITS.inputBytes): string {
  if (typeof value !== "string" || value.length > maximum || /[\uD800-\uDFFF]/u.test(value))
    return fail();
  return value;
}
function integer(value: unknown, maximum = CONTENT_LIMITS.inputBytes + 1): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum)
    return fail();
  return value;
}
function enumeration<const T extends string>(value: unknown, choices: readonly T[]): T {
  for (const choice of choices) if (value === choice) return choice;
  return fail();
}
function array(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return fail();
  return value;
}
function language(value: unknown): CodeLanguage {
  return enumeration(value, CODE_LANGUAGES);
}
function hints(value: unknown): ContentHints {
  const item = object(value, ["language", "mime", "filename", "intent"]);
  return {
    ...(item.language === undefined ? {} : { language: string(item.language, 512) }),
    ...(item.mime === undefined ? {} : { mime: string(item.mime, 512) }),
    ...(item.filename === undefined ? {} : { filename: string(item.filename, 512) }),
    ...(item.intent === undefined
      ? {}
      : { intent: enumeration(item.intent, ["prose", "code", "unknown"]) }),
  };
}
function limits(value: unknown): JsonLimits {
  const item = object(value, ["maxBytes", "maxDepth", "maxNodes", "maxStringBytes"]);
  const result = {
    maxBytes: integer(item.maxBytes, CONTENT_LIMITS.inputBytes),
    maxDepth: integer(item.maxDepth, 96),
    maxNodes: integer(item.maxNodes, 100_000),
    maxStringBytes: integer(item.maxStringBytes, CONTENT_LIMITS.inputBytes),
  };
  if (Object.values(result).some((entry) => entry === 0)) return fail();
  return result;
}
function decodeRequest(value: unknown): WorkerRequest {
  const item = object(value, ["protocol", "jobId", "key", "job"]);
  if (item.protocol !== 1) return fail();
  const jobId = string(item.jobId, 96);
  if (!/^[a-z0-9_-]+$/u.test(jobId)) return fail();
  const key = string(item.key, 1024);
  const job = object(item.job, ["kind", "request"]);
  const request = object(
    job.request,
    job.kind === "render"
      ? ["key", "bytes", "hints", "override", "mode", "startLine", "rawOffset"]
      : ["key", "bytes", "limits"],
  );
  if (
    request.key !== key ||
    !(request.bytes instanceof Uint8Array) ||
    request.bytes.byteLength > CONTENT_LIMITS.inputBytes
  )
    return fail();
  let payload: ContentJob;
  if (job.kind === "render")
    payload = {
      kind: "render",
      request: {
        key,
        bytes: request.bytes,
        hints: hints(request.hints),
        override: enumeration(request.override, ["auto", "plain", ...CODE_LANGUAGES]),
        mode: enumeration(request.mode, ["rendered", "source", "raw"]),
        startLine: integer(request.startLine),
        rawOffset: integer(request.rawOffset),
      },
    };
  else if (job.kind === "json")
    payload = {
      kind: "json",
      request: {
        key,
        bytes: request.bytes,
        ...(request.limits === undefined ? {} : { limits: limits(request.limits) }),
      },
    };
  else return fail();
  return { protocol: 1, jobId, key, job: payload };
}
export function readWorkerRequest(value: unknown): WorkerRequest | null {
  try {
    return decodeRequest(value);
  } catch (error: unknown) {
    if (error instanceof InvalidWire) return null;
    throw error;
  }
}

const tags: readonly RenderTag[] = [
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "em",
  "del",
  "blockquote",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "br",
  "hr",
  "code",
];
const tones: readonly TokenTone[] = [
  "plain",
  "keyword",
  "string",
  "number",
  "comment",
  "title",
  "meta",
  "addition",
  "deletion",
];
function readPreview(value: unknown): ContentPreview {
  const item = object(value, [
    "key",
    "byteLength",
    "format",
    "status",
    "nodes",
    "window",
    "rawHex",
    "rawOffset",
    "rawLength",
    "copyText",
    "diagnostics",
  ]);
  const choice = object(item.format, ["kind", "language", "via"]);
  const format: FormatChoice = {
    kind: enumeration(choice.kind, ["markdown", "code", "plain", "binary"]),
    language: choice.language === null ? null : language(choice.language),
    via: enumeration(choice.via, ["override", "language", "mime", "filename", "intent", "default"]),
  };
  const budget = new RenderBudget();
  let characters = 0;
  function consume(depth: number) {
    if (!budget.consume(depth)) fail();
  }
  function contentText(value: unknown) {
    const result = string(value, CONTENT_LIMITS.richBytes);
    characters += result.length;
    if (characters > CONTENT_LIMITS.richBytes * 4) fail();
    return result;
  }
  function highlight(value: unknown, depth: number): HighlightNode {
    consume(depth);
    if (!record(value)) return fail();
    if (value.kind === "text") {
      const node = object(value, ["kind", "text"]);
      return { kind: "text", text: contentText(node.text) };
    }
    const node = object(value, ["kind", "tone", "children"]);
    if (node.kind !== "token") return fail();
    return {
      kind: "token",
      tone: enumeration(node.tone, tones),
      children: array(node.children, CONTENT_LIMITS.nodes).map((entry) =>
        highlight(entry, depth + 1),
      ),
    };
  }
  function node(value: unknown, depth: number): RenderNode {
    consume(depth);
    if (!record(value)) return fail();
    if (value.kind === "text") {
      const entry = object(value, ["kind", "text"]);
      return { kind: "text", text: contentText(entry.text) };
    }
    if (value.kind === "element") {
      const entry = object(value, ["kind", "tag", "children", "align", "start"]);
      return {
        kind: "element",
        tag: enumeration(entry.tag, tags),
        children: array(entry.children, CONTENT_LIMITS.nodes).map((child) =>
          node(child, depth + 1),
        ),
        align: entry.align === null ? null : enumeration(entry.align, ["left", "right", "center"]),
        start: entry.start === null ? null : integer(entry.start, 999_999_999),
      };
    }
    if (value.kind === "code") {
      const entry = object(value, ["kind", "text", "language", "tokens"]);
      return {
        kind: "code",
        text: contentText(entry.text),
        language: entry.language === null ? null : language(entry.language),
        tokens: array(entry.tokens, CONTENT_LIMITS.nodes).map((child) =>
          highlight(child, depth + 1),
        ),
      };
    }
    if (value.kind === "reference") {
      const entry = object(value, ["kind", "image", "reference", "children"]);
      const reference = object(entry.reference, ["raw", "target", "title"]);
      if (typeof entry.image !== "boolean") return fail();
      return {
        kind: "reference",
        image: entry.image,
        reference: {
          raw: contentText(reference.raw),
          target: contentText(reference.target),
          title: reference.title === null ? null : contentText(reference.title),
        },
        children: array(entry.children, CONTENT_LIMITS.nodes).map((child) =>
          node(child, depth + 1),
        ),
      };
    }
    return fail();
  }
  let window: TextWindow | null = null;
  if (item.window !== null) {
    const entry = object(item.window, ["startLine", "totalLines", "lines"]);
    let total = 0;
    window = {
      startLine: integer(entry.startLine),
      totalLines: integer(entry.totalLines),
      lines: array(entry.lines, CONTENT_LIMITS.sourceLines).map((value) => {
        const line = object(value, ["number", "text", "omittedCharacters"]);
        const text = string(line.text, CONTENT_LIMITS.lineCharacters);
        total += text.length;
        if (total > CONTENT_LIMITS.windowCharacters) return fail();
        return {
          number: integer(line.number),
          text,
          omittedCharacters: integer(line.omittedCharacters),
        };
      }),
    };
  }
  return {
    key: string(item.key, 1024),
    byteLength: integer(item.byteLength, CONTENT_LIMITS.inputBytes),
    format,
    status: enumeration(item.status, ["rich", "source", "binary", "limited"]),
    nodes: array(item.nodes, CONTENT_LIMITS.nodes).map((entry) => node(entry, 0)),
    window,
    rawHex: string(item.rawHex, CONTENT_LIMITS.rawBytes * 6),
    rawOffset: integer(item.rawOffset, CONTENT_LIMITS.inputBytes),
    rawLength: integer(item.rawLength, CONTENT_LIMITS.rawBytes),
    copyText: item.copyText === null ? null : string(item.copyText, CONTENT_LIMITS.richBytes),
    diagnostics: array(item.diagnostics, 32).map((entry) => string(entry, 512)),
  };
}
function readDocument(value: unknown): JsonResult<JsonDocument> {
  if (!record(value)) return fail();
  if (value.ok === false) {
    const result = object(value, ["ok", "error"]);
    const error = object(result.error, ["code", "message", "utf16Offset"]);
    return {
      ok: false,
      error: {
        code: enumeration(error.code, [
          "invalid_limits",
          "invalid_utf8",
          "invalid_unicode",
          "invalid_json",
          "duplicate_key",
          "byte_limit",
          "depth_limit",
          "node_limit",
          "string_limit",
        ]),
        message: string(error.message, 512),
        ...(error.utf16Offset === undefined ? {} : { utf16Offset: integer(error.utf16Offset) }),
      } satisfies JsonError,
    };
  }
  if (value.ok !== true) return fail();
  const result = object(value, ["ok", "value"]);
  const doc = object(result.value, ["source", "byteLength", "value"]);
  let nodes = 0;
  let chars = 0;
  function json(value: unknown, depth: number): JsonValue {
    if (++nodes > 100_000 || depth > 96 || !record(value)) return fail();
    if (value.kind === "null") {
      object(value, ["kind"]);
      return { kind: "null" };
    }
    const node = object(
      value,
      value.kind === "array"
        ? ["kind", "items"]
        : value.kind === "object"
          ? ["kind", "fields"]
          : value.kind === "number"
            ? ["kind", "lexeme"]
            : ["kind", "value"],
    );
    switch (node.kind) {
      case "boolean":
        if (typeof node.value !== "boolean") return fail();
        return { kind: "boolean", value: node.value };
      case "string": {
        const text = string(node.value);
        chars += text.length;
        if (chars > CONTENT_LIMITS.inputBytes) return fail();
        return { kind: "string", value: text };
      }
      case "number": {
        const lexeme = string(node.lexeme);
        chars += lexeme.length;
        if (chars > CONTENT_LIMITS.inputBytes) return fail();
        if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(lexeme)) return fail();
        return { kind: "number", lexeme };
      }
      case "array":
        return {
          kind: "array",
          items: array(node.items, 100_000).map((child) => json(child, depth + 1)),
        };
      case "object": {
        const names = new Set<string>();
        return {
          kind: "object",
          fields: array(node.fields, 100_000).map((value) => {
            if (++nodes > 100_000) return fail();
            const field = object(value, ["name", "value"]);
            const name = string(field.name);
            chars += name.length;
            if (names.has(name) || chars > CONTENT_LIMITS.inputBytes) return fail();
            names.add(name);
            return { name, value: json(field.value, depth + 1) };
          }),
        };
      }
      default:
        return fail();
    }
  }
  return {
    ok: true,
    value: {
      source: string(doc.source),
      byteLength: integer(doc.byteLength, CONTENT_LIMITS.inputBytes),
      value: json(doc.value, 0),
    },
  };
}
function decodeMessage(value: unknown): WorkerMessage {
  if (!record(value)) return fail();
  const item = object(
    value,
    value.kind === "stage"
      ? ["protocol", "jobId", "key", "kind", "stage"]
      : value.kind === "complete"
        ? ["protocol", "jobId", "key", "kind", "result"]
        : ["protocol", "jobId", "key", "kind", "failure", "message"],
  );
  if (item.protocol !== 1) return fail();
  const base = { protocol: 1 as const, jobId: string(item.jobId, 96), key: string(item.key, 1024) };
  if (item.kind === "stage")
    return {
      ...base,
      kind: "stage",
      stage: enumeration<WorkerStage>(item.stage, [
        "decode",
        "markdown",
        "highlight",
        "projection",
      ]),
    };
  if (item.kind === "failed")
    return {
      ...base,
      kind: "failed",
      failure: enumeration(item.failure, ["budget", "parser"]),
      message: string(item.message, 512),
    };
  if (item.kind !== "complete") return fail();
  const result = object(
    item.result,
    record(item.result) && item.result.kind === "render"
      ? ["kind", "preview"]
      : ["kind", "document"],
  );
  let projected: ContentJobResult;
  if (result.kind === "render")
    projected = { kind: "render", preview: readPreview(result.preview) };
  else if (result.kind === "json")
    projected = { kind: "json", document: readDocument(result.document) };
  else return fail();
  return { ...base, kind: "complete", result: projected };
}
export function readWorkerMessage(value: unknown): WorkerMessage | null {
  try {
    return decodeMessage(value);
  } catch (error: unknown) {
    if (error instanceof InvalidWire) return null;
    throw error;
  }
}
