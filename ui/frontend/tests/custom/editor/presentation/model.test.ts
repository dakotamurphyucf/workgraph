import { describe, it, expect } from "vitest";
import * as d from "../../../../src/core/protocol/decoders";
import type { Column, LoadedRow, ViewConfig } from "../../../../src/features/custom/config";
import {
  cellReference,
  coveredCell,
  filteredRows,
  groupRows,
  timelineGroups,
  transformedRows,
} from "../../../../src/features/custom/editor/presentation/model";
const id = d.identifier.decode(d.jsonString("view"));
if (!id.ok) throw new Error("fixture ID");
const column: Column = {
  id: id.value,
  label: "Value",
  selector: { kind: "pointer", pointer: "" },
  format: { type: "json" },
};
const view: ViewConfig = {
  config_version: 1,
  kind: "view",
  id: id.value,
  title: "Rows",
  source: "sessions",
  scope: { kind: "workspace" },
  filter_mode: "loaded",
  filters: [],
  sort: [{ field: "created_at", direction: "asc", nulls: "last" }],
  group_by: null,
  presentation: "timeline",
  columns: [column],
};
const row = (identity: string, fields: LoadedRow["fields"]): LoadedRow => ({ identity, fields });
describe("supplied row presentation", () => {
  it("keeps unknown pointer matches separate even for a complete metadata collection", () => {
    const config: ViewConfig = {
      ...view,
      source: "facts",
      sort: [],
      filters: [{ pointer: "/score", op: "equals", value: { kind: "number", lexeme: "1" } }],
      columns: [{ ...column, selector: { kind: "field", field: "key" }, format: { type: "text" } }],
    };
    const rows = [
      row("budget", { key: d.jsonString("report.a") }),
      {
        ...row("known", { key: d.jsonString("report.b") }),
        decoded: d.jsonObject([["score", d.jsonNumber("0")]]),
      },
    ];
    const result = filteredRows(config, rows, {
      capture: [],
      complete: true,
      partial: false,
      stop: "complete",
      values: [
        { identity: "budget", status: "budget", message: "join response omitted", pin: null },
        { identity: "known", status: "decoded", message: null, pin: null },
      ],
    });
    expect(result.matches).toHaveLength(0);
    expect(result.notEvaluated.map((entry) => entry.row.identity)).toEqual(["budget"]);
    expect(result.notEvaluated[0]?.reason).toContain("budget");
    expect(
      filteredRows(
        {
          ...config,
          filters: [
            ...config.filters,
            { field: "key", op: "equals", value: { kind: "string", value: "other" } },
          ],
        },
        rows,
      ).notEvaluated,
    ).toHaveLength(0);
  });
  it("retains full extended-year date identity when grouping native timestamps", () => {
    const rows = [
      row("day1", { created_at: d.jsonNumber("253402300800000") }),
      row("day2", { created_at: d.jsonNumber("253402387200000") }),
    ];
    expect(timelineGroups(rows, view).map((group) => group.label)).toEqual([
      "+010000-01-01",
      "+010000-01-02",
    ]);
  });

  it("orders real session times, leaving null/malformed/out-of-range dates Unknown", () => {
    const rows = [
      row("null", { created_at: d.jsonNull() }),
      row("late", { created_at: d.jsonNumber("2000") }),
      row("huge", { created_at: d.jsonNumber("9223372036854775807") }),
      row("early", { created_at: d.jsonNumber("1000") }),
      row("bad", { created_at: d.jsonString("tomorrow") }),
    ];
    const ordered = transformedRows(view, rows);
    expect(ordered.map((r) => r.identity)).toEqual(["early", "late", "huge", "bad", "null"]);
    expect(
      timelineGroups(ordered, view).map((g) => [g.label, g.rows.map((r) => r.identity)]),
    ).toEqual([
      ["1970-01-01", ["early", "late"]],
      ["Unknown time", ["huge", "bad", "null"]],
    ]);
  });
  it("does not reapply server filters as invented loaded fields", () => {
    const rows = [row("a", { title: d.jsonString("Apple") })],
      query = {
        ...view,
        source: "tickets" as const,
        sort: [],
        filters: [{ field: "text", op: "contains_text" as const, value: "Apple" }],
      };
    expect(transformedRows({ ...query, filter_mode: "server" }, rows)).toHaveLength(1);
    expect(transformedRows({ ...query, filter_mode: "loaded" }, rows)).toHaveLength(0);
  });
  it("distinguishes metadata-only, missing, deleted, budget, invalid and decoded explicit null", () => {
    const r = row("r", {}),
      coverage = { capture: [], complete: true, partial: false, stop: "complete" };
    const metadataOnly = coveredCell(r, column, coverage);
    expect(metadataOnly.kind).toBe("unavailable");
    if (metadataOnly.kind === "unavailable") expect(metadataOnly.message).toContain("not evidence");
    for (const status of [
      "missing",
      "deleted",
      "unsupported",
      "budget",
      "invalid",
      "unavailable",
    ] as const) {
      const observed = coveredCell(r, column, {
        ...coverage,
        values: [{ identity: "r", status, message: null, pin: null }],
      });
      expect(observed.kind).toBe("unavailable");
      if (observed.kind === "unavailable") expect(observed.message).toContain(status);
    }
    expect(
      coveredCell({ ...r, decoded: d.jsonNull() }, column, {
        ...coverage,
        values: [{ identity: "r", status: "decoded", message: null, pin: null }],
      }),
    ).toEqual({ kind: "json", value: d.jsonNull() });
  });
  it("never navigates malformed entity IDs or nullable non-workspace identities", () => {
    expect(cellReference({ kind: "entity", entity: "ticket", id: null })).toBeNull();
    expect(cellReference({ kind: "entity", entity: "ticket", id: "../bad" })).toBeNull();
    expect(cellReference({ kind: "entity", entity: "unknown", id: "t" })).toBeNull();
    expect(cellReference({ kind: "entity", entity: "workspace", id: null })).toEqual({
      kind: "entity",
      entity: "workspace",
    });
    expect(cellReference({ kind: "entity", entity: "ticket", id: "t" })).toEqual({
      kind: "entity",
      entity: "ticket",
      id: "t",
    });
  });
  it("keeps distinct null, missing, and literal group names without duplicate render keys", () => {
    const groups = groupRows(
      [row("a", { s: d.jsonNull() }), row("b", {}), row("c", { s: d.jsonString("Null") })],
      "s",
    );
    expect(groups).toHaveLength(3);
    expect(new Set(groups.map((g) => g.key)).size).toBe(3);
  });
});
