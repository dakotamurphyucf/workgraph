import type { JsonValue } from "../../../core/json";
import type { SourcePath } from "./types";
import { Projection } from "./common";
import {
  array,
  enumeration,
  field,
  identifier,
  integer,
  object,
  optionalIdentifier,
  optionalString,
  required,
  string,
  mismatch,
} from "./validation";
function rolloutItem(raw: JsonValue, path: SourcePath, out: Projection): void {
  const s = object(raw, path),
    get = (k: string) => field(s, k),
    at = (k: string) => [...path, k];
  const type = string(get("type"), at("type"));
  if (type === "message" || type === "agent_message") {
    const role =
      type === "agent_message"
        ? string(get("author"), at("author"))
        : string(get("role"), at("role"));
    const phase = get("phase");
    if (phase !== undefined && phase.kind !== "null")
      enumeration(phase, ["commentary", "final_answer"], at("phase"));
    for (const [i, block] of array(get("content"), at("content")).entries()) {
      const p = [...path, "content", String(i)],
        b = object(block, p),
        t = string(field(b, "type"), [...p, "type"]);
      if (t === "input_text" || t === "output_text")
        out.text(
          block,
          [...p, "text"],
          string(field(b, "text"), [...p, "text"]),
          role,
          "message",
          phase?.kind === "string" ? phase.value : null,
        );
      else out.unsupported(block, p, `Unsupported Codex message content: ${t}`);
    }
    return;
  }
  if (type === "function_call" || type === "custom_tool_call") {
    const callId = identifier(get("call_id"), at("call_id")),
      name = identifier(get("name"), at("name"));
    const argumentKey = type === "custom_tool_call" ? "input" : "arguments";
    string(get(argumentKey), at(argumentKey));
    out.items.push({
      kind: "tool-call",
      callId,
      name,
      arguments: required(get(argumentKey), at(argumentKey)),
      raw,
      provenance: out.provenance(path),
    });
    return;
  }
  if (type === "function_call_output" || type === "custom_tool_call_output") {
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
    return;
  }
  if (type === "reasoning") {
    for (const [i, v] of array(get("summary"), at("summary")).entries()) {
      const p = [...path, "summary", String(i)],
        b = object(v, p);
      enumeration(field(b, "type"), ["summary_text"], [...p, "type"]);
      out.text(v, [...p, "text"], string(field(b, "text"), [...p, "text"]), null, "summary");
    }
    const content = get("content");
    if (content !== undefined && content.kind !== "null")
      for (const [i, v] of array(content, at("content")).entries()) {
        const p = [...path, "content", String(i)],
          b = object(v, p);
        enumeration(field(b, "type"), ["reasoning_text", "text"], [...p, "type"]);
        out.text(
          v,
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
    return;
  }
  out.unsupported(raw, path, `Unsupported Codex response item: ${type}`);
}
export function codexRollout(value: JsonValue, path: SourcePath, out: Projection): void {
  const s = object(value, path),
    get = (k: string) => field(s, k),
    at = (k: string) => [...path, k];
  const type = enumeration(
    get("type"),
    [
      "session_meta",
      "response_item",
      "compacted",
      "event_msg",
      "turn_context",
      "token_usage_record",
      "world_state",
      "inter_agent_communication_metadata",
    ],
    at("type"),
  );
  out.sourceTime = out.report(
    { format: "source-string", exact: string(get("timestamp"), at("timestamp")) },
    at("timestamp"),
  );
  const ordinal = get("ordinal");
  if (ordinal !== undefined && ordinal.kind !== "null") {
    const exact = integer(ordinal, at("ordinal"));
    if (BigInt(exact) > 18446744073709551615n) mismatch(at("ordinal"), "u64 ordinal");
    out.sourceSequence = out.report(exact, at("ordinal"));
  }
  const payload = required(get("payload"), at("payload")),
    p = at("payload"),
    body = object(payload, p);
  if (type === "response_item") {
    rolloutItem(payload, p, out);
    return;
  }
  if (type === "session_meta") {
    for (const key of ["id", "timestamp", "cwd", "originator", "cli_version"] as const)
      string(field(body, key), [...p, key]);
    out.identity = out.report(identifier(field(body, "id"), [...p, "id"]), [...p, "id"]);
    out.items.push({
      kind: "marker",
      label: "Codex session metadata",
      reportedStatus: null,
      raw: payload,
      provenance: out.provenance(p),
    });
    return;
  }
  if (type === "compacted") {
    out.text(
      payload,
      [...p, "message"],
      string(field(body, "message"), [...p, "message"]),
      null,
      "summary",
    );
    out.items.push({
      kind: "marker",
      label: "Compaction record",
      reportedStatus: null,
      raw: payload,
      provenance: out.provenance(p),
    });
    return;
  }
  if (type === "token_usage_record") {
    const responseId = identifier(field(body, "response_id"), [...p, "response_id"]);
    out.usage(
      field(body, "usage"),
      [...p, "usage"],
      { kind: "response", family: "codex.rollout", id: responseId },
      [
        ["input_tokens", "input_tokens", true],
        ["output_tokens", "output_tokens", true],
        ["total_tokens", "total_tokens", false],
        ["cached_input_tokens", "cache_read_tokens", false],
        ["cache_write_input_tokens", "cache_creation_tokens", false],
        ["reasoning_output_tokens", "reasoning_tokens", false],
      ],
    );
    out.items.push({
      kind: "marker",
      label: "Response token usage",
      reportedStatus: null,
      raw: payload,
      provenance: out.provenance(p),
    });
    return;
  }
  if (type !== "event_msg") {
    const model = optionalString(field(body, "model"), [...p, "model"]);
    if (model !== null) out.model = out.report(model, [...p, "model"]);
    out.items.push({
      kind: "marker",
      label: {
        turn_context: "Turn settings",
        world_state: "Environment snapshot",
        inter_agent_communication_metadata: "Agent handoff record",
      }[type],
      reportedStatus: null,
      raw: payload,
      provenance: out.provenance(p),
    });
    return;
  }
  const eventType = string(field(body, "type"), [...p, "type"]);
  if (eventType === "agent_message") {
    const phase = optionalString(field(body, "phase"), [...p, "phase"]);
    if (phase !== null)
      enumeration(field(body, "phase"), ["commentary", "final_answer"], [...p, "phase"]);
    out.text(
      payload,
      [...p, "message"],
      string(field(body, "message"), [...p, "message"]),
      "assistant",
      "message",
      phase,
    );
  } else if (
    [
      "task_started",
      "task_complete",
      "turn_aborted",
      "token_count",
      "item_completed",
      "thread_settings_applied",
    ].includes(eventType)
  ) {
    out.items.push({
      kind: "marker",
      label: `Codex ${eventType.replaceAll("_", " ")}`,
      reportedStatus: null,
      raw: payload,
      provenance: out.provenance(p),
    });
  } else out.unsupported(payload, p, `Unqualified Codex event_msg variant: ${eventType}`);
  out.warnings.push(
    "Pinned rollout projection does not derive token totals, hidden reasoning, liveness or project completion.",
  );
}
