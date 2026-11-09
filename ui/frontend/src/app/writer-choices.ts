import { useEffect, useState, useSyncExternalStore } from "react";
import { jsonString } from "../core/protocol/decoders";
import type { HttpClient, HttpResult } from "../core/protocol/http";
import { createReadSlot } from "../core/state/read-slot";
import {
  createParticipantsClient,
  invocation,
  invalid,
} from "../features/participants/runs/client";
import type { ParticipantsTarget, RunRecord } from "../features/participants/runs/types";
import { workScopeKey } from "../features/work/read-model";
import type { WorkScope } from "../features/work/read-model.types";

/** Runs are observed records, not proof that a harness process is currently alive. */
export async function readWriterRuns(
  client: HttpClient,
  scope: WorkScope,
  signal: AbortSignal,
): Promise<HttpResult<readonly RunRecord[]>> {
  const api = createParticipantsClient(client);
  const target: ParticipantsTarget = { ...scope, projectId: null, selection: { kind: "none" } };
  let request = invocation(target, "run.list", [
    ["limit", jsonString("100")],
    ["max_bytes", jsonString("1048576")],
  ]);
  const rows = new Map<string, RunRecord>();
  let revision: string | null | undefined;
  while (!signal.aborted) {
    const result = await api.page(target, request, signal);
    if (!result.ok) return result;
    const page = result.data;
    if (page.rows.kind !== "runs" || (revision !== undefined && revision !== page.revision))
      return invalid("The run directory changed while loading. Refresh choices or enter an ID.");
    revision = page.revision;
    for (const run of page.rows.items) {
      if (rows.has(run.run_id)) return invalid("Run choices repeated an identity.");
      rows.set(run.run_id, run);
    }
    if (page.continuation === null) {
      if (page.completeness !== "complete")
        return invalid("Run choices could not be fully loaded. You can still enter a run ID.");
      return { ok: true, httpStatus: 200, data: [...rows.values()] };
    }
    if (page.rows.items.length === 0 || page.completeness === "partial")
      return invalid("Run choices are incomplete. Refresh or enter a run ID.");
    request = page.continuation;
  }
  return { ok: false, failure: { kind: "aborted" } };
}

/** Read-only, workspace-wide choices. A refresh never edits the staged selection. */
export function useWriterChoices<T>(
  client: HttpClient,
  scope: WorkScope | undefined,
  read: (
    client: HttpClient,
    scope: WorkScope,
    signal: AbortSignal,
  ) => Promise<HttpResult<readonly T[]>>,
) {
  const [slot] = useState(() => createReadSlot<readonly T[]>());
  const state = useSyncExternalStore(slot.subscribe, slot.get);
  const key = scope ? workScopeKey(scope) : "unselected";
  const load = () => {
    if (!scope) return;
    void slot
      .load(key, (signal) => read(client, scope, signal))
      .catch(() => {
        // Unexpected exceptions stay in the slot and reach the owning error boundary.
      });
  };
  useEffect(() => {
    load();
    return () => slot.clear();
    // Scope key covers socket, generation and workspace; readers are stable module functions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot, key, client, read]);
  if (state.kind === "unexpected_error") throw state.error;
  const current = scope && state.kind !== "idle" && state.key === key ? state : undefined;
  return {
    state: current,
    rows: current?.kind === "ready" ? current.value : current?.previous,
    refresh: load,
  };
}
