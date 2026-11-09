import type { JsonDocument, JsonResult } from "../core/json";
import { CONTENT_LIMITS } from "./limits";
import { readWorkerMessage, readWorkerRequest } from "./wire";
import type {
  ContentJob,
  ContentJobResult,
  ContentPreview,
  ContentWorkerClient,
  JsonDecodeRequest,
  RenderRequest,
  WorkOutcome,
  WorkerRequest,
} from "./types";

export interface ContentWorkerPort {
  readonly listen: (message: (data: unknown) => void, failed: () => void) => () => void;
  readonly send: (message: WorkerRequest, transfer: Transferable[]) => void;
  readonly terminate: () => void;
}
export type ContentWorkerFactory = () => ContentWorkerPort;
export function browserContentWorker(): ContentWorkerPort {
  const worker = new Worker(new URL("./content.worker.ts", import.meta.url), { type: "module" });
  return {
    listen(message, failed) {
      const receive = (event: MessageEvent<unknown>) => {
        message(event.data);
      };
      const failure = () => {
        failed();
      };
      worker.addEventListener("message", receive);
      worker.addEventListener("error", failure);
      worker.addEventListener("messageerror", failure);
      return () => {
        worker.removeEventListener("message", receive);
        worker.removeEventListener("error", failure);
        worker.removeEventListener("messageerror", failure);
      };
    },
    send: (message, transfer) => {
      worker.postMessage(message, transfer);
    },
    terminate: () => {
      worker.terminate();
    },
  };
}
interface Pending {
  readonly envelope: WorkerRequest;
  readonly bytes: number;
  readonly resolve: (result: WorkOutcome<ContentJobResult>) => void;
  readonly signal: AbortSignal | undefined;
  onAbort: () => void;
  port: ContentWorkerPort | null;
  cleanup: (() => void) | null;
  deadline: ReturnType<typeof setTimeout> | null;
  slice: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}
