import type { HttpResult } from "../../../core/protocol/http";
import type { BlobRef, PayloadChunk } from "./types";
import type { TransferResult, VerifiedTransfer } from "./transfer.types";
export type { ChunkSupplier, TransferResult, VerifiedTransfer } from "./transfer.types";
export interface TransferWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage: (request: unknown) => void;
  terminate: () => void;
}
type Reply =
  | { readonly kind: "ready" }
  | { readonly kind: "progress"; readonly offset: number }
  | { readonly kind: "complete"; readonly blob: Blob }
  | { readonly kind: "failed"; readonly message: string };
function reply(value: unknown): Reply | null {
  if (typeof value !== "object" || value === null || !("kind" in value)) return null;
  const names = Object.keys(value).sort().join(",");
  if (value.kind === "ready" && names === "kind") return { kind: "ready" };
  if (
    value.kind === "progress" &&
    names === "kind,offset" &&
    "offset" in value &&
    typeof value.offset === "number" &&
    Number.isSafeInteger(value.offset) &&
    value.offset >= 0 &&
    value.offset <= 67108864
  )
    return { kind: "progress", offset: value.offset };
  if (
    value.kind === "complete" &&
    names === "blob,kind" &&
    "blob" in value &&
    value.blob instanceof Blob
  )
    return { kind: "complete", blob: value.blob };
  if (
    value.kind === "failed" &&
    names === "kind,message" &&
    "message" in value &&
    typeof value.message === "string" &&
    value.message.length <= 4096
  )
    return { kind: "failed", message: value.message };
  return null;
}
/** One full file at a time; one ≤256 KiB encoded chunk crosses before acknowledgement. */
export function createVerifiedTransfer(
  options: { readonly worker?: () => TransferWorker } = {},
): VerifiedTransfer {
  let active: AbortController | null = null,
    disposed = false;
  return {
    download: async (source, supplier, progress, signal): Promise<TransferResult> => {
      // Copy caller scalars and function identity before any await/worker creation.
      const captured = Object.freeze({ digest: source.digest, size_bytes: source.size_bytes });
      const readChunk = supplier.read;
      if (disposed) return { ok: false, kind: "cancelled", message: "Transfer owner ended." };
      if (active !== null)
        return { ok: false, kind: "busy", message: "Another full-file transfer is active." };
      if (
        !/^(0|[1-9][0-9]{0,7})(?![\s\S])/u.test(captured.size_bytes) ||
        Number(captured.size_bytes) > 67108864 ||
        !/^[a-f0-9]{64}(?![\s\S])/u.test(captured.digest)
      )
        return {
          ok: false,
          kind: "input",
          message: "Transfer requires a pinned SHA-256 blob of at most 64 MiB.",
        };
      if (signal?.aborted) return { ok: false, kind: "cancelled", message: "Download cancelled." };
      const controller = new AbortController();
      active = controller;
      let worker: TransferWorker | null = null,
        timeout = false;
      const fatal: { current: { error: Error } | null } = { current: null };
      let pending: {
        resolve: (reply: Reply | null) => void;
        reject: (error: unknown) => void;
      } | null = null;
      const abort = () => controller.abort();
      const cancelled = () => {
        const waiter = pending;
        pending = null;
        waiter?.resolve(null);
        worker?.terminate();
      };
      const timer = setTimeout(() => {
        timeout = true;
        controller.abort();
      }, 300_000);
      signal?.addEventListener("abort", abort, { once: true });
      controller.signal.addEventListener("abort", cancelled, { once: true });
      const assertHealthy = () => {
        if (fatal.current !== null) throw fatal.current.error;
      };
      const stopped = (): TransferResult => ({
        ok: false,
        kind: timeout ? "timeout" : "cancelled",
        message: timeout ? "Download deadline reached." : "Download cancelled.",
      });
      try {
        worker =
          options.worker?.() ??
          new Worker(new URL("./transfer.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (event) => {
          const waiter = pending;
          pending = null;
          if (waiter === null) {
            fatal.current = { error: new Error("Unsolicited transfer worker response.") };
            controller.abort();
            return;
          }
          waiter.resolve(reply(event.data));
        };
        worker.onerror = (event) => {
          const cause: unknown = event.error;
          const error = cause instanceof Error ? cause : new Error(event.message, { cause });
          fatal.current = { error };
          const waiter = pending;
          pending = null;
          waiter?.reject(
            error instanceof Error
              ? error
              : new Error("Unexpected transfer failure", { cause: error }),
          );
          controller.abort();
        };
        const ask = (
          request:
            | { kind: "begin"; source: BlobRef }
            | { kind: "chunk"; chunk: PayloadChunk }
            | { kind: "finish" },
        ): Promise<Reply | null> =>
          new Promise((resolve, reject) => {
            if (fatal.current !== null) {
              reject(fatal.current.error);
              return;
            }
            if (controller.signal.aborted) {
              resolve(null);
              return;
            }
            pending = { resolve, reject };
            try {
              worker?.postMessage(request);
            } catch (error: unknown) {
              pending = null;
              reject(
                error instanceof Error
                  ? error
                  : new Error("Unexpected transfer failure", { cause: error }),
              );
            }
          });
        const begun = await ask({ kind: "begin", source: captured });
        if (controller.signal.aborted) {
          assertHealthy();
          return stopped();
        }
        if (begun?.kind !== "ready")
          return {
            ok: false,
            kind: "protocol",
            message: "Transfer worker rejected the pinned source.",
          };
        const total = Number(captured.size_bytes);
        let offset = 0;
        progress(0, total);
        do {
          const read = await new Promise<HttpResult<PayloadChunk>>((resolve, reject) => {
            if (controller.signal.aborted) {
              resolve({ ok: false, failure: { kind: "aborted" } });
              return;
            }
            const end = () => resolve({ ok: false, failure: { kind: "aborted" } });
            controller.signal.addEventListener("abort", end, { once: true });
            Promise.resolve()
              .then(() => readChunk(String(offset), controller.signal))
              .then(resolve, reject)
              .finally(() => controller.signal.removeEventListener("abort", end))
              .catch(reject);
          });
          assertHealthy();
          if (controller.signal.aborted) return stopped();
          if (!read.ok)
            return {
              ok: false,
              kind: read.failure.kind === "aborted" ? "cancelled" : "read",
              message:
                read.failure.kind === "remote"
                  ? `${read.failure.problem.kind}: ${read.failure.problem.message}`
                  : read.failure.kind === "aborted"
                    ? "Download cancelled."
                    : read.failure.message,
            };
          const response = await ask({ kind: "chunk", chunk: read.data });
          if (controller.signal.aborted) {
            assertHealthy();
            return stopped();
          }
          if (
            response?.kind !== "progress" ||
            response.offset !== Number(read.data.next_offset) ||
            response.offset > total ||
            (response.offset <= offset && read.data.has_more)
          )
            return {
              ok: false,
              kind: "protocol",
              message:
                response?.kind === "failed"
                  ? response.message
                  : "Invalid transfer worker continuation.",
            };
          offset = response.offset;
          progress(offset, total);
          if (!read.data.has_more) break;
        } while (offset < total);
        const response = await ask({ kind: "finish" });
        if (controller.signal.aborted) {
          assertHealthy();
          return stopped();
        }
        return response?.kind === "complete" && response.blob.size === total
          ? { ok: true, blob: response.blob, digest: captured.digest }
          : {
              ok: false,
              kind: "protocol",
              message:
                response?.kind === "failed" ? response.message : "Incomplete verified transfer.",
            };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        controller.signal.removeEventListener("abort", cancelled);
        worker?.terminate();
        active = null;
      }
    },
    dispose: () => {
      disposed = true;
      active?.abort();
    },
  };
}
