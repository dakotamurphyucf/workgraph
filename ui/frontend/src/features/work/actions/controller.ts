import { createCompanion } from "../../../core/protocol/client";
import type { Identifier } from "../../../core/protocol/types";
import { failureText } from "../../connections/failure";
import { auxiliaryInvocation, auxiliaryKey, validateAuxiliary } from "./auxiliary";
import { commandDefinition } from "./commands";
import { filledInputs } from "./fill";
import {
  ActionInputError,
  MAX_DRAFT_BYTES,
  MAX_DRAFTS,
  MAX_TOTAL_BYTES,
  captureAction,
  freezeInput,
  identity,
  initialInputs,
  inputBytes,
  preparation,
} from "./model";
import type {
  FormInput,
  WorkActionsController,
  WorkActionsOptions,
  WorkActionsState,
  WorkDraft,
} from "./types";

/** Browser-launch owner. Pending immutable operations live in the shared controller, not editor slots. */
export function createWorkActionsController({
  client,
  operations,
}: WorkActionsOptions): WorkActionsController {
  const companion = createCompanion(client),
    listeners = new Set<() => void>(),
    active = new Map<Identifier, AbortController>();
  let state: WorkActionsState = Object.freeze({
      drafts: Object.freeze([]),
      selectedId: null,
      issue: null,
      unexpected: null,
    }),
    disposed = false;
  const emit = (next: WorkActionsState) => {
    state = Object.freeze(next);
    for (const listener of listeners) listener();
  };
  const find = (id: Identifier) => state.drafts.find((draft) => draft.id === id);
  const patch = (id: Identifier, change: Partial<WorkDraft>) => {
    if (disposed) return;
    emit({
      ...state,
      drafts: Object.freeze(
        state.drafts.map((draft) =>
          draft.id === id ? Object.freeze({ ...draft, ...change }) : draft,
        ),
      ),
    });
  };
  const fail = (id: Identifier, error: unknown) => {
    if (error instanceof ActionInputError)
      patch(id, { issue: error.message, phase: { kind: "editing" } });
    else patch(id, { unexpected: { error }, phase: { kind: "editing" } });
  };
  const cancel = (id: Identifier) => {
    active.get(id)?.abort();
    active.delete(id);
  };
  const room = (id: Identifier | null, inputs: Readonly<Record<string, FormInput>>) => {
    const size = inputBytes(inputs);
    if (size > MAX_DRAFT_BYTES)
      throw new ActionInputError(
        "This editor exceeds 4 MiB of UTF-8 input. Its previous values were retained.",
      );
    const total = state.drafts.reduce(
      (sum, draft) => sum + (draft.id === id ? 0 : inputBytes(draft.inputs)),
      size,
    );
    if (total > MAX_TOTAL_BYTES)
      throw new ActionInputError(
        "Open editors exceed the 16 MiB aggregate input budget. Close an editor before adding more content; registered intentions remain available.",
      );
  };
  const update = (id: Identifier, inputs: Readonly<Record<string, FormInput>>) => {
    const draft = find(id);
    if (draft === undefined || draft.phase.kind === "capturing" || draft.phase.kind === "captured")
      return;
    room(id, inputs);
    cancel(id);
    patch(id, {
      inputs: Object.freeze(
        Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, freezeInput(value)])),
      ),
      editRevision: draft.editRevision + 1,
      phase: { kind: "editing" },
      issue: null,
      unexpected: null,
    });
  };
  const capture = async (id: Identifier): Promise<boolean> => {
    const draft = find(id);
    if (
      disposed ||
      draft === undefined ||
      draft.phase.kind === "capturing" ||
      draft.phase.kind === "captured"
    )
      return false;
    // Cancel pending mutable auxiliary work before capturing anything. Late loads cannot edit a frozen draft.
    cancel(id);
    try {
      const captured = preparation(draft);
      patch(id, { phase: { kind: "capturing" }, issue: null, unexpected: null });
      const result = await operations.register(captured);
      if (disposed || find(id) === undefined) return false;
      if (!result.ok) {
        const retained = operations.get(id);
        patch(id, {
          phase:
            retained === undefined
              ? { kind: "editing" }
              : { kind: "captured", preparation: retained.preparation },
          issue: failureText(result.failure),
        });
        return false;
      }
      patch(id, {
        phase: { kind: "captured", preparation: result.entry.preparation },
        issue: null,
      });
      return true;
    } catch (error: unknown) {
      const retained = operations.get(id);
      if (retained !== undefined)
        patch(id, {
          phase: { kind: "captured", preparation: retained.preparation },
          unexpected: { error },
        });
      else fail(id, error);
      return false;
    }
  };
  return {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open: (context, method, target) => {
      if (disposed) return null;
      try {
        if (state.drafts.length >= MAX_DRAFTS)
          throw new ActionInputError(
            "At most 32 editors may remain open. Close an editor; captured intentions remain in the shared operation shelf.",
          );
        const capture = captureAction(context, method, target),
          inputs = initialInputs(method, capture);
        room(null, inputs);
        const id = identity(),
          draft: WorkDraft = Object.freeze({
            id,
            method,
            capture,
            inputs,
            auxiliary: Object.freeze({}),
            phase: { kind: "editing" as const },
            issue: null,
            unexpected: null,
            editRevision: 0,
          });
        emit({
          ...state,
          drafts: Object.freeze([...state.drafts, draft]),
          selectedId: id,
          issue: null,
          unexpected: null,
        });
        return id;
      } catch (error: unknown) {
        emit({
          ...state,
          ...(error instanceof ActionInputError
            ? { issue: error.message }
            : { unexpected: { error } }),
        });
        return null;
      }
    },
    select: (id) => {
      if (!disposed && (id === null || find(id) !== undefined))
        emit({ ...state, selectedId: id, issue: null });
    },
    edit: (id, field, value) => {
      const draft = find(id);
      if (
        draft === undefined ||
        !commandDefinition(draft.method).fields.some((item) => item.name === field)
      )
        return;
      try {
        update(id, { ...draft.inputs, [field]: value });
      } catch (error: unknown) {
        fail(id, error);
      }
    },
    load: async (id, page) => {
      const draft = find(id);
      if (
        disposed ||
        draft === undefined ||
        draft.phase.kind === "capturing" ||
        draft.phase.kind === "captured"
      )
        return;
      let abort: AbortController | undefined;
      try {
        const invocation = auxiliaryInvocation(draft, page),
          key = auxiliaryKey(draft);
        if (key === null) throw new ActionInputError("No auxiliary read is available.");
        cancel(id);
        abort = new AbortController();
        active.set(id, abort);
        patch(id, {
          phase: { kind: "loading", method: invocation.method },
          issue: null,
          unexpected: null,
        });
        const result = await companion.read(invocation, abort.signal),
          current = find(id);
        if (
          disposed ||
          abort.signal.aborted ||
          active.get(id) !== abort ||
          current?.editRevision !== draft.editRevision ||
          current.phase.kind !== "loading"
        )
          return;
        active.delete(id);
        if (!result.ok) {
          patch(id, { phase: { kind: "editing" }, issue: failureText(result.failure) });
          return;
        }
        const capture = validateAuxiliary(draft, invocation, result.data);
        patch(id, {
          phase: { kind: "editing" },
          auxiliary: Object.freeze({ ...current.auxiliary, [key]: capture }),
          issue: null,
        });
      } catch (error: unknown) {
        if (!disposed && abort?.signal.aborted !== true) {
          active.delete(id);
          fail(id, error);
        }
      }
    },
    fill: (id) => {
      const draft = find(id);
      if (
        draft === undefined ||
        draft.phase.kind === "capturing" ||
        draft.phase.kind === "captured"
      )
        return;
      try {
        update(id, filledInputs(draft));
      } catch (error: unknown) {
        fail(id, error);
      }
    },
    prepare: async (id) => {
      await capture(id);
    },
    review: async (id) => {
      const original = find(id);
      if (
        disposed ||
        original === undefined ||
        original.phase.kind === "capturing" ||
        original.phase.kind === "captured"
      )
        return;
      const admitted = await capture(id);
      if (!admitted) return;
      const current = find(id),
        entry = operations.get(id);
      if (
        disposed ||
        current === undefined ||
        current.phase.kind !== "captured" ||
        entry === undefined ||
        entry.phase.kind !== "draft" ||
        entry.operation !== null
      )
        return;
      try {
        const result = await operations.act(id, "prepare");
        if (disposed || find(id) === undefined) return;
        if (!result.ok) patch(id, { issue: failureText(result.failure) });
      } catch (error: unknown) {
        if (!disposed && find(id) !== undefined) patch(id, { unexpected: { error } });
      }
    },
    close: (id) => {
      const draft = find(id);
      if (disposed || draft === undefined) return;
      if (draft.phase.kind === "capturing") {
        patch(id, {
          issue:
            "Wait for local capture admission before closing this editor; no request will be silently discarded.",
        });
        return;
      }
      cancel(id);
      const drafts = state.drafts.filter((item) => item.id !== id);
      emit({
        ...state,
        drafts: Object.freeze(drafts),
        selectedId: state.selectedId === id ? (drafts.at(-1)?.id ?? null) : state.selectedId,
        issue: null,
      });
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const abort of active.values()) abort.abort();
      active.clear();
      listeners.clear();
    },
  };
}
