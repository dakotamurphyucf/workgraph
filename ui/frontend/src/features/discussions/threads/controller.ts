import type { FeatureContext } from "../../../app/types";
import type { Identifier, ReadInvocation } from "../../../core/protocol/types";
import { refreshSlots, createReadSlot, type ReadSlot } from "../../../core/state/read-slot";
import { failureText } from "../../connections/failure";
import { continued, invocation, loadGuards, protocol, read, selectorKey } from "./client";
import {
  capture,
  complete,
  endpoint,
  identity,
  inputBytes,
  MAX_DRAFT_BYTES,
  MAX_DRAFTS,
  MAX_TOTAL_BYTES,
  preparation,
  sameEndpoint,
  ThreadsInputError,
  validId,
  text,
} from "./model";
import type {
  DiscussionTarget,
  MessageFilter,
  ReadCapture,
  ThreadsController,
  ThreadsDraft,
  ThreadsInput,
  ThreadsOptions,
  ThreadsRead,
  ThreadsState,
} from "./types";

export function receivedFilter(
  target: DiscussionTarget | null,
  fallback: MessageFilter,
): MessageFilter {
  if (target?.kind !== "direct_messages" || target.capture === null) return fallback;
  const value = target.capture;
  return Object.freeze({
    consumerId: value.consumerId,
    recipient: value.recipient,
    after: value.after,
    through: value.through,
    ticketId: value.ticketId ?? "",
    excludeSelf: value.excludeSelf,
  });
}
/** Launch-owned immutable intentions and cancellable reads. Changing views or
 * writers cannot cancel a native write or retarget an existing composer. */
