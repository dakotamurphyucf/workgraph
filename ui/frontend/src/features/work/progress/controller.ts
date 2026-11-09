import * as d from "../../../core/protocol/decoders";
import { createOverviewClient, nextInvocation } from "../../overview/client";
import { digestInvocation, queryKey } from "../../overview/model";
import type { ActivityDigest, Observation, OverviewScope } from "../../overview/types";
import type { Decimal } from "../../../core/protocol/types";
import type { Identifier, ReadInvocation } from "../../../core/protocol/types";
import { jsonField } from "../../../core/json";
import {
  refreshSlots,
  createReadSlot,
  readKey,
  type ReadSlot,
} from "../../../core/state/read-slot";
import { failureText } from "../../connections/failure";
import { commentCodec, pageInvocation, pageKey, selectorKey, readGuards, readPage } from "./client";
import {
  captureProgress,
  freezeInput,
  identity,
  initialInput,
  inputBytes,
  MAX_DRAFT_BYTES,
  MAX_DRAFTS,
  MAX_TOTAL_BYTES,
  preparation,
  ProgressInputError,
} from "./model";
import type {
  ProgressController,
  ProgressDraft,
  ProgressInput,
  ProgressOptions,
  ProgressPage,
  ProgressState,
} from "./types";

/** Launch-owned drafts and read locations. UI disposal never owns a native send;
 * OperationController and its journal retain that service-owned lifetime. */
