import type { JsonValue } from "../../../core/json";
import type { SourcePath } from "./types";
import type { Projection } from "./common";
import { anthropicBlock } from "./anthropic";
import { responseItem } from "./openai";
import {
  array,
  enumeration,
  field,
  identifier,
  mismatch,
  object,
  required,
  string,
} from "./validation";

/** One stored conversation item, not a whole request/response. Common role/content
 * shapes do not establish a provider. Envelopes belong to their own adapters. */
export function conversationItem(value: JsonValue, path: SourcePath, out: Projection): void {
  const source = object(value, path);
  for (const key of ["object", "model", "usage", "sessionId", "session_id", "payload"])
    if (field(source, key) !== undefined)
      mismatch(path, "standalone conversation item, not an envelope");
  const type = field(source, "type");
  if (type !== undefined && !(type.kind === "string" && type.value === "message")) {
    const kind = string(type, [...path, "type"]);
    if (
      [
        "function_call",
        "function_call_output",
        "custom_tool_call",
        "custom_tool_call_output",
        "reasoning",
      ].includes(kind)
    ) {
      if (kind.endsWith("_output")) identifier(field(source, "call_id"), [...path, "call_id"]);
      responseItem(value, path, out);
    } else if (["tool_use", "tool_result", "thinking", "redacted_thinking"].includes(kind)) {
      anthropicBlock(value, path, out, "assistant", true);
    } else mismatch([...path, "type"], "known standalone conversation item");
    return;
  }
  const role = enumeration(
    field(source, "role"),
    ["user", "assistant", "system", "developer", "tool"],
    [...path, "role"],
  );
  const phase = field(source, "phase");
  const reportedPhase =
    phase === undefined || phase.kind === "null"
      ? null
      : enumeration(phase, ["commentary", "final_answer"], [...path, "phase"]);
  const content = field(source, "content");
  if (role === "tool") {
    const result = required(content, [...path, "content"]);
    string(result, [...path, "content"]);
    out.items.push({
      kind: "tool-result",
      callId: identifier(field(source, "tool_call_id"), [...path, "tool_call_id"]),
      content: result,
      reportedError: null,
      raw: value,
      provenance: out.provenance(path),
    });
    return;
  }
  if (content?.kind === "string")
    out.text(content, [...path, "content"], content.value, role, "message", reportedPhase);
  else if (content !== undefined && content.kind !== "null") {
    for (const [i, block] of array(content, [...path, "content"]).entries()) {
      const at = [...path, "content", String(i)],
        b = object(block, at),
        kind = string(field(b, "type"), [...at, "type"]);
      if (["input_text", "output_text", "text"].includes(kind))
        out.text(
          block,
          [...at, "text"],
          string(field(b, "text"), [...at, "text"]),
          role,
          "message",
          reportedPhase,
        );
      else if (kind === "refusal")
        out.text(
          block,
          [...at, "refusal"],
          string(field(b, "refusal"), [...at, "refusal"]),
          role,
          "refusal",
        );
      else {
        anthropicBlock(block, at, out, role, true);
      }
    }
  } else if (field(source, "tool_calls") === undefined && field(source, "refusal") === undefined)
    mismatch([...path, "content"], "message content or tool calls");
  const refusal = field(source, "refusal");
  if (refusal !== undefined && refusal.kind !== "null")
    out.text(value, [...path, "refusal"], string(refusal, [...path, "refusal"]), role, "refusal");
  const calls = field(source, "tool_calls");
  if (calls !== undefined && calls.kind !== "null")
    for (const [i, raw] of array(calls, [...path, "tool_calls"]).entries()) {
      const at = [...path, "tool_calls", String(i)],
        call = object(raw, at);
      enumeration(field(call, "type"), ["function"], [...at, "type"]);
      const fn = object(field(call, "function"), [...at, "function"]);
      const args = required(field(fn, "arguments"), [...at, "function", "arguments"]);
      string(args, [...at, "function", "arguments"]);
      out.items.push({
        kind: "tool-call",
        callId: identifier(field(call, "id"), [...at, "id"]),
        name: identifier(field(fn, "name"), [...at, "function", "name"]),
        arguments: args,
        raw,
        provenance: out.provenance(at),
      });
    }
}
