import type { JsonValue } from "../../../core/json";
import type { SourcePath } from "./types";
import type { Projection } from "./common";
import { anthropicBlocks } from "./anthropic";
import {
  object,
  field,
  enumeration,
  identifier,
  nullableString,
  string,
  optionalString,
  bool,
} from "./validation";

/** One on-disk Claude Code JSONL record, distinct from the SDK's snake_case
 * SessionMessage. The published SDK reader establishes these consumed fields.
 * Preserve file order and parent identity; do not invent a canonical branch. */
export function claudeTranscript(value: JsonValue, path: SourcePath, out: Projection): void {
  const record = object(value, path);
  const type = enumeration(
    field(record, "type"),
    ["user", "assistant", "system", "progress", "attachment"],
    [...path, "type"],
  );
  identifier(field(record, "uuid"), [...path, "uuid"]);
  const session = identifier(field(record, "sessionId"), [...path, "sessionId"]);
  nullableString(field(record, "parentUuid"), [...path, "parentUuid"]);
  const time = string(field(record, "timestamp"), [...path, "timestamp"]);
  out.identity = out.report(session, [...path, "sessionId"]);
  out.sourceTime = out.report({ format: "source-string", exact: time }, [...path, "timestamp"]);
  const sidechain = field(record, "isSidechain");
  if (sidechain !== undefined && bool(sidechain, [...path, "isSidechain"]))
    out.warnings.push(
      "Recorded on a side branch. This viewer preserves imported order; it does not rebuild the active conversation branch.",
    );
  if (type === "user" || type === "assistant") {
    const p = [...path, "message"],
      message = object(field(record, "message"), p);
    enumeration(field(message, "role"), [type], [...p, "role"]);
    const model = optionalString(field(message, "model"), [...p, "model"]);
    if (model !== null) out.model = out.report(model, [...p, "model"]);
    anthropicBlocks(field(message, "content"), [...p, "content"], out, type, type === "user");
  } else {
    const subtype = optionalString(field(record, "subtype"), [...path, "subtype"]);
    const content = field(record, "content");
    if (content?.kind === "string")
      out.text(
        content,
        [...path, "content"],
        content.value,
        "system",
        subtype === "compact_boundary" ? "summary" : "message",
      );
    out.items.push({
      kind: "marker",
      label:
        subtype === "compact_boundary"
          ? "Conversation compacted"
          : `Claude Code ${type}${subtype ? ` · ${subtype}` : ""}`,
      reportedStatus: null,
      raw: value,
      provenance: out.provenance(path),
    });
  }
}
