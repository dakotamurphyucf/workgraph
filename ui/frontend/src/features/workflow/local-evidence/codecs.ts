import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import { jsonField } from "../../../core/json";
import { resourceVersionCodec } from "../../knowledge/resources/codecs";
import type {
  CapturedCommand,
  CapturedOutcome,
  ExternalIntent,
  InspectedOutput,
  PublicationJob,
  PublicationLink,
  PublicationPlan,
  PublicationSummary,
  StageSnapshot,
} from "./types";

function choice<const T extends string>(values: readonly T[]): c.Codec<T> {
  return {
    decode(value, path = []) {
      const found = c.text.decode(value, path);
      if (!found.ok) return found;
      const selected = values.find((item) => item === found.value);
      return selected === undefined
        ? c.mismatch(path, values.join(" or "))
        : { ok: true, value: selected };
    },
  };
}
const bytes = (value: string) => new TextEncoder().encode(value).length;
export const hostPath = c.refine(
  c.text,
  (value) => value.startsWith("/") && !value.includes("\0") && bytes(value) <= 4096,
  "absolute companion-host path of at most 4096 bytes",
);
const boundedText = (maximum: number) =>
  c.refine(
    c.text,
    (value) => bytes(value) <= maximum && !value.includes("\0"),
    `UTF8 text of at most ${maximum} bytes`,
  );
export const int64 = c.refine(
  c.text,
  (value) => /^(0|[1-9][0-9]{0,18})$/u.test(value) && BigInt(value) <= 9223372036854775807n,
  "nonnegative canonical int64 decimal string",
);
const count = (maximum: bigint) =>
  c.refine(d.decimal, (value) => BigInt(value) <= maximum, `decimal byte count at most ${maximum}`);
