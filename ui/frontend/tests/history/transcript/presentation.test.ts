import { describe, expect, it } from "vitest";
import { projectCapturedPayload } from "../../../src/features/history/formats";
import type { ProjectionResult } from "../../../src/features/history/formats";
import { eventRecord } from "../../../src/features/history/transcript/codecs";
import { parseJsonText } from "../../../src/core/json";
import { partKey } from "../../../src/features/history/transcript/controller";
import {
  reportedDuplicates,
  toolPairs,
  conversationToolPairs,
} from "../../../src/features/history/transcript/presentation";
import { assistant, result, user } from "../formats/fixtures";
function event(
  sequence: number,
  correlation: string | null = "turn-a",
  runId: string | null = null,
) {
  const json = parseJsonText(
    JSON.stringify({
      event_ref: { session_id: "synthetic", sequence: String(sequence) },
      identity_hash: "a".repeat(64),
      actor_id: "observer",
      run_id: runId,
      event: {
        client_id: `source-${sequence}`,
        role: "arbitrary",
        kind: "arbitrary",
        phase: "arbitrary",
        correlation,
        provenance: null,
        payload: { kind: "blob", blob: { digest: "b".repeat(64), size_bytes: "0" } },
        searchable_text: null,
        resource_versions: [],
        attachments: [],
      },
    }),
  );
  if (!json.ok) throw new Error("fixture");
  const decoded = eventRecord.decode(json.value.value);
  if (!decoded.ok) throw new Error(decoded.issue.expected);
  return decoded.value;
}
function projected(sequence: number, payload: unknown): ProjectionResult {
  return projectCapturedPayload(
    {
      captureId: `head/synthetic/${sequence}`,
      scopeId: ["local", "1", "demo", "synthetic"],
      metadata: { kind: "null" },
      bytes: new TextEncoder().encode(JSON.stringify(payload)),
      completeness: "complete",
      producer: null,
    },
    "auto",
  );
}
const call = {
    ...assistant,
    message: {
      ...assistant.message,
      content: [{ type: "tool_use", id: "call-1", name: "synthetic", input: {} }],
    },
  },
  output = {
    ...user,
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call-1", content: "retained output", is_error: false },
      ],
    },
  };
describe("reversible source projections", () => {
  it("pairs only one exact source call/result with explicit matching correlation", () => {
    const events = [event(1), event(2)],
      projections = new Map(
        events.map((item, index) => [
          partKey(item.event_ref, { kind: "payload" }),
          projected(index + 1, index === 0 ? call : output),
        ]),
      );
    expect(toolPairs(events, projections)).toHaveLength(1);
    const otherSource = new Map(projections);
    otherSource.set(
      partKey(events[1]!.event_ref, { kind: "payload" }),
      projected(2, { ...output, session_id: "other-sdk-session" }),
    );
    expect(toolPairs(events, otherSource)).toHaveLength(0);
    expect(toolPairs([event(1, null), events[1]!], projections)).toHaveLength(0);
    expect(toolPairs([event(1, "other"), events[1]!], projections)).toHaveLength(0);
    const duplicate = event(3);
    projections.set(partKey(duplicate.event_ref, { kind: "payload" }), projected(3, output));
    expect(toolPairs([...events, duplicate], projections)).toHaveLength(0);
  });
  it("deduplicates exact reported text only within the qualified SDK source session and retains source references", () => {
    const events = [event(1), event(2)],
      message = {
        ...assistant,
        message: { ...assistant.message, content: [{ type: "text", text: "Exact final text" }] },
      },
      final = { ...result, result: "Exact final text" };
    const projections = new Map([
      [partKey(events[0]!.event_ref, { kind: "payload" }), projected(1, message)],
      [partKey(events[1]!.event_ref, { kind: "payload" }), projected(2, final)],
    ]);
    expect([...reportedDuplicates(events, projections).get("2")!.values()]).toEqual(["1"]);
    projections.set(
      partKey(events[1]!.event_ref, { kind: "payload" }),
      projected(2, { ...final, session_id: "different-source-session" }),
    );
    expect(reportedDuplicates(events, projections).size).toBe(0);
    projections.set(
      partKey(events[1]!.event_ref, { kind: "payload" }),
      projected(2, { ...final, result: "Exact final text " }),
    );
    expect(reportedDuplicates(events, projections).size).toBe(0);
  });
});

describe("conversation tool grouping", () => {
  it("pairs unique source IDs without importer correlation, rejects ambiguous or foreign sources", () => {
    const events = [event(1, null), event(2, null)];
    const projections = new Map(
      events.map((e, i) => [
        partKey(e.event_ref, { kind: "payload" }),
        projected(i + 1, i === 0 ? call : output),
      ]),
    );
    expect(conversationToolPairs(events, projections)).toHaveLength(1);
    projections.set(
      partKey(events[1]!.event_ref, { kind: "payload" }),
      projected(2, { ...output, session_id: "different" }),
    );
    expect(conversationToolPairs(events, projections)).toHaveLength(0);
    projections.set(partKey(events[1]!.event_ref, { kind: "payload" }), projected(2, output));
    projections.set(partKey(event(3).event_ref, { kind: "payload" }), projected(3, output));
    expect(conversationToolPairs([...events, event(3)], projections)).toHaveLength(0);
    expect(
      conversationToolPairs(
        [event(2), event(1)],
        new Map([
          [partKey(event(2).event_ref, { kind: "payload" }), projected(2, call)],
          [partKey(event(1).event_ref, { kind: "payload" }), projected(1, output)],
        ]),
      ),
    ).toHaveLength(0);
  });
  it("respects contradictory correlation and run identities", () => {
    const events = [event(1, "one"), event(2, "two")];
    const projections = new Map(
      events.map((e, i) => [
        partKey(e.event_ref, { kind: "payload" }),
        projected(i + 1, i === 0 ? call : output),
      ]),
    );
    expect(conversationToolPairs(events, projections)).toHaveLength(0);
    expect(
      conversationToolPairs(
        [event(1, "turn-a", "run-a"), event(2, "turn-a", "run-b")],
        projections,
      ),
    ).toHaveLength(0);
  });
});

it("does not combine OpenAI and Anthropic tool IDs in the generic conversation adapter", () => {
  const events = [event(1, null), event(2, null)];
  const projections = new Map([
    [
      partKey(events[0]!.event_ref, { kind: "payload" }),
      projected(1, { type: "function_call", call_id: "same-id", name: "lookup", arguments: "{}" }),
    ],
    [
      partKey(events[1]!.event_ref, { kind: "payload" }),
      projected(2, {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "same-id", content: "different protocol" }],
      }),
    ],
  ]);
  for (const result of projections.values()) expect(result.status).toBe("recognized");
  expect(conversationToolPairs(events, projections)).toHaveLength(0);
  projections.set(
    partKey(events[1]!.event_ref, { kind: "payload" }),
    projected(2, { type: "function_call_output", call_id: "same-id", output: "matching protocol" }),
  );
  expect(conversationToolPairs(events, projections)).toHaveLength(1);
});
