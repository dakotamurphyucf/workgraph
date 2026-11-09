import type { FeatureContext } from "../../app/types";
import type { ConnectionProfile, Identifier } from "../../core/protocol/types";
import type { FrozenAction, Launch, LaunchPlan, LifecycleAction } from "./types";
import type { HttpResult } from "../../core/protocol/http";
import { createProgressObserver, type ProgressStatus } from "../../core/state/progress-observer";
import { sameLaunchPlan } from "./client";
import { failureText } from "./failure";

export type LifecycleKind = Exclude<LifecycleAction["kind"], "daemon_stop">;
export type EditorField =
  | "id"
  | "name"
  | "root"
  | "title"
  | "summary"
  | "description"
  | "instructions"
  | "acceptance"
  | "priority"
  | "status"
  | "project"
  | "date"
  | "revision"
  | "evidence"
  | "nextSteps";
export type EditorFields = Readonly<Record<EditorField, string>>;
export interface LifecycleEditor {
  readonly context: FeatureContext;
  readonly kind: LifecycleKind;
  readonly fields: EditorFields;
  readonly archived: boolean;
  readonly review: FrozenAction | null;
  readonly registration: "idle" | "pending" | "registered";
}
export interface ProfileDraft {
  readonly id: string;
  readonly label: string;
  readonly socket: string;
  readonly previous: ConnectionProfile | null;
}
export interface ManagerDraft {
  readonly profileId: string | null;
  readonly savedProfile: ConnectionProfile | null;
  readonly draft: ProfileDraft;
  readonly registry: string;
  readonly log: string;
  readonly seconds: string;
  readonly frozen: LaunchPlan | null;
  readonly launch: Launch | null;
  readonly launchObservation: ProgressStatus | undefined;
  readonly stop: Identifier | null;
  readonly notice: string;
  readonly busy: boolean;
  readonly unexpected: { readonly error: unknown } | null;
}
export interface DraftCell<T> {
  readonly get: () => T;
  readonly subscribe: (listener: () => void) => () => void;
  readonly issue: () => string | null;
  /** A deferred prefill may publish only while no edit attempt has changed this selection. */
  readonly captureSelection: () => { readonly isCurrent: () => boolean };
  readonly set: (value: T | ((previous: T) => T)) => boolean;
}
export interface ConnectionDraftStore {
  readonly editor: DraftCell<LifecycleEditor | null>;
  readonly manager: DraftCell<ManagerDraft>;
  /** Only an explicit start/retry/Inspect returning Starting may call this method. */
  readonly observeLaunch: (
    initial: Launch,
    inspect: (capturedPlan: LaunchPlan, signal: AbortSignal) => Promise<HttpResult<Launch>>,
  ) => void;
  readonly stopObservingLaunch: (intention: Identifier) => void;
  /** Stops inspection reads only; it never stops or claims ownership of a daemon. */
  readonly dispose: () => void;
}
function cell<T>(
  initial: T,
  check: (value: T) => string | null,
  changed?: (previous: T, next: T) => void,
): DraftCell<T> {
  let state = initial;
  let selection = {};
  let issue: string | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    issue: () => issue,
    captureSelection: () => {
      const captured = selection;
      return { isCurrent: () => selection === captured };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (next) => {
      const value = typeof next === "function" ? (next as (previous: T) => T)(state) : next;
      selection = {};
      issue = check(value);
      if (issue === null) {
        changed?.(state, value);
        state = value;
      }
      for (const listener of listeners) listener();
      return issue === null;
    },
  };
}
function bounded(values: readonly string[]): string | null {
  return values.reduce((total, value) => total + value.length, 0) > 2 * 1024 * 1024
    ? "Retained draft exceeds the two-million-character editing budget. Your previous draft was preserved; shorten this field before continuing."
    : null;
}

