import { jsonField, type JsonValue } from "../../../core/json";
import type { Codec } from "../../../core/protocol/codec";
import { createCompanion } from "../../../core/protocol/client";
import * as d from "../../../core/protocol/decoders";
import type { HttpClient, HttpResult } from "../../../core/protocol/http";
import type {
  Decimal,
  JsonObject,
  ReadInvocation,
  ReadResponse,
} from "../../../core/protocol/types";
import { HTTP_LIMITS } from "../../../core/protocol/worker/jobs";
import { comment, thread } from "../threads/codecs";
import { linkJson, sameLink } from "../threads/model";
import { protocol } from "../threads/client";
import type { Captured, Endpoint } from "../threads/types";
import * as codecs from "./codecs";
import { id, integer, recipient, RequestsInputError, sameRecipient, timestamp } from "./model";
import type { DraftGuards, ReadCapture, RequestsDraft, RequestsRead, RequestsValue } from "./types";
export { protocol } from "../threads/client";
export function selectorKey(selector: RequestsRead): string {
  return JSON.stringify(selector);
}
function record(value: JsonValue | undefined, label: string): JsonObject {
  if (value?.kind !== "object") throw new RequestsInputError(`${label} must be an object.`);
  return value;
}
function decimal(value: JsonValue | undefined, label: string): Decimal {
  const parsed = d.decimal.decode(value);
  if (!parsed.ok) throw new RequestsInputError(`${label} must be an exact bounded counter.`);
  return parsed.value;
}
function string(value: JsonValue | undefined, label: string): string {
  if (value?.kind !== "string") throw new RequestsInputError(`${label} must be text.`);
  return value.value;
}
function recipientJson(value: Parameters<typeof recipient>[0]) {
  const valid = recipient(value);
  return d.jsonObject([
    ["kind", d.jsonString(valid.kind)],
    ["id", d.jsonString(valid.id)],
  ]);
}
export function invocation(endpoint: Endpoint, selector: RequestsRead): ReadInvocation {
  const params: [string, JsonValue][] = [["workspace_id", d.jsonString(endpoint.workspaceId)]];
  const add = (key: string, value: string) => params.push([key, d.jsonString(value)]);
  let method: string;
  switch (selector.kind) {
    case "requests": {
      method = "request.list";
      const f = selector.filter;
      if (f.scope !== null)
        params.push([
          "scope",
          linkJson(
            f.scope.kind === "workspace"
              ? f.scope
              : { kind: "project", id: id(f.scope.id, "Project filter") },
          ),
        ]);
      for (const [key, value] of [
        ["thread_id", f.threadId],
        ["ticket_id", f.ticketId],
        ["resolver_id", f.resolverId],
        ["related_to_request_id", f.relatedToId],
        ["supersedes_request_id", f.supersedesId],
        ["superseded_by_request_id", f.supersededById],
      ] as const)
        if (value !== "") add(key, id(value, key));
      if (f.recipient !== null) params.push(["recipient", recipientJson(f.recipient)]);
      if (f.responsible !== null) params.push(["responsible", recipientJson(f.responsible)]);
      if (f.kind !== "all") add("kind", f.kind);
      if (f.priority !== "") {
        const priority = integer(f.priority, "Priority");
        if (BigInt(priority) > 4n) throw new RequestsInputError("Priority must be 0–4.");
        add("priority", priority);
      }
      if (f.overdueAtUnixMs !== "")
        add("overdue_at_unix_ms", timestamp(f.overdueAtUnixMs, "Overdue observation"));
      params.push(
        ["open_only", d.jsonBoolean(f.openOnly)],
        ["unanswered", d.jsonBoolean(f.unanswered)],
      );
      break;
    }
    case "request":
      method = "request.get";
      add("request_id", selector.requestId);
      params.push(["include_messages", d.jsonBoolean(true)]);
      add("message_offset", "0");
      add("message_limit", "25");
      break;
    case "history":
      method = "request.history";
      add("request_id", selector.requestId);
      // selectedRevision is an entity snapshot target, never the query capture.
      break;
    case "historical_comment":
      method = "comment.history";
      add("comment_id", selector.pin.id);
      params.push(["include_archived", d.jsonBoolean(true)]);
      break;
    case "inbox": {
      const f = selector.filter;
      method = selector.wait ? "inbox.wait" : "inbox.read";
      add("consumer_id", id(f.consumerId, "Inbox consumer"));
      params.push(
        ["recipient", recipientJson(f.recipient)],
        ["exclude_self", d.jsonBoolean(f.excludeSelf)],
      );
      // The editor uses no selected kinds for "all". Native Inbox distinguishes
      // omitted kinds (all) from an explicit empty array (none).
      if (f.kinds.length > 0) params.push(["kinds", d.jsonArray(f.kinds.map(d.jsonString))]);
      add("after", integer(f.after, "After"));
      if (f.through !== "") add("through", integer(f.through, "Through"));
      if (f.ticketId !== "") add("ticket_id", id(f.ticketId, "Ticket filter"));
      if (selector.wait) add("timeout_ms", "25000");
      break;
    }
    case "teams":
      method = "team.list";
      break;
    case "team":
      method = "team.get";
      add("team_id", selector.teamId);
      break;
    case "subscriptions":
      method = "subscription.list";
      if (selector.recipient !== null)
        params.push(["recipient", recipientJson(selector.recipient)]);
      break;
    case "subscription":
      method = "subscription.get";
      add("subscription_id", selector.subscriptionId);
      break;
  }
  if (!["request", "team", "subscription", "inbox"].includes(selector.kind)) add("offset", "0");
  if (!["request", "team", "subscription"].includes(selector.kind)) add("limit", "25");
  add("max_bytes", "1048576");
  return {
    connection_id: endpoint.connectionId,
    generation: endpoint.generation,
    lane: selector.kind === "inbox" && selector.wait ? "wait" : "visible",
    method,
    params: d.jsonObject(params),
  };
}
function decoded(selector: RequestsRead, data: JsonValue): HttpResult<RequestsValue> {
  function finish<T>(codec: Codec<T>, map: (value: T) => RequestsValue): HttpResult<RequestsValue> {
    const result = codec.decode(data);
    return result.ok
      ? { ok: true, httpStatus: 200, data: map(result.value) }
      : protocol(
          `Invalid Requests response at ${result.issue.path.join("/")}: ${result.issue.expected}.`,
        );
  }
  switch (selector.kind) {
    case "requests":
      return finish(codecs.page(codecs.listedRequest), (page) => ({ kind: "requests", page }));
    case "request":
      return finish(codecs.currentRequest, (request) => ({ kind: "request", request }));
    case "history":
      return finish(codecs.page(codecs.request), (page) => ({ kind: "history", page }));
    case "historical_comment":
      return finish(codecs.page(comment), (page) => ({ kind: "historical_comment", page }));
    case "inbox":
      return finish(codecs.inbox, (page) => ({ kind: "inbox", page }));
    case "teams":
      return finish(codecs.page(codecs.team), (page) => ({ kind: "teams", page }));
    case "team":
      return finish(codecs.team, (team) => ({ kind: "team", team }));
    case "subscriptions":
      return finish(codecs.page(codecs.subscription), (page) => ({ kind: "subscriptions", page }));
    case "subscription":
      return finish(codecs.subscription, (subscription) => ({
        kind: "subscription",
        subscription,
      }));
  }
}
export function validate(
  endpoint: Endpoint,
  selector: RequestsRead,
  request: ReadInvocation,
  response: ReadResponse,
  httpStatus = 200,
): HttpResult<ReadCapture> {
  const result = decoded(selector, response.response.data);
  if (!result.ok) return result;
  try {
    const planning = selector.kind === "historical_comment";
    const revision = decimal(
      jsonField(response.response.meta, planning ? "workspace_revision" : "query_revision"),
      "Read capture",
    );
    if (
      !planning &&
      string(jsonField(response.response.meta, "query_scope"), "Query scope") !== "communication"
    )
      return protocol("Requests response changed namespace.");
    const requestedCapture = jsonField(request.params, planning ? "at_revision" : "revision");
    if (
      requestedCapture !== undefined &&
      decimal(requestedCapture, "Requested capture") !== revision
    )
      return protocol("Requests response changed query capture.");
    const value = result.data;
    if (
      value.kind === "request" &&
      selector.kind === "request" &&
      value.request.id !== selector.requestId
    )
      return protocol("Request response changed identity.");
    if (value.kind === "team" && selector.kind === "team" && value.team.id !== selector.teamId)
      return protocol("Team response changed identity.");
    if (
      value.kind === "subscription" &&
      selector.kind === "subscription" &&
      value.subscription.id !== selector.subscriptionId
    )
      return protocol("Subscription response changed identity.");
    if (value.kind === "request") {
      const related = value.request.related;
      if (related === null)
        return protocol("Request response omitted its requested expanded discussion.");
      if (
        related.messages.offset !==
          decimal(jsonField(request.params, "message_offset"), "Message offset") ||
        BigInt(related.messages.items.length) >
          BigInt(decimal(jsonField(request.params, "message_limit"), "Message limit"))
      )
        return protocol("Request messages changed page bounds.");
      const serial = jsonField(request.params, "discussion_serial");
      if (serial !== undefined && decimal(serial, "Discussion serial") !== related.discussionSerial)
        return protocol("Request changed discussion activity capture.");
    }
    if ("page" in value) {
      if (
        BigInt(value.page.items.length) >
        BigInt(decimal(jsonField(request.params, "limit"), "Page limit"))
      )
        return protocol("Requests page exceeded the requested item count.");
      if (value.kind === "inbox" && selector.kind === "inbox") {
        const f = selector.filter,
          page = value.page;
        if (
          page.consumerId !== f.consumerId ||
          !sameRecipient(page.recipient, f.recipient) ||
          page.after !== decimal(jsonField(request.params, "after"), "After") ||
          (f.through !== "" && page.through !== f.through) ||
          page.excludeSelf !== f.excludeSelf
        )
          return protocol("Inbox changed its captured consumer, recipient or interval.");
        if (
          page.items.some(
            (item) =>
              (f.kinds.length > 0 && !f.kinds.includes(item.kind)) ||
              (f.ticketId !== "" && !item.ticketIds.includes(id(f.ticketId, "Ticket"))),
          )
        )
          return protocol("Inbox changed its notification filters.");
      } else if (value.kind !== "inbox") {
        if (value.page.offset !== decimal(jsonField(request.params, "offset"), "Offset"))
          return protocol("Requests page changed offset.");
        const keys = value.page.items.map(
          (item) =>
            `${item.id}:${value.kind === "history" || value.kind === "historical_comment" ? item.revision : ""}`,
        );
        if (value.kind === "requests" && selector.kind === "requests") {
          const f = selector.filter,
            selectedRecipient = f.recipient,
            responsible = f.responsible;
          const selectedScope =
            f.scope === null
              ? null
              : f.scope.kind === "workspace"
                ? f.scope
                : { kind: "project" as const, id: id(f.scope.id, "Project") };
          const wrong = value.page.items.some((item) => {
            if (f.threadId !== "" && item.threadId !== f.threadId) return true;
            if (f.resolverId !== "" && item.resolverId !== f.resolverId) return true;
            if (f.kind !== "all" && item.kind !== f.kind) return true;
            if (f.priority !== "" && item.priority !== f.priority) return true;
            if (f.openOnly && item.status.kind !== "open") return true;
            if (
              f.unanswered &&
              (item.status.kind !== "open" ||
                !item.deliveries.some((delivery) => delivery.acknowledged === null))
            )
              return true;
            if (
              selectedRecipient !== null &&
              !item.deliveries.some((delivery) =>
                sameRecipient(delivery.recipient, selectedRecipient),
              )
            )
              return true;
            if (
              responsible !== null &&
              (item.responsibility.kind !== "accepted" ||
                !sameRecipient(item.responsibility.recipient, responsible))
            )
              return true;
            return selectedScope !== null && !sameLink(item.threadSummary.scope, selectedScope);
          });
          if (wrong) return protocol("Request page changed an explicitly requested selector.");
        }
        if (new Set(keys).size !== keys.length)
          return protocol("Requests page repeated an identity/version.");
        if (
          value.kind === "history" &&
          selector.kind === "history" &&
          value.page.items.some((item) => item.id !== selector.requestId)
        )
          return protocol("Request history changed identity.");
        if (
          value.kind === "historical_comment" &&
          selector.kind === "historical_comment" &&
          value.page.items.some((item) => item.id !== selector.pin.id)
        )
          return protocol("Historical body changed comment identity.");
        if (value.kind === "subscriptions" && selector.kind === "subscriptions") {
          const selectedRecipient = selector.recipient;
          if (
            selectedRecipient !== null &&
            value.page.items.some((item) => !sameRecipient(item.recipient, selectedRecipient))
          )
            return protocol("Subscriptions changed recipient filter.");
        }
      }
    }
    return {
      ok: true,
      httpStatus,
      data: { selector, captured: { endpoint, invocation: request, response, value } },
    };
  } catch (error: unknown) {
    if (error instanceof RequestsInputError) return protocol(error.message);
    throw error;
  }
}
/** Validate saved daemon continuations, retaining the exact full parameters.
 * Entity history selection is deliberately outside communication query captures. */
