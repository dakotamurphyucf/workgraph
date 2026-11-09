import { jsonField } from "../../../core/json";
import { createCompanion } from "../../../core/protocol/client";
import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type { HttpClient, HttpResult } from "../../../core/protocol/http";
import type { JsonObject, ReadInvocation, ReadResponse } from "../../../core/protocol/types";
import {
  actorCodec,
  actionCodec,
  attemptCodec,
  fields,
  participantCodec,
  runCodec,
  sessionPageCodec,
  decimal64,
} from "./codecs";
import type {
  PageRows,
  ParticipantsDetail,
  ParticipantsPage,
  ParticipantsReadMethod,
  ParticipantsTarget,
  SessionPage,
} from "./types";

export const invalid = (message: string): HttpResult<never> => ({
  ok: false,
  failure: { kind: "protocol", message, issue: undefined },
});
const textField = (value: import("../../../core/json").JsonValue, name: string) => {
  const field = jsonField(value, name);
  return field?.kind === "string" ? field.value : undefined;
};
const success = <T>(data: T): HttpResult<T> => ({ ok: true, data, httpStatus: 200 });
const metadata = (scope: "runs" | "policy") =>
  fields({ query_revision: d.decimal, query_scope: c.literal(scope) });
const history = fields({ history_capture: fields({ head: c.nullable(d.digest) }) });
const planning = fields({ workspace_revision: d.decimal });
const offset = fields({ next_offset: c.nullable(d.decimal) });
const cursor = fields({ cursor: c.nullable(c.text) });
const coordinatorCursor = fields({ next_cursor: c.nullable(c.text) });
const rawItems = fields({ items: c.array(c.object, 100) });
const params = (value: JsonObject) =>
  value.fields.map((field) => [field.name, field.value] as const);
const set = (value: JsonObject, name: string, item: import("../../../core/json").JsonValue) =>
  d.jsonObject([...params(value).filter(([key]) => key !== name), [name, item]]);
export function invocation(
  target: ParticipantsTarget,
  method: ParticipantsReadMethod,
  extra: readonly (readonly [string, import("../../../core/json").JsonValue])[] = [],
): ReadInvocation {
  if (extra.some(([key]) => key === "workspace_id"))
    throw new Error(
      "Captured workspace is supplied by the Participants target, never repeated in selectors.",
    );
  return Object.freeze({
    connection_id: target.connection.id,
    generation: target.connection.generation,
    method,
    params: d.jsonObject([["workspace_id", d.jsonString(target.workspaceId)], ...extra]),
    lane: "visible",
  });
}
/** Derive continuations from validated fields of this exact request/response. Never
 * execute an untrusted method/target copied out of arbitrary pagination metadata. */
