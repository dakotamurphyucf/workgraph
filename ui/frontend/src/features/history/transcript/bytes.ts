import type { BlobRef, PayloadChunk } from "./types";
export class PayloadBytesError extends Error {}
/** Bounded prefix/chunk decoding only. Full-file decoding/assembly is worker-owned. */
export function chunkBytes(
  chunk: PayloadChunk,
  expected: BlobRef,
  offset: number,
  maximum = 262144,
): Uint8Array {
  if (
    chunk.blob.digest !== expected.digest ||
    chunk.blob.size_bytes !== expected.size_bytes ||
    chunk.total_bytes !== expected.size_bytes ||
    chunk.offset !== String(offset)
  )
    throw new PayloadBytesError("Payload changed its pinned blob or byte offset.");
  const encoded = chunk.bytes_base64;
  if (
    encoded.length > Math.ceil(maximum / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?(?![\s\S])/u.test(encoded)
  )
    throw new PayloadBytesError("Payload chunk is not bounded canonical Base64.");
  const binary = atob(encoded);
  if (
    btoa(binary) !== encoded ||
    binary.length > maximum ||
    offset + binary.length !== Number(chunk.next_offset) ||
    Number(chunk.next_offset) > Number(expected.size_bytes) ||
    chunk.has_more !== (chunk.next_offset !== expected.size_bytes)
  )
    throw new PayloadBytesError("Payload chunk byte count or continuation is inconsistent.");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
export async function verified(bytes: Uint8Array, blob: BlobRef): Promise<boolean> {
  if (bytes.byteLength !== Number(blob.size_bytes)) return false;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer),
  );
  return (
    Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("") === blob.digest
  );
}
