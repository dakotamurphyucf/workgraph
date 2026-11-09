import { jsonField, type JsonValue } from "../../../core/json";
import { createCompanion } from "../../../core/protocol/client";
import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type { HttpClient, HttpResult } from "../../../core/protocol/http";
import type { Decimal, Identifier, JsonObject, ReadResponse } from "../../../core/protocol/types";
import {
  resourceChunkCodec,
  resourceHistoryCodec,
  resourceListCodec,
  resourceRecordCodec,
} from "./codecs";
import type {
  ResourceCapture,
  ResourceChunk,
  ResourcePage,
  ResourceRecord,
  ResourceScope,
  ResourceTarget,
  ResourceVersion,
} from "./types";

export interface ResourcePageOptions {
  readonly offset?: Decimal;
  readonly atRevision?: Decimal;
  readonly includeArchived?: boolean;
  readonly target?: ResourceTarget;
}
export interface ResourcesClient {
  readonly list: (
    scope: ResourceScope,
    options?: ResourcePageOptions,
    signal?: AbortSignal,
  ) => Promise<HttpResult<ResourceCapture<ResourcePage<ResourceRecord>>>>;
  readonly get: (
    scope: ResourceScope,
    resourceId: Identifier,
    signal?: AbortSignal,
  ) => Promise<HttpResult<ResourceCapture<ResourceRecord>>>;
  readonly history: (
    scope: ResourceScope,
    resourceId: Identifier,
    options?: ResourcePageOptions,
    signal?: AbortSignal,
  ) => Promise<HttpResult<ResourceCapture<ResourcePage<ResourceVersion>>>>;
  readonly version: (
    scope: ResourceScope,
    resourceId: Identifier,
    version: Decimal,
    atRevision: Decimal,
    signal?: AbortSignal,
  ) => Promise<HttpResult<ResourceCapture<ResourceVersion>>>;
  readonly chunk: (
    scope: ResourceScope,
    resourceId: Identifier,
    version: Decimal,
    offset: Decimal,
    signal?: AbortSignal,
  ) => Promise<HttpResult<ResourceChunk>>;
}
const invalid = (message: string): HttpResult<never> => ({
  ok: false,
  failure: { kind: "protocol", message, issue: undefined },
});
function ownedScope(scope: ResourceScope): ResourceScope {
  return Object.freeze({
    connection: Object.freeze({ ...scope.connection }),
    workspaceId: scope.workspaceId,
  });
}
function targetJson(target: ResourceTarget): JsonObject {
  return d.jsonObject([
    ["kind", d.jsonString(target.kind)],
    ...(target.kind === "workspace" ? [] : [["id", d.jsonString(target.id)] as const]),
  ]);
}
function capture<T>(
  scope: ResourceScope,
  response: ReadResponse,
  codec: c.Codec<T>,
  atRevision?: Decimal,
): HttpResult<ResourceCapture<T>> {
  const value = codec.decode(response.response.data);
  if (!value.ok)
    return invalid(
      `Invalid resource response at ${value.issue.path.join(".")}: ${value.issue.expected}.`,
    );
  const revision = d.decimal.decode(jsonField(response.response.meta, "workspace_revision"));
  if (!revision.ok || (atRevision !== undefined && revision.value !== atRevision))
    return invalid("Resource query did not retain its captured planning revision.");
  const budget = jsonField(response.response.meta, "budget");
  let partial = false;
  if (budget !== undefined) {
    const truncated = c.boolean.decode(jsonField(budget, "truncated"));
    const fields = d.decimal.decode(jsonField(budget, "omitted_fields"));
    const items = d.decimal.decode(jsonField(budget, "omitted_items"));
    if (
      !truncated.ok ||
      !fields.ok ||
      !items.ok ||
      truncated.value !== (fields.value !== "0" || items.value !== "0")
    )
      return invalid("Malformed resource byte-budget disclosure.");
    partial = truncated.value;
  }
  const complete =
    response.pagination === null ? undefined : jsonField(response.pagination, "complete");
  if (complete !== undefined) {
    const decoded = c.boolean.decode(complete);
    if (!decoded.ok) return invalid("Malformed resource continuation completeness.");
    partial ||= !decoded.value;
  }
  return {
    ok: true,
    data: Object.freeze({
      scope,
      value: value.value,
      response,
      queryRevision: revision.value,
      partial,
    }),
    httpStatus: 200,
  };
}
/** Every request binds the retained endpoint generation and workspace before yielding.
 * Continuations are rebuilt from typed page offsets, never untrusted next-method metadata. */
