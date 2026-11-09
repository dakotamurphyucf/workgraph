import { VIEWER_LIMITS as L } from "./limits";
import { closeReply, readReply, readRequest, type ViewerRequest } from "./wire";
import type {
  ViewerJob,
  ViewerResult,
  ViewerValue,
  ViewerWorker,
  JsonTree,
  RasterPreview,
  Comparison,
} from "./types";
export interface ViewerPort {
  readonly listen: (receive: (value: unknown) => void, failed: () => void) => () => void;
  readonly send: (request: ViewerRequest, transfer: Transferable[]) => void;
  readonly terminate: () => void;
}
export function browserViewerWorker(): ViewerPort {
  const worker = new Worker(new URL("./viewer.worker.ts", import.meta.url), { type: "module" });
  return {
    listen(receive, failed) {
      const message = (event: MessageEvent<unknown>) => receive(event.data);
      worker.addEventListener("message", message);
      worker.addEventListener("error", failed);
      worker.addEventListener("messageerror", failed);
      return () => {
        worker.removeEventListener("message", message);
        worker.removeEventListener("error", failed);
        worker.removeEventListener("messageerror", failed);
      };
    },
    send: (request, transfer) => worker.postMessage(request, transfer),
    terminate: () => worker.terminate(),
  };
}
interface Active {
  readonly stop: () => void;
}
/** No automatic retry or unbounded queue; cancellation/deadline terminates actual computation. */
export function createViewerWorker(factory: () => ViewerPort = browserViewerWorker): ViewerWorker {
  const active = new Set<Active>();
  let bytes = 0,
    counter = 0n,
    disposed = false;
  function submit(job: ViewerJob, signal?: AbortSignal): Promise<ViewerResult<ViewerValue>> {
    if (disposed || signal?.aborted)
      return Promise.resolve({
        ok: false,
        kind: "cancelled",
        message: "Viewer work was canceled.",
      });
    const size =
      job.kind === "compare"
        ? job.left.bytes.length + job.right.bytes.length
        : job.source.bytes.length;
    if (active.size >= L.activeJobs || bytes + size > L.admittedBytes)
      return Promise.resolve({
        ok: false,
        kind: "busy",
        message: "Viewer work capacity is full. Retry explicitly; original bytes remain available.",
      });
    const id = `viewer-${++counter}`,
      key = job.kind === "compare" ? JSON.stringify([job.left.key, job.right.key]) : job.source.key;
    const request = readRequest({ protocol: 1, id, key, job });
    if (!request)
      return Promise.resolve({
        ok: false,
        kind: "protocol",
        message: "Viewer input is invalid or exceeds its bounded request shape.",
      });
    const own = (s: import("../../../content/types").ContentSource) => ({
      ...s,
      bytes: s.bytes.slice(),
      hints: { ...s.hints },
    });
    const copied: ViewerRequest = {
      ...request,
      job:
        request.job.kind === "compare"
          ? { ...request.job, left: own(request.job.left), right: own(request.job.right) }
          : { ...request.job, source: own(request.job.source) },
    };
    return new Promise((resolve, reject) => {
      let port: ViewerPort | null = null,
        cleanup: (() => void) | null = null,
        ended = false,
        timer: ReturnType<typeof setTimeout> | null = null,
        slice: ReturnType<typeof setTimeout> | null = null;
      const entry: Active = {
        stop: () => finish({ ok: false, kind: "cancelled", message: "Viewer work was canceled." }),
      };
      function finish(outcome: ViewerResult<ViewerValue> | { readonly unexpected: Error }) {
        if (ended) {
          if ("ok" in outcome && outcome.ok && outcome.value.kind === "raster")
            outcome.value.bitmap.close();
          return;
        }
        ended = true;
        if (timer !== null) clearTimeout(timer);
        if (slice !== null) clearTimeout(slice);
        cleanup?.();
        port?.terminate();
        active.delete(entry);
        bytes -= size;
        signal?.removeEventListener("abort", entry.stop);
        if ("unexpected" in outcome) reject(outcome.unexpected);
        else resolve(outcome);
      }
      bytes += size;
      active.add(entry);
      signal?.addEventListener("abort", entry.stop, { once: true });
      timer = setTimeout(
        () =>
          finish({
            ok: false,
            kind: "timeout",
            message:
              "Viewer reached its 2-second decode/comparison deadline. This is a bounded preview outcome; original bytes remain available.",
          }),
        L.deadlineMs,
      );
      try {
        port = factory();
        cleanup = port.listen(
          (data) => {
            if (ended) {
              closeReply(data);
              return;
            }
            if (
              typeof data === "object" &&
              data !== null &&
              "id" in data &&
              "key" in data &&
              (data.id !== id || data.key !== key)
            ) {
              closeReply(data);
              return;
            }
            const reply = readReply(data);
            if (!reply) {
              closeReply(data);
              finish({
                ok: false,
                kind: "protocol",
                message:
                  "Viewer worker returned an invalid response. Original bytes remain available.",
              });
              return;
            }
            if (reply.kind === "stage") {
              if (slice !== null) clearTimeout(slice);
              slice =
                reply.stage === "decode"
                  ? null
                  : setTimeout(
                      () =>
                        finish({
                          ok: false,
                          kind: "timeout",
                          message:
                            "Viewer phase reached its 100ms processing watchdog. Source and verified download remain available.",
                        }),
                      L.sliceMs,
                    );
              return;
            }
            if (reply.kind === "unexpected") {
              finish({ unexpected: new Error(reply.message) });
              return;
            }
            if (reply.kind === "failed") {
              finish({ ok: false, kind: reply.failure, message: reply.message });
              return;
            }
            const value = reply.value;
            if (
              (job.kind === "json" && (value.kind !== "json" || value.offset !== job.offset)) ||
              (job.kind === "raster" && value.kind !== "raster") ||
              (job.kind === "compare" &&
                value.kind !== (job.format === "json" ? "json-diff" : job.format))
            ) {
              closeReply(data);
              finish({
                ok: false,
                kind: "protocol",
                message: "Viewer worker returned a different projection type or page.",
              });
              return;
            }
            finish({ ok: true, value });
          },
          () =>
            finish({
              ok: false,
              kind: "worker",
              message:
                "Viewer worker could not complete. Original bytes remain available; no retry was made.",
            }),
        );
        const buffers =
          copied.job.kind === "compare"
            ? [copied.job.left.bytes.buffer, copied.job.right.bytes.buffer]
            : [copied.job.source.bytes.buffer];
        port.send(copied, buffers);
      } catch (error: unknown) {
        if (error instanceof DOMException)
          finish({
            ok: false,
            kind: "worker",
            message: `Viewer worker admission failed: ${error.name}.`,
          });
        else
          finish({
            unexpected:
              error instanceof Error ? error : new Error("Unexpected viewer admission failure."),
          });
      }
    });
  }
  async function typed<T extends ViewerValue>(
    job: ViewerJob,
    accept: (value: ViewerValue) => value is T,
    signal?: AbortSignal,
  ): Promise<ViewerResult<T>> {
    const result = await submit(job, signal);
    if (!result.ok) return result;
    if (accept(result.value)) return { ok: true, value: result.value };
    if (result.value.kind === "raster") result.value.bitmap.close();
    return { ok: false, kind: "protocol", message: "Unexpected viewer result type." };
  }
  return {
    json: (source, expanded, offset, signal) =>
      typed(
        { kind: "json", source, expanded, offset },
        (v): v is JsonTree => v.kind === "json",
        signal,
      ),
    raster: (source, signal) =>
      typed({ kind: "raster", source }, (v): v is RasterPreview => v.kind === "raster", signal),
    compare: (left, right, format, signal) =>
      typed(
        { kind: "compare", left, right, format },
        (v): v is Comparison => v.kind !== "json" && v.kind !== "raster",
        signal,
      ),
    dispose: () => {
      disposed = true;
      for (const entry of [...active]) entry.stop();
    },
  };
}
