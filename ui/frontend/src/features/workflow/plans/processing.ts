import type { JsonValue } from "../../../core/json";
import * as d from "../../../core/protocol/decoders";
import type { ProtocolProcessor } from "../../../core/protocol/worker";
import type { Digest } from "../../../core/protocol/types";
import { PlanInputError } from "./model";

export const RECORD_LIMITS = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxDepth: 96,
  maxNodes: 400_000,
  maxStringBytes: 16 * 1024 * 1024,
});
export const PLAN_JSON_LIMITS = Object.freeze({
  ...RECORD_LIMITS,
  maxBytes: 4 * 1024 * 1024,
  maxStringBytes: 4 * 1024 * 1024,
});
function issue(kind: string, message: string): never {
  if (kind === "aborted")
    throw new DOMException("Obsolete plan processing cancelled.", "AbortError");
  throw new PlanInputError(message);
}
export async function parseSource(
  processing: ProtocolProcessor,
  source: string,
  signal?: AbortSignal,
  record = false,
): Promise<JsonValue> {
  const parsed = await processing.parse(source, {
    limits: record ? RECORD_LIMITS : PLAN_JSON_LIMITS,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!parsed.ok) issue(parsed.failure.kind, parsed.failure.message);
  if (!parsed.value.ok) throw new PlanInputError(parsed.value.error.message);
  return parsed.value.value.value;
}
export async function encodeValue(
  processing: ProtocolProcessor,
  value: JsonValue,
  signal?: AbortSignal,
): Promise<string> {
  const encoded = await processing.encode(value, {
    canonical: true,
    limits: RECORD_LIMITS,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!encoded.ok) issue(encoded.failure.kind, encoded.failure.message);
  if (!encoded.value.ok) throw new PlanInputError(encoded.value.error.message);
  return encoded.value.value;
}
/** Domain separated plan/review hashes are not native request or receipt identity. */
export async function hashValue(
  processing: ProtocolProcessor,
  domain: "plan" | "review" | "journal",
  value: JsonValue,
  signal?: AbortSignal,
): Promise<Digest> {
  const source = await encodeValue(processing, value, signal);
  if (signal?.aborted) throw new DOMException("Obsolete hash cancelled.", "AbortError");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`workgraph-ui-${domain}-1\n${source}`),
  );
  if (signal?.aborted) throw new DOMException("Obsolete hash cancelled.", "AbortError");
  const hex = Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join("");
  const decoded = d.digest.decode(d.jsonString(hex));
  if (!decoded.ok) throw new Error("SHA-256 output invariant");
  return decoded.value;
}
