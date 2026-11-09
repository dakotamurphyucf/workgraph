import type { HttpClient, HttpResult } from "../../../core/protocol/http";
import type { Identifier } from "../../../core/protocol/types";
import * as d from "../../../core/protocol/decoders";
import { createParticipantsClient, invocation, invalid } from "../../participants/runs/client";
import type { ParticipantsTarget, RunRecord, AttemptRecord } from "../../participants/runs/types";
import { readRunSessions } from "../usage-dashboard/associations";
import { readUsageDashboard, type UsageDashboard } from "../usage-dashboard/client";
import type { Captured, SessionDetail } from "./types";
export interface SessionContextData {
  readonly runs: readonly { readonly run: RunRecord; readonly sessionCount: string }[];
  readonly attempts: readonly AttemptRecord[];
  readonly usage: UsageDashboard;
}
/** Associations are many-to-many. Read every guarded run/attempt page; follow
 * truncated run association previews before claiming a session has no link. */
export async function readSessionContext(
  http: HttpClient,
  target: ParticipantsTarget,
  detail: Captured<SessionDetail>,
  signal: AbortSignal,
): Promise<HttpResult<SessionContextData>> {
  const api = createParticipantsClient(http),
    runs: SessionContextData["runs"][number][] = [],
    attempts: AttemptRecord[] = [];
  const seenRuns = new Set<Identifier>(),
    seenAttempts = new Set<Identifier>();
  let request = invocation(target, "run.list", [
    ["head", detail.capture.head === null ? d.jsonNull() : d.jsonString(detail.capture.head)],
    ["limit", d.jsonString("100")],
    ["max_bytes", d.jsonString("1048576")],
  ]);
  for (;;) {
    const read = await api.page(target, request, signal);
    if (!read.ok) return read;
    const page = read.data;
    if (page.rows.kind !== "runs" || page.completeness === "partial")
      return invalid("Related runs were incomplete.");
    for (const run of page.rows.items) {
      if (seenRuns.has(run.run_id)) return invalid("Repeated related run.");
      seenRuns.add(run.run_id);
      let ids = run.session_ids;
      if (
        !ids.includes(detail.data.session.session_id) &&
        run.session_associations.omitted !== "0"
      ) {
        const more = await readRunSessions(http, target, run.run_id, detail.capture.head, signal);
        if (!more.ok) return more;
        if (more.data.run_revision !== run.revision)
          return invalid("Related run changed while reading its sessions.");
        ids = more.data.session_ids;
      }
      if (ids.includes(detail.data.session.session_id))
        runs.push({ run, sessionCount: run.session_associations.total });
    }
    if (!page.continuation) break;
    request = page.continuation;
  }
  request = invocation(target, "attempt.list", [
    ["limit", d.jsonString("100")],
    ["max_bytes", d.jsonString("1048576")],
  ]);
  for (;;) {
    const read = await api.page(target, request, signal);
    if (!read.ok) return read;
    const page = read.data;
    if (page.rows.kind !== "attempts" || page.completeness === "partial")
      return invalid("Related attempts were incomplete.");
    for (const attempt of page.rows.items) {
      if (seenAttempts.has(attempt.attempt_id)) return invalid("Repeated related attempt.");
      seenAttempts.add(attempt.attempt_id);
      if (
        attempt.session_ids.includes(detail.data.session.session_id) ||
        runs.some((r) => r.run.run_id === attempt.run_id)
      )
        attempts.push(attempt);
    }
    if (!page.continuation) break;
    request = page.continuation;
  }
  const usage = await readUsageDashboard(http, target, detail.capture, signal);
  if (!usage.ok) return usage;
  for (const row of usage.data.runs) {
    if (!row.sessions.session_ids.includes(detail.data.session.session_id)) continue;
    const related = runs.find((r) => r.run.run_id === row.sessions.run_id);
    if (!related || related.run.revision !== row.sessions.run_revision)
      return invalid(
        "Session associations changed while reading usage. Retry for a fresh capture.",
      );
  }
  return { ...usage, data: { runs, attempts, usage: usage.data } };
}
