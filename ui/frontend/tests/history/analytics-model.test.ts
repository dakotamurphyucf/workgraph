import { afterAll, describe, expect, it } from "vitest";
import { parseJsonText, jsonField, type JsonValue } from "../../src/core/json";
import * as c from "../../src/core/protocol/codec";
import * as d from "../../src/core/protocol/decoders";
import { aggregate, searchPage, usagePage } from "../../src/features/history/analytics/codecs";
import {
  decodeUsage,
  recordsInvocation,
  searchFields,
  usageInvocation,
} from "../../src/features/history/analytics/client";
import { reportPreparation } from "../../src/features/history/analytics/model";
import { defaultUsage } from "../../src/features/history/analytics/controller";
import { nativeResponses } from "./analytics-native-fixtures";
import { createTestProcessor } from "../core/processing-harness";
import type { FeatureContext } from "../../src/app/types";
import type { UsageDraft } from "../../src/features/history/analytics/types";
function json(value: unknown): JsonValue {
  const v = parseJsonText(JSON.stringify(value));
  if (!v.ok) throw new Error(v.error.message);
  return v.value.value;
}
function decode<T>(codec: c.Codec<T>, value: unknown): T {
  const r = codec.decode(json(value));
  if (!r.ok) throw new Error(`${r.issue.path.join("/")}: ${r.issue.expected}`);
  return r.value;
}
const id = (s: string) => decode(d.identifier, s),
  dec = (s: string) => decode(d.decimal, s);
