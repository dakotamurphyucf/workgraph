import type { Digest } from "../../../core/protocol/types";
import * as d from "../../../core/protocol/decoders";
/** One locally emitted worker per explicit stage, terminated on cancel/timeout.
 * The immutable Blob is cloned; full64MiB reading/hash stay off main thread. */
export interface UploadHashWorker {
  onerror: ((event: ErrorEvent) => void) | null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: (message: unknown) => void;
  terminate: () => void;
}
export function hashUpload(
  blob: Blob,
  signal: AbortSignal,
  create: () => UploadHashWorker = () =>
    new Worker(new URL("./upload-digest.worker.ts", import.meta.url), { type: "module" }),
): Promise<Digest> {
  if (blob.size > 67108864) return Promise.reject(new RangeError("Resource source exceeds64MiB"));
  if (signal.aborted) return Promise.reject(new DOMException("Staging cancelled", "AbortError"));
  const worker = create();
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (result: Digest | Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      worker.terminate();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const abort = () => finish(new DOMException("Staging cancelled", "AbortError"));
    const timer = setTimeout(
      () => finish(new DOMException("Source hashing timed out", "TimeoutError")),
      300000,
    );
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) =>
      finish(event.error instanceof Error ? event.error : new Error("Source hash worker failed"));
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (
        typeof message === "object" &&
        message !== null &&
        Object.keys(message).sort().join(",") === "kind,message,name" &&
        "kind" in message &&
        message.kind === "failed" &&
        "name" in message &&
        typeof message.name === "string" &&
        message.name.length <= 128 &&
        "message" in message &&
        typeof message.message === "string" &&
        message.message.length <= 4096
      ) {
        const error = new Error(message.message);
        error.name = message.name;
        finish(error);
        return;
      }
      if (
        typeof message !== "object" ||
        message === null ||
        Object.keys(message).sort().join(",") !== "digest,kind" ||
        !("kind" in message) ||
        message.kind !== "digest" ||
        !("digest" in message) ||
        typeof message.digest !== "string"
      ) {
        finish(new Error("Invalid source hash worker reply"));
        return;
      }
      const value = d.digest.decode(d.jsonString(message.digest));
      finish(value.ok ? value.value : new Error("Invalid source digest"));
    };
    try {
      worker.postMessage({ kind: "hash", blob });
    } catch (error) {
      finish(
        error instanceof Error
          ? error
          : new Error("Source worker dispatch failed", { cause: error }),
      );
    }
  });
}
