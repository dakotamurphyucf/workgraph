import { describe, it, expect } from "vitest";
import { parseJsonText } from "../../../src/core/json";
import { prettyJson } from "../../../src/features/history/transcript/pretty-json";
describe("formatted history JSON", () => {
  it("indents nested fields without coercing numeric lexemes or escaped message contents", () => {
    const source = '{"n":9007199254740993,"items":[{"text":"line\\ntext"}],"exp":1e+30}';
    const parsed = parseJsonText(source);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const formatted = prettyJson(parsed.value.value);
    expect(formatted).toContain('\n  "n": 9007199254740993,');
    expect(formatted).toContain('\n    {\n      "text": "line\\ntext"');
    expect(formatted).toContain('"exp": 1e+30');
    expect(parsed.value.source).toBe(source);
  });
});
