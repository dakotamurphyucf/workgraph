/** Synthetic fixtures only. Never copy private session content or filesystem paths. */
export const messages = {
  type: "message",
  id: "msg-fixture",
  role: "assistant",
  model: "synthetic-model",
  content: [{ type: "text", text: "Synthetic response." }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 4 },
};
export const responses = {
  object: "response",
  id: "response-fixture",
  model: "synthetic-model",
  created_at: 1780000000.125,
  status: "completed",
  parallel_tool_calls: true,
  tool_choice: "auto",
  tools: [],
  output: [
    {
      id: "output-fixture",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Synthetic result.", annotations: [] }],
    },
  ],
  usage: {
    input_tokens: 12,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens: 4,
    output_tokens_details: { reasoning_tokens: 2 },
    total_tokens: 16,
  },
};
export const chat = {
  object: "chat.completion",
  id: "chat-fixture",
  created: 1780000000,
  model: "synthetic-model",
  choices: [
    { index: 0, finish_reason: "stop", message: { role: "assistant", content: "Synthetic chat." } },
  ],
};
export const assistant = {
  type: "assistant",
  uuid: "00000000-0000-4000-8000-000000000001",
  session_id: "synthetic-session",
  parent_tool_use_id: null,
  message: messages,
};
export const user = {
  type: "user",
  uuid: "00000000-0000-4000-8000-000000000002",
  session_id: "synthetic-session",
  parent_tool_use_id: null,
  message: { role: "user", content: "Synthetic input." },
};
export const init = {
  type: "system",
  subtype: "init",
  uuid: "00000000-0000-4000-8000-000000000003",
  session_id: "synthetic-session",
  apiKeySource: "none",
  claude_code_version: "synthetic",
  cwd: "/synthetic/project",
  tools: ["synthetic-tool"],
  mcp_servers: [],
  model: "synthetic-model",
  permissionMode: "default",
  slash_commands: [],
  output_style: "default",
  skills: [],
  plugins: [],
};
export const result = {
  type: "result",
  subtype: "success",
  uuid: "00000000-0000-4000-8000-000000000004",
  session_id: "synthetic-session",
  duration_ms: 300,
  duration_api_ms: 200,
  is_error: false,
  num_turns: 2,
  result: "Reported result only.",
  stop_reason: "end_turn",
  total_cost_usd: 0.001,
  usage: { input_tokens: 12, output_tokens: 4 },
  modelUsage: {
    synthetic: {
      inputTokens: 12,
      outputTokens: 4,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0.001,
      contextWindow: 1000,
      maxOutputTokens: 100,
    },
  },
  permission_denials: [],
};
export const codex = {
  timestamp: "synthetic-source-time",
  ordinal: 7,
  type: "response_item",
  payload: {
    type: "message",
    role: "assistant",
    phase: "final_answer",
    content: [{ type: "output_text", text: "Reported final text." }],
  },
};
export const codexMeta = {
  timestamp: "synthetic-source-time",
  type: "session_meta",
  payload: {
    id: "synthetic-thread",
    session_id: "synthetic-root",
    timestamp: "synthetic-creation-time",
    cwd: "/synthetic/project",
    originator: "synthetic",
    cli_version: "synthetic",
  },
};
