import { chunkBytes, PayloadBytesError } from "../../history/transcript/bytes";
import {
  createVerifiedTransfer,
  type TransferResult,
  type VerifiedTransfer,
} from "../../history/transcript/transfer";
import type { PayloadChunk } from "../../history/transcript/types";
import type { HttpResult } from "../../../core/protocol/http";
import * as d from "../../../core/protocol/decoders";
import type { Decimal } from "../../../core/protocol/types";
import type { ResourcesClient } from "./client";
import type { ResourceChunk, ResourcePin } from "./types";

const invalid = (message: string): HttpResult<never> => ({
  ok: false,
  failure: { kind: "protocol", message, issue: undefined },
});
/** A bounded range's hash is independent from the complete content hash. WebCrypto
 * performs hashing asynchronously; full-file assembly/hash stays in the existing worker. */
export async function adaptResourceChunk(
  pin: ResourcePin,
  chunk: ResourceChunk,
  offset: Decimal,
): Promise<HttpResult<PayloadChunk>> {
  if (
    chunk.resource_id !== pin.resourceId ||
    chunk.version !== pin.version ||
    chunk.digest !== pin.digest ||
    chunk.size_bytes !== pin.sizeBytes ||
    chunk.offset !== offset
  )
    return invalid("Resource range differs from the immutable selected content pin.");
  const payload: PayloadChunk = {
    blob: { digest: pin.digest, size_bytes: pin.sizeBytes },
    offset: chunk.offset,
    bytes_base64: chunk.data_base64,
    next_offset: chunk.next_offset ?? pin.sizeBytes,
    total_bytes: pin.sizeBytes,
    has_more: !chunk.eof,
  };
  let bytes: Uint8Array;
  try {
    bytes = chunkBytes(payload, payload.blob, Number(offset));
  } catch (error) {
    if (error instanceof PayloadBytesError) return invalid(error.message);
    throw error;
  }
  const chunkSize = String(bytes.byteLength);
  // A byte length from a <=256KiB validated range is exactly representable. Reuse
  // the already validated native decimal identity rather than admit arbitrary numeric input.
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer)),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
  if (digest !== chunk.chunk_digest)
    return invalid(`Resource range SHA-256 differs (${chunkSize} bytes).`);
  return { ok: true, data: payload, httpStatus: 200 };
}
export interface ResourceTransfer {
  readonly download: (
    pin: ResourcePin,
    progress: (received: number, total: number) => void,
    signal?: AbortSignal,
  ) => Promise<TransferResult>;
  readonly dispose: () => void;
}
/** One worker-owned <=64MiB complete transfer, existing absolute300s bound.
 * Supplier closes over frozen endpoint/workspace/content identity, never route state. */
export function createResourceTransfer(
  client: ResourcesClient,
  transfer: VerifiedTransfer = createVerifiedTransfer(),
): ResourceTransfer {
  return {
    download: (pin, progress, signal) => {
      const captured: ResourcePin = Object.freeze({
        ...pin,
        connection: Object.freeze({ ...pin.connection }),
      });
      return transfer.download(
        { digest: captured.digest, size_bytes: captured.sizeBytes },
        {
          read: async (offset, abort) => {
            // The worker only requests exact offsets in this validated <=64MiB domain.
            const position = d.decimal.decode(d.jsonString(offset));
            if (!position.ok || Number(position.value) > Number(captured.sizeBytes))
              return invalid("Resource transfer requested an invalid byte offset.");
            const parsed = await client.chunk(
              captured,
              captured.resourceId,
              captured.version,
              position.value,
              abort,
            );
            if (!parsed.ok) return parsed;
            const adapted = await adaptResourceChunk(captured, parsed.data, position.value);
            return abort.aborted ? { ok: false, failure: { kind: "aborted" } } : adapted;
          },
        },
        progress,
        signal,
      );
    },
    dispose: () => transfer.dispose(),
  };
}