export function createThreadsController({ http, operations }: ThreadsOptions): ThreadsController {
  const listeners = new Set<() => void>(),
    slots = new Map<ThreadsRead["kind"], ReadSlot<ReadCapture>>(),
    confirmed = new Map<ThreadsRead["kind"], ReadCapture>(),
    requests = new Map<ThreadsRead["kind"], { selector: string; request: ReadInvocation }>(),
    guards = new Map<Identifier, AbortController>(),
    flights = new Map<Identifier, Promise<void>>();
  const initialMessages = Object.freeze<MessageFilter>({
    consumerId: identity("ui-received"),
    recipient: { kind: "actor", id: "" },
    after: "0",
    through: "",
    ticketId: "",
    excludeSelf: false,
  });
  let state: ThreadsState = Object.freeze<ThreadsState>({
      endpoint: null,
      historicalGeneration: false,
      target: null,
      unavailable: null,
      issue: null,
      unexpected: null,
      filter: {
        scope: null,
        boardId: "",
        actorId: "",
        status: "all",
        unresolved: false,
        text: "",
        pageSize: "25",
      },
      messageFilter: initialMessages,
      reads: new Map(),
      selectors: new Map(),
      drafts: [],
      selectedDraftId: null,
    }),
    context: FeatureContext | null = null,
    scopeKey: string | null = null,
    disposed = false;
  const emit = (patch: Partial<ThreadsState>) => {
    if (disposed) return;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener();
  };
  const find = (id: Identifier) => state.drafts.find((draft) => draft.id === id);
  const patch = (id: Identifier, change: Partial<ThreadsDraft>) =>
    emit({
      drafts: Object.freeze(
        state.drafts.map((draft) =>
          draft.id === id ? Object.freeze({ ...draft, ...change }) : draft,
        ),
      ),
    });
  const fail = (id: Identifier | null, error: unknown) => {
    const change =
      error instanceof ThreadsInputError ? { issue: error.message } : { unexpected: { error } };
    if (id === null) emit(change);
    else patch(id, change);
  };
  const cancelGuard = (id: Identifier) => {
    const previous = guards.get(id);
    guards.delete(id);
    previous?.abort();
  };
  const room = (id: Identifier | null, input: ThreadsInput) => {
    const bytes = inputBytes(input);
    if (
      bytes > MAX_DRAFT_BYTES ||
      state.drafts.reduce(
        (sum, draft) => sum + (draft.id === id ? 0 : inputBytes(draft.input)),
        bytes,
      ) > MAX_TOTAL_BYTES
    )
      throw new ThreadsInputError(
        "This edit exceeds the retained composer budget. Shorten it or discard another editor; your previous text was preserved.",
      );
  };
  const freeze = (input: ThreadsInput): ThreadsInput => Object.freeze(structuredClone(input));
  const resetReads = (retain: readonly ThreadsRead["kind"][] = []) => {
    for (const [kind, slot] of slots) {
      if (retain.includes(kind)) continue;
      slot.dispose();
      slots.delete(kind);
      confirmed.delete(kind);
      requests.delete(kind);
    }
  };
  const retain = (id: Identifier) => {
    const managed = operations.get(id);
    patch(id, {
      phase:
        managed === undefined
          ? { kind: "editing" }
          : { kind: "captured", preparation: managed.preparation },
    });
  };
  async function prepare(id: Identifier, post: boolean): Promise<void> {
    if (disposed) return;
    const previous = flights.get(id);
    if (previous !== undefined) return previous;
    const draft = find(id);
    if (draft === undefined) return;
    if (post && !["thread.reply", "comment.add", "message.send"].includes(draft.input.method)) {
      fail(
        id,
        new ThreadsInputError("Review metadata and destructive actions before applying them."),
      );
      return;
    }
    if (post && draft.posted) {
      fail(
        id,
        new ThreadsInputError(
          "Post was already attempted for this original action. Inspect its retained outcome; exact retry is a separate deliberate action.",
        ),
      );
      return;
    }
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
          const frozen = preparation({ ...draft, guards: loaded.data });
          const registered = await operations.register(frozen);
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
        if (managed.operation !== null && managed.operation.state.kind !== "prepared_unsent") {
          if (post)
            patch(id, {
              issue:
                "This original action was already admitted or rejected. Inspect the retained operation; no additional write was sent.",
            });
          return;
        }
        const prepared = await operations.act(id, "prepare");
        if (disposed || find(id) === undefined) return;
        if (!prepared.ok) {
          patch(id, { issue: failureText(prepared.failure) });
          return;
        }
        if (!post) return;
        if (prepared.entry.operation?.state.kind !== "prepared_unsent") {
          patch(id, {
            issue:
              "Preparation did not confirm the original action as unsent. Inspect it before taking another action.",
          });
          return;
        }
        patch(id, { posted: true });
        const sent = await operations.act(id, "execute");
        if (!disposed && find(id) !== undefined && !sent.ok)
          patch(id, { issue: failureText(sent.failure) });
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
    refreshLive: (signal) => refreshSlots([...slots.values()], signal),
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open: (next, target) => {
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
          throw new ThreadsInputError(
            "This discussion link does not match the selected connection and workspace.",
          );
        const key = JSON.stringify([
          effective,
          selected,
          selected?.kind === "direct_messages" ? null : next.route.projectId,
        ]);
        if (key === scopeKey) {
          const historicalGeneration = effective.generation !== current.generation;
          if (state.historicalGeneration !== historicalGeneration) emit({ historicalGeneration });
          return;
        }
        const endpointChanged = state.endpoint === null || !sameEndpoint(state.endpoint, effective);
        const sameCollection =
          !endpointChanged &&
          previousContext?.route.projectId === next.route.projectId &&
          selected?.kind !== "direct_messages" &&
          state.target?.kind !== "direct_messages" &&
          // Returning to All discussions deliberately leaves the board collection.
          (selected !== null || state.filter.boardId === "") &&
          (selected?.kind !== "board" || selected.boardId === state.filter.boardId);
        scopeKey = key;
        const retain: readonly ThreadsRead["kind"][] = sameCollection ? ["boards", "threads"] : [];
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
          filter: sameCollection
            ? state.filter
            : {
                scope:
                  selected?.kind !== "direct_messages" && next.route.projectId !== null
                    ? { kind: "project", id: validId(next.route.projectId, "Selected project") }
                    : null,
                boardId: selected?.kind === "board" ? selected.boardId : "",
                actorId: "",
                status: "all",
                unresolved: false,
                text: "",
                pageSize: "25",
              },
          messageFilter: receivedFilter(
            selected,
            endpointChanged
              ? initialMessages
              : selected?.kind === "direct_messages" && selected.capture === null
                ? {
                    ...state.messageFilter,
                    consumerId: initialMessages.consumerId,
                    after: "0",
                    through: "",
                  }
                : state.messageFilter,
          ),
        });
      } catch (error: unknown) {
        resetReads();
        scopeKey = null;
        emit({
          endpoint: null,
          target: null,
          reads: new Map(),
          selectors: new Map(),
          unavailable:
            error instanceof ThreadsInputError
              ? error.message
              : "Discussion link could not be opened.",
          ...(error instanceof ThreadsInputError ? {} : { unexpected: { error } }),
        });
      }
    },
    filter: (value) => {
      if (disposed) return;
      try {
        text(value.text, "Thread search", 512, false);
        text(value.boardId, "Board filter", 96, false);
        text(value.actorId, "Actor filter", 96, false);
        emit({ filter: Object.freeze(structuredClone(value)), issue: null });
      } catch (error: unknown) {
        fail(null, error);
      }
    },
    messageFilter: (value) => {
      if (disposed) return;
      if (state.target?.kind === "direct_messages" && state.target.capture !== null) {
        emit({
          issue:
            "This link retains its original recipient, consumer and filters. Open a new received-message view to change them.",
        });
        return;
      }
      try {
        text(value.consumerId, "Browser consumer", 96, false);
        text(value.recipient.id, "Recipient", 96, false);
        text(value.ticketId, "Ticket filter", 96, false);
        text(value.after, "Notification counter", 19, false);
        text(value.through, "Notification counter", 19, false);
        emit({ messageFilter: Object.freeze(structuredClone(value)), issue: null });
      } catch (error: unknown) {
        fail(null, error);
      }
    },
    read: async (selector, page) => {
      const e = state.endpoint,
        owner = scopeKey;
      if (disposed || e === null || owner === null) return;
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
        last = requests.get(kind);
      const key = JSON.stringify([e, selectorIdentity]);
      try {
        await slot.load(
          key,
          async (signal) => {
            if (
              kind === "messages" &&
              state.target?.kind === "direct_messages" &&
              state.target.capture !== null &&
              selector.kind === "messages" &&
              selectorKey({
                kind: "messages",
                filter: receivedFilter(state.target, initialMessages),
              }) !== selectorIdentity
            )
              return protocol("Retained message link cannot inherit another recipient or filter.");
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
                if (error instanceof ThreadsInputError)
                  return { ok: false, failure: { kind: "input", message: error.message } };
                throw error;
              }
            }
            if (signal.aborted || disposed || slots.get(kind) !== slot)
              return { ok: false, failure: { kind: "aborted" } };
            requests.set(kind, { selector: selectorIdentity, request });
            const result = await read(http, e, selector, request, signal);
            if (!signal.aborted && !disposed && slots.get(kind) === slot && result.ok)
              confirmed.set(kind, result.data);
            return result;
          },
          {
            live:
              page === undefined &&
              selector.kind !== "thread_history" &&
              selector.kind !== "comment_history" &&
              (selector.kind !== "messages" || selector.filter.through === ""),
          },
        );
      } catch (error: unknown) {
        if (error instanceof ThreadsInputError)
          emit({
            issue: error.message,
          }); /* ReadSlot retains unexpected failures visibly; promise is owned here. */
      }
    },
    create: (input) => {
      if (disposed || context === null || state.endpoint === null) return null;
      try {
        if (state.drafts.length >= MAX_DRAFTS)
          throw new ThreadsInputError(
            "At most 24 editors may remain open. Discard one explicitly; registered operations remain retained separately.",
          );
        room(null, input);
        const captured = capture(context, state.endpoint),
          id = identity("discussion");
        const draft = Object.freeze<ThreadsDraft>({
          id,
          context: captured,
          endpoint: state.endpoint,
          input: freeze(input),
          guards: { board: undefined, thread: undefined, comment: undefined },
          editRevision: 0,
          phase: { kind: "editing" },
          issue: null,
          unexpected: null,
          posted: false,
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
          throw new ThreadsInputError(
            "This original action is frozen or being prepared. Preserve it for recovery and open a new editor explicitly.",
          );
        if (input.method !== draft.input.method)
          throw new ThreadsInputError("An editor cannot silently change its action.");
        room(id, input);
        cancelGuard(id);
        patch(id, {
          input: freeze(input),
          guards: { board: undefined, thread: undefined, comment: undefined },
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
        const result = await loadGuards(http, draft, abort.signal);
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
          result.ok
            ? { guards: result.data, phase: { kind: "editing" } }
            : { phase: { kind: "editing" }, issue: failureText(result.failure) },
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
          throw new ThreadsInputError(
            "Wait for the current read. Frozen actions cannot be changed.",
          );
        const { board, thread, comment } = draft.guards;
        if ([board, thread, comment].some((value) => value !== undefined && !complete(value)))
          throw new ThreadsInputError(
            "The loaded record has omissions. Your text was preserved; do not replace it with a clipped preview.",
          );
        let input = draft.input;
        if (input.method === "board.put" && input.existing && board?.value.id === input.fields.id)
          input = {
            ...input,
            fields: { id: board.value.id, title: board.value.title, scope: board.value.scope },
          };
        else if (
          input.method === "thread.put" &&
          input.existing &&
          thread?.value.id === input.fields.id
        ) {
          const value = thread.value;
          input = {
            ...input,
            fields: {
              id: value.id,
              boardId: value.boardId,
              title: value.title,
              participants: value.participants.join("\n"),
              mentions: value.mentions.join("\n"),
              links: value.links.map((link) => ({
                kind: link.kind,
                id: link.kind === "workspace" ? "" : link.id,
              })),
              status: value.status,
              closurePolicy: value.closurePolicy,
              pinned: value.pinned,
            },
          };
        } else if (input.method === "comment.edit" && comment?.value.id === input.commentId)
          input = { ...input, body: comment.value.body };
        else
          throw new ThreadsInputError(
            "Load this editor's current board, thread or comment before copying it.",
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
    review: (id) => prepare(id, false),
    post: (id) => prepare(id, true),
    close: (id) => {
      if (disposed) return;
      if (flights.has(id)) {
        fail(
          id,
          new ThreadsInputError(
            "Wait for this action to finish preparation. Its original identity is retained.",
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
      resetReads();
      for (const abort of guards.values()) abort.abort();
      guards.clear();
      disposed = true;
      listeners.clear();
    },
  };
}
