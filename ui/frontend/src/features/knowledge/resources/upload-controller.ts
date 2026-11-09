import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import { preparationJson } from "../../../core/protocol/client";
import type { HttpClient, HttpResult } from "../../../core/protocol/http";
import type { Decimal, Identifier, Preparation } from "../../../core/protocol/types";
import { failureText } from "../../connections/failure";
import { ResourceInputError, validateResourceTextMetadata } from "./drafts";
import { hashUpload } from "./upload-digest";
import {
  jobPageCodec,
  stageCodec,
  stagePageCodec,
  uploadJobCodec,
  uploadPlanCodec,
} from "./upload-codecs";
import type {
  ResourceUploadController,
  ResourceUploadJob,
  UploadDraft,
  UploadState,
} from "./upload-types";
function identifier(value: string): Identifier {
  const result = d.identifier.decode(d.jsonString(value));
  if (!result.ok)
    throw new ResourceInputError(
      "Use an identifier of 1–96 ASCII letters, digits, underscore or hyphen.",
    );
  return result.value;
}
function decimal(value: string): Decimal {
  const result = d.decimal.decode(d.jsonString(value));
  if (!result.ok) throw new ResourceInputError("Invalid captured resource revision.");
  return result.value;
}
function unwrap<T>(result: HttpResult<T>): T {
  if (!result.ok) throw new ResourceInputError(failureText(result.failure));
  return result.data;
}
function base64(bytes: Uint8Array) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}
export function uploadPreparation(draft: UploadDraft): Preparation {
  const metadata = validateResourceTextMetadata(draft.input);
  return Object.freeze({
    intention_id: draft.id,
    connection_id: draft.scope.connection.id,
    generation: draft.scope.connection.generation,
    context: {
      workspace_id: draft.scope.workspaceId,
      project_id: draft.projectId,
      writer: { actor_id: draft.writer.actorId, run_id: draft.writer.runId },
    },
    method: "resource.upload",
    params: d.jsonObject([
      ["workspace_id", d.jsonString(draft.scope.workspaceId)],
      ["actor_id", d.jsonString(draft.writer.actorId)],
      ...(draft.writer.runId === null
        ? []
        : [["run_id", d.jsonString(draft.writer.runId)] as const]),
      ["resource_id", d.jsonString(identifier(draft.input.resourceId))],
      ["expected_revision", d.jsonString(draft.expectedRevision)],
      ["title", d.jsonString(metadata.title)],
      ["filename", d.jsonString(metadata.filename)],
      ["mime_type", d.jsonString(metadata.mimeType)],
      ...(draft.input.ticketId === ""
        ? []
        : [["ticket_id", d.jsonString(identifier(draft.input.ticketId))] as const]),
    ]),
  });
}
/** Launch-owned browser source/drafts; all durable mutation identities, retries,
 * cleanup capacity and receipts belong to the independent native helper. */
