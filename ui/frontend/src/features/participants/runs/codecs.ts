import { jsonField, type JsonValue } from "../../../core/json";
import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type {
  ActorRecord,
  AttemptRecord,
  Checkpoint,
  ParticipantRecord,
  ParentStopPolicy,
  RecordedState,
  RunRecord,
  RunnerAction,
  SessionContinuation,
  SessionPage,
} from "./types";

/** Validate only consumed fields; callers retain the complete lossless record. */
export function fields<S extends Readonly<Record<string, c.Codec<unknown>>>>(
  shape: S,
): c.Codec<{ readonly [K in keyof S]: S[K] extends c.Codec<infer T> ? T : never }> {
  const names = new Set(Object.keys(shape)),
    codec = c.record(shape);
  return {
    decode(value, path = []) {
      return value?.kind === "object"
        ? codec.decode(
            { kind: "object", fields: value.fields.filter((field) => names.has(field.name)) },
            path,
          )
        : c.mismatch(path, "record");
    },
  };
}
export function choice<const T extends string>(values: readonly T[]): c.Codec<T> {
  return {
    decode(value, path = []) {
      const result = c.text.decode(value, path);
      if (!result.ok) return result;
      const match = values.find((item) => item === result.value);
      return match === undefined
        ? c.mismatch(path, values.join(" | "))
        : { ok: true, value: match };
    },
  };
}
const bytes = new TextEncoder();
const hasText = (value: string) => /[^ \t\n\r\f\v]/u.test(value);
const boundedText = (maximum: number, nonblank = false) =>
  c.refine(
    c.text,
    (value) => bytes.encode(value).byteLength <= maximum && (!nonblank || hasText(value)),
    `text within ${maximum} UTF-8 bytes${nonblank ? "; nonblank" : ""}`,
  );
const terminal = (value: RecordedState) =>
  value === "completed" || value === "failed" || value === "cancelled";
export const decimal64 = c.refine(
  c.text,
  (value) =>
    /^(0|[1-9][0-9]{0,18})(?![\s\S])/u.test(value) && BigInt(value) <= 9223372036854775807n,
  "canonical nonnegative int64 string",
);
export const stateCodec: c.Codec<RecordedState> = choice([
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
]);
export const parentPolicyCodec: c.Codec<ParentStopPolicy> = choice([
  "continue",
  "request_cancel",
  "request_wait",
]);
export const actorCodec: c.Codec<ActorRecord> = fields({
  actor_id: d.identifier,
  name: boundedText(512, true),
  kind: choice(["person", "agent"]),
  revision: d.positiveDecimal,
  archived: c.boolean,
});
const participantShape = fields({
  actor_id: d.identifier,
  registration: c.nullable(actorCodec),
  observed: c.nullable(
    c.record({ first_revision: d.positiveDecimal, last_revision: d.positiveDecimal }),
  ),
  sources: c.array(choice(["catalog", "activity", "fact", "comment", "request", "run"]), 6),
});
const sourceOrder = ["catalog", "activity", "fact", "comment", "request", "run"];
export const participantCodec: c.Codec<ParticipantRecord> = c.refine(
  participantShape,
  (value) => {
    const sources = value.sources;
    return (
      sources.length > 0 &&
      (value.registration === null || value.registration.actor_id === value.actor_id) &&
      sources.includes("catalog") === (value.registration !== null) &&
      sources.includes("activity") === (value.observed !== null) &&
      sources.every(
        (item, index) =>
          index === 0 || sourceOrder.indexOf(item) > sourceOrder.indexOf(sources[index - 1]!),
      ) &&
      (value.observed === null ||
        BigInt(value.observed.first_revision) <= BigInt(value.observed.last_revision)) &&
      (sources.every((item) => item === "catalog" || item === "activity") ||
        sources.includes("activity"))
    );
  },
  "consistent catalog/authorship identity and ordered distinct sources",
);
export const checkpointCodec: c.Codec<Checkpoint> = c.tagged<Checkpoint>("kind", {
  resource: c.record({
    kind: c.literal("resource"),
    resource_id: d.identifier,
    revision: d.positiveDecimal,
  }),
  handoff: c.record({
    kind: c.literal("handoff"),
    ticket_id: d.identifier,
    revision: d.positiveDecimal,
  }),
});
const sessionParams = c.record({
  workspace_id: d.identifier,
  target_run_id: d.identifier,
  head: c.nullable(d.digest),
  expected_run_revision: d.positiveDecimal,
  after_session_id: d.identifier,
  limit: c.refine(d.positiveDecimal, (value) => BigInt(value) <= 100n, "session limit1..100"),
  max_bytes: c.refine(
    d.positiveDecimal,
    (value) => BigInt(value) >= 4096n && BigInt(value) <= 1048576n,
    "session bytes4096..1048576",
  ),
});
export const sessionContinuationCodec: c.Codec<SessionContinuation> = c.record({
  method: c.literal("run.sessions"),
  params: sessionParams,
});
const ordered = (values: readonly string[]) =>
  values.every((value, index) => index === 0 || values[index - 1]! < value);
