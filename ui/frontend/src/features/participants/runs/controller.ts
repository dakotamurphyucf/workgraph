import * as d from "../../../core/protocol/decoders";
import type { ReadInvocation, Identifier } from "../../../core/protocol/types";
import { refreshSlots, createReadSlot } from "../../../core/state/read-slot";
import { createConnectionsClient } from "../../connections/client";
import { failureText } from "../../connections/failure";
import { createParticipantsClient, invocation, invalid } from "./client";
import {
  capture,
  counter,
  identifier,
  initialInput,
  inputBytes,
  MAX_DRAFT_BYTES,
  MAX_DRAFTS,
  MAX_TOTAL_BYTES,
  ParticipantsInputError,
  prepareDraft,
  target,
  targetKey,
  readRequest,
} from "./model";
import type {
  ParticipantsController,
  ParticipantsDetail,
  ParticipantsDraft,
  ParticipantsOptions,
  ParticipantsPage,
  ParticipantsState,
  ParticipantsTarget,
  SessionPage,
} from "./types";

export function createParticipantsController({
  http,
  operations,
}: ParticipantsOptions): ParticipantsController {
  const api = createParticipantsClient(http),
    page = createReadSlot<ParticipantsPage>(),
    detail = createReadSlot<ParticipantsDetail>(),
    sessions = createReadSlot<SessionPage>(),
    listeners = new Set<() => void>(),
    jobs = new Map<Identifier, AbortController>();
  let disposed = false,
    epoch = 0,
    selectedOwner: AbortController | null = null;
  let state: ParticipantsState = {
    target: null,
    historicalGeneration: false,
    panel: "runs",
    filter: { actorId: "", runId: "", ticketId: "" },
    page: page.get(),
    detail: detail.get(),
    sessions: sessions.get(),
    drafts: [],
    selectedDraftId: null,
    issue: null,
    unexpected: null,
  };
  const publish = (patch: Partial<ParticipantsState>) => {
    if (disposed) return;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener();
  };
  const find = (id: Identifier) => state.drafts.find((draft) => draft.id === id);
  const patch = (id: Identifier, change: Partial<ParticipantsDraft>) =>
    publish({
      drafts: Object.freeze(
        state.drafts.map((draft) =>
          draft.id === id ? Object.freeze({ ...draft, ...change }) : draft,
        ),
      ),
    });
  const failure = (error: unknown, id: Identifier | null = null) => {
    const value =
      error instanceof ParticipantsInputError
        ? { issue: error.message }
        : { unexpected: { error } };
    if (id === null) publish(value);
    else patch(id, value);
  };
  const run = (promise: Promise<unknown>, valid: () => boolean = () => true) => {
    const capturedEpoch = epoch;
    void promise.catch((error) => {
      if (!disposed && epoch === capturedEpoch && valid()) failure(error);
    });
  };
  page.subscribe(() => publish({ page: page.get() }));
  detail.subscribe(() => publish({ detail: detail.get() }));
  sessions.subscribe(() => publish({ sessions: sessions.get() }));
  const current = <T>(slot: import("../../../core/state/read-slot").ReadSlot<T>): T | undefined => {
    const value = slot.get();
    return value.kind === "ready" ? value.value : undefined;
  };
  // ReadSlot publishes current unexpected errors and fences obsolete ones. Its
  // rejection is handled here without creating a second, unfenced error owner.
  const ownedRead = async (promise: Promise<unknown>): Promise<void> => {
    await promise.catch(() => undefined);
  };
  async function load(scope = state.target, request?: ReadInvocation) {
    if (scope === null || disposed) return;
    let query: ReadInvocation;
    try {
      query = request ?? readRequest(scope, state.panel, state.filter);
    } catch (error) {
      // A selector that cannot form a query must not display another view's page.
      page.clear();
      failure(error);
      return;
    }
    await ownedRead(
      page.load(
        JSON.stringify([targetKey(scope), query.method, query.params]),
        (signal) => api.page(scope, query, signal),
        { live: request === undefined },
      ),
    );
  }
  async function loadDetail(scope: ParticipantsTarget) {
    const s = scope.selection;
    if (s.kind !== "run" && s.kind !== "attempt") return;
    const method = s.kind === "run" ? "run.get" : "attempt.get",
      id = s.kind === "run" ? s.runId : s.attemptId;
    await ownedRead(
      detail.load(
        `${targetKey(scope)}:${method}`,
        (signal) => api.detail(scope, method, id, signal),
        { live: true },
      ),
    );
  }
  const room = (input: ParticipantsDraft["input"], id: Identifier | null) => {
    const size = inputBytes(input);
    if (
      size > MAX_DRAFT_BYTES ||
      state.drafts.reduce(
        (sum, draft) => sum + (draft.id === id ? 0 : inputBytes(draft.input)),
        size,
      ) > MAX_TOTAL_BYTES
    )
      throw new ParticipantsInputError(
        "Retained forms exceed the local editor budget. Close an unsent draft; admitted operations remain saved separately.",
      );
  };
  return {
    refreshLive: (signal) => refreshSlots([page, detail, sessions], signal),
    get: () => state,
    subscribe: (listener) => {
      if (disposed) throw new Error("Participants controller disposed.");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    select: (context, selection, generation) => {
      try {
        const desired = target(context, selection),
          requested =
            generation ??
            (context.route.participant === undefined
              ? desired.connection.generation
              : counter(context.route.participant.generation, true));
        const scope = Object.freeze({
          ...desired,
          connection: Object.freeze({ ...desired.connection, generation: requested }),
        });
        if (state.target !== null && targetKey(state.target) === targetKey(scope)) {
          const historicalGeneration = requested !== context.connection.generation;
          if (state.historicalGeneration !== historicalGeneration)
            publish({ historicalGeneration });
          return;
        }
        epoch++;
        const identity = epoch;
        const old = state.target;
        const changedScope =
          old === null ||
          old.connection.id !== scope.connection.id ||
          old.connection.generation !== scope.connection.generation ||
          old.workspaceId !== scope.workspaceId ||
          old.projectId !== scope.projectId;
        if (changedScope) publish({ filter: { actorId: "", runId: "", ticketId: "" } });
        selectedOwner?.abort();
        selectedOwner = new AbortController();
        const owner = selectedOwner;
        page.clear();
        detail.clear();
        sessions.clear();
        publish({
          target: scope,
          historicalGeneration: requested !== context.connection.generation,
          issue: null,
          unexpected: null,
          panel:
            scope.selection.kind === "actor"
              ? "actor-overview"
              : scope.selection.kind === "attempt"
                ? "attempts"
                : scope.selection.kind === "run"
                  ? "runs"
                  : state.panel,
        });
        run(
          (async () => {
            let resolved = scope;
            if (requested !== context.connection.generation) {
              const result = await createConnectionsClient(http).attach(
                scope.connection,
                owner.signal,
              );
              if (disposed || epoch !== identity || owner.signal.aborted) return;
              if (!result.ok) {
                await detail.load(targetKey(scope), () => Promise.resolve(result));
                return;
              }
              if (
                result.data.connection.id !== scope.connection.id ||
                result.data.connection.generation !== requested
              ) {
                await detail.load(targetKey(scope), () =>
                  Promise.resolve(invalid("Retained profile resolution changed its identity.")),
                );
                return;
              }
              resolved = Object.freeze({ ...scope, connection: result.data.connection });
              publish({ target: resolved });
            }
            if (disposed || epoch !== identity || owner.signal.aborted) return;
            await Promise.all([load(resolved), loadDetail(resolved)]);
          })(),
          () => epoch === identity && !owner.signal.aborted,
        );
      } catch (error) {
        failure(error);
      }
    },
    panel: (value) => {
      publish({ panel: value, issue: null });
      run(load());
    },
    filter: (filter) => publish({ filter: Object.freeze({ ...filter }) }),
    refresh: () => {
      sessions.clear();
      publish({ issue: null });
      run(load());
      if (state.target !== null) run(loadDetail(state.target));
    },
    continuePage: (kind) => {
      const result = current(page),
        request = kind === "next" ? result?.continuation : result?.retry;
      if (result !== undefined && request !== null && request !== undefined)
        run(load(result.target, request));
    },
    nextSessions: () => {
      const scope = state.target,
        record = current(detail),
        prior = current(sessions);
      if (scope === null || record?.value.kind !== "run") return;
      const next =
        prior === undefined
          ? record.value.run.session_associations.next_request
          : prior.next_request;
      if (next === null) return;
      const request = invocation(
        scope,
        "run.sessions",
        Object.entries(next.params)
          .filter(([key]) => key !== "workspace_id")
          .map(([key, value]) => [key, value === null ? d.jsonNull() : d.jsonString(value)]),
      );
      void ownedRead(
        sessions.load(JSON.stringify([targetKey(scope), next.params]), (signal) =>
          api.sessions(scope, request, signal),
        ),
      );
    },
    open: (context, method) => {
      try {
        if (state.drafts.length >= MAX_DRAFTS)
          throw new ParticipantsInputError(
            "Close an unsent draft before opening another form (24 maximum).",
          );
        const saved = capture(context, state.target),
          input = initialInput(method, saved);
        room(input, null);
        const draft: ParticipantsDraft = Object.freeze({
          id: identifier(`participants-${crypto.randomUUID()}`),
          capture: saved,
          input: Object.freeze(input),
          phase: { kind: "editing" as const },
          issue: null,
          unexpected: null,
        });
        publish({
          drafts: Object.freeze([...state.drafts, draft]),
          selectedDraftId: draft.id,
          issue: null,
          unexpected: null,
        });
      } catch (error) {
        failure(error);
      }
    },
    edit: (id, input) => {
      try {
        const draft = find(id);
        if (draft === undefined || draft.phase.kind !== "editing") return;
        if (input.method !== draft.input.method)
          throw new ParticipantsInputError("A retained draft cannot change its command identity.");
        room(input, id);
        patch(id, { input: Object.freeze({ ...input }), issue: null, unexpected: null });
      } catch (error) {
        failure(error, id);
      }
    },
    chooseDraft: (id) => publish({ selectedDraftId: id }),
    discard: (id) => {
      const draft = find(id);
      if (draft === undefined || draft.phase.kind !== "editing") return;
      jobs.get(id)?.abort();
      jobs.delete(id);
      publish({
        drafts: Object.freeze(state.drafts.filter((draft) => draft.id !== id)),
        selectedDraftId: state.selectedDraftId === id ? null : state.selectedDraftId,
      });
    },
    review: async (id) => {
      const draft = find(id);
      if (draft === undefined || draft.phase.kind !== "editing" || jobs.has(id) || disposed) return;
      const owner = new AbortController();
      jobs.set(id, owner);
      patch(id, { phase: { kind: "capturing" }, issue: null, unexpected: null });
      let registered = false;
      try {
        const preparation = await prepareDraft(draft, api, owner.signal);
        if (disposed || owner.signal.aborted || jobs.get(id) !== owner) return;
        const result = await operations.register(preparation);
        if (!result.ok) throw new ParticipantsInputError(failureText(result.failure));
        registered = true;
        if (disposed || owner.signal.aborted || jobs.get(id) !== owner) return;
        patch(id, { phase: { kind: "registered", preparation } });
        const prepared = await operations.act(id, "prepare");
        if (!prepared.ok && !disposed && !owner.signal.aborted)
          patch(id, { issue: failureText(prepared.failure) });
      } catch (error) {
        if (!disposed && !owner.signal.aborted) {
          failure(error, id);
          if (!registered) patch(id, { phase: { kind: "editing" } });
        }
      } finally {
        if (jobs.get(id) === owner) jobs.delete(id);
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      epoch++;
      selectedOwner?.abort();
      selectedOwner = null;
      for (const owner of jobs.values()) owner.abort();
      jobs.clear();
      page.dispose();
      detail.dispose();
      sessions.dispose();
      listeners.clear();
    },
  };
}
