import { chunkBytes, PayloadBytesError } from "./bytes";
import type { BlobRef, PayloadChunk } from "./types";
/** Worker-only retained allocation: one 64 MiB assembly plus hash/Blob backing copies, ≤192 MiB transient. */
export function createTransferAssembly(source: BlobRef) {
  const size = Number(source.size_bytes);
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > 67108864 ||
    !/^[a-f0-9]{64}(?![\s\S])/u.test(source.digest)
  )
    throw new PayloadBytesError("Transfer requires a valid ≤64 MiB blob.");
  const bytes = new Uint8Array(size);
  let offset = 0,
    finished = false;
  return {
    append(chunk: PayloadChunk) {
      if (finished) throw new PayloadBytesError("Transfer already completed.");
      const decoded = chunkBytes(chunk, source, offset);
      if (decoded.byteLength === 0 && chunk.has_more)
        throw new PayloadBytesError("Positive-length transfer did not advance.");
      bytes.set(decoded, offset);
      offset += decoded.length;
      return offset;
    },
    async finish() {
      if (finished || offset !== size) throw new PayloadBytesError("Transfer is incomplete.");
      finished = true;
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer)),
        (value) => value.toString(16).padStart(2, "0"),
      ).join("");
      if (digest !== source.digest)
        throw new PayloadBytesError("Complete transfer SHA-256 differs from the pinned blob.");
      return new Blob([bytes.buffer], { type: "application/octet-stream" });
    },
  };
}
