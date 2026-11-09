import { jsonField, type JsonValue } from "../../../core/json";
import { createCompanion } from "../../../core/protocol/client";
import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type { HttpClient, HttpResult } from "../../../core/protocol/http";
import type { JsonObject, ReadInvocation, ReadResponse } from "../../../core/protocol/types";
import { pageCodec } from "../read-model.codec";
import type { WorkActionContext } from "../read-model.types";
import { ActionInputError, object, readText, validId } from "../actions/model";
import type {
  Attempt,
  Handoff,
  ProgressDraft,
  ProgressGuards,
  ProgressPage,
  ProgressRead,
  TicketComment,
} from "./types";

/** Daemon records retain every unprojected source field. These adapters validate
 * the fields the tailored feature uses, rather than treating API JSON as a closed
 * companion DTO or claiming that a clipped text preview is the full document. */
type FieldValues<S> = { readonly [K in keyof S]: S[K] extends c.Codec<infer T> ? T : never };
function fields<S extends Readonly<Record<string, c.Codec<unknown>>>>(
  shape: S,
): c.Codec<FieldValues<S>> {
  const names = new Set(Object.keys(shape)),
    codec = c.record(shape);
  return {
    decode(value: JsonValue | undefined, path: readonly string[] = []) {
      if (value?.kind !== "object") return c.mismatch(path, "record");
      return codec.decode(
        { kind: "object", fields: value.fields.filter((field) => names.has(field.name)) },
        path,
      );
    },
  };
}
function projected<A, B>(shape: c.Codec<A>, map: (value: A, raw: JsonObject) => B): c.Codec<B> {
  return {
    decode(value, path = []) {
      if (value?.kind !== "object") return c.mismatch(path, "record");
      const decoded = shape.decode(value, path);
      return decoded.ok ? { ok: true, value: Object.freeze(map(decoded.value, value)) } : decoded;
    },
  };
}
function choice<const T extends string>(values: readonly T[]): c.Codec<T> {
  return {
    decode(value, path = []) {
      const decoded = c.text.decode(value, path);
      if (!decoded.ok) return decoded;
      const found = values.find((item) => item === decoded.value);
      return found === undefined
        ? c.mismatch(path, values.join(" | "))
        : { ok: true, value: found };
    },
  };
}
export const handoffCodec: c.Codec<Handoff> = projected(
  fields({
    ticket_id: d.identifier,
    actor_id: d.identifier,
    revision: d.positiveDecimal,
    summary: c.text,
    next_steps: c.text,
    evidence: c.text,
    objective: c.text,
    completed: c.text,
    decisions: c.text,
    blockers: c.text,
    resource_ids: c.array(d.identifier, 65536),
    covers_through: d.decimal,
    timestamp: c.text,
  }),
  (value, raw) => ({
    ticketId: value.ticket_id,
    actorId: value.actor_id,
    revision: value.revision,
    summary: value.summary,
    nextSteps: value.next_steps,
    evidence: value.evidence,
    objective: value.objective,
    completed: value.completed,
    decisions: value.decisions,
    blockers: value.blockers,
    resourceIds: value.resource_ids,
    coversThrough: value.covers_through,
    timestamp: value.timestamp,
    raw,
  }),
);
export const attemptCodec: c.Codec<Attempt> = projected(
  fields({
    attempt_id: d.identifier,
    revision: d.positiveDecimal,
    run_id: d.identifier,
    ticket_id: d.identifier,
    token: d.positiveDecimal,
    state: choice(["running", "waiting", "completed", "failed", "cancelled"]),
    session_ids: c.array(d.identifier, 100),
    checkpoints: c.array(c.object, 100),
    evidence: c.text,
  }),
  (value, raw) => ({
    id: value.attempt_id,
    revision: value.revision,
    runId: value.run_id,
    ticketId: value.ticket_id,
    token: value.token,
    state: value.state,
    sessionIds: value.session_ids,
    checkpoints: value.checkpoints,
    evidence: value.evidence,
    raw,
  }),
);
export const commentCodec: c.Codec<TicketComment> = projected(
  fields({
    comment_id: d.identifier,
    revision: d.positiveDecimal,
    actor_id: d.identifier,
    author_id: d.identifier,
    body: c.text,
    kind: choice(["comment", "progress", "decision", "blocker", "evidence"]),
    origin: choice(["authored", "completion"]),
    reply_to_comment_id: c.nullable(d.identifier),
    tombstone: c.boolean,
    sequence: d.positiveDecimal,
    timestamp: c.text,
  }),
  (value, raw) => ({
    id: value.comment_id,
    revision: value.revision,
    actorId: value.actor_id,
    authorId: value.author_id,
    body: value.body,
    kind: value.kind,
    origin: value.origin,
    replyToId: value.reply_to_comment_id,
    tombstone: value.tombstone,
    sequence: value.sequence,
    timestamp: value.timestamp,
    raw,
  }),
);

