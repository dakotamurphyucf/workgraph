import { PayloadBytesError } from "./bytes";
import { createTransferAssembly } from "./transfer-core";
import { transferRequest } from "./transfer-wire";
let assembly: ReturnType<typeof createTransferAssembly> | null = null,
  busy = false,
  finished = false;
self.onmessage = (event: MessageEvent<unknown>) => {
  void (async () => {
    const request = transferRequest(event.data);
    if (request === null || busy || finished)
      throw new PayloadBytesError("Invalid transfer worker request or phase.");
    busy = true;
    try {
      if (request.kind === "begin") {
        if (assembly !== null) throw new PayloadBytesError("Transfer already active.");
        assembly = createTransferAssembly(request.source);
        self.postMessage({ kind: "ready" });
      } else if (request.kind === "chunk") {
        if (assembly === null) throw new PayloadBytesError("Transfer not started.");
        self.postMessage({ kind: "progress", offset: assembly.append(request.chunk) });
      } else {
        if (assembly === null) throw new PayloadBytesError("Transfer not started.");
        const blob = await assembly.finish();
        finished = true;
        self.postMessage({ kind: "complete", blob });
      }
    } finally {
      busy = false;
    }
  })().catch((error: unknown) => {
    if (error instanceof PayloadBytesError)
      self.postMessage({ kind: "failed", message: error.message });
    else
      setTimeout(() => {
        throw error;
      }, 0);
  });
};
