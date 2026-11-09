import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import { choice, decimal64, fields } from "../runs/codecs";
import type {
  ClaimBorrower,
  Condition,
  Holder,
  Lease,
  PathTarget,
  Pool,
  ProofPin,
  Reservation,
  ReservationTarget,
  TicketPolicy,
} from "./types";

export { choice, decimal64, fields };
export const text = (maximum: number, nonblank = false) =>
  c.refine(
    c.text,
    (value) =>
      new TextEncoder().encode(value).byteLength <= maximum &&
      (!nonblank || /[^ \t\n\r\f\v]/u.test(value)),
    `text within ${maximum} UTF-8 bytes${nonblank ? "; nonblank" : ""}`,
  );
export const unique = <T>(codec: c.Codec<T>, maximum: number, key: (value: T) => string) =>
  c.refine(
    c.array(codec, maximum),
    (values) => new Set(values.map(key)).size === values.length,
    "distinct items",
  );
export const names = unique(text(96, true), 100, (value) => value);

/** Canonical logical paths, never filesystem identities or glob patterns. */
export function normalizePath(value: string, kind: PathTarget["kind"]): string | null {
  if (
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 4096 ||
    value.startsWith("/") ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127 ||
        "\\*?[]".includes(character),
    )
  )
    return null;
  const parts = value.split("/");
  if (parts.includes("..")) return null;
  const path = parts.filter((part) => part !== "" && part !== ".").join("/");
  return path === "" ? (kind === "subtree" ? "." : null) : path;
}
export const pathCodec: c.Codec<PathTarget> = c.refine(
  c.record({ worktree_id: d.identifier, kind: choice(["file", "subtree"]), path: c.text }),
  (value) => normalizePath(value.path, value.kind) === value.path,
  "canonical logical path",
);
export const targetCodec: c.Codec<ReservationTarget> = c.tagged<ReservationTarget>("kind", {
  named: c.record({ kind: c.literal("named"), reservation_id: d.identifier }),
  path: c.record({ kind: c.literal("path"), target: pathCodec }),
});
const leaseWire = c.record({
  epoch: d.positiveDecimal,
  revision: d.positiveDecimal,
  duration_ms: c.nullable(decimal64),
  last_unix_ms: decimal64,
  deadline_unix_ms: c.nullable(decimal64),
});
export const leaseCodec: c.Codec<Lease> = {
  decode(value, path = []) {
    const result = leaseWire.decode(value, path);
    if (!result.ok) return result;
    const v = result.value,
      base = { epoch: v.epoch, revision: v.revision, lastUnixMs: v.last_unix_ms };
    if (v.duration_ms === null && v.deadline_unix_ms === null)
      return { ok: true, value: Object.freeze({ ...base, kind: "indefinite" }) };
    if (
      v.duration_ms === null ||
      v.deadline_unix_ms === null ||
      BigInt(v.duration_ms) < 1n ||
      BigInt(v.duration_ms) > 86400000n ||
      BigInt(v.last_unix_ms) + BigInt(v.duration_ms) !== BigInt(v.deadline_unix_ms)
    )
      return c.mismatch(path, "consistent timed lease from 1ms through 24h");
    return {
      ok: true,
      value: Object.freeze({
        ...base,
        kind: "timed",
        durationMs: v.duration_ms,
        deadlineUnixMs: v.deadline_unix_ms,
      }),
    };
  },
};
const borrower = c.record({
  ticket_id: d.identifier,
  actor_id: d.identifier,
  run_id: d.identifier,
  token: d.positiveDecimal,
});
const originCodec: c.Codec<Holder["origin"]> = {
  decode(value, path = []) {
    const codec = c.tagged<
      | { readonly kind: "manual" }
      | { readonly kind: "automatic"; readonly borrowers: readonly ClaimBorrower[] }
    >("kind", {
      manual: c.record({ kind: c.literal("manual") }),
      automatic: c.record({ kind: c.literal("automatic"), borrowers: c.array(borrower, 100) }),
    });
    const result = codec.decode(value, path);
    if (!result.ok) return result;
    const v = result.value;
    if (v.kind === "manual") return { ok: true, value: v };
    const compare = (a: ClaimBorrower, b: ClaimBorrower) =>
      a.ticket_id < b.ticket_id
        ? -1
        : a.ticket_id > b.ticket_id
          ? 1
          : BigInt(a.token) < BigInt(b.token)
            ? -1
            : BigInt(a.token) > BigInt(b.token)
              ? 1
              : a.run_id < b.run_id
                ? -1
                : a.run_id > b.run_id
                  ? 1
                  : a.actor_id < b.actor_id
                    ? -1
                    : a.actor_id > b.actor_id
                      ? 1
                      : 0;
    if (
      v.borrowers.length === 0 ||
      v.borrowers.some((item, index) => index > 0 && compare(v.borrowers[index - 1]!, item) >= 0)
    )
      return c.mismatch(path, "nonempty sorted distinct exact claim borrowers");
    return { ok: true, value: Object.freeze({ kind: "automatic", claims: v.borrowers }) };
  },
};
export const holderCodec: c.Codec<Holder> = c.refine(
  c.record({
    actor_id: d.identifier,
    run_id: d.identifier,
    token: d.positiveDecimal,
    mode: choice(["exclusive", "shared"]),
    lease: leaseCodec,
    origin: originCodec,
  }),
  (value) =>
    value.token === value.lease.epoch &&
    (value.origin.kind === "manual" ||
      (value.lease.kind === "indefinite" &&
        value.origin.claims.every(
          (claim) => claim.run_id === value.run_id && claim.actor_id === value.actor_id,
        ))),
  "holder token, lease and actual claim borrowers agree",
);
const validHolders = (epoch: string, holders: readonly Holder[]) =>
  holders.every((holder) => BigInt(holder.token) <= BigInt(epoch)) &&
  new Set(holders.map((holder) => holder.run_id)).size === holders.length &&
  (holders.length <= 1 || holders.every((holder) => holder.mode === "shared"));
