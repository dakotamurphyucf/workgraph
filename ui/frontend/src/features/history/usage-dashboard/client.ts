import { readRunSessions } from "./associations";
import type { HttpClient, HttpResult } from "../../../core/protocol/http";
import type { Decimal } from "../../../core/protocol/types";
import { createAnalyticsClient } from "../analytics/client";
import { defaultUsage } from "../analytics/controller";
import type { UsageRow } from "../analytics/types";
import { invalid } from "../../participants/runs/client";
import type { ParticipantsTarget, SessionPage } from "../../participants/runs/types";
import type { HistoryCapture, HistoryScope } from "../transcript/types";
export interface RunConsumption {
  readonly usage: Extract<UsageRow, { readonly kind: "usage" }>;
  readonly sessions: SessionPage;
}
export interface UsageDashboard {
  readonly runs: readonly RunConsumption[];
  readonly revision: Decimal;
}
/** All run groups at one planning revision. Association totals come from the
 * full native run.sessions count, never the visible session-directory page. */
export async function readUsageDashboard(
  http: HttpClient,
  target: ParticipantsTarget,
  capture: HistoryCapture,
  signal: AbortSignal,
): Promise<HttpResult<UsageDashboard>> {
  const api = createAnalyticsClient(http);
  const scope: HistoryScope = {
    connectionId: target.connection.id,
    generation: target.connection.generation,
    workspaceId: target.workspaceId,
  };
  const rows: Extract<UsageRow, { readonly kind: "usage" }>[] = [];
  const seenRuns = new Set<string>(),
    seenCursors = new Set<string>();
  let cursor: string | undefined, revision: Decimal | undefined;
  do {
    const result = await api.aggregate(
      scope,
      { ...defaultUsage, group: "run", layout: "nested", limit: "100", maxBytes: "1048576" },
      cursor,
      revision,
      signal,
    );
    if (!result.ok) return result;
    revision = result.data.revision;
    if (result.data.data.needs_larger_budget)
      return invalid(
        "A usage group exceeded the dashboard budget. Inspect Usage reports for its full series.",
      );
    for (const row of result.data.data.items) {
      if (
        row.kind !== "usage" ||
        row.group.kind !== "run" ||
        row.metrics === undefined ||
        seenRuns.has(row.group.run_id)
      )
        return invalid("Run usage groups were incomplete or repeated.");
      seenRuns.add(row.group.run_id);
      rows.push(row);
    }
    const next = result.data.data.cursor;
    if (
      result.data.data.has_more &&
      (next === null || seenCursors.has(next) || result.data.data.items.length === 0)
    )
      return invalid("Run usage continuation did not advance.");
    if (next !== null) seenCursors.add(next);
    cursor = result.data.data.has_more ? (next ?? undefined) : undefined;
  } while (cursor !== undefined);
  const runs: RunConsumption[] = [];
  // Sequential lightweight association reads do not occupy all history lanes.
  for (const usage of rows) {
    if (usage.group.kind !== "run") return invalid("Unexpected usage group.");
    const result = await readRunSessions(http, target, usage.group.run_id, capture.head, signal);
    if (!result.ok) return result;
    if (result.data.total === "1" && (result.data.session_ids.length !== 1 || result.data.has_more))
      return invalid("Single-session attribution was incomplete.");
    runs.push({ usage, sessions: result.data });
  }
  if (revision === undefined) return invalid("Usage capture missing.");
  return { ok: true, httpStatus: 200, data: { runs, revision } };
}