const protocol = (message: string): HttpResult<never> => ({
  ok: false,
  failure: { kind: "protocol", message, issue: undefined },
});
function checked<T>(codec: c.Codec<T>, value: JsonValue): HttpResult<T> {
  const decoded = codec.decode(value);
  return decoded.ok
    ? { ok: true, data: decoded.value, httpStatus: 200 }
    : protocol(
        `Invalid participation response at ${decoded.issue.path.join("/")}: ${decoded.issue.expected}.`,
      );
}
export function pageKey(selector: ProgressRead): string {
  return selector.kind;
}
export function selectorKey(selector: ProgressRead): string {
  return JSON.stringify(
    selector.kind === "comment_history"
      ? [selector.kind, selector.commentId, selector.pageSize ?? "25"]
      : selector.kind === "amendment_acknowledgements"
        ? [selector.kind, selector.amendmentId, selector.revision, selector.pageSize ?? "25"]
        : [selector.kind, selector.pageSize ?? "25"],
  );
}
export function invocation(target: WorkActionContext, selector: ProgressRead): ReadInvocation {
  const workspaceId = target.scope.workspaceId,
    ticketId = target.ticket.value.ticket.ticket_id;
  const params: [string, JsonValue][] = [["workspace_id", d.jsonString(workspaceId)]];
  let method: string;
  switch (selector.kind) {
    case "handoff":
      method = "handoff.get";
      break;
    case "handoff_history":
      method = "handoff.history";
      break;
    case "attempts":
      method = "attempt.list";
      break;
    case "comments":
      method = "comment.list";
      break;
    case "comment_history":
      method = "comment.history";
      break;
    case "evidence":
      method = "evidence.context";
      break;
    case "review_gate":
      method = "review.gate";
      break;
    case "amendments":
      method = "ticket.amendment.list";
      break;
    case "amendment_acknowledgements":
      method = "ticket.amendment.acknowledgements";
      break;
  }
  if (selector.kind === "comments") {
    params.push([
      "target",
      d.jsonObject([
        ["kind", d.jsonString("ticket")],
        ["id", d.jsonString(ticketId)],
      ]),
    ]);
    params.push(
      ["include_tombstones", d.jsonBoolean(true)],
      ["include_archived", d.jsonBoolean(true)],
    );
  } else if (selector.kind === "comment_history") {
    params.push(
      ["comment_id", d.jsonString(selector.commentId)],
      ["include_archived", d.jsonBoolean(true)],
    );
  } else if (selector.kind === "amendment_acknowledgements") {
    params.push(
      ["amendment_id", d.jsonString(selector.amendmentId)],
      ["revision", d.jsonString(selector.revision)],
    );
  } else params.push(["ticket_id", d.jsonString(ticketId)]);
  params.push(["max_bytes", d.jsonString("1048576")]);
  if (
    [
      "handoff_history",
      "attempts",
      "comments",
      "comment_history",
      "amendments",
      "amendment_acknowledgements",
    ].includes(selector.kind)
  )
    params.push(["limit", d.jsonString(selector.pageSize ?? "25")], ["offset", d.jsonString("0")]);
  return {
    connection_id: target.scope.connection.id,
    generation: target.scope.connection.generation,
    lane: "visible",
    method,
    params: d.jsonObject(params),
  };
}
function dataCodec(selector: ProgressRead): c.Codec<unknown> {
  switch (selector.kind) {
    case "handoff":
      return handoffCodec;
    case "handoff_history":
      return pageCodec(handoffCodec);
    case "attempts":
      return fields({
        items: c.array(attemptCodec, 100),
        next_offset: c.nullable(d.decimal),
        omitted: d.decimal,
      });
    case "comments":
    case "comment_history":
      return pageCodec(commentCodec);
    case "review_gate":
      return c.refine(
        fields({ allowed: c.boolean, problem: c.nullable(d.problem) }),
        (value) => value.allowed === (value.problem === null),
        "consistent gate result and problem",
      );
    case "amendments":
    case "amendment_acknowledgements":
      return c.refine(
        fields({
          items: c.array(c.object, 100),
          offset: d.decimal,
          remaining: d.decimal,
          next_offset: c.nullable(d.decimal),
          needs_larger_budget: c.boolean,
          required_bytes: c.nullable(d.positiveDecimal),
        }),
        (page) => {
          const next =
            page.remaining === "0" ? null : String(BigInt(page.offset) + BigInt(page.items.length));
          return (
            page.next_offset === next &&
            page.needs_larger_budget === (page.items.length === 0 && page.remaining !== "0") &&
            page.needs_larger_budget === (page.required_bytes !== null)
          );
        },
        "consistent whole-record amendment continuation and budget",
      );
    case "evidence":
      return c.object;
  }
}
/** Native continuation is carried verbatim after validating its association.
 * Offset/revision counters are exact strings and are never regenerated. */