export async function continued(
  http: HttpClient,
  previous: ReadCapture,
  page: "next" | "retry",
  signal?: AbortSignal,
): Promise<HttpResult<ReadInvocation>> {
  try {
    const capture = previous.captured,
      old = capture.invocation;
    let metadata = capture.response.pagination;
    if (metadata === null) return protocol("This read has no native continuation.");
    const nested = previous.selector.kind === "request",
      inbox = previous.selector.kind === "inbox",
      planning = previous.selector.kind === "historical_comment";
    if (nested) {
      const sections = jsonField(metadata, "sections");
      if (sections?.kind !== "array")
        return protocol("Expanded request lacks message continuation.");
      metadata = record(
        sections.items.find(
          (section) =>
            jsonField(section, "path")?.kind === "string" &&
            string(jsonField(section, "path"), "Section path") === "/data/related/messages",
        ),
        "Messages section",
      );
    }
    const saved = record(
      jsonField(metadata, page === "next" ? "next_request" : "retry_request"),
      "Continuation",
    );
    if (string(jsonField(saved, "method"), "Continuation method") !== old.method)
      return protocol("Continuation changed its method.");
    const params = record(jsonField(saved, "params"), "Continuation parameters");
    const mutable = new Set(
      inbox
        ? ["after", "through", "max_bytes"]
        : nested
          ? ["message_offset", "revision", "discussion_serial", "max_bytes"]
          : ["offset", planning ? "at_revision" : "revision", "max_bytes"],
    );
    const fixed = (object: JsonObject) =>
      d.jsonObject(
        object.fields
          .filter((field) => !mutable.has(field.name))
          .map((field) => [field.name, field.value]),
      );
    const encode = (value: JsonObject) =>
      http.processing.encode(value, {
        canonical: true,
        limits: HTTP_LIMITS,
        ...(signal === undefined ? {} : { signal }),
      });
    const a = await encode(fixed(old.params));
    if (!a.ok)
      return a.failure.kind === "aborted"
        ? { ok: false, failure: { kind: "aborted" } }
        : protocol(a.failure.message);
    const b = await encode(fixed(params));
    if (!b.ok)
      return b.failure.kind === "aborted"
        ? { ok: false, failure: { kind: "aborted" } }
        : protocol(b.failure.message);
    if (!a.value.ok || !b.value.ok || a.value.value !== b.value.value)
      return protocol("Continuation changed fixed Requests selectors.");
    const budget = BigInt(decimal(jsonField(params, "max_bytes"), "Byte budget"));
    if (budget < 4096n || budget > 1048576n)
      return protocol("Continuation exceeded native byte bounds.");
    const value = capture.value;
    if (inbox && value.kind === "inbox") {
      if (
        decimal(jsonField(params, "after"), "After") !==
          (page === "next" ? value.page.nextAfter : value.page.after) ||
        decimal(jsonField(params, "through"), "Through") !== value.page.through
      )
        return protocol("Continuation changed notification interval.");
    } else {
      if (
        decimal(jsonField(params, planning ? "at_revision" : "revision"), "Continued capture") !==
        decimal(
          jsonField(
            capture.response.response.meta,
            planning ? "workspace_revision" : "query_revision",
          ),
          "Original capture",
        )
      )
        return protocol("Continuation changed native query revision.");
      const selected =
        value.kind === "request"
          ? value.request.related?.messages
          : "page" in value && value.kind !== "inbox"
            ? value.page
            : undefined;
      const expected =
        selected === undefined ? null : page === "next" ? selected.nextOffset : selected.offset;
      if (
        expected === null ||
        decimal(jsonField(params, nested ? "message_offset" : "offset"), "Offset") !== expected
      )
        return protocol("Continuation changed page offset.");
      if (
        value.kind === "request" &&
        value.request.related !== null &&
        decimal(jsonField(params, "discussion_serial"), "Discussion capture") !==
          value.request.related.discussionSerial
      )
        return protocol("Continuation changed discussion serial.");
    }
    return { ok: true, httpStatus: 200, data: { ...old, params } };
  } catch (error: unknown) {
    if (error instanceof RequestsInputError) return protocol(error.message);
    throw error;
  }
}
export async function read(
  http: HttpClient,
  endpoint: Endpoint,
  selector: RequestsRead,
  request: ReadInvocation,
  signal: AbortSignal,
): Promise<HttpResult<ReadCapture>> {
  const result = await createCompanion(http).read(request, signal);
  return result.ok ? validate(endpoint, selector, request, result.data, result.httpStatus) : result;
}
export async function loadGuards(
  http: HttpClient,
  draft: RequestsDraft,
  signal: AbortSignal,
): Promise<HttpResult<DraftGuards>> {
  let guards = draft.guards;
  const endpoint = draft.endpoint;
  async function get<T>(
    method: string,
    key: string,
    target: string,
    codec: Codec<T>,
  ): Promise<HttpResult<Captured<T>>> {
    const request: ReadInvocation = {
      connection_id: endpoint.connectionId,
      generation: endpoint.generation,
      lane: "visible",
      method,
      params: d.jsonObject([
        ["workspace_id", d.jsonString(endpoint.workspaceId)],
        [key, d.jsonString(id(target, key))],
        ["max_bytes", d.jsonString("1048576")],
        ...(method === "comment.get"
          ? [["include_archived", d.jsonBoolean(true)] as [string, JsonValue]]
          : []),
      ]),
    };
    const result = await createCompanion(http).read(request, signal);
    if (!result.ok) return result;
    const value = codec.decode(result.data.response.data);
    if (!value.ok) return protocol(`Invalid current action guard: ${value.issue.expected}.`);
    return {
      ok: true,
      httpStatus: result.httpStatus,
      data: { endpoint, invocation: request, response: result.data, value: value.value },
    };
  }
  const input = draft.input;
  if ("requestId" in input) {
    const result = await get("request.get", "request_id", input.requestId, codecs.currentRequest);
    if (!result.ok) return result;
    if (result.data.value.id !== input.requestId)
      return protocol("Request guard changed identity.");
    guards = { ...guards, request: result.data };
  }
  const threadId =
    input.method === "request.ask" && input.destination.kind === "thread"
      ? input.destination.threadId
      : input.method === "request.create"
        ? input.threadId
        : undefined;
  if (threadId !== undefined) {
    const result = await get("thread.get", "thread_id", threadId, thread);
    if (!result.ok) return result;
    if (result.data.value.id !== threadId) return protocol("Thread guard changed identity.");
    guards = { ...guards, thread: result.data };
  }
  if (input.method === "request.create") {
    const result = await get("comment.get", "comment_id", input.commentId, comment);
    if (!result.ok) return result;
    if (result.data.value.id !== input.commentId)
      return protocol("Question guard changed identity.");
    guards = { ...guards, comment: result.data };
  }
  if (input.method === "team.put" && input.existing) {
    const result = await get("team.get", "team_id", input.teamId, codecs.team);
    if (!result.ok) return result;
    if (result.data.value.id !== input.teamId) return protocol("Team guard changed identity.");
    guards = { ...guards, team: result.data };
  }
  if (input.method === "subscription.put" && input.existing) {
    const result = await get(
      "subscription.get",
      "subscription_id",
      input.subscriptionId,
      codecs.subscription,
    );
    if (!result.ok) return result;
    if (result.data.value.id !== input.subscriptionId)
      return protocol("Subscription guard changed identity.");
    guards = { ...guards, subscription: result.data };
  }
  return { ok: true, httpStatus: 200, data: guards };
}

