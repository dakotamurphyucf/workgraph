import { jsonField, type JsonValue } from "../../../core/json";
import { createCompanion } from "../../../core/protocol/client";
import * as d from "../../../core/protocol/decoders";
import type { HttpClient, HttpResult } from "../../../core/protocol/http";
import type { Decimal, ReadInvocation, ReadResponse } from "../../../core/protocol/types";
import { invalid, historyParams } from "../transcript/client";
import { historyCapture } from "../transcript/codecs";
import type { EventRef, HistoryScope } from "../transcript/types";
import * as codec from "./codecs";
import { AnalyticsInputError, bounded, counter, identifier } from "./model";
import type {
  PlanningCapture,
  SearchCapture,
  SearchQuery,
  UsageAggregate,
  UsagePage,
  UsageQuery,
} from "./types";
function compareEvent(a: EventRef, b: EventRef): number {
  return a.session_id < b.session_id
    ? -1
    : a.session_id > b.session_id
      ? 1
      : BigInt(a.sequence) < BigInt(b.sequence)
        ? -1
        : BigInt(a.sequence) > BigInt(b.sequence)
          ? 1
          : 0;
}

export function searchFields(query: SearchQuery, after: EventRef | null = null) {
  bounded(query.text, "Search text", 256);
  if (query.text === "") throw new AnalyticsInputError("Enter nonempty search text.");
  counter(query.maxBytes, "Search byte budget", 4096n, 1048576n);
  if (query.kinds.length > 100)
    throw new AnalyticsInputError("At most 100 event kinds may be selected.");
  return [
    ["text", d.jsonString(query.text)],
    ["limit", d.jsonString(counter(query.limit, "Search page size", 1n, 100n))],
    ...(query.sessionId === ""
      ? []
      : [["session_id", d.jsonString(identifier(query.sessionId, "Session filter"))] as const]),
    ...(query.kinds.length === 0
      ? []
      : [
          [
            "kinds",
            d.jsonArray(query.kinds.map((kind) => d.jsonString(bounded(kind, "Event kind", 256)))),
          ] as const,
        ]),
    ...(after === null
      ? []
      : [
          [
            "after_event",
            d.jsonObject([
              ["session_id", d.jsonString(after.session_id)],
              ["sequence", d.jsonString(after.sequence)],
            ]),
          ] as const,
        ]),
  ] as const;
}
export function searchInvocation(
  scope: HistoryScope,
  query: SearchQuery,
  after: EventRef | null = null,
): ReadInvocation {
  const base = historyParams(scope, query.capture, searchFields(query, after));
  return {
    connection_id: scope.connectionId,
    generation: scope.generation,
    method: "history.search",
    lane: "search",
    params: d.jsonObject([
      ...base.fields.filter((f) => f.name !== "max_bytes").map((f) => [f.name, f.value] as const),
      ["max_bytes", d.jsonString(counter(query.maxBytes, "Search byte budget", 4096n, 1048576n))],
    ]),
  };
}
export function usageInvocation(
  scope: HistoryScope,
  query: UsageQuery,
  cursor?: string,
  revision?: Decimal,
): ReadInvocation {
  const entries: [string, JsonValue][] = [
    ["workspace_id", d.jsonString(scope.workspaceId)],
    ["group_by", d.jsonString(query.group)],
    ["metrics_layout", d.jsonString(query.layout)],
    ["limit", d.jsonString(counter(query.limit, "Usage page size", 1n, 100n))],
    ["max_bytes", d.jsonString(counter(query.maxBytes, "Usage byte budget", 4096n, 1048576n))],
  ];
  for (const [key, value] of [
    ["project_id", query.projectId],
    ["milestone_id", query.milestoneId],
    ["ticket_id", query.ticketId],
    ["run_id", query.runId],
    ["attempt_id", query.attemptId],
    ["actor_id", query.actorId],
  ] as const)
    if (value !== "") entries.push([key, d.jsonString(identifier(value, key))]);
  if (cursor !== undefined) entries.push(["cursor", d.jsonString(cursor)]);
  if (revision !== undefined) entries.push(["at_revision", d.jsonString(revision)]);
  return {
    connection_id: scope.connectionId,
    generation: scope.generation,
    method: "usage.aggregate",
    params: d.jsonObject(entries),
    lane: "visible",
  };
}
/** Compare selection against the actual saved request, never a mutable editor or
 * last attempted filter. Page size/byte budget may change at the same cursor. */