export class ProgressProtocolError extends Error {}
export function continuation(previous: ProgressPage, kind: "next" | "retry"): JsonObject {
  const pagination = previous.response.pagination;
  if (pagination === null) throw new ProgressProtocolError("This native read has no continuation.");
  const raw = object(
    jsonField(pagination, kind === "next" ? "next_request" : "retry_request"),
    "Native continuation",
  );
  if (readText(jsonField(raw, "method"), "Continuation method") !== previous.method)
    throw new ProgressProtocolError("Native continuation changed its method.");
  const params = object(jsonField(raw, "params"), "Continuation parameters");
  const allowed = new Set([
    ...previous.params.fields.map((field) => field.name),
    "at_revision",
    "expected_revision",
  ]);
  if (params.fields.some((field) => !allowed.has(field.name)))
    throw new ProgressProtocolError("Native continuation changed its selectors.");
  for (const field of previous.params.fields) {
    if (["offset", "max_bytes", "at_revision", "expected_revision"].includes(field.name)) continue;
    const next = jsonField(params, field.name);
    if (
      field.value.kind === "string" &&
      (next?.kind !== "string" || next.value !== field.value.value)
    )
      throw new ProgressProtocolError("Native continuation changed its captured target.");
    if (
      field.value.kind === "boolean" &&
      (next?.kind !== "boolean" || next.value !== field.value.value)
    )
      throw new ProgressProtocolError("Native continuation changed its archival selectors.");
    if (field.name === "target") {
      const old = object(field.value, "Original comment target"),
        value = object(next, "Continued comment target");
      for (const name of ["kind", "id"])
        if (readText(jsonField(old, name), name) !== readText(jsonField(value, name), name))
          throw new ProgressProtocolError("Native continuation changed its comment target.");
    }
  }
  const guardName = previous.selector.kind === "attempts" ? "expected_revision" : "at_revision";
  const revision = jsonField(
    previous.response.response.meta,
    previous.selector.kind === "attempts" ? "query_revision" : "workspace_revision",
  );
  if (
    readText(jsonField(params, guardName), "Continued capture") !==
    readText(revision, "Original capture")
  )
    throw new ProgressProtocolError("Native continuation changed its captured revision.");
  const offset = d.decimal.decode(jsonField(params, "offset")),
    budget = d.decimal.decode(jsonField(params, "max_bytes"));
  const data = object(previous.value, "Original page");
  const expected =
    kind === "next" ? jsonField(data, "next_offset") : jsonField(previous.params, "offset");
  if (
    !offset.ok ||
    readText(expected, "Expected offset") !== offset.value ||
    !budget.ok ||
    BigInt(budget.value) < 4096n ||
    BigInt(budget.value) > 1048576n
  )
    throw new ProgressProtocolError("Native continuation changed its offset or byte bound.");
  return params;
}
export function pageInvocation(
  target: WorkActionContext,
  selector: ProgressRead,
  previous?: ProgressPage,
  page?: "next" | "retry",
): HttpResult<ReadInvocation> {
  const request = invocation(target, selector);
  let params: JsonObject | undefined;
  try {
    params =
      page === undefined
        ? request.params
        : previous === undefined
          ? undefined
          : continuation(previous, page);
  } catch (error: unknown) {
    if (error instanceof ProgressProtocolError || error instanceof ActionInputError)
      return protocol(error.message);
    throw error;
  }
  if (params === undefined) return protocol("Load the captured page before continuing it.");
  if (previous !== undefined && page !== undefined) {
    if (
      previous.method !== request.method ||
      selectorKey(previous.selector) !== selectorKey(selector)
    )
      return protocol("Continuation belongs to a different captured selector.");
    for (const name of ["workspace_id", "ticket_id", "limit"]) {
      const original = jsonField(previous.params, name),
        selected = jsonField(request.params, name);
      if (
        original?.kind === "string" &&
        (selected?.kind !== "string" || original.value !== selected.value)
      )
        return protocol("Continuation belongs to another captured target.");
    }
  }
  return { ok: true, httpStatus: 200, data: { ...request, params } };
}
export async function readPage(
  client: HttpClient,
  target: WorkActionContext,
  selector: ProgressRead,
  request: ReadInvocation,
  signal: AbortSignal,
): Promise<HttpResult<ProgressPage>> {
  const result = await createCompanion(client).read(request, signal);
  if (!result.ok) return result;
  return validatePage(target, selector, request, result.data, result.httpStatus);
}

