import * as d from "../../src/core/protocol/decoders";
import { describe, expect, it, vi } from "vitest";
import {
  createProtocolProcessor,
  type ProtocolWorkerFactory,
} from "../../src/core/protocol/worker";
import { PROCESSING_LIMITS } from "../../src/core/protocol/worker/jobs";
import { createTestProcessor } from "./processing-harness";
describe("dedicated protocol pipeline test transport", () => {
  it("roundtrips exact lexemes and immutable ownership across reused jobs", async () => {
    const processor = createTestProcessor();
    try {
      const parsed = await processor.parse('{"__proto__":9007199254740993,"emoji":"😀"}');
      expect(parsed.ok).toBe(true);
      if (!parsed.ok || !parsed.value.ok) throw new Error("Expected parsed source");
      expect(parsed.value.value.source).toContain("9007199254740993");
      const encoded = await processor.encode(parsed.value.value.value, { canonical: true });
      expect(encoded).toEqual({
        ok: true,
        value: { ok: true, value: '{"__proto__":9007199254740993,"emoji":"😀"}' },
      });
      expect(Object.isFrozen(parsed.value.value.value)).toBe(true);
    } finally {
      processor.dispose();
    }
  });
  it("returns parser errors without conflating them with worker faults", async () => {
    const processor = createTestProcessor();
    try {
      const parsed = await processor.parse('{"a":1,"a":2}');
      expect(parsed.ok && !parsed.value.ok && parsed.value.error.code).toBe("duplicate_key");
    } finally {
      processor.dispose();
    }
  });
  it("preserves96container depth across expanded AST transport", async () => {
    const processor = createTestProcessor();
    try {
      for (const depth of [90, 96]) {
        const source = '{"a":'.repeat(depth) + "0" + "}".repeat(depth);
        const bounds = {
          maxBytes: 4194304,
          maxDepth: 96,
          maxNodes: 100000,
          maxStringBytes: 4194304,
        };
        const parsed = await processor.parse(source, { limits: bounds });
        expect(parsed.ok && parsed.value.ok).toBe(true);
        if (!parsed.ok || !parsed.value.ok) throw new Error("Expected full-depth parsed source");
        const encoded = await processor.encode(parsed.value.value.value, { limits: bounds });
        expect(encoded).toEqual({ ok: true, value: { ok: true, value: source } });
        if (depth === 90) {
          const id = d.identifier.decode(d.jsonString("test"));
          const generation = d.positiveDecimal.decode(d.jsonString("1"));
          if (!id.ok || !generation.ok || parsed.value.value.value.kind !== "object")
            throw new Error("Invalid test fixture");
          const admitted = await processor.admitPreparation({
            intention_id: id.value,
            connection_id: id.value,
            generation: generation.value,
            context: {
              workspace_id: null,
              project_id: null,
              writer: { actor_id: id.value, run_id: null },
            },
            method: "ticket.create",
            params: parsed.value.value.value,
          });
          expect(admitted).toMatchObject({ ok: true, value: { ok: true } });
        }
      }
    } finally {
      processor.dispose();
    }
  });
  it("rejects plainly oversized inputs before copying or starting a worker", async () => {
    let starts = 0;
    const processor = createProtocolProcessor(() => {
      starts++;
      throw new Error("must not start");
    });
    const source = new Uint8Array(4 * 1024 * 1024 + 1);
    const parsed = await processor.parse(source);
    expect(parsed.ok && !parsed.value.ok && parsed.value.error.code).toBe("byte_limit");
    expect(
      await processor.decodeHttp(source, { budget: "ordinary", operation: false }),
    ).toMatchObject({ ok: true, value: { ok: false } });
    expect(starts).toBe(0);
    expect(source.byteLength).toBe(4 * 1024 * 1024 + 1);
    processor.dispose();
  });
  it("bounds admission and distinguishes queued cancellation, active termination, deadline and disposal", async () => {
    vi.useFakeTimers();
    let starts = 0;
    let stops = 0;
    const factory: ProtocolWorkerFactory = () => {
      starts++;
      return {
        listen: () => () => {},
        send: () => {},
        terminate: () => {
          stops++;
        },
      };
    };
    const processor = createProtocolProcessor(factory);
    try {
      const active = processor.parse("0");
      const abort = new AbortController();
      const queued = processor.parse("1", { signal: abort.signal });
      const rest = Array.from({ length: PROCESSING_LIMITS.queued - 1 }, (_, i) =>
        processor.parse(String(i + 2)),
      );
      expect(await processor.parse("5")).toMatchObject({ ok: false, failure: { kind: "busy" } });
      abort.abort();
      expect(await queued).toMatchObject({ ok: false, failure: { kind: "aborted" } });
      expect(stops).toBe(0);
      await vi.advanceTimersByTimeAsync(PROCESSING_LIMITS.deadlineMs);
      expect(await active).toMatchObject({ ok: false, failure: { kind: "timeout" } });
      await Promise.all(rest);
      expect(stops).toBeGreaterThan(0);
      const last = processor.parse("6");
      processor.dispose();
      expect(await last).toMatchObject({ ok: false, failure: { kind: "aborted" } });
      expect(await processor.parse("7")).toMatchObject({ ok: false, failure: { kind: "aborted" } });
      expect(starts).toBeGreaterThan(0);
    } finally {
      processor.dispose();
      vi.useRealTimers();
    }
  });
  it("preserves Unicode/UTF8 domain errors and unexpected worker exceptions", async () => {
    const processor = createTestProcessor();
    try {
      const invalid = await processor.parse('"\ud800"');
      expect(invalid.ok && !invalid.value.ok && invalid.value.error.code).toBe("invalid_unicode");
      const utf8 = await processor.parse(new Uint8Array([255]));
      expect(utf8.ok && !utf8.value.ok && utf8.value.error.code).toBe("invalid_utf8");
    } finally {
      processor.dispose();
    }
    const bug = new TypeError("worker implementation fault");
    const broken = createProtocolProcessor(() => ({
      listen: (_receive, failed) => {
        queueMicrotask(() => failed(bug));
        return () => {};
      },
      send: () => {},
      terminate: () => {},
    }));
    await expect(broken.parse("0")).rejects.toBe(bug);
    broken.dispose();
  });
  it("accepts exact ordinary and operation node/byte budgets without a smaller transport ceiling", async () => {
    const processor = createTestProcessor();
    try {
      for (const [nodes, maxBytes] of [
        [100000, 4 * 1024 * 1024],
        [400000, 16 * 1024 * 1024],
      ] as const) {
        const limits = { maxBytes, maxDepth: 96, maxNodes: nodes, maxStringBytes: maxBytes };
        const source = "[" + "null,".repeat(nodes - 2) + "null]";
        const parsed = await processor.parse(source, { limits });
        expect(parsed.ok && parsed.value.ok).toBe(true);
        if (!parsed.ok || !parsed.value.ok) throw new Error("Full node budget failed");
        const encoded = await processor.encode(parsed.value.value.value, { limits });
        expect(encoded).toEqual({ ok: true, value: { ok: true, value: source } });
        const full = '"' + "x".repeat(maxBytes - 2) + '"';
        const bytes = await processor.parse(full, { limits });
        expect(bytes.ok && bytes.value.ok).toBe(true);
      }
    } finally {
      processor.dispose();
    }
  }, 30000);
  it("captures byte sources before caller mutation and does not detach them", async () => {
    const processor = createTestProcessor();
    try {
      const source = new TextEncoder().encode('{"n":9007199254740993}');
      const pending = processor.parse(source);
      source.fill(0);
      const parsed = await pending;
      expect(parsed).toMatchObject({
        ok: true,
        value: { ok: true, value: { source: '{"n":9007199254740993}' } },
      });
      expect(source.byteLength).toBe(22);
    } finally {
      processor.dispose();
    }
  });
});