export function usageQueryMatches(
  request: ReadInvocation,
  scope: HistoryScope,
  query: UsageQuery,
): boolean {
  if (
    request.method !== "usage.aggregate" ||
    request.connection_id !== scope.connectionId ||
    request.generation !== scope.generation
  )
    return false;
  const wanted = [
    ["workspace_id", scope.workspaceId],
    ["group_by", query.group],
    ["metrics_layout", query.layout],
    ["project_id", query.projectId],
    ["milestone_id", query.milestoneId],
    ["ticket_id", query.ticketId],
    ["run_id", query.runId],
    ["attempt_id", query.attemptId],
    ["actor_id", query.actorId],
  ] as const;
  return wanted.every(([name, value]) => {
    const original = jsonField(request.params, name);
    return value === ""
      ? original === undefined
      : original?.kind === "string" && original.value === value;
  });
}
export function recordsInvocation(
  scope: HistoryScope,
  offset?: Decimal,
  revision?: Decimal,
): ReadInvocation {
  return {
    connection_id: scope.connectionId,
    generation: scope.generation,
    method: "usage.list",
    lane: "visible",
    params: d.jsonObject([
      ["workspace_id", d.jsonString(scope.workspaceId)],
      ["limit", d.jsonString("25")],
      ["max_bytes", d.jsonString("1048576")],
      ...(offset === undefined ? [] : [["offset", d.jsonString(offset)] as const]),
      ...(revision === undefined ? [] : [["expected_revision", d.jsonString(revision)] as const]),
    ]),
  };
}
export function decodeUsage(
  request: ReadInvocation,
  response: ReadResponse,
): HttpResult<PlanningCapture<UsageAggregate> | PlanningCapture<UsagePage>> {
  const raw = response.response.data,
    meta = response.response.meta;
  if (request.method !== "usage.list" && request.method !== "usage.aggregate")
    return invalid("This is not a typed usage query.");
  if (request.method === "usage.list") {
    const data = codec.usagePage.decode(raw),
      m = codec.policyMeta.decode(meta);
    if (!data.ok || !m.ok) return invalid("Malformed reported-usage catalog or policy capture.");
    const expected = jsonField(request.params, "expected_revision"),
      offset = jsonField(request.params, "offset");
    if (expected?.kind === "string" && expected.value !== m.value.query_revision)
      return invalid("Usage catalog changed its captured policy revision.");
    const start = offset?.kind === "string" ? BigInt(offset.value) : 0n;
    if (
      data.value.next_offset !== null &&
      (BigInt(data.value.next_offset) !== start + BigInt(data.value.items.length) ||
        data.value.items.length === 0)
    )
      return invalid("Usage catalog continuation did not advance by its complete records.");
    return {
      ok: true,
      data: { data: data.value, revision: m.value.query_revision, raw, meta, invocation: request },
      httpStatus: 200,
    };
  }
  const data = codec.aggregate.decode(raw),
    m = codec.planningMeta.decode(meta);
  if (!data.ok || !m.ok)
    return invalid("Malformed usage aggregate, metric layout, or planning capture.");
  const expected = jsonField(request.params, "at_revision"),
    group = jsonField(request.params, "group_by"),
    layout = jsonField(request.params, "metrics_layout");
  if (
    (expected?.kind === "string" && expected.value !== m.value.workspace_revision) ||
    (group?.kind === "string" && group.value !== data.value.group_by) ||
    (layout?.kind === "string" && layout.value !== data.value.metrics_layout)
  )
    return invalid("Usage aggregate changed its requested membership capture or layout.");
  return {
    ok: true,
    data: {
      data: data.value,
      revision: m.value.workspace_revision,
      raw,
      meta,
      invocation: request,
    },
    httpStatus: 200,
  };
}
export function createAnalyticsClient(http: HttpClient) {
  const companion = createCompanion(http);
  return {
    async search(
      scope: HistoryScope,
      query: SearchQuery,
      after: EventRef | null,
      signal: AbortSignal,
    ): Promise<HttpResult<SearchCapture>> {
      const result = await companion.read(searchInvocation(scope, query, after), signal);
      if (!result.ok) return result;
      const data = codec.searchPage.decode(result.data.response.data),
        capture = historyCapture.decode(jsonField(result.data.response.meta, "history_capture"));
      if (!data.ok || !capture.ok)
        return invalid("Invalid history search response or immutable capture.");
      if (
        capture.value.workspace_id !== scope.workspaceId ||
        (query.capture.kind === "pinned" && capture.value.head !== query.capture.head)
      )
        return invalid("Search changed the requested workspace or immutable head.");
      const throughById = new Map(capture.value.sessions.map((v) => [v.session_id, v.through]));
      if (
        data.value.coverage.length !== throughById.size ||
        new Set(data.value.coverage.map((v) => v.session_id)).size !== throughById.size ||
        data.value.coverage.some((v) => throughById.get(v.session_id) !== v.committed_through)
      )
        return invalid("Search coverage does not describe the exact captured session vector.");
      let previous = after;
      for (const hit of data.value.items) {
        const through = capture.value.sessions.find(
          (v) => v.session_id === hit.event_ref.session_id,
        )?.through;
        if (
          through === undefined ||
          BigInt(hit.event_ref.sequence) > BigInt(through) ||
          (query.sessionId !== "" && query.sessionId !== hit.event_ref.session_id) ||
          (query.kinds.length > 0 && !query.kinds.includes(hit.kind)) ||
          (previous !== null && compareEvent(previous, hit.event_ref) >= 0)
        )
          return invalid("Search hit escaped its requested filter or immutable capture.");
        previous = hit.event_ref;
      }
      const next = data.value.next;
      if (
        next !== null &&
        (throughById.get(next.session_id) === undefined ||
          BigInt(next.sequence) > BigInt(throughById.get(next.session_id) ?? "0") ||
          (after !== null && compareEvent(after, next) >= 0) ||
          (previous !== null && compareEvent(previous, next) > 0))
      )
        return invalid(
          "Search continuation escaped or failed to advance its captured scanned position.",
        );
      return {
        ok: true,
        data: { data: data.value, capture: capture.value, query, scope },
        httpStatus: result.httpStatus,
      };
    },
    async aggregate(
      scope: HistoryScope,
      query: UsageQuery,
      cursor: string | undefined,
      revision: Decimal | undefined,
      signal: AbortSignal,
    ): Promise<HttpResult<PlanningCapture<UsageAggregate>>> {
      const request = usageInvocation(scope, query, cursor, revision),
        r = await companion.read(request, signal);
      if (!r.ok) return r;
      const result = decodeUsage(request, r.data);
      if (!result.ok) return result;
      // Re-decode with this method's exact type rather than asserting a union.
      const data = codec.aggregate.decode(result.data.raw);
      return data.ok
        ? { ok: true, data: { ...result.data, data: data.value }, httpStatus: r.httpStatus }
        : invalid("Invalid aggregate.");
    },
    async records(
      scope: HistoryScope,
      offset: Decimal | undefined,
      revision: Decimal | undefined,
      signal: AbortSignal,
    ): Promise<HttpResult<PlanningCapture<UsagePage>>> {
      const request = recordsInvocation(scope, offset, revision),
        r = await companion.read(request, signal);
      if (!r.ok) return r;
      const result = decodeUsage(request, r.data);
      if (!result.ok) return result;
      const data = codec.usagePage.decode(result.data.raw);
      return data.ok
        ? { ok: true, data: { ...result.data, data: data.value }, httpStatus: r.httpStatus }
        : invalid("Invalid usage catalog.");
    },
  };
}