const commandRaw: c.Codec<CapturedCommand> = c.record({
  argv: c.array(boundedText(65536), 256),
  cwd: hostPath,
  output_limit: c.refine(count(1048576n), (v) => BigInt(v) > 0n, "1..1MiB stream retention"),
  source_root: c.optional(hostPath),
  source_paths: c.optional(c.array(boundedText(65536), 256)),
});
export const command = c.refine(
  commandRaw,
  (value) =>
    value.argv.length > 0 &&
    value.argv[0] !== "" &&
    value.argv.reduce((sum, argument) => sum + bytes(argument), 0) <= 65536,
  "nonempty bounded literal argv",
);
export const outcome: c.Codec<CapturedOutcome> = c.tagged<CapturedOutcome>("kind", {
  exited: c.record({ kind: c.literal("exited"), code: count(255n) }),
  signaled: c.record({
    kind: c.literal("signaled"),
    signal: c.refine(
      c.text,
      (value) =>
        /^-?[1-9][0-9]{0,18}$/u.test(value) &&
        BigInt(value) >= -4611686018427387904n &&
        BigInt(value) <= 4611686018427387903n,
      "nonzero canonical native signal integer",
    ),
  }),
  interrupted: c.record({ kind: c.literal("interrupted") }),
  launch_failed: c.record({ kind: c.literal("launch_failed"), message: boundedText(4096) }),
});
const retained = c.refine(
  c.record({
    digest: d.digest,
    size_bytes: count(1048576n),
    observed_bytes: int64,
    observed_sha256: d.digest,
    eof: c.boolean,
    truncated: c.boolean,
  }),
  (value) =>
    BigInt(value.observed_bytes) >= BigInt(value.size_bytes) &&
    value.truncated === BigInt(value.observed_bytes) > BigInt(value.size_bytes) &&
    (value.truncated || value.digest === value.observed_sha256),
  "consistent retained-prefix identity and observed count",
);
const base = {
  directory: hostPath,
  command,
  owner_token: c.nullable(d.digest),
  publication_intent: choice(["absent", "external", "helper_bound"]),
};
const stageRaw: c.Codec<StageSnapshot> = c.tagged<StageSnapshot>("kind", {
  unfinished: c.record({ ...base, kind: c.literal("unfinished") }),
  finished: c.record({
    ...base,
    kind: c.literal("finished"),
    capture: c.record({ digest: d.digest, size_bytes: count(4194304n) }),
    outcome,
    started_unix_ms: int64,
    finished_unix_ms: int64,
    elapsed_ms: int64,
    source_before: c.raw,
    source_after: c.raw,
    stdout: retained,
    stderr: retained,
  }),
});
export const stage = c.refine(
  stageRaw,
  (value) =>
    value.kind === "unfinished" ||
    (value.outcome.kind !== "exited" && value.outcome.kind !== "signaled") ||
    (value.stdout.eof && value.stderr.eof),
  "terminal native result with drained output",
);
function exactBase64(value: string, count: string): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?(?![\s\S])/u.test(value))
    return false;
  const binary = atob(value);
  return btoa(binary) === value && BigInt(binary.length) === BigInt(count);
}
export const inspected: c.Codec<InspectedOutput> = c.refine(
  c.record({
    directory: hostPath,
    capture_digest: d.digest,
    stream: choice(["stdout", "stderr"]),
    selection: choice(["range", "retained_tail"]),
    retention: c.literal("prefix"),
    offset: count(1048576n),
    returned_bytes: count(65536n),
    retained_bytes: count(1048576n),
    omitted_retained_bytes: count(1048576n),
    observed_bytes: int64,
    observed_sha256: d.digest,
    eof: c.boolean,
    truncated: c.boolean,
    at_observed_end: c.boolean,
    text: c.text,
    text_lossy: c.boolean,
    data_base64: c.refine(c.text, (value) => value.length <= 87384, "bounded exact base64 bytes"),
    source_before: c.raw,
    source_after: c.raw,
    outcome,
  }),
  (value) =>
    exactBase64(value.data_base64, value.returned_bytes) &&
    BigInt(value.offset) + BigInt(value.returned_bytes) <= BigInt(value.retained_bytes) &&
    BigInt(value.observed_bytes) >= BigInt(value.retained_bytes) &&
    BigInt(value.omitted_retained_bytes) + BigInt(value.returned_bytes) ===
      BigInt(value.retained_bytes) &&
    value.truncated === BigInt(value.observed_bytes) > BigInt(value.retained_bytes) &&
    value.at_observed_end ===
      (!value.truncated &&
        BigInt(value.offset) + BigInt(value.returned_bytes) === BigInt(value.retained_bytes)),
  "consistent native retained output slice",
);
export const externalIntent: c.Codec<ExternalIntent> = c.record({
  directory: hostPath,
  intent_digest: d.digest,
  saved_request: hostPath,
  request: c.raw,
  original_endpoint_recorded: c.literal(false),
});
const common = { intention_id: d.identifier, connection: d.connectionProfile, directory: hostPath };
const params = c.record({
  workspace_id: d.identifier,
  actor_id: d.identifier,
  run_id: c.optional(d.identifier),
  mutation_id: d.identifier,
  resource_id: d.identifier,
  expected_revision: d.decimal,
  title: c.refine(boundedText(512), (v) => v.length > 0, "nonempty resource title"),
  ticket_id: c.optional(d.identifier),
});
const planRaw: c.Codec<PublicationPlan> = c.tagged<PublicationPlan>("kind", {
  ui_prepared: c.record({
    ...common,
    kind: c.literal("ui_prepared"),
    context: d.draftContext,
    params,
    capture_digest: d.digest,
  }),
  operator_bound_external: c.record({
    ...common,
    kind: c.literal("operator_bound_external"),
    intent_digest: d.digest,
  }),
});
export const plan = c.refine(
  planRaw,
  (value) =>
    value.kind !== "ui_prepared" ||
    (value.params.mutation_id === value.intention_id &&
      value.params.workspace_id === value.context.workspace_id &&
      value.params.actor_id === value.context.writer.actor_id &&
      (value.params.run_id ?? null) === value.context.writer.run_id),
  "immutable original writer/workspace/intention binding",
);
export const link: c.Codec<PublicationLink> = c.tagged<PublicationLink>("kind", {
  not_requested: c.record({ kind: c.literal("not_requested") }),
  linked: c.record({ kind: c.literal("linked"), receipt: c.raw }),
  rejected: c.record({ kind: c.literal("rejected"), problem: d.problem }),
  unknown: c.record({ kind: c.literal("unknown"), problem: c.nullable(d.problem) }),
});
const known = c.record({ publication: c.raw, link });
const diagnosticState = (kind: "outcome_unknown" | "local_save_incomplete" | "failed_unsent") =>
  c.record({ kind: c.literal(kind), diagnostic: d.problem });
