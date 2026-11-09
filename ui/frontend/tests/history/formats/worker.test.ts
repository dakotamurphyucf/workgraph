import { describe, expect, it } from "vitest";
import { createTestProcessor } from "../../core/processing-harness";
import { jsonObject } from "../../../src/core/protocol/decoders";
import {
  FORMAT_LIMITS,
  projectCapturedPayload,
  projectCapturedPayloadAsync,
  type CapturedPayload,
} from "../../../src/features/history/formats";
import { messages } from "./fixtures";
function capture(bytes: Uint8Array): CapturedPayload {
  return {
    captureId: "capture-1",
    scopeId: ["local", "1", "demo", "session"],
    bytes,
    metadata: jsonObject([]),
    completeness: "complete",
    producer: null,
  };
}
describe("worker-owned provider projection", () => {
  it("matches pinned validators while retaining the exact original capture and bytes", async () => {
    const processor = createTestProcessor();
    const captured = capture(new TextEncoder().encode(JSON.stringify(messages)));
    try {
      const result = await projectCapturedPayloadAsync(processor, captured);
      expect(result).toEqual({ ok: true, value: projectCapturedPayload(captured) });
      if (!result.ok) throw new Error("Projection failed");
      expect(result.value.capture).toBe(captured);
      expect(result.value.capture.bytes).toBe(captured.bytes);
      expect(captured.bytes.byteLength).toBeGreaterThan(0);
    } finally {
      processor.dispose();
    }
  });
  it("retains generic/source fallback beyond pinned preview budget without worker allocation", async () => {
    const processor = createTestProcessor();
    const source = capture(new Uint8Array(FORMAT_LIMITS.maxBytes + 1));
    try {
      const result = await projectCapturedPayloadAsync(processor, source);
      expect(result).toMatchObject({
        ok: true,
        value: { status: "unsupported", reason: "byte-budget", document: null },
      });
      if (result.ok) expect(result.value.capture.bytes).toBe(source.bytes);
      const partial = await projectCapturedPayloadAsync(processor, {
        ...source,
        completeness: "partial",
      });
      expect(partial).toMatchObject({
        ok: true,
        value: { status: "unsupported", reason: "partial" },
      });
    } finally {
      processor.dispose();
    }
  });
});
