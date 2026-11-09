import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import { jsonField } from "../../../core/json";
import type {
  PublishedUpload,
  ResourceStage,
  ResourceUploadJob,
  StagePage,
  UploadPage,
  UploadPhase,
  PublicationLink,
} from "./upload-types";
import { resourceVersionCodec } from "./codecs";
const size = c.refine(
  d.decimal,
  (v) => BigInt(v) <= 134217728n,
  "bounded private source byte count",
);
const oneOf = <T>(codecs: readonly c.Codec<T>[]): c.Codec<T> => ({
  decode(value, path = []) {
    for (const codec of codecs) {
      const result = codec.decode(value, path);
      if (result.ok) return result;
    }
    return c.mismatch(path, "closed native resource-transfer variant");
  },
});
const status = oneOf([c.literal("incoming"), c.literal("sealed"), c.literal("abandoned")]);
export const stageCodec: c.Codec<ResourceStage> = c.refine(
  c.record({
    stage_id: d.identifier,
    digest: d.digest,
    size_bytes: c.refine(size, (v) => BigInt(v) <= 67108864n, "stage <=64MiB"),
    received: size,
    status,
    source_retained: c.boolean,
    intention_id: c.nullable(d.identifier),
    diagnostic: c.nullable(d.problem),
  }),
  (v) =>
    BigInt(v.received) <= BigInt(v.size_bytes) &&
    (v.status !== "sealed" || v.received === v.size_bytes) &&
    (v.source_retained || v.status === "abandoned" || v.intention_id !== null),
  "coherent native staged input",
);
const link: c.Codec<PublicationLink> = oneOf<PublicationLink>([
  c.record({ kind: c.literal("not_requested") }),
  c.record({ kind: c.literal("unresolved"), problem: c.nullable(d.problem) }),
  c.record({
    kind: c.literal("committed"),
    response: c.refine(
      c.object,
      (v) => {
        const parsed = d.publicResponse.decode(v);
        return parsed.ok && c.literal(true).decode(jsonField(parsed.value.meta, "durable")).ok;
      },
      "durably acknowledged optional link",
    ),
  }),
]);
export const publishedCodec: c.Codec<PublishedUpload> = c.record({
  kind: c.literal("published"),
  publication: c.record({
    data: c.record({
      resource_id: d.identifier,
      revision: d.positiveDecimal,
      version: resourceVersionCodec,
    }),
    meta: c.refine(
      c.object,
      (v) => c.literal(true).decode(jsonField(v, "durable")).ok,
      "durably acknowledged publication",
    ),
  }),
  link,
});
const phase: c.Codec<UploadPhase> = oneOf<UploadPhase>([
  c.record({ kind: c.literal("local_save_incomplete") }),
  c.record({ kind: c.literal("prepared_unsent") }),
  c.record({ kind: c.literal("running"), previous: c.nullable(publishedCodec) }),
  c.record({ kind: c.literal("rejected"), problem: d.problem }),
  c.record({ kind: c.literal("outcome_unknown"), problem: d.problem }),
  publishedCodec,
]);
const job = c.record({
  format: c.literal("workgraph-ui-resource-upload-job-1"),
  intention_id: d.identifier,
  plan: c.object,
  native_plan: c.object,
  saved_request: c.object,
  journal_path: c.text,
  input_hash: d.digest,
  revision: d.positiveDecimal,
  phase,
  diagnostic: c.nullable(d.problem),
});
export const uploadPlanCodec = c.record({
  format: c.literal("workgraph-ui-resource-upload-plan-1"),
  intention_id: d.identifier,
  connection: d.connectionProfile,
  context: d.draftContext,
  stage_id: d.identifier,
  params: c.object,
});
const savedRequest = c.record({
  id: c.text,
  jsonrpc: c.literal("2.0"),
  workgraph_api: c.literal("0.7"),
  method: c.literal("resource.upload"),
  params: c.object,
});
const text = (value: import("../../../core/json").JsonValue, name: string) => {
  const field = jsonField(value, name);
  return field?.kind === "string" ? field.value : null;
};
export const uploadJobCodec: c.Codec<ResourceUploadJob> = c.refine(
  job,
  (value) => {
    const captured = uploadPlanCodec.decode(value.plan),
      request = savedRequest.decode(value.saved_request);
    if (
      !captured.ok ||
      !request.ok ||
      captured.value.intention_id !== value.intention_id ||
      captured.value.context.workspace_id === null
    )
      return false;
    const params = captured.value.params,
      native = value.native_plan;
    if (
      text(params, "workspace_id") !== captured.value.context.workspace_id ||
      text(params, "actor_id") !== captured.value.context.writer.actor_id ||
      text(params, "run_id") !== captured.value.context.writer.run_id
    )
      return false;
    for (const key of [
      "workspace_id",
      "actor_id",
      "run_id",
      "resource_id",
      "expected_revision",
      "title",
      "filename",
      "mime_type",
      "ticket_id",
    ]) {
      if (text(params, key) !== text(native, key)) return false;
    }
    if (
      native.fields.length !== request.value.params.fields.length ||
      native.fields.some(
        (field) =>
          field.value.kind !== "string" ||
          text(request.value.params, field.name) !== field.value.value,
      )
    )
      return false;
    const published =
      value.phase.kind === "published"
        ? value.phase
        : value.phase.kind === "running"
          ? value.phase.previous
          : null;
    if (published !== null) {
      const data = published.publication.data,
        expected = d.decimal.decode(jsonField(native, "expected_revision"));
      if (
        !expected.ok ||
        BigInt(data.revision) !== BigInt(expected.value) + 1n ||
        data.resource_id !== text(native, "resource_id") ||
        data.version.digest !== text(native, "digest") ||
        data.version.size_bytes !== text(native, "size_bytes") ||
        data.version.actor_id !== text(native, "actor_id") ||
        data.version.filename !== text(native, "filename") ||
        data.version.mime_type !== text(native, "mime_type")
      )
        return false;
    }
    return true;
  },
  "upload observation matches its captured native plan/request/publication identity",
);
const pageShape = <T>(item: c.Codec<T>) => ({
  items: c.array(item, 100),
  offset: d.decimal,
  next_offset: c.nullable(d.decimal),
  remaining: d.decimal,
});
function coherentPage<T>(value: UploadPage<T>) {
  return value.next_offset === null
    ? value.remaining === "0"
    : value.items.length > 0 &&
        BigInt(value.next_offset) === BigInt(value.offset) + BigInt(value.items.length) &&
        value.remaining !== "0";
}
const page = <T>(item: c.Codec<T>): c.Codec<UploadPage<T>> =>
  c.refine(
    c.record(pageShape(item)),
    coherentPage,
    "nonempty advancing upload inventory continuation",
  );
export const jobPageCodec = page(uploadJobCodec);
export const stagePageCodec: c.Codec<StagePage> = c.refine(
  c.record({
    ...pageShape(stageCodec),
    retained_bytes: size,
    incoming_count: c.refine(
      d.decimal,
      (value) => BigInt(value) <= 2n,
      "at most two unprepared stages",
    ),
    maximum_retained_bytes: c.refine(
      size,
      (v) => v === "134217728",
      "native128MiB retained source capacity",
    ),
  }),
  (value) =>
    coherentPage(value) && BigInt(value.retained_bytes) <= BigInt(value.maximum_retained_bytes),
  "coherent staged input page and capacity",
);