const scope = { connectionId: id("local"), generation: dec("1"), workspaceId: id("demo") };
const native = (label: string) => {
  const r = nativeResponses.find((v) => v.label === label);
  if (r === undefined) throw new Error(label);
  return r;
};
describe("native History/usage codecs", () => {
  it("decodes all13 actual daemon envelopes with exact method metadata", () => {
    for (const x of nativeResponses) {
      if (x.method === "history.search")
        expect(searchPage.decode(json(x.response.data)).ok, x.label).toBe(true);
      else {
        const request = {
          connection_id: scope.connectionId,
          generation: scope.generation,
          method: x.method,
          params: decode(c.object, x.params),
          lane: "visible" as const,
        };
        expect(
          decodeUsage(request, {
            response: { data: json(x.response.data), meta: decode(c.object, x.response.meta) },
            pagination: null,
          }).ok,
          x.label,
        ).toBe(true);
      }
    }
  });
  it("preserves int64 saturation, exact units and independent unassigned disclosure", () => {
    const all = decode(aggregate, native("usage-nested").response.data),
      project = decode(aggregate, native("usage-project").response.data);
    expect(all.totals.tokens).toBe("9223372036854775807");
    expect(all.totals.overflow).toBe(true);
    expect(all.totals.elapsed_ms).toBe("9007199254740998");
    const metrics = all.items
      .flatMap((v) => (v.kind === "usage" ? (v.metrics ?? []) : []))
      .filter((v) => v.name === "bytes");
    expect(metrics.map((v) => [v.unit, v.value, v.overflow])).toEqual([
      ["KiB", "7", false],
      ["bytes", "9223372036854775807", true],
    ]);
    expect(project.unassigned_in_totals).toBe(false);
    expect(project.unassigned_run_usage.observations).toBe("6");
    expect(project.totals.observations).toBe("1");
  });
  it("retains native whole-group retry at the exact cursor, without accepting partial nested arrays", () => {
    const budget = decode(aggregate, native("usage-budget").response.data),
      retry = decode(aggregate, native("usage-budget-retry").response.data);
    expect(budget.items).toEqual([]);
    expect(budget.needs_larger_budget).toBe(true);
    expect(BigInt(budget.required_bytes ?? "0")).toBeGreaterThan(4096n);
    expect(retry.items.length).toBe(1);
    const value = native("usage-nested").response.data;
    expect(
      aggregate.decode(json({ ...value, items: value.items.map((v) => ({ ...v, metrics: [] })) }))
        .ok,
    ).toBe(false);
    expect(aggregate.decode(json({ ...value, metrics_layout: "totals_only" })).ok).toBe(false);
  });
  it("distinguishes complete traversal from complete indexing and rejects inconsistent cursor claims", () => {
    const empty = decode(searchPage, native("search-empty").response.data);
    expect(empty.index_complete).toBe(true);
    expect(empty.has_more).toBe(false);
    const partial = {
      ...native("search-empty").response.data,
      index_complete: false,
      restart_after_indexing: true,
      unindexed_events: "1",
      has_more: true,
    };
    expect(searchPage.decode(json(partial)).ok).toBe(true);
    expect(
      searchPage.decode(json({ ...partial, next: { session_id: "a-history", sequence: "1" } })).ok,
    ).toBe(false);
    const page = decode(searchPage, native("search-budget").response.data);
    expect(page.omitted_for_budget).toBe("1");
    expect(page.next).not.toBeNull();
  });
  it("rejects catalog capture substitution and nonadvancing offsets", () => {
    const x = native("usage-list"),
      request = recordsInvocation(scope, dec("2"), dec("999"));
    expect(
      decodeUsage(request, {
        response: { data: json(x.response.data), meta: decode(c.object, x.response.meta) },
        pagination: null,
      }).ok,
    ).toBe(false);
    expect(
      usagePage.decode(
        json({
          ...x.response.data,
          items: [{ ...x.response.data.items[0], tokens: "9223372036854775808" }],
        }),
      ).ok,
    ).toBe(false);
  });
  it("exposes all literal filters, native layout and bounded search space semantics", () => {
    const request = usageInvocation(
      scope,
      {
        ...defaultUsage,
        group: "attempt",
        layout: "rows",
        projectId: "release",
        milestoneId: "m",
        ticketId: "design",
        runId: "r",
        attemptId: "a",
        actorId: "person",
      },
      "opaque",
      dec("99"),
    );
    expect(request.params.fields.map((v) => v.name)).toEqual([
      "workspace_id",
      "group_by",
      "metrics_layout",
      "limit",
      "max_bytes",
      "project_id",
      "milestone_id",
      "ticket_id",
      "run_id",
      "attempt_id",
      "actor_id",
      "cursor",
      "at_revision",
    ]);
    expect(() =>
      searchFields({
        text: " ",
        sessionId: "",
        kinds: [],
        capture: { kind: "pinned", head: null },
        limit: "1",
        maxBytes: "4096",
      }),
    ).not.toThrow();
    expect(() =>
      searchFields({
        text: "雪".repeat(86),
        sessionId: "",
        kinds: [],
        capture: { kind: "current" },
        limit: "1",
        maxBytes: "4096",
      }),
    ).toThrow(/256/u);
    expect(() =>
      searchFields({
        text: "x",
        sessionId: "",
        kinds: [],
        capture: { kind: "current" },
        limit: "1",
        maxBytes: "4095",
      }),
    ).toThrow(/4096/u);
  });
});
describe("typed immutable usage reports", () => {
  const processing = createTestProcessor();
  const context: FeatureContext = {
    client: { processing, request: () => Promise.reject(new Error("unused")) },
    connection: decode(d.connectionProfile, {
      id: "local",
      generation: "1",
      label: "Local",
      socket: "/tmp/fixture.sock",
    }),
    profileState: "current",
    route: {
      view: "history",
      connectionId: "local",
      workspaceId: "demo",
      projectId: "release",
      entityId: null,
    },
    writer: { actorId: "original", runId: "original-run" },
    navigate: () => {},
  };
  const draft: UsageDraft = {
    id: id("intention"),
    context,
    input: {
      usageId: "source-report",
      scopeKind: "attempt",
      scopeId: "original-attempt",
      tokens: "9007199254740993",
      elapsedMs: "0",
      metrics: [
        { name: "z", unit: "bytes", value: "0" },
        { name: "a", unit: "KiB", value: "9223372036854775807" },
      ],
      provenance: "Source report, not observed activity",
      timestamp: "unknown source time",
    },
    frozen: null,
    pending: false,
    issue: null,
    unexpected: null,
  };
  it("binds original writer/run, declared scope and exact large integer lexemes", () => {
    const p = reportPreparation(draft);
    expect(p.context.writer).toEqual({ actor_id: "original", run_id: "original-run" });
    expect(jsonField(p.params, "reported_actor_id")).toEqual(d.jsonString("original"));
    expect(jsonField(p.params, "tokens")).toEqual(d.jsonString("9007199254740993"));
    const m = jsonField(p.params, "metrics");
    expect(m?.kind === "array" && jsonField(m.items[0] ?? d.jsonNull(), "name")).toEqual(
      d.jsonString("a"),
    );
  });
  it("does not turn missing quantities into zero, convert units or accept duplicate/reserved sample names", () => {
    expect(() => reportPreparation({ ...draft, input: { ...draft.input, tokens: "" } })).toThrow(
      /exact integer/u,
    );
    expect(() =>
      reportPreparation({
        ...draft,
        input: { ...draft.input, metrics: [{ name: "tokens", unit: "count", value: "1" }] },
      }),
    ).toThrow(/Invalid sample/u);
    expect(() =>
      reportPreparation({
        ...draft,
        input: {
          ...draft.input,
          metrics: [
            { name: "a", unit: "bytes", value: "1" },
            { name: "a", unit: "KiB", value: "1" },
          ],
        },
      }),
    ).toThrow(/distinct/u);
    expect(() =>
      reportPreparation({ ...draft, input: { ...draft.input, tokens: "9223372036854775808" } }),
    ).toThrow(/exact integer/u);
  });
  afterAll(() => processing.dispose());
});
