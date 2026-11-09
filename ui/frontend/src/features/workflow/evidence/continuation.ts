import { jsonField } from "../../../core/json";
import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type { JsonObject, ReadResponse } from "../../../core/protocol/types";
import type { ProtocolProcessor } from "../../../core/protocol/worker";
import { HTTP_LIMITS } from "../../../core/protocol/worker/jobs";
import { EvidenceInputError, objectFields } from "./model";
import type { EvidenceRead, EvidenceTarget } from "./types";
const request = c.record({
  jsonrpc: c.literal("2.0"),
  workgraph_api: c.literal("0.7"),
  id: c.text,
  method: c.text,
  params: c.object,
});
const compare = (left: string, right: string) =>
  left.length === right.length
    ? left === right
      ? 0
      : left < right
        ? -1
        : 1
    : left.length < right.length
      ? -1
      : 1;
function counter(value: import("../../../core/json").JsonValue | undefined, name: string): string {
  const result = d.decimal.decode(value);
  if (!result.ok) throw new EvidenceInputError(`Malformed continuation ${name}.`);
  return result.value;
}
/** A continuation can advance only this exact native read and namespace capture.
 * No alternate read method, target or newly supplied selector is admitted. */
export async function continuation(
  processing: ProtocolProcessor,
  target: EvidenceTarget,
  method: EvidenceRead,
  params: JsonObject,
  response: ReadResponse,
  kind: "next_request" | "retry_request",
  signal: AbortSignal,
): Promise<JsonObject> {
  const page = response.pagination;
  if (page === null) throw new EvidenceInputError("No continuation is available.");
  const next = request.decode(jsonField(page, kind));
  if (!next.ok || next.value.method !== method)
    throw new EvidenceInputError("Continuation changed the original read method.");
  const meta = response.response.meta,
    scope = jsonField(meta, "query_scope"),
    revision = counter(jsonField(meta, "query_revision"), "query revision"),
    capture = jsonField(page, "capture");
  const expectedScope = method.startsWith("condition.") ? "runs" : "evidence";
  if (
    scope?.kind !== "string" ||
    scope.value !== expectedScope ||
    capture?.kind !== "object" ||
    jsonField(capture, "query_scope")?.kind !== "string" ||
    counter(jsonField(capture, "query_revision"), "capture") !== revision ||
    jsonField(capture, "query_scope")?.kind !== "string" ||
    getText(capture, "query_scope") !== expectedScope ||
    getText(page, "consistency") !== "current_revision_guard"
  )
    throw new EvidenceInputError("Continuation does not match the returned namespace capture.");
  const guard = expectedScope === "runs" ? "expected_revision" : "revision",
    nextParams = next.value.params;
  if (
    counter(jsonField(nextParams, guard), "revision guard") !== revision ||
    getText(nextParams, "workspace_id") !== target.workspaceId
  )
    throw new EvidenceInputError("Continuation changed the requested workspace or revision.");
  const excluded = new Set(["offset", guard, "max_bytes"]),
    allowed = new Set([...params.fields.map((item) => item.name), "offset", guard, "max_bytes"]);
  if (!nextParams.fields.every((item) => allowed.has(item.name)))
    throw new EvidenceInputError("Continuation introduced a query selector.");
  const filtered = (value: JsonObject) =>
    d.jsonObject(objectFields(value).filter(([name]) => !excluded.has(name)));
  const encode = async (value: JsonObject) => {
    const result = await processing.encode(value, { canonical: true, limits: HTTP_LIMITS, signal });
    if (!result.ok) throw new EvidenceInputError(result.failure.message);
    if (!result.value.ok) throw new EvidenceInputError(result.value.error.message);
    return result.value.value;
  };
  if ((await encode(filtered(params))) !== (await encode(filtered(nextParams))))
    throw new EvidenceInputError("Continuation changed exact target selectors.");
  const oldBytes =
      jsonField(params, "max_bytes") === undefined
        ? "65536"
        : counter(jsonField(params, "max_bytes"), "original byte budget"),
    newBytes = counter(jsonField(nextParams, "max_bytes"), "byte budget");
  if (
    compare(newBytes, "1048576") > 0 ||
    compare(newBytes, oldBytes) < 0 ||
    (kind === "next_request" && newBytes !== oldBytes)
  )
    throw new EvidenceInputError("Continuation changed the admitted byte budget.");
  const oldOffset =
      jsonField(params, "offset") === undefined
        ? "0"
        : counter(jsonField(params, "offset"), "original offset"),
    newOffset = counter(jsonField(nextParams, "offset"), "offset");
  if (
    kind === "retry_request"
      ? newOffset !== oldOffset
      : newOffset !==
          counter(jsonField(response.response.data, "next_offset"), "returned next offset") ||
        compare(newOffset, oldOffset) <= 0
  )
    throw new EvidenceInputError("Continuation cursor does not match the original page.");
  return nextParams;
}
function getText(value: JsonObject, name: string): string {
  const field = jsonField(value, name);
  return field?.kind === "string" ? field.value : "";
}
