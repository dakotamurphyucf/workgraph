import { jsonField, parseJsonText, type JsonValue } from "../../../core/json";
import type { ContentHints } from "../../../content";
import type { ProjectedItem } from "../formats";
import { prettyJson } from "./pretty-json";

export interface ToolDisplayPart {
  readonly label: string;
  readonly text: string;
  readonly hints: ContentHints;
}
const string = (value: JsonValue, key: string): string | undefined => {
  const found = jsonField(value, key);
  return found?.kind === "string" ? found.value : undefined;
};
export function recordedHints(value: JsonValue): ContentHints {
  const language = string(value, "language"),
    mime = string(value, "mime_type"),
    filename = string(value, "filename") ?? string(value, "file_path");
  return {
    ...(language ? { language } : {}),
    ...(mime ? { mime } : {}),
    ...(filename ? { filename } : {}),
  };
}
/** Display-only decoding. Never change the retained source or evaluate input. */
export function structuredText(text: string): JsonValue | null {
  if (!["{", "["].some((prefix) => text.trimStart().startsWith(prefix))) return null;
  const parsed = parseJsonText(text);
  return parsed.ok && ["object", "array"].includes(parsed.value.value.kind)
    ? parsed.value.value
    : null;
}
export function toolInputParts(
  item: Extract<ProjectedItem, { kind: "tool-call" }>,
): readonly ToolDisplayPart[] {
  const original = item.arguments;
  const codex = item.provenance.adapter === "codex.rollout-jsonl.7cdb219.v1";
  if (codex && ["exec", "functions.exec"].includes(item.name) && original.kind === "string")
    return [{ label: "JavaScript", text: original.value, hints: { language: "javascript" } }];
  const value =
    original.kind === "string" ? (structuredText(original.value) ?? original) : original;
  const command = string(value, "command") ?? string(value, "cmd"),
    code = string(value, "code"),
    content = string(value, "content"),
    filename = string(value, "file_path") ?? string(value, "path"),
    oldText = string(value, "old_string"),
    newText = string(value, "new_string");
  if (
    ["Bash", "bash", "exec_command", "functions.exec_command"].includes(item.name) &&
    command !== undefined
  )
    return [{ label: "Command", text: command, hints: { language: "bash" } }];
  if (["mcp__node_repl.js", "mcp__cua_repl.js"].includes(item.name) && code !== undefined)
    return [{ label: "JavaScript", text: code, hints: { language: "javascript" } }];
  if (["Write", "write_file"].includes(item.name) && content !== undefined)
    return [{ label: filename ?? "File content", text: content, hints: recordedHints(value) }];
  if (["Edit", "edit_file"].includes(item.name) && oldText !== undefined && newText !== undefined)
    return [
      { label: "Before", text: oldText, hints: { ...recordedHints(value), intent: "code" } },
      { label: "After", text: newText, hints: { ...recordedHints(value), intent: "code" } },
    ];
  if (item.name === "Read" && filename !== undefined)
    return [{ label: "File", text: filename, hints: { intent: "code", language: "plaintext" } }];
  if (["Grep", "Glob"].includes(item.name) && string(value, "pattern") !== undefined)
    return [
      {
        label: item.name === "Grep" ? "Search pattern" : "File pattern",
        text: prettyJson(value),
        hints: { language: "json" },
      },
    ];
  if (["apply_patch", "functions.apply_patch"].includes(item.name) && original.kind === "string")
    return [{ label: "Patch", text: original.value, hints: { language: "diff" } }];
  return [
    {
      label: "Input",
      text: value.kind === "string" ? value.value : prettyJson(value),
      hints: value.kind === "string" ? { intent: "prose" } : { language: "json" },
    },
  ];
}
/** Exec outputs sometimes contain several JSON documents concatenated by text().
 * Split only complete object/array documents, respecting quoted braces. A mixed
 * or malformed stream remains untouched. One bounded parse validates the result. */
export function outputDocuments(text: string): readonly JsonValue[] | null {
  const whole = structuredText(text);
  if (whole) return [whole];
  if (text.length > 4 * 1024 * 1024) return null;
  const documents: string[] = [];
  let start = -1,
    depth = 0,
    quoted = false,
    escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (start === -1) {
      if (/\s/u.test(c)) continue;
      if (c !== "{" && c !== "[") return null;
      start = i;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) {
        documents.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  if (start !== -1 || documents.length < 2) return null;
  const parsed = parseJsonText(`[${documents.join(",")}]`);
  return parsed.ok && parsed.value.value.kind === "array" ? parsed.value.value.items : null;
}