export function createWorkProgressController({
  client,
  operations,
}: ProgressOptions): ProgressController {
  let state: ProgressState = {
    drafts: [],
    selectedId: null,
    target: null,
    pages: {},
    recentComments: [],
    commentsCatchingUp: false,
    commentsIssue: null,
    issue: null,
    unexpected: null,
  };
  let disposed = false,
    scopeKey: string | null = null;
  const activity = createOverviewClient(client),
    recent = createReadSlot<Observation<ActivityDigest>>();
  let after: Decimal | null = null;
  const listeners = new Set<() => void>(),
    flights = new Map<Identifier, Promise<void>>(),
    posted = new Set<Identifier>(),
    guards = new Map<Identifier, AbortController>(),
    reads = new Map<string, ReadSlot<ProgressPage>>(),
    confirmedPages = new Map<string, ProgressPage>(),
    requests = new Map<string, { readonly selector: string; readonly request: ReadInvocation }>();
  const emit = (patch: Partial<ProgressState>) => {
    if (disposed) return;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener();
  };
  recent.subscribe(() => {
    const value = recent.get();
    if (value.kind === "failed") emit({ commentsIssue: failureText(value.failure) });
    else if (value.kind === "unexpected_error") emit({ unexpected: { error: value.error } });
    else if (value.kind === "ready" || value.kind === "idle") emit({ commentsIssue: null });
  });
  const find = (id: Identifier) => state.drafts.find((draft) => draft.id === id);
  const patch = (id: Identifier, update: Partial<ProgressDraft>) =>
    emit({
      drafts: Object.freeze(
        state.drafts.map((draft) =>
          draft.id === id ? Object.freeze({ ...draft, ...update }) : draft,
        ),
      ),
    });
  const cancelGuard = (id: Identifier) => {
    const pending = guards.get(id);
    guards.delete(id);
    pending?.abort();
  };
  const fail = (id: Identifier | null, error: unknown) => {
    const update =
      error instanceof ProgressInputError ? { issue: error.message } : { unexpected: { error } };
    if (id === null) emit(update);
    else patch(id, update);
  };
  const room = (id: Identifier | null, input: ProgressInput) => {
    const size = inputBytes(input);
    if (
      size > MAX_DRAFT_BYTES ||
      state.drafts.reduce(
        (total, draft) => total + (draft.id === id ? 0 : inputBytes(draft.input)),
        size,
      ) > MAX_TOTAL_BYTES
    )
      throw new ProgressInputError(
        "This edit exceeds the retained composer byte budget. Shorten it or close another editor; the previous text was preserved.",
      );
  };
  const retainPreparation = (id: Identifier) => {
    const retained = operations.get(id);
    if (retained !== undefined)
      patch(id, { phase: { kind: "captured", preparation: retained.preparation } });
    else patch(id, { phase: { kind: "editing" } });
  };
  const prepare = async (id: Identifier, post: boolean): Promise<void> => {
    if (disposed) return;
    const pending = flights.get(id);
    if (pending !== undefined) return pending;
    const draft = find(id);
    if (draft === undefined) return;
    if (post && posted.has(id)) {
      patch(id, {
        issue:
          "Post was already attempted for this original intention. Inspect its retained outcome; exact retry is a separate deliberate action. No additional write was sent.",
      });
      return;
    }
    if (post && draft.input.method !== "ticket.progress" && draft.input.method !== "comment.add") {
      fail(
        id,
        new ProgressInputError("Lifecycle actions require deliberate Review followed by Apply."),
      );
      return;
    }
    cancelGuard(id);
    // Install the shared promise before any asynchronous validation/transport.
    const task = Promise.resolve().then(async () => {
      try {
        let managed = operations.get(id);
        if (managed === undefined) {
          patch(id, { phase: { kind: "capturing" }, issue: null, unexpected: null });
          let guarded = draft;
          const input = draft.input;
          const missing =
            input.method === "handoff.set"
              ? draft.guards.handoff === undefined
              : input.method === "comment.edit" || input.method === "comment.tombstone"
                ? draft.guards.comment?.id !== input.commentId
                : input.method === "attempt.checkpoint" || input.method === "attempt.finish"
                  ? draft.guards.attempt?.id !== input.attemptId
                  : false;
          if (missing) {
            const abort = new AbortController();
            guards.set(id, abort);
            const loaded = await readGuards(client, draft, abort.signal);
            if (
              disposed ||
              abort.signal.aborted ||
              guards.get(id) !== abort ||
              find(id) === undefined
            )
              return;
            guards.delete(id);
            if (!loaded.ok) {
              patch(id, { phase: { kind: "editing" }, issue: failureText(loaded.failure) });
              return;
            }
            guarded = { ...draft, guards: loaded.data };
            patch(id, { guards: loaded.data });
          }
          const captured = preparation(guarded);
          const registered = await operations.register(captured);
          if (disposed || find(id) === undefined) return;
          if (!registered.ok) {
            retainPreparation(id);
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
        // A repeated explicit Post never resends an admitted/unknown/known write.
        // Exact retry remains an explicit shared operation action.
        if (managed.operation !== null && managed.operation.state.kind !== "prepared_unsent") {
          if (post)
            patch(id, {
              issue:
                managed.operation.state.kind === "committed" ||
                managed.operation.state.kind === "observed"
                  ? "This original action already has a known result; no additional write was sent."
                  : "This original action was already admitted or rejected. Inspect its retained operation and choose recovery or a new draft explicitly; no additional write was sent.",
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
              "Preparation did not confirm this original action as unsent; review its retained operation before any further action.",
          });
          return;
        }
        posted.add(id);
        const sent = await operations.act(id, "execute");
        if (!disposed && find(id) !== undefined && !sent.ok)
          patch(id, { issue: failureText(sent.failure) });
      } catch (error: unknown) {
        if (!disposed && find(id) !== undefined) {
          retainPreparation(id);
          fail(id, error);
        }
      } finally {
        flights.delete(id);
      }
    });
    flights.set(id, task);
    return task;
  };
  return {
    refreshLive: async (signal) => {
      const result = await refreshSlots([...reads.values()], signal);
      const target = state.target,
        owner = scopeKey;
      if (target === null || after === null || signal.aborted) return result;
      const scope: OverviewScope = { ...target.scope, actorId: null, runId: null };
      for (let page = 0; page < 4; page++) {
        if (signal.aborted || scopeKey !== owner) break;
        const observed = recent.get();
        const previous =
          observed.kind === "ready"
            ? observed.value
            : observed.kind === "idle"
              ? undefined
              : observed.previous;
        const next = previous?.value.hasMore ? nextInvocation(previous) : null;
        if (next && !next.ok) return { ok: false };
        const request = next?.ok
          ? next.data
          : digestInvocation(scope, {
              ticketId: target.ticket.value.ticket.ticket_id,
              after: previous?.value.capture.through ?? after,
              limit: "100",
              maxBytes: "1048576",
            });
        const read = await recent.load(
          queryKey(scope, request),
          (readSignal) => activity.digest(scope, request, readSignal),
          { signal, background: true, ...(previous === undefined ? {} : { previous }) },
        );
        if (!read.ok) return { ok: false };
        if (signal.aborted || scopeKey !== owner) break;
        const merged = new Map(state.recentComments.map((item) => [item.comment.id, item]));
        for (const entry of read.data.value.entries) {
          if (entry.item.kind !== "comment") continue;
          const decoded = commentCodec.decode(entry.item.record);
          if (!decoded.ok)
            throw new Error("Live comment digest did not preserve comment provenance.");
          const old = merged.get(decoded.value.id);
          if (!old || BigInt(decoded.value.revision) >= BigInt(old.comment.revision))
            merged.set(decoded.value.id, {
              comment: decoded.value,
              partial: entry.item.clipped.length > 0,
            });
        }
        emit({
          recentComments: [...merged.values()]
            .sort((a, b) =>
              BigInt(a.comment.sequence) > BigInt(b.comment.sequence)
                ? -1
                : BigInt(a.comment.sequence) < BigInt(b.comment.sequence)
                  ? 1
                  : 0,
            )
            .slice(0, 100),
          commentsCatchingUp: read.data.value.hasMore,
        });
        if (!read.data.value.hasMore) break;
      }
      return result;
    },
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open: (target) => {
      if (disposed) return;
      const key = JSON.stringify([
        target.scope.connection.id,
        target.scope.connection.generation,
        target.scope.workspaceId,
        target.ticket.value.ticket.ticket_id,
        target.scope.connection.socket,
      ]);
      if (key === scopeKey) {
        emit({ target });
        return;
      }
      scopeKey = key;
      after = null;
      recent.clear();
      for (const slot of reads.values()) slot.dispose();
      reads.clear();
      confirmedPages.clear();
      requests.clear();
      emit({
        target,
        pages: {},
        recentComments: [],
        commentsCatchingUp: false,
        issue: null,
        unexpected: null,
      });
    },
    create: (target, method) => {
      if (disposed) return null;
      try {
        if (state.drafts.length >= MAX_DRAFTS)
          throw new ProgressInputError(
            "At most 24 participation editors may remain open. Discard an editor explicitly; native operations remain available separately.",
          );
        const capture = captureProgress(target),
          input = freezeInput(initialInput(method));
        room(null, input);
        const id = identity("progress"),
          draft: ProgressDraft = Object.freeze<ProgressDraft>({
            id,
            capture,
            input,
            guards: { handoff: undefined, attempt: undefined, comment: undefined, reads: [] },
            phase: { kind: "editing" },
            issue: null,
            unexpected: null,
            editRevision: 0,
          });
        emit({
          drafts: Object.freeze([...state.drafts, draft]),
          selectedId: id,
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
      if (!disposed && (id === null || find(id) !== undefined))
        emit({ selectedId: id, issue: null });
    },
    copy: (id, target) => {
      const source = find(id);
      if (disposed || source === undefined) return null;
      try {
        if (flights.has(id) || operations.get(id)?.operation?.state.kind !== "rejected")
          throw new ProgressInputError(
            "Only a definitely rejected action can be copied here. Preserve uncertain work for inspection and exact retry.",
          );
        const old = source.capture;
        if (
          target.scope.connection.id !== old.connection.id ||
          target.scope.connection.generation !== old.connection.generation ||
          target.scope.workspaceId !== old.workspaceId ||
          target.ticket.value.ticket.ticket_id !== old.ticket.value.ticket.ticket_id
        )
          throw new ProgressInputError(
            "Return to this original ticket and endpoint before refreshing a rejected action.",
          );
        if (target.ticket.revision === old.ticket.revision)
          throw new ProgressInputError(
            "Refresh this selected ticket before copying its rejected action. The old operation and text remain unchanged.",
          );
        if (state.drafts.length >= MAX_DRAFTS)
          throw new ProgressInputError(
            "Discard an editor explicitly before opening another retained draft.",
          );
        room(null, source.input);
        const capture = captureProgress({
          ...target,
          context: { ...target.context, writer: old.writer },
        });
        const next: ProgressDraft = Object.freeze<ProgressDraft>({
          id: identity("progress"),
          capture,
          input: freezeInput(source.input),
          guards: { handoff: undefined, attempt: undefined, comment: undefined, reads: [] },
          phase: { kind: "editing" },
          issue: null,
          unexpected: null,
          editRevision: 0,
        });
        emit({
          drafts: Object.freeze([...state.drafts, next]),
          selectedId: next.id,
          issue: null,
          unexpected: null,
        });
        return next.id;
      } catch (error: unknown) {
        fail(id, error);
        return null;
      }
    },
    edit: (id, input) => {
      const draft = find(id);
      if (disposed || draft === undefined) return;
      if (draft.phase.kind === "capturing" || draft.phase.kind === "captured" || flights.has(id)) {
        fail(
          id,
          new ProgressInputError(
            "This original intention is being captured or is already frozen. Preserve it for recovery; open a new composer explicitly to change its text.",
          ),
        );
        return;
      }
      if (input.method !== draft.input.method) {
        fail(id, new ProgressInputError("A composer cannot silently change its method."));
        return;
      }
      try {
        room(id, input);
        cancelGuard(id);
        patch(id, {
          input: freezeInput(input),
          phase: { kind: "editing" },
          issue: null,
          unexpected: null,
          editRevision: draft.editRevision + 1,
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
        const result = await readGuards(client, draft, abort.signal);
        const current = find(id);
        if (
          disposed ||
          abort.signal.aborted ||
          guards.get(id) !== abort ||
          current?.editRevision !== draft.editRevision ||
          current.phase.kind !== "loading"
        )
          return;
        guards.delete(id);
        patch(
          id,
          result.ok
            ? { phase: { kind: "editing" }, guards: result.data, issue: null }
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
        if (flights.has(id) || draft.phase.kind !== "editing")
          throw new ProgressInputError(
            "Wait for the current record read, or open a new editable draft; frozen requests cannot be changed.",
          );
        if (
          draft.guards.reads.some((read) => {
            const budget = jsonField(read.response.meta, "budget");
            const truncated =
              budget?.kind === "object" ? jsonField(budget, "truncated") : undefined;
            return truncated?.kind === "boolean" && truncated.value;
          })
        )
          throw new ProgressInputError(
            "The loaded record has omissions. Do not replace your text with a clipped preview.",
          );
        let input: ProgressInput;
        if (
          draft.input.method === "handoff.set" &&
          draft.guards.handoff !== undefined &&
          draft.guards.handoff !== null
        ) {
          const value = draft.guards.handoff;
          input = {
            method: "handoff.set",
            fields: {
              summary: value.summary,
              nextSteps: value.nextSteps,
              evidence: value.evidence,
              objective: value.objective,
              completed: value.completed,
              decisions: value.decisions,
              blockers: value.blockers,
              resourceIds: value.resourceIds.join("\n"),
              coversThrough: value.coversThrough,
            },
          };
        } else if (
          draft.input.method === "comment.edit" &&
          draft.guards.comment?.id === draft.input.commentId
        )
          input = { ...draft.input, body: draft.guards.comment.body };
        else
          throw new ProgressInputError(
            "Load this existing comment or handoff before explicitly using its text.",
          );
        room(id, input);
        cancelGuard(id);
        patch(id, {
          input: freezeInput(input),
          issue: null,
          unexpected: null,
          editRevision: draft.editRevision + 1,
        });
      } catch (error: unknown) {
        fail(id, error);
      }
    },
    read: async (selector, page) => {
      const target = state.target;
      if (disposed || target === null) return;
      const location = pageKey(selector);
      let slot = reads.get(location);
      if (slot === undefined) {
        slot = createReadSlot<ProgressPage>();
        reads.set(location, slot);
        const owned = slot;
        slot.subscribe(() => {
          if (!disposed && reads.get(location) === owned) {
            const observed = owned.get();
            if (observed.kind === "ready") {
              confirmedPages.set(location, observed.value);
              if (after === null && selector.kind === "comments") {
                const revision = d.decimal.decode(
                  jsonField(observed.value.response.response.meta, "workspace_revision"),
                );
                if (revision.ok) after = revision.value;
              }
            }
            emit({ pages: Object.freeze({ ...state.pages, [location]: observed }) });
          }
        });
      }
      const old = slot.get(),
        previous =
          old.kind === "ready"
            ? old.value
            : ((old.kind === "idle" ? undefined : old.previous) ?? confirmedPages.get(location));
      try {
        const repeated = requests.get(location);
        const selected =
          page === "repeat"
            ? repeated?.selector === selectorKey(selector)
              ? { ok: true as const, data: repeated.request }
              : {
                  ok: false as const,
                  failure: {
                    kind: "input" as const,
                    message: "No matching captured read request is available to repeat.",
                  },
                }
            : pageInvocation(target, selector, previous, page);
        if (!selected.ok) {
          emit({ issue: failureText(selected.failure) });
          return;
        }
        const request = selected.data;
        requests.set(location, { selector: selectorKey(selector), request });
        const key = readKey(
          {
            connectionId: target.scope.connection.id,
            generation: target.scope.connection.generation,
            workspaceId: target.scope.workspaceId,
            projectId: target.ticket.value.ticket.project_id ?? undefined,
            actorId: undefined,
            runId: undefined,
            history: { kind: "current" },
          },
          request.method,
          request.params,
        );
        // ReadSlot owns current failures and same-location supersession. Its
        // rethrow must not overwrite the replacement page's global error state.
        await slot
          .load(key, (signal) => readPage(client, target, selector, request, signal), {
            live:
              page === undefined &&
              selector.kind !== "comment_history" &&
              selector.kind !== "handoff_history" &&
              selector.kind !== "amendment_acknowledgements",
          })
          .catch(() => {});
      } catch (error: unknown) {
        if (!disposed && reads.get(location) === slot) emit({ unexpected: { error } });
      }
    },
    review: (id) => prepare(id, false),
    post: (id) => prepare(id, true),
    close: (id) => {
      const draft = find(id);
      if (disposed || draft === undefined) return;
      if (flights.has(id) || draft.phase.kind === "capturing") {
        fail(
          id,
          new ProgressInputError(
            "Wait for this original capture/post action to settle before discarding its editor.",
          ),
        );
        return;
      }
      cancelGuard(id);
      posted.delete(id);
      emit({
        drafts: Object.freeze(state.drafts.filter((value) => value.id !== id)),
        selectedId: state.selectedId === id ? null : state.selectedId,
      });
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      recent.dispose();
      for (const abort of guards.values()) abort.abort();
      guards.clear();
      for (const slot of reads.values()) slot.dispose();
      reads.clear();
      confirmedPages.clear();
      requests.clear();
      listeners.clear();
    },
  };
}