export function createResourcesClient(http: HttpClient): ResourcesClient {
  const companion = createCompanion(http);
  async function read(
    scope: ResourceScope,
    method: string,
    extra: readonly (readonly [string, JsonValue])[],
    signal?: AbortSignal,
  ) {
    const owner = ownedScope(scope);
    return companion.read(
      {
        connection_id: owner.connection.id,
        generation: owner.connection.generation,
        method,
        params: d.jsonObject([["workspace_id", d.jsonString(owner.workspaceId)], ...extra]),
        lane: "visible",
      },
      signal,
    );
  }
  function pageParams(options: ResourcePageOptions): readonly (readonly [string, JsonValue])[] {
    return [
      ["limit", d.jsonString("100")],
      ["max_bytes", d.jsonString("1048576")],
      ...(options.offset === undefined ? [] : [["offset", d.jsonString(options.offset)] as const]),
      ...(options.atRevision === undefined
        ? []
        : [["at_revision", d.jsonString(options.atRevision)] as const]),
    ];
  }
  async function page<T>(
    scope: ResourceScope,
    method: string,
    options: ResourcePageOptions,
    extra: readonly (readonly [string, JsonValue])[],
    codec: c.Codec<T>,
    signal?: AbortSignal,
  ): Promise<HttpResult<ResourceCapture<T>>> {
    if (options.offset !== undefined && options.offset !== "0" && options.atRevision === undefined)
      return {
        ok: false,
        failure: {
          kind: "input",
          message: "Resource continuation requires the original planning revision.",
        },
      };
    const owner = ownedScope(scope),
      atRevision = options.atRevision;
    const response = await read(owner, method, [...pageParams(options), ...extra], signal);
    return response.ok ? capture(owner, response.data, codec, atRevision) : response;
  }
  return {
    list: (scope, options = {}, signal) =>
      page(
        scope,
        "resource.list",
        options,
        [
          ["include_archived", d.jsonBoolean(options.includeArchived ?? false)],
          ...(options.target === undefined
            ? []
            : [["target", targetJson(options.target)] as const]),
        ],
        resourceListCodec,
        signal,
      ),
    get: async (scope, id, signal) => {
      const owner = ownedScope(scope),
        response = await read(
          owner,
          "resource.get",
          [
            ["resource_id", d.jsonString(id)],
            ["max_bytes", d.jsonString("1048576")],
          ],
          signal,
        );
      if (!response.ok) return response;
      const result = capture(owner, response.data, resourceRecordCodec);
      return result.ok && result.data.value.resource_id !== id
        ? invalid("Resource metadata response changed the selected resource identity.")
        : result;
    },
    history: (scope, id, options = {}, signal) =>
      page(
        scope,
        "resource.history",
        options,
        [["resource_id", d.jsonString(id)]],
        resourceHistoryCodec,
        signal,
      ),
    version: async (scope, id, version, revision, signal) => {
      // Native Resource.apply enforces consecutive publication versions starting1;
      // Planning_query resource.history returns their ascending order. One exact
      // position is captured, and the actual returned revision is checked below.
      if (version === "0") return invalid("Resource content version must be positive.");
      const offset = d.decimal.decode(d.jsonString((BigInt(version) - 1n).toString()));
      if (!offset.ok) return invalid("Resource version position is outside the native domain.");
      const response = await page(
        scope,
        "resource.history",
        { offset: offset.value, atRevision: revision },
        [["resource_id", d.jsonString(id)]],
        resourceHistoryCodec,
        signal,
      );
      if (!response.ok) return response;
      const found = response.data.value.items.find((item) => item.revision === version);
      return found === undefined
        ? invalid(
            "The exact published content version is unavailable; current content was not substituted.",
          )
        : { ...response, data: { ...response.data, value: found } };
    },
    chunk: async (scope, id, version, offset, signal) => {
      const response = await read(
        scope,
        "resource.read_chunk",
        [
          ["resource_id", d.jsonString(id)],
          ["version", d.jsonString(version)],
          ["offset", d.jsonString(offset)],
          ["length", d.jsonString("262144")],
        ],
        signal,
      );
      if (!response.ok) return response;
      const result = resourceChunkCodec.decode(response.data.response.data);
      if (!result.ok) return invalid(`Invalid resource byte range: ${result.issue.expected}.`);
      if (
        result.value.resource_id !== id ||
        result.value.version !== version ||
        result.value.offset !== offset
      )
        return invalid("Resource byte range changed captured resource/version/offset.");
      return { ok: true, data: result.value, httpStatus: response.httpStatus };
    },
  };
}
