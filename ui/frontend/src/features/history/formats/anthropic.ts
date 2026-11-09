import type { JsonValue } from "../../../core/json";
import type { SourcePath } from "./types";
import { Projection } from "./common";
import {
  array,
  bool,
  enumeration,
  field,
  identifier,
  literal,
  nullableString,
  object,
  optionalString,
  required,
  string,
} from "./validation";
const stops = [
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "tool_use",
  "pause_turn",
  "refusal",
  "model_context_window_exceeded",
] as const;
export function anthropicBlocks(
  value: JsonValue | undefined,
  path: SourcePath,
  output: Projection,
  role: string,
  request = false,
): void {
  if (request && value?.kind === "string") {
    output.text(value, path, value.value, role);
    return;
  }
  for (const [index, raw] of array(value, path).entries())
    anthropicBlock(raw, [...path, String(index)], output, role, request);
}
export function anthropicBlock(
  raw: JsonValue,
  at: SourcePath,
  output: Projection,
  role: string,
  request = false,
): void {
  const block = object(raw, at);
  const type = string(field(block, "type"), [...at, "type"]);
  switch (type) {
    case "text":
      output.text(raw, at, string(field(block, "text"), [...at, "text"]), role);
      break;
    case "tool_use": {
      const callId = identifier(field(block, "id"), [...at, "id"]);
      const name = identifier(field(block, "name"), [...at, "name"]);
      const args = object(field(block, "input"), [...at, "input"]);
      output.items.push({
        kind: "tool-call",
        callId,
        name,
        arguments: args,
        raw,
        provenance: output.provenance(at),
      });
      break;
    }
    case "thinking": {
      const thinking = string(field(block, "thinking"), [...at, "thinking"]);
      const signature = string(field(block, "signature"), [...at, "signature"]);
      output.text(raw, [...at, "thinking"], thinking, role, "retained-reasoning");
      output.items.push({
        kind: "opaque-reasoning",
        retention: "signature",
        opaque: { kind: "string", value: signature },
        raw,
        provenance: output.provenance([...at, "signature"]),
      });
      break;
    }
    case "redacted_thinking": {
      const data = string(field(block, "data"), [...at, "data"]);
      output.items.push({
        kind: "opaque-reasoning",
        retention: "redacted",
        opaque: { kind: "string", value: data },
        raw,
        provenance: output.provenance(at),
      });
      break;
    }
    case "tool_result": {
      if (!request) {
        output.unsupported(raw, at, "tool_result is not a Messages response block");
        break;
      }
      const callId = identifier(field(block, "tool_use_id"), [...at, "tool_use_id"]);
      const content = field(block, "content");
      if (content !== undefined && content.kind !== "string") array(content, [...at, "content"]);
      const error = field(block, "is_error");
      output.items.push({
        kind: "tool-result",
        callId,
        content: content ?? { kind: "null" },
        reportedError: error === undefined ? null : bool(error, [...at, "is_error"]),
        raw,
        provenance: output.provenance(at),
      });
      break;
    }
    default:
      output.unsupported(raw, at, `Unsupported Messages block type: ${type}`);
  }
}

export function anthropicMessage(value: JsonValue, path: SourcePath, output: Projection): void {
  const source = object(value, path);
  literal(field(source, "type"), "message", [...path, "type"]);
  literal(field(source, "role"), "assistant", [...path, "role"]);
  const id = identifier(field(source, "id"), [...path, "id"]);
  output.identity = output.report(id, [...path, "id"]);
  output.model = output.report(identifier(field(source, "model"), [...path, "model"]), [
    ...path,
    "model",
  ]);
  const stop = field(source, "stop_reason");
  if (stop !== undefined && stop.kind !== "null")
    output.reportedStatus = output.report(enumeration(stop, stops, [...path, "stop_reason"]), [
      ...path,
      "stop_reason",
    ]);
  optionalString(field(source, "stop_sequence"), [...path, "stop_sequence"]);
  anthropicBlocks(field(source, "content"), [...path, "content"], output, "assistant");
  output.usage(
    required(field(source, "usage"), [...path, "usage"]),
    [...path, "usage"],
    { kind: "response", family: "anthropic.messages", id },
    [
      ["input_tokens", "input_tokens", true],
      ["output_tokens", "output_tokens", true],
      ["cache_read_input_tokens", "cache_read_tokens", false],
      ["cache_creation_input_tokens", "cache_creation_tokens", false],
    ],
  );
}
// SDK wrapper requires its parent correlation field even when there is no parent.
export function sdkParent(source: JsonValue, path: SourcePath): void {
  nullableString(field(source, "parent_tool_use_id"), [...path, "parent_tool_use_id"]);
}
