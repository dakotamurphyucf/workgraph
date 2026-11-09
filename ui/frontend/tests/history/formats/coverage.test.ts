import { describe, expect, it } from "vitest";
import { formatCoverage } from "../../../src/features/history/formats/coverage";
import type { FormatCoverageEntry } from "../../../src/features/history/formats/coverage.types";
import {
  FORMAT_ADAPTERS,
  projectCapturedPayload,
  type CapturedPayload,
} from "../../../src/features/history/formats";
import { codex, messages, responses } from "./fixtures";
const capture = (value: unknown): CapturedPayload => ({
  captureId: "current-capture:event-1",
  scopeId: ["connection", "1", "workspace", "session"],
  metadata: { kind: "object", fields: [] },
  bytes: new TextEncoder().encode(JSON.stringify(value)),
  completeness: "complete",
  producer: null,
});
const loaded = (value: unknown): FormatCoverageEntry => ({
  payload: "complete",
  projection: projectCapturedPayload(capture(value)),
});
describe("captured-window format coverage", () => {
  it("distinguishes uninspected, pending, partial and unsupported instead of treating them as absent or session totals", () => {
    const partial = { ...capture(messages), completeness: "partial" as const };
    const entries: readonly FormatCoverageEntry[] = [
      loaded(messages),
      loaded({ sensor: 4 }),
      { payload: "unloaded", projection: projectCapturedPayload(capture(responses)) },
      { payload: "complete", projection: null },
      { payload: "partial", projection: projectCapturedPayload(partial) },
    ];
    const before = entries.map((entry) => entry.projection?.capture.bytes.slice());
    const result = formatCoverage(entries);
    expect(result).toMatchObject({
      windowEvents: 5,
      loaded: 4,
      matched: 1,
      unsupported: 2,
      partial: 1,
      pending: 1,
      unloaded: 1,
      explicitGeneric: 0,
      ambiguous: 0,
    });
    expect(result.matches.map((match) => match.adapter.id)).toEqual([
      "anthropic.messages.response.v1",
    ]);
    expect(result.fallbacks).toEqual([
      { reason: "no-adapter", count: 1 },
      { reason: "partial", count: 1 },
    ]);
    for (const [i, entry] of entries.entries())
      expect(entry.projection?.capture.bytes).toEqual(before[i]);
    // This earlier loaded projection was evicted, so it cannot inflate current recognition.
    expect(result.matches.some((match) => match.adapter.id === "openai.responses.object.v1")).toBe(
      false,
    );
  });
  it("keeps explicit Generic and ambiguous shapes separate from failed validation", () => {
    const ambiguous = loaded({ ...responses, ...codex, payload: codex.payload });
    expect(ambiguous.projection?.status).toBe("ambiguous");
    const result = formatCoverage([
      ambiguous,
      { payload: "complete", projection: projectCapturedPayload(capture(messages), "generic") },
      {
        payload: "complete",
        projection: projectCapturedPayload(capture(messages), "openai.responses.object.v1"),
      },
    ]);
    expect(result).toMatchObject({ matched: 0, explicitGeneric: 1, ambiguous: 1, unsupported: 1 });
    expect(result.fallbacks).toEqual([{ reason: "schema-mismatch", count: 1 }]);
  });
  it("labels actual producer pins independently of shape-only recognition without inventing confidence", () => {
    const schema = FORMAT_ADAPTERS.find((entry) => entry.id === "anthropic.messages.response.v1")!;
    const pinned = { ...capture(messages), producer: schema.schemaPin };
    const result = formatCoverage([
      loaded(messages),
      { payload: "complete", projection: projectCapturedPayload(pinned) },
    ]);
    expect(result.matches).toMatchObject([{ count: 2, shapeOnly: 1, producerPinned: 1 }]);
    expect(Object.keys(result)).not.toContain("confidence");
  });
  it("counts only the supplied window and every event has exactly one projection disposition", () => {
    const entries: FormatCoverageEntry[] = [
      loaded(messages),
      loaded(responses),
      loaded(null),
      { payload: "complete", projection: null },
      { payload: "unloaded", projection: null },
    ];
    for (let length = 0; length <= entries.length; length++) {
      const result = formatCoverage(entries.slice(0, length));
      expect(
        result.matched +
          result.explicitGeneric +
          result.unsupported +
          result.ambiguous +
          result.pending +
          result.unloaded,
      ).toBe(length);
      expect(result.loaded + result.unloaded).toBe(length);
      expect(result.windowEvents).toBe(length);
    }
    expect(formatCoverage([]).matches).toEqual([]);
  });
});