/** Records bind to the requested ticket and exact family capture. Planning and
 * coordination/evidence namespace revisions are independent. */
export function validatePage(
  target: WorkActionContext,
  selector: ProgressRead,
  request: ReadInvocation,
  response: ReadResponse,
  httpStatus = 200,
): HttpResult<ProgressPage> {
  const value = response.response.data;
  const decoded = checked(dataCodec(selector), value);
  if (!decoded.ok) return decoded;
  try {
    const domain =
      selector.kind === "attempts"
        ? "runs"
        : selector.kind === "evidence" || selector.kind === "review_gate"
          ? "evidence"
          : null;
    const revisionName = domain === null ? "workspace_revision" : "query_revision";
    const revision = d.decimal.decode(jsonField(response.response.meta, revisionName));
    if (
      !revision.ok ||
      (domain !== null &&
        readText(jsonField(response.response.meta, "query_scope"), "Namespace") !== domain)
    )
      return protocol("Read omitted or changed its captured namespace revision.");
    const guard = jsonField(
      request.params,
      domain === "runs" ? "expected_revision" : "at_revision",
    );
    if (guard !== undefined && readText(guard, "Requested capture") !== revision.value)
      return protocol("Read returned another requested capture.");
    const ticketId = target.ticket.value.ticket.ticket_id;
    if (selector.kind === "handoff" || selector.kind === "evidence") {
      if (readText(jsonField(object(value, "Record"), "ticket_id"), "Returned ticket") !== ticketId)
        return protocol("Read returned another ticket identity.");
    }
    const items = value.kind === "object" ? jsonField(value, "items") : undefined;
    if (items?.kind === "array") {
      const seen = new Set<string>();
      for (const item of items.items) {
        const row = object(item, "Page record");
        if (selector.kind === "attempts" || selector.kind === "handoff_history") {
          if (readText(jsonField(row, "ticket_id"), "Page ticket") !== ticketId)
            return protocol("Page returned another ticket's record.");
          const id =
            selector.kind === "attempts"
              ? readText(jsonField(row, "attempt_id"), "Attempt ID")
              : ticketId;
          const key =
            selector.kind === "attempts"
              ? id
              : `${id}:${readText(jsonField(row, "revision"), "Handoff revision")}`;
          if (seen.has(key)) return protocol("Page repeated a record identity.");
          seen.add(key);
        }
        if (selector.kind === "comments" || selector.kind === "comment_history") {
          const ref = object(jsonField(row, "target"), "Comment target");
          if (
            readText(jsonField(ref, "kind"), "Comment target kind") !== "ticket" ||
            readText(jsonField(ref, "id"), "Comment ticket") !== ticketId
          )
            return protocol("Comment page belongs to another ticket.");
          const id = readText(jsonField(row, "comment_id"), "Comment ID"),
            version = readText(jsonField(row, "revision"), "Comment revision");
          if (selector.kind === "comment_history" && id !== selector.commentId)
            return protocol("Comment history returned another identity.");
          const key = selector.kind === "comments" ? id : `${id}:${version}`;
          if (seen.has(key)) return protocol("Page repeated a comment identity/revision.");
          seen.add(key);
        }
      }
      const record = object(value, "Page"),
        offset = d.decimal.decode(jsonField(request.params, "offset"));
      if (!offset.ok) return protocol("Page request has no exact offset.");
      if (selector.kind === "attempts") {
        const next = jsonField(record, "next_offset");
        if (
          next?.kind === "string" &&
          (items.items.length === 0 ||
            BigInt(next.value) !== BigInt(offset.value) + BigInt(items.items.length))
        )
          return protocol("Attempt continuation did not advance by exactly the returned items.");
      } else if (readText(jsonField(record, "offset"), "Returned offset") !== offset.value)
        return protocol("Page returned another offset.");
    }
  } catch (error: unknown) {
    if (error instanceof ActionInputError || error instanceof ProgressProtocolError)
      return protocol(error.message);
    throw error;
  }
  return {
    ok: true,
    httpStatus,
    data: { selector, method: request.method, params: request.params, response, value },
  };
}

