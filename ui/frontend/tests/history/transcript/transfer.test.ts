import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import * as d from "../../../src/core/protocol/decoders";
import { createTransferAssembly } from "../../../src/features/history/transcript/transfer-core";
import {
  createVerifiedTransfer,
  type TransferWorker,
} from "../../../src/features/history/transcript/transfer";
import { transferRequest } from "../../../src/features/history/transcript/transfer-wire";
import { chunkBytes } from "../../../src/features/history/transcript/bytes";
import type { BlobRef, PayloadChunk } from "../../../src/features/history/transcript/types";
function decimal(value: number) {
  const result = d.decimal.decode(d.jsonString(String(value)));
  if (!result.ok) throw new Error("bad fixture decimal");
  return result.value;
}
function blob(bytes: Uint8Array): BlobRef {
  const digest = d.digest.decode(d.jsonString(createHash("sha256").update(bytes).digest("hex")));
  if (!digest.ok) throw new Error("bad fixture digest");
  return { digest: digest.value, size_bytes: decimal(bytes.length) };
}
function chunk(bytes: Uint8Array, source: BlobRef, offset = 0): PayloadChunk {
  return {
    blob: source,
    offset: decimal(offset),
    bytes_base64: Buffer.from(bytes).toString("base64"),
    next_offset: decimal(offset + bytes.length),
    total_bytes: source.size_bytes,
    has_more: offset + bytes.length < Number(source.size_bytes),
  };
}
function worker(): TransferWorker {
  let assembly: ReturnType<typeof createTransferAssembly> | null = null,
    stopped = false;
  const result: TransferWorker = {
    onmessage: null,
    onerror: null,
    terminate: () => {
      stopped = true;
    },
    postMessage: (request) => {
      queueMicrotask(() => {
        void (async () => {
          if (stopped || typeof request !== "object" || request === null || !("kind" in request))
            return;
          if (request.kind === "begin" && "source" in request) {
            const source = request.source;
            if (
              typeof source !== "object" ||
              source === null ||
              !("digest" in source) ||
              !("size_bytes" in source)
            )
              throw new Error("fixture");
            const decoded = d.digest.decode(d.jsonString(String(source.digest))),
              size = d.decimal.decode(d.jsonString(String(source.size_bytes)));
            if (!decoded.ok || !size.ok) throw new Error("fixture");
            assembly = createTransferAssembly({ digest: decoded.value, size_bytes: size.value });
            result.onmessage?.(new MessageEvent("message", { data: { kind: "ready" } }));
          } else if (request.kind === "chunk" && "chunk" in request && assembly) {
            const decoded = await import("../../../src/features/history/transcript/codecs");
            const json = JSON.stringify(request.chunk);
            const parsed = (await import("../../../src/core/json")).parseJsonText(json);
            if (!parsed.ok) throw new Error("fixture");
            const found = decoded.payloadChunk.decode(parsed.value.value);
            if (!found.ok) throw new Error("fixture");
            result.onmessage?.(
              new MessageEvent("message", {
                data: { kind: "progress", offset: assembly.append(found.value) },
              }),
            );
          } else if (request.kind === "finish" && assembly)
            result.onmessage?.(
              new MessageEvent("message", {
                data: { kind: "complete", blob: await assembly.finish() },
              }),
            );
        })().catch((error: unknown) =>
          result.onmessage?.(
            new MessageEvent("message", {
              data: {
                kind: "failed",
                message: error instanceof Error ? error.message : "fixture error",
              },
            }),
          ),
        );
      });
    },
  };
  return result;
}
describe("verified exact byte transfer", () => {
  it("full64MiB boundary assembles through256 bounded chunks and independently matches its digest", async () => {
    const bytes = new Uint8Array(67108864),
      source = blob(bytes),
      assembly = createTransferAssembly(source);
    for (let offset = 0; offset < bytes.length; offset += 262144)
      assembly.append(chunk(bytes.subarray(offset, offset + 262144), source, offset));
    const verified = await assembly.finish();
    expect(verified.size).toBe(67108864);
    expect(
      createHash("sha256")
        .update(new Uint8Array(await verified.arrayBuffer()))
        .digest("hex"),
    ).toBe(source.digest);
  }, 15000);
  it.each([
    { kind: "nope" },
    { kind: "finish", extra: 1 },
    { kind: "begin", source: { digest: "a".repeat(64), size_bytes: "67108865" } },
    { kind: "begin", source: { digest: "a".repeat(64), size_bytes: "1\n" } },
    { kind: "chunk", chunk: {} },
  ])("worker rejects unknown/malformed request without finish fallthrough %j", (message) =>
    expect(transferRequest(message)).toBeNull(),
  );
  it("300-second deadline aborts the captured read, terminates its worker and releases busy ownership", async () => {
    vi.useFakeTimers();
    try {
      let ended = 0;
      const signals: AbortSignal[] = [];
      const transfer = createVerifiedTransfer({
          worker: () => {
            const owned = worker(),
              terminate = owned.terminate;
            owned.terminate = () => {
              ended++;
              terminate();
            };
            return owned;
          },
        }),
        source = blob(new Uint8Array([1]));
      let settled = false;
      const pending = transfer.download(
        source,
        {
          read: (_offset, signal) => {
            signals.push(signal);
            return new Promise(() => {});
          },
        },
        () => {},
      );
      void pending.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(299999);
      expect(settled).toBe(false);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(false);
      expect(ended).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({ ok: false, kind: "timeout" });
      expect(signals[0]?.aborted).toBe(true);
      expect(ended).toBeGreaterThanOrEqual(1);
      expect(vi.getTimerCount()).toBe(0);
      const cancel = new AbortController();
      const next = transfer.download(
        source,
        { read: () => new Promise(() => {}) },
        () => {},
        cancel.signal,
      );
      cancel.abort();
      expect(await next).toMatchObject({ ok: false, kind: "cancelled" });
      expect(vi.getTimerCount()).toBe(0);
      transfer.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("assembles byte-split UTF-8 and binary without normalization and verifies digest", async () => {
    const bytes = new Uint8Array([0, 255, 0xe9, 0x9b, 0xaa, 13, 10]),
      source = blob(bytes),
      assembly = createTransferAssembly(source);
    assembly.append(chunk(bytes.slice(0, 3), source));
    assembly.append(chunk(bytes.slice(3), source, 3));
    expect(new Uint8Array(await (await assembly.finish()).arrayBuffer())).toEqual(bytes);
  });
  it.each(["offset", "digest", "padding", "count", "nonadvance"])(
    "rejects malformed %s before verified success",
    (kind) => {
      const bytes = new Uint8Array([1, 2, 3]),
        source = blob(bytes),
        correct = chunk(bytes, source);
      const bad =
        kind === "offset"
          ? { ...correct, offset: decimal(1) }
          : kind === "digest"
            ? { ...correct, blob: blob(new Uint8Array([3, 2, 1])) }
            : kind === "padding"
              ? { ...correct, bytes_base64: "AR==" }
              : kind === "count"
                ? { ...correct, next_offset: decimal(2) }
                : { ...correct, bytes_base64: "", next_offset: decimal(0), has_more: true };
      expect(() => createTransferAssembly(source).append(bad)).toThrow();
    },
  );
  it("rejects complete bytes with the wrong full-file digest", async () => {
    const source = blob(new Uint8Array([1])),
      assembly = createTransferAssembly(source);
    assembly.append(chunk(new Uint8Array([2]), source));
    await expect(assembly.finish()).rejects.toThrow("SHA-256");
  });
  it("freezes source and supplier function before deferred reads; caller mutation cannot relabel verified bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3]),
      source = { ...blob(bytes) };
    let release: ((value: Awaited<ReturnType<typeof supplier.read>>) => void) | undefined;
    const supplier = {
      read: () =>
        new Promise<{ ok: true; data: PayloadChunk; httpStatus: number }>((resolve) => {
          release = resolve;
        }),
    };
    const transfer = createVerifiedTransfer({ worker });
    const result = transfer.download(source, supplier, () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const original = { ...source };
    source.digest = blob(new Uint8Array([9])).digest;
    source.size_bytes = decimal(1);
    supplier.read = () => Promise.reject(new Error("changed callback must not be used"));
    release?.({ ok: true, data: chunk(bytes, original), httpStatus: 200 });
    const complete = await result;
    expect(complete.ok).toBe(true);
    if (!complete.ok) throw new Error(complete.message);
    expect(complete.digest).toBe(original.digest);
    expect(complete.blob.size).toBe(3);
    transfer.dispose();
  });
  it("worker constructor failure releases busy ownership and preserves the unexpected error", async () => {
    let calls = 0;
    const defect = new TypeError("worker constructor defect"),
      transfer = createVerifiedTransfer({
        worker: () => {
          if (calls++ === 0) throw defect;
          return worker();
        },
      }),
      bytes = new Uint8Array([1]),
      source = blob(bytes),
      supplier = {
        read: () =>
          Promise.resolve({ ok: true as const, data: chunk(bytes, source), httpStatus: 200 }),
      };
    await expect(transfer.download(source, supplier, () => {})).rejects.toBe(defect);
    expect((await transfer.download(source, supplier, () => {})).ok).toBe(true);
    transfer.dispose();
  });
  it("rejects malformed/unsolicited response shapes and never returns a download Blob", async () => {
    const fake: TransferWorker = {
      onmessage: null,
      onerror: null,
      terminate: () => {},
      postMessage: () =>
        queueMicrotask(() =>
          fake.onmessage?.(new MessageEvent("message", { data: { kind: "ready", extra: "bad" } })),
        ),
    };
    const source = blob(new Uint8Array()),
      transfer = createVerifiedTransfer({ worker: () => fake });
    expect(
      (
        await transfer.download(
          source,
          { read: () => Promise.reject(new Error("should not read")) },
          () => {},
        )
      ).ok,
    ).toBe(false);
    transfer.dispose();
  });
  it("does not accept noncanonical Base64 even if the browser decoder accepts it", () => {
    const source = blob(new Uint8Array([1]));
    expect(() =>
      chunkBytes({ ...chunk(new Uint8Array([1]), source), bytes_base64: "AR==" }, source, 0),
    ).toThrow("continuation");
  });
});
