import * as d from "../../../../core/protocol/decoders";
import { sameEndpoint } from "../../threads/model";
import { observeRequest, requestWaitPlan, sameRequestWait } from "./client";
import type {
  RequestWaitController,
  RequestWaitObservation,
  RequestWaitOptions,
  RequestWaitPlan,
  RequestWaitState,
} from "./types";
interface Flight {
  readonly plan: RequestWaitPlan;
  readonly abort: AbortController;
  readonly done: Promise<void>;
}
function last(state: RequestWaitState): RequestWaitObservation | null {
  return state.kind === "idle" ? null : state.kind === "stopped" ? state.observation : state.last;
}
export function createRequestWaitController({ http }: RequestWaitOptions): RequestWaitController {
  let state: RequestWaitState = Object.freeze({ kind: "idle" }),
    active: Flight | null = null,
    disposed = false;
  const listeners = new Set<() => void>();
  const emit = (next: RequestWaitState) => {
    if (disposed) return;
    state = Object.freeze(next);
    for (const listener of listeners) listener();
  };
  const stop = () => {
    const previous = active;
    if (previous === null || disposed) return;
    active = null;
    previous.abort.abort();
    emit({ kind: "cancelled_locally", plan: previous.plan, last: last(state) });
  };
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start(input) {
      if (disposed) return Promise.resolve();
      if (active !== null && sameRequestWait(active.plan, input)) return active.done;
      const parsed = requestWaitPlan.decode(
        d.jsonObject([
          ["connectionId", d.jsonString(input.connectionId)],
          ["generation", d.jsonString(input.generation)],
          ["workspaceId", d.jsonString(input.workspaceId)],
          ["requestId", d.jsonString(input.requestId)],
          ["timeoutMs", d.jsonString(input.timeoutMs)],
          ["pollIntervalMs", d.jsonString(input.pollIntervalMs)],
        ]),
      );
      if (!parsed.ok) {
        stop();
        emit({
          kind: "failed",
          plan: input,
          last: null,
          failure: {
            kind: "input",
            message: `Invalid foreground wait ${parsed.issue.path.join(".")}: ${parsed.issue.expected}.`,
          },
        });
        return Promise.resolve();
      }
      const plan = parsed.value,
        previous = last(state),
        retained =
          previous !== null &&
          sameEndpoint(plan, previous.plan) &&
          plan.requestId === previous.plan.requestId
            ? previous
            : null;
      active?.abort.abort();
      const abort = new AbortController();
      // The microtask begins after ownership is installed, including reentrant subscribers.
      const done = Promise.resolve().then(async () => {
        if (disposed || active !== owner || abort.signal.aborted) return;
        try {
          const response = await observeRequest(http, plan, abort.signal);
          if (disposed || active !== owner || abort.signal.aborted) return;
          active = null;
          if (response.ok) emit({ kind: "stopped", plan, observation: response.data });
          else if (response.failure.kind === "aborted")
            emit({ kind: "cancelled_locally", plan, last: retained });
          else emit({ kind: "failed", plan, last: retained, failure: response.failure });
        } catch (error: unknown) {
          if (disposed || active !== owner || abort.signal.aborted) return;
          active = null;
          // The owned view throws this exact unexpected failure at its React boundary.
          emit({ kind: "unexpected_error", plan, last: retained, error });
        }
      });
      const owner: Flight = { plan, abort, done };
      active = owner;
      emit({ kind: "waiting", plan, last: retained });
      return done;
    },
    stop,
    select(target) {
      if (
        active !== null &&
        (target === null ||
          !sameEndpoint(active.plan, target) ||
          active.plan.requestId !== target.requestId)
      )
        stop();
    },
    dispose() {
      active?.abort.abort();
      active = null;
      disposed = true;
      listeners.clear();
    },
  };
}
