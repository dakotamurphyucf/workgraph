import { describe, expect, it } from "vitest";
import { parseJsonText, type JsonValue } from "../../../src/core/json";
import type { ProjectedItem } from "../../../src/features/history/formats";
import {
  outputDocuments,
  toolInputParts,
} from "../../../src/features/history/transcript/tool-display";
import { prettyJson } from "../../../src/features/history/transcript/pretty-json";
function value(input: unknown): JsonValue {
  const parsed = parseJsonText(JSON.stringify(input));
  if (!parsed.ok) throw new Error("fixture");
  return parsed.value.value;
}
function call(
  name: string,
  input: unknown,
  codex = true,
): Extract<ProjectedItem, { kind: "tool-call" }> {
  return {
    kind: "tool-call",
    name,
    arguments: value(input),
    callId: "call",
    raw: value(input),
    provenance: {
      captureId: "fixture",
      adapter: codex ? "codex.rollout-jsonl.7cdb219.v1" : "claude.code.transcript.v1",
      schemaPin: { name: "fixture", revision: "1" },
      path: [],
    },
  };
}
describe("tool display without changing retained input", () => {
  it("highlights Codex exec JavaScript without treating it as JSON or executing it", () => {
    const item = call("exec", 'const x = await tools.exec_command({cmd:"pwd"}); text(x);');
    expect(toolInputParts(item)[0]?.hints.language).toBe("javascript");
    expect(
      toolInputParts(call("exec", "not a known JS tool", false))[0]?.hints.language,
    ).toBeUndefined();
  });
  it("decodes function argument JSON for known shell tools and keeps the source string", () => {
    const input = '{"cmd":"printf hello","workdir":"/repo"}';
    const item = call("exec_command", input);
    expect(toolInputParts(item)).toEqual([
      { label: "Command", text: "printf hello", hints: { language: "bash" } },
    ]);
    expect(item.arguments).toEqual({ kind: "string", value: input });
    expect(toolInputParts(call("Bash", { command: "pwd" }, false))[0]?.hints.language).toBe("bash");
  });
  it("shows both sides of Claude Edit and file hints for Write", () => {
    expect(
      toolInputParts(
        call("Edit", { old_string: "before", new_string: "after", file_path: "app.ts" }, false),
      ).map((p) => [p.label, p.text]),
    ).toEqual([
      ["Before", "before"],
      ["After", "after"],
    ]);
    expect(
      toolInputParts(call("Write", { content: "export {};", file_path: "app.ts" }, false))[0]?.hints
        .filename,
    ).toBe("app.ts");
  });
  it("unpacks concatenated structured outputs with quoted braces and exact integers", () => {
    const input = '{"output":"brace }","n":9007199254740993123}{"output":"two"}';
    const parts = outputDocuments(input);
    expect(parts).toHaveLength(2);
    expect(prettyJson(parts![0]!)).toContain("9007199254740993123");
    expect(outputDocuments('{"n":1}{"n":2')).toBeNull();
    expect(outputDocuments('{"n":1} explanatory text')).toBeNull();
    expect(outputDocuments('{"n":1,"n":2}')).toBeNull();
  });
});