const state: c.Codec<PublicationJob["state"]> = c.tagged<PublicationJob["state"]>("kind", {
  prepared_unsent: c.record({ kind: c.literal("prepared_unsent") }),
  running: c.record({ kind: c.literal("running"), previous: c.nullable(known) }),
  published: c.record({ kind: c.literal("published"), publication: c.raw, link }),
  outcome_unknown: diagnosticState("outcome_unknown"),
  local_save_incomplete: diagnosticState("local_save_incomplete"),
  failed_unsent: diagnosticState("failed_unsent"),
});
const jobRaw = c.record({
  plan,
  input_hash: d.digest,
  revision: d.positiveDecimal,
  saved_request: c.nullable(hostPath),
  native_request: c.nullable(c.raw),
  intent_digest: c.nullable(d.digest),
  state,
  diagnostic: c.nullable(d.problem),
});
const nativeRequest = c.record({
  jsonrpc: c.literal("2.0"),
  workgraph_api: c.literal("0.7"),
  id: c.text,
  method: c.literal("resource.upload"),
  params: c.record({
    transfer_version: c.literal("2"),
    upload_id: d.identifier,
    workspace_id: d.identifier,
    actor_id: d.identifier,
    run_id: c.optional(d.identifier),
    mutation_id: d.identifier,
    resource_id: d.identifier,
    expected_revision: d.decimal,
    title: boundedText(512),
    filename: boundedText(255),
    mime_type: boundedText(128),
    file: hostPath,
    digest: d.digest,
    size_bytes: count(67108864n),
    ticket_id: c.optional(d.identifier),
  }),
});
const publishedReceipt = c.record({
  data: c.record({
    resource_id: d.identifier,
    revision: d.positiveDecimal,
    version: resourceVersionCodec,
  }),
  meta: c.refine(
    c.object,
    (value) => c.literal(true).decode(jsonField(value, "durable")).ok,
    "durable publication metadata",
  ),
});
const linkReceipt = c.record({
  data: c.record({ revision: d.positiveDecimal }),
  meta: c.refine(
    c.object,
    (value) => c.literal(true).decode(jsonField(value, "durable")).ok,
    "durable link metadata",
  ),
});
export const job: c.Codec<PublicationJob> = c.refine(
  jobRaw,
  (value) => {
    const saved = value.native_request !== null;
    if (saved !== (value.saved_request !== null) || saved !== (value.intent_digest !== null))
      return false;
    if (!saved)
      return value.state.kind === "local_save_incomplete" || value.state.kind === "failed_unsent";
    if (
      value.plan.kind === "operator_bound_external" &&
      (value.plan.intent_digest !== value.intent_digest || value.state.kind === "prepared_unsent")
    )
      return false;
    const native = nativeRequest.decode(value.native_request);
    if (
      !native.ok ||
      value.saved_request !== `${value.plan.directory}/publication.json` ||
      native.value.params.file !== `${value.plan.directory}/capture.json`
    )
      return false;
    const params = native.value.params;
    if (value.plan.kind === "ui_prepared") {
      const captured = value.plan.params;
      for (const key of [
        "workspace_id",
        "actor_id",
        "run_id",
        "mutation_id",
        "resource_id",
        "expected_revision",
        "title",
        "ticket_id",
      ] as const) {
        if (captured[key] !== params[key]) return false;
      }
      if (
        params.digest !== value.plan.capture_digest ||
        params.filename !== "execution-capture.json" ||
        params.mime_type !== "application/json"
      )
        return false;
    }
    const known =
      value.state.kind === "published"
        ? value.state
        : value.state.kind === "running"
          ? value.state.previous
          : null;
    if (known !== null) {
      const receipt = publishedReceipt.decode(known.publication);
      if (!receipt.ok) return false;
      const data = receipt.value.data,
        v = data.version;
      if (
        data.resource_id !== params.resource_id ||
        BigInt(data.revision) !== BigInt(params.expected_revision) + 1n ||
        v.digest !== params.digest ||
        v.size_bytes !== params.size_bytes ||
        v.actor_id !== params.actor_id ||
        v.filename !== params.filename ||
        v.mime_type !== params.mime_type
      )
        return false;
      if ((known.link.kind === "not_requested") !== (params.ticket_id === undefined)) return false;
      if (known.link.kind === "linked" && !linkReceipt.decode(known.link.receipt).ok) return false;
      if (
        known.link.kind === "rejected" &&
        ["Outcome_unknown", "Local_io", "Storage_unavailable"].includes(known.link.problem.kind)
      )
        return false;
    }
    return true;
  },
  "saved exact upload identity, coherent lifecycle and external uncertainty",
);
const stateKind = choice([
  "prepared_unsent",
  "running",
  "published",
  "outcome_unknown",
  "local_save_incomplete",
  "failed_unsent",
]);
const linkKind = choice(["not_requested", "linked", "rejected", "unknown"]);
export const summary: c.Codec<PublicationSummary> = c.refine(
  c.record({
    plan,
    revision: d.positiveDecimal,
    state_kind: stateKind,
    publication_known: c.boolean,
    link_kind: c.nullable(linkKind),
    diagnostic: c.nullable(d.problem),
  }),
  (value) =>
    value.publication_known === (value.link_kind !== null) &&
    (value.state_kind !== "published" || value.publication_known),
  "coherent compact publication summary",
);
