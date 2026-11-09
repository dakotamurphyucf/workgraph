import type { ContentSource } from "../../../content";
import { createCompanion } from "../../../core/protocol/client";
import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type { HttpClient, HttpResult } from "../../../core/protocol/http";
import { fields } from "./client";
import type { EvidenceTarget } from "./types";
export const pinCodec = fields({
  resource_id: d.identifier,
  revision: d.positiveDecimal,
  digest: d.digest,
});
const resourceCodec = fields({
  resource_id: d.identifier,
  version: d.positiveDecimal,
  digest: d.digest,
  size_bytes: d.decimal,
  text: c.text,
});
type ResourcePin = Extract<ReturnType<typeof pinCodec.decode>, { readonly ok: true }>["value"];
const invalid = (message: string): HttpResult<never> => ({
  ok: false,
  failure: { kind: "protocol", message, issue: undefined },
});
/** Native complete-text endpoint is independently capped at 64 KiB. No current
 * version fallback and no partially verified prefix is admitted as this pin. */
export async function readPinnedResource(
  http: HttpClient,
  target: EvidenceTarget,
  pin: ResourcePin,
  signal: AbortSignal,
): Promise<HttpResult<ContentSource>> {
  const captured = Object.freeze({ ...pin }),
    scope = Object.freeze({ ...target, connection: Object.freeze({ ...target.connection }) }),
    response = await createCompanion(http).read(
      {
        connection_id: scope.connection.id,
        generation: scope.connection.generation,
        method: "resource.read",
        lane: "visible",
        params: d.jsonObject([
          ["workspace_id", d.jsonString(scope.workspaceId)],
          ["resource_id", d.jsonString(captured.resource_id)],
          ["version", d.jsonString(captured.revision)],
        ]),
      },
      signal,
    );
  if (!response.ok) return response;
  const decoded = resourceCodec.decode(response.data.response.data);
  if (!decoded.ok) return invalid("Malformed pinned resource text result.");
  const value = decoded.value;
  if (
    value.resource_id !== captured.resource_id ||
    value.version !== captured.revision ||
    value.digest !== captured.digest ||
    value.text.length > 65536
  )
    return invalid(
      "Resource result changed its pinned identity or exceeds the complete text budget.",
    );
  const bytes = new TextEncoder().encode(value.text);
  if (bytes.byteLength > 65536 || String(bytes.byteLength) !== value.size_bytes)
    return invalid("Pinned resource byte count is inconsistent.");
  // At most 64 KiB is passed to native asynchronous WebCrypto, never a full
  // arbitrary-size main-thread hashing/serialization workload.
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (signal.aborted) return { ok: false, failure: { kind: "aborted" } };
  if (digest !== captured.digest)
    return invalid("Pinned resource bytes failed SHA-256 verification.");
  return {
    ok: true,
    httpStatus: response.httpStatus,
    data: Object.freeze({
      key: JSON.stringify([
        scope.connection.id,
        scope.connection.generation,
        scope.workspaceId,
        captured.resource_id,
        captured.revision,
        captured.digest,
      ]),
      label: `${captured.resource_id} · content version ${captured.revision}`,
      bytes,
      completeness: "complete",
      hints: { intent: "prose" as const },
    }),
  };
}
