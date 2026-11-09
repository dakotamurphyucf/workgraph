import { jsonField, type JsonValue } from "../../core/json";
import * as c from "../../core/protocol/codec";
import * as d from "../../core/protocol/decoders";
import type { Decimal, JsonObject } from "../../core/protocol/types";
import { fields, choice } from "../discussions/threads/codecs";
import { scopeCodec, keyCodec } from "../knowledge/facts/codecs";
import { usageRecord, int64 } from "../history/analytics/codecs";
import { readinessCodec } from "../work/read-model.codec";
import { TICKET_STATUSES } from "../work/read-model.types";
import type {
  ActivityDigest,
  AttentionPage,
  AttentionRow,
  CoordinationPage,
  CoordinationRow,
  DigestItem,
  ExcerptPage,
  OverviewSummary,
  ProjectSummary,
  ReadinessPage,
  TicketSummary,
} from "./types";

function map<A, B>(codec: c.Codec<A>, f: (value: A, raw: JsonObject) => B): c.Codec<B> {
  return {
    decode(value, path = []) {
      if (value?.kind !== "object") return c.mismatch(path, "native object");
      const v = codec.decode(value, path);
      return v.ok ? { ok: true, value: Object.freeze(f(v.value, value)) } : v;
    },
  };
}
const nonempty = c.refine(c.text, (s) => s.length > 0, "nonempty cursor");
const statuses = choice(TICKET_STATUSES);
export const summaryTicket: c.Codec<TicketSummary> = map(
  fields({
    ticket_id: d.identifier,
    revision: d.positiveDecimal,
    title: c.text,
    status: statuses,
    readiness: readinessCodec,
  }),
  (v, raw) => ({
    ticketId: v.ticket_id,
    revision: v.revision,
    title: v.title,
    status: v.status,
    raw,
  }),
);
const project: c.Codec<ProjectSummary> = map(
  fields({ project_id: d.identifier, title: c.text, description: c.text }),
  (v, raw) => ({ projectId: v.project_id, title: v.title, description: v.description, raw }),
);
export function page<T>(item: c.Codec<T>): c.Codec<ExcerptPage<T>> {
  return map(
    c.refine(
      fields({
        items: c.array(item, 100),
        offset: d.decimal,
        remaining: d.decimal,
        next_offset: c.nullable(d.decimal),
      }),
      (p) =>
        p.remaining === "0"
          ? p.next_offset === null
          : p.items.length > 0 &&
            p.next_offset !== null &&
            BigInt(p.next_offset) === BigInt(p.offset) + BigInt(p.items.length),
      "native contiguous excerpt page",
    ),
    (p) => ({ ...p, nextOffset: p.next_offset }),
  );
}
const statusCounts = fields({
  backlog: d.decimal,
  todo: d.decimal,
  in_progress: d.decimal,
  done: d.decimal,
  canceled: d.decimal,
});
export const workspaceSummary: c.Codec<OverviewSummary> = map(
  fields({
    name: c.text,
    projects: d.decimal,
    tickets: d.decimal,
    ready: d.decimal,
    counts_by_status: statusCounts,
    active_projects: page(project),
    held_work: page(summaryTicket),
    blocked_work: page(summaryTicket),
  }),
  (v, raw) => ({
    kind: "workspace",
    title: v.name,
    description:
      "Your workspace at a glance. Pick up ready work, follow progress, and see what needs attention.",
    metrics: [
      {
        kind: "ready",
        label: "Graph ready",
        value: v.ready,
        denominator: null,
        meaning: "Native graph-ready count; run admission is checked separately.",
      },
      {
        kind: "working",
        label: "In progress",
        value: v.counts_by_status.in_progress,
        denominator: null,
        meaning: "Active tickets with in-progress status, excluding archived scopes.",
      },
      {
        kind: "blocked",
        label: "Blocked",
        value: total(v.blocked_work),
        denominator: null,
        meaning: "Native held or prerequisite-blocked tickets.",
      },
      {
        kind: "claimed",
        label: "Claimed",
        value: total(v.held_work),
        denominator: null,
        meaning: "Claimed tickets matching the selected actor/run filters; not policy holds.",
      },
      {
        kind: "done",
        label: "Done",
        value: v.counts_by_status.done,
        denominator: null,
        meaning: "Active done tickets, excluding archived scopes.",
      },
    ],
    progress: null,
    statusCounts: TICKET_STATUSES.map((status) => ({ status, count: v.counts_by_status[status] })),
    projects: v.active_projects,
    ready: null,
    working: v.held_work,
    blocked: v.blocked_work,
    raw,
  }),
);
export const projectSummary: c.Codec<OverviewSummary> = map(
  fields({
    project,
    progress: c.refine(
      fields({ total: d.decimal, done: d.decimal, blocked: d.decimal }),
      (v) => BigInt(v.done) <= BigInt(v.total) && BigInt(v.blocked) <= BigInt(v.total),
      "done and blocked <= complete native ticket count",
    ),
    ready_work: page(summaryTicket),
    in_progress_work: page(summaryTicket),
    blocked_work: page(summaryTicket),
    communication: fields({ requests: page(c.object) }),
  }),
  (v, raw) => ({
    kind: "project",
    title: v.project.title,
    description: v.project.description,
    metrics: [
      {
        kind: "ready",
        label: "Ready",
        value: total(v.ready_work),
        denominator: null,
        meaning: "Native graph-ready project tickets; not run admission.",
      },
      {
        kind: "working",
        label: "In progress",
        value: total(v.in_progress_work),
        denominator: null,
        meaning: "Project tickets with in-progress status.",
      },
      {
        kind: "blocked",
        label: "Blocked",
        value: v.progress.blocked,
        denominator: null,
        meaning: "Native held or prerequisite-blocked project tickets.",
      },
      {
        kind: "done",
        label: "Done",
        value: v.progress.done,
        denominator: v.progress.total,
        meaning: "Done out of all nonarchived project tickets, including the native omitted tail.",
      },
    ],
    progress: v.progress,
    statusCounts: [],
    projects: null,
    ready: v.ready_work,
    working: v.in_progress_work,
    blocked: v.blocked_work,
    raw,
  }),
);
/** Only initial offset zero is used for a full selected collection count. */
export function total<T>(p: ExcerptPage<T>): Decimal {
  return (BigInt(p.offset) + BigInt(p.items.length) + BigInt(p.remaining)).toString() as Decimal;
}

