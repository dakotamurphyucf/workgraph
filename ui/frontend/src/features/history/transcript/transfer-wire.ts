import * as d from "../../../core/protocol/decoders";
import { blobRef, payloadChunk } from "./codecs";
import type { BlobRef, PayloadChunk } from "./types";
export type TransferRequest =
  | { readonly kind: "begin"; readonly source: BlobRef }
  | { readonly kind: "chunk"; readonly chunk: PayloadChunk }
  | { readonly kind: "finish" };
function record(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return false;
  const keys = Object.keys(value);
  return keys.length === names.length && keys.every((key) => names.includes(key));
}
function blob(value: unknown): BlobRef | null {
  if (
    !record(value, ["digest", "size_bytes"]) ||
    typeof value.digest !== "string" ||
    typeof value.size_bytes !== "string"
  )
    return null;
  const found = blobRef.decode(
    d.jsonObject([
      ["digest", d.jsonString(value.digest)],
      ["size_bytes", d.jsonString(value.size_bytes)],
    ]),
  );
  return found.ok ? found.value : null;
}
/** Closed, fixed-size data-only boundary; unknown kinds never fall through to finish. */
export function transferRequest(value: unknown): TransferRequest | null {
  if (typeof value !== "object" || value === null || !("kind" in value)) return null;
  if (value.kind === "finish" && record(value, ["kind"])) return { kind: "finish" };
  if (value.kind === "begin" && record(value, ["kind", "source"]) && "source" in value) {
    const source = blob(value.source);
    return source === null ? null : { kind: "begin", source };
  }
  if (value.kind === "chunk" && record(value, ["kind", "chunk"]) && "chunk" in value) {
    const part = value.chunk;
    if (
      !record(part, ["blob", "offset", "bytes_base64", "next_offset", "total_bytes", "has_more"]) ||
      typeof part.offset !== "string" ||
      typeof part.bytes_base64 !== "string" ||
      part.bytes_base64.length > 349528 ||
      typeof part.next_offset !== "string" ||
      typeof part.total_bytes !== "string" ||
      typeof part.has_more !== "boolean"
    )
      return null;
    const source = blob(part.blob);
    if (source === null) return null;
    const found = payloadChunk.decode(
      d.jsonObject([
        [
          "blob",
          d.jsonObject([
            ["digest", d.jsonString(source.digest)],
            ["size_bytes", d.jsonString(source.size_bytes)],
          ]),
        ],
        ["offset", d.jsonString(part.offset)],
        ["bytes_base64", d.jsonString(part.bytes_base64)],
        ["next_offset", d.jsonString(part.next_offset)],
        ["total_bytes", d.jsonString(part.total_bytes)],
        ["has_more", d.jsonBoolean(part.has_more)],
      ]),
    );
    return found.ok ? { kind: "chunk", chunk: found.value } : null;
  }
  return null;
}
