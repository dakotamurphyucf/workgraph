import { describe, it, expect } from "vitest";
import {
  projectCapturedPayload,
  type CapturedPayload,
} from "../../../src/features/history/formats";
import { responses, assistant } from "./fixtures";
function project(value: unknown) {
  const capture: CapturedPayload = {
    captureId: "test",
    scopeId: ["local", "1", "demo", "session"],
    metadata: { kind: "null" },
    bytes: new TextEncoder().encode(JSON.stringify(value)),
    completeness: "complete",
    producer: null,
  };
  return projectCapturedPayload(capture);
}
function items(value: unknown) {
  const r = project(value);
  expect(r.status).toBe("recognized");
  if (r.status !== "recognized") throw Error(r.status);
  return r;
}
const line = {
  type: "assistant",
  sessionId: "claude-session",
  uuid: "line-1",
  parentUuid: null,
  timestamp: "2026-11-07T19:35:56Z",
  message: {
    role: "assistant",
    model: "recorded-model",
    content: [
      { type: "text", text: "First paragraph" },
      { type: "thinking", thinking: "Retained summary", signature: "opaque" },
      { type: "tool_use", id: "c1", name: "Read", input: { file_path: "example.ml" } },
      { type: "text", text: "Last paragraph" },
    ],
  },
};
describe("conversation schema projections", () => {
  it("distinguishes the Claude Code file envelope from SDK records and keeps every ordered block", () => {
    const r = items(line);
    expect(r.adapter.id).toBe("claude.code.transcript.v1");
    expect(r.projection.items.map((i) => i.kind)).toEqual([
      "text",
      "text",
      "opaque-reasoning",
      "tool-call",
      "text",
    ]);
    expect(items(assistant).adapter.id).toBe("claude.agent-sdk.message.v1");
  });
  it("projects Claude tool results as tools even though the containing message role is user", () => {
    const r = items({
      ...line,
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "c1",
            is_error: true,
            content: [{ type: "text", text: "Not found" }],
          },
        ],
      },
    });
    expect(r.projection.items[0]).toMatchObject({
      kind: "tool-result",
      callId: "c1",
      reportedError: true,
    });
  });
  it.each([
    { ...line, parentUuid: 3 },
    { ...line, sessionId: undefined },
    { ...line, message: { role: "user", content: "wrong role" } },
    { ...line, message: { role: "assistant", content: [{ type: "text", text: 3 }] } },
  ])("does not hide malformed known records under a recognized label", (value) =>
    expect(project(value).status).toBe("unsupported"),
  );
  it("keeps unknown blocks and side branches without claiming canonical conversation order", () => {
    const r = items({
      ...line,
      isSidechain: true,
      message: {
        role: "assistant",
        content: [{ type: "future-media", url: "https://invalid.test/private" }],
      },
    });
    expect(r.projection.items[0]?.kind).toBe("unsupported");
    expect(r.projection.warnings.join(" ")).toContain("side branch");
  });
  it("handles actual local Codex custom tool input and output envelopes", () => {
    const wrap = (payload: unknown) => ({
      timestamp: "2026-11-07T19:35:56Z",
      type: "response_item",
      ordinal: 12,
      payload,
    });
    expect(
      items(
        wrap({
          type: "custom_tool_call",
          call_id: "c",
          name: "apply_patch",
          input: "*** Begin Patch",
        }),
      ).projection.items[0],
    ).toMatchObject({
      kind: "tool-call",
      name: "apply_patch",
      arguments: { kind: "string", value: "*** Begin Patch" },
    });
    expect(
      items(wrap({ type: "custom_tool_call_output", call_id: "c", output: "Done" })).projection
        .items[0],
    ).toMatchObject({ kind: "tool-result", callId: "c" });
    expect(
      items(
        wrap({
          type: "agent_message",
          author: "/root",
          recipient: "/worker",
          content: [{ type: "input_text", text: "Please review" }],
        }),
      ).projection.items[0],
    ).toMatchObject({ kind: "text", role: "/root" });
  });
  it("renders Responses conversation inputs with user turns and call outputs that have no output-only ID or status", () => {
    const r = items({
      model: "recorded",
      instructions: "Be brief",
      input: [
        { role: "user", content: "Hello" },
        { type: "function_call_output", call_id: "c", output: "Saved" },
      ],
    });
    expect(r.adapter.id).toBe("openai.responses.input.v1");
    expect(r.projection.items.map((i) => i.kind)).toEqual(["text", "text", "tool-result"]);
  });
  it("renders an Anthropic input transcript with instructions before user and assistant content", () => {
    const r = items({
      model: "recorded",
      max_tokens: 100,
      system: "Instructions",
      messages: [
        { role: "user", content: "Question" },
        { role: "assistant", content: [{ type: "text", text: "Answer" }] },
      ],
    });
    expect(r.adapter.id).toBe("anthropic.messages.request.v1");
    expect(r.projection.items.map((i) => (i.kind === "text" ? i.role : i.kind))).toEqual([
      "system",
      "user",
      "assistant",
    ]);
  });
  it("supports older Responses usage without inventing missing cache write tokens", () => {
    const r = items({
      ...responses,
      usage: {
        input_tokens: 12,
        output_tokens: 4,
        total_tokens: 16,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 2 },
      },
    });
    expect(r.projection.metrics.some((m) => m.name === "cache_creation_tokens")).toBe(false);
  });
  it("renders shared standalone messages without falsely attributing a provider", () => {
    const r = items({ role: "assistant", content: "A standalone turn" });
    expect(r.adapter.id).toBe("conversation.item.v1");
    expect(r.projection.items[0]).toMatchObject({
      kind: "text",
      role: "assistant",
      text: "A standalone turn",
    });
  });
  it.each([
    [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }, "text"],
    [{ type: "function_call", call_id: "c", name: "read", arguments: "{}" }, "tool-call"],
    [{ type: "function_call_output", call_id: "c", output: "OK" }, "tool-result"],
    [
      { type: "reasoning", id: "r", summary: [{ type: "summary_text", text: "Saved summary" }] },
      "text",
    ],
    [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: "OK" }] },
      "tool-result",
    ],
    [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c", type: "function", function: { name: "read", arguments: "{}" } }],
      },
      "tool-call",
    ],
    [{ role: "tool", tool_call_id: "c", content: "OK" }, "tool-result"],
  ])("renders one item stored as one history event", (value, kind) => {
    const r = items(value);
    expect(r.adapter.id).toBe("conversation.item.v1");
    expect(r.projection.items[0]?.kind).toBe(kind);
  });
  it("keeps content-block source paths exact", () => {
    const r = items({
      role: "assistant",
      content: [
        { type: "text", text: "First" },
        { type: "thinking", thinking: "Saved", signature: "opaque" },
        { type: "tool_use", id: "c", name: "Read", input: {} },
      ],
    });
    expect(r.projection.items.map((i) => i.provenance.path)).toEqual([
      ["content", "0", "text"],
      ["content", "1", "thinking"],
      ["content", "1", "signature"],
      ["content", "2"],
    ]);
  });
  it("rejects a malformed standalone tool result", () =>
    expect(project({ type: "function_call_output", output: "OK" }).status).toBe("unsupported"));
});

it("retains Codex per-response usage separately from cumulative snapshots", () => {
  const r = items({
    timestamp: "2026-11-09T01:00:00Z",
    type: "token_usage_record",
    payload: {
      response_id: "response-1",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cached_input_tokens: 50,
        reasoning_output_tokens: 10,
        total_tokens: 120,
      },
      thread_token_usage: { input_tokens: 10000, output_tokens: 2000 },
    },
  });
  expect(r.projection.metrics.find((m) => m.name === "input_tokens")?.lexeme).toBe("100");
  expect(
    r.projection.metrics.every((m) => m.scope.kind === "response" && m.scope.id === "response-1"),
  ).toBe(true);
});
