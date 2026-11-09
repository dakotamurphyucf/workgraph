// Explicit test worker: prove the main-thread watchdog terminates actual blocked computation.
globalThis.addEventListener("message", (event: MessageEvent<unknown>) => {
  const data = event.data;
  if (typeof data !== "object" || data === null || !("jobId" in data) || !("key" in data)) return;
  globalThis.postMessage({
    protocol: 1,
    jobId: data.jobId,
    key: data.key,
    kind: "stage",
    stage: "markdown",
  });
  const until = performance.now() + 5000;
  while (performance.now() < until) {
    /* Deliberately blocked only in this isolated qualification fixture. */
  }
});
