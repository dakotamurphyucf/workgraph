import type { HttpClient } from "../../core/protocol/http";
import { HTTP_LIMITS } from "../../core/protocol/worker/jobs";
import type { Identifier } from "../../core/protocol/types";
import type { OperationController } from "../../core/state/operations";
import { createProgressObserver } from "../../core/state/progress-observer";
import { DraftInputError } from "../connections/model";
import { failureText } from "../connections/failure";
import { createAdministrationClient, observationJson, sameAction, samePlan } from "./client";
import { freezeDaemon, freezeLocal, identity } from "./model";
import type {
  AdminAction,
  AdminDraft,
  AdminFields,
  AdministrationController,
  AdministrationState,
  AdminSelection,
  LocalAction,
  LocalJob,
} from "./types";

export const EMPTY_FIELDS: AdminFields = {
  workspaceId: "",
  destination: "",
  jobId: "",
  directory: "",
  root: "",
  rootsSource: "{}",
  targetActor: "",
  targetMutation: "",
  source: "",
  stage: "",
  owner_token: "",
};
function action(draft: AdminDraft): AdminAction | LocalAction {
  const f = draft.fields;
  switch (draft.kind) {
    case "workspace_export":
      return { kind: draft.kind, workspaceId: f.workspaceId, destination: f.destination };
    case "export_all":
      return { kind: draft.kind, destination: f.destination, allowPartial: draft.allowPartial };
    case "export_cancel":
    case "export_retry":
      return { kind: draft.kind, jobId: f.jobId };
    case "workspace_restore":
      return { kind: draft.kind, directory: f.directory, root: f.root };
    case "restore_all":
      return { kind: draft.kind, directory: f.directory, rootsSource: f.rootsSource };
    case "restore_cancel":
      return { kind: draft.kind, targetActor: f.targetActor, targetMutation: f.targetMutation };
    case "migrate_0_6_2":
      return { kind: draft.kind, source: f.source, destination: f.destination };
    case "cleanup_stage":
      return { kind: draft.kind, stage: f.stage, owner_token: f.owner_token };
  }
}
function draftFields(action: LocalAction): Partial<AdminFields> {
  return action.kind === "migrate_0_6_2"
    ? { source: action.source, destination: action.destination }
    : { stage: action.stage, owner_token: action.owner_token };
}
const older = (a: string, b: string) => a.length < b.length || (a.length === b.length && a < b);
/** Application-owned unsent editors and finite read-only local-job observation. */
export function createAdministrationController({
  http,
  operations,
}: {
  readonly http: HttpClient;
  readonly operations: OperationController;
}): AdministrationController {
  let state: AdministrationState = {
    drafts: [],
    activeId: null,
    notice: "",
    tools: {
      directory: "",
      journalPath: "",
      socket: "",
      verifyDirectory: "",
      receiptActor: "",
      receiptMutation: "",
    },
  };
  let disposed = false;
  const listeners = new Set<() => void>(),
    active = new Map<Identifier, Promise<void>>();
  const local = createAdministrationClient(http),
    progress = createProgressObserver();
  const emit = (patch: Partial<AdministrationState>) => {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener();
  };
  const get = (id: Identifier) => state.drafts.find((draft) => draft.id === id);
  const patch = (id: Identifier, update: Partial<AdminDraft>) => {
    if (!disposed)
      emit({
        drafts: state.drafts.map((draft) =>
          draft.id === id ? Object.freeze({ ...draft, ...update }) : draft,
        ),
      });
  };
  const publishJob = async (
    id: Identifier,
    job: LocalJob,
    owns: () => boolean = () => true,
  ): Promise<boolean> => {
    if (disposed || !owns()) return false;
    const draft = get(id);
    if (!draft || draft.frozen?.kind !== "local") return false;
    const previous = draft.local;
    if (
      !samePlan(draft.frozen.plan, job.plan) ||
      (previous !== null &&
        (previous.input_hash !== job.input_hash ||
          !sameAction(previous.execution_action, job.execution_action)))
    ) {
      patch(id, {
        issue:
          "Local job identity or captured execution paths changed; retained plan was preserved.",
      });
      return false;
    }
    if (previous !== null && older(job.revision, previous.revision)) return true;
    if (previous !== null && job.revision === previous.revision) {
      const observations = await Promise.all([
        http.processing.encode(observationJson(previous), { canonical: true, limits: HTTP_LIMITS }),
        http.processing.encode(observationJson(job), { canonical: true, limits: HTTP_LIMITS }),
      ]);
      if (disposed || !owns() || get(id)?.frozen !== draft.frozen) return false;
      // A newer publication may have arrived while the worker compared these values.
      if (get(id)?.local !== previous) return publishJob(id, job, owns);
      for (const result of observations) {
        if (!result.ok || !result.value.ok) {
          patch(id, {
            issue: !result.ok
              ? result.failure.message
              : !result.value.ok
                ? result.value.error.message
                : "Observation comparison failed.",
          });
          return false;
        }
      }
      const [left, right] = observations;
      if (!left.ok || !left.value.ok || !right.ok || !right.value.ok) return false;
      if (left.value.value !== right.value.value) {
        patch(id, {
          issue:
            "Protocol issue: local job changed without increasing its revision. The known observation was preserved.",
        });
        return false;
      }
      return true;
    }
    if (
      previous !== null &&
      previous.state.status !== "prepared_unsent" &&
      previous.state.status !== "running" &&
      job.state.status !== previous.state.status
    ) {
      patch(id, {
        issue:
          "A terminal local outcome cannot be replaced by a different state. The known observation was preserved.",
      });
      return false;
    }
    patch(id, { local: job, issue: null });
    return true;
  };
  const observe = (id: Identifier) => {
    const owner = get(id)?.frozen;
    const first = get(id)?.local;
    if (!first || first.state.status !== "running") return;
    const captured = first;
    progress.start(id, {
      inspect: async (signal) => {
        const result = await local.inspect(id, signal);
        const owns = () => !signal.aborted && !disposed && get(id)?.frozen === owner;
        // The adapter itself publishes state. Fence it before any publication,
        // independently of the observer's own late-decision suppression.
        if (!owns()) return "unknown";
        if (!result.ok) {
          patch(id, { issue: failureText(result.failure) });
          return "error";
        }
        if (
          !samePlan(captured.plan, result.data.plan) ||
          captured.input_hash !== result.data.input_hash ||
          !sameAction(captured.execution_action, result.data.execution_action) ||
          !(await publishJob(id, result.data, owns))
        )
          return "unknown";
        const latest = get(id)?.local?.state.status;
        return latest === "running"
          ? "pending"
          : latest === "outcome_unknown"
            ? "unknown"
            : "complete";
      },
      changed: (observation) => patch(id, { observation }),
      unexpected: (error) => patch(id, { unexpected: { error } }),
    });
  };
  const run = (id: Identifier, work: () => Promise<void>): Promise<void> => {
    const previous = active.get(id);
    if (previous) return previous;
    if (disposed) return Promise.resolve();
    patch(id, { pending: true, issue: null });
    const promise = Promise.resolve()
      .then(work)
      .catch((error: unknown) => {
        if (error instanceof DraftInputError) patch(id, { issue: error.message });
        else {
          patch(id, { unexpected: { error } });
          throw error;
        }
      })
      .finally(() => {
        active.delete(id);
        patch(id, { pending: false });
      });
    active.set(id, promise);
    return promise;
  };
  const controller: AdministrationController = {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    editTools: (fields) => {
      const tools = { ...state.tools, ...fields };
      if (Object.values(tools).reduce((sum, value) => sum + value.length, 0) > 512 * 1024) {
        emit({
          notice: "Tool input budget exceeded; previous paths and identities were preserved.",
        });
        return false;
      }
      emit({ tools, notice: "" });
      return true;
    },
    create: (selection, kind, fields = {}) => {
      if (disposed) return null;
      if (state.drafts.length >= 16) {
        emit({
          notice:
            "Keep at most 16 administration drafts. Close a draft without discarding its saved operation before creating another.",
        });
        return null;
      }
      const values = { ...EMPTY_FIELDS, workspaceId: selection.route.workspaceId ?? "", ...fields };
      const characters = Object.values(values).reduce((sum, text) => sum + text.length, 0);
      const total = state.drafts.reduce(
        (sum, item) => sum + Object.values(item.fields).reduce((n, text) => n + text.length, 0),
        characters,
      );
      if (characters > 2 * 1024 * 1024 || total > 4 * 1024 * 1024) {
        emit({ notice: "Editing budget exceeded; existing drafts were preserved." });
        return null;
      }
      const id = identity();
      if (get(id) || operations.get(id))
        throw new Error("Administration identity generator reused an existing intention.");
      const captured: AdminSelection = {
        ...selection,
        route: Object.freeze({ ...selection.route }),
        writer: Object.freeze({ ...selection.writer }),
        connection:
          selection.connection === null ? null : Object.freeze({ ...selection.connection }),
      };
      const draft: AdminDraft = {
        id,
        selection: captured,
        kind,
        fields: { ...EMPTY_FIELDS, workspaceId: selection.route.workspaceId ?? "", ...fields },
        allowPartial: false,
        frozen: null,
        local: null,
        pending: false,
        issue: null,
        unexpected: null,
        observation: undefined,
      };
      emit({ drafts: [...state.drafts, draft], activeId: id, notice: "" });
      return id;
    },
    select: (id) => {
      if (get(id)) emit({ activeId: id });
    },
    edit: (id, fields, allowPartial) => {
      const draft = get(id);
      if (!draft || draft.pending || draft.frozen !== null) return false;
      const next = { ...draft.fields, ...fields };
      const characters = Object.values(next).reduce((sum, text) => sum + text.length, 0);
      const total = state.drafts.reduce(
        (sum, item) =>
          sum +
          (item.id === id
            ? characters
            : Object.values(item.fields).reduce((n, text) => n + text.length, 0)),
        0,
      );
      if (characters > 2 * 1024 * 1024 || total > 4 * 1024 * 1024) {
        patch(id, {
          issue:
            "Editing budget exceeded (2 MiB characters per draft, 4 MiB total). The previous draft was preserved.",
        });
        return false;
      }
      patch(id, { fields: next, allowPartial: allowPartial ?? draft.allowPartial, issue: null });
      return true;
    },
    review: (id) =>
      run(id, async () => {
        let draft = get(id);
        if (!draft) return;
        let frozen = draft.frozen;
        if (frozen === null) {
          const input = action(draft);
          if (input.kind === "migrate_0_6_2" || input.kind === "cleanup_stage")
            frozen = freezeLocal(draft.selection, input, id);
          else {
            let roots;
            if (input.kind === "restore_all") {
              const parsed = await http.processing.parse(input.rootsSource);
              if (!parsed.ok) throw new DraftInputError(parsed.failure.message);
              if (!parsed.value.ok) throw new DraftInputError(parsed.value.error.message);
              if (parsed.value.value.value.kind !== "object")
                throw new DraftInputError("Restore roots must be a JSON object.");
              roots = parsed.value.value.value;
            }
            frozen = freezeDaemon(draft.selection, input, id, roots);
          }
          patch(id, { frozen });
        }
        if (disposed) return;
        if (frozen.kind === "daemon") {
          const registered = await operations.register(frozen.preparation);
          if (!registered.ok) {
            patch(id, { issue: failureText(registered.failure) });
            return;
          }
          const prepared = await operations.act(id, "prepare");
          if (!prepared.ok) patch(id, { issue: failureText(prepared.failure) });
        } else {
          const prepared = await local.prepare(frozen.plan);
          if (!prepared.ok) patch(id, { issue: failureText(prepared.failure) });
          else await publishJob(id, prepared.data);
        }
        draft = get(id);
        if (draft?.local?.state.status === "running") observe(id);
      }),
    localAction: (id, action) =>
      run(id, async () => {
        const draft = get(id);
        if (draft?.frozen?.kind !== "local") return;
        progress.stop(id);
        const result =
          action === "inspect"
            ? await local.inspect(id)
            : await local.act(draft.frozen.plan, action);
        if (!result.ok) {
          patch(id, { issue: failureText(result.failure) });
          return;
        }
        if (await publishJob(id, result.data)) observe(id);
      }),
    adoptLocal: async (job) => {
      const existing = get(job.plan.intention_id);
      if (existing) return publishJob(existing.id, job);
      if (disposed || state.drafts.length >= 16) {
        emit({ notice: "Close a draft before loading another saved helper." });
        return false;
      }
      const selection: AdminSelection = {
        client: http,
        connection: null,
        current: true,
        route: {
          view: "overview",
          connectionId: null,
          workspaceId: job.plan.context.workspace_id,
          projectId: job.plan.context.project_id,
          entityId: null,
        },
        writer: {
          actorId: job.plan.context.writer?.actor_id ?? null,
          runId: job.plan.context.writer?.run_id ?? null,
        },
      };
      const draft: AdminDraft = {
        id: job.plan.intention_id,
        selection,
        kind: job.plan.action.kind,
        fields: { ...EMPTY_FIELDS, ...draftFields(job.plan.action) },
        allowPartial: false,
        frozen: { kind: "local", plan: job.plan },
        local: job,
        pending: false,
        issue: null,
        unexpected: null,
        observation: undefined,
      };
      emit({ drafts: [...state.drafts, draft], activeId: draft.id });
      return true;
    },
    discard: (id) => {
      const draft = get(id);
      if (!draft || draft.pending) return false;
      progress.stop(id);
      emit({
        drafts: state.drafts.filter((item) => item.id !== id),
        activeId: state.activeId === id ? null : state.activeId,
      });
      return true;
    },
    dispose: () => {
      disposed = true;
      progress.dispose();
      listeners.clear();
    },
  };
  return controller;
}
