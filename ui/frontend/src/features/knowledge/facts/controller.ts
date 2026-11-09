import { sameScope, VALUE_LIMITS } from "./codecs";
import type { FeatureContext } from "../../../app/types";
import type { Decimal, Identifier } from "../../../core/protocol/types";
import { refreshSlots, createReadSlot, type ReadSlot } from "../../../core/state/read-slot";
import { failureText } from "../../connections/failure";
import { createFactsClient, ownTarget } from "./client";
import {
  copyInput,
  copyQuery,
  decimal,
  FactInputError,
  identifier,
  initialSource,
  inputBytes,
  key,
  MAX_DRAFTS,
  MAX_TOTAL_BYTES,
  prepareDraft,
  sameTarget,
  scope,
  target,
  targetKey,
} from "./model";
import type {
  FactCapture,
  FactDraft,
  FactKey,
  FactObservation,
  FactPage,
  FactReference,
  FactSelection,
  FactsController,
  FactsOptions,
  FactsState,
  FactTarget,
  FactVersion,
} from "./types";

export function createFactsController({ http, operations }: FactsOptions): FactsController {
  const api = createFactsClient(http),
    keys = createReadSlot<FactCapture<FactPage<FactKey>>>(),
    values = createReadSlot<FactCapture<FactPage<FactObservation>>>(),
    detail = createReadSlot<FactCapture<FactObservation>>(),
    history = createReadSlot<FactCapture<FactPage<FactVersion>>>(),
    references = createReadSlot<FactCapture<FactPage<FactVersion>>>(),
    listeners = new Set<() => void>(),
    jobs = new Map<Identifier, AbortController>();
  let disposed = false,
    epoch = 0,
    sequence = 0,
    opening: AbortController | null = null,
    selected: FactSelection | null = null;
  let state: FactsState = {
    target: null,
    historicalGeneration: false,
    query: { prefix: "", includeDeleted: false, predicates: [] },
    keys: keys.get(),
    keyPreviousOffsets: [],
    values: values.get(),
    detail: detail.get(),
    history: history.get(),
    historyPreviousOffsets: [],
    references: references.get(),
    referenceQuery: null,
    referencePreviousOffsets: [],
    selectedKey: null,
    drafts: [],
    selectedDraftId: null,
    issue: null,
    unexpected: null,
  };
  const publish = (patch: Partial<FactsState>) => {
    if (disposed) return;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener();
  };
  keys.subscribe(() => publish({ keys: keys.get() }));
  values.subscribe(() => publish({ values: values.get() }));
  detail.subscribe(() => publish({ detail: detail.get() }));
  history.subscribe(() => publish({ history: history.get() }));
  references.subscribe(() => publish({ references: references.get() }));
  const find = (id: Identifier) => state.drafts.find((d) => d.id === id);
  const patch = (id: Identifier, change: Partial<FactDraft>) =>
    publish({
      drafts: Object.freeze(
        state.drafts.map((d) => (d.id === id ? Object.freeze({ ...d, ...change }) : d)),
      ),
    });
  const fail = (error: unknown, id?: Identifier) => {
    const change =
      error instanceof FactInputError ? { issue: error.message } : { unexpected: { error } };
    if (id === undefined) publish(change);
    else patch(id, change);
  };
  const current = <T>(slot: ReadSlot<T>) => {
    const value = slot.get();
    return value.kind === "ready" ? value.value : undefined;
  };
  const settled = <T>(slot: ReadSlot<T>) => {
    const value = slot.get();
    return value.kind === "ready"
      ? value.value
      : value.kind === "failed" || value.kind === "unexpected_error"
        ? value.previous
        : undefined;
  };
  // ReadSlot owns rejection visibility and stale-read fences. Never republish its rejected exception globally.
  const owned = async (work: Promise<unknown>) => {
    await work.catch(() => undefined);
  };
  const run = (work: Promise<unknown>, identity = epoch) => {
    void work.catch((error) => {
      if (!disposed && epoch === identity) fail(error);
    });
  };
  const clear = () => {
    epoch++;
    opening?.abort();
    opening = null;
    keys.clear();
    values.clear();
    detail.clear();
    history.clear();
    references.clear();
    publish({
      referenceQuery: null,
      referencePreviousOffsets: [],
      historyPreviousOffsets: [],
      keyPreviousOffsets: [],
    });
  };
  async function batch(
    page: FactCapture<FactPage<FactKey>>,
    identity: number,
    signal?: AbortSignal,
  ) {
    if (disposed || epoch !== identity) return;
    const requested = page.value.items.map((item) => item.key);
    await owned(
      values.load(
        `values:${targetKey(page.target)}:${page.revision}:${sequence++}`,
        (signal) => api.multiGet(page.target, requested, { atRevision: page.revision }, signal),
        { background: true, ...(signal === undefined ? {} : { signal }) },
      ),
    );
  }
  async function load(
    options: { offset?: Decimal; atRevision?: Decimal } = {},
    previousOffsets: readonly Decimal[] = [],
  ) {
    const t = state.target;
    if (t === null || disposed) return;
    const identity = epoch,
      query = state.query,
      previous = settled(keys);
    const result = await keys
      .load(`keys:${targetKey(t)}:${sequence++}`, (signal) => api.keys(t, query, options, signal), {
        ...(previous === undefined ? {} : { previous }),
        live: options.atRevision === undefined && options.offset === undefined,
        after: (page, signal) => batch(page, identity, signal),
      })
      .catch(() => undefined);
    if (result?.ok && epoch === identity)
      publish({ keyPreviousOffsets: Object.freeze([...previousOffsets]) });
  }
  async function readOne(t: FactTarget, k: string, signal: AbortSignal, revision?: Decimal) {
    const r = await api.multiGet(
      t,
      [k],
      revision === undefined ? {} : { atRevision: revision },
      signal,
    );
    if (!r.ok) return r;
    const only = r.data.value.items[0];
    if (
      only === undefined ||
      r.data.partial ||
      r.data.value.nextOffset !== null ||
      r.data.value.remaining !== "0"
    )
      return {
        ok: false as const,
        failure: {
          kind: "protocol" as const,
          message: "Incomplete fact read cannot establish existence or a revision guard.",
          issue: undefined,
        },
      };
    return { ...r, data: Object.freeze({ ...r.data, value: only }) };
  }
  async function inspect(k: string, selection: FactSelection | null = null) {
    const t = state.target;
    if (t === null) return;
    publish({
      selectedKey: k,
      issue: null,
      referenceQuery: null,
      referencePreviousOffsets: [],
      historyPreviousOffsets: [],
    });
    history.clear();
    references.clear();
    await owned(
      detail.load(
        `detail:${targetKey(t)}:${k}:${sequence++}`,
        async (signal) => {
          if (selection?.factRevision !== undefined) {
            let atRevision = selection.atRevision;
            if (atRevision === undefined) {
              const head = await readOne(t, k, signal);
              if (!head.ok) return head;
              atRevision = head.data.revision;
            }
            const r = await api.history(
              t,
              k,
              { offset: decimal((BigInt(selection.factRevision) - 1n).toString()), atRevision },
              signal,
            );
            if (!r.ok) return r;
            const version = r.data.value.items.find((v) => v.revision === selection.factRevision);
            return version === undefined
              ? {
                  ok: false as const,
                  failure: {
                    kind: "protocol" as const,
                    message:
                      "The exact fact version is unavailable; current value was not substituted.",
                    issue: undefined,
                  },
                }
              : { ...r, data: Object.freeze({ ...r.data, value: version }) };
          }
          return readOne(t, k, signal, selection?.atRevision);
        },
        { live: selection?.factRevision === undefined && selection?.atRevision === undefined },
      ),
    );
  }
  function historyCapture() {
    const value = history.get();
    return value.kind === "ready"
      ? value.value
      : value.kind === "failed" || value.kind === "unexpected_error"
        ? value.previous
        : undefined;
  }
  async function loadHistory(offset?: Decimal, previousOffsets: readonly Decimal[] = []) {
    const t = state.target,
      k = state.selectedKey,
      prior = historyCapture(),
      identity = epoch;
    if (t === null || k === null) return;
    const at = offset === undefined ? current(detail)?.revision : prior?.revision;
    if (at === undefined) return;
    const result = await history.load(
      `history:${targetKey(t)}:${k}:${sequence++}`,
      (signal) =>
        api.history(t, k, { atRevision: at, ...(offset === undefined ? {} : { offset }) }, signal),
      // Continuation failures leave the last page readable and navigable.
      prior === undefined ? {} : { previous: prior },
    );
    if (result.ok && epoch === identity && state.selectedKey === k)
      publish({ historyPreviousOffsets: Object.freeze([...previousOffsets]) });
  }
  async function loadReferences(
    ref: FactReference,
    navigation:
      { readonly kind: "start" } | { readonly kind: "next" | "previous"; readonly offset: Decimal },
  ) {
    const t = state.target,
      prior = settled(references),
      before = state.referenceQuery;
    if (t === null) return;
    const sameReference =
      prior !== undefined &&
      before !== null &&
      before.kind === ref.kind &&
      before.id === ref.id &&
      sameTarget(prior.target, t);
    if (
      navigation.kind !== "start" &&
      (!sameReference ||
        (navigation.kind === "next"
          ? prior.value.nextOffset
          : state.referencePreviousOffsets.at(-1)) !== navigation.offset)
    ) {
      publish({
        issue:
          "Reference continuation no longer matches its captured reference and target. Start a new reference lookup.",
      });
      return;
    }
    const captured = Object.freeze({ ...ref });
    const previousOffsets =
      navigation.kind === "next" && prior !== undefined
        ? [...state.referencePreviousOffsets, prior.value.offset]
        : navigation.kind === "previous"
          ? state.referencePreviousOffsets.slice(0, -1)
          : [];
    const options =
      navigation.kind !== "start" && prior !== undefined
        ? { offset: navigation.offset, atRevision: prior.revision }
        : {};
    publish({
      referenceQuery: captured,
      issue: null,
      ...(sameReference ? {} : { referencePreviousOffsets: [] }),
    });
    const result = await references.load(
      `references:${targetKey(t)}:${sequence++}`,
      (signal) => api.references(t, captured, options, signal),
      sameReference ? { previous: prior } : {},
    );
    if (result.ok) publish({ referencePreviousOffsets: Object.freeze(previousOffsets) });
  }
  const room = (input: import("./types").FactEditInput, except?: Identifier) => {
    if (
      state.drafts
        .filter((d) => d.id !== except)
        .reduce((sum, d) => sum + inputBytes(d.input), inputBytes(input)) > MAX_TOTAL_BYTES
    )
      throw new FactInputError(
        "Retained fact drafts exceed2 MiB. Discard an unsent draft before adding more.",
      );
  };
  const freshId = () => identifier(`fact-${crypto.randomUUID()}`);
  async function open(
    context: FeatureContext,
    k: string,
    method: "fact.put" | "fact.delete",
    restore?: FactVersion,
  ) {
    const viewed = state.target;
    if (viewed === null) return;
    let owner: AbortController | null = null;
    try {
      if (state.drafts.length >= MAX_DRAFTS)
        throw new FactInputError("Discard an unsent draft before opening another (24 maximum).");
      if (
        context.profileState !== "current" ||
        context.connection.id !== viewed.connection.id ||
        context.connection.generation !== viewed.connection.generation ||
        context.connection.socket !== viewed.connection.socket ||
        context.route.workspaceId !== viewed.workspaceId
      )
        throw new FactInputError(
          "Open this fact's current endpoint explicitly before authoring. An old generation's key will not be transplanted to another daemon.",
        );
      if (context.writer.actorId === null)
        throw new FactInputError("Select the actual acting writer before editing.");
      const writer = Object.freeze({
          actorId: identifier(context.writer.actorId),
          runId: context.writer.runId === null ? null : identifier(context.writer.runId),
        }),
        captured = ownTarget(viewed),
        name = key(k),
        id = freshId();
      owner = new AbortController();
      opening?.abort();
      opening = owner;
      const base = await readOne(captured, name, owner.signal);
      if (disposed || owner.signal.aborted || opening !== owner) return;
      if (!base.ok) throw new FactInputError(failureText(base.failure));
      if (
        restore !== undefined &&
        (!sameScope(restore.scope, captured.scope) ||
          restore.key !== name ||
          restore.kind !== "value")
      )
        throw new FactInputError(
          "Restore requires an active immutable version of this exact scope/key.",
        );
      const value = restore ?? (base.data.value.kind === "missing" ? undefined : base.data.value),
        encoded = await http.processing.encode(initialSource(value), {
          limits: VALUE_LIMITS,
          signal: owner.signal,
        });
      if (disposed || owner.signal.aborted || opening !== owner) return;
      if (!encoded.ok) throw new FactInputError(encoded.failure.message);
      if (!encoded.value.ok) throw new FactInputError(encoded.value.error.message);
      const input = copyInput({
        source: encoded.value.value,
        references:
          restore === undefined
            ? { kind: "preserve" }
            : { kind: "replace", items: restore.references },
      });
      room(input);
      const draft: FactDraft = Object.freeze({
        id,
        target: captured,
        key: name,
        writer,
        base: base.data,
        input,
        method,
        phase: { kind: "editing" as const },
        current: null,
        issue: null,
        unexpected: null,
      });
      publish({
        drafts: Object.freeze([...state.drafts, draft]),
        selectedDraftId: id,
        issue: null,
      });
    } catch (error) {
      if (!disposed && !owner?.signal.aborted) fail(error);
    } finally {
      if (opening === owner) opening = null;
    }
  }
  return {
    refreshLive: (signal) => refreshSlots([keys, detail], signal),
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    select: (context, selection) => {
      try {
        const next = selection === undefined ? target(context) : ownTarget(selection);
        const selectionKey =
          selection === undefined
            ? null
            : JSON.stringify([
                selection.key,
                selection.atRevision ?? null,
                selection.factRevision ?? null,
              ]);
        const oldKey =
          selected === null
            ? null
            : JSON.stringify([
                selected.key,
                selected.atRevision ?? null,
                selected.factRevision ?? null,
              ]);
        if (state.target !== null && sameTarget(state.target, next) && selectionKey === oldKey) {
          publish({
            historicalGeneration: context.connection.generation !== next.connection.generation,
          });
          return;
        }
        const nextSelected: FactSelection | null =
          selection === undefined
            ? null
            : selection.key === null
              ? Object.freeze({ ...ownTarget(selection), key: null })
              : Object.freeze({
                  ...ownTarget(selection),
                  key: key(selection.key),
                  ...(selection.atRevision === undefined
                    ? {}
                    : { atRevision: selection.atRevision }),
                  ...(selection.factRevision === undefined
                    ? {}
                    : { factRevision: selection.factRevision }),
                });
        if (nextSelected?.factRevision === "0")
          throw new FactInputError("A fact version must be positive.");
        const sameDirectory =
          state.target !== null &&
          sameTarget(state.target, next) &&
          selected?.atRevision === nextSelected?.atRevision;
        const query =
          state.target !== null && sameTarget(state.target, next)
            ? state.query
            : { prefix: "", includeDeleted: false, predicates: [] };
        if (sameDirectory) {
          opening?.abort();
          opening = null;
          detail.clear();
          history.clear();
          references.clear();
          publish({ historyPreviousOffsets: [], referencePreviousOffsets: [] });
        } else clear();
        selected = nextSelected;
        publish({
          target: next,
          historicalGeneration: context.connection.generation !== next.connection.generation,
          query,
          selectedKey: null,
          referenceQuery: null,
          issue: null,
          unexpected: null,
        });
        if (!sameDirectory || keys.get().kind === "idle")
          run(
            load(selection?.atRevision === undefined ? {} : { atRevision: selection.atRevision }),
          );
        if (selected !== null && selected.key !== null) run(inspect(selected.key, selected));
      } catch (error) {
        fail(error);
      }
    },
    changeScope: (value) => {
      try {
        const nextScope = scope(value),
          t = state.target;
        if (t === null) return;
        clear();
        selected = null;
        publish({
          target: ownTarget({ ...t, scope: nextScope }),
          selectedKey: null,
          referenceQuery: null,
          query: { prefix: "", includeDeleted: false, predicates: [] },
          issue: null,
        });
        run(load());
      } catch (error) {
        fail(error);
      }
    },
    query: (query) => {
      try {
        const ownedQuery = copyQuery(query);
        clear();
        publish({ query: ownedQuery, selectedKey: null, referenceQuery: null, issue: null });
        run(load(selected?.atRevision === undefined ? {} : { atRevision: selected.atRevision }));
        if (selected !== null && selected.key !== null) run(inspect(selected.key, selected));
      } catch (error) {
        fail(error);
      }
    },
    refresh: () => {
      publish({ issue: null });
      run(load(selected?.atRevision === undefined ? {} : { atRevision: selected.atRevision }));
      if (state.selectedKey !== null) run(inspect(state.selectedKey, selected));
    },
    nextKeys: () => {
      const page = settled(keys);
      if (page?.value.nextOffset !== null && page?.value.nextOffset !== undefined)
        run(
          load({ offset: page.value.nextOffset, atRevision: page.revision }, [
            ...state.keyPreviousOffsets,
            page.value.offset,
          ]),
        );
    },
    previousKeys: () => {
      const page = settled(keys),
        offset = state.keyPreviousOffsets.at(-1);
      if (page !== undefined && offset !== undefined)
        run(load({ offset, atRevision: page.revision }, state.keyPreviousOffsets.slice(0, -1)));
    },
    inspect: (k) => {
      try {
        selected = null;
        run(inspect(key(k)));
      } catch (error) {
        fail(error);
      }
    },
    history: () => void owned(loadHistory()),
    nextHistory: () => {
      const prior = historyCapture();
      if (prior === undefined || prior.value.nextOffset === null) return;
      void owned(
        loadHistory(prior.value.nextOffset, [...state.historyPreviousOffsets, prior.value.offset]),
      );
    },
    previousHistory: () => {
      const offset = state.historyPreviousOffsets.at(-1);
      if (offset !== undefined)
        void owned(loadHistory(offset, state.historyPreviousOffsets.slice(0, -1)));
    },
    references: (ref, offset) =>
      void owned(
        loadReferences(ref, offset === undefined ? { kind: "start" } : { kind: "next", offset }),
      ),
    nextReferences: () => {
      const prior = settled(references),
        ref = state.referenceQuery;
      if (ref !== null && prior?.value.nextOffset !== undefined && prior.value.nextOffset !== null)
        void owned(loadReferences(ref, { kind: "next", offset: prior.value.nextOffset }));
    },
    previousReferences: () => {
      const offset = state.referencePreviousOffsets.at(-1),
        ref = state.referenceQuery;
      if (offset !== undefined && ref !== null)
        void owned(loadReferences(ref, { kind: "previous", offset }));
    },
    open,
    edit: (id, input) => {
      try {
        const draft = find(id);
        if (draft?.phase.kind !== "editing") return;
        const captured = copyInput(input);
        room(captured, id);
        patch(id, { input: captured, issue: null, unexpected: null });
      } catch (error) {
        fail(error, id);
      }
    },
    chooseDraft: (id) => publish({ selectedDraftId: id }),
    discard: (id) => {
      const draft = find(id);
      if (draft?.phase.kind !== "editing") return;
      jobs.get(id)?.abort();
      jobs.delete(id);
      publish({
        drafts: Object.freeze(state.drafts.filter((d) => d.id !== id)),
        selectedDraftId: state.selectedDraftId === id ? null : state.selectedDraftId,
      });
    },
    review: async (id) => {
      const draft = find(id);
      if (draft?.phase.kind !== "editing" || jobs.has(id) || disposed) return;
      const owner = new AbortController();
      jobs.set(id, owner);
      patch(id, { phase: { kind: "validating" }, issue: null, unexpected: null });
      let registered = false;
      try {
        const preparation = await prepareDraft(draft, http.processing, owner.signal);
        if (disposed || owner.signal.aborted || jobs.get(id) !== owner) return;
        const result = await operations.register(preparation);
        if (!result.ok) throw new FactInputError(failureText(result.failure));
        registered = true;
        if (disposed || owner.signal.aborted || jobs.get(id) !== owner) return;
        patch(id, { phase: { kind: "registered", preparation } });
        const prepared = await operations.act(id, "prepare");
        if (!prepared.ok && !disposed) patch(id, { issue: failureText(prepared.failure) });
      } catch (error) {
        if (!disposed && !owner.signal.aborted) {
          fail(error, id);
          if (!registered) patch(id, { phase: { kind: "editing" } });
        }
      } finally {
        if (jobs.get(id) === owner) jobs.delete(id);
      }
    },
    compareCurrent: async (id) => {
      const draft = find(id);
      if (draft === undefined || jobs.has(id) || disposed) return;
      const owner = new AbortController();
      jobs.set(id, owner);
      try {
        const result = await readOne(draft.target, draft.key, owner.signal);
        if (disposed || owner.signal.aborted || jobs.get(id) !== owner) return;
        if (!result.ok) throw new FactInputError(failureText(result.failure));
        patch(id, { current: result.data, issue: null });
      } catch (error) {
        if (!disposed && !owner.signal.aborted) fail(error, id);
      } finally {
        if (jobs.get(id) === owner) jobs.delete(id);
      }
    },
    rebase: (id) => {
      try {
        const draft = find(id);
        if (draft?.current === null || draft?.current === undefined) return;
        if (state.drafts.length >= MAX_DRAFTS)
          throw new FactInputError("Discard an unsent draft before rebasing.");
        room(draft.input);
        const newId = freshId();
        publish({
          drafts: Object.freeze([
            ...state.drafts,
            Object.freeze({
              ...draft,
              id: newId,
              base: draft.current,
              current: null,
              phase: { kind: "editing" as const },
              issue: null,
              unexpected: null,
            }),
          ]),
          selectedDraftId: newId,
        });
      } catch (error) {
        fail(error, id);
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      epoch++;
      opening?.abort();
      for (const owner of jobs.values()) owner.abort();
      jobs.clear();
      keys.dispose();
      values.dispose();
      detail.dispose();
      history.dispose();
      references.dispose();
      listeners.clear();
    },
  };
}
