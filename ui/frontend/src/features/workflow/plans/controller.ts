import type { FeatureContext } from "../../../app/types";
import { jsonField } from "../../../core/json";
import { invalidScalarOffset } from "../../../core/json/decode";
import { createCompanion } from "../../../core/protocol/client";
import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type { HttpResult } from "../../../core/protocol/http";
import type {
  Decimal,
  ConnectionProfile,
  Identifier,
  JsonObject,
  Operation,
  Preparation,
} from "../../../core/protocol/types";
import {
  PLAN_LIMITS,
  PlanInputError,
  checkedId,
  decodePlan,
  decodePlanShape,
  validatePlan,
  materializeStage,
  planJson,
  preflightCodec,
  stageJson,
  stageParams,
  templateCodec,
  templatePreviewCodec,
  validateExposure,
  type InstanceExposurePreview,
} from "./model";
import {
  initialTemplateSpec,
  instanceDocument,
  templateSourceDocument,
  templateSourceOperation,
} from "./authoring";
import { setField, text } from "./schema";
import { captureJson, storedStageMatches } from "./records";
import {
  DRAFT_CONTAINER_LIMITS,
  decodeContainer,
  encodeContainer,
  stageFrameBytes,
} from "./container";
import { createDraftStorage } from "./storage";
import { encodeValue, hashValue, parseSource } from "./processing";
import type {
  FrozenStage,
  PlanCapture,
  PlanDocument,
  PlanDraft,
  PlansController,
  PlansControllerOptions,
  PlansState,
  PlanTask,
  TemplatePin,
} from "./types";

