import { describe, expect, it } from "vitest";
import { jsonField } from "../../../src/core/json";
import {
  FORMAT_ADAPTERS,
  FORMAT_LIMITS,
  projectCapturedPayload,
  type CapturedPayload,
  type FormatSelection,
  type ProjectionResult,
} from "../../../src/features/history/formats";
import {
  assistant,
  chat,
  codex,
  codexMeta,
  init,
  messages,
  responses,
  result,
  user,
} from "./fixtures";
function capture(value: unknown): CapturedPayload {
  return source(JSON.stringify(value));
}
function source(text: string): CapturedPayload {
  return {
    captureId: "synthetic-capture:event-7",
    scopeId: ["synthetic-connection", "1", "synthetic-workspace", "synthetic-session"],
    metadata: { kind: "object", fields: [] },
    bytes: new TextEncoder().encode(text),
    completeness: "complete",
    producer: null,
  };
}
function project(value: unknown, selection: FormatSelection = "auto") {
  return projectCapturedPayload(capture(value), selection);
}
function recognized(value: unknown, selection: FormatSelection = "auto") {
  const p = project(value, selection);
  expect(p.status).toBe("recognized");
  if (p.status !== "recognized") throw new Error(`Expected recognized: ${p.status}`);
  return p;
}
function unsupported(p: ProjectionResult, reason?: string) {
  expect(p.status).toBe("unsupported");
  if (p.status === "unsupported" && reason) expect(p.reason).toBe(reason);
}
const sdk = "claude.agent-sdk.message.v1",
  response = "openai.responses.object.v1",
  rollout = "codex.rollout-jsonl.7cdb219.v1";
