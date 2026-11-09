import type { HttpClient, HttpResult } from "../../../core/protocol/http";
import type { Digest, Identifier } from "../../../core/protocol/types";
import * as d from "../../../core/protocol/decoders";
import { createParticipantsClient, invocation, invalid } from "../../participants/runs/client";
import type { ParticipantsTarget, SessionPage } from "../../participants/runs/types";
/** Complete the native association set at one history head and run revision.
 * A directory page (or the first association preview) cannot prove membership. */
export async function readRunSessions(
  http: HttpClient,
  target: ParticipantsTarget,
  runId: Identifier,
  head: Digest | null,
  signal: AbortSignal,
): Promise<HttpResult<SessionPage>> {
  const api = createParticipantsClient(http);
  let request = invocation(target, "run.sessions", [
    ["target_run_id", d.jsonString(runId)],
    ["head", head === null ? d.jsonNull() : d.jsonString(head)],
    ["limit", d.jsonString("100")],
    ["max_bytes", d.jsonString("1048576")],
  ]);
  const ids: Identifier[] = [],
    seen = new Set<string>();
  let first: SessionPage | undefined;
  for (;;) {
    const read = await api.sessions(target, request, signal);
    if (!read.ok) return read;
    const page = read.data;
    if (first && (page.run_revision !== first.run_revision || page.total !== first.total))
      return invalid("Run associations changed during traversal.");
    first ??= page;
    for (const id of page.session_ids) {
      if (seen.has(id)) return invalid("Repeated run session association.");
      seen.add(id);
      ids.push(id);
    }
    if (!page.has_more) {
      if (BigInt(ids.length) !== BigInt(page.total))
        return invalid("Incomplete run session associations.");
      return { ...read, data: { ...page, session_ids: ids } };
    }
    if (!page.next_request || !page.session_ids.length)
      return invalid("Run association continuation did not advance.");
    const next = page.next_request.params;
    request = invocation(target, "run.sessions", [
      ["target_run_id", d.jsonString(runId)],
      ["head", head === null ? d.jsonNull() : d.jsonString(head)],
      ["expected_run_revision", d.jsonString(next.expected_run_revision)],
      ["after_session_id", d.jsonString(next.after_session_id)],
      ["limit", d.jsonString("100")],
      ["max_bytes", d.jsonString("1048576")],
    ]);
  }
}
