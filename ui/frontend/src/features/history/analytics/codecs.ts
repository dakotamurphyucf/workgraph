import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import { choice, fields } from "../../participants/runs/codecs";
import { eventRef, sequence } from "../transcript/codecs";
import type {
  GroupKey,
  MetricSample,
  MetricTotal,
  SearchPage,
  UsageAggregate,
  UsagePage,
  UsageRecord,
  UsageRow,
  UsageScope,
  UsageTotals,
} from "./types";

export const text = (max: number, nonblank = false) =>
  c.refine(
    c.text,
    (value) =>
      new TextEncoder().encode(value).byteLength <= max &&
      (!nonblank || /[^ \t\n\r\f\v]/u.test(value)),
    `UTF-8 text <=${max} bytes${nonblank ? ", nonblank" : ""}`,
  );
export const int64 = c.refine(
  c.text,
  (value) =>
    /^(0|[1-9][0-9]{0,18})(?![\s\S])/u.test(value) && BigInt(value) <= 9223372036854775807n,
  "nonnegative canonical int64",
);
export const searchPage: c.Codec<SearchPage> = c.refine(
  c.record({
    items: c.array(
      c.record({
        event_ref: eventRef,
        kind: text(256),
        role: text(256),
        byte_offset: d.decimal,
        snippet: text(512),
      }),
      100,
    ),
    next: c.nullable(eventRef),
    restart_after_indexing: c.boolean,
    has_more: c.boolean,
    coverage: c.array(
      c.refine(
        c.record({
          session_id: d.identifier,
          committed_through: sequence,
          indexed_through: sequence,
        }),
        (v) => BigInt(v.indexed_through) <= BigInt(v.committed_through),
        "index watermark <= committed through",
      ),
      1_000_000,
    ),
    index_complete: c.boolean,
    unindexed_events: d.decimal,
    unsearchable_events: d.decimal,
    omitted_for_budget: d.decimal,
  }),
  (v) =>
    v.index_complete === (v.unindexed_events === "0") &&
    v.restart_after_indexing !== v.index_complete &&
    (v.next !== null) === (v.index_complete && v.has_more),
  "independent, consistent search coverage and continuation",
);
export const metricName = c.refine(
  text(64, true),
  (v) => /^[A-Za-z0-9_.-]+$/u.test(v) && v !== "tokens" && v !== "elapsed_ms",
  "nonreserved ASCII metric name",
);
export const metricUnit = c.refine(
  text(32, true),
  (v) => /^[A-Za-z0-9_./%-]+$/u.test(v),
  "explicit ASCII metric unit",
);
export const metric: c.Codec<MetricSample> = c.record({
  name: metricName,
  unit: metricUnit,
  value: int64,
});
export const metricTotal: c.Codec<MetricTotal> = c.refine(
  c.record({
    name: metricName,
    unit: metricUnit,
    value: int64,
    samples: d.positiveDecimal,
    overflow: c.boolean,
  }),
  (v) => !v.overflow || v.value === "9223372036854775807",
  "truthfully saturated metric total",
);
export const usageScope: c.Codec<UsageScope> = c.tagged<UsageScope>("kind", {
  run: c.record({ kind: c.literal("run"), run_id: d.identifier }),
  attempt: c.record({ kind: c.literal("attempt"), attempt_id: d.identifier }),
});
export const usageRecord: c.Codec<UsageRecord> = c.refine(
  c.record({
    usage_id: d.identifier,
    scope: usageScope,
    actor_id: d.identifier,
    tokens: int64,
    elapsed_ms: int64,
    metrics: c.array(metric, 16),
    provenance: text(4096, true),
    timestamp: text(128, true),
  }),
  (v) => v.metrics.every((m, i) => i === 0 || (v.metrics[i - 1]?.name ?? "") < m.name),
  "unique sorted named samples",
);
export const usagePage: c.Codec<UsagePage> = c.record({
  items: c.array(usageRecord, 100),
  next_offset: c.nullable(d.decimal),
  omitted: d.decimal,
});
export const totals: c.Codec<UsageTotals> = c.refine(
  c.record({
    observations: d.decimal,
    tokens: int64,
    elapsed_ms: int64,
    overflow: c.boolean,
    metric_series: d.decimal,
    metric_overflow: c.boolean,
  }),
  (v) =>
    (v.observations !== "0" ||
      (v.tokens === "0" &&
        v.elapsed_ms === "0" &&
        !v.overflow &&
        v.metric_series === "0" &&
        !v.metric_overflow)) &&
    (!v.overflow || v.tokens === "9223372036854775807" || v.elapsed_ms === "9223372036854775807") &&
    (!v.metric_overflow || v.metric_series !== "0"),
  "usage sources and saturation agree",
);
export const groupKey: c.Codec<GroupKey> = c.tagged<GroupKey>("kind", {
  workspace: c.record({ kind: c.literal("workspace") }),
  project: c.record({ kind: c.literal("project"), project_id: d.identifier }),
  milestone: c.record({ kind: c.literal("milestone"), milestone_id: d.identifier }),
  ticket: c.record({ kind: c.literal("ticket"), ticket_id: d.identifier }),
  run: c.record({ kind: c.literal("run"), run_id: d.identifier }),
  attempt: c.record({ kind: c.literal("attempt"), attempt_id: d.identifier }),
  unassigned: c.record({
    kind: c.literal("unassigned"),
    reason: choice([
      "run_scope_has_no_attempt",
      "ticket_has_no_project",
      "ticket_has_no_milestone",
    ]),
  }),
});
export const row: c.Codec<UsageRow> = c.tagged<UsageRow>("kind", {
  usage: c.record({
    kind: c.literal("usage"),
    group: groupKey,
    totals,
    metrics: c.optional(c.array(metricTotal, 100_000)),
  }),
  metric: c.record({ kind: c.literal("metric"), group: groupKey, metric: metricTotal }),
});
export const aggregate: c.Codec<UsageAggregate> = c.refine(
  c.record({
    basis: c.literal("externally_reported"),
    membership_basis: c.literal("current_capture"),
    group_by: choice(["workspace", "project", "milestone", "ticket", "run", "attempt"]),
    metrics_layout: choice(["rows", "nested", "totals_only"]),
    totals,
    unassigned_run_usage: totals,
    unassigned_in_totals: c.boolean,
    unassigned_scope: c.literal("run_and_actor_filters"),
    items: c.array(row, 100),
    cursor: c.nullable(text(4096, true)),
    has_more: c.boolean,
    needs_larger_budget: c.boolean,
    required_bytes: c.nullable(d.decimal),
  }),
  (v) =>
    (v.cursor !== null) === v.has_more &&
    v.needs_larger_budget === (v.items.length === 0 && v.has_more) &&
    (v.required_bytes !== null) === v.needs_larger_budget &&
    v.items.every((item) => {
      if (v.metrics_layout === "rows") return item.kind === "metric" || item.metrics === undefined;
      if (item.kind !== "usage") return false;
      if (v.metrics_layout === "totals_only") return item.metrics === undefined;
      const m = item.metrics;
      return (
        m !== undefined &&
        BigInt(m.length) === BigInt(item.totals.metric_series) &&
        m.every(
          (x, i) =>
            i === 0 ||
            (m[i - 1]?.name ?? "") < x.name ||
            (m[i - 1]?.name === x.name && (m[i - 1]?.unit ?? "") < x.unit),
        ) &&
        m.some((x) => x.overflow) === item.totals.metric_overflow
      );
    }),
  "layout-complete usage page and exact budget continuation",
);
export const policyMeta = fields({ query_scope: c.literal("policy"), query_revision: d.decimal });
export const planningMeta = fields({ workspace_revision: d.decimal });