/** Guard reads are keyed to the immutable editor. Handoff absence is confirmed
 * by an explicit null in ticket.context, never inferred from a generic Not_found. */
export async function readGuards(
  client: HttpClient,
  draft: ProgressDraft,
  signal: AbortSignal,
): Promise<HttpResult<ProgressGuards>> {
  const input = draft.input,
    capture = draft.capture;
  const params: [string, JsonValue][] = [
    ["workspace_id", d.jsonString(capture.workspaceId)],
    ["max_bytes", d.jsonString("1048576")],
  ];
  let method: string;
  switch (input.method) {
    case "handoff.set":
      method = "ticket.context";
      params.push(["ticket_id", d.jsonString(capture.ticket.value.ticket.ticket_id)]);
      break;
    case "attempt.checkpoint":
    case "attempt.finish":
      method = "attempt.get";
      params.push(["attempt_id", d.jsonString(validId(input.attemptId, "Attempt ID"))]);
      break;
    case "comment.edit":
    case "comment.tombstone":
      method = "comment.get";
      params.push(
        ["comment_id", d.jsonString(validId(input.commentId, "Comment ID"))],
        ["include_archived", d.jsonBoolean(true)],
      );
      break;
    case "attempt.start":
    case "comment.add":
    case "ticket.complete":
    case "ticket.finish":
    case "ticket.progress":
    case "ticket.reopen":
      return { ok: true, httpStatus: 200, data: draft.guards };
  }
  const result = await createCompanion(client).read(
    {
      connection_id: capture.connection.id,
      generation: capture.connection.generation,
      method,
      params: d.jsonObject(params),
      lane: "visible",
    },
    signal,
  );
  if (!result.ok) return result;
  const value = result.data.response.data;
  const reads = [result.data];
  if (input.method === "handoff.set") {
    if (value.kind !== "object") return protocol("Ticket context is malformed.");
    const ticket = jsonField(value, "ticket"),
      handoff = jsonField(value, "handoff");
    if (ticket?.kind !== "object") return protocol("Handoff guard context lacks the exact ticket.");
    const id = d.identifier.decode(jsonField(ticket, "ticket_id"));
    if (!id.ok || id.value !== capture.ticket.value.ticket.ticket_id)
      return protocol("Handoff guard context changed its ticket.");
    if (handoff?.kind === "null")
      return {
        ok: true,
        httpStatus: result.httpStatus,
        data: { ...draft.guards, handoff: null, reads },
      };
    const parsed = handoffCodec.decode(handoff);
    if (!parsed.ok || parsed.value.ticketId !== id.value)
      return protocol("Handoff guard context changed or omitted the handoff identity.");
    return {
      ok: true,
      httpStatus: result.httpStatus,
      data: { ...draft.guards, handoff: parsed.value, reads },
    };
  }
  if (input.method === "attempt.checkpoint" || input.method === "attempt.finish") {
    const parsed = checked(attemptCodec, value);
    return parsed.ok
      ? {
          ok: true,
          httpStatus: result.httpStatus,
          data: { ...draft.guards, attempt: parsed.data, reads },
        }
      : parsed;
  }
  const parsed = checked(commentCodec, value);
  return parsed.ok
    ? {
        ok: true,
        httpStatus: result.httpStatus,
        data: { ...draft.guards, comment: parsed.data, reads },
      }
    : parsed;
}
