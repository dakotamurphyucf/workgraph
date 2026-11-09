import type { JsonValue } from "../../../core/json";
import type { ViewConfig, ViewFilter } from "./types";
import { compareNumbers, compareText, scalarEqual, selectPointer } from "./values";
import { sourceContracts } from "./semantics";
import * as d from "../../../core/protocol/decoders";
import type { SessionRecord } from "../../history/transcript/types";
/** Rows are explicit adapter projections, never arbitrary traversal of entity internals. */
export interface LoadedRow {
  readonly identity: string;
  readonly fields: Readonly<Record<string, JsonValue>>;
  readonly decoded?: JsonValue;
}
export function matchesLoaded(row: LoadedRow, filter: ViewFilter): boolean {
  const selected =
    "pointer" in filter
      ? row.decoded === undefined
        ? undefined
        : selectPointer(row.decoded, filter.pointer)
      : undefined;
  const value =
    "pointer" in filter
      ? selected?.kind === "found"
        ? selected.value
        : undefined
      : Object.hasOwn(row.fields, filter.field)
        ? row.fields[filter.field]
        : undefined;
  if (value === undefined || value.kind === "array" || value.kind === "object") return false;
  switch (filter.op) {
    case "equals":
      return scalarEqual(value, filter.value);
    case "one_of":
      return filter.values.some((candidate) => scalarEqual(value, candidate));
    case "literal_prefix":
      return value.kind === "string" && value.value.startsWith(filter.value);
    case "contains_text":
      return value.kind === "string" && value.value.includes(filter.value);
  }
}
/** Validated native session metadata -> explicit adapter fields. Timestamp strings retain every millisecond; null stays unknown. */
export function projectSessionRow(session: SessionRecord): LoadedRow {
  const timestamp = (value: string | null) =>
    value !== null &&
    /^(?:0|[1-9][0-9]{0,18})$/u.test(value) &&
    BigInt(value) <= 9223372036854775807n
      ? d.jsonNumber(value)
      : d.jsonNull();
  return {
    identity: session.session_id,
    fields: {
      session_id: d.jsonString(session.session_id),
      title: d.jsonString(session.title),
      actor_id: d.jsonString(session.actor_id),
      run_id: session.run_id === null ? d.jsonNull() : d.jsonString(session.run_id),
      archived: d.jsonBoolean(session.archived),
      created_at: timestamp(session.created_at_unix_ms),
      last_event_at: timestamp(session.last_event_at_unix_ms),
    },
  };
}
/** Exact nanoseconds for ordering. Numeric adapter timestamps are native nonnegative int64 Unix milliseconds; ISO input is strict UTC only. */
function timeNanoseconds(value: JsonValue | undefined): bigint | null {
  if (value?.kind === "number") {
    if (!/^(?:0|[1-9][0-9]{0,18})$/u.test(value.lexeme)) return null;
    const milliseconds = BigInt(value.lexeme);
    return milliseconds <= 9223372036854775807n ? milliseconds * 1000000n : null;
  }
  if (value?.kind !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z(?![\s\S])/u.exec(
    value.value,
  );
  if (match === null) return null;
  const normalized = `${match[1]}.000Z`;
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === normalized
    ? BigInt(milliseconds) * 1000000n + BigInt((match[2] ?? "").padEnd(9, "0"))
    : null;
}
/** Timeline placement only: dates beyond the native Date range stay Unknown. Ordering separately retains exact native/nanosecond precision. */
export function utcTime(value: JsonValue | undefined): number | null {
  const nanoseconds = timeNanoseconds(value);
  if (
    nanoseconds === null ||
    nanoseconds < -8640000000000000000000n ||
    nanoseconds > 8640000000000000000000n
  )
    return null;
  return Number(nanoseconds / 1000000n);
}
export function timelineTime(row: LoadedRow, config: ViewConfig): number | null {
  const field = config.sort[0]?.field;
  return field === undefined || sourceContracts[config.source].fields[field] !== "time"
    ? null
    : utcTime(row.fields[field]);
}
/** Loaded-only ordering. Caller must keep captured coverage/continuation visible. Nulls stay last in either direction. */
export function sortLoaded(rows: readonly LoadedRow[], config: ViewConfig): readonly LoadedRow[] {
  const contract = sourceContracts[config.source];
  const fieldOrder = (a: LoadedRow, b: LoadedRow, field: string, descending: boolean): number => {
    const left = Object.hasOwn(a.fields, field) ? a.fields[field] : undefined,
      right = Object.hasOwn(b.fields, field) ? b.fields[field] : undefined;
    const type = contract.fields[field];
    const valid = (value: JsonValue | undefined) =>
      value !== undefined &&
      value.kind !== "null" &&
      (type === "number"
        ? value.kind === "number" && compareNumbers(value.lexeme, "0") !== null
        : type === "time"
          ? timeNanoseconds(value) !== null
          : type === "text"
            ? value.kind === "string"
            : type === "boolean"
              ? value.kind === "boolean"
              : false);
    const l = valid(left),
      r = valid(right);
    if (!l || !r) return l === r ? 0 : l ? -1 : 1;
    let order = 0;
    if (left?.kind === "number" && right?.kind === "number")
      order = compareNumbers(left.lexeme, right.lexeme) ?? 0;
    else if (type === "time") {
      const l = timeNanoseconds(left),
        r = timeNanoseconds(right);
      if (l !== null && r !== null) order = l === r ? 0 : l < r ? -1 : 1;
    } else if (left?.kind === "string" && right?.kind === "string")
      order = compareText(left.value, right.value);
    else if (left?.kind === "boolean" && right?.kind === "boolean")
      order = left.value === right.value ? 0 : left.value ? 1 : -1;
    return descending ? -order : order;
  };
  return [...rows].sort((a, b) => {
    for (const sort of config.sort) {
      const order = fieldOrder(a, b, sort.field, sort.direction === "desc");
      if (order !== 0) return order;
    }
    return compareText(a.identity, b.identity);
  });
}