/** One browser launch owns this store outside React. No persistence or automatic execution/retry. */
export function createConnectionDraftStore(): ConnectionDraftStore {
  const progress = createProgressObserver();
  let disposed = false;
  let planSelection = {};
  let owner: {
    readonly plan: LaunchPlan;
    readonly hash: string;
    readonly executable: string;
    readonly selection: object;
  } | null = null;
  const older = (left: string, right: string) =>
    left.length < right.length || (left.length === right.length && left < right);
  const value: ConnectionDraftStore = {
    editor: cell<LifecycleEditor | null>(null, (value) => {
      return value === null ? null : bounded(Object.values(value.fields));
    }),
    manager: cell<ManagerDraft>(
      {
        profileId: null,
        savedProfile: null,
        draft: { id: "", label: "", socket: "", previous: null },
        registry: "",
        log: "",
        seconds: "15",
        frozen: null,
        launch: null,
        launchObservation: undefined,
        stop: null,
        notice: "",
        busy: false,
        unexpected: null,
      },
      (value) =>
        bounded([
          value.draft.id,
          value.draft.label,
          value.draft.socket,
          value.registry,
          value.log,
          value.seconds,
        ]),
      (previous, next) => {
        if (previous.frozen !== next.frozen) planSelection = {};
      },
    ),
    observeLaunch: (initial, inspect) => {
      if (disposed || initial.state.status !== "starting") return;
      const retained = value.manager.get();
      if (retained.frozen === null || !sameLaunchPlan(retained.frozen, initial.plan)) return;
      if (owner?.plan.intention_id === initial.plan.intention_id) {
        // Same-key starts coalesce without replacing the reader or extending its deadline.
        if (
          !sameLaunchPlan(owner.plan, initial.plan) ||
          owner.hash !== initial.input_hash ||
          owner.executable !== initial.executable
        )
          value.manager.set((previous) => ({
            ...previous,
            notice:
              "A changed startup identity was rejected; the original observation was retained.",
          }));
        return;
      }
      if (
        retained.launch !== null &&
        retained.launch.plan.intention_id === initial.plan.intention_id
      ) {
        if (
          !sameLaunchPlan(retained.launch.plan, initial.plan) ||
          retained.launch.input_hash !== initial.input_hash ||
          retained.launch.executable !== initial.executable ||
          (initial.revision === retained.launch.revision &&
            initial.state.status !== retained.launch.state.status)
        ) {
          value.manager.set((previous) => ({
            ...previous,
            notice:
              "A changed startup identity or contradictory revision was rejected; the original observation was retained.",
          }));
          return;
        }
        if (
          older(initial.revision, retained.launch.revision) ||
          retained.launch.state.status === "ready"
        )
          return;
      }
      if (owner !== null) progress.stop(owner.plan.intention_id);
      const plan: LaunchPlan = Object.freeze({
        ...initial.plan,
        connection: Object.freeze({ ...initial.plan.connection }),
        context: Object.freeze({
          ...initial.plan.context,
          writer:
            initial.plan.context.writer === null
              ? null
              : Object.freeze({ ...initial.plan.context.writer }),
        }),
      });
      value.manager.set((previous) => ({
        ...previous,
        frozen: plan,
        launch: Object.freeze({ ...initial, plan, state: Object.freeze({ ...initial.state }) }),
        launchObservation: undefined,
      }));
      const captured = {
        plan,
        hash: initial.input_hash,
        executable: initial.executable,
        selection: planSelection,
      };
      owner = captured;
      const current = () =>
        !disposed &&
        owner === captured &&
        planSelection === captured.selection &&
        value.manager.get().frozen === plan;
      progress.start(plan.intention_id, {
        changed: (launchObservation) => {
          if (owner === captured && value.manager.get().frozen === plan)
            value.manager.set((previous) => ({ ...previous, launchObservation }));
          if (launchObservation.kind === "stopped" && owner === captured) owner = null;
        },
        unexpected: (error) => {
          if (planSelection === captured.selection && value.manager.get().frozen === plan)
            value.manager.set((previous) => ({ ...previous, unexpected: { error } }));
        },
        inspect: async (signal) => {
          if (!current()) return "unknown";
          const latest = value.manager.get().launch;
          if (latest?.state.status !== "starting")
            return latest?.state.status === "outcome_unknown" ? "unknown" : "complete";
          const result = await inspect(plan, signal);
          if (signal.aborted || !current()) return "unknown";
          const previous = value.manager.get().launch;
          if (previous?.state.status !== "starting")
            return previous?.state.status === "outcome_unknown" ? "unknown" : "complete";
          if (!result.ok) {
            value.manager.set((state) => ({
              ...state,
              notice: `${failureText(result.failure)} The last startup observation was retained; no startup was retried.`,
            }));
            return "error";
          }
          const next = result.data;
          if (
            !sameLaunchPlan(next.plan, plan) ||
            next.input_hash !== captured.hash ||
            next.executable !== captured.executable ||
            (next.revision === previous.revision && next.state.status !== previous.state.status)
          ) {
            value.manager.set((state) => ({
              ...state,
              notice:
                "A changed startup identity or contradictory revision was rejected; the last observation was retained.",
            }));
            return "error";
          }
          if (older(next.revision, previous.revision)) return "pending";
          value.manager.set((state) => ({
            ...state,
            launch: Object.freeze({ ...next, plan, state: Object.freeze({ ...next.state }) }),
          }));
          return next.state.status === "starting"
            ? "pending"
            : next.state.status === "outcome_unknown"
              ? "unknown"
              : "complete";
        },
      });
    },
    stopObservingLaunch: (intention) => progress.stop(intention),
    dispose: () => {
      disposed = true;
      progress.dispose();
    },
  };
  return value;
}
