import type { JsonValue } from "../../../core/json";
import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import { choice, fields, pinCodec, targetCodec, text } from "./codecs";
import type { ProofPin, ReservationTarget } from "./types";

/** Compact human summary of a validated audit. Original lossless source remains
 * alongside the summary; a recovery record is attribution, not process liveness. */
export interface CoordinationAudit {
  readonly id: string;
  readonly actorId: string;
  readonly runId: string | null;
  readonly timestamp: string;
  readonly summary: string;
  readonly binding: string;
  readonly previousOwner: string | null;
  readonly guards: string | null;
  readonly evidence: readonly ProofPin[];
}
const common = {
  actor_id: d.identifier,
  run_id: c.nullable(d.identifier),
  timestamp: text(128, true),
  sequence: d.positiveDecimal,
};
const recovery = {
  recovery_id: d.identifier,
  old_actor_id: d.identifier,
  token: d.positiveDecimal,
  expected_lease_revision: d.positiveDecimal,
  confirmation: choice(["stopped", "isolated"]),
  evidence: c.array(pinCodec, 100),
};
const reservationAudit = fields({
  ...common,
  request: fields({
    ...recovery,
    target: targetCodec,
    expected_epoch: d.positiveDecimal,
    old_run_id: d.identifier,
    reason: text(65536, true),
  }),
  borrowers: c.array(
    fields({
      ticket_id: d.identifier,
      actor_id: d.identifier,
      run_id: d.identifier,
      token: d.positiveDecimal,
    }),
    100,
  ),
});
const ticketAudit = fields({
  ...common,
  request: fields({
    ...recovery,
    ticket_id: d.identifier,
    expected_revision: d.decimal,
    old_run_id: c.nullable(d.identifier),
    disposition: choice(["preserve_status", "requeue"]),
    reason: text(4096, true),
  }),
});
const signal = fields({
  ...common,
  signal_id: d.identifier,
  condition_id: d.identifier,
  condition_revision: d.positiveDecimal,
  operation_id: d.identifier,
  artifact: pinCodec,
  evidence: c.refine(
    c.array(pinCodec, 100),
    (values) => values.length > 0,
    "at least one exact proof pin",
  ),
  summary: text(65536, true),
});
export const reservationLabel = (value: ReservationTarget): string =>
  value.kind === "named"
    ? value.reservation_id
    : `${value.target.worktree_id} / ${value.target.path} (${value.target.kind})`;
export function proofLabel(pin: ProofPin): string {
  switch (pin.kind) {
    case "resource":
      return `Resource ${pin.resource_id} · content version ${pin.revision} · SHA-256 ${pin.digest}`;
    case "event":
      return `Session ${pin.session_id} · event ${pin.sequence}`;
    case "commit":
      return `Commit ${pin.repository} / ${pin.object_id}`;
    case "checksum":
      return `Checksum ${pin.source} · SHA-256 ${pin.digest}`;
    case "comment":
      return `Comment ${pin.comment_id} · revision ${pin.revision}`;
    case "amendment":
      return `Amendment ${pin.amendment_id} · revision ${pin.revision}`;
    case "contract":
      return `Contract ${pin.contract_id} · revision ${pin.revision}`;
    case "decision":
      return `Decision ${pin.decision_id} · revision ${pin.revision}`;
  }
}
export function decodeAudit(method: string, value: JsonValue): c.DecodeResult<CoordinationAudit> {
  if (method === "condition.signals") {
    const result = signal.decode(value);
    if (!result.ok) return result;
    const v = result.value;
    return {
      ok: true,
      value: {
        id: v.signal_id,
        actorId: v.actor_id,
        runId: v.run_id,
        timestamp: v.timestamp,
        summary: v.summary,
        binding: `Condition ${v.condition_id} · declaration ${v.condition_revision} · operation ${v.operation_id}`,
        previousOwner: null,
        guards: null,
        evidence: [v.artifact, ...v.evidence],
      },
    };
  }
  if (method === "recovery.list") {
    const result = reservationAudit.decode(value);
    if (!result.ok) return result;
    const v = result.value,
      r = v.request;
    if (
      BigInt(r.token) > BigInt(r.expected_epoch) ||
      v.borrowers.some((b) => b.actor_id !== r.old_actor_id || b.run_id !== r.old_run_id) ||
      new Set(v.borrowers.map((b) => b.ticket_id)).size !== v.borrowers.length
    )
      return c.mismatch([], "recovery with matching original epoch and automatic borrowers");
    return {
      ok: true,
      value: {
        id: r.recovery_id,
        actorId: v.actor_id,
        runId: v.run_id,
        timestamp: v.timestamp,
        summary: r.reason,
        binding: `${reservationLabel(r.target)} · outside confirmation: ${r.confirmation}`,
        previousOwner: `${r.old_actor_id} / ${r.old_run_id}`,
        guards: `Reservation epoch ${r.expected_epoch} · token ${r.token} · lease revision ${r.expected_lease_revision}${v.borrowers.length === 0 ? "" : ` · ${v.borrowers.length} affected automatic claim(s)`}`,
        evidence: r.evidence,
      },
    };
  }
  if (method === "ticket.recovery.list") {
    const result = ticketAudit.decode(value);
    if (!result.ok) return result;
    const v = result.value,
      r = v.request;
    return {
      ok: true,
      value: {
        id: r.recovery_id,
        actorId: v.actor_id,
        runId: v.run_id,
        timestamp: v.timestamp,
        summary: r.reason,
        binding: `Ticket ${r.ticket_id} · outside confirmation: ${r.confirmation} · ${r.disposition.replaceAll("_", " ")}`,
        previousOwner: `${r.old_actor_id} / ${r.old_run_id ?? "no run"}`,
        guards: `Ticket revision ${r.expected_revision} · claim token ${r.token} · lease revision ${r.expected_lease_revision}`,
        evidence: r.evidence,
      },
    };
  }
  return c.mismatch([], "supported captured coordination audit method");
}
