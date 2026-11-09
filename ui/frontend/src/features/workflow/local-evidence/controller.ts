import * as d from "../../../core/protocol/decoders";
import { createReadSlot } from "../../../core/state/read-slot";
import { createProgressObserver } from "../../../core/state/progress-observer";
import type { Decimal } from "../../../core/protocol/types";
import type { HttpResult } from "../../../core/protocol/http";
import { createVerifiedTransfer } from "../../history/transcript/transfer";
import { createExecutionClient, planJson } from "./client";
import * as codecs from "./codecs";
import type {
  ExecutionClient,
  LocalEvidenceController,
  LocalEvidenceOptions,
  LocalEvidenceState,
  PublicationJob,
  PublicationPlan,
  StageSnapshot,
} from "./types";
const decimal = (value: string) => {
  const result = d.decimal.decode(d.jsonString(value));
  if (!result.ok) throw new LocalInputError("Enter a canonical nonnegative revision.");
  return result.value;
};
class LocalInputError extends Error {}
function value<T>(slot: import("../../../core/state/read-slot").ReadState<T>): T | null {
  return slot.kind === "ready" ? slot.value : null;
}
export function createLocalEvidenceController(
  options: LocalEvidenceOptions & {
    readonly transfer?: import("../../history/transcript/transfer.types").VerifiedTransfer;
    readonly client?: ExecutionClient;
    readonly identity?: () => string;
  },
): LocalEvidenceController {
  const client = options.client ?? createExecutionClient(options.http),
    stage = createReadSlot<StageSnapshot>(),
    output = createReadSlot<import("./types").InspectedOutput>(),
    intent = createReadSlot<import("./types").ExternalIntent>(),
    saved = createReadSlot<{
      readonly items: readonly import("./types").PublicationSummary[];
      readonly next_offset: Decimal | null;
      readonly total: Decimal;
    }>(),
    observer = createProgressObserver(),
    transfer = options.transfer ?? createVerifiedTransfer();
  let state: LocalEvidenceState = {
      directory: "",
      stage: stage.get(),
      output: output.get(),
      intent: intent.get(),
      saved: saved.get(),
      selectedStream: "stdout",
      jobs: [],
      diagnostic: null,
      draft: null,
      notice: null,
      busy: false,
      unexpected: null,
      observations: new Map(),
      uncertain: new Set(),
      download: { kind: "idle" },
    },
    disposed = false,
    downloadOwner: AbortController | null = null;
  const listeners = new Set<() => void>();
  const publish = (change: Partial<LocalEvidenceState>) => {
    if (disposed) return;
    state = Object.freeze({ ...state, ...change });
    for (const listener of listeners) listener();
  };
  stage.subscribe(() => publish({ stage: stage.get() }));
  output.subscribe(() => publish({ output: output.get() }));
  intent.subscribe(() => publish({ intent: intent.get() }));
  saved.subscribe(() => publish({ saved: saved.get() }));
  const unexpected = (error: unknown) => publish({ unexpected: { error } });
  const retain = (job: PublicationJob) => {
    const previous = state.jobs.find((old) => old.plan.intention_id === job.plan.intention_id);
    if (previous !== undefined && previous.input_hash !== job.input_hash)
      throw new Error("Saved publication identity changed its original input.");
    if (previous !== undefined && BigInt(previous.revision) > BigInt(job.revision)) return;
    const uncertain = new Set(state.uncertain);
    uncertain.delete(job.plan.intention_id);
    const jobs = state.jobs.filter((old) => old.plan.intention_id !== job.plan.intention_id);
    publish({ jobs: [...jobs, job], uncertain });
  };
  const failure = (
    result: Extract<HttpResult<unknown>, { readonly ok: false }>,
    uncertain: boolean,
  ) => publish({ notice: { kind: "request_failure", failure: result.failure, uncertain } });
  const action = async (work: () => Promise<void>) => {
    if (disposed || state.busy) return;
    publish({ busy: true, notice: null });
    try {
      await work();
    } catch (error: unknown) {
      if (error instanceof LocalInputError)
        publish({ notice: { kind: "message", message: error.message } });
      else unexpected(error);
    } finally {
      publish({ busy: false });
    }
  };
  const observed = (job: PublicationJob) => {
    retain(job);
    if (job.state.kind !== "running") return;
    const id = job.plan.intention_id,
      hash = job.input_hash;
    observer.start(id, {
      changed: (status) => {
        const observations = new Map(state.observations);
        observations.set(id, status);
        publish({ observations });
      },
      unexpected,
      inspect: async (signal) => {
        const result = await client.inspect(id, signal);
        if (!result.ok) {
          if (!signal.aborted) failure(result, false);
          return "error";
        }
        if (result.data.plan.intention_id !== id || result.data.input_hash !== hash)
          throw new Error("Publication observation returned a different captured intention.");
        if (disposed || signal.aborted) return "unknown";
        retain(result.data);
        switch (result.data.state.kind) {
          case "running":
            return "pending";
          case "published":
            return "complete";
          case "outcome_unknown":
            return "unknown";
          case "prepared_unsent":
          case "local_save_incomplete":
          case "failed_unsent":
            return "error";
        }
      },
    });
  };
  const prepare = async (plan: PublicationPlan) => {
    // Retain the exact typed/immutable plan BEFORE any request can be admitted.
    const checked = codecs.plan.decode(planJson(plan));
    if (!checked.ok)
      throw new LocalInputError(`Invalid publication input: ${checked.issue.expected}.`);
    const captured = checked.value;
    publish({ draft: { kind: "captured", plan: captured, pending: true } });
    const result = await client.prepare(captured);
    if (disposed) return;
    publish({ draft: { kind: "captured", plan: captured, pending: false } });
    if (!result.ok) {
      failure(result, true);
      return;
    }
    if (result.data.plan.intention_id !== captured.intention_id)
      throw new Error("Prepared publication returned another intention.");
    retain(result.data);
  };
  const clearDownload = () => {
    const owner = downloadOwner;
    downloadOwner = null;
    owner?.abort();
    publish({ download: { kind: "idle" } });
  };
  const controller: LocalEvidenceController = {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setDirectory: (directory) => {
      clearDownload();
      publish({ directory });
      stage.clear();
      output.clear();
      intent.clear();
    },
    inspectStage: async () => {
      clearDownload();
      const directory = state.directory;
      output.clear();
      intent.clear();
      // ReadSlot owns stale/current unexpected errors; never republish obsolete catches.
      await stage
        .load(directory, (signal) => client.inspectStage({ directory }, signal))
        .catch(() => undefined);
    },
    inspectOutput: async (stream, selection) => {
      if (stream !== state.selectedStream) clearDownload();
      const capture = value(stage.get());
      if (capture?.kind !== "finished") return;
      const target = Object.freeze({
        directory: capture.directory,
        capture_digest: capture.capture.digest,
      });
      const captured = Object.freeze({ ...selection });
      publish({ selectedStream: stream });
      await output
        .load(
          JSON.stringify([target.directory, target.capture_digest, stream, captured]),
          (signal) => client.inspectOutput(target, stream, captured, signal),
        )
        .catch(() => undefined);
    },
    inspectIntent: async () => {
      const capture = value(stage.get());
      if (capture === null) return;
      const directory = capture.directory;
      await intent
        .load(directory, (signal) => client.inspectIntent({ directory }, signal))
        .catch(() => undefined);
    },
    newPublication: (context) => {
      if (state.busy || disposed) return;
      const capture = value(stage.get());
      if (capture?.kind !== "finished") {
        publish({ notice: { kind: "message", message: "Inspect a finished native stage first." } });
        return;
      }
      if (
        context.profileState !== "current" ||
        context.route.workspaceId === null ||
        context.writer.actorId === null
      ) {
        publish({
          notice: {
            kind: "message",
            message:
              "Choose a current connection, workspace and explicit writer before capturing a publication.",
          },
        });
        return;
      }
      const identity = d.identifier.decode(
        d.jsonString(options.identity?.() ?? crypto.randomUUID()),
      );
      const actor = d.identifier.decode(d.jsonString(context.writer.actorId)),
        workspace = d.identifier.decode(d.jsonString(context.route.workspaceId)),
        run =
          context.writer.runId === null
            ? null
            : d.identifier.decode(d.jsonString(context.writer.runId));
      if (!identity.ok || !actor.ok || !workspace.ok || (run !== null && !run.ok)) {
        publish({ notice: { kind: "message", message: "Writer/workspace identity is invalid." } });
        return;
      }
      const project =
        context.route.projectId === null
          ? null
          : d.identifier.decode(d.jsonString(context.route.projectId));
      if (project !== null && !project.ok) {
        publish({ notice: { kind: "message", message: "Project identity is invalid." } });
        return;
      }
      publish({
        draft: {
          kind: "editing",
          id: identity.value,
          connection: Object.freeze({ ...context.connection }),
          context: Object.freeze({
            workspace_id: workspace.value,
            project_id: project?.value ?? null,
            writer: Object.freeze({ actor_id: actor.value, run_id: run?.value ?? null }),
          }),
          stage: capture,
          fields: {
            resourceId: "",
            expectedRevision: "0",
            title: "Execution evidence",
            ticketId: "",
          },
        },
        notice: null,
      });
    },
    edit: (fields) => {
      const draft = state.draft;
      if (draft?.kind !== "editing") return;
      publish({ draft: { ...draft, fields: Object.freeze({ ...draft.fields, ...fields }) } });
    },
    review: () =>
      action(async () => {
        const draft = state.draft;
        if (draft?.kind !== "editing") return;
        const resource = d.identifier.decode(d.jsonString(draft.fields.resourceId));
        if (!resource.ok) throw new LocalInputError("Enter a valid exact resource ID.");
        const ticket =
          draft.fields.ticketId === ""
            ? null
            : d.identifier.decode(d.jsonString(draft.fields.ticketId));
        if (ticket !== null && !ticket.ok)
          throw new LocalInputError("Enter a valid ticket ID, or leave it empty for no link.");
        if (draft.context.workspace_id === null)
          throw new LocalInputError("Publication requires the captured workspace.");
        await prepare(
          Object.freeze({
            kind: "ui_prepared",
            intention_id: draft.id,
            connection: draft.connection,
            context: draft.context,
            directory: draft.stage.directory,
            capture_digest: draft.stage.capture.digest,
            params: Object.freeze({
              workspace_id: draft.context.workspace_id,
              actor_id: draft.context.writer.actor_id,
              ...(draft.context.writer.run_id === null
                ? {}
                : { run_id: draft.context.writer.run_id }),
              mutation_id: draft.id,
              resource_id: resource.value,
              expected_revision: decimal(draft.fields.expectedRevision),
              title: draft.fields.title,
              ...(ticket === null ? {} : { ticket_id: ticket.value }),
            }),
          }),
        );
      }),
    finishSaving: (id) =>
      action(async () => {
        if (id !== undefined) {
          const job = state.jobs.find((job) => job.plan.intention_id === id);
          if (job !== undefined) await prepare(job.plan);
        } else if (state.draft?.kind === "captured") await prepare(state.draft.plan);
      }),
    associate: (connection) =>
      action(async () => {
        const current = value(intent.get());
        if (current === null) throw new LocalInputError("Inspect the saved native intent first.");
        const id = d.identifier.decode(d.jsonString(options.identity?.() ?? crypto.randomUUID()));
        if (!id.ok) throw new Error("Invalid generated intention.");
        await prepare(
          Object.freeze({
            kind: "operator_bound_external",
            intention_id: id.value,
            connection: Object.freeze({ ...connection }),
            directory: current.directory,
            intent_digest: current.intent_digest,
          }),
        );
      }),
    act: (id, kind) =>
      action(async () => {
        observer.stop(id);
        const result =
          kind === "inspect"
            ? await client.inspect(id, new AbortController().signal)
            : await client[kind](id);
        if (disposed) return;
        if (!result.ok) {
          if (kind === "start" || kind === "retryExact") {
            const uncertain = new Set(state.uncertain);
            uncertain.add(id);
            publish({ uncertain });
          }
          failure(result, kind !== "inspect" && kind !== "recover");
          return;
        }
        if (result.data.plan.intention_id !== id)
          throw new Error("Publication action returned another intention.");
        if (kind === "start" || kind === "retryExact") observed(result.data);
        else retain(result.data);
      }),
    loadSaved: async (offset = decimal("0")) => {
      await saved.load(offset, (signal) => client.list(offset, signal)).catch(() => undefined);
    },
    cleanup: () =>
      action(async () => {
        const capture = value(stage.get());
        if (capture?.kind !== "finished" || capture.owner_token === null)
          throw new LocalInputError(
            "Only a validated finished stage with its exact ownership token can be cleaned.",
          );
        const result = await client.cleanup({
          directory: capture.directory,
          owner_token: capture.owner_token,
        });
        if (!result.ok) {
          failure(result, true);
          return;
        }
        if (result.data.directory !== capture.directory)
          throw new Error("Cleanup returned another host directory.");
        if (state.directory === capture.directory) {
          stage.clear();
          output.clear();
          intent.clear();
        }
        publish({
          notice: {
            kind: "message",
            message:
              "Native cleanup completed for the exact owned stage. Published resources were not deleted.",
          },
        });
      }),
    download: async () => {
      const capture = value(stage.get());
      if (capture?.kind !== "finished" || downloadOwner !== null) return;
      const stream = state.selectedStream,
        retained = capture[stream],
        source = Object.freeze({ digest: retained.digest, size_bytes: retained.size_bytes }),
        target = { directory: capture.directory, capture_digest: capture.capture.digest },
        owner = new AbortController();
      downloadOwner = owner;
      publish({ download: { kind: "running", received: 0, total: Number(source.size_bytes) } });
      try {
        const result = await transfer.download(
          source,
          {
            read: async (offset, signal) => {
              const result = await client.inspectOutput(
                target,
                stream,
                { kind: "range", offset: decimal(offset), length: decimal("65536") },
                signal,
              );
              if (!result.ok) return result;
              const chunk = result.data;
              if (chunk.retained_bytes !== source.size_bytes)
                return {
                  ok: false,
                  failure: {
                    kind: "protocol",
                    message: "Retained output changed during download.",
                    issue: undefined,
                  },
                };
              const next = decimal(
                (BigInt(chunk.offset) + BigInt(chunk.returned_bytes)).toString(),
              );
              return {
                ok: true,
                httpStatus: result.httpStatus,
                data: {
                  blob: source,
                  offset: chunk.offset,
                  bytes_base64: chunk.data_base64,
                  next_offset: next,
                  total_bytes: source.size_bytes,
                  has_more: BigInt(next) < BigInt(source.size_bytes),
                },
              };
            },
          },
          (received, total) => {
            if (downloadOwner === owner)
              publish({ download: { kind: "running", received, total } });
          },
          owner.signal,
        );
        if (disposed || downloadOwner !== owner) return;
        publish({
          download: result.ok
            ? {
                kind: "ready",
                blob: result.blob,
                filename: `${stream}-${capture.capture.digest.slice(0, 12)}.bin`,
              }
            : { kind: "failed", message: result.message },
        });
      } catch (error: unknown) {
        if (!disposed && downloadOwner === owner) unexpected(error);
      } finally {
        if (downloadOwner === owner) downloadOwner = null;
      }
    },
    cancelDownload: () => downloadOwner?.abort(),
    dispose: () => {
      disposed = true;
      downloadOwner?.abort();
      observer.dispose();
      transfer.dispose();
      stage.dispose();
      output.dispose();
      intent.dispose();
      saved.dispose();
      listeners.clear();
    },
  };
  return controller;
}
