import { type JsonValue } from "../../../../core/json";
import * as d from "../../../../core/protocol/decoders";
import {
  compareText,
  formatCell,
  matchesLoaded,
  selectPointer,
  sortLoaded,
  timelineTime,
  type CellResult,
  type Column,
  type LoadedRow,
  type ViewConfig,
} from "../../config";
import type { CellReference, RowsCoverage } from "./types";
export function cellValue(row: LoadedRow, column: Column): JsonValue | undefined {
  if (column.selector.kind === "field")
    return Object.hasOwn(row.fields, column.selector.field)
      ? row.fields[column.selector.field]
      : undefined;
  if (row.decoded === undefined) return undefined;
  const selected = selectPointer(row.decoded, column.selector.pointer);
  return selected.kind === "found" ? selected.value : undefined;
}
export const cell = (row: LoadedRow, column: Column) =>
  formatCell(cellValue(row, column), column.format);
/** No unvalidated identifier reaches a host navigation callback. */
export function cellReference(result: CellResult): CellReference | null {
  if (result.kind === "pin") return { kind: "resource_pin", pin: result.pin };
  if (result.kind !== "entity") return null;
  if (result.entity === "workspace" && result.id === null)
    return { kind: "entity", entity: "workspace" };
  const id = result.id === null ? null : d.identifier.decode(d.jsonString(result.id));
  const entity = ["project", "milestone", "ticket", "resource"].find(
    (entity): entity is "project" | "milestone" | "ticket" | "resource" => entity === result.entity,
  );
  return id?.ok && entity !== undefined ? { kind: "entity", entity, id: id.value } : null;
}
export function filteredRows(
  view: ViewConfig,
  rows: readonly LoadedRow[],
  coverage?: RowsCoverage,
): {
  readonly matches: readonly LoadedRow[];
  readonly notEvaluated: readonly { readonly row: LoadedRow; readonly reason: string }[];
} {
  if (view.filter_mode !== "loaded") return { matches: sortLoaded(rows, view), notEvaluated: [] };
  const matches: LoadedRow[] = [],
    notEvaluated: { row: LoadedRow; reason: string }[] = [];
  for (const row of rows) {
    const status = coverage?.values?.find((value) => value.identity === row.identity);
    const pointerAvailable = status?.status === "decoded" && row.decoded !== undefined;
    let mismatch = false,
      unknown = false;
    for (const filter of view.filters) {
      if ("pointer" in filter && !pointerAvailable) unknown = true;
      else if (!matchesLoaded(row, filter)) mismatch = true;
    }
    if (mismatch) continue;
    if (unknown)
      notEvaluated.push({
        row,
        reason:
          status === undefined
            ? "Value not acquired; pointer filter not evaluated."
            : `${status.status}: ${status.message ?? "No usable decoded value; pointer filter not evaluated."}`,
      });
    else matches.push(row);
  }
  return { matches: sortLoaded(matches, view), notEvaluated };
}
export function transformedRows(
  view: ViewConfig,
  rows: readonly LoadedRow[],
  coverage?: RowsCoverage,
): readonly LoadedRow[] {
  return filteredRows(view, rows, coverage).matches;
}
export function groupRows(
  rows: readonly LoadedRow[],
  field: string | null,
): readonly {
  readonly key: string;
  readonly label: string;
  readonly rows: readonly LoadedRow[];
}[] {
  if (field === null) return [{ key: "rows", label: "Rows", rows }];
  const groups = new Map<string, LoadedRow[]>();
  for (const row of rows) {
    const value = Object.hasOwn(row.fields, field) ? row.fields[field] : undefined;
    const label =
      value?.kind === "string"
        ? value.value
        : value?.kind === "number"
          ? value.lexeme
          : value?.kind === "boolean"
            ? String(value.value)
            : value?.kind === "null"
              ? "Null"
              : "Missing / unavailable";
    const key = (value?.kind ?? "missing") + ":" + label;
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, [row]);
    else existing.push(row);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([key, items]) => ({ key, label: key.slice(key.indexOf(":") + 1), rows: items }));
}
export function timelineGroups(rows: readonly LoadedRow[], view: ViewConfig) {
  const groups = new Map<string, LoadedRow[]>();
  for (const row of rows) {
    const time = timelineTime(row, view),
      label =
        time === null
          ? "Unknown time"
          : (new Date(time).toISOString().split("T")[0] ?? "Unknown time");
    const items = groups.get(label);
    if (items === undefined) groups.set(label, [row]);
    else items.push(row);
  }
  return [...groups].map(([label, rows]) => ({ key: label, label, rows }));
}
export function coveredCell(row: LoadedRow, column: Column, coverage: RowsCoverage): CellResult {
  if (column.selector.kind !== "pointer") return cell(row, column);
  const observation = coverage.values?.find((entry) => entry.identity === row.identity);
  if (observation !== undefined && observation.status !== "decoded")
    return {
      kind: "unavailable",
      raw: null,
      message: `Value ${observation.status}: ${observation.message ?? "No decoded value was supplied."}`,
    };
  if (observation === undefined || row.decoded === undefined)
    return {
      kind: "unavailable",
      raw: null,
      message:
        "Decoded value unavailable; this is not evidence that the selected property is missing.",
    };
  return cell(row, column);
}
