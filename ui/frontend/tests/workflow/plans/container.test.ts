import { afterEach, describe, expect, it } from "vitest";
import * as d from "../../../src/core/protocol/decoders";
import {
  decodeContainer,
  encodeContainer,
  DRAFT_CONTAINER_LIMITS,
} from "../../../src/features/workflow/plans/container";
import { createPlansController } from "../../../src/features/workflow/plans/controller";
import {
  decodePlan,
  planJson,
  preflightCodec,
  stageJson,
  stageParams,
} from "../../../src/features/workflow/plans/model";
import { captureJson } from "../../../src/features/workflow/plans/records";
import {
  encodeValue,
  hashValue,
  parseSource,
} from "../../../src/features/workflow/plans/processing";
import type {
  FrozenStage,
  PlanCapture,
  PlanDraft,
} from "../../../src/features/workflow/plans/types";
import type { HttpClient } from "../../../src/core/protocol/http";
import { createOperationController } from "../../../src/core/state/operations";
import { context, decode } from "../../work/actions-fixtures";
import { createTestProcessor } from "../../core/processing-harness";

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});
function setup() {
  const processing = createTestProcessor();
  const unexpected = () =>
    Promise.reject(new Error("Recovery decoding must not contact a daemon or journal"));
  const http: HttpClient = { processing, request: unexpected };
  const operations = createOperationController(
    {
      connections: unexpected,
      read: unexpected,
      inspect: unexpected,
      prepare: unexpected,
      act: unexpected,
    },
    processing,
  );
  const controller = createPlansController({
    http,
    operations,
    storage: {
      load: () => Promise.resolve([]),
      put: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      dispose: () => undefined,
    },
  });
  disposals.push(
    () => controller.dispose(),
    () => operations.dispose(),
    () => processing.dispose(),
  );
  const selected = context(http);
  const capture: PlanCapture = {
    connection: selected.connection,
    context: {
      workspace_id: decode(d.identifier, selected.route.workspaceId),
      project_id: null,
      writer: { actor_id: decode(d.identifier, "author"), run_id: null },
    },
  };
  return { processing, controller, capture };
}
async function fixture(h: ReturnType<typeof setup>, size = 16) {
  const payload = "x".repeat(size),
    frozen: FrozenStage[] = [],
    snapshots: PlanDraft["snapshots"][number][] = [];
  let source = "";
  const preview = decode(preflightCodec, {
    validation: "domain_preparation",
    workspace_revision: "10",
    proposed_revision: "11",
    operation_count: "1",
    generated_ids: [],
    staged_blob_count: "0",
    staged_blob_bytes: "0",
  });
  for (let index = 0; index < 3; index++) {
    source = JSON.stringify({
      format: "workgraph-ui-plan-1",
      title: `Recovery revision ${index + 1}`,
      stages: [0, 1, 2].map((stage) => ({
        id: `stage-${stage}`,
        title: `Atomic stage ${stage}`,
        operations: [
          {
            method: "fact.put",
            alias: null,
            params: {
              key: `synthetic.stage.${stage}`,
              value: stage === 0 ? payload : `value-${stage}`,
            },
          },
        ],
        bindings: [],
        exposure: "Independent explicit commit",
        exposures: [],
      })),
    });
    const document = decodePlan(await parseSource(h.processing, source)),
      stage = document.stages[index]!;
    const hash = await hashValue(
      h.processing,
      "plan",
      d.jsonObject([
        ["capture", captureJson(h.capture)],
        ["document", planJson(document)],
      ]),
    );
    const params = stageParams(h.capture, stage.operations);
    const reviewHash = await hashValue(
      h.processing,
      "review",
      d.jsonObject([
        ["plan_hash", d.jsonString(hash)],
        ["stage_id", d.jsonString(stage.id)],
        ["params", params],
        ["preflight", preview.raw],
      ]),
    );
    frozen.push({
      stageId: stage.id,
      stageIndex: index,
      sourceRevision: index + 1,
      sourceStage: stageJson(stage),
      hash,
      reviewHash,
      params,
      preview,
      intentionId: decode(d.identifier, `retained-intention-${index}`),
      prepared: false,
      captured: true,
      operationId: null,
      requestHash: null,
      preparationHash: null,
    });
    snapshots.push({
      revision: index + 1,
      source,
      sourceBytes: new TextEncoder().encode(source).byteLength,
      hash,
    });
  }
  return {
    id: decode(d.identifier, "retained-draft"),
    capture: h.capture,
    source,
    sourceBytes: new TextEncoder().encode(source).byteLength,
    revision: 3,
    parsedRevision: 3,
    structuredRevision: 3,
    templateSpec: null,
    templateSpecRevision: null,
    document: decodePlan(await parseSource(h.processing, source)),
    frozen,
    snapshots,
    active: null,
    issue: null,
    unexpected: null,
    persisted: "saved",
    persistenceFailure: null,
  } satisfies PlanDraft;
}
describe("bounded ordered local recovery container", () => {
  it("round trips more than16MiB through individually bounded worker frames and controller admission", async () => {
    const h = setup(),
      draft = await fixture(h, 3 * 1024 * 1024);
    const text = await encodeContainer(h.processing, draft),
      bytes = new TextEncoder().encode(text).byteLength;
    expect(bytes).toBeGreaterThan(16 * 1024 * 1024);
    expect(bytes).toBeLessThan(DRAFT_CONTAINER_LIMITS.bytes);
    const lines = text.trimEnd().split("\n");
    expect(
      lines.every((line) => new TextEncoder().encode(line).byteLength < 16 * 1024 * 1024),
    ).toBe(true);
    expect(lines.length).toBeLessThan(DRAFT_CONTAINER_LIMITS.frames);
    const decoded = await decodeContainer(h.processing, text);
    expect(decoded.source).toBe(draft.source);
    expect(decoded.snapshots.map((s) => s.source)).toEqual(draft.snapshots.map((s) => s.source));
    expect(decoded.frozen.map((f) => f.intentionId)).toEqual(
      draft.frozen.map((f) => f.intentionId),
    );
    expect(await h.controller.importDraft(text)).toBe(draft.id);
    const restored = h.controller.get().drafts[0]!;
    expect(restored.issue).toBeNull();
    expect(restored.frozen).toHaveLength(3);
    expect(await encodeValue(h.processing, restored.frozen[0]!.params)).toBe(
      await encodeValue(h.processing, draft.frozen[0]!.params),
    );
  }, 90_000);
  it("rejects missing, duplicate, unknown, reordered, inconsistent and old monolithic records without replacing an editor", async () => {
    const h = setup(),
      draft = await fixture(h),
      text = await encodeContainer(h.processing, draft),
      lines = text.trimEnd().split("\n");
    expect(await h.controller.importDraft(text)).toBe(draft.id);
    const before = h.controller.get().drafts[0];
    const header = lines[0]!;
    const malformed = [
      lines.slice(0, -1).join("\n"),
      [header, lines[1], ...lines.slice(1)].join("\n"),
      [...lines.slice(0, -1), '{"kind":"unknown"}', lines.at(-1)].join("\n"),
      [header, lines[2], lines[1], ...lines.slice(3)].join("\n"),
      text.replace('"sourceParts":1', '"sourceParts":2'),
      text.replace('"records":', '"records":999,"duplicate":'),
      '{"format":"workgraph-ui-plan-draft-1"}',
    ];
    for (const bad of malformed) {
      expect(await h.controller.importDraft(bad)).toBeNull();
      expect(h.controller.get().drafts).toHaveLength(1);
      expect(h.controller.get().drafts[0]?.source).toBe(before?.source);
      expect(h.controller.get().drafts[0]?.capture).toBe(before?.capture);
      expect(h.controller.get().drafts[0]?.frozen).toBe(before?.frozen);
      expect(h.controller.get().issue).not.toBeNull();
    }
  });
  it("retains literal invalid editing source and splits surrogate pairs without corruption", async () => {
    const h = setup(),
      draft = await fixture(h);
    const source = "a".repeat(DRAFT_CONTAINER_LIMITS.textUnits - 1) + "😀\u0000\n";
    const text = await encodeContainer(h.processing, {
      ...draft,
      source,
      sourceBytes: new TextEncoder().encode(source).byteLength,
    });
    expect((await decodeContainer(h.processing, text)).source).toBe(source);
  });
});
