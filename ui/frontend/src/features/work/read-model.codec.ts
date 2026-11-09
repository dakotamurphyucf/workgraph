import { jsonField, type JsonValue } from "../../core/json";
import * as c from "../../core/protocol/codec";
import * as d from "../../core/protocol/decoders";
import type { Decimal, JsonObject, ReadResponse } from "../../core/protocol/types";
import type {
  Capture,
  Completion,
  Continuation,
  Page,
  PageControl,
  Readiness,
  Ticket,
  TicketContext,
  TicketRead,
  WorkScope,
} from "./read-model.types";
import { TICKET_STATUSES } from "./read-model.types";

/** Daemon records preserve unprojected fields. The closed companion DTO codec is not an API evolution policy. */
function projected<T>(codec: c.Codec<T>, names: readonly string[]): c.Codec<T> {
  const allowed = new Set(names);
  return {
    decode(value, path = []) {
      if (value?.kind !== "object") return c.mismatch(path, "object");
      return codec.decode(
        { kind: "object", fields: value.fields.filter((f) => allowed.has(f.name)) },
        path,
      );
    },
  };
}
function fields<S extends Readonly<Record<string, c.Codec<unknown>>>>(shape: S) {
  return projected(c.record(shape), Object.keys(shape));
}
function withRaw<T>(codec: c.Codec<T>): c.Codec<T & { readonly raw: JsonObject }> {
  return {
    decode(value, path = []) {
      if (value?.kind !== "object") return c.mismatch(path, "object");
      const result = codec.decode(value, path);
      return result.ok
        ? { ok: true, value: Object.freeze({ ...result.value, raw: value }) }
        : result;
    },
  };
}
const choice = <const T extends string>(values: readonly T[]): c.Codec<T> => ({
  decode(value, path = []) {
    const result = c.text.decode(value, path);
    if (!result.ok) return result;
    const found = values.find((v) => v === result.value);
    return found === undefined ? c.mismatch(path, values.join(" | ")) : { ok: true, value: found };
  },
});
const ids = c.refine(
  c.array(d.identifier, 100000),
  (values) => new Set(values).size === values.length,
  "unique identifiers",
);
const claim = fields({
  actor_id: d.identifier,
  run_id: c.nullable(d.identifier),
  token: d.positiveDecimal,
});
export const ticketCodec: c.Codec<Ticket> = withRaw(
  fields({
    ticket_id: d.identifier,
    display_key: c.text,
    title: c.text,
    description: c.text,
    acceptance_criteria: c.text,
    revision: d.positiveDecimal,
    membership_revision: d.positiveDecimal,
    status: choice(TICKET_STATUSES),
    status_id: c.nullable(d.identifier),
    priority: choice(["0", "1", "2", "3", "4"]),
    archived: c.boolean,
    assignee_id: c.nullable(d.identifier),
    project_id: c.nullable(d.identifier),
    milestone_id: c.nullable(d.identifier),
    parent_ticket_id: c.nullable(d.identifier),
    prerequisite_ticket_ids: ids,
    related_ticket_ids: ids,
    label_ids: ids,
    claim: c.nullable(claim),
    hold: c.nullable(fields({ actor_id: d.identifier, reason: c.text, timestamp: c.text })),
  }),
);
export function pageCodec<T>(item: c.Codec<T>): c.Codec<Page<T>> {
  return c.refine(
    fields({
      items: c.array(item, 100),
      offset: d.decimal,
      next_offset: c.nullable(d.decimal),
      remaining: d.decimal,
    }),
    (p) =>
      p.next_offset === null ||
      (p.items.length > 0 &&
        BigInt(p.next_offset) === BigInt(p.offset) + BigInt(p.items.length) &&
        p.remaining !== "0"),
    "page continuation advances exactly by returned items",
  );
}
export const listCodec = c.refine(
  pageCodec(ticketCodec),
  (page) => new Set(page.items.map((t) => t.ticket_id)).size === page.items.length,
  "unique page ticket identities",
);
export const ticketReadCodec: c.Codec<TicketRead> = fields({ ticket: ticketCodec });
const completionShape = withRaw(
  fields({
    can_complete: c.boolean,
    checks: c.array(
      fields({
        kind: choice([
          "hold",
          "prerequisites",
          "children",
          "amendment_acknowledgements",
          "configured_policy",
        ]),
        passed: c.boolean,
      }),
      5,
    ),
    blocked_prerequisite_ids: ids,
    blocked_prerequisite_count: d.decimal,
    unfinished_child_ids: ids,
    unfinished_child_count: d.decimal,
    problem: c.nullable(fields({ kind: c.text, message: c.text })),
    policy: c.object,
  }),
);
export const completionCodec: c.Codec<Completion> = c.refine(
  completionShape,
  (x) =>
    x.checks.length === 5 &&
    new Set(x.checks.map((c) => c.kind)).size === 5 &&
    BigInt(x.blocked_prerequisite_count) === BigInt(x.blocked_prerequisite_ids.length) &&
    BigInt(x.unfinished_child_count) === BigInt(x.unfinished_child_ids.length) &&
    x.can_complete === x.checks.every((c) => c.passed) &&
    (x.can_complete ? x.problem === null : x.problem !== null),
  "consistent exact completion checks and counts",
);
const reasonShapes: Readonly<Record<string, c.Codec<unknown>>> = {
  archived_scope: fields({ kind: c.literal("archived_scope") }),
  status: fields({ kind: c.literal("status"), category: choice(TICKET_STATUSES) }),
  hold: fields({
    kind: c.literal("hold"),
    details: fields({ actor_id: d.identifier, reason: c.text, timestamp: c.text }),
  }),
  claimed: fields({ kind: c.literal("claimed"), details: claim, revision: d.positiveDecimal }),
  inherited_prerequisite: fields({
    kind: c.literal("inherited_prerequisite"),
    ancestor_ticket_id: d.identifier,
    prerequisite_ticket_id: d.identifier,
  }),
  prerequisite: fields({ kind: c.literal("prerequisite"), ticket_id: d.identifier }),
  run_required: fields({ kind: c.literal("run_required"), target: c.object }),
  path_conflict: fields({
    kind: c.literal("path_conflict"),
    target: c.object,
    reservation: c.object,
    holder: c.object,
  }),
  expired_required_ownership: fields({
    kind: c.literal("expired_required_ownership"),
    target: c.object,
    reservation: c.object,
    holder: c.object,
  }),
  ownership_mode: fields({ kind: c.literal("ownership_mode"), target: c.object, holder: c.object }),
  external_condition: fields({
    kind: c.literal("external_condition"),
    condition_id: d.identifier,
    revision: d.positiveDecimal,
    operation_id: d.identifier,
    artifact: c.object,
    label: c.text,
  }),
  observation_time_required: fields({
    kind: c.literal("observation_time_required"),
    target: c.object,
  }),
  allocation: fields({ kind: c.literal("allocation"), reason: c.object }),
  missing_candidate_capability: fields({
    kind: c.literal("missing_candidate_capability"),
    capability: c.text,
  }),
};
const reasonCodec: c.Codec<JsonObject> = {
  decode(value, path = []) {
    if (value?.kind !== "object") return c.mismatch(path, "readiness reason");
    const kind = c.text.decode(jsonField(value, "kind"), [...path, "kind"]);
    if (!kind.ok) return kind;
    const shape = Object.hasOwn(reasonShapes, kind.value) ? reasonShapes[kind.value] : undefined;
    if (!shape) return c.mismatch(path, "known readiness reason");
    const decoded = shape.decode(value, path);
    return decoded.ok ? { ok: true, value } : decoded;
  },
};
export const readinessCodec: c.Codec<Readiness> = c.refine(
  withRaw(
    fields({
      ready: c.boolean,
      assessment: fields({
        scope: choice(["graph", "run", "candidate"]),
        unknown_checks: c.array(
          choice(["run_lifecycle", "run_budget", "required_path_ownership"]),
          3,
        ),
      }),
      reason_count: d.decimal,
      reasons: c.array(reasonCodec, 100000),
      completion: completionCodec,
    }),
  ),
  (x) =>
    BigInt(x.reason_count) === BigInt(x.reasons.length) && x.ready === (x.reasons.length === 0),
  "exact readiness reasons and count",
);
export const CONTEXT_PATHS = [
  "related",
  "resources",
  "communication/threads",
  "communication/requests",
  "amendments",
  "pending_amendment_acknowledgements",
  "attempts",
  "recoveries",
  "children",
  "updates",
  "activity_since_handoff",
  "fact_keys",
] as const;
export function atPath(value: JsonValue | undefined, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const name of path.split("/").filter(Boolean))
    current = current?.kind === "object" ? jsonField(current, name) : undefined;
  return current;
}
export const factPageCodec: c.Codec<Page<JsonValue>> = {
  decode(value, path = []) {
    const result = fields({
      items: c.array(c.raw, 100),
      remaining: d.decimal,
      total: d.decimal,
    }).decode(value, path);
    if (!result.ok) return result;
    if (
      BigInt(result.value.total) <
      BigInt(result.value.remaining) + BigInt(result.value.items.length)
    )
      return c.mismatch(path, "fact discovery totals");
    const zero = d.decimal.decode(d.jsonString("0"));
    if (!zero.ok) throw new Error("Invalid constant");
    return {
      ok: true,
      value: {
        items: result.value.items,
        remaining: result.value.remaining,
        offset: zero.value,
        next_offset: null,
      },
    };
  },
};
export const contextCodec: c.Codec<TicketContext> = {
  decode(value, path = []) {
    const base = withRaw(
      fields({
        ticket: ticketCodec,
        readiness: readinessCodec,
        completion_readiness: completionCodec,
        parent: c.nullable(ticketCodec),
        blocker_ticket_ids: ids,
      }),
    ).decode(value, path);
    if (!base.ok) return base;
    const sections: Record<string, Page<JsonValue>> = {};
    for (const name of CONTEXT_PATHS) {
      const result = (name === "fact_keys" ? factPageCodec : pageCodec(c.raw)).decode(
        atPath(base.value.raw, name),
        [...path, name],
      );
      if (!result.ok) return result;
      sections[`/data/${name}`] = result.value;
    }
    return { ok: true, value: { ...base.value, sections: Object.freeze(sections) } };
  },
};
const requestCodec = c.record({
  jsonrpc: c.literal("2.0"),
  workgraph_api: c.literal("0.7"),
  id: c.text,
  method: choice(["ticket.list", "ticket.context", "fact.keys"]),
  params: c.object,
});
const stopCodec = choice([
  "complete",
  "page_limit",
  "byte_limit",
  "no_progress",
  "needs_larger_budget",
  "indexing_incomplete",
  "server_field_omissions",
  "server_item_omissions",
  "error",
  "metadata_limit",
]);
const controlCodec = fields({
  complete: c.boolean,
  stop: stopCodec,
  next_request: c.nullable(requestCodec),
  retry_request: c.nullable(requestCodec),
});
const paginationCodec = fields({
  capture: fields({ workspace_revision: d.decimal }),
  consistency: c.literal("current_revision_guard"),
  complete: c.boolean,
  stop: stopCodec,
  next_request: c.nullable(requestCodec),
  retry_request: c.nullable(requestCodec),
  sections: c.optional(
    c.array(
      fields({
        path: c.text,
        response_path: c.optional(c.text),
        complete: c.boolean,
        stop: stopCodec,
        next_request: c.nullable(requestCodec),
        retry_request: c.nullable(requestCodec),
      }),
      32,
    ),
  ),
});
/** Continuations are transport descriptors, not executable URLs. Validate target/capture before sending unchanged params. */
function allowed(
  request: Continuation | null,
  scope: WorkScope,
  revision: Decimal,
  method: string,
  params: JsonObject,
  path: string,
): boolean {
  if (request === null) return true;
  const expectedMethod = path === "/data/fact_keys" ? "fact.keys" : method;
  if (
    request.method !== expectedMethod ||
    jsonField(request.params, "workspace_id")?.kind !== "string"
  )
    return false;
  const ws = c.text.decode(jsonField(request.params, "workspace_id")),
    rev = d.decimal.decode(jsonField(request.params, "at_revision"));
  if (!ws.ok || ws.value !== scope.workspaceId || !rev.ok || rev.value !== revision) return false;
  if (expectedMethod === "fact.keys") {
    const target = c
      .record({ kind: c.literal("ticket"), id: d.identifier })
      .decode(jsonField(request.params, "scope"));
    const original =
      method === "fact.keys"
        ? fields({ kind: c.literal("ticket"), id: d.identifier }).decode(jsonField(params, "scope"))
        : null;
    const ticket = d.identifier.decode(jsonField(params, "ticket_id"));
    const permitted = new Set([
      "workspace_id",
      "scope",
      "at_revision",
      "offset",
      "limit",
      "max_bytes",
    ]);
    if (!request.params.fields.every((field) => permitted.has(field.name))) return false;
    for (const name of ["limit", "max_bytes"]) {
      const previous = c.optional(c.text).decode(jsonField(params, name));
      const next = c.optional(c.text).decode(jsonField(request.params, name));
      if (!previous.ok || !next.ok || previous.value !== next.value) return false;
    }
    return (
      target.ok &&
      (original?.ok
        ? target.value.id === original.value.id
        : ticket.ok && target.value.id === ticket.value)
    );
  }
  // All query selectors survive exactly; only the native offset and revision may change.
  for (const f of params.fields) {
    if (f.name === "offset" || f.name === "at_revision") continue;
    const actual = jsonField(request.params, f.name);
    if (f.value.kind === "string" || f.value.kind === "boolean") {
      if (actual?.kind !== f.value.kind || !("value" in actual) || actual.value !== f.value.value)
        return false;
    } else return false;
  }
  const permitted = new Set([...params.fields.map((f) => f.name), "offset", "at_revision"]);
  return request.params.fields.every((f) => permitted.has(f.name));
}
export function decodeCapture<T>(
  response: ReadResponse,
  codec: c.Codec<T>,
  scope: WorkScope,
  method: string,
  params: JsonObject,
): c.DecodeResult<Capture<T>> {
  const value = codec.decode(response.response.data, ["data"]);
  if (!value.ok) return value;
  const revision = d.decimal.decode(jsonField(response.response.meta, "workspace_revision"), [
    "meta",
    "workspace_revision",
  ]);
  if (!revision.ok) return revision;
  const pinned = c.optional(d.decimal).decode(jsonField(params, "at_revision"));
  if (!pinned.ok) return pinned;
  if (pinned.value !== undefined && pinned.value !== revision.value)
    return c.mismatch(["meta", "workspace_revision"], "requested planning capture");
  if (method === "ticket.read" || method === "ticket.context") {
    const target = d.identifier.decode(jsonField(params, "ticket_id"));
    const returned = d.identifier.decode(atPath(response.response.data, "ticket/ticket_id"));
    if (!target.ok || !returned.ok || target.value !== returned.value)
      return c.mismatch(["data", "ticket", "ticket_id"], "requested ticket identity");
  }
  if (method === "ticket.readiness") {
    const expected =
      jsonField(params, "target_run_id") !== undefined
        ? "run"
        : jsonField(params, "candidate") !== undefined
          ? "candidate"
          : "graph";
    const returned = c.literal(expected).decode(atPath(response.response.data, "assessment/scope"));
    if (!returned.ok) return returned;
  }
  const controls: PageControl[] = [];
  if (response.pagination !== null) {
    const paging = paginationCodec.decode(response.pagination, ["pagination"]);
    if (!paging.ok) return paging;
    if (paging.value.capture.workspace_revision !== revision.value)
      return c.mismatch(["pagination", "capture"], "matching planning capture");
    const all = paging.value.sections ?? [
      { ...paging.value, path: "/data", response_path: "/data" },
    ];
    const paths = new Set<string>();
    for (const p of all) {
      if (
        paths.has(p.path) ||
        !(p.path === "/data" || CONTEXT_PATHS.some((s) => p.path === `/data/${s}`))
      )
        return c.mismatch(["pagination", "sections"], "unique known section paths");
      paths.add(p.path);
      if (
        !allowed(p.next_request, scope, revision.value, method, params, p.path) ||
        !allowed(p.retry_request, scope, revision.value, method, params, p.path)
      )
        return c.mismatch(["pagination", p.path], "unchanged read query and capture");
      if (
        p.complete !== (p.stop === "complete") ||
        (p.complete && (p.next_request !== null || p.retry_request !== null))
      )
        return c.mismatch(["pagination", p.path], "consistent completion control");
      if (
        p.response_path !== undefined &&
        p.response_path !== (p.path === "/data/fact_keys" ? "/data" : p.path)
      )
        return c.mismatch(["pagination", p.path], "known section response path");
      const returnedPage =
        p.path === "/data"
          ? response.response.data
          : atPath(response.response.data, p.path.slice(6));
      if (p.next_request !== null && returnedPage?.kind === "object") {
        const nextOffset = d.decimal.decode(jsonField(p.next_request.params, "offset"));
        const reported = d.decimal.decode(jsonField(returnedPage, "next_offset"));
        const items = jsonField(returnedPage, "items");
        const expectedOffset =
          p.path === "/data/fact_keys" && method === "ticket.context" && items?.kind === "array"
            ? String(items.items.length)
            : reported.ok
              ? reported.value
              : undefined;
        if (!nextOffset.ok || nextOffset.value !== expectedOffset)
          return c.mismatch(["pagination", p.path], "continuation matches returned page offset");
      }
      controls.push({
        path: p.path,
        responsePath: p.response_path ?? p.path,
        complete: p.complete,
        stop: p.stop,
        next: p.next_request,
        retry: p.retry_request,
      });
    }
  }
  const budgetValue = jsonField(response.response.meta, "budget");
  const budget = c
    .optional(fields({ truncated: c.boolean, omitted_fields: d.decimal, omitted_items: d.decimal }))
    .decode(budgetValue);
  if (!budget.ok) return budget;
  if (
    budget.value !== undefined &&
    budget.value.truncated !==
      (budget.value.omitted_fields !== "0" || budget.value.omitted_items !== "0")
  )
    return c.mismatch(["meta", "budget"], "consistent omission summary");
  return {
    ok: true,
    value: Object.freeze({
      id: `work-${crypto.randomUUID()}`,
      value: value.value,
      revision: revision.value,
      response,
      partial:
        (budget.value?.truncated ?? false) ||
        controls.some((p) => !p.complete) ||
        (method === "ticket.context"
          ? CONTEXT_PATHS.some((path) => {
              const remaining = atPath(response.response.data, `${path}/remaining`);
              return remaining?.kind === "string" && remaining.value !== "0";
            })
          : (() => {
              const remaining = atPath(response.response.data, "remaining");
              return remaining?.kind === "string" && remaining.value !== "0";
            })()),
      controls: Object.freeze(controls),
    }),
  };
}
export { controlCodec };