export function decodePage(
  target: ParticipantsTarget,
  request: ReadInvocation,
  response: ReadResponse,
): HttpResult<ParticipantsPage> {
  if (
    request.connection_id !== target.connection.id ||
    request.generation !== target.connection.generation ||
    jsonField(request.params, "workspace_id")?.kind !== "string" ||
    textField(request.params, "workspace_id") !== target.workspaceId
  )
    return invalid("Page request changed its captured participant target.");
  const data = response.response.data,
    meta = response.response.meta,
    method = request.method;
  let rows: PageRows;
  switch (method) {
    case "actor.list": {
      const v = fields({ items: c.array(actorCodec, 100) }).decode(data);
      if (!v.ok) return invalid("Malformed actor catalog.");
      rows = { kind: "catalog", items: v.value.items };
      break;
    }
    case "participant.list": {
      const v = fields({ items: c.array(participantCodec, 100) }).decode(data);
      if (!v.ok) return invalid("Malformed retained participant observations.");
      rows = { kind: "actors", items: v.value.items };
      break;
    }
    case "run.list": {
      const v = fields({ items: c.array(runCodec, 100) }).decode(data);
      if (!v.ok) return invalid("Malformed recorded runs.");
      rows = { kind: "runs", items: v.value.items };
      break;
    }
    case "attempt.list": {
      const v = fields({ items: c.array(attemptCodec, 100) }).decode(data);
      if (!v.ok) return invalid("Malformed attempts.");
      const run = jsonField(request.params, "target_run_id"),
        ticket = jsonField(request.params, "ticket_id");
      if (
        v.value.items.some(
          (item) =>
            (run?.kind === "string" && item.run_id !== run.value) ||
            (ticket?.kind === "string" && item.ticket_id !== ticket.value),
        )
      )
        return invalid("Attempt page changed its run/ticket filter.");
      rows = { kind: "attempts", items: v.value.items };
      break;
    }
    case "run.actions": {
      const v = fields({ items: c.array(actionCodec, 100) }).decode(data);
      if (!v.ok) return invalid("Malformed runner actions.");
      rows = { kind: "actions", items: v.value.items };
      break;
    }
    case "actor.overview":
    case "coordinator.overview":
    case "run.budget_attention": {
      const v = rawItems.decode(data);
      if (!v.ok) return invalid("Malformed participant overview.");
      rows = { kind: "overview", items: v.value.items };
      break;
    }
    case "run.budget_get": {
      const v = fields({
        target_run_id: d.identifier,
        revision: d.positiveDecimal,
        max_attempts: c.nullable(d.positiveDecimal),
        max_active_attempts: c.nullable(d.positiveDecimal),
        reported_token_limit: c.nullable(decimal64),
        reported_elapsed_ms_limit: c.nullable(decimal64),
      }).decode(data);
      if (
        !v.ok ||
        jsonField(request.params, "target_run_id")?.kind !== "string" ||
        v.value.target_run_id !== textField(request.params, "target_run_id") ||
        data.kind !== "object"
      )
        return invalid("Malformed budget or changed run identity.");
      rows = { kind: "record", value: data };
      break;
    }
    case "run.heartbeat_get": {
      const v = fields({
        target_run_id: d.identifier,
        observation: c.record({ actor_id: d.identifier, observed_unix_ms: decimal64 }),
        persisted: c.nullable(c.record({ actor_id: d.identifier, observed_unix_ms: decimal64 })),
        durable: c.boolean,
        advisory: c.literal(true),
      }).decode(data);
      if (
        !v.ok ||
        v.value.target_run_id !== textField(request.params, "target_run_id") ||
        v.value.durable !==
          (v.value.persisted !== null &&
            v.value.persisted.actor_id === v.value.observation.actor_id &&
            v.value.persisted.observed_unix_ms === v.value.observation.observed_unix_ms) ||
        (v.value.persisted !== null &&
          (v.value.persisted.actor_id !== v.value.observation.actor_id ||
            BigInt(v.value.persisted.observed_unix_ms) >
              BigInt(v.value.observation.observed_unix_ms))) ||
        data.kind !== "object"
      )
        return invalid("Malformed advisory heartbeat or changed run identity.");
      rows = { kind: "record", value: data };
      break;
    }
    default:
      return invalid("Unsupported Participants page method.");
  }
  const plan =
      method === "actor.list" || method === "participant.list" || method === "actor.overview",
    domain = ![
      "actor.list",
      "participant.list",
      "actor.overview",
      "coordinator.overview",
      "run.heartbeat_get",
    ].includes(method);
  const revision = plan
    ? planning.decode(meta)
    : domain
      ? metadata(method.startsWith("run.budget") ? "policy" : "runs").decode(meta)
      : null;
  if (revision !== null && !revision.ok)
    return invalid("Participant page is missing its exact namespace revision.");
  const revisionValue = revision?.ok
    ? "workspace_revision" in revision.value
      ? revision.value.workspace_revision
      : revision.value.query_revision
    : null;
  const guard = plan ? "at_revision" : "expected_revision",
    explicit = jsonField(request.params, guard);
  if (explicit !== undefined && (explicit.kind !== "string" || explicit.value !== revisionValue))
    return invalid("Participant page changed its guarded revision.");
  const head = method === "run.list" ? history.decode(meta) : null;
  if (head !== null && !head.ok)
    return invalid("Run collection is missing its captured History head.");
  const historyHead = head?.ok ? head.value.history_capture.head : undefined,
    requestedHead = jsonField(request.params, "head");
  if (
    requestedHead !== undefined &&
    (requestedHead.kind === "null"
      ? historyHead !== null
      : requestedHead.kind !== "string" || requestedHead.value !== historyHead)
  )
    return invalid("Run page changed its captured History head.");
  let continuation: ReadInvocation | null = null,
    retry: ReadInvocation | null = null;
  let completeness: ParticipantsPage["completeness"] = "complete",
    stopReason: string | null = null;
  let omittedItems = "0";
  const budget = jsonField(meta, "budget");
  if (budget !== undefined) {
    const value = fields({
      omitted_items: d.decimal,
      omitted_fields: d.decimal,
      truncated: c.boolean,
      details_complete: c.boolean,
    }).decode(budget);
    if (!value.ok) return invalid("Malformed response completeness budget.");
    if (
      value.value.truncated !==
      (value.value.omitted_items !== "0" || value.value.omitted_fields !== "0")
    )
      return invalid("Budget omission counts disagree with truncation.");
    omittedItems = value.value.omitted_items;
    if (value.value.omitted_fields !== "0" || !value.value.details_complete) {
      completeness = "partial";
      stopReason = "Some record fields were omitted by the server byte budget.";
    }
  }
  if (
    rows.kind === "runs" &&
    rows.items.some((run) => run.session_associations.history_head !== historyHead)
  )
    return invalid("A run association head differs from its collection capture.");
  if (
    [
      "actor.list",
      "participant.list",
      "run.list",
      "attempt.list",
      "run.actions",
      "run.budget_attention",
    ].includes(method)
  ) {
    const v = offset.decode(data);
    if (!v.ok) return invalid("Malformed participant page offset.");
    const remaining = d.decimal.decode(jsonField(data, plan ? "remaining" : "omitted"));
    if (!remaining.ok) return invalid("Participant page is missing its exact remaining count.");
    if (plan) {
      const returnedOffset = d.decimal.decode(jsonField(data, "offset")),
        requested = d.decimal.decode(jsonField(request.params, "offset") ?? d.jsonString("0"));
      if (!returnedOffset.ok || !requested.ok || returnedOffset.value !== requested.value)
        return invalid("Participant page changed its requested offset.");
    }
    if (v.value.next_offset !== null) {
      const before = d.decimal.decode(jsonField(request.params, "offset") ?? d.jsonString("0"));
      const count = rows.kind === "record" ? 0 : rows.items.length;
      if (
        !before.ok ||
        BigInt(v.value.next_offset) !== BigInt(before.value) + BigInt(count) ||
        revisionValue === null
      )
        return invalid("Participant continuation changed its exact offset.");
      if (remaining.value === "0")
        return invalid("Continuation advertised with no remaining records.");
      if (count === 0) {
        completeness = "partial";
        stopReason = "This page made no progress within its byte budget.";
      }
      let next = set(
        set(request.params, "offset", d.jsonString(v.value.next_offset)),
        guard,
        d.jsonString(revisionValue),
      );
      if (historyHead !== undefined)
        next = set(next, "head", historyHead === null ? d.jsonNull() : d.jsonString(historyHead));
      if (count > 0) {
        continuation = { ...request, params: next };
        if (completeness !== "partial") completeness = "more";
      }
    } else {
      const remainder = d.decimal.decode(jsonField(data, plan ? "remaining" : "omitted"));
      if (!remainder.ok) return invalid("Participant page is missing its exact remaining count.");
      if (remainder.value !== "0" || omittedItems !== "0") {
        completeness = "partial";
        stopReason = "Records remain but the server supplied no advancing continuation.";
      }
    }
  } else if (method === "actor.overview" || method === "coordinator.overview") {
    const v = (method === "actor.overview" ? cursor : coordinatorCursor).decode(data);
    if (!v.ok) return invalid("Malformed captured overview cursor.");
    const next = "cursor" in v.value ? v.value.cursor : v.value.next_cursor;
    const needs = fields({
      needs_larger_budget: c.boolean,
      required_bytes: c.nullable(d.positiveDecimal),
    }).decode(data);
    if (!needs.ok) return invalid("Overview is missing its byte-budget status.");
    if (needs.value.needs_larger_budget !== (needs.value.required_bytes !== null))
      return invalid("Overview byte-budget flag disagrees with its required byte count.");
    if (needs.value.needs_larger_budget) {
      completeness = "partial";
      stopReason = `The next captured row needs ${needs.value.required_bytes} bytes.`;
    }
    if (method === "actor.overview") {
      const has = fields({ has_more: c.boolean }).decode(data);
      if (!has.ok || has.value.has_more !== (next !== null))
        return invalid("Actor overview cursor disagrees with remaining rows.");
    }
    if (next !== null) {
      const previous = jsonField(request.params, "cursor");
      if (
        !needs.value.needs_larger_budget &&
        previous?.kind === "string" &&
        previous.value === next
      )
        return invalid("Overview cursor did not advance.");
      if (!needs.value.needs_larger_budget) {
        continuation = { ...request, params: set(request.params, "cursor", d.jsonString(next)) };
        if (completeness !== "partial") completeness = "more";
      }
    }
  }
  if (completeness === "partial") {
    const bytes = d.positiveDecimal.decode(
      jsonField(request.params, "max_bytes") ?? d.jsonString("1048576"),
    );
    if (bytes.ok && BigInt(bytes.value) < 1048576n) {
      // An initial current-cursor query cannot recreate an exact captured range.
      // Use its response cursor only when it explicitly names the oversized next row.
      const cursorMethod = method === "actor.overview" || method === "coordinator.overview";
      const currentCursor = jsonField(request.params, "cursor"),
        oversized = jsonField(data, "needs_larger_budget");
      const responseCursor = jsonField(
        data,
        method === "actor.overview" ? "cursor" : "next_cursor",
      );
      const exactCursor =
        oversized?.kind === "boolean" && oversized.value ? responseCursor : currentCursor;
      if (cursorMethod && exactCursor?.kind !== "string")
        return success(
          Object.freeze({
            target,
            invocation: request,
            response,
            rows,
            revision: revisionValue,
            historyHead,
            continuation,
            retry: null,
            completeness,
            stopReason,
          }),
        );
      let retryParams = set(
        request.params,
        "max_bytes",
        d.jsonString(
          String(BigInt(bytes.value) * 2n > 1048576n ? 1048576n : BigInt(bytes.value) * 2n),
        ),
      );
      if (cursorMethod && exactCursor?.kind === "string")
        retryParams = set(retryParams, "cursor", exactCursor);
      if (
        revisionValue !== null &&
        method !== "actor.overview" &&
        method !== "coordinator.overview"
      )
        retryParams = set(retryParams, guard, d.jsonString(revisionValue));
      if (historyHead !== undefined)
        retryParams = set(
          retryParams,
          "head",
          historyHead === null ? d.jsonNull() : d.jsonString(historyHead),
        );
      retry = { ...request, params: retryParams };
    }
  }
  return success(
    Object.freeze({
      target,
      invocation: request,
      response,
      rows,
      revision: revisionValue,
      historyHead,
      continuation,
      retry,
      completeness,
      stopReason,
    }),
  );
}
export function decodeDetail(
  target: ParticipantsTarget,
  method: "run.get" | "attempt.get",
  id: string,
  response: ReadResponse,
): HttpResult<ParticipantsDetail> {
  if (!fields({ query_scope: c.literal("runs") }).decode(response.response.meta).ok)
    return invalid("Detail is missing its run namespace capture.");
  const value =
    method === "run.get"
      ? runCodec.decode(response.response.data)
      : attemptCodec.decode(response.response.data);
  if (!value.ok) return invalid("Malformed recorded run or attempt.");
  if (
    ("run_id" in value.value && method === "run.get"
      ? value.value.run_id
      : "attempt_id" in value.value
        ? value.value.attempt_id
        : undefined) !== id
  )
    return invalid("Detail belongs to another recorded target.");
  if ("session_associations" in value.value) {
    const h = history.decode(response.response.meta);
    if (!h.ok || h.value.history_capture.head !== value.value.session_associations.history_head)
      return invalid("Run association head differs from response capture.");
    return success({ target, response, value: { kind: "run", run: value.value } });
  }
  return success({ target, response, value: { kind: "attempt", attempt: value.value } });
}
export function decodeSessions(
  target: ParticipantsTarget,
  request: ReadInvocation,
  response: ReadResponse,
): HttpResult<SessionPage> {
  const page = sessionPageCodec.decode(response.response.data),
    h = history.decode(response.response.meta),
    run = jsonField(request.params, "target_run_id"),
    head = jsonField(request.params, "head"),
    revision = jsonField(request.params, "expected_run_revision"),
    after = jsonField(request.params, "after_session_id");
  if (
    !page.ok ||
    !h.ok ||
    run?.kind !== "string" ||
    page.value.run_id !== run.value ||
    page.value.history_head !== h.value.history_capture.head ||
    (head !== undefined &&
      (head.kind === "null"
        ? page.value.history_head !== null
        : head.kind !== "string" || head.value !== page.value.history_head)) ||
    (revision !== undefined &&
      (revision.kind !== "string" || revision.value !== page.value.run_revision)) ||
    (after !== undefined &&
      (after.kind !== "string" || page.value.session_ids.some((id) => id <= after.value))) ||
    (page.value.next_request !== null &&
      page.value.next_request.params.workspace_id !== target.workspaceId)
  )
    return invalid("Session association response changed its run, revision, head or cursor.");
  return success(page.value);
}
export function createParticipantsClient(http: HttpClient) {
  const companion = createCompanion(http);
  return {
    read: companion.read,
    page: async (target: ParticipantsTarget, request: ReadInvocation, signal: AbortSignal) => {
      const result = await companion.read(request, signal);
      return result.ok ? decodePage(target, request, result.data) : result;
    },
    detail: async (
      target: ParticipantsTarget,
      method: "run.get" | "attempt.get",
      id: string,
      signal: AbortSignal,
    ) => {
      const result = await companion.read(
        invocation(target, method, [
          [method === "run.get" ? "target_run_id" : "attempt_id", d.jsonString(id)],
          ["max_bytes", d.jsonString("1048576")],
        ]),
        signal,
      );
      return result.ok ? decodeDetail(target, method, id, result.data) : result;
    },
    sessions: async (target: ParticipantsTarget, request: ReadInvocation, signal: AbortSignal) => {
      const result = await companion.read(request, signal);
      return result.ok ? decodeSessions(target, request, result.data) : result;
    },
  };
}
