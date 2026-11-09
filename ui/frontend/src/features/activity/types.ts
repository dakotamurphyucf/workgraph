import type { Decimal, Identifier, JsonObject } from "../../core/protocol/types";

/** Attribution comes from the immutable audit envelope, never current ownership. */
export interface AuditEvent {
  readonly revision: Decimal;
  readonly actorId: Identifier;
  readonly runId: Identifier | null;
  readonly timestamp: string;
  readonly changes: readonly JsonObject[];
  readonly raw: JsonObject;
}
export interface ActivityFilter {
  readonly ticketId: string;
  readonly actorId: string;
}
/** Half-open offsets in one exact planning capture. Each window has at most 25 events. */
export interface AuditWindow {
  readonly revision: Decimal;
  readonly start: bigint;
  readonly end: bigint;
  readonly total: bigint;
  readonly events: readonly AuditEvent[];
}
export interface AuditPosition {
  readonly revision: Decimal;
  readonly end: bigint;
  readonly total: bigint;
}