const unique = (values: readonly string[]) => new Set(values).size === values.length;
const association = c.record({
  basis: c.literal("explicit_and_history_run"),
  history_head: c.nullable(d.digest),
  explicit_session_ids: c.array(d.identifier, 100),
  total: d.decimal,
  omitted: d.decimal,
  next_request: c.nullable(sessionContinuationCodec),
});
const runShape = fields({
  run_id: d.identifier,
  revision: d.positiveDecimal,
  actor_id: d.identifier,
  parent_run_id: c.nullable(d.identifier),
  parent_stop_policy: parentPolicyCodec,
  objective: boundedText(16384, true),
  capabilities: c.array(boundedText(96, true), 100),
  process_ref: c.nullable(boundedText(1024, true)),
  worktree_ref: c.nullable(boundedText(4096, true)),
  status: stateCodec,
  last_observed_unix_ms: c.nullable(decimal64),
  evidence: boundedText(65536),
  session_ids: c.array(d.identifier, 100),
  session_associations: association,
});
export const runCodec: c.Codec<RunRecord> = c.refine(
  runShape,
  (value) => {
    const a = value.session_associations,
      next = a.next_request,
      ids = value.session_ids;
    return (
      (!terminal(value.status) || hasText(value.evidence)) &&
      unique(value.capabilities) &&
      ordered(ids) &&
      unique(a.explicit_session_ids) &&
      BigInt(a.total) >= BigInt(a.explicit_session_ids.length) &&
      BigInt(a.total) - BigInt(ids.length) === BigInt(a.omitted) &&
      a.explicit_session_ids.every(
        (id) =>
          (a.omitted !== "0" && (ids.length === 0 || id > ids[ids.length - 1]!)) ||
          ids.includes(id),
      ) &&
      (a.omitted === "0"
        ? next === null
        : next !== null &&
          next.params.target_run_id === value.run_id &&
          next.params.expected_run_revision === value.revision &&
          next.params.head === a.history_head &&
          next.params.after_session_id === ids.at(-1))
    );
  },
  "consistent run/session association count, order and exact continuation",
);
export const attemptCodec: c.Codec<AttemptRecord> = c.refine(
  fields({
    attempt_id: d.identifier,
    revision: d.positiveDecimal,
    run_id: d.identifier,
    ticket_id: d.identifier,
    token: d.positiveDecimal,
    state: stateCodec,
    session_ids: c.array(d.identifier, 100),
    checkpoints: c.array(checkpointCodec, 100),
    evidence: boundedText(65536),
  }),
  (value) => unique(value.session_ids) && (!terminal(value.state) || hasText(value.evidence)),
  "distinct attempt session links",
);
export const actionCodec: c.Codec<RunnerAction> = c.record({
  parent_run_id: d.identifier,
  child_run_id: d.identifier,
  policy: parentPolicyCodec,
});
const sessionShape = c.record({
  run_id: d.identifier,
  run_revision: d.positiveDecimal,
  history_head: c.nullable(d.digest),
  session_ids: c.array(d.identifier, 100),
  total: d.decimal,
  remaining: d.decimal,
  next_after_session_id: c.nullable(d.identifier),
  next_request: c.nullable(sessionContinuationCodec),
  has_more: c.boolean,
});
export const sessionPageCodec: c.Codec<SessionPage> = c.refine(
  sessionShape,
  (value) => {
    const next = value.next_request;
    return (
      ordered(value.session_ids) &&
      BigInt(value.remaining) <= BigInt(value.total) &&
      BigInt(value.session_ids.length) <= BigInt(value.total) - BigInt(value.remaining) &&
      value.has_more === (value.remaining !== "0") &&
      (!value.has_more
        ? next === null && value.next_after_session_id === null
        : next !== null &&
          value.next_after_session_id === value.session_ids.at(-1) &&
          next.params.target_run_id === value.run_id &&
          next.params.expected_run_revision === value.run_revision &&
          next.params.head === value.history_head &&
          next.params.after_session_id === value.next_after_session_id)
    );
  },
  "consistent exact session association page",
);
export const readText = (value: JsonValue | undefined, name: string): string => {
  const field = value === undefined ? undefined : jsonField(value, name);
  return field?.kind === "string" ? field.value : "";
};

/** Readable identifiers from native overview row shapes; exact records remain available. */
export function signalSummary(value: JsonValue): string {
  const records = [
    value,
    jsonField(value, "source"),
    jsonField(value, "metadata"),
    jsonField(value, "record"),
  ];
  const keys = [
    "actor_id",
    "run_id",
    "ticket_id",
    "attempt_id",
    "request_id",
    "name",
    "title",
    "status",
    "state",
    "reason",
  ];
  return [
    ...new Set(
      records.flatMap((record) => keys.map((key) => readText(record, key))).filter(Boolean),
    ),
  ].join(" · ");
}
