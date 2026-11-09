import { createCompanion } from "../../core/protocol/client";
import * as c from "../../core/protocol/codec";
import * as d from "../../core/protocol/decoders";
import type { HttpClient, HttpResult } from "../../core/protocol/http";
import type { Decimal, JsonObject, ReadInvocation } from "../../core/protocol/types";
import { fields } from "../discussions/threads/codecs";
import { invalid } from "../history/transcript/client";
import { decodeObservation } from "../overview/client";
import { page } from "../overview/codecs";
import { identifier, invocation, scopeKey } from "../overview/model";
import type { OverviewScope } from "../overview/types";
import type { ActivityFilter, AuditEvent, AuditPosition, AuditWindow } from "./types";

const envelope = fields({
  revision: d.positiveDecimal,
  actor_id: d.identifier,
  run_id: c.nullable(d.identifier),
  timestamp: c.text,
  targets: c.array(c.object, 100000),
  changes: c.array(c.object, 100000),
});
export const auditCodec: c.Codec<AuditEvent> = {
  decode(raw, path = []) {
    if (raw?.kind !== "object") return c.mismatch(path, "audit object");
    const decoded = envelope.decode(raw, path);
    if (!decoded.ok) return decoded;
    return {
      ok: true,
      value: {
        revision: decoded.value.revision,
        actorId: decoded.value.actor_id,
        runId: decoded.value.run_id,
        timestamp: decoded.value.timestamp,
        changes: decoded.value.changes,
        raw,
      },
    };
  },
};
const auditPage = page(auditCodec);
/** Native activity pages are ascending. Probe the count, then seek directly to
 * the last bounded window at that exact revision. No full-history scan, fabricated
 * cursor, or mixture of live revisions. Byte-clipped pages advance by actual count. */
export function createActivityClient(http: HttpClient) {
  const companion = createCompanion(http);
  // Audit revisions are immutable within this endpoint/workspace. Retain only
  // the last bounded window so an unchanged row's expanded raw viewer does not
  // re-encode/reparse its content on every passive refresh.
  let retained: { readonly key: string; readonly events: ReadonlyMap<string, AuditEvent> } | null =
    null;
  return {
    async window(
      scope: OverviewScope,
      filter: ActivityFilter,
      position: AuditPosition | null,
      signal: AbortSignal,
    ): Promise<HttpResult<AuditWindow>> {
      const selectors: (readonly [string, JsonObject | ReturnType<typeof d.jsonString>])[] = [];
      if (filter.ticketId !== "") {
        selectors.push([
          "target",
          d.jsonObject([
            ["kind", d.jsonString("ticket")],
            ["ticket_id", d.jsonString(identifier(filter.ticketId, "Ticket"))],
          ]),
        ]);
      } else if (scope.projectId !== null)
        selectors.push(["project_id", d.jsonString(scope.projectId)]);
      if (filter.actorId !== "")
        selectors.push(["actor_id", d.jsonString(identifier(filter.actorId, "Actor"))]);
      const read = async (offset: bigint, limit: bigint, revision?: Decimal) => {
        const request: ReadInvocation = invocation(scope, "activity.since", [
          ...selectors,
          ["offset", d.jsonString(offset.toString())],
          ["limit", d.jsonString(limit.toString())],
          ["max_bytes", d.jsonString("1048576")],
          ...(revision === undefined ? [] : [["at_revision", d.jsonString(revision)] as const]),
        ]);
        const result = await companion.read(request, signal);
        return result.ok
          ? decodeObservation(scope, request, result.data, auditPage, (p) => p.remaining !== "0")
          : result;
      };
      let captured = position;
      if (captured === null) {
        const probe = await read(0n, 1n);
        if (!probe.ok) return probe;
        if (probe.data.value.offset !== "0") return invalid("Activity count probe changed offset.");
        const total = BigInt(probe.data.value.items.length) + BigInt(probe.data.value.remaining);
        captured = { revision: probe.data.revision, end: total, total };
      }
      const { revision, end, total } = captured;
      if (end < 0n || end > total) return invalid("Invalid activity window.");
      const start = end > 25n ? end - 25n : 0n;
      const events: AuditEvent[] = [];
      let offset = start;
      while (offset < end) {
        if (signal.aborted) return { ok: false, failure: { kind: "aborted" } };
        const result = await read(offset, end - offset, revision);
        if (!result.ok) return result;
        const p = result.data.value;
        if (
          BigInt(p.offset) !== offset ||
          p.items.length === 0 ||
          offset + BigInt(p.items.length) > end ||
          offset + BigInt(p.items.length) + BigInt(p.remaining) !== total
        )
          return invalid("Activity page changed its captured offsets or total.");
        for (const event of p.items) {
          const last = events.at(-1);
          if (
            BigInt(event.revision) > BigInt(revision) ||
            (last !== undefined && BigInt(event.revision) <= BigInt(last.revision))
          )
            return invalid("Activity events changed their captured order.");
          events.push(event);
        }
        offset += BigInt(p.items.length);
      }
      const key = JSON.stringify([scopeKey(scope), filter]);
      const previous = retained?.key === key ? retained.events : null;
      const stable = events.map((event) => previous?.get(event.revision) ?? event);
      if (!signal.aborted)
        retained = { key, events: new Map(stable.map((event) => [event.revision, event])) };
      return { ok: true, httpStatus: 200, data: { revision, start, end, total, events: stable } };
    },
  };
}
