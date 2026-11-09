import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type {
  BlobRef,
  EventRecord,
  EventRef,
  HistoryCapture,
  PayloadChunk,
  ScopeRef,
  SessionRecord,
} from "./types";
const maximum = (max: bigint, positive = false) =>
  c.refine(
    d.decimal,
    (value) => BigInt(value) <= max && (!positive || value !== "0"),
    `canonical ${positive ? "positive " : ""}decimal <=${max}`,
  );
export const sequence = maximum(1_000_000n);
export const eventRef: c.Codec<EventRef> = c.record({
  session_id: d.identifier,
  sequence: maximum(1_000_000n, true),
});
export const blobRef: c.Codec<BlobRef> = c.record({
  digest: d.digest,
  size_bytes: maximum(67_108_864n),
});
export const scopeRef: c.Codec<ScopeRef> = c.tagged<ScopeRef>("kind", {
  workspace: c.record({ kind: c.literal("workspace") }),
  project: c.record({ kind: c.literal("project"), id: d.identifier }),
  milestone: c.record({ kind: c.literal("milestone"), id: d.identifier }),
  ticket: c.record({ kind: c.literal("ticket"), id: d.identifier }),
  resource: c.record({ kind: c.literal("resource"), id: d.identifier }),
});
const utf8 = (max: number, nonempty = true) =>
  c.refine(
    c.text,
    (value) => (!nonempty || value.length > 0) && new TextEncoder().encode(value).length <= max,
    `${nonempty ? "nonempty " : ""}UTF-8 <=${max} bytes`,
  );
const timestamp = c.refine(
  c.text,
  (value) =>
    /^(0|[1-9][0-9]{0,18})(?![\s\S])/u.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n,
  "nonnegative Int64 Unix milliseconds",
);
export const sessionRecord: c.Codec<SessionRecord> = c.record({
  workspace_id: d.identifier,
  session_id: d.identifier,
  title: utf8(512),
  actor_id: d.identifier,
  run_id: c.nullable(d.identifier),
  parent_event: c.nullable(eventRef),
  scopes: c.array(scopeRef, 100),
  archived: c.boolean,
  created_at_unix_ms: c.nullable(timestamp),
  last_event_at_unix_ms: c.nullable(timestamp),
});
const committed = c.record({ kind: c.literal("blob"), blob: blobRef });
export const eventRecord: c.Codec<EventRecord> = c.record({
  event_ref: eventRef,
  identity_hash: d.digest,
  actor_id: d.identifier,
  run_id: c.nullable(d.identifier),
  event: c.record({
    client_id: utf8(256),
    role: utf8(256),
    kind: utf8(256),
    phase: utf8(256),
    correlation: c.nullable(utf8(256, false)),
    provenance: c.raw,
    payload: committed,
    searchable_text: c.nullable(committed),
    resource_versions: c.array(
      c.record({ resource_id: d.identifier, revision: maximum(100_000n, true) }),
      100,
    ),
    attachments: c.array(blobRef, 100),
  }),
});
export const historyCapture: c.Codec<HistoryCapture> = c.refine(
  c.record({
    workspace_id: d.identifier,
    head: c.nullable(d.digest),
    sequence: sequence,
    sessions: c.array(c.record({ session_id: d.identifier, through: sequence }), 100_000),
  }),
  (value) =>
    new Set(value.sessions.map((item) => item.session_id)).size === value.sessions.length &&
    (value.head === null
      ? value.sequence === "0" && value.sessions.length === 0
      : value.sequence !== "0"),
  "consistent unique history capture",
);
export const directoryPage = c.record({
  items: c.array(sessionRecord, 100),
  next_offset: d.decimal,
  has_more: c.boolean,
});
export const sessionDetail = c.record({ session: sessionRecord, through: sequence });
export const eventWindow = c.record({
  session_id: d.identifier,
  through: sequence,
  items: c.array(eventRecord, 100),
  has_more: c.boolean,
  next_anchor: sequence,
  omitted_for_budget: sequence,
});
export const payloadChunk: c.Codec<PayloadChunk> = c.refine(
  c.record({
    blob: blobRef,
    offset: maximum(67_108_864n),
    bytes_base64: c.refine(c.text, (v) => v.length <= 349_528, "bounded Base64 chunk"),
    next_offset: maximum(67_108_864n),
    total_bytes: maximum(67_108_864n),
    has_more: c.boolean,
  }),
  (value) =>
    value.total_bytes === value.blob.size_bytes &&
    BigInt(value.offset) <= BigInt(value.next_offset) &&
    BigInt(value.next_offset) <= BigInt(value.total_bytes) &&
    value.has_more === (value.next_offset !== value.total_bytes),
  "consistent payload byte bounds",
);
export const payloadBatch = c.record({
  items: c.array(c.record({ event_ref: eventRef, payload: payloadChunk }), 100),
});
