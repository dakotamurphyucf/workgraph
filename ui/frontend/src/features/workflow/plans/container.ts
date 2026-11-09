import type { JsonValue } from "../../../core/json";
import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type { ProtocolProcessor } from "../../../core/protocol/worker";
import { PlanInputError, PLAN_LIMITS } from "./model";
import {
  captureCodec,
  captureJson,
  counter,
  frozenJson,
  storedDraftCodec,
  type StoredDraft,
} from "./records";
import { encodeValue, parseSource } from "./processing";
import type { PlanDraft } from "./types";

export const DRAFT_CONTAINER_LIMITS = Object.freeze({
  bytes: 64 * 1024 * 1024,
  frames: 512,
  textUnits: 256 * 1024,
});
const text = c.refine(
  c.text,
  (v) => v.length <= DRAFT_CONTAINER_LIMITS.textUnits,
  "bounded source part",
);
const header = c.record({
  format: c.literal("workgraph-ui-plan-draft-lines-1"),
  id: d.identifier,
  capture: captureCodec,
  revision: counter,
  sourceParts: counter,
  stageCount: counter,
  snapshotCount: counter,
});
const sourcePart = c.record({ kind: c.literal("source"), index: counter, text });
const stageRecord = c.record({ kind: c.literal("stage"), index: counter, value: c.object });
const stageSource = c.record({ kind: c.literal("stage-source"), index: counter, value: c.object });
const stageParams = c.record({ kind: c.literal("stage-params"), index: counter, value: c.object });
const stagePreview = c.record({
  kind: c.literal("stage-preview"),
  index: counter,
  value: c.object,
});
const snapshotRecord = c.record({
  kind: c.literal("snapshot"),
  index: counter,
  revision: counter,
  sourceBytes: counter,
  hash: d.digest,
  parts: counter,
});
const snapshotPart = c.record({
  kind: c.literal("snapshot-source"),
  snapshot: counter,
  index: counter,
  text,
});
const endRecord = c.record({ kind: c.literal("end"), records: counter });
function chunks(source: string): readonly string[] {
  const result: string[] = [];
  for (let start = 0; start < source.length;) {
    let end = Math.min(start + DRAFT_CONTAINER_LIMITS.textUnits, source.length);
    const code = source.charCodeAt(end - 1);
    if (end < source.length && code >= 0xd800 && code <= 0xdbff) end--;
    result.push(source.slice(start, end));
    start = end;
  }
  return result.length === 0 ? [""] : result;
}
function record(entries: readonly (readonly [string, JsonValue])[]) {
  return d.jsonObject(entries);
}
export function stageFrames(
  draft: PlanDraft["frozen"][number],
  index: number,
): readonly JsonValue[] {
  const metadata = d.jsonObject(
    frozenJson(draft)
      .fields.filter((f) => !["sourceStage", "params", "preview"].includes(f.name))
      .map((f) => [f.name, f.value] as const),
  );
  return [
    ["stage", metadata],
    ["stage-source", draft.sourceStage],
    ["stage-params", draft.params],
    ["stage-preview", draft.preview.raw],
  ].map(([kind, value]) => {
    if (typeof kind !== "string" || typeof value === "string" || value === undefined)
      throw new Error("Stage frame invariant");
    return record([
      ["kind", d.jsonString(kind)],
      ["index", d.jsonNumber(String(index))],
      ["value", value],
    ]);
  });
}
export async function stageFrameBytes(
  processing: ProtocolProcessor,
  stage: PlanDraft["frozen"][number],
): Promise<number> {
  let bytes = 0;
  for (const frame of stageFrames(stage, 0))
    bytes += new TextEncoder().encode(await encodeValue(processing, frame)).byteLength + 1;
  return bytes;
}
export async function encodeContainer(
  processing: ProtocolProcessor,
  draft: PlanDraft,
): Promise<string> {
  const sources = chunks(draft.source),
    frames: JsonValue[] = [
      record([
        ["format", d.jsonString("workgraph-ui-plan-draft-lines-1")],
        ["id", d.jsonString(draft.id)],
        ["capture", captureJson(draft.capture)],
        ["revision", d.jsonNumber(String(draft.revision))],
        ["sourceParts", d.jsonNumber(String(sources.length))],
        ["stageCount", d.jsonNumber(String(draft.frozen.length))],
        ["snapshotCount", d.jsonNumber(String(draft.snapshots.length))],
      ]),
    ];
  sources.forEach((text, index) =>
    frames.push(
      record([
        ["kind", d.jsonString("source")],
        ["index", d.jsonNumber(String(index))],
        ["text", d.jsonString(text)],
      ]),
    ),
  );
  draft.frozen.forEach((value, index) => frames.push(...stageFrames(value, index)));
  draft.snapshots.forEach((snapshot, index) => {
    const parts = chunks(snapshot.source);
    frames.push(
      record([
        ["kind", d.jsonString("snapshot")],
        ["index", d.jsonNumber(String(index))],
        ["revision", d.jsonNumber(String(snapshot.revision))],
        ["sourceBytes", d.jsonNumber(String(snapshot.sourceBytes))],
        ["hash", d.jsonString(snapshot.hash)],
        ["parts", d.jsonNumber(String(parts.length))],
      ]),
    );
    parts.forEach((text, part) =>
      frames.push(
        record([
          ["kind", d.jsonString("snapshot-source")],
          ["snapshot", d.jsonNumber(String(index))],
          ["index", d.jsonNumber(String(part))],
          ["text", d.jsonString(text)],
        ]),
      ),
    );
  });
  const count = frames.length;
  frames.push(
    record([
      ["kind", d.jsonString("end")],
      ["records", d.jsonNumber(String(count))],
    ]),
  );
  if (frames.length > DRAFT_CONTAINER_LIMITS.frames)
    throw new PlanInputError("Recoverable draft exceeds its frame count bound.");
  const output: string[] = [];
  let bytes = 0;
  for (const frame of frames) {
    const line = await encodeValue(processing, frame);
    bytes += new TextEncoder().encode(line).byteLength + 1;
    if (bytes > DRAFT_CONTAINER_LIMITS.bytes)
      throw new PlanInputError("Recoverable draft exceeds64MiB; no state was replaced.");
    output.push(line);
  }
  return output.join("\n") + "\n";
}
export async function decodeContainer(
  processing: ProtocolProcessor,
  source: string,
): Promise<StoredDraft> {
  if (new TextEncoder().encode(source).byteLength > DRAFT_CONTAINER_LIMITS.bytes)
    throw new PlanInputError("Draft container exceeds64MiB.");
  const lines = source.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (
    lines.length < 3 ||
    lines.length > DRAFT_CONTAINER_LIMITS.frames ||
    lines.some((line) => line === "")
  )
    throw new PlanInputError(
      "Draft container is empty, truncated or has invalid frame boundaries.",
    );
  let cursor = 0;
  async function read<T>(codec: c.Codec<T>): Promise<T> {
    const line = lines[cursor++];
    if (line === undefined) throw new PlanInputError("Draft container is truncated.");
    const decoded = codec.decode(await parseSource(processing, line, undefined, true));
    if (!decoded.ok)
      throw new PlanInputError(
        `Draft frame${cursor}: ${decoded.issue.path.join(".")} expected ${decoded.issue.expected}.`,
      );
    return decoded.value;
  }
  const start = await read(header);
  if (
    start.sourceParts < 1 ||
    start.sourceParts > 32 ||
    start.stageCount > PLAN_LIMITS.stages ||
    start.snapshotCount > PLAN_LIMITS.stages
  )
    throw new PlanInputError("Draft header counts exceed their bounds.");
  const sourceParts: string[] = [];
  for (let index = 0; index < start.sourceParts; index++) {
    const part = await read(sourcePart);
    if (part.index !== index)
      throw new PlanInputError("Source frame is duplicate or out of order.");
    sourceParts.push(part.text);
  }
  const stages: JsonValue[] = [];
  for (let index = 0; index < start.stageCount; index++) {
    const stage = await read(stageRecord);
    if (stage.index !== index)
      throw new PlanInputError("Stage frame is duplicate or out of order.");
    if (stage.value.fields.some((f) => ["sourceStage", "params", "preview"].includes(f.name)))
      throw new PlanInputError("Heavy stage fields must have their own ordered records.");
    const source = await read(stageSource),
      params = await read(stageParams),
      preview = await read(stagePreview);
    if (source.index !== index || params.index !== index || preview.index !== index)
      throw new PlanInputError("Stage payload identity/order differs.");
    stages.push(
      record([
        ...stage.value.fields.map((f) => [f.name, f.value] as const),
        ["sourceStage", source.value],
        ["params", params.value],
        ["preview", preview.value],
      ]),
    );
  }
  const snapshots: JsonValue[] = [];
  for (let index = 0; index < start.snapshotCount; index++) {
    const snapshot = await read(snapshotRecord);
    if (snapshot.index !== index || snapshot.parts < 1 || snapshot.parts > 32)
      throw new PlanInputError("Snapshot frame/count is invalid.");
    const parts: string[] = [];
    for (let partIndex = 0; partIndex < snapshot.parts; partIndex++) {
      const part = await read(snapshotPart);
      if (part.snapshot !== index || part.index !== partIndex)
        throw new PlanInputError("Snapshot source is duplicate or out of order.");
      parts.push(part.text);
    }
    snapshots.push(
      record([
        ["revision", d.jsonNumber(String(snapshot.revision))],
        ["source", d.jsonString(parts.join(""))],
        ["sourceBytes", d.jsonNumber(String(snapshot.sourceBytes))],
        ["hash", d.jsonString(snapshot.hash)],
      ]),
    );
  }
  const expected = cursor,
    end = await read(endRecord);
  if (end.records !== expected || cursor !== lines.length)
    throw new PlanInputError("Draft end/count differs or unrecognized trailing records remain.");
  const assembled = record([
    ["format", d.jsonString("workgraph-ui-plan-draft-1")],
    ["id", d.jsonString(start.id)],
    ["capture", captureJson(start.capture)],
    ["source", d.jsonString(sourceParts.join(""))],
    ["revision", d.jsonNumber(String(start.revision))],
    ["frozen", d.jsonArray(stages)],
    ["snapshots", d.jsonArray(snapshots)],
  ]);
  const decoded = storedDraftCodec.decode(assembled);
  if (!decoded.ok)
    throw new PlanInputError(
      `Draft contents: ${decoded.issue.path.join(".")} expected ${decoded.issue.expected}.`,
    );
  return decoded.value;
}