export const reservationCodec = (kind: "named" | "path"): c.Codec<Reservation> => ({
  decode(value, path = []) {
    if (kind === "named") {
      const result = fields({
        reservation_id: d.identifier,
        epoch: d.decimal,
        holders: c.array(holderCodec, 100),
      }).decode(value, path);
      if (!result.ok) return result;
      const v = result.value;
      return validHolders(v.epoch, v.holders)
        ? {
            ok: true,
            value: Object.freeze({
              target: { kind: "named" as const, reservation_id: v.reservation_id },
              epoch: v.epoch,
              holders: v.holders,
            }),
          }
        : c.mismatch(path, "consistent reservation holders");
    }
    const result = fields({
      target: pathCodec,
      epoch: d.decimal,
      holders: c.array(holderCodec, 100),
    }).decode(value, path);
    if (!result.ok) return result;
    const v = result.value;
    return validHolders(v.epoch, v.holders)
      ? {
          ok: true,
          value: Object.freeze({
            target: { kind: "path" as const, target: v.target },
            epoch: v.epoch,
            holders: v.holders,
          }),
        }
      : c.mismatch(path, "consistent path holders");
  },
});
export const poolCodec: c.Codec<Pool> = fields({
  name: text(96, true),
  revision: d.positiveDecimal,
  limit: c.refine(d.positiveDecimal, (value) => BigInt(value) <= 10000n, "pool limit 1..10000"),
});
export const policyCodec: c.Codec<TicketPolicy> = fields({
  ticket_id: d.identifier,
  revision: d.positiveDecimal,
  required_capabilities: names,
  pools: names,
  allowed_actor_ids: c.nullable(
    c.refine(
      unique(d.identifier, 100, (value) => value),
      (value) => value.length > 0,
      "positive actor allowlist",
    ),
  ),
});
export const pinCodec: c.Codec<ProofPin> = c.tagged<ProofPin>("kind", {
  resource: c.record({
    kind: c.literal("resource"),
    resource_id: d.identifier,
    revision: d.positiveDecimal,
    digest: d.digest,
  }),
  event: c.record({
    kind: c.literal("event"),
    session_id: d.identifier,
    sequence: d.positiveDecimal,
  }),
  commit: c.record({
    kind: c.literal("commit"),
    repository: text(1024, true),
    object_id: c.refine(
      c.text,
      (value) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})(?![\s\S])/u.test(value),
      "lowercase 40/64 hex object ID",
    ),
  }),
  checksum: c.record({ kind: c.literal("checksum"), source: text(1024, true), digest: d.digest }),
  comment: c.record({
    kind: c.literal("comment"),
    comment_id: d.identifier,
    revision: d.positiveDecimal,
  }),
  amendment: c.record({
    kind: c.literal("amendment"),
    amendment_id: d.identifier,
    revision: d.positiveDecimal,
  }),
  contract: c.record({
    kind: c.literal("contract"),
    contract_id: d.identifier,
    revision: d.positiveDecimal,
  }),
  decision: c.record({
    kind: c.literal("decision"),
    decision_id: d.identifier,
    revision: d.positiveDecimal,
  }),
});
export const conditionCodec: c.Codec<Condition> = fields({
  condition_id: d.identifier,
  revision: d.positiveDecimal,
  ticket_id: d.identifier,
  operation_id: d.identifier,
  artifact: pinCodec,
  required: c.boolean,
  label: text(4096, true),
  creator: d.identifier,
  creator_run: c.nullable(d.identifier),
  recipients: unique(d.identifier, 100, (value) => value),
});
