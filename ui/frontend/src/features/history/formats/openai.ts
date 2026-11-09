import type { JsonValue } from "../../../core/json";
import { Projection } from "./common";
import type { SourcePath } from "./types";
import {
  array,
  bool,
  enumeration,
  field,
  identifier,
  integer,
  literal,
  nonnegative,
  object,
  optionalIdentifier,
  optionalString,
  required,
  string,
} from "./validation";
const statuses = [
  "completed",
  "failed",
  "in_progress",
  "cancelled",
  "queued",
  "incomplete",
] as const;
const itemStatuses = ["in_progress", "completed", "incomplete"] as const;
export function responseItem(raw: JsonValue, path: SourcePath, out: Projection): void {
  const item = object(raw, path),
    type = string(field(item, "type"), [...path, "type"]);
  const get = (key: string) => field(item, key),
    at = (key: string) => [...path, key];
  switch (type) {
    case "message": {
      identifier(get("id"), at("id"));
      literal(get("role"), "assistant", at("role"));
      enumeration(get("status"), itemStatuses, at("status"));
      const phase = get("phase");
      if (phase !== undefined && phase.kind !== "null")
        enumeration(phase, ["commentary", "final_answer"], at("phase"));
      for (const [i, block] of array(get("content"), at("content")).entries()) {
        const p = [...path, "content", String(i)],
          b = object(block, p),
          t = string(field(b, "type"), [...p, "type"]);
        if (t === "output_text") {
          array(field(b, "annotations"), [...p, "annotations"]);
          out.text(
            block,
            [...p, "text"],
            string(field(b, "text"), [...p, "text"]),
            "assistant",
            "message",
            phase?.kind === "string" ? phase.value : null,
          );
        } else if (t === "refusal")
          out.text(
            block,
            [...p, "refusal"],
            string(field(b, "refusal"), [...p, "refusal"]),
            "assistant",
            "refusal",
          );
        else out.unsupported(block, p, `Unsupported Responses message content: ${t}`);
      }
      break;
    }
    case "custom_tool_call":
    case "function_call": {
      const callId = identifier(get("call_id"), at("call_id")),
        name = identifier(get("name"), at("name"));
      const argumentKey = type === "custom_tool_call" ? "input" : "arguments";
      string(get(argumentKey), at(argumentKey));
      const status = get("status");
      if (status !== undefined && status.kind !== "null")
        enumeration(status, itemStatuses, at("status"));
      out.items.push({
        kind: "tool-call",
        callId,
        name,
        arguments: required(get(argumentKey), at(argumentKey)),
        raw,
        provenance: out.provenance(path),
      });
      break;
    }
    case "custom_tool_call_output":
    case "function_call_output": {
      optionalIdentifier(get("id"), at("id"));
      const status = get("status");
      if (status !== undefined && status.kind !== "null")
        enumeration(status, itemStatuses, at("status"));
      const content = required(get("output"), at("output"));
      if (content.kind !== "string") array(content, at("output"));
      out.items.push({
        kind: "tool-result",
        callId: optionalIdentifier(get("call_id"), at("call_id")),
        content,
        reportedError: null,
        raw,
        provenance: out.provenance(path),
      });
      break;
    }
    case "reasoning": {
      identifier(get("id"), at("id"));
      for (const [i, summary] of array(get("summary"), at("summary")).entries()) {
        const p = [...path, "summary", String(i)],
          s = object(summary, p);
        literal(field(s, "type"), "summary_text", [...p, "type"]);
        out.text(
          summary,
          [...p, "text"],
          string(field(s, "text"), [...p, "text"]),
          null,
          "summary",
        );
      }
      const content = get("content");
      if (content !== undefined && content.kind !== "null")
        for (const [i, entry] of array(content, at("content")).entries()) {
          const p = [...path, "content", String(i)],
            b = object(entry, p);
          literal(field(b, "type"), "reasoning_text", [...p, "type"]);
          out.text(
            entry,
            [...p, "text"],
            string(field(b, "text"), [...p, "text"]),
            null,
            "retained-reasoning",
          );
        }
      const encrypted = get("encrypted_content");
      if (encrypted !== undefined && encrypted.kind !== "null") {
        string(encrypted, at("encrypted_content"));
        out.items.push({
          kind: "opaque-reasoning",
          retention: "encrypted",
          opaque: encrypted,
          raw,
          provenance: out.provenance(at("encrypted_content")),
        });
      }
      break;
    }
    default:
      out.unsupported(raw, path, `Unsupported Responses output item: ${type}`);
  }
}
export function response(value: JsonValue, path: SourcePath, out: Projection): void {
  const s = object(value, path),
    get = (k: string) => field(s, k),
    at = (k: string) => [...path, k];
  literal(get("object"), "response", at("object"));
  const id = identifier(get("id"), at("id"));
  out.identity = out.report(id, at("id"));
  out.model = out.report(identifier(get("model"), at("model")), at("model"));
  out.sourceTime = out.report(
    { format: "unix-seconds", exact: nonnegative(get("created_at"), at("created_at")) },
    at("created_at"),
  );
  out.reportedStatus = out.report(enumeration(get("status"), statuses, at("status")), at("status"));
  bool(get("parallel_tool_calls"), at("parallel_tool_calls"));
  array(get("tools"), at("tools"));
  const choice = required(get("tool_choice"), at("tool_choice"));
  if (choice.kind !== "string") object(choice, at("tool_choice"));
  for (const [i, item] of array(get("output"), at("output")).entries())
    responseItem(item, [...path, "output", String(i)], out);
  const usage = get("usage");
  if (usage !== undefined && usage.kind !== "null") {
    const scope = { kind: "response", family: "openai.responses", id } as const;
    out.usage(usage, at("usage"), scope, [
      ["input_tokens", "input_tokens", true],
      ["output_tokens", "output_tokens", true],
      ["total_tokens", "total_tokens", true],
    ]);
    const u = object(usage, at("usage"));
    for (const [detail, fields] of [
      [
        "input_tokens_details",
        [
          ["cached_tokens", "cache_read_tokens"],
          ["cache_write_tokens", "cache_creation_tokens"],
        ],
      ],
      ["output_tokens_details", [["reasoning_tokens", "reasoning_tokens"]]],
    ] as const) {
      const p = [...path, "usage", detail],
        d = object(field(u, detail), p);
      for (const [key, name] of fields) {
        const metric = field(d, key);
        if (metric !== undefined && metric.kind !== "null")
          out.metric(metric, [...p, key], name, scope, "breakdown");
      }
    }
  }
}
export function responseEvent(value: JsonValue, path: SourcePath, out: Projection): void {
  const s = object(value, path),
    type = enumeration(
      field(s, "type"),
      [
        "response.created",
        "response.completed",
        "response.failed",
        "response.incomplete",
        "response.output_item.done",
      ],
      [...path, "type"],
    );
  out.sourceSequence = out.report(
    integer(field(s, "sequence_number"), [...path, "sequence_number"]),
    [...path, "sequence_number"],
  );
  if (type === "response.output_item.done") {
    integer(field(s, "output_index"), [...path, "output_index"]);
    responseItem(required(field(s, "item"), [...path, "item"]), [...path, "item"], out);
  } else
    response(required(field(s, "response"), [...path, "response"]), [...path, "response"], out);
  out.warnings.push(
    "One complete event only; no streaming reassembly or implied session completion.",
  );
}
export function chatCompletion(value: JsonValue, path: SourcePath, out: Projection): void {
  const s = object(value, path),
    get = (k: string) => field(s, k),
    at = (k: string) => [...path, k];
  literal(get("object"), "chat.completion", at("object"));
  const id = identifier(get("id"), at("id"));
  out.identity = out.report(id, at("id"));
  out.model = out.report(identifier(get("model"), at("model")), at("model"));
  out.sourceTime = out.report(
    { format: "unix-seconds", exact: integer(get("created"), at("created")) },
    at("created"),
  );
  for (const [i, raw] of array(get("choices"), at("choices")).entries()) {
    const p = [...path, "choices", String(i)],
      c = object(raw, p);
    integer(field(c, "index"), [...p, "index"]);
    enumeration(
      field(c, "finish_reason"),
      ["stop", "length", "tool_calls", "content_filter", "function_call"],
      [...p, "finish_reason"],
    );
    const mp = [...p, "message"],
      m = object(field(c, "message"), mp);
    literal(field(m, "role"), "assistant", [...mp, "role"]);
    for (const key of ["content", "refusal"] as const) {
      const text = optionalString(field(m, key), [...mp, key]);
      if (text !== null)
        out.text(raw, [...mp, key], text, "assistant", key === "refusal" ? "refusal" : "message");
    }
    const calls = field(m, "tool_calls");
    if (calls !== undefined && calls.kind !== "null")
      for (const [j, call] of array(calls, [...mp, "tool_calls"]).entries()) {
        const cp = [...mp, "tool_calls", String(j)],
          t = object(call, cp),
          type = string(field(t, "type"), [...cp, "type"]);
        if (type !== "function") {
          out.unsupported(call, cp, `Unsupported Chat tool call: ${type}`);
          continue;
        }
        const callId = identifier(field(t, "id"), [...cp, "id"]),
          f = object(field(t, "function"), [...cp, "function"]),
          name = identifier(field(f, "name"), [...cp, "function", "name"]),
          args = required(field(f, "arguments"), [...cp, "function", "arguments"]);
        string(args, [...cp, "function", "arguments"]);
        out.items.push({
          kind: "tool-call",
          callId,
          name,
          arguments: args,
          raw: call,
          provenance: out.provenance(cp),
        });
      }
    const legacy = field(m, "function_call");
    if (legacy !== undefined && legacy.kind !== "null")
      out.unsupported(
        legacy,
        [...mp, "function_call"],
        "Legacy function_call retained without a call identity.",
      );
  }
  const usage = get("usage");
  if (usage !== undefined && usage.kind !== "null") {
    const scope = { kind: "response", family: "openai.chat-completions", id } as const;
    out.usage(usage, at("usage"), scope, [
      ["prompt_tokens", "input_tokens", true],
      ["completion_tokens", "output_tokens", true],
      ["total_tokens", "total_tokens", true],
    ]);
    const u = object(usage, at("usage"));
    for (const [detail, key, name] of [
      ["prompt_tokens_details", "cached_tokens", "cache_read_tokens"],
      ["completion_tokens_details", "reasoning_tokens", "reasoning_tokens"],
    ] as const) {
      const d = field(u, detail);
      if (d !== undefined && d.kind !== "null") {
        const p = [...path, "usage", detail],
          v = field(object(d, p), key);
        if (v !== undefined && v.kind !== "null")
          out.metric(v, [...p, key], name, scope, "breakdown");
      }
    }
  }
}
