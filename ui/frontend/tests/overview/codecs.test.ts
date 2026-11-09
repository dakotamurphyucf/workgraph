import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { jsonField, parseJsonText, type JsonValue } from "../../src/core/json";
import type { Codec } from "../../src/core/protocol/codec";
import {
  activityDigest,
  attentionPage,
  coordinationPage,
  projectSummary,
  workspaceSummary,
} from "../../src/features/overview/codecs";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/native-probe.json", import.meta.url), "utf8"),
) as { readonly reads: readonly { readonly method: string; readonly raw: string }[] };
function source(method: string): JsonValue {
  const raw = fixture.reads.find((x) => x.method === method)?.raw;
  if (raw === undefined) throw new Error("Missing actual executable probe");
  const value = parseJsonText(raw);
  if (!value.ok) throw new Error(value.error.message);
  const result = jsonField(value.value.value, "result");
  const data = result === undefined ? undefined : jsonField(result, "data");
  if (data === undefined) throw new Error("Actual native probe has no success data");
  return data;
}
function change(value: JsonValue, name: string, replacement: JsonValue): JsonValue {
  if (value.kind !== "object") throw new Error("Expected test object");
  return {
    kind: "object",
    fields: value.fields.map((f) => (f.name === name ? { name, value: replacement } : f)),
  };
}
function json(text: string): JsonValue {
  const v = parseJsonText(text);
  if (!v.ok) throw new Error(v.error.message);
  return v.value.value;
}

describe("actual native read envelopes", () => {
  for (const [method, codec] of [
    ["workspace.overview", workspaceSummary],
    ["project.brief", projectSummary],
    ["coordinator.overview", coordinationPage],
    ["attention.read", attentionPage],
    ["attention.wait", attentionPage],
    ["activity.digest", activityDigest],
  ] as const) {
    it(`decodes actual ${method} using the production projection`, () => {
      const result = (codec as Codec<unknown>).decode(source(method));
      expect(result).toMatchObject({ ok: true });
    });
  }

  it("keeps complete native counters apart from limited pages and their status scope", () => {
    const result = projectSummary.decode(source("project.brief"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.progress?.total).toBe("3");
    expect(result.value.blocked.items).toHaveLength(2);
    const digest = activityDigest.decode(source("activity.digest"));
    expect(digest.ok).toBe(true);
    if (!digest.ok) return;
    expect(digest.value.entries).toHaveLength(2);
    expect(digest.value.counts.find((x) => x.section === "entries")).toEqual({
      section: "entries",
      total: "8",
      returned: "2",
      omitted: "6",
    });
    expect(digest.value.hasMore).toBe(true);
  });

  it("does not turn independent current readiness into durable activity history", () => {
    const result = attentionPage.decode(source("attention.read"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hasMore).toBe(true);
    expect(result.value.cursor).not.toBe("");
    expect(result.value.readiness?.items).toHaveLength(1);
    expect(result.value.readiness?.cursor).toBe(null);
    expect(result.value.readiness?.hasMore).toBe(false);
    expect(result.value.readiness?.items[0]?.readiness?.assessment.scope).toBe("graph");
  });

  it("rejects inconsistent digest section totals and returned row counts", () => {
    const result = source("activity.digest");
    expect(
      activityDigest.decode(
        change(
          result,
          "counts",
          json('[{"section":"entries","total":"8","returned":"2","omitted":"0"}]'),
        ),
      ).ok,
    ).toBe(false);
    expect(
      activityDigest.decode(
        change(
          result,
          "counts",
          json('[{"section":"entries","total":"8","returned":"1","omitted":"7"}]'),
        ),
      ).ok,
    ).toBe(false);
  });

  it("rejects reordered chronology and a row with no exact planning source pin", () => {
    const result = source("activity.digest"),
      entries = jsonField(result, "entries");
    if (entries?.kind !== "array") throw new Error("Expected native entries");
    expect(
      activityDigest.decode(
        change(result, "entries", { kind: "array", items: [...entries.items].reverse() }),
      ).ok,
    ).toBe(false);
    const first = entries.items[0];
    if (first === undefined) throw new Error("Expected actual row");
    const item = jsonField(first, "item");
    if (item === undefined) throw new Error("Expected actual item");
    const bad = change(
      first,
      "item",
      change(
        item,
        "sources",
        json('[{"kind":"planning_change","workspace_revision":"999","change_index":"0"}]'),
      ),
    );
    expect(
      activityDigest.decode(
        change(result, "entries", { kind: "array", items: [bad, ...entries.items.slice(1)] }),
      ).ok,
    ).toBe(false);
  });

  it("validates UTF8 excerpt byte accounting, including non-ASCII text", () => {
    const result = source("activity.digest"),
      entries = jsonField(result, "entries");
    if (entries?.kind !== "array" || entries.items[0] === undefined) throw new Error("Missing row");
    const first = entries.items[0],
      item = jsonField(first, "item");
    if (item === undefined) throw new Error("Missing item");
    const record = jsonField(item, "record");
    if (record === undefined) throw new Error("Missing record");
    const clipped = (original: string) =>
      change(
        first,
        "item",
        change(
          change(item, "record", change(record, "title", json('"雪"'))),
          "clipped_fields",
          json(`[{"field":"title","original_bytes":"${original}","omitted_bytes":"2"}]`),
        ),
      );
    expect(
      activityDigest.decode(
        change(result, "entries", {
          kind: "array",
          items: [clipped("5"), ...entries.items.slice(1)],
        }),
      ).ok,
    ).toBe(true);
    expect(
      activityDigest.decode(
        change(result, "entries", {
          kind: "array",
          items: [clipped("3"), ...entries.items.slice(1)],
        }),
      ).ok,
    ).toBe(false);
  });
});

it("renders actually recorded usage attribution, attempt and unanswered-request metadata without inventing process liveness", () => {
  const actual = JSON.parse(
    readFileSync(new URL("./fixtures/reported-native.json", import.meta.url), "utf8"),
  ) as { reads: { method: string; raw: string }[] };
  for (const [method, codec] of [
    ["workspace.overview", workspaceSummary],
    ["project.brief", projectSummary],
    ["coordinator.overview", coordinationPage],
    ["attention.read", attentionPage],
    ["attention.wait", attentionPage],
    ["activity.digest", activityDigest],
  ] as const) {
    const entry = actual.reads.find((r) => r.method === method);
    if (entry === undefined) throw new Error("actual method");
    const parsed = parseJsonText(entry.raw);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const result = jsonField(parsed.value.value, "result");
    const data = result === undefined ? undefined : jsonField(result, "data");
    expect((codec as Codec<unknown>).decode(data).ok).toBe(true);
    if (method === "coordinator.overview") {
      const v = coordinationPage.decode(data);
      if (!v.ok) throw new Error(v.issue.expected);
      expect(v.value.items.find((r) => r.kind === "reported_usage")?.description).toContain(
        "9007199254740993 reported tokens",
      );
      expect(v.value.items.find((r) => r.kind === "reported_usage")?.description).toContain(
        "actor fixture-author",
      );
      expect(v.value.items.find((r) => r.kind === "active_attempt")?.description).toContain(
        "reported-run",
      );
      expect(v.value.items.find((r) => r.kind === "unobserved_run")?.description).toContain(
        "does not establish process liveness",
      );
    }
  }
});