describe("bounded Generic-first history formats", () => {
  it.each([messages, responses, chat, assistant, user, init, result, codex, codexMeta])(
    "recognizes qualified complete synthetic envelopes without model inference: %j",
    (value) => {
      const p = recognized(value);
      expect(p.recognition).toBe("validated-shape");
      expect(p.projection.warnings.join(" ")).toContain("producer/revision");
    },
  );
  it("has a closed precisely named registry and frozen source pins", () => {
    expect(FORMAT_ADAPTERS).toHaveLength(10);
    expect(Object.isFrozen(FORMAT_ADAPTERS)).toBe(true);
    for (const d of FORMAT_ADAPTERS) {
      expect(Object.isFrozen(d)).toBe(true);
      expect(Object.isFrozen(d.schemaPin)).toBe(true);
      expect(d.sources.every((s) => s.startsWith("https://"))).toBe(true);
    }
    expect(FORMAT_ADAPTERS.find((d) => d.id === sdk)?.schemaPin.revision).toBe("0.3.319");
  });
  it("Generic handles arbitrary binary/partial/oversized data without JSON parsing", () => {
    const c = {
      ...capture(null),
      bytes: new Uint8Array(FORMAT_LIMITS.maxBytes + 1).fill(255),
      completeness: "partial" as const,
    };
    const p = projectCapturedPayload(c, "generic");
    expect(p).toMatchObject({ status: "generic", document: null });
    expect(p.capture).toBe(c);
    expect(p.capture.bytes).toBe(c.bytes);
  });
  it.each([
    null,
    [],
    { temperature: 23.5 },
    { type: "assistant", message: messages },
    { type: "result", result: "done" },
    { type: "message_start", message: messages },
    { object: "chat.completion.chunk", ...{ choices: [] } },
    { ...assistant, type: "progress" },
  ])("keeps unqualified data Generic: %j", (value) => unsupported(project(value), "no-adapter"));
  it("rejects manual mismatches instead of promoting a vendor label", () => {
    unsupported(project(chat, response), "schema-mismatch");
    unsupported(
      project({ role: "assistant", content: [] }, "anthropic.messages.response.v1"),
      "schema-mismatch",
    );
  });
  it("does not certify raw Claude Code JSONL as SDK: missing SDK parent and required envelope", () => {
    const { parent_tool_use_id: removed, ...raw } = assistant;
    expect(removed).toBeNull();
    unsupported(
      project({ ...raw, timestamp: "source-time", requestId: "raw-log-field" }, sdk),
      "schema-mismatch",
    );
  });
  it("validates all candidates then preserves ambiguity; explicit choice still validates", () => {
    const hybrid = { ...responses, ...codex, payload: codex.payload };
    const auto = project(hybrid);
    expect(auto.status).toBe("ambiguous");
    if (auto.status === "ambiguous")
      expect(auto.candidates.map((d) => d.id)).toEqual([response, rollout]);
    expect(recognized(hybrid, response).adapter.id).toBe(response);
  });
  it("honors exact producer pins and rejects historical/future/mismatched claims", () => {
    const descriptor = FORMAT_ADAPTERS.find((d) => d.id === rollout);
    if (!descriptor) throw new Error("missing descriptor");
    const c = { ...capture(codex), producer: descriptor.schemaPin };
    expect(projectCapturedPayload(c)).toMatchObject({
      status: "recognized",
      recognition: "producer-pinned",
    });
    for (const producer of [
      { ...descriptor.schemaPin, revision: "future" },
      { ...descriptor.schemaPin, revision: "historical" },
      { name: "other", revision: descriptor.schemaPin.revision },
    ])
      unsupported(projectCapturedPayload({ ...c, producer }), "producer-mismatch");
  });
  it("retains original bytes, whitespace, number lexemes and opaque metadata by identity", () => {
    const text =
      " \n" +
      JSON.stringify({
        ...messages,
        usage: { input_tokens: 0, output_tokens: 4 },
        extra: { constructor: 1 },
      }).replace('"input_tokens":0', '"input_tokens":9007199254740993') +
      "\r\n";
    const c = source(text),
      p = projectCapturedPayload(c);
    expect(p.capture).toBe(c);
    expect(p.capture.bytes).toBe(c.bytes);
    expect(p.capture.metadata).toBe(c.metadata);
    expect(p.document?.ok && p.document.value.source).toBe(text);
    if (p.status !== "recognized") throw new Error("not recognized");
    expect(p.projection.metrics[0]).toMatchObject({
      lexeme: "9007199254740993",
      provenance: { captureId: c.captureId, path: ["usage", "input_tokens"] },
    });
  });
  it.each(['{"type":"message","type":"message"}', '"\\ud800"', "{}{}", "{", "\ufeff{}"])(
    "retains malformed source and refuses lossy/partial JSON: %s",
    (text) => {
      const c = source(text),
        p = projectCapturedPayload(c);
      unsupported(p, "invalid-json");
      expect(p.capture.bytes).toBe(c.bytes);
    },
  );
  it("bounds depth/nodes/bytes before projection and distinguishes partial/binary", () => {
    unsupported(
      projectCapturedPayload({ ...capture(messages), completeness: "partial" }),
      "partial",
    );
    unsupported(
      projectCapturedPayload({ ...capture(messages), bytes: new Uint8Array([255]) }),
      "invalid-json",
    );
    unsupported(
      projectCapturedPayload(source(" ".repeat(FORMAT_LIMITS.maxBytes + 1))),
      "byte-budget",
    );
    for (const text of [
      "[".repeat(65) + "0" + "]".repeat(65),
      "[" + "0,".repeat(FORMAT_LIMITS.maxNodes) + "0]",
    ])
      unsupported(projectCapturedPayload(source(text)), "parse-budget");
  });
  it("enforces bounded item arrays even with otherwise valid envelopes", () =>
    unsupported(
      project({
        ...messages,
        content: Array.from({ length: 257 }, () => ({ type: "text", text: "x" })),
      }),
      "no-adapter",
    ));
  it.each([-1, 1.5, "4", null])(
    "rejects malformed counts, never turns them into zero: %j",
    (count) =>
      unsupported(
        project({ ...messages, usage: { input_tokens: count, output_tokens: 0 } }),
        "no-adapter",
      ),
  );
  it("keeps explicit zero separate from missing values, and never infers cost/time/model from metadata", () => {
    const p = recognized({ ...messages, usage: { input_tokens: 0, output_tokens: 0 } });
    expect(p.projection.metrics.map((m) => m.lexeme)).toEqual(["0", "0"]);
    expect(p.projection.sourceTime).toBeNull();
    expect(p.projection.metrics.some((m) => m.name === "estimated_cost_usd")).toBe(false);
    const c = capture({ sensor: 4 }),
      unknown = projectCapturedPayload({
        ...c,
        metadata: {
          kind: "object",
          fields: [{ name: "vendor", value: { kind: "string", value: "OpenAI" } }],
        },
      });
    unsupported(unknown, "no-adapter");
  });
  it("keeps mixed events independent without whole-session detection", () => {
    const input = [
      messages,
      { sensor: 4 },
      chat,
      { type: "response.output_text.delta", delta: "part" },
      codex,
    ];
    expect(input.map((v) => project(v).status)).toEqual([
      "recognized",
      "unsupported",
      "recognized",
      "unsupported",
      "recognized",
    ]);
  });
});
describe("Messages and SDK projections", () => {
  it("keeps retained reasoning, opaque signatures/redactions, calls and unknown blocks distinct", () => {
    const p = recognized({
      ...messages,
      content: [
        { type: "thinking", thinking: "Explicit retained text.", signature: "opaque" },
        { type: "redacted_thinking", data: "opaque-redacted" },
        { type: "tool_use", id: "call-1", name: "synthetic", input: { large: "9007199254740993" } },
        { type: "future-block", text: "not promoted" },
      ],
    });
    expect(p.projection.items.map((i) => i.kind)).toEqual([
      "text",
      "opaque-reasoning",
      "opaque-reasoning",
      "tool-call",
      "unsupported",
    ]);
    const text = p.projection.items[0];
    expect(text?.kind === "text" && text.interpretation).toBe("retained-reasoning");
    expect(p.projection.items.filter((i) => i.kind === "text").map((i) => i.text)).toEqual([
      "Explicit retained text.",
    ]);
  });
  it("validates known blocks rather than swallowing malformed payloads", () => {
    for (const content of [
      [{ type: "text", text: 9 }],
      [{ type: "thinking", thinking: "x" }],
      [{ type: "tool_use", id: "c", name: "t", input: "{}" }],
    ])
      unsupported(project({ ...messages, content }), "no-adapter");
  });
  it("projects independently recorded tool results with exact correlation only", () => {
    const p = recognized({
      ...user,
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call-1", content: "result", is_error: true },
        ],
      },
    });
    expect(p.projection.items[0]).toMatchObject({
      kind: "tool-result",
      callId: "call-1",
      reportedError: true,
    });
    expect(p.projection.metrics).toEqual([]);
  });
  it("qualifies SDK result error arms and leaves errors as reported text", () => {
    const { result: removed, ...base } = result;
    expect(removed).toBeTruthy();
    for (const subtype of [
      "error_during_execution",
      "error_max_turns",
      "error_max_budget_usd",
      "error_max_structured_output_retries",
    ]) {
      const p = recognized({ ...base, subtype, is_error: true, errors: ["Synthetic failure."] });
      expect(p.projection.reportedStatus?.value).toBe(subtype);
    }
    unsupported(project({ ...base, subtype: "error_future", errors: [] }), "no-adapter");
  });
  it("keeps main-agent result usage distinct from cumulative query-pipeline cost", () => {
    const first = recognized(result),
      second = recognized({
        ...result,
        uuid: "00000000-0000-4000-8000-000000000005",
        num_turns: 5,
        total_cost_usd: 0.004,
        usage: { input_tokens: 40, output_tokens: 10 },
      });
    expect(first.projection.metrics.filter((m) => m.name === "input_tokens")).toHaveLength(1);
    expect(first.projection.metrics.find((m) => m.name === "input_tokens")?.snapshotKey).not.toBe(
      second.projection.metrics.find((m) => m.name === "input_tokens")?.snapshotKey,
    );
    const firstCost = first.projection.metrics.find((m) => m.name === "estimated_cost_usd"),
      secondCost = second.projection.metrics.find((m) => m.name === "estimated_cost_usd");
    expect(firstCost?.snapshotKey).toBeNull();
    expect(secondCost?.snapshotKey).toBeNull();
    expect(firstCost?.possibleOverlapKey).toBe(secondCost?.possibleOverlapKey);
    expect(firstCost?.scope).toMatchObject({
      kind: "sdk-query-pipeline",
      queryId: null,
      reportedByResultId: result.uuid,
    });
    expect(second.projection.metrics.find((m) => m.name === "input_tokens")?.lexeme).toBe("40");
    expect(second.projection.warnings.join(" ")).toContain("not project completion");
  });
  it("retains estimated decimal cost exactly, without currency arithmetic", () => {
    const raw = JSON.stringify(result).replace(
      '"total_cost_usd":0.001',
      '"total_cost_usd":0.0000000000000001234500',
    );
    const p = projectCapturedPayload(source(raw), sdk);
    if (p.status !== "recognized") throw new Error("not recognized");
    expect(p.projection.metrics.find((m) => m.name === "estimated_cost_usd")).toMatchObject({
      lexeme: "0.0000000000000001234500",
      unit: "USD",
      scope: { kind: "sdk-query-pipeline", sessionId: "synthetic-session", queryId: null },
    });
  });
  it("rejects malformed system, result and nested Messages known fields", () => {
    for (const value of [
      { ...init, tools: [3] },
      { ...init, permissionMode: "future" },
      { ...result, permission_denials: [{ tool_name: "t", tool_use_id: "c", tool_input: null }] },
      { ...result, modelUsage: { model: {} } },
      { ...assistant, parent_tool_use_id: 4 },
      { ...assistant, message: { ...messages, usage: {} } },
    ])
      unsupported(project(value, sdk), "schema-mismatch");
  });
});
describe("OpenAI complete objects/events", () => {
  it("keeps response message phases, refusal, reasoning summaries and ciphertext distinct", () => {
    const p = recognized({
      ...responses,
      output: [
        {
          ...responses.output[0],
          phase: "commentary",
          content: [{ type: "refusal", refusal: "Synthetic refusal." }],
        },
        {
          type: "reasoning",
          id: "r-1",
          summary: [{ type: "summary_text", text: "Explicit summary." }],
          encrypted_content: "ciphertext",
        },
        { type: "future-output", payload: "raw" },
      ],
    });
    expect(p.projection.items.map((i) => i.kind)).toEqual([
      "text",
      "text",
      "opaque-reasoning",
      "unsupported",
    ]);
    expect(
      p.projection.items.filter((i) => i.kind === "text").map((i) => i.interpretation),
    ).toEqual(["refusal", "summary"]);
  });
  it("does not parse tool arguments or pair outputs with missing call IDs", () => {
    const p = recognized({
      ...responses,
      output: [
        {
          type: "function_call",
          call_id: "call-1",
          name: "synthetic",
          arguments: '{"large":9007199254740993}',
        },
        {
          type: "function_call_output",
          id: "output-1",
          status: "completed",
          output: "Result without call ID.",
        },
      ],
    });
    expect(p.projection.items[0]).toMatchObject({
      kind: "tool-call",
      arguments: { kind: "string", value: '{"large":9007199254740993}' },
    });
    expect(p.projection.items[1]).toMatchObject({
      kind: "tool-result",
      callId: null,
      reportedError: null,
    });
  });
  it("keeps token breakdowns separate from total and source time separate from event time", () => {
    const p = recognized(responses);
    expect(p.projection.metrics.find((m) => m.name === "reasoning_tokens")).toMatchObject({
      lexeme: "2",
      basis: "breakdown",
    });
    expect(p.projection.metrics.find((m) => m.name === "total_tokens")?.lexeme).toBe("16");
    expect(p.projection.sourceTime).toMatchObject({
      value: { format: "unix-seconds", exact: "1780000000.125" },
      provenance: { path: ["created_at"] },
    });
  });
  it.each(["response.created", "response.completed", "response.failed", "response.incomplete"])(
    "validates individual %s snapshots without summing",
    (type) => {
      const object = recognized(responses),
        event = recognized({ type, sequence_number: 9, response: responses });
      expect(event.adapter.id).toBe("openai.responses.event.v1");
      expect(event.projection.sourceSequence?.value).toBe("9");
      expect(event.projection.metrics[0]?.snapshotKey).toBe(
        object.projection.metrics[0]?.snapshotKey,
      );
      expect(event.projection.metrics[0]?.provenance.path).toEqual([
        "response",
        "usage",
        "input_tokens",
      ]);
    },
  );
  it("validates output_item.done without inventing a parent response ID", () => {
    const p = recognized({
      type: "response.output_item.done",
      sequence_number: 4,
      output_index: 0,
      item: responses.output[0],
    });
    expect(p.projection.identity).toBeNull();
    expect(p.projection.metrics).toEqual([]);
    unsupported(
      project({ type: "response.output_item.done", sequence_number: 4, item: responses.output[0] }),
      "no-adapter",
    );
  });
  it("rejects known malformed fields and incomplete stream shapes", () => {
    for (const value of [
      { ...responses, parallel_tool_calls: "true" },
      { ...responses, status: "future" },
      {
        ...responses,
        output: [
          {
            type: "message",
            id: "m",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "x" }],
          },
        ],
      },
      { type: "response.completed", sequence_number: -1, response: responses },
      { type: "response.output_text.delta", sequence_number: 1, delta: "text" },
      { ...responses, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
    ])
      unsupported(project(value), "no-adapter");
  });
  it("accepts absent usage without manufacturing zeros", () => {
    const { usage: removed, ...value } = responses;
    expect(removed).toBeTruthy();
    expect(recognized(value).projection.metrics).toEqual([]);
  });
  it("retains multiple Chat choices, refusals and tools without a global final answer", () => {
    const p = recognized({
      ...chat,
      choices: [
        ...chat.choices,
        {
          index: 1,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            refusal: "Synthetic refusal.",
            tool_calls: [
              { id: "c", type: "function", function: { name: "synthetic", arguments: "not JSON" } },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
        completion_tokens_details: { reasoning_tokens: 1 },
      },
    });
    expect(p.projection.items.map((i) => i.kind)).toEqual(["text", "text", "tool-call"]);
    expect(p.projection.items[1]?.provenance.path).toEqual(["choices", "1", "message", "refusal"]);
    expect(p.projection.reportedStatus).toBeNull();
    expect(p.projection.metrics.find((m) => m.name === "reasoning_tokens")?.basis).toBe(
      "breakdown",
    );
  });
  it("rejects a Chat chunk and malformed choice/tool fields", () => {
    for (const value of [
      { ...chat, object: "chat.completion.chunk" },
      { ...chat, choices: [{ ...chat.choices[0], index: -1 }] },
      {
        ...chat,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "user", content: "x" } }],
      },
      {
        ...chat,
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              tool_calls: [{ type: "function", id: "c", function: { name: "n", arguments: {} } }],
            },
          },
        ],
      },
    ])
      unsupported(project(value), "no-adapter");
  });
});
describe("pinned Codex rollout projection", () => {
  it("keeps phase, source string and u64 ordinal distinct from capture sequence", () => {
    const p = recognized(codex);
    expect(p.projection.items[0]).toMatchObject({ kind: "text", phase: "final_answer" });
    expect(p.projection.sourceTime?.value).toEqual({
      format: "source-string",
      exact: "synthetic-source-time",
    });
    expect(p.projection.sourceSequence?.value).toBe("7");
    expect(p.projection.metrics).toEqual([]);
  });
  it("retains arbitrary nested decimal source without lossy numeric conversion", () => {
    const raw = JSON.stringify({
      ...codex,
      payload: {
        type: "function_call",
        name: "synthetic",
        call_id: "call-1",
        arguments: "source string",
        extra: 0,
      },
    }).replace('"extra":0', '"extra":0.123456789012345678901234567890');
    const p = projectCapturedPayload(source(raw), rollout);
    expect(p.status).toBe("recognized");
    if (p.status !== "recognized" || !p.document?.ok) throw new Error("not recognized");
    expect(
      jsonField(jsonField(p.document.value.value, "payload") ?? { kind: "null" }, "extra"),
    ).toEqual({ kind: "number", lexeme: "0.123456789012345678901234567890" });
  });
  it("projects compacted summary without reconstructing discarded context", () => {
    const p = recognized({
      ...codex,
      type: "compacted",
      payload: { message: "Only retained summary." },
    });
    expect(p.projection.items.map((i) => i.kind)).toEqual(["text", "marker"]);
    expect(p.projection.items[0]).toMatchObject({ interpretation: "summary" });
    expect(p.projection.reportedStatus).toBeNull();
  });
  it("projects only explicit reasoning and preserves ciphertext", () => {
    const p = recognized({
      ...codex,
      payload: { type: "reasoning", summary: [], encrypted_content: "opaque" },
    });
    expect(p.projection.items).toHaveLength(1);
    expect(p.projection.items[0]).toMatchObject({
      kind: "opaque-reasoning",
      retention: "encrypted",
    });
  });
  it("does not infer tool errors or create missing call identity", () => {
    const p = recognized({
      ...codex,
      payload: { type: "function_call_output", output: "Error is just source text." },
    });
    expect(p.projection.items[0]).toMatchObject({
      kind: "tool-result",
      callId: null,
      reportedError: null,
    });
  });
  it("allows an agent message and a token-record marker without inventing usage", () => {
    const p = recognized({
      ...codex,
      type: "event_msg",
      payload: { type: "agent_message", message: "Explicit text.", phase: "commentary" },
    });
    expect(p.projection.items[0]).toMatchObject({ kind: "text", phase: "commentary" });
    const unknown = recognized({
      ...codex,
      type: "event_msg",
      payload: { type: "token_count", info: { total_tokens: 100 } },
    });
    expect(unknown.projection.items[0]?.kind).toBe("marker");
    expect(unknown.projection.metrics).toEqual([]);
  });
  it("rejects missing pinned wrapper fields, ordinal overflow and unqualified variants", () => {
    for (const value of [
      { ...codex, timestamp: null },
      { ...codex, ordinal: -1 },
      { ...codex, type: "future_rollout" },
      {
        ...codexMeta,
        payload: {
          id: null,
          timestamp: "source",
          cwd: "/synthetic",
          originator: "synthetic",
          cli_version: "synthetic",
        },
      },
      { ...codex, payload: { type: "message", role: "assistant", phase: "future", content: [] } },
    ])
      unsupported(project(value, rollout), "schema-mismatch");
    unsupported(
      projectCapturedPayload(
        source(JSON.stringify(codex).replace('"ordinal":7', '"ordinal":18446744073709551616')),
        rollout,
      ),
      "schema-mismatch",
    );
  });
});