export function createResourceUploadController(
  http: HttpClient,
  ports: { readonly hash?: typeof hashUpload } = {},
): ResourceUploadController {
  let state: UploadState = {
      drafts: [],
      selectedId: null,
      stages: null,
      jobs: null,
      selectedJob: null,
      loading: false,
      issue: null,
      unexpected: null,
    },
    disposed = false,
    inventoryEpoch = 0,
    jobEpoch = 0;
  const listeners = new Set<() => void>(),
    staging = new Map<Identifier, AbortController>();
  const publish = (patch: Partial<UploadState>) => {
    if (disposed) return;
    state = Object.freeze({ ...state, ...patch });
    listeners.forEach((fn) => fn());
  };
  const get = (id: Identifier) => state.drafts.find((d) => d.id === id);
  const update = (id: Identifier, patch: Partial<UploadDraft>) =>
    publish({
      drafts: state.drafts.map((d) => (d.id === id ? Object.freeze({ ...d, ...patch }) : d)),
    });
  const report = (error: unknown, id?: Identifier) => {
    if (disposed) return;
    if (error instanceof ResourceInputError) {
      if (id) update(id, { issue: error.message });
      else publish({ issue: error.message });
    } else if (id) update(id, { unexpected: { error } });
    else publish({ unexpected: { error } });
  };
  function chooseJob(job: ResourceUploadJob) {
    const previous = state.selectedJob;
    if (
      previous?.intention_id === job.intention_id &&
      BigInt(previous.revision) > BigInt(job.revision)
    )
      return;
    publish({ selectedJob: job });
  }
  async function inspect(id: Identifier) {
    const epoch = ++jobEpoch;
    try {
      const job = unwrap(
        await http.request({
          method: "GET",
          path: `/resource-uploads/${encodeURIComponent(id)}`,
          codec: uploadJobCodec,
          responseBudget: "operation",
        }),
      );
      if (!disposed && epoch === jobEpoch) chooseJob(job);
    } catch (error) {
      if (!disposed && epoch === jobEpoch) report(error);
    }
  }
  return {
    observe: async (id, signal) => {
      const epoch = jobEpoch;
      const current = () =>
        !disposed &&
        !signal.aborted &&
        epoch === jobEpoch &&
        state.selectedJob?.intention_id === id;
      if (!current()) return;
      try {
        const job = unwrap(
          await http.request({
            method: "GET",
            path: `/resource-uploads/${encodeURIComponent(id)}`,
            codec: uploadJobCodec,
            responseBudget: "operation",
            signal,
          }),
        );
        if (current()) chooseJob(job);
      } catch (error) {
        if (current()) report(error);
      }
    },
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open: (context, scope, base) => {
      try {
        if (state.drafts.length >= 8)
          throw new ResourceInputError(
            "Close an upload editor before opening another (8 maximum).",
          );
        if (
          context.profileState !== "current" ||
          context.connection.id !== scope.connection.id ||
          context.connection.generation !== scope.connection.generation ||
          context.connection.socket !== scope.connection.socket ||
          context.route.workspaceId !== scope.workspaceId ||
          context.writer.actorId === null
        )
          throw new ResourceInputError(
            "Choose a current matching connection/workspace and acting actor before creating an upload.",
          );
        if (
          base &&
          (base.partial ||
            base.scope.connection.id !== scope.connection.id ||
            base.scope.connection.generation !== scope.connection.generation ||
            base.scope.connection.socket !== scope.connection.socket ||
            base.scope.workspaceId !== scope.workspaceId)
        )
          throw new ResourceInputError(
            "Complete matching metadata is required for a guarded binary replacement.",
          );
        const id = identifier(`upload-${crypto.randomUUID()}`),
          metadata = base?.value.metadata;
        const draft: UploadDraft = Object.freeze({
          id,
          stageId: identifier(`source-${crypto.randomUUID()}`),
          scope: Object.freeze({ ...scope, connection: Object.freeze({ ...scope.connection }) }),
          writer: Object.freeze({
            actorId: identifier(context.writer.actorId),
            runId: context.writer.runId === null ? null : identifier(context.writer.runId),
          }),
          projectId: context.route.projectId === null ? null : identifier(context.route.projectId),
          expectedRevision: base?.value.revision ?? decimal("0"),
          input: Object.freeze({
            resourceId: base?.value.resource_id ?? "",
            title: metadata?.title ?? "",
            filename: metadata?.filename ?? "artifact.bin",
            mimeType: metadata?.mime_type ?? "application/octet-stream",
            ticketId: "",
          }),
          file: null,
          phase: "editing",
          received: 0,
          digest: null,
          issue: null,
          unexpected: null,
        });
        publish({ drafts: [...state.drafts, draft], selectedId: id, issue: null });
      } catch (error) {
        report(error);
      }
    },
    edit: (id, input, file) => {
      const draft = get(id);
      if (!draft || draft.phase !== "editing") return;
      if (file && file.size > 67108864) {
        update(id, { issue: "Resource uploads support complete files up to 64MiB." });
        return;
      }
      update(id, { input: Object.freeze({ ...input }), ...(file ? { file } : {}), issue: null });
    },
    choose: (id) => publish({ selectedId: id }),
    stage: async (id) => {
      const draft = get(id);
      if (
        !draft ||
        !(draft.phase === "editing" || draft.phase === "interrupted") ||
        staging.size > 0
      )
        return;
      try {
        if (draft.file === null)
          throw new ResourceInputError("Choose the complete source file first.");
        uploadPreparation(draft);
      } catch (error) {
        report(error, id);
        return;
      }
      const abort = new AbortController();
      staging.set(id, abort);
      update(id, { phase: "staging", issue: null });
      try {
        if (draft.file === null)
          throw new ResourceInputError("Choose the complete source file first.");
        uploadPreparation(draft);
        const hash = await (ports.hash ?? hashUpload)(draft.file, abort.signal);
        if (abort.signal.aborted || disposed) return;
        update(id, { digest: hash });
        const call = <T>(
          path: string,
          body: import("../../../core/json").JsonValue,
          codec: c.Codec<T>,
        ) => http.request({ method: "POST", path, body, codec, signal: abort.signal });
        const initial = unwrap(
          await call(
            "/resource-stages/prepare",
            d.jsonObject([
              ["stage_id", d.jsonString(draft.stageId)],
              ["digest", d.jsonString(hash)],
              ["size_bytes", d.jsonString(String(draft.file.size))],
            ]),
            stageCodec,
          ),
        );
        if (
          initial.digest !== hash ||
          initial.size_bytes !== String(draft.file.size) ||
          initial.stage_id !== draft.stageId ||
          initial.intention_id !== null ||
          !initial.source_retained ||
          initial.status === "abandoned"
        )
          throw new ResourceInputError(
            "Staged source identity/ownership differs from this retained draft.",
          );
        update(id, { received: Number(initial.received) });
        for (let offset = Number(initial.received); offset < draft.file.size; offset += 262144) {
          if (abort.signal.aborted || disposed) return;
          const bytes = new Uint8Array(
            await draft.file.slice(offset, offset + 262144).arrayBuffer(),
          );
          if (abort.signal.aborted || disposed) return;
          const row = unwrap(
            await call(
              `/resource-stages/${draft.stageId}/chunks`,
              d.jsonObject([
                ["offset", d.jsonString(String(offset))],
                ["data_base64", d.jsonString(base64(bytes))],
              ]),
              stageCodec,
            ),
          );
          if (
            row.stage_id !== draft.stageId ||
            row.digest !== hash ||
            row.received !== String(offset + bytes.length)
          )
            throw new ResourceInputError(
              "Staging acknowledgement differs from the exact source range.",
            );
          update(id, { received: offset + bytes.length });
        }
        const sealed = unwrap(
          await call(`/resource-stages/${draft.stageId}/seal`, d.jsonObject([]), stageCodec),
        );
        if (
          sealed.status !== "sealed" ||
          sealed.digest !== hash ||
          sealed.received !== String(draft.file.size) ||
          sealed.stage_id !== draft.stageId
        )
          throw new ResourceInputError("Native sealed source does not match this complete file.");
        if (!abort.signal.aborted) update(id, { phase: "sealed", received: draft.file.size });
      } catch (error) {
        if (!abort.signal.aborted && !disposed) report(error, id);
      } finally {
        if (staging.get(id) === abort) staging.delete(id);
        const latest = get(id);
        if (latest?.phase === "staging")
          update(id, {
            phase: "interrupted",
            issue: abort.signal.aborted
              ? "Staging observer cancelled. Inspect retained input; exact restaging or explicit unprepared cleanup remain available."
              : latest.issue,
          });
      }
    },
    cancelStaging: (id) => staging.get(id)?.abort(),
    prepare: async (id) => {
      const draft = get(id);
      if (!draft || draft.phase !== "sealed") return;
      update(id, { phase: "preparing", issue: null });
      const epoch = ++jobEpoch;
      try {
        const preparation = uploadPreparation(draft);
        const job = unwrap(
          await http.request({
            method: "POST",
            path: "/resource-uploads/prepare",
            codec: uploadJobCodec,
            responseBudget: "operation",
            body: d.jsonObject([
              ["stage_id", d.jsonString(draft.stageId)],
              ["preparation", preparationJson(preparation)],
            ]),
          }),
        );
        if (job.intention_id !== id)
          throw new ResourceInputError("Native upload identity differs from captured intention.");
        if (!disposed && epoch === jobEpoch) chooseJob(job);
        update(id, { phase: "prepared", file: null });
      } catch (error) {
        report(error, id);
        update(id, { phase: "sealed" });
      }
    },
    inspect,
    finishSaving: async (id) => {
      const retained =
        state.selectedJob?.intention_id === id
          ? state.selectedJob
          : state.jobs?.items.find((job) => job.intention_id === id);
      if (!retained || retained.phase.kind !== "local_save_incomplete") {
        publish({
          issue: "Inspect a saved local-incomplete upload before finishing its exact save.",
        });
        return;
      }
      const epoch = ++jobEpoch;
      try {
        const captured = uploadPlanCodec.decode(retained.plan);
        if (!captured.ok)
          throw new ResourceInputError(
            "Retained native upload plan is invalid; it was not reconstructed.",
          );
        const plan = captured.value;
        const preparation: Preparation = {
          intention_id: plan.intention_id,
          connection_id: plan.connection.id,
          generation: plan.connection.generation,
          context: plan.context,
          method: "resource.upload",
          params: plan.params,
        };
        const saved = unwrap(
          await http.request({
            method: "POST",
            path: "/resource-uploads/prepare",
            codec: uploadJobCodec,
            responseBudget: "operation",
            body: d.jsonObject([
              ["stage_id", d.jsonString(plan.stage_id)],
              ["preparation", preparationJson(preparation)],
            ]),
          }),
        );
        if (saved.intention_id !== id)
          throw new ResourceInputError("Native save returned a different upload identity.");
        if (!disposed && epoch === jobEpoch) chooseJob(saved);
      } catch (error) {
        if (!disposed && epoch === jobEpoch) report(error);
      }
    },
    act: async (id, action) => {
      const epoch = ++jobEpoch;
      try {
        const job = unwrap(
          await http.request({
            method: "POST",
            path: `/resource-uploads/${encodeURIComponent(id)}/${action}`,
            codec: uploadJobCodec,
            responseBudget: "operation",
            body: d.jsonObject([]),
          }),
        );
        if (!disposed && epoch === jobEpoch) chooseJob(job);
      } catch (error) {
        if (!disposed && epoch === jobEpoch) report(error);
      }
    },
    inventory: async (offset, stageOffset) => {
      const epoch = ++inventoryEpoch;
      publish({ loading: true, issue: null });
      try {
        const [jobs, stages] = await Promise.all([
          http.request({
            method: "GET",
            path: `/resource-uploads?offset=${offset ?? "0"}&limit=100`,
            codec: jobPageCodec,
            responseBudget: "operation",
          }),
          http.request({
            method: "GET",
            path: `/resource-stages?offset=${stageOffset ?? "0"}&limit=100`,
            codec: stagePageCodec,
          }),
        ]);
        if (!disposed && epoch === inventoryEpoch)
          publish({ jobs: unwrap(jobs), stages: unwrap(stages) });
      } catch (error) {
        if (!disposed && epoch === inventoryEpoch) report(error);
      } finally {
        if (!disposed && epoch === inventoryEpoch) publish({ loading: false });
      }
    },
    abandon: async (id) => {
      try {
        unwrap(
          await http.request({
            method: "POST",
            path: `/resource-stages/${encodeURIComponent(id)}/abandon`,
            body: d.jsonObject([]),
            codec: c.object,
          }),
        );
        publish({
          issue:
            "Unprepared input cleanup requested. Refresh inventory to inspect retained capacity.",
        });
      } catch (error) {
        report(error);
      }
    },
    close: (id) => {
      const draft = get(id);
      if (!draft || draft.phase === "staging" || draft.phase === "preparing") return;
      publish({
        drafts: state.drafts.filter((d) => d.id !== id),
        selectedId: state.selectedId === id ? null : state.selectedId,
      });
    },
    dispose: () => {
      disposed = true;
      for (const abort of staging.values()) abort.abort();
      staging.clear();
      listeners.clear();
    },
  };
}
