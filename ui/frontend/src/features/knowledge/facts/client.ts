import { jsonField, type JsonValue } from "../../../core/json";
import { createCompanion } from "../../../core/protocol/client";
import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type { HttpClient, HttpResult } from "../../../core/protocol/http";
import type { Decimal, ReadResponse } from "../../../core/protocol/types";
import {
  factKeyCodec,
  factObservationCodec,
  factPageCodec,
  factVersionCodec,
  sameScope,
  scopeJson,
} from "./codecs";
import type {
  FactCapture,
  FactKey,
  FactObservation,
  FactPage,
  FactQuery,
  FactReference,
  FactTarget,
  FactVersion,
} from "./types";

export interface FactPageOptions {
  readonly offset?: Decimal;
  readonly atRevision?: Decimal;
}
export interface FactsClient {
  readonly keys: (
    target: FactTarget,
    query: FactQuery,
    options?: FactPageOptions,
    signal?: AbortSignal,
  ) => Promise<HttpResult<FactCapture<FactPage<FactKey>>>>;
  readonly multiGet: (
    target: FactTarget,
    keys: readonly string[],
    options?: FactPageOptions,
    signal?: AbortSignal,
  ) => Promise<HttpResult<FactCapture<FactPage<FactObservation>>>>;
  readonly history: (
    target: FactTarget,
    key: string,
    options?: FactPageOptions,
    signal?: AbortSignal,
  ) => Promise<HttpResult<FactCapture<FactPage<FactVersion>>>>;
  readonly references: (
    target: FactTarget,
    reference: FactReference,
    options?: FactPageOptions,
    signal?: AbortSignal,
  ) => Promise<HttpResult<FactCapture<FactPage<FactVersion>>>>;
}
export const invalid = (message: string): HttpResult<never> => ({
  ok: false,
  failure: { kind: "protocol", message, issue: undefined },
});
export function ownTarget(target: FactTarget): FactTarget {
  return Object.freeze({
    connection: Object.freeze({ ...target.connection }),
    workspaceId: target.workspaceId,
    scope: Object.freeze({ ...target.scope }),
  });
}
export function decodeCapture<T>(
  target: FactTarget,
  response: ReadResponse,
  codec: c.Codec<T>,
  atRevision?: Decimal,
): HttpResult<FactCapture<T>> {
  const decoded = codec.decode(response.response.data);
  if (!decoded.ok)
    return invalid(
      `Invalid fact response at ${decoded.issue.path.join(".")}: ${decoded.issue.expected}.`,
    );
  const revision = d.decimal.decode(jsonField(response.response.meta, "workspace_revision"));
  if (!revision.ok || (atRevision !== undefined && revision.value !== atRevision))
    return invalid("Fact response changed its captured planning revision.");
  const budget = jsonField(response.response.meta, "budget");
  let partial = false;
  if (budget !== undefined) {
    const truncated = c.boolean.decode(jsonField(budget, "truncated")),
      fields = d.decimal.decode(jsonField(budget, "omitted_fields")),
      items = d.decimal.decode(jsonField(budget, "omitted_items"));
    if (
      !truncated.ok ||
      !fields.ok ||
      !items.ok ||
      truncated.value !== (fields.value !== "0" || items.value !== "0")
    )
      return invalid("Invalid fact byte-budget disclosure.");
    partial = truncated.value;
  }
  return {
    ok: true,
    httpStatus: 200,
    data: Object.freeze({
      target,
      value: decoded.value,
      response,
      revision: revision.value,
      partial,
    }),
  };
}
/** Continuations rebuild only this method's validated selectors; no daemon-supplied method is executed. */
export function createFactsClient(http: HttpClient): FactsClient {
  const companion = createCompanion(http);
  async function page<
    T extends {
      readonly scope: import("./types").FactScope;
      readonly key: string;
      readonly changedAtRevision?: Decimal;
    },
  >(
    target: FactTarget,
    method: string,
    extra: readonly (readonly [string, JsonValue])[],
    codec: c.Codec<T>,
    options: FactPageOptions,
    signal?: AbortSignal,
  ) {
    const owner = ownTarget(target),
      at = options.atRevision,
      position = options.offset ?? "0";
    if (position !== "0" && at === undefined)
      return invalid("Fact continuation requires the original planning capture.");
    const response = await companion.read(
      {
        connection_id: owner.connection.id,
        generation: owner.connection.generation,
        method,
        lane: "visible",
        params: d.jsonObject([
          ["workspace_id", d.jsonString(owner.workspaceId)],
          ["scope", scopeJson(owner.scope)],
          ["limit", d.jsonString("100")],
          ["max_bytes", d.jsonString("1048576")],
          ["offset", d.jsonString(position)],
          ...(at === undefined ? [] : [["at_revision", d.jsonString(at)] as const]),
          ...extra,
        ]),
      },
      signal,
    );
    if (!response.ok) return response;
    const result = decodeCapture(owner, response.data, factPageCodec(codec), at);
    if (!result.ok) return result;
    if (
      result.data.value.offset !== position ||
      result.data.value.items.some(
        (item) =>
          !sameScope(item.scope, owner.scope) ||
          (item.changedAtRevision !== undefined &&
            BigInt(item.changedAtRevision) > BigInt(result.data.revision)),
      )
    )
      return invalid("Fact page changed its scope, offset or planning capture.");
    return result;
  }
  return {
    keys: (target, query, options = {}, signal) =>
      page(
        target,
        "fact.keys",
        [
          ["prefix", d.jsonString(query.prefix)],
          ["include_deleted", d.jsonBoolean(query.includeDeleted)],
          [
            "predicates",
            d.jsonArray(
              query.predicates.map((p) =>
                d.jsonObject([
                  ["pointer", d.jsonString(p.pointer)],
                  ["equals", p.equals],
                ]),
              ),
            ),
          ],
        ],
        factKeyCodec,
        options,
        signal,
      ),
    multiGet: async (target, keys, options = {}, signal) => {
      const captured = Object.freeze([...keys]);
      if (captured.length > 100) return invalid("At most100 fact keys may be read in one batch.");
      const r = await page(
        target,
        "fact.multi_get",
        [["keys", d.jsonArray(captured.map(d.jsonString))]],
        factObservationCodec,
        options,
        signal,
      );
      if (!r.ok) return r;
      const position = BigInt(r.data.value.offset);
      if (position > BigInt(captured.length))
        return invalid("Fact batch offset exceeds its bounded requested key list.");
      const start = Number(position);
      if (
        r.data.value.items.some((item, index) => item.key !== captured[start + index]) ||
        BigInt(r.data.value.remaining) + BigInt(r.data.value.items.length) + BigInt(start) !==
          BigInt(captured.length)
      )
        return invalid(
          "Fact batch changed requested key order/count, including explicit missing records.",
        );
      return r;
    },
    history: async (target, key, options = {}, signal) => {
      const r = await page(
        target,
        "fact.history",
        [["key", d.jsonString(key)]],
        factVersionCodec,
        options,
        signal,
      );
      if (!r.ok) return r;
      if (
        r.data.value.items.some(
          (item, index) =>
            item.key !== key ||
            BigInt(item.revision) !== BigInt(r.data.value.offset) + BigInt(index) + 1n,
        )
      )
        return invalid("Fact history changed key or oldest-first version order.");
      return r;
    },
    references: async (target, reference, options = {}, signal) => {
      const captured = Object.freeze({ ...reference });
      const result = await page(
        target,
        "fact.references",
        [
          [
            "reference",
            d.jsonObject([
              ["kind", d.jsonString(captured.kind)],
              ["id", d.jsonString(captured.id)],
            ]),
          ],
        ],
        factVersionCodec,
        options,
        signal,
      );
      if (!result.ok) return result;
      if (
        result.data.value.items.some(
          (item) =>
            item.kind !== "value" ||
            !item.references.some((ref) => ref.kind === captured.kind && ref.id === captured.id),
        )
      )
        return invalid("Reverse-reference page returned a deleted or unrelated fact.");
      return result;
    },
  };
}
