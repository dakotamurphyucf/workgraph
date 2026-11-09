import { createRequestWaitController } from "./wait/controller";
import type { FeatureContext } from "../../../app/types";
import type { Identifier, ReadInvocation } from "../../../core/protocol/types";
import { refreshSlots, createReadSlot, type ReadSlot } from "../../../core/state/read-slot";
import { ActionInputError } from "../../work/actions/model";
import { failureText } from "../../connections/failure";
import { capture, complete, endpoint, identity, sameEndpoint } from "../threads/model";
import { continued, invocation, loadGuards, locate, protocol, read, selectorKey } from "./client";
import {
  id as validId,
  inputBytes,
  MAX_DRAFT_BYTES,
  MAX_DRAFTS,
  MAX_TOTAL_BYTES,
  preparation,
  RequestsInputError,
  text,
} from "./model";
import type {
  DraftGuards,
  InboxFilter,
  ReadCapture,
  RequestFilter,
  RequestsController,
  RequestsDraft,
  RequestsInput,
  RequestsOptions,
  RequestsRead,
  RequestsState,
} from "./types";
const emptyGuards = (): DraftGuards => ({
  request: undefined,
  thread: undefined,
  comment: undefined,
  team: undefined,
  subscription: undefined,
  inbox: undefined,
});
export function defaultFilter(context: FeatureContext): RequestFilter {
  return {
    scope:
      context.route.projectId === null
        ? null
        : { kind: "project", id: validId(context.route.projectId, "Selected project") },
    threadId: "",
    ticketId: "",
    resolverId: "",
    recipient: null,
    responsible: null,
    kind: "all",
    priority: "",
    openOnly: false,
    unanswered: false,
    overdueAtUnixMs: "",
    relatedToId: "",
    supersedesId: "",
    supersededById: "",
  };
}
export function retainedInbox(value: InboxFilter): InboxFilter {
  return Object.freeze({
    consumerId: value.consumerId,
    recipient: { ...value.recipient },
    after: value.after,
    through: value.through,
    kinds: [...value.kinds],
    ticketId: value.ticketId,
    excludeSelf: value.excludeSelf,
  });
}
/** Launch-owned drafts and original intentions outlive mounted views. Read jobs
 * are cancellable; admitted mutations belong exclusively to shared operations. */
