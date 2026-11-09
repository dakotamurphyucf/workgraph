import { jsonField } from "../../core/json";
import { createCompanion } from "../../core/protocol/client";
import * as c from "../../core/protocol/codec";
import * as d from "../../core/protocol/decoders";
import type { HttpClient, HttpResult } from "../../core/protocol/http";
import type { Decimal, JsonObject, ReadResponse } from "../../core/protocol/types";
import type { Route } from "../../app/types";
import { routeHref } from "../../app/navigation";
import { AnalyticsInputError } from "../history/analytics/model";
import { searchFields, createAnalyticsClient } from "../history/analytics/client";
import { planningRoute } from "../history/scope-navigation/model";
import { createResourcesClient } from "../knowledge/resources/client";
import { resourceRoute } from "../knowledge/resources/navigation";
import { searchPageCodec, text } from "./codecs";
import type { PlanningCapture, PlanningQuery, SearchClient, SearchHit, SearchScope } from "./types";
const invalid = (message: string): HttpResult<never> => ({
  ok: false,
  failure: { kind: "protocol", message, issue: undefined },
});
export function ownScope(scope: SearchScope): SearchScope {
  return Object.freeze({
    connection: Object.freeze({ ...scope.connection }),
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
  });
}
export function ownQuery(query: PlanningQuery): PlanningQuery {
  return Object.freeze({ ...query, kinds: Object.freeze([...query.kinds]) });
}
export function scopeKey(scope: SearchScope) {
  return JSON.stringify([
    scope.connection.id,
    scope.connection.generation,
    scope.connection.socket,
    scope.workspaceId,
    scope.projectId,
  ]);
}
export function queryKey(scope: SearchScope, query: PlanningQuery) {
  return JSON.stringify([
    scopeKey(scope),
    query.text,
    [...query.kinds].sort(),
    query.includeArchived,
  ]);
}
function queryJson(
  scope: SearchScope,
  query: PlanningQuery,
  offset: Decimal,
  atRevision?: Decimal,
): JsonObject {
  return d.jsonObject([
    ["workspace_id", d.jsonString(scope.workspaceId)],
    ["text", d.jsonString(query.text)],
    ["kinds", d.jsonArray(query.kinds.map(d.jsonString))],
    ["include_archived", d.jsonBoolean(query.includeArchived)],
    ["offset", d.jsonString(offset)],
    ["limit", d.jsonString("25")],
    ["max_bytes", d.jsonString("65536")],
    ...(scope.projectId === null ? [] : [["project_id", d.jsonString(scope.projectId)] as const]),
    ...(atRevision === undefined ? [] : [["at_revision", d.jsonString(atRevision)] as const]),
  ]);
}
export function planningCapture(
  scope: SearchScope,
  query: PlanningQuery,
  response: ReadResponse,
  offset: Decimal,
  atRevision?: Decimal,
): HttpResult<PlanningCapture> {
  const page = searchPageCodec.decode(response.response.data),
    revision = d.decimal.decode(jsonField(response.response.meta, "workspace_revision"));
  if (!page.ok || !revision.ok)
    return invalid("Search response is missing validated results, source identities or coverage.");
  if (
    page.value.offset !== offset ||
    page.value.index_revision !== revision.value ||
    (atRevision !== undefined && revision.value !== atRevision) ||
    page.value.items.some(
      (hit) =>
        !query.kinds.includes(hit.source.kind) ||
        (hit.source.kind === "workspace" && hit.source.workspace_id !== scope.workspaceId),
    )
  )
    return invalid("Search changed its captured query revision, offset, kinds or workspace.");
  let partial = false;
  const budget = jsonField(response.response.meta, "budget");
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
      return invalid("Search byte-budget disclosure is malformed.");
    partial = truncated.value;
  }
  if (response.pagination !== null) {
    const complete = c.boolean.decode(jsonField(response.pagination, "complete"));
    if (!complete.ok) return invalid("Search page completeness is malformed.");
    partial ||= !complete.value;
  }
  return {
    ok: true,
    data: Object.freeze({
      scope,
      query,
      revision: revision.value,
      value: page.value,
      response,
      partial,
    }),
    httpStatus: 200,
  };
}
export function destination(scope: SearchScope, hit: SearchHit): Route | null {
  const base = {
    connectionId: scope.connection.id,
    workspaceId: scope.workspaceId,
    projectId: null,
    entityId: null,
  };
  const source = hit.source;
  switch (source.kind) {
    case "workspace":
      return planningRoute({
        connectionId: scope.connection.id,
        generation: scope.connection.generation,
        workspaceId: scope.workspaceId,
        kind: "workspace",
        id: source.workspace_id,
      });
    case "project":
    case "milestone":
    case "ticket":
    case "handoff": {
      const kind = source.kind === "handoff" ? "ticket" : source.kind,
        id =
          source.kind === "project"
            ? source.project_id
            : source.kind === "milestone"
              ? source.milestone_id
              : source.ticket_id;
      return planningRoute({
        connectionId: scope.connection.id,
        generation: scope.connection.generation,
        workspaceId: scope.workspaceId,
        kind,
        id,
      });
    }
    case "comment":
      return {
        ...base,
        view: "discussions",
        entityId: source.comment_id,
        discussion: {
          kind: "comment",
          generation: scope.connection.generation,
          revision: source.revision,
        },
      };
    case "resource":
      return resourceRoute({
        connectionId: scope.connection.id,
        generation: scope.connection.generation,
        workspaceId: scope.workspaceId,
        resourceId: source.resource_id,
        content: null,
      });
    case "resource_text":
      return null; // Descriptor/digest resolution is mandatory, not a current-version fallback.
    case "fact":
      return {
        ...base,
        view: "facts",
        projectId: source.scope.kind === "project" ? source.scope.id : null,
        fact: {
          generation: scope.connection.generation,
          scope: source.scope,
          key: source.key,
          factRevision: source.revision,
          atRevision: null,
        },
      };
  }
}
/** No cached attach qualification: retained profiles are resolved before every explicit invocation. */
export function createSearchClient(http: HttpClient): SearchClient {
  const companion = createCompanion(http),
    analytics = createAnalyticsClient(http),
    resources = createResourcesClient(http);
  const confirm: SearchClient["confirm"] = async (scope, signal) => {
    const profile = await http.request({
      path: `/connections/${encodeURIComponent(scope.connection.id)}/generations/${scope.connection.generation}`,
      method: "GET",
      codec: d.connectionProfile,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!profile.ok) return profile;
    if (
      profile.data.id !== scope.connection.id ||
      profile.data.generation !== scope.connection.generation ||
      profile.data.socket !== scope.connection.socket
    )
      return invalid(
        "The retained connection profile differs from this captured endpoint. No daemon request was sent.",
      );
    return profile;
  };
  return {
    confirm,
    async planning(input, queryInput, offset, atRevision, signal) {
      const scope = ownScope(input),
        query = ownQuery(queryInput);
      if (
        !text(256, true).decode(d.jsonString(query.text)).ok ||
        query.kinds.length === 0 ||
        query.kinds.length > 9 ||
        new Set(query.kinds).size !== query.kinds.length ||
        (offset !== "0" && atRevision === undefined)
      )
        return invalid(
          "Choose nonblank search text ≤256 UTF-8 bytes and distinct kinds; continuation requires its original capture.",
        );
      const profile = await confirm(scope, signal);
      if (!profile.ok) return profile;
      if (signal?.aborted) return { ok: false, failure: { kind: "aborted" } };
      const result = await companion.read(
        {
          connection_id: scope.connection.id,
          generation: scope.connection.generation,
          method: "search.query",
          params: queryJson(scope, query, offset, atRevision),
          lane: "search",
        },
        signal,
      );
      return result.ok ? planningCapture(scope, query, result.data, offset, atRevision) : result;
    },
    async history(input, queryInput, after, signal) {
      const scope = ownScope(input),
        query = Object.freeze({
          ...queryInput,
          kinds: Object.freeze([...queryInput.kinds]),
          capture: Object.freeze({ ...queryInput.capture }),
        });
      try {
        searchFields(query, after);
      } catch (error: unknown) {
        if (error instanceof AnalyticsInputError)
          return { ok: false, failure: { kind: "input", message: error.message } };
        throw error;
      }
      const profile = await confirm(scope, signal);
      if (!profile.ok) return profile;
      if (signal.aborted) return { ok: false, failure: { kind: "aborted" } };
      const result = await analytics.search(
        {
          connectionId: scope.connection.id,
          generation: scope.connection.generation,
          workspaceId: scope.workspaceId,
        },
        query,
        after,
        signal,
      );
      return result.ok
        ? { ...result, data: { scope, requestedQuery: query, value: result.data } }
        : result;
    },
    async resolve(capture, hit, signal) {
      if (!capture.value.items.includes(hit))
        return invalid(
          "This result is not in the retained search page. Run an explicit new search.",
        );
      const scope = ownScope(capture.scope),
        profile = await confirm(scope, signal);
      if (!profile.ok) return profile;
      if (signal?.aborted) return { ok: false, failure: { kind: "aborted" } };
      let route = destination(scope, hit);
      if (hit.source.kind === "resource_text") {
        const target = { connection: scope.connection, workspaceId: scope.workspaceId },
          meta = await resources.get(target, hit.source.resource_id, signal);
        if (!meta.ok) return meta;
        if (signal?.aborted) return { ok: false, failure: { kind: "aborted" } };
        const version = await resources.version(
          target,
          hit.source.resource_id,
          hit.source.revision,
          meta.data.queryRevision,
          signal,
        );
        if (!version.ok) return version;
        if (signal?.aborted) return { ok: false, failure: { kind: "aborted" } };
        if (version.data.partial || version.data.value.revision !== hit.source.revision)
          return invalid(
            "The exact content descriptor is unavailable or incomplete; current content was not substituted.",
          );
        route = resourceRoute({
          connectionId: scope.connection.id,
          generation: scope.connection.generation,
          workspaceId: scope.workspaceId,
          resourceId: hit.source.resource_id,
          content: {
            version: version.data.value.revision,
            expectedDigest: version.data.value.digest,
          },
        });
      }
      if (route === null) return invalid("This typed source has no supported destination.");
      routeHref(route);
      return { ok: true, data: route, httpStatus: 200 };
    },
  };
}