describe("snapshot identity and precise provenance", () => {
  function metricKey(c: CapturedPayload): string {
    const projected = projectCapturedPayload(c);
    if (projected.status !== "recognized") throw new Error("Expected qualified metric fixture");
    const metric = projected.projection.metrics[0];
    if (!metric) throw new Error("Expected metric");
    if (metric.snapshotKey === null) throw new Error("Expected exact API snapshot identity");
    return metric.snapshotKey;
  }
  it("shares overlapping response snapshots across object/events and changing event capture IDs", () => {
    const c = capture(responses),
      event = {
        ...capture({ type: "response.completed", sequence_number: 10, response: responses }),
        captureId: "synthetic-capture:event-99",
      };
    expect(metricKey(c)).toBe(metricKey(event));
  });
  it.each([0, 1, 2, 3])("keeps distinct source-scope dimension %i separate", (index) => {
    const c = capture(responses),
      scope: [string, string, string, string] = [...c.scopeId];
    scope[index] = "another-source";
    expect(metricKey({ ...c, scopeId: scope })).not.toBe(metricKey(c));
  });
  it("uses unambiguous tuple encoding even for hostile separator-containing identities", () => {
    const a = { ...capture(responses), scopeId: ["a:b", "c", "workspace", "collection"] as const },
      b = { ...capture(responses), scopeId: ["a", "b:c", "workspace", "collection"] as const };
    expect(metricKey(a)).not.toBe(metricKey(b));
    expect(metricKey({ ...a, scopeId: ['["a","b"]', '"\\\n', "w:[]", "s"] })).not.toBe(
      metricKey({ ...a, scopeId: ["a", 'b],["c', "w:[]", "s"] }),
    );
  });
  it("names reported coverage and does not imply complete captured-session totals", () => {
    const api = recognized(responses),
      sdkReport = recognized(result);
    expect(api.projection.metrics.every((m) => m.coverage === "reported-response")).toBe(true);
    expect(sdkReport.projection.metrics.find((m) => m.name === "input_tokens")?.coverage).toBe(
      "reported-main-agent-only-usage-per-turn-in-streaming",
    );
    expect(
      sdkReport.projection.metrics.find((m) => m.name === "estimated_cost_usd")?.coverage,
    ).toBe("reported-query-pipeline-cumulative-query-boundary-unknown");
  });
  it("preserves exact u64 maximum without narrowing to Number", () => {
    const c = source(
        JSON.stringify(codex).replace('"ordinal":7', '"ordinal":18446744073709551615'),
      ),
      p = projectCapturedPayload(c);
    if (p.status !== "recognized") throw new Error("not recognized");
    expect(p.projection.sourceSequence?.value).toBe("18446744073709551615");
  });
  it("retains source subtrees and reports exact field paths rather than reconstructed source", () => {
    const p = recognized({
      ...messages,
      content: [{ type: "text", text: "Explicit text.", future_field: { opaque: true } }],
    });
    if (!p.document?.ok) throw new Error("missing document");
    const blocks = jsonField(p.document.value.value, "content");
    expect(blocks?.kind === "array" && p.projection.items[0]?.raw).toBe(
      blocks?.kind === "array" ? blocks.items[0] : null,
    );
    expect(p.projection.items[0]?.provenance.path).toEqual(["content", "0"]);
  });
  it("does not swallow unexpected caller failures as schema mismatch", () => {
    const failure = new Error("unexpected caller failure"),
      base = capture(messages);
    const c = {
      ...base,
      get bytes(): Uint8Array {
        throw failure;
      },
    };
    expect(() => projectCapturedPayload(c)).toThrow(failure);
  });
  it("reports a precise known-field validation path for explicit mismatch", () => {
    const p = project(
      { ...responses, usage: { ...responses.usage, output_tokens: "not a count" } },
      response,
    );
    expect(p.status).toBe("unsupported");
    if (p.status === "unsupported")
      expect(p.issues).toContainEqual({
        adapter: response,
        path: ["usage", "output_tokens"],
        expected: "nonnegative integer JSON number",
      });
  });
  it("requires wrapper identity for the supported SDK user subset, without certifying every SDK request", () => {
    const { uuid: uuidRemoved, session_id: sessionRemoved, ...request } = user;
    expect(uuidRemoved).toBeTruthy();
    expect(sessionRemoved).toBeTruthy();
    unsupported(project(request, sdk), "schema-mismatch");
  });
  it("does not reconstruct signature-only thinking or invent absent timestamps", () => {
    const p = recognized({
      ...messages,
      content: [{ type: "thinking", thinking: "", signature: "retained-signature-only" }],
    });
    expect(p.projection.items.filter((i) => i.kind === "text").every((i) => i.text === "")).toBe(
      true,
    );
    expect(p.projection.items[1]).toMatchObject({
      kind: "opaque-reasoning",
      retention: "signature",
    });
    expect(p.projection.sourceTime).toBeNull();
  });
});

