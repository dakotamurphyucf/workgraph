import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import { contextJson } from "../../../core/protocol/client";
import { jsonField } from "../../../core/json";
import type { JsonObject } from "../../../core/protocol/types";
import type { FrozenStage, PlanCapture, PlanDraft, PlanSnapshot } from "./types";
import { PLAN_LIMITS, preflightCodec } from "./model";

export const counter: c.Codec<number> = {
  decode(value, path = []) {
    return value?.kind === "number" &&
      /^(0|[1-9][0-9]{0,9})$/.test(value.lexeme) &&
      Number(value.lexeme) <= 1_000_000_000
      ? { ok: true, value: Number(value.lexeme) }
      : c.mismatch(path, "bounded local revision/count");
  },
};
const revision = c.refine(counter, (value) => value > 0, "positive local revision");
export const captureCodec: c.Codec<PlanCapture> = {
  decode(value, path = []) {
    const result = c
      .record({ connection: d.connectionProfile, context: d.draftContext })
      .decode(value, path);
    if (!result.ok) return result;
    const context = result.value.context;
    if (
      context.workspace_id === null ||
      new TextEncoder().encode(result.value.connection.label).byteLength > 512 ||
      result.value.connection.label.trim() === "" ||
      new TextEncoder().encode(result.value.connection.socket).byteLength > 4096
    )
      return c.mismatch(path, "explicit bounded workspace/profile capture");
    return {
      ok: true,
      value: {
        connection: result.value.connection,
        context: Object.freeze({ ...context, workspace_id: context.workspace_id }),
      },
    };
  },
};
const frozen: c.Codec<FrozenStage> = c.record({
  stageId: c.text,
  sourceRevision: revision,
  stageIndex: counter,
  sourceStage: c.object,
  hash: d.digest,
  reviewHash: d.digest,
  params: c.object,
  preview: preflightCodec,
  intentionId: d.identifier,
  prepared: c.boolean,
  captured: c.boolean,
  operationId: c.nullable(d.identifier),
  requestHash: c.nullable(d.digest),
  preparationHash: c.nullable(d.digest),
});
const snapshot: c.Codec<PlanSnapshot> = c.record({
  revision,
  source: c.text,
  sourceBytes: counter,
  hash: d.digest,
});
export interface StoredDraft {
  readonly format: "workgraph-ui-plan-draft-1";
  readonly id: PlanDraft["id"];
  readonly capture: PlanCapture;
  readonly source: string;
  readonly revision: number;
  readonly frozen: readonly FrozenStage[];
  readonly snapshots: readonly PlanSnapshot[];
}
export const storedDraftCodec: c.Codec<StoredDraft> = c.refine(
  c.record({
    format: c.literal("workgraph-ui-plan-draft-1"),
    id: d.identifier,
    capture: captureCodec,
    source: c.text,
    revision,
    frozen: c.array(frozen, PLAN_LIMITS.stages),
    snapshots: c.array(snapshot, PLAN_LIMITS.stages),
  }),
  (r) =>
    r.frozen.every((f) =>
      r.snapshots.some((s) => s.revision === f.sourceRevision && s.hash === f.hash),
    ) &&
    r.frozen.every((f) => f.stageIndex < PLAN_LIMITS.stages && f.sourceRevision <= r.revision) &&
    r.snapshots.every((s) => s.revision <= r.revision) &&
    new Set(r.frozen.map((f) => f.stageId)).size === r.frozen.length &&
    new Set(r.frozen.map((f) => f.stageIndex)).size === r.frozen.length &&
    new Set(r.frozen.map((f) => f.intentionId)).size === r.frozen.length &&
    new Set(r.snapshots.map((s) => s.revision)).size === r.snapshots.length,
  "coherent frozen-stage snapshot references",
);
export function captureJson(capture: PlanCapture): JsonObject {
  return d.jsonObject([
    [
      "connection",
      d.jsonObject([
        ["id", d.jsonString(capture.connection.id)],
        ["generation", d.jsonString(capture.connection.generation)],
        ["label", d.jsonString(capture.connection.label)],
        ["socket", d.jsonString(capture.connection.socket)],
      ]),
    ],
    ["context", contextJson(capture.context)],
  ]);
}
export function frozenJson(f: FrozenStage): JsonObject {
  return d.jsonObject([
    ["stageId", d.jsonString(f.stageId)],
    ["sourceRevision", d.jsonNumber(String(f.sourceRevision))],
    ["stageIndex", d.jsonNumber(String(f.stageIndex))],
    ["sourceStage", f.sourceStage],
    ["hash", d.jsonString(f.hash)],
    ["reviewHash", d.jsonString(f.reviewHash)],
    ["params", f.params],
    ["preview", f.preview.raw],
    ["intentionId", d.jsonString(f.intentionId)],
    ["prepared", d.jsonBoolean(f.prepared)],
    ["captured", d.jsonBoolean(f.captured)],
    ["operationId", f.operationId === null ? d.jsonNull() : d.jsonString(f.operationId)],
    ["requestHash", f.requestHash === null ? d.jsonNull() : d.jsonString(f.requestHash)],
    [
      "preparationHash",
      f.preparationHash === null ? d.jsonNull() : d.jsonString(f.preparationHash),
    ],
  ]);
}
export function draftJson(draft: PlanDraft): JsonObject {
  return d.jsonObject([
    ["format", d.jsonString("workgraph-ui-plan-draft-1")],
    ["id", d.jsonString(draft.id)],
    ["capture", captureJson(draft.capture)],
    ["source", d.jsonString(draft.source)],
    ["revision", d.jsonNumber(String(draft.revision))],
    ["frozen", d.jsonArray(draft.frozen.map(frozenJson))],
    [
      "snapshots",
      d.jsonArray(
        draft.snapshots.map((s) =>
          d.jsonObject([
            ["revision", d.jsonNumber(String(s.revision))],
            ["source", d.jsonString(s.source)],
            ["sourceBytes", d.jsonNumber(String(s.sourceBytes))],
            ["hash", d.jsonString(s.hash)],
          ]),
        ),
      ),
    ],
  ]);
}
export function storedStageMatches(frozen: FrozenStage): boolean {
  const id = jsonField(frozen.sourceStage, "id");
  return (
    id?.kind === "string" && id.value === frozen.stageId && frozen.stageIndex < PLAN_LIMITS.stages
  );
}