export function createRequestsController({
  http,
  operations,
}: RequestsOptions): RequestsController {
  const waiter = createRequestWaitController({ http });
  const listeners = new Set<() => void>(),
    slots = new Map<RequestsRead["kind"], ReadSlot<ReadCapture>>(),
    confirmed = new Map<RequestsRead["kind"], ReadCapture>(),
    requests = new Map<RequestsRead["kind"], { selector: string; request: ReadInvocation }>(),
    guards = new Map<Identifier, AbortController>(),
    flights = new Map<Identifier, Promise<void>>();
  const initialInbox: InboxFilter = {
    consumerId: identity("ui-inbox"),
    recipient: { kind: "actor", id: "" },
    after: "0",
    through: "",
    kinds: [],
    ticketId: "",
    excludeSelf: false,
  };
  let state: RequestsState = Object.freeze<RequestsState>({
      endpoint: null,
      target: null,
      historicalGeneration: false,
      unavailable: null,
      issue: null,
      unexpected: null,
      filter: {
        scope: null,
        threadId: "",
        ticketId: "",
        resolverId: "",
        recipient: null,
        responsible: null,
        kind: "all",
        priority: "",
        openOnly: false,
        unanswered: false,
        overdueAtUnixMs: "",
        relatedToId: "",
        supersedesId: "",
        supersededById: "",
      },
      inboxFilter: initialInbox,
      reads: new Map(),
      selectors: new Map(),
      drafts: [],
      selectedDraftId: null,
    }),
    context: FeatureContext | null = null,
    scopeKey: string | null = null,
    disposed = false;
  const emit = (patch: Partial<RequestsState>) => {
    if (disposed) return;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener();
  };
  const find = (id: Identifier) => state.drafts.find((draft) => draft.id === id);
  const patch = (id: Identifier, change: Partial<RequestsDraft>) =>
    emit({
      drafts: Object.freeze(
        state.drafts.map((draft) =>
          draft.id === id ? Object.freeze({ ...draft, ...change }) : draft,
        ),
      ),
    });
  const fail = (id: Identifier | null, error: unknown) => {
    const change =
      error instanceof ActionInputError ? { issue: error.message } : { unexpected: { error } };
    if (id === null) emit(change);
    else patch(id, change);
  };
  const cancelGuard = (id: Identifier) => {
    const old = guards.get(id);
    guards.delete(id);
    old?.abort();
  };
  const resetReads = (retain: readonly RequestsRead["kind"][] = []) => {
    for (const [kind, slot] of slots) {
      if (retain.includes(kind)) continue;
      slot.dispose();
      slots.delete(kind);
      confirmed.delete(kind);
      requests.delete(kind);
    }
  };
  const freeze = (input: RequestsInput): RequestsInput => Object.freeze(structuredClone(input));
  const room = (id: Identifier | null, input: RequestsInput) => {
    const bytes = inputBytes(input);
    if (
      bytes > MAX_DRAFT_BYTES ||
      state.drafts.reduce(
        (sum, draft) => sum + (draft.id === id ? 0 : inputBytes(draft.input)),
        bytes,
      ) > MAX_TOTAL_BYTES
    )
      throw new RequestsInputError(
        "This edit exceeds the retained composer budget. Shorten it or discard another editor; previous text was preserved.",
      );
  };
  const retain = (id: Identifier) => {
    const saved = operations.get(id);
    patch(id, {
      phase:
        saved === undefined
          ? { kind: "editing" }
          : { kind: "captured", preparation: saved.preparation },
    });
  };
  function review(id: Identifier): Promise<void> {
    if (disposed) return Promise.resolve();
    const prior = flights.get(id);
    if (prior !== undefined) return prior;
    const draft = find(id);
    if (draft === undefined) return Promise.resolve();
    cancelGuard(id);
    const task = Promise.resolve().then(async () => {
      try {
        let managed = operations.get(id);
        if (managed === undefined) {
          patch(id, { phase: { kind: "capturing" }, issue: null, unexpected: null });
          const abort = new AbortController();
          guards.set(id, abort);
          const loaded = await loadGuards(http, draft, abort.signal);
          if (
            disposed ||
            abort.signal.aborted ||
            guards.get(id) !== abort ||
            find(id)?.editRevision !== draft.editRevision
          )
            return;
          guards.delete(id);
          if (!loaded.ok) {
            patch(id, { phase: { kind: "editing" }, issue: failureText(loaded.failure) });
            return;
          }
          patch(id, { guards: loaded.data });
          const registered = await operations.register(
            preparation({ ...draft, guards: loaded.data }),
          );
          if (disposed || find(id) === undefined) return;
          if (!registered.ok) {
            retain(id);
            patch(id, { issue: failureText(registered.failure) });
            return;
          }
          managed = registered.entry;
        }
        patch(id, {
          phase: { kind: "captured", preparation: managed.preparation },
          issue: null,
          unexpected: null,
        });
        if (managed.operation !== null && managed.operation.state.kind !== "prepared_unsent")
          return;
        const prepared = await operations.act(id, "prepare");
        if (!disposed && find(id) !== undefined && !prepared.ok)
          patch(id, { issue: failureText(prepared.failure) });
      } catch (error: unknown) {
        if (!disposed && find(id) !== undefined) {
          retain(id);
          fail(id, error);
        }
      } finally {
        flights.delete(id);
      }
    });
    flights.set(id, task);
    return task;
  }
  return {
    waiter,
    refreshLive: (signal) => refreshSlots([...slots.values()], signal),
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open: (next, target, entering = false) => {
      if (disposed) return;
      const previousContext = context;
      context = next;
      try {
        const selected = target ?? null,
          current = endpoint(next),
          effective =
            selected === null
              ? current
              : {
                  connectionId: selected.connectionId,
                  generation: selected.generation,
                  workspaceId: selected.workspaceId,
                };
        if (
          effective.connectionId !== current.connectionId ||
          effective.workspaceId !== current.workspaceId
        )
          throw new RequestsInputError(
            "This Requests link does not match the selected connection and workspace.",
          );
        waiter.select(
          selected?.kind === "request" && selected.revision === null
            ? { ...effective, requestId: selected.requestId }
            : null,
        );
        const key = JSON.stringify([
          effective,
          selected,
          selected === null || selected.kind === "requests" || selected.kind === "request"
            ? next.route.projectId
            : null,
        ]);
        if (
          key === scopeKey &&
          !(entering && selected?.kind === "inbox" && selected.capture === null)
        ) {
          const historicalGeneration = effective.generation !== current.generation;
          if (state.historicalGeneration !== historicalGeneration) emit({ historicalGeneration });
          return;
        }
        const endpointChanged = state.endpoint === null || !sameEndpoint(state.endpoint, effective);
        const sameCollection =
          !endpointChanged &&
          previousContext?.route.projectId === next.route.projectId &&
          (selected?.kind === "requests" || selected?.kind === "request") &&
          (state.target?.kind === "requests" || state.target?.kind === "request");
        scopeKey = key;
        const retain: readonly RequestsRead["kind"][] = sameCollection ? ["requests"] : [];
        resetReads(retain);
        emit({
          endpoint: effective,
          target: selected,
          historicalGeneration: effective.generation !== current.generation,
          unavailable: null,
          issue: null,
          unexpected: null,
          reads: new Map([...state.reads].filter(([kind]) => retain.includes(kind))),
          selectors: new Map([...state.selectors].filter(([kind]) => retain.includes(kind))),
          filter:
            selected?.kind === "thread_requests"
              ? { ...defaultFilter(next), scope: null, threadId: selected.threadId }
              : sameCollection
                ? state.filter
                : defaultFilter(next),
          inboxFilter:
            selected?.kind === "inbox" && selected.capture !== null
              ? Object.freeze(retainedInbox(selected.capture))
              : selected?.kind === "inbox"
                ? retainedInbox({
                    ...initialInbox,
                    recipient: { kind: "actor", id: next.writer.actorId ?? "" },
                  })
                : endpointChanged
                  ? initialInbox
                  : state.inboxFilter,
        });
      } catch (error: unknown) {
        waiter.select(null);
        resetReads();
        scopeKey = null;
        emit({
          endpoint: null,
          target: null,
          reads: new Map(),
          selectors: new Map(),
          unavailable:
            error instanceof RequestsInputError ? error.message : "Requests could not be opened.",
          ...(error instanceof RequestsInputError ? {} : { unexpected: { error } }),
        });
      }
    },
    filter: (value) => {
      if (disposed) return;
      try {
        if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 16384)
          throw new RequestsInputError("Request filters exceed the local input budget.");
        emit({ filter: Object.freeze(structuredClone(value)), issue: null });
      } catch (error: unknown) {
        fail(null, error);
      }
    },
    inboxFilter: (value) => {
      if (disposed) return;
      if (state.target?.kind === "inbox" && state.target.capture !== null) {
        emit({
          issue:
            "This link retains its original recipient, consumer and filters. Open a new Inbox view to change them.",
        });
        return;
      }
      try {
        for (const [label, value_] of [
          ["Consumer", value.consumerId],
          ["Recipient", value.recipient.id],
          ["Ticket filter", value.ticketId],
        ] as const)
          text(value_, label, 96, false);
        text(value.after, "After", 19, false);
        text(value.through, "Through", 19, false);
        emit({ inboxFilter: Object.freeze(structuredClone(value)), issue: null });
      } catch (error: unknown) {
        fail(null, error);
      }
    },
    read: async (selector, page) => {
      const e = state.endpoint,
        owner = scopeKey;
      if (disposed || e === null || owner === null) return;
      const selectedNotification =
        state.target?.kind === "inbox" ? state.target.capture?.notificationId : undefined;
      const kind = selector.kind,
        selectorIdentity = selectorKey(selector);
      let slot = slots.get(kind);
      if (slot === undefined) {
        slot = createReadSlot<ReadCapture>();
        slots.set(kind, slot);
        const location = slot;
        slot.subscribe(() => {
          if (slots.get(kind) === location)
            emit({ reads: new Map(state.reads).set(kind, location.get()) });
        });
      }
      emit({
        selectors: new Map(state.selectors).set(kind, Object.freeze(structuredClone(selector))),
      });
      const saved = confirmed.get(kind),
        last = requests.get(kind),
        key = JSON.stringify([e, selectorIdentity]);
      try {
        await slot.load(
          key,
          async (signal) => {
            if (
              selector.kind === "inbox" &&
              state.target?.kind === "inbox" &&
              state.target.capture !== null &&
              selectorKey({
                kind: "inbox",
                filter: retainedInbox(state.target.capture),
                wait: selector.wait,
              }) !== selectorIdentity
            )
              return protocol(
                "A retained Inbox link cannot inherit another consumer, recipient or filter.",
              );
            let request: ReadInvocation;
            if (page === "repeat") {
              if (last === undefined || last.selector !== selectorIdentity)
                return protocol("There is no saved exact read for these selectors.");
              request = last.request;
            } else if (page !== undefined) {
              if (saved === undefined || selectorKey(saved.selector) !== selectorIdentity)
                return protocol("Load this exact selector before continuing it.");
              const next = await continued(http, saved, page, signal);
              if (!next.ok) return next;
              request = next.data;
            } else {
              try {
                request = invocation(e, selector);
              } catch (error: unknown) {
                if (error instanceof RequestsInputError)
                  return { ok: false, failure: { kind: "input", message: error.message } };
                throw error;
              }
            }
            if (signal.aborted || disposed || slots.get(kind) !== slot)
              return { ok: false, failure: { kind: "aborted" } };
            requests.set(kind, { selector: selectorIdentity, request });
            const first = await read(http, e, selector, request, signal);
            const result =
              first.ok && page === undefined
                ? await locate(http, first.data, signal, selectedNotification ?? undefined)
                : first;
            if (!signal.aborted && !disposed && slots.get(kind) === slot && result.ok) {
              confirmed.set(kind, result.data);
              requests.set(kind, {
                selector: selectorIdentity,
                request: result.data.captured.invocation,
              });
            }
            return result;
          },
          {
            live:
              page === undefined &&
              selector.kind !== "history" &&
              selector.kind !== "historical_comment" &&
              (selector.kind !== "inbox" || (!selector.wait && selector.filter.through === "")) &&
              !(state.target?.kind === "request" && state.target.revision !== null),
          },
        );
      } catch (error: unknown) {
        if (!disposed && slots.get(kind) === slot && error instanceof RequestsInputError)
          emit({ issue: error.message }); /* ReadSlot owns unexpected errors. */
      }
    },
    create: (input, inbox) => {
      if (disposed || context === null || state.endpoint === null) return null;
      try {
        if (state.drafts.length >= MAX_DRAFTS)
          throw new RequestsInputError(
            "At most 24 editors may remain open. Discard one explicitly; registered actions remain retained separately.",
          );
        if (state.target?.kind === "request" && state.target.revision !== null)
          throw new RequestsInputError(
            "This is a historical request snapshot. Open the current request explicitly before creating an action.",
          );
        room(null, input);
        const captured = capture(context, state.endpoint),
          id = identity("request");
        const draft: RequestsDraft = Object.freeze<RequestsDraft>({
          id,
          context: captured,
          endpoint: state.endpoint,
          input: freeze(input),
          guards: { ...emptyGuards(), inbox },
          editRevision: 0,
          phase: { kind: "editing" },
          issue: null,
          unexpected: null,
        });
        emit({
          drafts: Object.freeze([...state.drafts, draft]),
          selectedDraftId: id,
          issue: null,
          unexpected: null,
        });
        return id;
      } catch (error: unknown) {
        fail(null, error);
        return null;
      }
    },
    select: (id) => {
      if (!disposed && (id === null || find(id) !== undefined)) emit({ selectedDraftId: id });
    },
    edit: (id, input) => {
      const draft = find(id);
      if (disposed || draft === undefined) return;
      try {
        if (draft.phase.kind === "capturing" || draft.phase.kind === "captured" || flights.has(id))
          throw new RequestsInputError(
            "This original action is frozen or being prepared. Retain it for recovery and open a new editor explicitly.",
          );
        if (input.method !== draft.input.method)
          throw new RequestsInputError("An editor cannot silently change its action.");
        room(id, input);
        cancelGuard(id);
        patch(id, {
          input: freeze(input),
          guards: { ...emptyGuards(), inbox: draft.guards.inbox },
          editRevision: draft.editRevision + 1,
          phase: { kind: "editing" },
          issue: null,
          unexpected: null,
        });
      } catch (error: unknown) {
        fail(id, error);
      }
    },
    loadGuards: async (id) => {
      const draft = find(id);
      if (
        disposed ||
        draft === undefined ||
        draft.phase.kind === "capturing" ||
        draft.phase.kind === "captured" ||
        flights.has(id)
      )
        return;
      cancelGuard(id);
      const abort = new AbortController();
      guards.set(id, abort);
      patch(id, { phase: { kind: "loading" }, issue: null, unexpected: null });
      try {
        const loaded = await loadGuards(http, draft, abort.signal);
        if (
          disposed ||
          abort.signal.aborted ||
          guards.get(id) !== abort ||
          find(id)?.editRevision !== draft.editRevision
        )
          return;
        guards.delete(id);
        patch(
          id,
          loaded.ok
            ? { guards: loaded.data, phase: { kind: "editing" } }
            : { phase: { kind: "editing" }, issue: failureText(loaded.failure) },
        );
      } catch (error: unknown) {
        if (!disposed && !abort.signal.aborted && guards.get(id) === abort) {
          guards.delete(id);
          patch(id, { phase: { kind: "editing" } });
          fail(id, error);
        }
      }
    },
    fill: (id) => {
      const draft = find(id);
      if (disposed || draft === undefined) return;
      try {
        if (draft.phase.kind !== "editing" || flights.has(id))
          throw new RequestsInputError("Wait for the current read. Frozen actions cannot change.");
        let input = draft.input;
        if (input.method === "team.put" && input.existing) {
          const team = draft.guards.team;
          if (team === undefined || team.value.id !== input.teamId || !complete(team))
            throw new RequestsInputError(
              "Load the complete current team before copying its configuration.",
            );
          input = { ...input, title: team.value.title, members: team.value.members };
        } else if (input.method === "subscription.put" && input.existing) {
          const sub = draft.guards.subscription;
          if (sub === undefined || sub.value.id !== input.subscriptionId || !complete(sub))
            throw new RequestsInputError(
              "Load the complete current subscription before copying its configuration.",
            );
          input = {
            ...input,
            recipient: sub.value.recipient,
            filter: {
              scope: sub.value.filter.scope,
              threadId: sub.value.filter.threadId ?? "",
              kinds: sub.value.filter.kinds,
            },
            active: sub.value.active,
          };
        } else
          throw new RequestsInputError(
            "Only an explicitly loaded team or subscription can populate this editor.",
          );
        room(id, input);
        patch(id, {
          input: freeze(input),
          editRevision: draft.editRevision + 1,
          issue: null,
          unexpected: null,
        });
      } catch (error: unknown) {
        fail(id, error);
      }
    },
    review,
    close: (id) => {
      if (disposed) return;
      if (flights.has(id)) {
        fail(
          id,
          new RequestsInputError(
            "Wait for this original action's preparation to settle before discarding its editor.",
          ),
        );
        return;
      }
      cancelGuard(id);
      emit({
        drafts: Object.freeze(state.drafts.filter((draft) => draft.id !== id)),
        selectedDraftId: state.selectedDraftId === id ? null : state.selectedDraftId,
      });
    },
    dispose: () => {
      waiter.dispose();
      resetReads();
      for (const abort of guards.values()) abort.abort();
      guards.clear();
      disposed = true;
      listeners.clear();
    },
  };
}
