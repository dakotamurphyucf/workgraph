import type { JsonValue } from "../../../core/json";
import type { CoordinationList } from "./client";
import { poolCodec, policyCodec, reservationCodec } from "./codecs";
import { conditionRecord, pathPolicyCodec } from "./prepare";
import { decodeAudit } from "./records";

/** Stable entity identity within one endpoint/workspace/query. Namespace revisions
 * describe a capture and must not remount open record details on every update.
 * Malformed rows have no trusted identity; callers isolate them by page position. */
export function recordIdentity(method: CoordinationList, row: JsonValue): string | null {
  switch (method) {
    case "allocation.pools": {
      const value = poolCodec.decode(row);
      return value.ok ? value.value.name : null;
    }
    case "allocation.ticket_policies": {
      const value = policyCodec.decode(row);
      return value.ok ? value.value.ticket_id : null;
    }
    case "ticket.paths.list": {
      const value = pathPolicyCodec.decode(row);
      return value.ok ? value.value.ticket_id : null;
    }
    case "reservation.list":
    case "reservation.path.list": {
      const value = reservationCodec(method === "reservation.list" ? "named" : "path").decode(row);
      return value.ok ? JSON.stringify(value.value.target) : null;
    }
    case "condition.list": {
      const value = conditionRecord.decode(row);
      return value.ok ? value.value.declaration.condition_id : null;
    }
    case "condition.signals":
    case "recovery.list":
    case "ticket.recovery.list": {
      const value = decodeAudit(method, row);
      return value.ok ? value.value.id : null;
    }
  }
}
