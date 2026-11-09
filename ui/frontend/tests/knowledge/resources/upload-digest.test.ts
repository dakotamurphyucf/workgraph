import { describe, expect, it, vi } from "vitest";
import { digestUploadBlob } from "../../../src/features/knowledge/resources/upload-digest.core";
import {
  hashUpload,
  type UploadHashWorker,
} from "../../../src/features/knowledge/resources/upload-digest";
function worker() {
  const value: UploadHashWorker = {
    onerror: null,
    onmessage: null,
    postMessage: vi.fn(),
    terminate: vi.fn(),
  };
  return value;
}
describe("bounded source hash failure lifecycle", () => {
  it("reports Blob-read and digest failures explicitly, without a rejected worker task", async () => {
    const blob = new Blob(["abc"]),
      read = new DOMException("Synthetic source cannot be read", "NotReadableError");
    expect(await digestUploadBlob(blob, { read: () => Promise.reject(read) })).toEqual({
      kind: "failed",
      name: "NotReadableError",
      message: "Synthetic source cannot be read",
    });
    const digest = new Error("Synthetic digest failure");
    expect(await digestUploadBlob(blob, { digest: () => Promise.reject(digest) })).toEqual({
      kind: "failed",
      name: "Error",
      message: "Synthetic digest failure",
    });
  });
  it("terminates promptly and preserves the worker failure name/message", async () => {
    const w = worker(),
      pending = hashUpload(new Blob(["abc"]), new AbortController().signal, () => w);
    const observed = expect(pending).rejects.toMatchObject({
      name: "NotReadableError",
      message: "Synthetic source cannot be read",
    });
    w.onmessage?.(
      new MessageEvent("message", {
        data: {
          kind: "failed",
          name: "NotReadableError",
          message: "Synthetic source cannot be read",
        },
      }),
    );
    await observed;
    expect(w.terminate).toHaveBeenCalledOnce();
  });
  it("cancels and ignores a late worker completion without publishing another result", async () => {
    const w = worker(),
      abort = new AbortController(),
      pending = hashUpload(new Blob(["abc"]), abort.signal, () => w),
      observed = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    abort.abort();
    w.onmessage?.(
      new MessageEvent("message", { data: { kind: "digest", digest: "a".repeat(64) } }),
    );
    await observed;
    expect(w.terminate).toHaveBeenCalledOnce();
  });
  it("terminates an invalid worker reply instead of interpreting it as a source hash", async () => {
    const w = worker(),
      pending = hashUpload(new Blob(["abc"]), new AbortController().signal, () => w),
      observed = expect(pending).rejects.toThrow("Invalid source hash worker reply");
    w.onmessage?.(
      new MessageEvent("message", {
        data: { kind: "digest", digest: "a".repeat(64), extra: true },
      }),
    );
    await observed;
    expect(w.terminate).toHaveBeenCalledOnce();
  });
});