const source = c.tagged<JsonObject>("kind", {
  ticket: map(fields({ kind: c.literal("ticket"), ticket_id: d.identifier }), (_, raw) => raw),
  attempt: map(fields({ kind: c.literal("attempt"), attempt_id: d.identifier }), (_, raw) => raw),
  run: map(fields({ kind: c.literal("run"), run_id: d.identifier }), (_, raw) => raw),
  request: map(fields({ kind: c.literal("request"), request_id: d.identifier }), (_, raw) => raw),
  reservation: map(fields({ kind: c.literal("reservation"), name: d.identifier }), (_, raw) => raw),
  reconciliation: map(
    fields({
      kind: c.literal("reconciliation"),
      serial: d.positiveDecimal,
      attempt_id: d.identifier,
    }),
    (_, raw) => raw,
  ),
  submission: map(
    fields({
      kind: c.literal("submission"),
      ticket_id: d.identifier,
      generation: d.positiveDecimal,
    }),
    (_, raw) => raw,
  ),
  usage: map(fields({ kind: c.literal("usage"), usage_id: d.identifier }), (_, raw) => raw),
  run_budget: map(fields({ kind: c.literal("run_budget"), run_id: d.identifier }), (_, raw) => raw),
});
const coordinationKinds = [
  "active_attempt",
  "ready_work",
  "allocation_blocked",
  "unanswered_request",
  "stale_run",
  "unobserved_run",
  "stale_ownership",
  "expired_ownership",
  "changed_input",
  "pending_review",
  "reservation",
  "reported_usage",
  "budget_limit",
  "dependency_bottleneck",
  "runner_action",
] as const;
const title = (kind: string) => kind.replaceAll("_", " ");
const text = (o: JsonObject, name: string): string | null => {
  const v = jsonField(o, name);
  return v?.kind === "string" ? v.value : null;
};
export const coordinationRow: c.Codec<CoordinationRow> = {
  decode(value, path = []) {
    const v = fields({ kind: choice(coordinationKinds), source, metadata: c.object }).decode(
      value,
      path,
    );
    if (!v.ok || value?.kind !== "object") return v.ok ? c.mismatch(path, "coordination row") : v;
    let rowTitle = title(v.value.kind),
      description = "Captured current record; inspect its source for details.";
    let readiness: import("../work/read-model.types").Readiness | null = null;
    const metadata = v.value.metadata;
    if (v.value.kind === "ready_work" || v.value.kind === "allocation_blocked") {
      const m = fields({
        title: c.text,
        blockers: readinessCodec,
        eligibility_scope: choice(["graph", "run"]),
        allocation_reasons: c.array(c.object, 100),
      }).decode(metadata, [...path, "metadata"]);
      if (!m.ok) return m;
      rowTitle = m.value.title;
      readiness = m.value.blockers;
      description = `${m.value.eligibility_scope === "graph" ? "Graph readiness" : "Run admission"}: ${v.value.kind === "ready_work" ? "ready" : "blocked"}. ${m.value.blockers.reason_count} recorded readiness reasons; ${m.value.allocation_reasons.length} allocation reasons.`;
    } else if (v.value.kind === "dependency_bottleneck") {
      const m = c
        .refine(
          fields({ waiting_count: d.decimal, waiting_ticket_ids: c.array(d.identifier, 100000) }),
          (m) =>
            BigInt(m.waiting_count) === BigInt(m.waiting_ticket_ids.length) &&
            new Set(m.waiting_ticket_ids).size === m.waiting_ticket_ids.length,
          "complete distinct waiting tickets",
        )
        .decode(metadata, [...path, "metadata"]);
      if (!m.ok) return m;
      description = `${m.value.waiting_count} tickets depend on this prerequisite.`;
    } else if (v.value.kind === "reported_usage") {
      const m = usageRecord.decode(metadata, [...path, "metadata"]);
      if (!m.ok) return m;
      description = `${m.value.tokens} reported tokens · ${m.value.elapsed_ms} reported ms · actor ${m.value.actor_id}. Caller attribution; not measured provider usage or a complete aggregate.`;
    } else if (v.value.kind === "active_attempt") {
      const m = fields({
        ticket_id: d.identifier,
        run_id: d.identifier,
        state: c.text,
        token: d.positiveDecimal,
        last_checkpoint: c.nullable(c.object),
      }).decode(metadata, [...path, "metadata"]);
      if (!m.ok) return m;
      description = `Ticket ${m.value.ticket_id} · run ${m.value.run_id} · ${m.value.state.replaceAll("_", " ")}. ${m.value.last_checkpoint === null ? "No checkpoint reported." : "A checkpoint is recorded; inspect the exact capture for its reported progress."}`;
    } else if (v.value.kind === "budget_limit") {
      const m = c
        .refine(
          fields({
            run_id: d.identifier,
            kind: choice(["reported_tokens", "reported_elapsed_ms"]),
            reported: int64,
            limit: int64,
            reported_total_is_lower_bound: c.boolean,
            provenance: c.literal("externally_reported"),
          }),
          (m) =>
            BigInt(m.reported) >= BigInt(m.limit) &&
            m.reported_total_is_lower_bound === (m.reported === "9223372036854775807"),
          "externally reported total at limit with exact saturation marker",
        )
        .decode(metadata, [...path, "metadata"]);
      if (!m.ok) return m;
      description = `${m.value.reported_total_is_lower_bound ? "At least " : ""}${m.value.reported} reported ${m.value.kind === "reported_tokens" ? "tokens" : "ms"} against limit ${m.value.limit}. Externally reported, not measured spending.`;
    } else if (v.value.kind === "stale_run" || v.value.kind === "unobserved_run") {
      const m = fields({
        status: c.text,
        liveness_is_advisory: c.literal(true),
        clock_regressed: c.boolean,
        observation_age_ms: c.nullable(int64),
      }).decode(metadata, [...path, "metadata"]);
      if (!m.ok) return m;
      description = m.value.clock_regressed
        ? "Observation clock regressed; age unavailable. Recorded state is advisory, not process liveness."
        : m.value.observation_age_ms === null
          ? "No observation is recorded. This does not establish process liveness."
          : `Last observed ${m.value.observation_age_ms} ms before this capture. Advisory, not proof the process stopped.`;
    } else if (v.value.kind === "unanswered_request") {
      const m = fields({
        thread_id: d.identifier,
        kind: c.text,
        unacknowledged_recipients: d.decimal,
        responsibility: c.object,
      }).decode(metadata, [...path, "metadata"]);
      if (!m.ok) return m;
      description = `${m.value.kind.replaceAll("_", " ")} · ${m.value.unacknowledged_recipients} unacknowledged recipients. Responsibility and resolution are separate.`;
    }
    const expectedSource =
      v.value.kind === "ready_work" ||
      v.value.kind === "allocation_blocked" ||
      v.value.kind === "dependency_bottleneck"
        ? "ticket"
        : v.value.kind === "active_attempt"
          ? "attempt"
          : v.value.kind === "unanswered_request"
            ? "request"
            : v.value.kind === "stale_run" ||
                v.value.kind === "unobserved_run" ||
                v.value.kind === "runner_action"
              ? "run"
              : v.value.kind === "pending_review"
                ? "submission"
                : v.value.kind === "changed_input"
                  ? "reconciliation"
                  : v.value.kind === "reported_usage"
                    ? "usage"
                    : v.value.kind === "budget_limit"
                      ? "run_budget"
                      : v.value.kind === "reservation"
                        ? "reservation"
                        : null;
    if (expectedSource !== null && text(v.value.source, "kind") !== expectedSource)
      return c.mismatch([...path, "source"], "source kind corresponding to coordination row");
    return {
      ok: true,
      value: Object.freeze({
        kind: v.value.kind,
        source: v.value.source,
        title: rowTitle,
        description,
        readiness,
        raw: value,
      }),
    };
  },
};
export const coordinationPage: c.Codec<CoordinationPage> = map(
  c.refine(
    fields({
      captured_now_unix_ms: int64,
      items: c.array(coordinationRow, 100),
      next_cursor: c.nullable(nonempty),
      omitted: d.decimal,
      needs_larger_budget: c.boolean,
      required_bytes: c.nullable(d.decimal),
    }),
    (v) => v.next_cursor !== null || v.omitted === "0",
    "omitted rows require continuation",
  ),
  (v, raw) => ({
    observedUnixMs: v.captured_now_unix_ms,
    items: v.items,
    cursor: v.next_cursor,
    omitted: v.omitted,
    needsLargerBudget: v.needs_larger_budget,
    requiredBytes: v.required_bytes,
    raw,
  }),
);
export const readinessPage: c.Codec<ReadinessPage> = map(
  fields({
    workspace_revision: d.decimal,
    observed_unix_ms: int64,
    items: c.array(coordinationRow, 100),
    cursor: c.nullable(nonempty),
    has_more: c.boolean,
    needs_larger_budget: c.boolean,
    required_bytes: c.nullable(d.decimal),
  }),
  (v) => ({
    revision: v.workspace_revision,
    observedUnixMs: v.observed_unix_ms,
    items: v.items,
    cursor: v.cursor,
    hasMore: v.has_more,
    needsLargerBudget: v.needs_larger_budget,
    requiredBytes: v.required_bytes,
  }),
);
const notification = fields({
  notification_id: d.positiveDecimal,
  source: c.object,
  source_revision: d.decimal,
  kind: c.text,
  causal_body: c.nullable(c.object),
});
export const attentionRow: c.Codec<AttentionRow> = {
  decode(value, path = []) {
    const base = fields({
      kind: choice([
        "ticket_changed",
        "fact_changed",
        "readiness_invalidated",
        "hierarchy_policy_changed",
        "communication_group",
      ]),
      source: fields({ workspace_revision: d.positiveDecimal, change_index: d.decimal }),
    }).decode(value, path);
    if (!base.ok || value?.kind !== "object")
      return base.ok ? c.mismatch(path, "attention row") : base;
    let rowTitle = title(base.value.kind),
      ids: readonly Decimal[] = [];
    if (base.value.kind === "communication_group") {
      const v = fields({
        group_id: nonempty,
        fragment_index: d.decimal,
        fragment_count: d.positiveDecimal,
        notification_ids: c.array(d.positiveDecimal, 32),
        notifications: c.array(notification, 32),
      }).decode(value, path);
      if (!v.ok) return v;
      if (
        v.value.notification_ids.length === 0 ||
        v.value.notification_ids.length !== v.value.notifications.length ||
        v.value.notifications.some(
          (n, i) =>
            n.notification_id !== v.value.notification_ids[i] ||
            (i > 0 &&
              BigInt(n.notification_id) <= BigInt(v.value.notifications[i - 1]!.notification_id)),
        ) ||
        BigInt(v.value.fragment_index) >= BigInt(v.value.fragment_count)
      )
        return c.mismatch(
          path,
          "matching ordered raw notification IDs and valid fragment position",
        );
      ids = v.value.notification_ids;
      rowTitle = `${ids.length} received notifications · fragment ${BigInt(v.value.fragment_index) + 1n}/${v.value.fragment_count}`;
    } else if (base.value.kind === "ticket_changed") {
      const v = fields({
        ticket_id: d.identifier,
        ticket_revision: d.positiveDecimal,
        status: statuses,
      }).decode(value, path);
      if (!v.ok) return v;
      rowTitle = `${v.value.ticket_id} · ${v.value.status.replaceAll("_", " ")}`;
    } else if (base.value.kind === "readiness_invalidated") {
      const v = fields({ reason: c.text }).decode(value, path);
      if (!v.ok) return v;
      rowTitle = `Readiness may have changed · ${v.value.reason.replaceAll("_", " ")}`;
    } else if (base.value.kind === "hierarchy_policy_changed") {
      const v = fields({ ticket_id: d.identifier, policy_revision: d.positiveDecimal }).decode(
        value,
        path,
      );
      if (!v.ok) return v;
      rowTitle = `${v.value.ticket_id} · hierarchy policy changed`;
    } else {
      const v = fields({ fact: c.object }).decode(value, path);
      if (!v.ok) return v;
    }
    return {
      ok: true,
      value: {
        kind: base.value.kind,
        revision: base.value.source.workspace_revision,
        changeIndex: base.value.source.change_index,
        title: rowTitle,
        notificationIds: ids,
        raw: value,
      },
    };
  },
};
export const attentionPage: c.Codec<AttentionPage> = map(
  fields({
    through: d.decimal,
    cursor: nonempty,
    items: c.array(attentionRow, 100),
    has_more: c.boolean,
    needs_larger_budget: c.boolean,
    required_bytes: c.nullable(d.decimal),
    readiness: c.nullable(readinessPage),
  }),
  (v, raw) => ({
    through: v.through,
    cursor: v.cursor,
    items: v.items,
    hasMore: v.has_more,
    needsLargerBudget: v.needs_larger_budget,
    requiredBytes: v.required_bytes,
    readiness: v.readiness,
    raw,
  }),
);