it("retains resumed/reset SDK reports without inferring deltas or summing snapshots", () => {
  const resumed = recognized({
      ...result,
      resume_reason: "synthetic-resume",
      num_turns: 9,
      usage: { input_tokens: 120, output_tokens: 40 },
    }),
    reset = recognized({
      ...result,
      resume_reason: "synthetic-reset",
      num_turns: 1,
      usage: { input_tokens: 3, output_tokens: 1 },
    });
  expect(resumed.projection.metrics.find((m) => m.name === "input_tokens")?.lexeme).toBe("120");
  expect(reset.projection.metrics.find((m) => m.name === "input_tokens")?.lexeme).toBe("3");
  expect(reset.projection.metrics[0]?.snapshotKey).toBe(resumed.projection.metrics[0]?.snapshotKey);
  expect(reset.document?.ok && jsonField(reset.document.value.value, "resume_reason")).toEqual({
    kind: "string",
    value: "synthetic-reset",
  });
});

it("does not interpret unknown timestamp extras on SDK result/init, and labels reported results", () => {
  const p = recognized({ ...result, timestamp: { unknown: "field" } });
  expect(p.projection.sourceTime).toBeNull();
  expect(p.projection.items[0]).toMatchObject({ kind: "text", interpretation: "reported-result" });
  expect(recognized({ ...init, timestamp: "unknown-extra" }).projection.sourceTime).toBeNull();
  expect(
    recognized({ ...assistant, timestamp: "explicit-source-time" }).projection.sourceTime?.value,
  ).toEqual({ format: "source-string", exact: "explicit-source-time" });
});

