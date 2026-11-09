import { compareSources, complete, jsonValue, projectJsonValue } from "./projection";
import { inspectRaster } from "./raster";
import { ViewerProblem, viewerPhase } from "./limits";
import { readRequest, type ViewerReply } from "./wire";
import type { ViewerValue, ViewerFailureKind } from "./types";
const port = self as unknown as {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: (value: ViewerReply, transfer?: Transferable[]) => void;
};
port.onmessage = (event) => {
  const request = readRequest(event.data);
  if (!request) return;
  const send = (
    reply:
      | { readonly kind: "failed"; readonly failure: ViewerFailureKind; readonly message: string }
      | { readonly kind: "unexpected"; readonly message: string },
  ) => {
    port.postMessage({ ...reply, protocol: 1, id: request.id, key: request.key });
  };
  const stage = (stage: "parse" | "projection" | "diff" | "headers" | "decode") =>
    port.postMessage({ protocol: 1, id: request.id, key: request.key, kind: "stage", stage });
  void (async () => {
    const job = request.job;
    let value: ViewerValue;
    if (job.kind === "json") {
      complete(job.source);
      stage("parse");
      const parsed = viewerPhase(() => jsonValue(job.source.bytes));
      stage("projection");
      value = viewerPhase(() => projectJsonValue(parsed, job.expanded, job.offset));
    } else if (job.kind === "compare") {
      stage("diff");
      value = viewerPhase(() => compareSources(job.left, job.right, job.format));
    } else {
      complete(job.source);
      stage("headers");
      const metadata = viewerPhase(() =>
        inspectRaster(job.source.bytes, job.source.hints.mime ?? ""),
      );
      stage("decode");
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(job.source.bytes)], { type: job.source.hints.mime ?? "" }),
        { imageOrientation: "from-image" },
      );
      const swap = metadata.orientation >= 5;
      const width = swap ? metadata.height : metadata.width,
        height = swap ? metadata.width : metadata.height;
      if (bitmap.width !== width || bitmap.height !== height) {
        bitmap.close();
        throw new ViewerProblem(
          "malformed",
          "Decoded image dimensions disagree with its bounded oriented header.",
        );
      }
      value = { kind: "raster", metadata, bitmap };
    }
    const reply: ViewerReply = {
      protocol: 1,
      id: request.id,
      key: request.key,
      kind: "complete",
      value,
    };
    port.postMessage(reply, value.kind === "raster" ? [value.bitmap] : []);
  })().catch((error: unknown) => {
    if (error instanceof ViewerProblem)
      send({ kind: "failed", failure: error.kind, message: error.message });
    else if (
      error instanceof DOMException &&
      (error.name === "InvalidStateError" || error.name === "EncodingError")
    )
      send({
        kind: "failed",
        failure: "malformed",
        message: "The browser rejected this raster's compressed pixel data.",
      });
    else
      send({
        kind: "unexpected",
        message:
          error instanceof Error
            ? `${error.name}: ${error.message}`.slice(0, 4096)
            : "Unexpected viewer worker exception.",
      });
  });
};
