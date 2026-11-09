/// <reference lib="webworker" />
import { digestUploadBlob } from "./upload-digest.core";
const scope = self as DedicatedWorkerGlobalScope;
let busy = false;
scope.onmessage = (event: MessageEvent<unknown>) => {
  const input = event.data;
  if (
    busy ||
    typeof input !== "object" ||
    input === null ||
    Object.keys(input).sort().join(",") !== "blob,kind" ||
    !("kind" in input) ||
    input.kind !== "hash" ||
    !("blob" in input) ||
    !(input.blob instanceof Blob) ||
    input.blob.size > 67108864
  ) {
    scope.postMessage({
      kind: "failed",
      name: "ProtocolError",
      message: "Invalid bounded source hash request.",
    });
    return;
  }
  busy = true;
  void digestUploadBlob(input.blob)
    .then((reply) => scope.postMessage(reply))
    .catch((error: unknown) => {
      queueMicrotask(() => {
        throw error;
      });
    });
};