const requestCodec = c.record({
  jsonrpc: c.literal("2.0"),
  workgraph_api: c.literal("0.7"),
  id: c.text,
  method: c.literal("transaction.apply"),
  params: c.object,
});
const listingCodec = c.record({
  items: c.array(templateCodec, 100),
  next_offset: c.nullable(d.decimal),
  omitted: d.decimal,
});
function unwrap<T>(result: HttpResult<T>): T {
  if (result.ok) return result.data;
  const failure = result.failure;
  if (failure.kind === "aborted")
    throw new DOMException("Obsolete plan request cancelled.", "AbortError");
  throw new PlanInputError(
    failure.kind === "remote"
      ? `${failure.problem.kind}: ${failure.problem.message}`
      : "message" in failure
        ? failure.message
        : "The companion could not complete this request.",
  );
}
function nativeScope(context: FeatureContext): PlanCapture {
  if (context.profileState !== "current")
    throw new PlanInputError(
      "Refresh this exact connection profile before starting a new draft or read.",
    );
  if (context.route.workspaceId === null || context.writer.actorId === null)
    throw new PlanInputError("Select a workspace and acting actor before creating a plan.");
  return Object.freeze({
    connection: Object.freeze({ ...context.connection }),
    context: Object.freeze({
      workspace_id: checkedId(context.route.workspaceId),
      project_id: context.route.projectId === null ? null : checkedId(context.route.projectId),
      writer: Object.freeze({
        actor_id: checkedId(context.writer.actorId),
        run_id: context.writer.runId === null ? null : checkedId(context.writer.runId),
      }),
    }),
  });
}
function readScope(context: FeatureContext) {
  if (context.profileState !== "current" || context.route.workspaceId === null)
    throw new PlanInputError(
      "Select a workspace and refresh this exact connection profile before reading templates.",
    );
  return {
    connection: Object.freeze({ ...context.connection }),
    context: { workspace_id: checkedId(context.route.workspaceId) },
  };
}
function withScope(capture: PlanCapture, params: JsonObject): JsonObject {
  const scope = stageParams(capture, []).fields.filter((f) => f.name !== "operations");
  for (const name of ["workspace_id", "actor_id", "run_id", "mutation_id"]) {
    const field = jsonField(params, name),
      expected = scope.find((f) => f.name === name)?.value;
    if (
      field !== undefined &&
      (expected?.kind !== "string" || field.kind !== "string" || field.value !== expected.value)
    )
      throw new PlanInputError(
        "Input attribution differs from its captured writer/workspace. Open a new draft explicitly.",
      );
  }
  return d.jsonObject([
    ...params.fields
      .filter((f) => !["workspace_id", "actor_id", "run_id"].includes(f.name))
      .map((f) => [f.name, f.value] as const),
    ...scope.map((f) => [f.name, f.value] as const),
  ]);
}
function helperBody(capture: PlanCapture, params: JsonObject): JsonObject {
  return d.jsonObject([
    ["connection_id", d.jsonString(capture.connection.id)],
    ["generation", d.jsonString(capture.connection.generation)],
    ["lane", d.jsonString("visible")],
    ["params", params],
  ]);
}
function emptyPlan(capture: PlanCapture): PlanDocument {
  return {
    format: "workgraph-ui-plan-1",
    title: "Untitled workflow",
    stages: [
      {
        id: "stage-one",
        title: "Atomic publication",
        operations: [
          {
            method: "ticket.create",
            params: d.jsonObject([
              ["title", d.jsonString("New work")],
              ...(capture.context.project_id === null
                ? []
                : [["project_id", d.jsonString(capture.context.project_id)] as const]),
            ]),
            alias: "work",
          },
        ],
        bindings: [],
        exposure: "",
        exposures: [],
      },
    ],
  };
}
/** One launch owner. Unsent source and exact staged operations survive route/actor changes. */
export function createPlansController({
  http,
  operations,
  storage = createDraftStorage(),
  newId = () => `plan-${crypto.randomUUID()}`,
}: PlansControllerOptions): PlansController {
  const companion = createCompanion(http),
    listeners = new Set<() => void>(),
    jobs = new Map<Identifier, { readonly token: object; readonly abort: AbortController }>(),
    pendingStorage = new Map<
      Identifier,
      { readonly draft: PlanDraft | null; readonly token: object }
    >(),
    storageTokens = new Map<Identifier, object>();
  const verified = new Map<Identifier, Map<Identifier, string>>();
  const reviewed = new Map<Identifier, Map<Identifier, string>>();
  // Identity follows immutable payloads through metadata updates; obsolete previews are collectable.
  const recoveryWeights = new WeakMap<JsonObject, number>();
  const markVerified = (id: Identifier, stage: FrozenStage) => {
    const entries = verified.get(id) ?? new Map<Identifier, string>();
    entries.set(stage.intentionId, stage.reviewHash);
    verified.set(id, entries);
  };
  let disposed = false,
    flushing = false,
    templateEpoch = 0,
    templateAbort: AbortController | null = null;
  let state: PlansState = {
    drafts: [],
    selectedId: null,
    templates: [],
    templateRevision: null,
    nextTemplateOffset: null,
    templateScope: null,
    templateBusy: false,
    templateIssue: null,
    templatePreview: null,
    issue: null,
    unexpected: null,
  };
  const publish = (patch: Partial<PlansState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const get = (id: Identifier) => state.drafts.find((d) => d.id === id);
  async function confirmCapture(
    capture: { readonly connection: ConnectionProfile },
    signal?: AbortSignal,
  ) {
    if (signal?.aborted)
      throw new DOMException("Obsolete profile confirmation cancelled.", "AbortError");
    const actual = unwrap(
      await http.request({
        path: `/connections/${encodeURIComponent(capture.connection.id)}/generations/${encodeURIComponent(capture.connection.generation)}`,
        method: "GET",
        codec: d.connectionProfile,
        ...(signal === undefined ? {} : { signal }),
      }),
    );
    if (signal?.aborted)
      throw new DOMException("Obsolete profile confirmation cancelled.", "AbortError");
    if (
      actual.id !== capture.connection.id ||
      actual.generation !== capture.connection.generation ||
      actual.socket !== capture.connection.socket
    )
      throw new PlanInputError(
        "This retained connection ID/generation belongs to a different socket in this companion root. The draft was not retargeted; use its original companion or create a new draft explicitly.",
      );
  }
  const update = (id: Identifier, patch: Partial<PlanDraft>, save = true) => {
    const old = get(id);
    if (old === undefined || disposed) return;
    const draft = Object.freeze({ ...old, ...patch });
    const intentions = new Set(draft.frozen.map((stage) => stage.intentionId));
    for (const known of [verified.get(id), reviewed.get(id)])
      if (known !== undefined)
        for (const intention of known.keys())
          if (!intentions.has(intention)) known.delete(intention);
    publish({ drafts: state.drafts.map((d) => (d.id === id ? draft : d)) });
    if (save) {
      queueStorage(id, draft);
    }
  };
  function failure(id: Identifier | null, error: unknown) {
    if (disposed || (error instanceof DOMException && error.name === "AbortError")) return;
    const patch =
      error instanceof PlanInputError || error instanceof DOMException
        ? { issue: error.message }
        : { unexpected: { error } };
    if (id === null) publish(patch);
    else update(id, { ...patch, active: null }, false);
  }
  function queueStorage(id: Identifier, draft: PlanDraft | null) {
    const token = {};
    storageTokens.set(id, token);
    pendingStorage.set(id, { draft, token });
    flush();
  }
  function flush() {
    if (flushing || disposed) return;
    flushing = true;
    void (async () => {
      try {
        while (!disposed && pendingStorage.size > 0) {
          const entry = pendingStorage.entries().next().value;
          if (entry === undefined) break;
          const [id, { draft, token }] = entry;
          pendingStorage.delete(id);
          try {
            if (draft === null) {
              await storage.remove(id);
              continue;
            }
            const source = await encodeContainer(http.processing, draft);
            if (disposed) break;
            if (storageTokens.get(id) !== token) continue;
            await storage.put(id, source);
            if (storageTokens.get(id) === token)
              update(id, { persisted: "saved", persistenceFailure: null }, false);
          } catch (error) {
            if (draft !== null && storageTokens.get(id) === token) {
              // Persistence owns neither the active task nor its issue/error state.
              update(
                id,
                {
                  persisted: "unavailable",
                  persistenceFailure: { revision: draft.revision, error },
                },
                false,
              );
            } else if (draft === null && storageTokens.get(id) === token) {
              failure(
                null,
                error instanceof DOMException || error instanceof PlanInputError
                  ? new PlanInputError(
                      `Local draft ${id} could not be removed from recovery storage: ${error.message}. It may return after reload; reopen and close it again to retry deletion.`,
                    )
                  : error,
              );
            } else if (!(error instanceof PlanInputError) && !(error instanceof DOMException)) {
              // Unexpected stale failures remain observable without altering draft tasks.
              failure(null, error);
            }
          } finally {
            if (storageTokens.get(id) === token) storageTokens.delete(id);
          }
        }
      } finally {
        flushing = false;
      }
    })().catch((error) => {
      flushing = false;
      failure(null, error);
    });
  }
  function bytes(draft: PlanDraft): number {
    return (
      draft.sourceBytes +
      draft.snapshots.reduce((n, s) => n + (s.source === draft.source ? 0 : s.sourceBytes), 0)
    );
  }
  function admit(source: string, except?: Identifier, extra = 0): number {
    if (invalidScalarOffset(source) !== undefined)
      throw new PlanInputError(
        "Editing source must contain complete Unicode scalar values; the previous text was retained.",
      );
    const count = new TextEncoder().encode(source).byteLength;
    if (count > PLAN_LIMITS.sourceBytes)
      throw new PlanInputError(
        "Plan source exceeds4MiB. Keep explicit smaller stages/documents; an atomic template instance is never split automatically.",
      );
    const total =
      state.drafts.filter((d) => d.id !== except).reduce((n, d) => n + bytes(d), 0) + count + extra;
    if (total > PLAN_LIMITS.totalBytes)
      throw new PlanInputError(
        "The16MiB retained plan editing budget is full. Export and close old drafts without deleting native journals.",
      );
    return count;
  }
  function ensureRecovery(draft: PlanDraft) {
    let bound =
      65536 +
      6 * draft.sourceBytes +
      draft.snapshots.reduce((n, s) => n + 2 * s.sourceBytes + 4096, 0);
    for (const stage of draft.frozen) {
      const weight = recoveryWeights.get(stage.sourceStage);
      if (weight === undefined)
        throw new PlanInputError("Frozen stage recovery size is not verified.");
      bound += weight + 4096;
    }
    if (bound > DRAFT_CONTAINER_LIMITS.bytes)
      throw new PlanInputError(
        "The64MiB recoverable container budget is full. Export/close an older editor or revise an unstarted stage; registered-stage evidence was retained.",
      );
  }
  function allocate(capture: PlanCapture, source: string, id = checkedId(newId())): Identifier {
    if (state.drafts.length >= PLAN_LIMITS.drafts)
      throw new PlanInputError(
        "At most32 drafts are open. Export/close an old editor; native operation journals remain retained.",
      );
    if (get(id) !== undefined)
      throw new PlanInputError(
        "This draft identity is already open; importing never overwrites it.",
      );
    const draft: PlanDraft = {
      id,
      capture,
      source,
      sourceBytes: admit(source),
      revision: 1,
      parsedRevision: null,
      structuredRevision: null,
      document: null,
      templateSpec: null,
      templateSpecRevision: null,
      frozen: [],
      snapshots: [],
      active: null,
      issue: null,
      unexpected: null,
      persisted: "pending",
      persistenceFailure: null,
    };
    ensureRecovery(draft);
    publish({ drafts: [...state.drafts, draft], selectedId: id, issue: null });
    queueStorage(id, draft);
    return id;
  }
  function begin(id: Identifier, kind: PlanTask) {
    const draft = get(id);
    if (draft === undefined || draft.active === "preparing") return null;
    jobs.get(id)?.abort.abort();
    const job = { token: {}, abort: new AbortController() };
    jobs.set(id, job);
    update(id, { active: kind, issue: null, unexpected: null }, false);
    return {
      draft,
      signal: job.abort.signal,
      current: () =>
        !disposed && jobs.get(id)?.token === job.token && get(id)?.revision === draft.revision,
    };
  }
  function registered(f: FrozenStage) {
    return (
      f.captured ||
      f.prepared ||
      f.operationId !== null ||
      operations.get(f.intentionId) !== undefined
    );
  }
  async function verifyPrefix(draft: PlanDraft, document: PlanDocument, signal?: AbortSignal) {
    for (const frozen of draft.frozen.filter(registered)) {
      const stage = document.stages[frozen.stageIndex];
      if (
        stage?.id !== frozen.stageId ||
        (await encodeValue(http.processing, stageJson(stage), signal)) !==
          (await encodeValue(http.processing, frozen.sourceStage, signal))
      )
        throw new PlanInputError(
          "A captured/saved batch is immutable. Keep its exact stage and order; edit only unstarted later stages or create a separate draft.",
        );
    }
  }
  function edit(id: Identifier, source: string) {
    try {
      const draft = get(id);
      if (draft === undefined) return;
      if (draft.active === "preparing") {
        update(id, { issue: "Wait for the captured preparation result before editing." }, false);
        return;
      }
      if (draft.revision >= 1_000_000_000)
        throw new PlanInputError(
          "This draft reached its local revision bound. Export it and copy into a new draft before further editing.",
        );
      const frozen = draft.frozen.filter(registered),
        revisions = new Set(frozen.map((f) => f.sourceRevision)),
        snapshots = draft.snapshots.filter((s) => revisions.has(s.revision));
      const retained = snapshots.reduce((n, s) => n + (s.source === source ? 0 : s.sourceBytes), 0);
      const sourceBytes = admit(source, id, retained);
      ensureRecovery({ ...draft, source, sourceBytes, frozen, snapshots });
      jobs.get(id)?.abort.abort();
      jobs.delete(id);
      update(id, {
        source,
        sourceBytes,
        revision: draft.revision + 1,
        parsedRevision: null,
        structuredRevision: null,
        active: null,
        issue: null,
        persisted: "pending",
        frozen,
        snapshots,
      });
    } catch (error) {
      failure(id, error);
    }
  }
  async function replaceDocument(id: Identifier, document: PlanDocument) {
    const job = begin(id, "parsing");
    if (job === null) return;
    try {
      update(id, { document, parsedRevision: null }, false);
      const sourceOp = templateSourceOperation(document);
      if (
        sourceOp !== null &&
        job.draft.templateSpec !== null &&
        job.draft.templateSpecRevision === job.draft.revision
      ) {
        const specSource = await encodeValue(http.processing, job.draft.templateSpec, job.signal);
        document = {
          ...document,
          stages: document.stages.map((stage) => ({
            ...stage,
            operations: [
              { ...sourceOp, params: setField(sourceOp.params, "text", d.jsonString(specSource)) },
            ],
          })),
        };
      }
      const source = await encodeValue(http.processing, planJson(document), job.signal);
      if (!job.current()) return;
      edit(id, source);
      await parse(id);
    } catch (error) {
      if (job.current()) failure(id, error);
    }
  }
  async function parse(id: Identifier) {
    const job = begin(id, "parsing");
    if (job === null) return;
    try {
      const document = decodePlanShape(
        await parseSource(http.processing, job.draft.source, job.signal),
      );
      if (!job.current()) return;
      update(id, { document, structuredRevision: job.draft.revision, parsedRevision: null }, false);
      const sourceOp = templateSourceOperation(document);
      if (sourceOp !== null) {
        const spec = await parseSource(
          http.processing,
          text(jsonField(sourceOp.params, "text")),
          job.signal,
        );
        if (spec.kind !== "object")
          throw new PlanInputError("Template source must contain a Spec object.");
        if (!job.current()) return;
        update(id, { templateSpec: spec, templateSpecRevision: job.draft.revision }, false);
      } else update(id, { templateSpec: null, templateSpecRevision: null }, false);
      validatePlan(document);
      await verifyPrefix(job.draft, document, job.signal);
      if (job.current()) {
        const retained = job.draft.frozen.filter(registered),
          revisions = new Set(retained.map((f) => f.sourceRevision));
        update(id, {
          document,
          parsedRevision: job.draft.revision,
          active: null,
          issue: null,
          frozen: retained,
          snapshots: job.draft.snapshots.filter((s) => revisions.has(s.revision)),
        });
      }
    } catch (error) {
      if (job.current()) failure(id, error);
    }
  }
  function receipts(draft: PlanDraft) {
    return draft.frozen.flatMap((stage) => {
      if (verified.get(draft.id)?.get(stage.intentionId) !== stage.reviewHash) return [];
      const operation = operations.get(stage.intentionId)?.operation;
      return operation === undefined || operation === null ? [] : [{ stage, operation }];
    });
  }
  async function instancePreview(
    capture: PlanCapture,
    pin: TemplatePin,
    params: JsonObject,
    signal?: AbortSignal,
  ) {
    await confirmCapture(capture, signal);
    const scoped = withScope(capture, params),
      expected = d.jsonObject([
        ...scoped.fields.map((f) => [f.name, f.value] as const),
        ["expected_digest", d.jsonString(pin.digest)],
      ]);
    const result = unwrap(
      await http.request({
        path: "/template-instances/preview",
        method: "POST",
        body: helperBody(capture, expected),
        codec: templatePreviewCodec,
        ...(signal === undefined ? {} : { signal }),
      }),
    );
    if (
      result.template.id !== pin.id ||
      result.template.version !== pin.version ||
      result.template.digest !== pin.digest ||
      (await encodeValue(http.processing, result.request.params, signal)) !==
        (await encodeValue(http.processing, scoped, signal))
    )
      throw new PlanInputError(
        "Native instance preview differs from the complete captured template pin/input.",
      );
    return result;
  }
  async function instanceEffects(
    capture: PlanCapture,
    stage: PlanDocument["stages"][number],
    ops: readonly import("./types").PlanOperation[],
    signal: AbortSignal,
  ) {
    const result = new Map<number, InstanceExposurePreview>();
    for (const exposure of stage.exposures) {
      const op = ops[exposure.operation];
      if (op?.method !== "template.instantiate") continue;
      const id = jsonField(op.params, "template_id"),
        version = jsonField(op.params, "template_revision");
      if (id?.kind !== "string" || version?.kind !== "string" || exposure.templateDigest === null)
        throw new PlanInputError("A complete exact template pin is required.");
      const read = unwrap(
        await companion.read(
          {
            connection_id: capture.connection.id,
            generation: capture.connection.generation,
            method: "template.get",
            lane: "visible",
            params: d.jsonObject([
              ["workspace_id", d.jsonString(capture.context.workspace_id)],
              ["template_id", id],
              ["template_revision", version],
              ["max_bytes", d.jsonString("1048576")],
            ]),
          },
          signal,
        ),
      );
      const decoded = templateCodec.decode(read.response.data);
      if (!decoded.ok)
        throw new PlanInputError("Template capture is not a complete current public record.");
      const pin = decoded.value;
      if (
        pin.id !== id.value ||
        pin.version !== version.value ||
        pin.digest !== exposure.templateDigest
      )
        throw new PlanInputError("Template capture differs from the exact declared pin.");
      const aliasPlacement = ["project_id", "milestone_id", "parent_ticket_id"].some((name) => {
        const v = jsonField(op.params, name);
        return v?.kind === "string" && v.value.startsWith("$");
      });
      if (aliasPlacement) {
        if (exposure.disposition === "held")
          throw new PlanInputError(
            "Held instance verification needs literal placement. Create placement in an earlier explicit stage, then bind its committed receipt. Same-batch aliases remain supported by native runnable-intent preflight; no provisional IDs are substituted.",
          );
        result.set(exposure.operation, { input: op.params, mode: "native-alias", tickets: [] });
        continue;
      }
      const preview = await instancePreview(capture, pin, op.params, signal),
        tickets = jsonField(preview.instance, "tickets");
      if (tickets?.kind !== "array")
        throw new PlanInputError("Native instance preview omitted its complete ticket list.");
      const ids = tickets.items.map((t) => {
        const field = jsonField(t, "ticket_id"),
          id = d.identifier.decode(field);
        if (!id.ok)
          throw new PlanInputError("Native instance preview has an invalid ticket identity.");
        return id.value;
      });
      result.set(exposure.operation, { input: op.params, mode: "literal", tickets: ids });
    }
    return result;
  }
  async function preview(id: Identifier, stageId: string, baseRevision?: Decimal) {
    const job = begin(id, "preflight");
    if (job === null) return;
    try {
      const draft = job.draft,
        document = draft.document;
      if (document === null || draft.parsedRevision !== draft.revision)
        throw new PlanInputError("Validate the current editing source before reviewing a stage.");
      const stageIndex = document.stages.findIndex((s) => s.id === stageId),
        stage = document.stages[stageIndex];
      if (stage === undefined) throw new PlanInputError("Select an existing stage.");
      await confirmCapture(draft.capture, job.signal);
      if (!job.current()) return;
      if (draft.frozen.some((f) => f.stageId === stageId && registered(f)))
        throw new PlanInputError(
          "This stage already has a captured intention. Inspect its exact operation; never silently rebase it.",
        );
      const ops = materializeStage(document, stageId, receipts(draft)),
        effects = await instanceEffects(draft.capture, stage, ops, job.signal);
      validateExposure(stage, ops, effects);
      const params = stageParams(draft.capture, ops),
        preflightParams = d.jsonObject([
          ...params.fields.map((f) => [f.name, f.value] as const),
          ...(baseRevision === undefined
            ? []
            : [["at_revision", d.jsonString(baseRevision)] as const]),
        ]);
      const read = unwrap(
        await companion.read(
          {
            connection_id: draft.capture.connection.id,
            generation: draft.capture.connection.generation,
            method: "transaction.preflight",
            lane: "visible",
            params: preflightParams,
          },
          job.signal,
        ),
      );
      const decoded = preflightCodec.decode(read.response.data);
      if (!decoded.ok)
        throw new PlanInputError(
          `Native preflight: ${decoded.issue.path.join(".")} expected ${decoded.issue.expected}.`,
        );
      if (BigInt(decoded.value.expandedOperationCount) < BigInt(ops.length))
        throw new PlanInputError(
          "Native expanded count is smaller than the captured source batch.",
        );
      const hash = await hashValue(
        http.processing,
        "plan",
        d.jsonObject([
          ["capture", captureJson(draft.capture)],
          ["document", planJson(document)],
        ]),
        job.signal,
      );
      const reviewHash = await hashValue(
        http.processing,
        "review",
        d.jsonObject([
          ["plan_hash", d.jsonString(hash)],
          ["stage_id", d.jsonString(stageId)],
          ["params", params],
          ["preflight", decoded.value.raw],
        ]),
        job.signal,
      );
      if (!job.current()) return;
      const frozen: FrozenStage = {
        stageId,
        sourceRevision: draft.revision,
        stageIndex,
        sourceStage: stageJson(stage),
        hash,
        reviewHash,
        params,
        preview: decoded.value,
        intentionId: checkedId(newId()),
        prepared: false,
        captured: false,
        operationId: null,
        requestHash: null,
        preparationHash: null,
      };
      const retained = [...draft.frozen.filter((f) => f.stageId !== stageId), frozen],
        revisions = new Set(retained.map((f) => f.sourceRevision));
      const priorSnapshots = draft.snapshots.filter((s) => revisions.has(s.revision));
      const snapshots = priorSnapshots.some((s) => s.revision === draft.revision)
        ? priorSnapshots
        : [
            ...priorSnapshots,
            {
              revision: draft.revision,
              source: draft.source,
              sourceBytes: draft.sourceBytes,
              hash,
            },
          ];
      recoveryWeights.set(frozen.sourceStage, await stageFrameBytes(http.processing, frozen));
      if (!job.current()) return;
      ensureRecovery({ ...draft, frozen: retained, snapshots });
      update(id, {
        active: null,
        frozen: retained,
        snapshots,
        issue: null,
      });
      const reviews = reviewed.get(id) ?? new Map<Identifier, string>();
      reviews.set(frozen.intentionId, frozen.reviewHash);
      reviewed.set(id, reviews);
    } catch (error) {
      if (job.current()) failure(id, error);
    }
  }
  function preparation(draft: PlanDraft, stage: FrozenStage): Preparation {
    return {
      intention_id: stage.intentionId,
      context: draft.capture.context,
      connection_id: draft.capture.connection.id,
      generation: draft.capture.connection.generation,
      method: "transaction.apply",
      params: stage.params,
    };
  }
  async function verifyDerivation(draft: PlanDraft, stage: FrozenStage) {
    const snapshot = draft.snapshots.find((s) => s.revision === stage.sourceRevision);
    if (snapshot === undefined)
      throw new PlanInputError("Saved stage has no exact source snapshot.");
    const document = decodePlan(await parseSource(http.processing, snapshot.source));
    const materialized = materializeStage(document, stage.stageId, receipts(draft));
    if (
      (await encodeValue(http.processing, stageParams(draft.capture, materialized))) !==
      (await encodeValue(http.processing, stage.params))
    )
      throw new PlanInputError(
        "Saved stage parameters do not derive from its exact source and verified preceding durable receipts. Restore exact saved operations before using later-stage bindings.",
      );
  }
  async function prepare(id: Identifier, stageId: string) {
    const job = begin(id, "preparing");
    if (job === null) return;
    try {
      const stage = job.draft.frozen.find((f) => f.stageId === stageId);
      if (stage === undefined)
        throw new PlanInputError("Review this stage with native preflight first.");
      if (!registered(stage) && stage.sourceRevision !== job.draft.revision)
        throw new PlanInputError("Source changed after this preview; review again.");
      if (
        reviewed.get(id)?.get(stage.intentionId) !== stage.reviewHash &&
        verified.get(id)?.get(stage.intentionId) !== stage.reviewHash
      )
        throw new PlanInputError(
          "Imported/restored previews are retained data. Run native preview again for an unstarted batch, or Restore the exact saved operation before resuming a captured batch.",
        );
      await verifyDerivation(job.draft, stage);
      if (!job.current()) return;
      await confirmCapture(job.draft.capture, job.signal);
      if (!job.current()) return;
      update(id, {
        frozen: get(id)!.frozen.map((f) => (f.stageId === stageId ? { ...f, captured: true } : f)),
      });
      const admitted = await operations.register(preparation(job.draft, stage));
      if (!admitted.ok) {
        if (job.current() && operations.get(stage.intentionId) === undefined)
          update(id, {
            frozen: get(id)!.frozen.map((f) =>
              f.stageId === stageId ? { ...f, captured: false } : f,
            ),
          });
        unwrap(admitted);
        return;
      }
      if (!job.current()) return;
      const saved = await operations.act(stage.intentionId, "prepare");
      if (!job.current()) return;
      if (!saved.ok) {
        unwrap(saved);
        return;
      }
      const operation = saved.entry.operation;
      const requestHash =
        operation === null ? null : await hashValue(http.processing, "journal", operation.request);
      if (!job.current()) return;
      if (operation !== null) markVerified(id, stage);
      update(id, {
        active: null,
        frozen: get(id)!.frozen.map((f) =>
          f.stageId === stageId
            ? {
                ...f,
                prepared: operation !== null,
                operationId: operation?.operation_id ?? null,
                requestHash,
                preparationHash: operation?.preparation_input_hash ?? null,
              }
            : f,
        ),
      });
    } catch (error) {
      if (job.current()) failure(id, error);
    }
  }
  async function adoptForDraft(draft: PlanDraft, stage: FrozenStage, operation: Operation) {
    await verifyDerivation(draft, stage);
    // Full canonical complete preparation equality, not stage ID matching.
    const expected = preparation(draft, stage),
      actual = operation.preparation;
    if (
      stage.operationId !== operation.operation_id ||
      (stage.preparationHash !== null &&
        stage.preparationHash !== operation.preparation_input_hash) ||
      (stage.requestHash !== null &&
        stage.requestHash !== (await hashValue(http.processing, "journal", operation.request))) ||
      actual.intention_id !== expected.intention_id ||
      actual.connection.id !== draft.capture.connection.id ||
      actual.connection.generation !== draft.capture.connection.generation ||
      actual.connection.socket !== draft.capture.connection.socket ||
      actual.method !== "transaction.apply" ||
      (await encodeValue(http.processing, actual.params)) !==
        (await encodeValue(http.processing, expected.params)) ||
      (await encodeValue(
        http.processing,
        captureJson({
          connection: actual.connection,
          context: {
            ...actual.context,
            workspace_id: checkedId(actual.context.workspace_id ?? ""),
          },
        }),
      )) !== (await encodeValue(http.processing, captureJson(draft.capture)))
    )
      throw new PlanInputError(
        "Saved journal does not match this exact captured draft/intention. It was not adopted.",
      );
    const adopted = await operations.adopt(operation);
    if (!adopted.ok) unwrap(adopted);
    markVerified(draft.id, stage);
  }
  async function restoreOperations(id: Identifier) {
    const job = begin(id, "restoring");
    if (job === null) return;
    try {
      await confirmCapture(job.draft.capture, job.signal);
      if (!job.current()) return;
      for (const stage of [...job.draft.frozen].sort((a, b) => a.stageIndex - b.stageIndex)) {
        if (stage.operationId === null) continue;
        const operation = unwrap(await companion.inspect(stage.operationId, job.signal));
        if (!job.current()) return;
        await adoptForDraft(job.draft, stage, operation);
      }
      if (job.current()) update(id, { active: null, issue: null });
    } catch (error) {
      if (job.current()) failure(id, error);
    }
  }
  async function loadTemplates(context: FeatureContext, more = false) {
    const epoch = ++templateEpoch;
    templateAbort?.abort();
    const abort = new AbortController();
    templateAbort = abort;
    try {
      const capture = readScope(context),
        scope = JSON.stringify([
          capture.connection.id,
          capture.connection.generation,
          capture.context.workspace_id,
        ]);
      if (
        more &&
        (scope !== state.templateScope ||
          state.nextTemplateOffset === null ||
          state.templateRevision === null)
      )
        throw new PlanInputError(
          "Restart template browsing on this exact scope before continuing.",
        );
      const offset = more ? state.nextTemplateOffset : null,
        revision = more ? state.templateRevision : null;
      await confirmCapture(capture, abort.signal);
      if (disposed || epoch !== templateEpoch || abort.signal.aborted) return;
      publish({
        templateScope: scope,
        templateBusy: true,
        templateIssue: null,
        ...(more || scope === state.templateScope
          ? {}
          : { templates: [], templateRevision: null, nextTemplateOffset: null }),
      });
      const read = unwrap(
        await companion.read(
          {
            connection_id: capture.connection.id,
            generation: capture.connection.generation,
            method: "template.list",
            lane: "visible",
            params: d.jsonObject([
              ["workspace_id", d.jsonString(capture.context.workspace_id)],
              ["limit", d.jsonString("100")],
              ["max_bytes", d.jsonString("1048576")],
              ...(offset === null ? [] : [["offset", d.jsonString(offset)] as const]),
              ...(revision === null
                ? []
                : [["expected_revision", d.jsonString(revision)] as const]),
            ]),
          },
          abort.signal,
        ),
      );
      const data = listingCodec.decode(read.response.data),
        actual = d.decimal.decode(jsonField(read.response.meta, "query_revision"));
      if (!data.ok || !actual.ok || (revision !== null && actual.value !== revision))
        throw new PlanInputError(
          "Template page schema or policy capture changed. Restart browsing; pages were not merged.",
        );
      if (disposed || epoch !== templateEpoch) return;
      const items = more ? [...state.templates, ...data.value.items] : data.value.items;
      if (items.length > 1000)
        throw new PlanInputError(
          "Template browser capture holds1000 records. Narrow or restart this bounded inventory.",
        );
      publish({
        templates: items,
        templateRevision: actual.value,
        nextTemplateOffset: data.value.next_offset,
        templateBusy: false,
      });
    } catch (error) {
      if (!disposed && epoch === templateEpoch) {
        publish({
          templateBusy: false,
          templateIssue: error instanceof PlanInputError ? error.message : null,
        });
        if (!(error instanceof PlanInputError)) failure(null, error);
      }
    }
  }
  async function previewTemplate(context: FeatureContext, pin: TemplatePin, params: JsonObject) {
    const epoch = ++templateEpoch;
    templateAbort?.abort();
    const abort = new AbortController();
    templateAbort = abort;
    try {
      const capture = nativeScope(context);
      publish({ templateBusy: true, templateIssue: null });
      const value = await instancePreview(capture, pin, params, abort.signal);
      if (!disposed && epoch === templateEpoch)
        publish({ templatePreview: { capture, value }, templateBusy: false });
    } catch (error) {
      if (!disposed && epoch === templateEpoch) {
        publish({
          templateBusy: false,
          templateIssue: error instanceof PlanInputError ? error.message : null,
        });
        if (!(error instanceof PlanInputError)) failure(null, error);
      }
    }
  }
  async function sourceFor(document: PlanDocument) {
    return encodeValue(http.processing, planJson(document));
  }
  async function publicationDocument(
    capture: PlanCapture,
    params: JsonObject,
    signal?: AbortSignal,
  ) {
    const scoped = withScope(capture, params);
    await confirmCapture(capture, signal);
    const result = unwrap(
      await http.request({
        path: "/template-publications/prepare",
        method: "POST",
        body: helperBody(capture, scoped),
        codec: requestCodec,
        ...(signal === undefined ? {} : { signal }),
      }),
    );
    const workspace = jsonField(result.params, "workspace_id"),
      actor = jsonField(result.params, "actor_id"),
      run = jsonField(result.params, "run_id");
    if (
      workspace?.kind !== "string" ||
      workspace.value !== capture.context.workspace_id ||
      actor?.kind !== "string" ||
      actor.value !== capture.context.writer.actor_id ||
      (capture.context.writer.run_id === null
        ? run !== undefined
        : run?.kind !== "string" || run.value !== capture.context.writer.run_id)
    )
      throw new PlanInputError(
        "Native publication capture differs from its original scope/writer.",
      );
    const ops = jsonField(result.params, "operations");
    if (ops?.kind !== "array")
      throw new PlanInputError("Native publication omitted its transaction operations.");
    const values = ops.items.map((value) => {
      const r = c.record({ method: c.text, params: c.object }).decode(value);
      if (!r.ok) throw new PlanInputError("Native publication returned an invalid operation.");
      return { ...r.value, alias: null };
    });
    const document: PlanDocument = {
      format: "workgraph-ui-plan-1",
      title: "Publish template",
      stages: [
        {
          id: "publication",
          title: "Publish canonical template and registration",
          operations: values,
          bindings: [],
          exposure: "Atomic canonical content publication plus exact native template registration.",
          exposures: [],
        },
      ],
    };
    return document;
  }
  async function publishTemplate(context: FeatureContext, params: JsonObject) {
    try {
      const capture = nativeScope(context),
        document = await publicationDocument(capture, params);
      const id = allocate(capture, await sourceFor(document));
      await parse(id);
      return id;
    } catch (error) {
      failure(null, error);
      return null;
    }
  }
  async function createTemplateSource(context: FeatureContext) {
    try {
      const capture = nativeScope(context),
        spec = await encodeValue(http.processing, initialTemplateSpec());
      const id = allocate(capture, await sourceFor(templateSourceDocument(spec)));
      await parse(id);
      return id;
    } catch (error) {
      failure(null, error);
      return null;
    }
  }
  async function createInstance(context: FeatureContext, pin: TemplatePin) {
    try {
      const capture = nativeScope(context),
        document = instanceDocument(pin, capture.context.project_id);
      const id = allocate(capture, await sourceFor(document));
      await parse(id);
      return id;
    } catch (error) {
      failure(null, error);
      return null;
    }
  }
  async function replaceTemplateSpec(id: Identifier, spec: JsonObject) {
    const draft = get(id);
    if (draft?.document === null || draft === undefined || draft.active === "preparing") return;
    update(id, { templateSpec: spec, templateSpecRevision: draft.revision }, false);
    await replaceDocument(id, draft.document);
  }
  async function canonicalizeTemplate(id: Identifier) {
    const job = begin(id, "template");
    if (job === null) return null;
    try {
      const op = templateSourceOperation(job.draft.document);
      if (op === null || job.draft.parsedRevision !== job.draft.revision)
        throw new PlanInputError(
          "Parse the current template source before building a publication draft.",
        );
      const spec = await parseSource(
        http.processing,
        text(jsonField(op.params, "text")),
        job.signal,
      );
      if (spec.kind !== "object") throw new PlanInputError("Template Spec must be an object.");
      const params = d.jsonObject([
        ["template_id", jsonField(op.params, "resource_id") ?? d.jsonString("")],
        ["expected_revision", jsonField(op.params, "expected_revision") ?? d.jsonString("")],
        ["title", jsonField(op.params, "title") ?? d.jsonString("")],
        ["spec", spec],
      ]);
      const document = await publicationDocument(job.draft.capture, params, job.signal),
        source = await sourceFor(document);
      if (!job.current()) return null;
      update(id, { active: null }, false);
      const created = allocate(job.draft.capture, source);
      await parse(created);
      return created;
    } catch (error) {
      if (job.current()) failure(id, error);
      return null;
    }
  }
  async function draftFromTemplatePreview() {
    try {
      const current = state.templatePreview;
      if (current === null) throw new PlanInputError("Review exact instance inputs first.");
      const { capture, value } = current,
        params = d.jsonObject(
          value.request.params.fields
            .filter((f) => !["workspace_id", "actor_id", "run_id", "mutation_id"].includes(f.name))
            .map((f) => [f.name, f.value] as const),
        );
      const document: PlanDocument = {
        format: "workgraph-ui-plan-1",
        title: "Instantiate workflow template",
        stages: [
          {
            id: "instance",
            title: "Atomic native template instance",
            operations: [{ method: "template.instantiate", params, alias: null }],
            bindings: [],
            exposure:
              "Declared runnable intent for the complete native instance and its native gates; readiness remains native.",
            exposures: [
              {
                operation: 0,
                disposition: "runnable",
                deferred: "",
                templateDigest: value.template.digest,
              },
            ],
          },
        ],
      };
      const id = allocate(capture, await sourceFor(document));
      await parse(id);
      return id;
    } catch (error) {
      failure(null, error);
      return null;
    }
  }
  async function decodeStored(source: string): Promise<PlanDraft> {
    const value = await decodeContainer(http.processing, source),
      sourceBytes = admit(value.source);
    for (const snapshot of value.snapshots) {
      const document = decodePlan(await parseSource(http.processing, snapshot.source));
      const hash = await hashValue(
        http.processing,
        "plan",
        d.jsonObject([
          ["capture", captureJson(value.capture)],
          ["document", planJson(document)],
        ]),
      );
      if (
        hash !== snapshot.hash ||
        new TextEncoder().encode(snapshot.source).byteLength !== snapshot.sourceBytes
      )
        throw new PlanInputError(
          "Imported plan snapshot hash/bytes differ; saved identities were not adopted.",
        );
    }
    for (const stage of value.frozen) {
      const snapshot = value.snapshots.find((s) => s.revision === stage.sourceRevision);
      if (snapshot === undefined || !storedStageMatches(stage))
        throw new PlanInputError("Frozen stage has no exact source snapshot.");
      const document = decodePlan(await parseSource(http.processing, snapshot.source)),
        original = document.stages[stage.stageIndex];
      if (
        original === undefined ||
        (await encodeValue(http.processing, stageJson(original))) !==
          (await encodeValue(http.processing, stage.sourceStage)) ||
        (await hashValue(
          http.processing,
          "review",
          d.jsonObject([
            ["plan_hash", d.jsonString(stage.hash)],
            ["stage_id", d.jsonString(stage.stageId)],
            ["params", stage.params],
            ["preflight", stage.preview.raw],
          ]),
        )) !== stage.reviewHash
      )
        throw new PlanInputError(
          "Frozen stage source or review hash differs; journal binding rejected.",
        );
      recoveryWeights.set(stage.sourceStage, await stageFrameBytes(http.processing, stage));
    }
    const extra = value.snapshots.reduce(
      (n, s) => n + (s.source === value.source ? 0 : s.sourceBytes),
      0,
    );
    admit(value.source, undefined, extra);
    const draft: PlanDraft = {
      ...value,
      sourceBytes,
      parsedRevision: null,
      structuredRevision: null,
      document: null,
      templateSpec: null,
      templateSpecRevision: null,
      active: null,
      issue: null,
      unexpected: null,
      persisted: "saved",
      persistenceFailure: null,
    };
    ensureRecovery(draft);
    return draft;
  }
  async function importDraft(source: string) {
    try {
      const draft = await decodeStored(source);
      if (disposed) return null;
      if (get(draft.id) !== undefined)
        throw new PlanInputError(
          "This draft identity is already open; import never overwrites a captured intention.",
        );
      if (state.drafts.length >= PLAN_LIMITS.drafts)
        throw new PlanInputError("Close an old editor before importing another draft.");
      // Admission may have changed while decoding/hashing the imported frames.
      admit(draft.source, undefined, bytes(draft) - draft.sourceBytes);
      publish({ drafts: [...state.drafts, draft], selectedId: draft.id });
      queueStorage(draft.id, draft);
      await parse(draft.id);
      return draft.id;
    } catch (error) {
      failure(null, error);
      return null;
    }
  }
  const unsubscribe = operations.subscribe(() => {
    for (const draft of state.drafts) {
      let changed = false;
      const frozen = draft.frozen.map((f) => {
        const op = operations.get(f.intentionId)?.operation;
        if (op === undefined || op === null || (f.operationId === op.operation_id && f.prepared))
          return f;
        changed = true;
        return { ...f, operationId: op.operation_id, prepared: true };
      });
      if (changed) update(draft.id, { frozen });
    }
  });
  void (async () => {
    try {
      for (const source of await storage.load()) {
        if (disposed) return;
        await importDraft(source);
      }
    } catch (error) {
      failure(null, error);
    }
  })().catch((error) => failure(null, error));
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    create(context, source) {
      try {
        const capture = nativeScope(context);
        if (source !== undefined) return allocate(capture, source);
        const id = allocate(capture, "");
        void sourceFor(emptyPlan(capture))
          .then((value) => {
            const draft = get(id);
            if (draft?.source === "" && draft.revision === 1) {
              update(id, { source: value, sourceBytes: admit(value, id) });
              return parse(id);
            }
          })
          .catch((error) => failure(id, error));
        return id;
      } catch (error) {
        failure(null, error);
        return null;
      }
    },
    select(id) {
      if (id === null || get(id) !== undefined) publish({ selectedId: id });
    },
    copy(id) {
      try {
        const draft = get(id);
        return draft === undefined ? null : allocate(draft.capture, draft.source);
      } catch (error) {
        failure(id, error);
        return null;
      }
    },
    edit,
    replaceDocument,
    replaceTemplateSpec,
    createTemplateSource,
    createInstance,
    canonicalizeTemplate,
    parse,
    preview,
    prepare,
    restoreOperations,
    loadTemplates,
    previewTemplate,
    publishTemplate,
    draftFromTemplatePreview,
    importDraft,
    async exportDraft(id) {
      try {
        const draft = get(id);
        return draft === undefined ? null : await encodeContainer(http.processing, draft);
      } catch (error) {
        failure(id, error);
        return null;
      }
    },
    remove(id) {
      const draft = get(id);
      if (draft === undefined) return;
      if (draft.active === "preparing") {
        update(id, { issue: "Wait for preparation to finish before removing this draft." }, false);
        return;
      }
      jobs.get(id)?.abort.abort();
      jobs.delete(id);
      verified.delete(id);
      reviewed.delete(id);
      publish({
        drafts: state.drafts.filter((d) => d.id !== id),
        selectedId: state.selectedId === id ? null : state.selectedId,
      });
      queueStorage(id, null);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      templateAbort?.abort();
      for (const job of jobs.values()) job.abort.abort();
      jobs.clear();
      verified.clear();
      reviewed.clear();
      pendingStorage.clear();
      storageTokens.clear();
      unsubscribe();
      storage.dispose();
      listeners.clear();
    },
  };
}
