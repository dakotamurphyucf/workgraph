import type { JsonValue } from "../../../core/json";
import type { SourcePath } from "./types";
import { Projection } from "./common";
import { anthropicBlocks, anthropicMessage, sdkParent } from "./anthropic";
import {
  array,
  bool,
  enumeration,
  field,
  identifier,
  literal,
  object,
  optionalString,
  required,
  string,
  nonnegative,
  integer,
} from "./validation";
export function claudeSdk(value: JsonValue, path: SourcePath, out: Projection): void {
  const s = object(value, path),
    get = (k: string) => field(s, k),
    at = (k: string) => [...path, k];
  const type = enumeration(get("type"), ["assistant", "user", "system", "result"], at("type"));
  const resultId = identifier(get("uuid"), at("uuid"));
  const session = identifier(get("session_id"), at("session_id"));
  out.identity = out.report(session, at("session_id"));
  if (type === "assistant" || type === "user") {
    const timestamp = optionalString(get("timestamp"), at("timestamp"));
    if (timestamp !== null)
      out.sourceTime = out.report({ format: "source-string", exact: timestamp }, at("timestamp"));
    sdkParent(s, path);
    const message = required(get("message"), at("message"));
    if (type === "assistant") {
      anthropicMessage(message, at("message"), out);
      out.identity = out.report(session, at("session_id"));
    } else {
      const m = object(message, at("message"));
      literal(field(m, "role"), "user", [...path, "message", "role"]);
      anthropicBlocks(field(m, "content"), [...path, "message", "content"], out, "user", true);
    }
    return;
  }
  if (type === "system") {
    literal(get("subtype"), "init", at("subtype"));
    for (const key of ["claude_code_version", "cwd", "output_style"] as const)
      string(get(key), at(key));
    enumeration(
      get("apiKeySource"),
      [
        "ANTHROPIC_API_KEY",
        "apiKeyHelper",
        "/login managed key",
        "none",
        "user",
        "project",
        "org",
        "temporary",
        "oauth",
      ],
      at("apiKeySource"),
    );
    enumeration(
      get("permissionMode"),
      ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"],
      at("permissionMode"),
    );
    for (const key of ["tools", "slash_commands", "skills"] as const)
      for (const [i, v] of array(get(key), at(key)).entries()) string(v, [...path, key, String(i)]);
    for (const key of ["mcp_servers", "plugins"] as const)
      for (const [i, v] of array(get(key), at(key)).entries()) {
        const p = [...path, key, String(i)],
          b = object(v, p);
        string(field(b, "name"), [...p, "name"]);
        string(field(b, key === "plugins" ? "path" : "status"), [
          ...p,
          key === "plugins" ? "path" : "status",
        ]);
      }
    out.model = out.report(identifier(get("model"), at("model")), at("model"));
    out.items.push({
      kind: "marker",
      label: "SDK initialization report",
      reportedStatus: null,
      raw: value,
      provenance: out.provenance(path),
    });
    return;
  }
  const subtype = enumeration(
    get("subtype"),
    [
      "success",
      "error_during_execution",
      "error_max_turns",
      "error_max_budget_usd",
      "error_max_structured_output_retries",
    ],
    at("subtype"),
  );
  const isError = bool(get("is_error"), at("is_error"));
  out.reportedError = out.report(isError, at("is_error"));
  const stop = get("stop_reason");
  if (stop?.kind !== "null") string(stop, at("stop_reason"));
  const scope = {
    kind: "sdk-result",
    family: "claude.agent-sdk",
    sessionId: session,
    resultId,
  } as const;
  for (const [key, name] of [
    ["duration_ms", "duration_ms"],
    ["duration_api_ms", "api_duration_ms"],
  ] as const)
    out.metric(
      required(get(key), at(key)),
      at(key),
      name,
      scope,
      "report",
      "reported-result-duration-extent-not-inferred",
    );
  out.metric(
    required(get("num_turns"), at("num_turns")),
    at("num_turns"),
    "model_round_trips",
    scope,
    "report",
    "reported-result-model-round-trips",
  );
  out.metric(
    required(get("total_cost_usd"), at("total_cost_usd")),
    at("total_cost_usd"),
    "estimated_cost_usd",
    {
      kind: "sdk-query-pipeline",
      family: "claude.agent-sdk",
      sessionId: session,
      queryId: null,
      reportedByResultId: resultId,
    },
    "cumulative-snapshot",
    "reported-query-pipeline-cumulative-query-boundary-unknown",
  );
  out.usage(
    get("usage"),
    at("usage"),
    scope,
    [
      ["input_tokens", "input_tokens", true],
      ["output_tokens", "output_tokens", true],
      ["cache_read_input_tokens", "cache_read_tokens", false],
      ["cache_creation_input_tokens", "cache_creation_tokens", false],
    ],
    "report",
    "reported-main-agent-only-usage-per-turn-in-streaming",
  );
  const modelUsage = object(get("modelUsage"), at("modelUsage"));
  for (const entry of modelUsage.fields) {
    const p = [...path, "modelUsage", entry.name],
      m = object(entry.value, p);
    for (const k of [
      "inputTokens",
      "outputTokens",
      "cacheReadInputTokens",
      "cacheCreationInputTokens",
      "webSearchRequests",
      "contextWindow",
      "maxOutputTokens",
    ] as const)
      integer(field(m, k), [...p, k]);
    nonnegative(field(m, "costUSD"), [...p, "costUSD"]);
  }
  for (const [i, v] of array(get("permission_denials"), at("permission_denials")).entries()) {
    const p = [...path, "permission_denials", String(i)],
      d = object(v, p);
    string(field(d, "tool_name"), [...p, "tool_name"]);
    string(field(d, "tool_use_id"), [...p, "tool_use_id"]);
    object(field(d, "tool_input"), [...p, "tool_input"]);
  }
  if (subtype === "success")
    out.text(
      value,
      at("result"),
      string(get("result"), at("result")),
      "assistant",
      isError ? "reported-error" : "reported-result",
    );
  else
    for (const [i, error] of array(get("errors"), at("errors")).entries())
      out.text(
        error,
        [...path, "errors", String(i)],
        string(error, [...path, "errors", String(i)]),
        null,
        "reported-error",
      );
  out.reportedStatus = out.report(subtype, at("subtype"));
  out.warnings.push(
    "SDK result is a reported outcome, not project completion or process liveness. usage reports main-agent-only usage and is per-turn in streaming-input sessions; num_turns counts model round-trips within one turn. total_cost_usd/modelUsage are cumulative query-pipeline estimates and may include restored state or reset after /clear. Session identity does not establish query boundaries. modelUsage is retained raw; do not add it to usage or sum cost reports.",
  );
}