interface Waiting {
  readonly job: ContentJob;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (result: WorkOutcome<ContentJobResult>) => void;
  readonly reject: (error: unknown) => void;
  readonly onAbort: () => void;
}
/** Shared bounded admission, one disposable worker per active job. Cancel/deadline terminates actual computation. */
export function createContentWorkerClient(
  factory: ContentWorkerFactory = browserContentWorker,
): ContentWorkerClient {
  const queue: Pending[] = [];
  const active = new Set<Pending>();
  const waiting: Waiting[] = [];
  let draining = false;
  let bytes = 0;
  let counter = 0n;
  let disposed = false;
  function finish(entry: Pending, result: WorkOutcome<ContentJobResult>) {
    if (entry.settled) return;
    entry.settled = true;
    active.delete(entry);
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
    if (entry.deadline !== null) clearTimeout(entry.deadline);
    if (entry.slice !== null) clearTimeout(entry.slice);
    entry.cleanup?.();
    entry.port?.terminate();
    entry.signal?.removeEventListener("abort", entry.onAbort);
    bytes -= entry.bytes;
    entry.resolve(result);
    pump();
    drain();
  }
  function room(size: number) {
    return (
      active.size + queue.length < CONTENT_LIMITS.pending &&
      bytes + size <= CONTENT_LIMITS.admittedBytes
    );
  }
  function drain() {
    if (disposed || draining) return;
    draining = true;
    try {
      while (waiting.length > 0) {
        const next = waiting[0];
        if (next === undefined || !room(next.job.request.bytes.byteLength)) break;
        waiting.shift();
        next.signal?.removeEventListener("abort", next.onAbort);
        // Admission is synchronous. Completion settles this exact waiter; a
        // newer source cannot adopt it and cancellation still terminates work.
        void submit(next.job, next.signal).then(next.resolve, next.reject);
      }
    } finally {
      draining = false;
    }
  }
  function pump() {
    while (!disposed && active.size < CONTENT_LIMITS.workers && queue.length) {
      const entry = queue.shift();
      if (!entry || entry.settled) continue;
      active.add(entry);
      entry.deadline = setTimeout(() => {
        finish(entry, {
          ok: false,
          kind: "timeout",
          message: `Content preview exceeded its ${CONTENT_LIMITS.deadlineMs / 1000}s worker deadline. Source is retained.`,
        });
      }, CONTENT_LIMITS.deadlineMs);
      try {
        const port = factory();
        entry.port = port;
        entry.cleanup = port.listen(
          (data) => {
            if (entry.settled) return;
            // Drop stale identities before traversing a potentially substantial result tree.
            if (
              typeof data === "object" &&
              data !== null &&
              "jobId" in data &&
              "key" in data &&
              (data.jobId !== entry.envelope.jobId || data.key !== entry.envelope.key)
            )
              return;
            const message = readWorkerMessage(data);
            if (!message) {
              finish(entry, {
                ok: false,
                kind: "protocol",
                message: "Content worker returned an invalid response. Source is retained.",
              });
              return;
            }
            if (message.kind === "stage") {
              if (entry.slice !== null) clearTimeout(entry.slice);
              entry.slice = setTimeout(() => {
                finish(entry, {
                  ok: false,
                  kind: "timeout",
                  message: `Content preview exceeded its ${CONTENT_LIMITS.sliceMs}ms work slice. Source is retained.`,
                });
              }, CONTENT_LIMITS.sliceMs);
            } else if (message.kind === "complete") {
              if (
                message.result.kind !== entry.envelope.job.kind ||
                (message.result.kind === "render" &&
                  (message.result.preview.key !== entry.envelope.key ||
                    message.result.preview.byteLength !== entry.bytes))
              )
                finish(entry, {
                  ok: false,
                  kind: "protocol",
                  message: "Content worker returned a different capture or job type.",
                });
              else if (
                message.result.kind === "json" &&
                message.result.document.ok &&
                message.result.document.value.byteLength !== entry.bytes
              )
                finish(entry, {
                  ok: false,
                  kind: "protocol",
                  message: "JSON worker returned a different capture size.",
                });
              else finish(entry, { ok: true, value: message.result });
            } else
              finish(entry, {
                ok: false,
                kind: message.failure === "budget" ? "timeout" : "worker",
                message: message.message,
              });
          },
          () => {
            finish(entry, {
              ok: false,
              kind: "worker",
              message:
                "Content worker failed. Source is retained; no work was retried automatically.",
            });
          },
        );
        port.send(entry.envelope, [entry.envelope.job.request.bytes.buffer]);
      } catch (error: unknown) {
        // Browser worker admission/CSP/serialization errors are explicit worker failures.
        if (error instanceof Error)
          finish(entry, {
            ok: false,
            kind: "worker",
            message: "Content worker could not start or accept this capture. Source is retained.",
          });
        else throw error;
      }
    }
  }
  function submit(
    job: ContentJob,
    signal?: AbortSignal,
    waitForCapacity = false,
  ): Promise<WorkOutcome<ContentJobResult>> {
    if (disposed || signal?.aborted)
      return Promise.resolve({
        ok: false,
        kind: "cancelled",
        message: "Content work was canceled.",
      });
    if (!(job.request.bytes instanceof Uint8Array))
      return Promise.resolve({
        ok: false,
        kind: "input",
        message: "Content source must be captured bytes.",
      });
    const key = job.request.key;
    const id = `content-${++counter}`;
    const checked = readWorkerRequest({ protocol: 1, jobId: id, key, job });
    if (!checked)
      return Promise.resolve({
        ok: false,
        kind: "input",
        message: "Content request is invalid or exceeds the input budget.",
      });
    if (!room(job.request.bytes.byteLength) || (waitForCapacity && waiting.length > 0)) {
      if (waitForCapacity && waiting.length < CONTENT_LIMITS.waiting) {
        return new Promise((resolve, reject) => {
          const entry: Waiting = {
            job: checked.job,
            signal,
            resolve,
            reject,
            onAbort: () => {
              const index = waiting.indexOf(entry);
              if (index < 0) return;
              waiting.splice(index, 1);
              signal?.removeEventListener("abort", entry.onAbort);
              resolve({ ok: false, kind: "cancelled", message: "Content work was canceled." });
              drain();
            },
          };
          waiting.push(entry);
          signal?.addEventListener("abort", entry.onAbort, { once: true });
          drain();
        });
      }
      return Promise.resolve({
        ok: false,
        kind: "busy",
        message: "Content work queue is full. Raw source is retained; retry explicitly.",
      });
    }
    const copy = checked.job.request.bytes.slice();
    const envelope: WorkerRequest = {
      ...checked,
      job:
        checked.job.kind === "render"
          ? { kind: "render", request: { ...checked.job.request, bytes: copy } }
          : { kind: "json", request: { ...checked.job.request, bytes: copy } },
    };
    return new Promise((resolve) => {
      const entry: Pending = {
        envelope,
        bytes: copy.byteLength,
        resolve,
        signal,
        onAbort: () => {},
        port: null,
        cleanup: null,
        deadline: null,
        slice: null,
        settled: false,
      };
      entry.onAbort = () => {
        finish(entry, { ok: false, kind: "cancelled", message: "Content work was canceled." });
      };
      signal?.addEventListener("abort", entry.onAbort, { once: true });
      bytes += copy.byteLength;
      queue.push(entry);
      pump();
    });
  }
  return {
    render: async (
      request: RenderRequest,
      signal?: AbortSignal,
      options?: { readonly waitForCapacity?: boolean },
    ): Promise<WorkOutcome<ContentPreview>> => {
      const result = await submit({ kind: "render", request }, signal, options?.waitForCapacity);
      if (!result.ok) return result;
      return result.value.kind === "render"
        ? { ok: true, value: result.value.preview }
        : { ok: false, kind: "protocol", message: "Wrong content worker result." };
    },
    decodeJson: async (
      request: JsonDecodeRequest,
      signal?: AbortSignal,
    ): Promise<WorkOutcome<JsonResult<JsonDocument>>> => {
      const result = await submit({ kind: "json", request }, signal);
      if (!result.ok) return result;
      return result.value.kind === "json"
        ? { ok: true, value: result.value.document }
        : { ok: false, kind: "protocol", message: "Wrong content worker result." };
    },
    dispose: () => {
      disposed = true;
      for (const entry of waiting.splice(0)) {
        entry.signal?.removeEventListener("abort", entry.onAbort);
        entry.resolve({ ok: false, kind: "cancelled", message: "Content client was disposed." });
      }
      for (const entry of [...queue, ...active])
        finish(entry, { ok: false, kind: "cancelled", message: "Content client was disposed." });
    },
  };
}