it("preserves SDK is_error even on success and marks API error text without project/process claims", () => {
  const p = recognized({ ...result, is_error: true, result: "Explicit API error report." });
  expect(p.projection.reportedStatus?.value).toBe("success");
  expect(p.projection.reportedError).toMatchObject({
    value: true,
    provenance: { path: ["is_error"] },
  });
  expect(p.projection.items[0]).toMatchObject({
    kind: "text",
    interpretation: "reported-error",
    text: "Explicit API error report.",
  });
  expect(recognized(result).projection.reportedError?.value).toBe(false);
  expect(recognized(messages).projection.reportedError).toBeNull();
});
it("reports SDK model round-trips within one result rather than inventing user-turn counts", () => {
  const p = recognized(result),
    metric = p.projection.metrics.find((m) => m.name === "model_round_trips");
  expect(metric).toMatchObject({
    lexeme: "2",
    unit: "model-round-trips",
    basis: "report",
    scope: { kind: "sdk-result", sessionId: result.session_id, resultId: result.uuid },
    coverage: "reported-result-model-round-trips",
    provenance: { path: ["num_turns"] },
  });
  for (const name of ["duration_ms", "api_duration_ms"]) {
    expect(p.projection.metrics.find((m) => m.name === name)).toMatchObject({
      basis: "report",
      scope: { kind: "sdk-result", resultId: result.uuid },
      coverage: "reported-result-duration-extent-not-inferred",
    });
  }
});
it("keeps repeated exact SDK result IDs overlapping but does not invent query boundaries across sessions", () => {
  const a = recognized(result),
    duplicate = recognized(result),
    otherSession = recognized({ ...result, session_id: "another-source-session" });
  const usage = (p: typeof a) => p.projection.metrics.find((m) => m.name === "input_tokens"),
    cost = (p: typeof a) => p.projection.metrics.find((m) => m.name === "estimated_cost_usd");
  expect(usage(a)?.snapshotKey).toBe(usage(duplicate)?.snapshotKey);
  expect(usage(a)?.snapshotKey).not.toBe(usage(otherSession)?.snapshotKey);
  expect(cost(a)?.possibleOverlapKey).not.toBe(cost(otherSession)?.possibleOverlapKey);
  expect(cost(a)?.scope).toMatchObject({ kind: "sdk-query-pipeline", queryId: null });
});
