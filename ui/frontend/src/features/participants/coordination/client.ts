import { jsonField, type JsonValue } from "../../../core/json";
import { createCompanion } from "../../../core/protocol/client";
import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type { HttpClient, HttpResult } from "../../../core/protocol/http";
import type {
  Decimal,
  JsonObject,
  ReadInvocation,
  ReadResponse,
} from "../../../core/protocol/types";
import { fields } from "./codecs";
import type { CoordinationPage, CoordinationScope } from "./types";

export const LISTS = [
  "allocation.pools",
  "allocation.ticket_policies",
  "ticket.paths.list",
  "reservation.list",
  "reservation.path.list",
  "condition.list",
  "condition.signals",
  "recovery.list",
  "ticket.recovery.list",
] as const;
export type CoordinationList = (typeof LISTS)[number];
export const invalid = (message: string): HttpResult<never> => ({
  ok: false,
  failure: { kind: "protocol", message, issue: undefined },
});
const success = <T>(data: T): HttpResult<T> => ({ ok: true, data, httpStatus: 200 });
const text = (value: JsonValue | undefined) => (value?.kind === "string" ? value.value : undefined);
export function invocation(
  scope: CoordinationScope,
  method: string,
  extra: readonly (readonly [string, JsonValue])[] = [],
): ReadInvocation {
  if (extra.some(([name]) => name === "workspace_id"))
    throw new Error("Captured workspace must not be overridden by selectors.");
  return Object.freeze({
    connection_id: scope.connection.id,
    generation: scope.connection.generation,
    method,
    params: d.jsonObject([["workspace_id", d.jsonString(scope.workspaceId)], ...extra]),
    lane: "visible",
  });
}
function replace(params: JsonObject, items: readonly (readonly [string, JsonValue])[]): JsonObject {
  const names = new Set(items.map(([name]) => name));
  return d.jsonObject([
    ...params.fields
      .filter((field) => !names.has(field.name))
      .map((field) => [field.name, field.value] as const),
    ...items,
  ]);
}
export function complete(response: ReadResponse): HttpResult<boolean> {
  const budget = jsonField(response.response.meta, "budget");
  if (budget === undefined) return success(true);
  const decoded = fields({
    omitted_items: d.decimal,
    omitted_fields: d.decimal,
    truncated: c.boolean,
    details_complete: c.boolean,
  }).decode(budget);
  if (!decoded.ok) return invalid("Missing or malformed coordination completeness budget.");
  const v = decoded.value;
  if (v.truncated !== (v.omitted_items !== "0" || v.omitted_fields !== "0"))
    return invalid("Coordination omission counts disagree with truncation.");
  return success(!v.truncated && v.details_complete);
}
export function decodePage(
  scope: CoordinationScope,
  request: ReadInvocation,
  response: ReadResponse,
): HttpResult<CoordinationPage> {
  if (
    request.connection_id !== scope.connection.id ||
    request.generation !== scope.connection.generation ||
    text(jsonField(request.params, "workspace_id")) !== scope.workspaceId
  )
    return invalid("Coordination read changed its captured endpoint or workspace.");
  if (!LISTS.some((method) => method === request.method))
    return invalid("Unknown coordination list selector.");
  const namespace = "runs" as const,
    metadata = fields({ query_scope: c.literal(namespace), query_revision: d.decimal }).decode(
      response.response.meta,
    ),
    page = fields({
      items: c.array(c.object, 100),
      next_offset: c.nullable(d.decimal),
      omitted: d.decimal,
    }).decode(response.response.data),
    completeness = complete(response);
  if (!metadata.ok || !page.ok)
    return invalid("Coordination list is missing its namespace capture or bounded page fields.");
  if (!completeness.ok) return completeness;
  const revision = metadata.value.query_revision,
    guarded = jsonField(request.params, "expected_revision"),
    offset = d.decimal.decode(jsonField(request.params, "offset") ?? d.jsonString("0"));
  if (!offset.ok || (guarded !== undefined && text(guarded) !== revision))
    return invalid("Coordination page changed its expected revision or offset.");
  const v = page.value,
    next = v.next_offset;
  if (
    (next === null) !== (v.omitted === "0") ||
    (next !== null &&
      (v.items.length === 0 || BigInt(next) !== BigInt(offset.value) + BigInt(v.items.length)))
  )
    return invalid("Coordination page does not advance through its captured rows.");
  const continuation =
    next === null
      ? null
      : Object.freeze({
          ...request,
          params: replace(request.params, [
            ["offset", d.jsonString(next)],
            ["expected_revision", d.jsonString(revision)],
          ]),
        });
  return success(
    Object.freeze({
      scope,
      invocation: request,
      response,
      items: v.items,
      revision,
      namespace,
      continuation,
      completeness: completeness.data ? (continuation === null ? "complete" : "more") : "partial",
      warning: completeness.data
        ? null
        : "Some fields/items were omitted. This capture cannot prove an absent record.",
    }),
  );
}
export function createCoordinationClient(http: HttpClient) {
  const companion = createCompanion(http);
  const read = companion.read;
  const page = async (scope: CoordinationScope, request: ReadInvocation, signal: AbortSignal) => {
    const result = await read(request, signal);
    return result.ok ? decodePage(scope, request, result.data) : result;
  };
  return {
    read,
    page,
    /** Absence is admitted only after bounded traversal of a complete exact
     * catalog. Any partial page/revision change stops guard discovery. */
    lookup: async <T>(
      scope: CoordinationScope,
      method: CoordinationList,
      codec: c.Codec<T>,
      matches: (value: T) => boolean,
      signal: AbortSignal,
      extra: readonly (readonly [string, JsonValue])[] = [],
    ): Promise<HttpResult<{ readonly value: T | null; readonly revision: Decimal }>> => {
      let request = invocation(scope, method, [
        ["limit", d.jsonString("100")],
        ["max_bytes", d.jsonString("1048576")],
        ...extra,
      ]);
      let found: T | null = null;
      for (let count = 0; count < 100; count++) {
        if (signal.aborted) return { ok: false, failure: { kind: "aborted" } };
        const result = await page(scope, request, signal);
        if (!result.ok) return result;
        if (result.data.completeness === "partial")
          return invalid(
            "The incomplete catalog cannot supply an existence guard; inspect or retry with a complete capture.",
          );
        for (const row of result.data.items) {
          const decoded = codec.decode(row);
          if (!decoded.ok) return invalid("Malformed coordination record in guard discovery.");
          if (matches(decoded.value)) {
            if (found !== null) return invalid("Coordination catalog repeated an exact identity.");
            found = decoded.value;
          }
        }
        if (result.data.continuation === null)
          return success({ value: found, revision: result.data.revision });
        request = result.data.continuation;
      }
      return invalid(
        "Coordination catalog exceeds the bounded 100-page guard discovery limit; no absence was inferred.",
      );
    },
  };
}
