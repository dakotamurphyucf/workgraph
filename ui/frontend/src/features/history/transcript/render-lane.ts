import type {
  ContentWorkerClient,
  ContentPreview,
  RenderRequest,
  WorkOutcome,
} from "../../../content";

/** A transcript can mount a bounded event window at once. Admit its previews
 * serially to the worker; queued requests retain caller-owned immutable bytes,
 * honor cancellation, and never retry a failed render. The lane owns its client. */
export function createTranscriptRenderLane(client: ContentWorkerClient): ContentWorkerClient {
  type Job = {
    request: RenderRequest;
    signal: AbortSignal | undefined;
    resolve: (value: WorkOutcome<ContentPreview>) => void;
    reject: (error: unknown) => void;
    detach: () => void;
  };
  const queue: Job[] = [];
  let active = false,
    disposed = false;
  const cancelled = (): WorkOutcome<ContentPreview> => ({
    ok: false,
    kind: "cancelled",
    message: "Transcript preview was canceled.",
  });
  function pump() {
    if (active || disposed) return;
    const job = queue.shift();
    if (!job) return;
    job.detach();
    if (job.signal?.aborted) {
      job.resolve(cancelled());
      pump();
      return;
    }
    active = true;
    void Promise.resolve()
      .then(() => client.render(job.request, job.signal))
      .then(job.resolve, job.reject)
      .finally(() => {
        active = false;
        pump();
      });
  }
  return {
    render(request, signal) {
      if (disposed || signal?.aborted) return Promise.resolve(cancelled());
      if (queue.length >= 32)
        return Promise.resolve({
          ok: false,
          kind: "busy",
          message: "Too many transcript previews are waiting. Close unused source views and retry.",
        });
      return new Promise((resolve, reject) => {
        const abort = () => {
          const index = queue.indexOf(job);
          if (index >= 0) {
            queue.splice(index, 1);
            job.detach();
            resolve(cancelled());
          }
        };
        const job: Job = {
          request,
          signal,
          resolve,
          reject,
          detach: () => signal?.removeEventListener("abort", abort),
        };
        signal?.addEventListener("abort", abort, { once: true });
        queue.push(job);
        pump();
      });
    },
    decodeJson: (request, signal) => client.decodeJson(request, signal),
    dispose() {
      disposed = true;
      for (const job of queue.splice(0)) {
        job.detach();
        job.resolve(cancelled());
      }
      client.dispose();
    },
  };
}
