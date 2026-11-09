import type { AttentionRow } from "./types";

export function attentionRowKey(row: AttentionRow): string {
  return `${row.kind}:${row.revision}:${row.changeIndex}:${row.notificationIds.join(",")}`;
}
/** Retain recent observed rows across empty long-poll windows. This is not a durable inbox. */
export function mergeObservedChanges(
  previous: readonly AttentionRow[],
  incoming: readonly AttentionRow[],
): readonly AttentionRow[] {
  const rows = new Map(previous.map((row) => [attentionRowKey(row), row]));
  for (const row of incoming) rows.set(attentionRowKey(row), row);
  return [...rows.values()]
    .sort((a, b) => {
      for (const field of ["revision", "changeIndex"] as const) {
        const left = BigInt(a[field]),
          right = BigInt(b[field]);
        if (left !== right) return left > right ? -1 : 1;
      }
      return attentionRowKey(a).localeCompare(attentionRowKey(b));
    })
    .slice(0, 100);
}
