import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { jsonField, parseJsonText, type JsonValue } from "../../src/core/json";
import * as d from "../../src/core/protocol/decoders";
import { projectSummary, workspaceSummary } from "../../src/features/overview/codecs";
import { progressPercent } from "../../src/features/overview/dashboard-model";
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/native-probe.json", import.meta.url), "utf8"),
) as { reads: { method: string; raw: string }[] };
function sample(method: string): JsonValue {
  const source = fixture.reads.find((r) => r.method === method);
  if (source === undefined) throw new Error("native sample absent");
  const parsed = parseJsonText(source.raw);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const value = jsonField(jsonField(parsed.value.value, "result")!, "data");
  if (value === undefined) throw new Error("native data absent");
  return value;
}
function replace(value: JsonValue, key: string, next: JsonValue): JsonValue {
  if (value.kind !== "object") throw new Error("object required");
  return d.jsonObject(value.fields.map((f) => [f.name, f.name === key ? next : f.value]));
}
const decimal = (s: string) => {
  const result = d.decimal.decode(d.jsonString(s));
  if (!result.ok) throw new Error("decimal required");
  return result.value;
};
describe("Overview's native metric meanings", () => {
  it("uses complete page totals, not the visible ready/in-progress subset", () => {
    const value = sample("project.brief"),
      ready = jsonField(value, "ready_work")!;
    const modified = replace(
      value,
      "ready_work",
      replace(
        replace(ready, "remaining", d.jsonString("9007199254740993")),
        "next_offset",
        d.jsonString("1"),
      ),
    );
    const result = projectSummary.decode(modified);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ready?.items).toHaveLength(1);
    expect(result.value.metrics.find((m) => m.kind === "ready")?.value).toBe("9007199254740994");
    expect(result.value.progress?.total).toBe("3");
    expect(result.value.metrics.find((m) => m.kind === "done")?.denominator).toBe("3");
  });
  it("does not call all project-linked request statuses unanswered questions", () => {
    const result = projectSummary.decode(sample("project.brief"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.metrics.some((m) => m.kind === "question")).toBe(false);
    expect(result.value.description).toBe("Isolated UI test data; never a user workspace.");
  });
  it("distinguishes claimed workspace tickets from in-progress status and does not invent project progress", () => {
    const result = workspaceSummary.decode(sample("workspace.overview"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.metrics.find((m) => m.kind === "claimed")?.label).toBe("Claimed");
    expect(result.value.metrics.find((m) => m.kind === "working")?.label).toBe("In progress");
    expect(result.value.metrics.find((m) => m.kind === "done")?.denominator).toBeNull();
    expect(result.value.progress).toBeNull();
    expect(result.value.projects?.items[0]?.description).toBe(
      "Isolated UI test data; never a user workspace.",
    );
  });
  it("keeps largest supported native counters exact and bounds only the display ratio", () => {
    const total = decimal("4611686018427387903"),
      done = decimal("3074457345618258602");
    expect(progressPercent({ total, done, blocked: decimal("0") })).toBe(66.66);
    expect(progressPercent({ total, done: total, blocked: decimal("0") })).toBe(100);
    expect(
      progressPercent({ total: decimal("0"), done: decimal("0"), blocked: decimal("0") }),
    ).toBe(0);
  });
  it("rejects contradictory native progress rather than drawing a fabricated bar", () => {
    const result = projectSummary.decode(
      replace(
        sample("project.brief"),
        "progress",
        d.jsonObject([
          ["done", d.jsonString("4")],
          ["total", d.jsonString("3")],
          ["blocked", d.jsonString("0")],
        ]),
      ),
    );
    expect(result.ok).toBe(false);
  });
});