const retainedSource = (shape: Readonly<Record<string, c.Codec<unknown>>>) =>
  map(fields(shape), (_, raw) => raw);
const revisionSource = (name: string) =>
  retainedSource({ [name]: d.identifier, revision: d.positiveDecimal });
const digestSource: c.Codec<JsonObject> = c.tagged("kind", {
  ticket: revisionSource("ticket_id"),
  handoff: retainedSource({
    ticket_id: d.identifier,
    revision: d.positiveDecimal,
    covers_through: d.decimal,
  }),
  comment: retainedSource({
    comment_id: d.identifier,
    revision: d.positiveDecimal,
    sequence: d.positiveDecimal,
  }),
  fact: retainedSource({
    scope: scopeCodec,
    key: keyCodec,
    revision: d.positiveDecimal,
    changed_at_revision: d.positiveDecimal,
  }),
  run: revisionSource("run_id"),
  attempt: revisionSource("attempt_id"),
  request: revisionSource("request_id"),
  condition: revisionSource("condition_id"),
  ticket_recovery: retainedSource({ recovery_id: d.identifier, sequence: d.positiveDecimal }),
  reservation_recovery: retainedSource({ recovery_id: d.identifier, sequence: d.positiveDecimal }),
  resource_version: retainedSource({
    resource: fields({ resource_id: d.identifier, revision: d.positiveDecimal, digest: d.digest }),
  }),
  planning_change: retainedSource({
    workspace_revision: d.positiveDecimal,
    change_index: d.decimal,
  }),
});
export const digestItem: c.Codec<DigestItem> = map(
  fields({
    kind: c.text,
    summary: c.text,
    sources: c.array(digestSource, 100),
    record: c.object,
    clipped_fields: c.array(
      fields({ field: nonempty, original_bytes: d.decimal, omitted_bytes: d.positiveDecimal }),
      16,
    ),
  }),
  (v, raw) => ({
    kind: v.kind,
    summary: v.summary,
    sources: v.sources,
    record: v.record,
    clipped: v.clipped_fields.map((x) => ({
      field: x.field,
      originalBytes: x.original_bytes,
      omittedBytes: x.omitted_bytes,
    })),
    raw,
  }),
);
const entry = map(
  fields({
    workspace_revision: d.positiveDecimal,
    change_index: d.decimal,
    category: choice([
      "completion",
      "reopening",
      "decision",
      "blocker",
      "request",
      "condition",
      "recovery",
      "ownership",
      "progress",
      "fact",
      "task_changed",
      "resource",
    ]),
    item: digestItem,
  }),
  (v) => ({
    revision: v.workspace_revision,
    changeIndex: v.change_index,
    category: v.category,
    item: v.item,
  }),
);
function validClips(item: DigestItem): boolean {
  if (new Set(item.clipped.map((clip) => clip.field)).size !== item.clipped.length) return false;
  return item.clipped.every((clip) => {
    const value = jsonField(item.record, clip.field);
    return (
      value?.kind === "string" &&
      BigInt(new TextEncoder().encode(value.value).byteLength) + BigInt(clip.omittedBytes) ===
        BigInt(clip.originalBytes)
    );
  });
}
export const activityDigest: c.Codec<ActivityDigest> = map(
  c.refine(
    fields({
      capture: fields({
        after: d.decimal,
        after_change_index: c.nullable(d.decimal),
        through: d.decimal,
        lineage: d.digest,
      }),
      entries: c.array(entry, 100),
      outstanding_requests: c.array(digestItem, 100),
      counts: c.array(
        fields({ section: nonempty, total: d.decimal, returned: d.decimal, omitted: d.decimal }),
        32,
      ),
      cursor: nonempty,
      has_more: c.boolean,
    }),
    (v) => {
      if (
        BigInt(v.capture.after) > BigInt(v.capture.through) ||
        new Set(v.counts.map((x) => x.section)).size !== v.counts.length
      )
        return false;
      if (v.counts.some((x) => BigInt(x.returned) + BigInt(x.omitted) !== BigInt(x.total)))
        return false;
      if (
        !v.counts.some(
          (x) => x.section === "entries" && BigInt(x.returned) === BigInt(v.entries.length),
        )
      )
        return false;
      let previousRevision = BigInt(v.capture.after),
        previousIndex =
          v.capture.after_change_index === null
            ? 9223372036854775807n
            : BigInt(v.capture.after_change_index);
      for (const row of v.entries) {
        const revision = BigInt(row.revision),
          index = BigInt(row.changeIndex);
        if (
          revision > BigInt(v.capture.through) ||
          revision < previousRevision ||
          (revision === previousRevision && index <= previousIndex)
        )
          return false;
        if (
          !row.item.sources.some(
            (s) =>
              text(s, "kind") === "planning_change" &&
              text(s, "workspace_revision") === row.revision &&
              text(s, "change_index") === row.changeIndex,
          )
        )
          return false;
        previousRevision = revision;
        previousIndex = index;
        if (!validClips(row.item)) return false;
      }
      return v.outstanding_requests.every(validClips);
    },
    "ordered digest rows, exact source pins, complete counts and honest clipped bytes",
  ),
  (v, raw) => ({
    capture: {
      after: v.capture.after,
      afterChangeIndex: v.capture.after_change_index,
      through: v.capture.through,
      lineage: v.capture.lineage,
    },
    entries: v.entries,
    outstandingRequests: v.outstanding_requests,
    counts: v.counts,
    cursor: v.cursor,
    hasMore: v.has_more,
    raw,
  }),
);
export function field(value: JsonValue, name: string): string | null {
  return value.kind === "object" ? text(value, name) : null;
}
