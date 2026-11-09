import type { HttpClient, HttpResult } from "../../core/protocol/http";
import * as d from "../../core/protocol/decoders";
import { createParticipantsClient, invocation, invalid } from "../participants/runs/client";
import type { ParticipantRecord, ParticipantsTarget } from "../participants/runs/types";
import type { WorkScope } from "./read-model.types";

/** Reuses participant validation and exact continuations; observations do not imply liveness. */
export async function readKnownActors(
  client: HttpClient,
  scope: WorkScope,
  signal: AbortSignal,
): Promise<HttpResult<readonly ParticipantRecord[]>> {
  const api = createParticipantsClient(client);
  const target: ParticipantsTarget = { ...scope, selection: { kind: "none" } };
  let request = invocation(target, "participant.list", [
    ["limit", d.jsonString("100")],
    ["max_bytes", d.jsonString("1048576")],
  ]);
  const rows = new Map<string, ParticipantRecord>();
  let revision: string | null | undefined;
  while (!signal.aborted) {
    const result = await api.page(target, request, signal);
    if (!result.ok) return result;
    const page = result.data;
    if (page.rows.kind !== "actors" || (revision !== undefined && revision !== page.revision))
      return invalid("Actor directory changed while loading. Try again.");
    revision = page.revision;
    for (const actor of page.rows.items) {
      if (rows.has(actor.actor_id))
        return invalid("Actor directory continuation repeated an identity.");
      rows.set(actor.actor_id, actor);
    }
    if (page.continuation === null) {
      if (page.completeness !== "complete")
        return invalid("Actor choices could not be fully loaded. You can still enter an actor ID.");
      return {
        ok: true,
        data: [...rows.values()].sort((a, b) =>
          (a.registration?.name ?? a.actor_id).localeCompare(b.registration?.name ?? b.actor_id),
        ),
        httpStatus: 200,
      };
    }
    if (page.rows.items.length === 0) return invalid("Actor directory did not advance.");
    request = page.continuation;
  }
  return { ok: false, failure: { kind: "aborted" } };
}
