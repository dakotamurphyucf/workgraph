import { PreviewBudget } from "./limits";
import { processContentJob } from "./processor";
import { readWorkerRequest } from "./wire";
import type { WorkerMessage } from "./types";

// Dedicated bundled module worker. No network, DOM, HTML parser, plugins or external grammar loading.
globalThis.addEventListener("message", (event: MessageEvent<unknown>) => {
  const request = readWorkerRequest(event.data);
  if (!request) return;
  const identity = { protocol: 1 as const, jobId: request.jobId, key: request.key };
  const send = (message: WorkerMessage) => {
    globalThis.postMessage(message);
  };
  try {
    const result = processContentJob(request.job, (stage) => {
      send({ ...identity, kind: "stage", stage });
    });
    send({ ...identity, kind: "complete", result });
  } catch (error: unknown) {
    if (error instanceof PreviewBudget)
      send({ ...identity, kind: "failed", failure: "budget", message: error.message });
    else {
      console.error("Unexpected content parser failure.", error);
      send({
        ...identity,
        kind: "failed",
        failure: "parser",
        message: "Content parser failed unexpectedly. Raw source is retained.",
      });
    }
  }
});