/** A deep link locates one exact entity/body version across at most 32 native
 * pages. Returning a page without the version means unavailable in this bounded
 * traversal, never permission to substitute current text or claim absence. */
export async function locate(
  http: HttpClient,
  initial: ReadCapture,
  signal: AbortSignal,
  notificationId?: Decimal,
): Promise<HttpResult<ReadCapture>> {
  const selector = initial.selector;
  const wanted =
    selector.kind === "history"
      ? selector.selectedRevision
      : selector.kind === "historical_comment"
        ? selector.pin.revision
        : null;
  let current = initial;
  if (selector.kind === "inbox" && notificationId !== undefined) {
    for (let page = 0; page < 32; page++) {
      const value = current.captured.value;
      if (value.kind !== "inbox") return protocol("Inbox selector changed its response family.");
      if (
        value.page.items.some((item) => item.id === notificationId) ||
        value.page.remaining === "0" ||
        page === 31
      )
        return { ok: true, httpStatus: 200, data: current };
      const next = await continued(http, current, "next", signal);
      if (!next.ok) return next;
      const result = await read(http, current.captured.endpoint, selector, next.data, signal);
      if (!result.ok) return result;
      if (signal.aborted) return { ok: false, failure: { kind: "aborted" } };
      current = result.data;
    }
    throw new Error("Bounded notification traversal invariant");
  }
  if (wanted === null) return { ok: true, httpStatus: 200, data: current };
  for (let page = 0; page < 32; page++) {
    const value = current.captured.value;
    if (value.kind !== "history" && value.kind !== "historical_comment")
      return protocol("Historical selector changed its response family.");
    if (
      value.page.items.some((item) => item.revision === wanted) ||
      value.page.nextOffset === null ||
      page === 31
    )
      return { ok: true, httpStatus: 200, data: current };
    const next = await continued(http, current, "next", signal);
    if (!next.ok) return next;
    const result = await read(http, current.captured.endpoint, selector, next.data, signal);
    if (result.ok) {
      const before = current.captured.value,
        after = result.data.captured.value;
      if (
        (before.kind === "history" || before.kind === "historical_comment") &&
        (after.kind === "history" || after.kind === "historical_comment")
      ) {
        const last = before.page.items.at(-1),
          first = after.page.items[0];
        if (
          last !== undefined &&
          first !== undefined &&
          BigInt(first.revision) <= BigInt(last.revision)
        )
          return protocol("Historical continuation repeated or reversed an entity version.");
      }
    }

    if (!result.ok) return result;
    current = result.data;
    if (signal.aborted) return { ok: false, failure: { kind: "aborted" } };
  }
  throw new Error("Bounded historical traversal invariant");
}
