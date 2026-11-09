import { jsonField } from "../../../core/json";
import * as c from "../../../core/protocol/codec";
import { fields, leaseCodec } from "./codecs";
import { decodeContention } from "./contention";
import * as d from "../../../core/protocol/decoders";
import type { Identifier } from "../../../core/protocol/types";
import { refreshSlots, createReadSlot } from "../../../core/state/read-slot";
import { createProgressObserver } from "../../../core/state/progress-observer";
import { failureText } from "../../connections/failure";
import { captureInput, inputWeight, MAX_RETAINED_INPUT_BYTES } from "./capture";
import {
  createCoordinationClient,
  invocation,
  complete,
  LISTS,
  type CoordinationList,
} from "./client";
import {
  capture,
  scope,
  counter,
  identifier,
  MAX_DRAFTS,
  CoordinationInputError,
  target,
} from "./model";
import { prepareCommand } from "./prepare";
import { createWaitClient } from "./waits";
import type {
  ContentionPage,
  CoordinationController,
  CoordinationDraft,
  CoordinationOptions,
  CoordinationPage,
  CoordinationState,
  WaitJob,
  WaitLimits,
} from "./types";

const METHODS = {
  records: null,
  allocation: "allocation.pools",
  reservations: "reservation.list",
  conditions: "condition.list",
  recovery: "recovery.list",
} as const;
export function createCoordinationController({
  http,
  operations,
}: CoordinationOptions): CoordinationController {
  const api = createCoordinationClient(http),
    waits = createWaitClient(http),
    page = createReadSlot<CoordinationPage>(),
    contention = createReadSlot<ContentionPage>(),
    opening = new Set<AbortController>(),
    waitReads = new Set<AbortController>(),
    observer = createProgressObserver(),
    listeners = new Set<() => void>(),
    jobs = new Map<Identifier, AbortController>(),
    waitActions = new Set<Identifier>();
  let disposed = false,
    loadedWaits = false;
  let waitListOwner: AbortController | null = null;
  let selectedMethod: CoordinationList | null = null,
    selectedCondition: string | undefined;
  let state: CoordinationState = {
    scope: null,
    tab: "records",
    page: page.get(),
    contention: contention.get(),
    drafts: [],
    selectedDraftId: null,
    waits: [],
    waitPage: null,
    waitsLoading: false,
    waitObservations: new Map(),
    issue: null,
    unexpected: null,
  };
  const emit = (change: Partial<CoordinationState>) => {
    if (disposed) return;
    state = Object.freeze({ ...state, ...change });
    for (const listener of listeners) listener();
  };
  const find = (id: Identifier) => state.drafts.find((draft) => draft.id === id);
  const patch = (id: Identifier, change: Partial<CoordinationDraft>) =>
    emit({
      drafts: Object.freeze(
        state.drafts.map((draft) =>
          draft.id === id ? Object.freeze({ ...draft, ...change }) : draft,
        ),
      ),
    });
  const admitInput = (input: import("./types").CoordinationInput, replacing?: Identifier) => {
    const owned = captureInput(input);
    const retained = state.drafts.reduce(
      (sum, draft) => sum + (draft.id === replacing ? 0 : inputWeight(draft.input)),
      inputWeight(owned),
    );
    if (retained > MAX_RETAINED_INPUT_BYTES)
      throw new CoordinationInputError(
        "Coordination drafts exceed the shared 16 MiB retained-input budget. Close an unsent draft first.",
      );
    return owned;
  };
  const fail = (error: unknown, id: Identifier | null = null) => {
    const change =
      error instanceof CoordinationInputError
        ? { issue: error.message }
        : { unexpected: { error } };
    if (id === null) emit(change);
    else patch(id, change);
  };
  const run = (promise: Promise<unknown>, id: Identifier | null = null) => {
    void promise.catch((error) => fail(error, id));
  };
  page.subscribe(() => emit({ page: page.get() }));
  contention.subscribe(() => emit({ contention: contention.get() }));
  const adopt = (job: WaitJob) => {
    const old = state.waits.find((value) => value.id === job.id);
    if (old !== undefined) {
      if (old.inputHash !== job.inputHash)
        throw new Error("Saved wait changed its original complete plan.");
      if (BigInt(old.revision) > BigInt(job.revision)) return;
      if (BigInt(old.revision) === BigInt(job.revision)) return;
      if (
        old.state.kind !== "running" &&
        old.state.kind !== "prepared_unsent" &&
        job.state.kind === "prepared_unsent"
      )
        throw new Error("Saved wait regressed to unsent.");
      if (old.state.kind === "completed" && job.state.kind !== "completed")
        throw new Error("Known acquired wait cannot regress.");
    }
    emit({ waits: Object.freeze([...state.waits.filter((value) => value.id !== job.id), job]) });
  };
  const observe = (job: WaitJob) => {
    if (job.state.kind !== "running") return;
    const captured = job;
    observer.start(job.id, {
      inspect: async (signal) => {
        const result = await waits.inspect(captured.id, signal);
        if (signal.aborted || disposed) return "unknown";
        if (!result.ok) {
          emit({ issue: failureText(result.failure) });
          return "error";
        }
        if (result.data.id !== captured.id || result.data.inputHash !== captured.inputHash)
          throw new Error("Wait observation changed its captured identity.");
        adopt(result.data);
        return result.data.state.kind === "running"
          ? "pending"
          : result.data.state.kind === "outcome_unknown"
            ? "unknown"
            : "complete";
      },
      changed: (status) => {
        const next = new Map(state.waitObservations);
        next.set(job.id, status);
        emit({ waitObservations: next });
      },
      unexpected: (error) => fail(error),
    });
  };
  const loadWaits = async (offset = counter("0")) => {
    if (disposed || waitListOwner !== null) return;
    const owner = new AbortController();
    waitListOwner = owner;
    waitReads.add(owner);
    emit({ waitsLoading: true });
    try {
      const result = await waits.list(offset, owner.signal);
      if (disposed || owner.signal.aborted) return;
      if (!result.ok) {
        emit({ issue: failureText(result.failure) });
        return;
      }
      for (const job of result.data.items) adopt(job);
      emit({
        waitPage: Object.freeze({
          offset: result.data.offset,
          remaining: result.data.remaining,
          nextOffset: result.data.next_offset,
        }),
      });
    } finally {
      waitReads.delete(owner);
      if (waitListOwner === owner) {
        waitListOwner = null;
        emit({ waitsLoading: false });
      }
    }
  };
  const load = async (request?: import("../../../core/protocol/types").ReadInvocation) => {
    const selected = state.scope,
      method = selectedMethod ?? METHODS[state.tab];
    if (selected === null || method === null || disposed) return;
    const query =
      request ??
      invocation(selected, method, [
        ["limit", d.jsonString("100")],
        ["max_bytes", d.jsonString("1048576")],
        ...(selectedCondition === undefined
          ? []
          : [["condition_id", d.jsonString(identifier(selectedCondition))] as const]),
      ]);
    // The slot owns current unexpected errors and obsolete-rejection fencing.
    await page
      .load(
        JSON.stringify([
          selected.connection.id,
          selected.connection.generation,
          selected.workspaceId,
          query.method,
          query.params,
        ]),
        (signal) => api.page(selected, query, signal),
        { live: request === undefined },
      )
      .catch(() => undefined);
  };
  const loadContention = async (
    request: import("../../../core/protocol/types").ReadInvocation,
    live = true,
  ) => {
    const selected = state.scope;
    if (selected === null || disposed) return;
    await contention
      .load(
        JSON.stringify([
          selected.connection.id,
          selected.connection.generation,
          selected.workspaceId,
          request.params,
        ]),
        async (signal) => {
          const response = await api.read(request, signal);
          return response.ok ? decodeContention(selected, request, response.data) : response;
        },
        { live },
      )
      .catch(() => undefined);
  };
  const review = async (id: Identifier, limits: WaitLimits | null) => {
    const draft = find(id);
    if (draft === undefined || disposed || jobs.has(id) || draft.phase.kind !== "editing") return;
    if (limits !== null && draft.input.kind !== "acquire") {
      fail(new CoordinationInputError("Only an acquisition can use bounded wait."), id);
      return;
    }
    const capturedLimits = limits === null ? null : Object.freeze({ ...limits });
    const owner = new AbortController();
    jobs.set(id, owner);
    patch(id, { phase: { kind: "capturing" }, issue: null, unexpected: null });
    let admitted = false;
    try {
      const preparation = await prepareCommand(draft, api, owner.signal);
      if (disposed || owner.signal.aborted || jobs.get(id) !== owner) return;
      if (capturedLimits !== null) {
        counter(capturedLimits.timeoutMs, 300000n, 1000n);
        counter(capturedLimits.maxAttempts, 100n, 1n);
        counter(capturedLimits.waitSliceMs, 25000n, 1n);
        // Freeze the alternate path before a POST can have been admitted. A lost
        // response can be inspected/reprepared with these same inputs only.
        admitted = true;
        patch(id, {
          phase: { kind: "wait_prepared", preparation, jobId: id, limits: capturedLimits },
        });
        const result = await waits.prepare(preparation, capturedLimits, draft.scope.connection);
        if (disposed) return;
        if (!result.ok) throw new CoordinationInputError(failureText(result.failure));
        adopt(result.data);
      } else {
        const result = await operations.register(preparation);
        if (!result.ok) throw new CoordinationInputError(failureText(result.failure));
        admitted = true;
        if (disposed) return;
        patch(id, { phase: { kind: "registered", preparation } });
        const resultPrepare = await operations.act(id, "prepare");
        if (!resultPrepare.ok && !disposed)
          throw new CoordinationInputError(failureText(resultPrepare.failure));
      }
    } catch (error) {
      if (!disposed && !owner.signal.aborted) {
        fail(error, id);
        if (!admitted) patch(id, { phase: { kind: "editing" } });
      }
    } finally {
      if (jobs.get(id) === owner) jobs.delete(id);
    }
  };
  return {
    refreshLive: (signal) => refreshSlots([page, contention], signal),
    get: () => state,
    subscribe: (listener) => {
      if (disposed) throw new Error("Coordination controller disposed.");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    select: (context) => {
      try {
        if (
          context.route.participant !== undefined &&
          context.route.participant.generation !== context.connection.generation
        ) {
          page.clear();
          contention.clear();
          emit({
            scope: null,
            issue:
              "This exact run link retains an older endpoint generation. Open Coordination at the current endpoint explicitly; no IDs were moved.",
          });
          return;
        }
        const desired = scope(context),
          key = JSON.stringify([
            desired.connection.id,
            desired.connection.generation,
            desired.workspaceId,
            desired.projectId,
          ]);
        const prior = state.scope;
        if (
          prior !== null &&
          JSON.stringify([
            prior.connection.id,
            prior.connection.generation,
            prior.workspaceId,
            prior.projectId,
          ]) === key
        )
          return;
        page.clear();
        contention.clear();
        selectedMethod = null;
        selectedCondition = undefined;
        emit({ scope: desired, issue: null, unexpected: null });
        run(load());
        if (!loadedWaits) {
          loadedWaits = true;
          run(loadWaits());
        }
      } catch (error) {
        fail(error);
      }
    },
    tab: (tab) => {
      page.clear();
      selectedMethod = null;
      selectedCondition = undefined;
      emit({ tab, issue: null });
      run(load());
    },
    refresh: () => {
      run(load());
    },
    refreshWaits: () => {
      run(loadWaits());
    },
    nextWaits: () => {
      const offset = state.waitPage?.nextOffset;
      if (offset !== null && offset !== undefined) run(loadWaits(offset));
    },
    next: () => {
      const current = page.get();
      if (current.kind === "ready" && current.value.continuation !== null)
        run(load(current.value.continuation));
    },
    browse: (method, conditionId) => {
      try {
        if (!LISTS.includes(method)) throw new CoordinationInputError("Unknown coordination list.");
        if (method === "condition.signals" && conditionId === undefined)
          throw new CoordinationInputError("Choose an actual condition before reading signals.");
        selectedMethod = method;
        selectedCondition =
          method === "condition.signals" ? identifier(conditionId ?? "") : undefined;
        page.clear();
        run(load());
      } catch (error) {
        fail(error);
      }
    },
    inspectContention: (input) => {
      try {
        if (state.scope === null) return;
        const request = invocation(state.scope, "reservation.contention", [
          ["target", target(input)],
          ["include_inactive", d.jsonBoolean(true)],
          ["limit", d.jsonString("100")],
          ["max_bytes", d.jsonString("1048576")],
        ]);
        run(loadContention(request));
      } catch (error) {
        fail(error);
      }
    },
    nextContention: () => {
      const value = contention.get();
      if (value.kind === "ready" && value.value.continuation !== null)
        run(loadContention(value.value.continuation, false));
    },
    openTicketRecovery: async (context, ticket) => {
      const owner = new AbortController();
      opening.add(owner);
      try {
        const saved = capture(context),
          ticketId = identifier(ticket);
        const result = await api.read(
          invocation(saved.scope, "ticket.read", [["ticket_id", d.jsonString(ticketId)]]),
          owner.signal,
        );
        if (disposed || owner.signal.aborted) return;
        if (!result.ok) throw new CoordinationInputError(failureText(result.failure));
        const budget = complete(result.data),
          record = fields({
            ticket_id: d.identifier,
            revision: d.positiveDecimal,
            project_id: c.nullable(d.identifier),
            claim: c.nullable(
              fields({
                actor_id: d.identifier,
                run_id: c.nullable(d.identifier),
                token: d.positiveDecimal,
                lease: leaseCodec,
              }),
            ),
          }).decode(jsonField(result.data.response.data, "ticket"));
        if (
          !budget.ok ||
          !budget.data ||
          !record.ok ||
          record.value.ticket_id !== ticketId ||
          record.value.claim === null
        )
          throw new CoordinationInputError(
            "A complete actual claimed ticket capture is required for recovery.",
          );
        const value = record.value,
          claim = value.claim!;
        if (state.drafts.length >= MAX_DRAFTS)
          throw new CoordinationInputError(
            "Close an unsent draft before opening another (24 maximum).",
          );
        const id = identifier(`coord-${crypto.randomUUID()}`),
          input = admitInput({
            kind: "recover",
            recovery: {
              kind: "ticket",
              recoveryId: `recovery-${crypto.randomUUID()}`,
              confirmation: "",
              reason: "",
              evidence: [],
              disposition: "preserve_status",
              fence: {
                scope: saved.scope,
                ticketId,
                ticketRevision: value.revision,
                projectId: value.project_id,
                actorId: claim.actor_id,
                runId: claim.run_id,
                token: claim.token,
                lease: claim.lease,
                response: result.data,
              },
            },
          });
        emit({
          drafts: Object.freeze([
            ...state.drafts,
            Object.freeze({
              id,
              ...saved,
              input,
              phase: { kind: "editing" as const },
              issue: null,
              unexpected: null,
            }),
          ]),
          selectedDraftId: id,
        });
      } catch (error) {
        if (!disposed && !owner.signal.aborted) fail(error);
      } finally {
        opening.delete(owner);
      }
    },
    open: (context, input) => {
      try {
        if (state.drafts.length >= MAX_DRAFTS)
          throw new CoordinationInputError(
            "Close an unsent draft before opening another (24 maximum).",
          );
        const saved = capture(context),
          owned = admitInput(input),
          id = identifier(`coord-${crypto.randomUUID()}`);
        emit({
          drafts: Object.freeze([
            ...state.drafts,
            Object.freeze({
              id,
              ...saved,
              input: owned,
              phase: { kind: "editing" as const },
              issue: null,
              unexpected: null,
            }),
          ]),
          selectedDraftId: id,
        });
      } catch (error) {
        fail(error);
      }
    },
    edit: (id, input) => {
      const draft = find(id);
      if (draft === undefined || draft.phase.kind !== "editing") return;
      try {
        if (input.kind !== draft.input.kind)
          throw new CoordinationInputError("Retained draft cannot switch action identity.");
        patch(id, { input: admitInput(input, id), issue: null, unexpected: null });
      } catch (error) {
        fail(error, id);
      }
    },
    review: (id) => review(id, null),
    prepareWait: async (id, limits) => {
      const draft = find(id);
      if (draft?.phase.kind !== "wait_prepared") return review(id, limits);
      if (disposed || jobs.has(id)) return;
      const phase = draft.phase;
      if (
        phase.limits.timeoutMs !== limits.timeoutMs ||
        phase.limits.maxAttempts !== limits.maxAttempts ||
        phase.limits.waitSliceMs !== limits.waitSliceMs
      ) {
        fail(
          new CoordinationInputError(
            "An admitted wait keeps its original limits. Recheck only the exact saved preparation.",
          ),
          id,
        );
        return;
      }
      const owner = new AbortController();
      jobs.set(id, owner);
      patch(id, { issue: null, unexpected: null });
      try {
        // Repeating prepare only deduplicates this complete immutable helper plan;
        // it never starts a flight or creates an ordinary operation.
        const result = await waits.prepare(phase.preparation, phase.limits, draft.scope.connection);
        if (disposed || owner.signal.aborted || jobs.get(id) !== owner) return;
        if (!result.ok) throw new CoordinationInputError(failureText(result.failure));
        adopt(result.data);
      } catch (error) {
        if (!disposed && !owner.signal.aborted) fail(error, id);
      } finally {
        if (jobs.get(id) === owner) jobs.delete(id);
      }
    },
    chooseDraft: (id) => emit({ selectedDraftId: id }),
    discard: (id) => {
      const draft = find(id);
      if (draft === undefined || draft.phase.kind !== "editing") return;
      emit({
        drafts: Object.freeze(state.drafts.filter((value) => value.id !== id)),
        selectedDraftId: state.selectedDraftId === id ? null : state.selectedDraftId,
      });
    },
    actWait: async (id, action) => {
      if (disposed || waitActions.has(id)) return;
      waitActions.add(id);
      if (action === "inspect") observer.stop(id);
      const reader = action === "inspect" ? new AbortController() : null;
      if (reader !== null) waitReads.add(reader);
      try {
        const result =
          action === "inspect"
            ? await waits.inspect(id, reader?.signal)
            : await waits.act(id, action);
        if (disposed) return;
        if (!result.ok) {
          emit({ issue: failureText(result.failure) });
          return;
        }
        if (result.data.id !== id) throw new Error("Wait action returned another identity.");
        adopt(result.data);
        if (action !== "inspect") observe(result.data);
      } catch (error) {
        fail(error);
      } finally {
        if (reader !== null) waitReads.delete(reader);
        waitActions.delete(id);
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const owner of jobs.values()) owner.abort();
      jobs.clear();
      for (const owner of opening) owner.abort();
      opening.clear();
      for (const owner of waitReads) owner.abort();
      waitReads.clear();
      observer.dispose();
      contention.dispose();
      page.dispose();
      listeners.clear();
    },
  };
}
