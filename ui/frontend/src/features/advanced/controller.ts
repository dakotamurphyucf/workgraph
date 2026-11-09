import { jsonField } from "../../core/json";
import { createCompanion } from "../../core/protocol/client";
import * as d from "../../core/protocol/decoders";
import * as c from "../../core/protocol/codec";
import type { Identifier, JsonObject, ReadResponse } from "../../core/protocol/types";
import type { HttpRequest, HttpResult } from "../../core/protocol/http";
import type { ManagedResult } from "../../core/state/operations";
import { createReadSlot, type ReadSlot } from "../../core/state/read-slot";
import { catalogCodec, methodCodec } from "./catalog";
import { editedParams, encode, parseObject } from "./parameters";
import type {
  AdvancedController,
  AdvancedDraft,
  AdvancedOptions,
  AdvancedState,
  Catalog,
  DraftSelection,
  MethodContract,
  ParameterFieldEdit,
} from "./types";
const MAX_DRAFTS = 32,
  MAX_SOURCE = 4 * 1024 * 1024,
  MAX_TOTAL = 16 * 1024 * 1024;
const continuationCodec = c.record({
  jsonrpc: c.literal("2.0"),
  workgraph_api: c.literal("0.7"),
  id: c.refine(
    c.text,
    (v) => {
      const n = new TextEncoder().encode(v).byteLength;
      return n > 0 && n <= 256;
    },
    "1..256 byte request ID",
  ),
  method: c.text,
  params: c.object,
});
/** Preserve native continuation method/params; the companion owns transport RPC IDs. */
export function continuation(
  response: ReadResponse,
  kind: "next_request" | "retry_request",
  catalog: Catalog,
) {
  const raw = response.pagination === null ? undefined : jsonField(response.pagination, kind),
    decoded = continuationCodec.decode(raw);
  if (!decoded.ok) return null;
  return catalog.methods.find((m) => m.name === decoded.value.method)?.mode === "read"
    ? decoded.value
    : null;
}
export function createAdvancedController({
  client,
  operations,
  newId = () => `adv-${crypto.randomUUID()}`,
}: AdvancedOptions): AdvancedController {
  const catalog = createReadSlot<Catalog>(),
    contract = createReadSlot<MethodContract>(),
    companion = createCompanion(client),
    processing = client.processing,
    reads = new Map<Identifier, ReadSlot<ReadResponse>>(),
    listeners = new Set<() => void>();
  type ParseJob = { readonly controller: AbortController; readonly promise: Promise<void> };
  type ActionJob = { readonly controller: AbortController };
  const parses = new Map<Identifier, ParseJob>(),
    edits = new Map<Identifier, ActionJob>(),
    reading = new Map<Identifier, ActionJob>(),
    preparing = new Map<Identifier, Promise<ManagedResult | null>>();
  let state: AdvancedState = {
      catalog: catalog.get(),
      selectedMethod: null,
      contract: contract.get(),
      drafts: [],
      activeDraftId: null,
      notice: "",
    },
    disposed = false;
  const publish = (patch: Partial<AdvancedState>) => {
    state = { ...state, ...patch };
    if (!disposed) for (const listener of listeners) listener();
  };
  const getDraft = (id: Identifier) => state.drafts.find((d) => d.id === id);
  const patchDraft = (id: Identifier, patch: Partial<AdvancedDraft>) => {
    if (getDraft(id))
      publish({ drafts: state.drafts.map((d) => (d.id === id ? { ...d, ...patch } : d)) });
  };
  // Catalog/contract callers may forward errors to a component boundary. A
  // canceled slot owns neither that boundary nor the newer lookup's state.
  const lookup = async <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
    try {
      return await client.request(request);
    } catch (error: unknown) {
      if (request.signal?.aborted) return { ok: false, failure: { kind: "aborted" } };
      throw error;
    }
  };
  catalog.subscribe(() => publish({ catalog: catalog.get() }));
  contract.subscribe(() => publish({ contract: contract.get() }));
  const unsubscribe = operations.subscribe(() => publish({}));
  const editorBytes = (source: string, fields: Readonly<Record<string, ParameterFieldEdit>>) =>
    new TextEncoder().encode(source).byteLength +
    Object.entries(fields).reduce(
      (n, [name, input]) =>
        n +
        new TextEncoder().encode(name).byteLength +
        new TextEncoder().encode(input.text).byteLength,
      0,
    );
  const withinBudget = (
    id: Identifier | null,
    source: string,
    fields: Readonly<Record<string, ParameterFieldEdit>>,
  ) => {
    const size = editorBytes(source, fields);
    return (
      size <= MAX_SOURCE &&
      size +
        state.drafts.reduce(
          (n, d) => n + (d.id === id ? 0 : editorBytes(d.source, d.fieldEdits)),
          0,
        ) <=
        MAX_TOTAL
    );
  };
  const cancelRead = (id: Identifier) => {
    reading.get(id)?.controller.abort();
    reading.delete(id);
    reads.get(id)?.clear();
    patchDraft(id, { reading: false });
  };
  const cancelEdit = (id: Identifier) => {
    edits.get(id)?.controller.abort();
    edits.delete(id);
  };
  const parse = (id: Identifier): Promise<void> => {
    const draft = getDraft(id);
    if (!draft) return Promise.resolve();
    parses.get(id)?.controller.abort();
    const controller = new AbortController();
    const promise = Promise.resolve().then(async () => {
      try {
        const result = await parseObject(
          processing,
          draft.source,
          draft.contract,
          controller.signal,
        );
        if (disposed || parses.get(id) !== job) return;
        patchDraft(id, {
          parameters: result.ok
            ? { kind: "ready", value: result.value }
            : { kind: "failed", message: result.message },
        });
      } catch (error: unknown) {
        if (!disposed && parses.get(id) === job)
          patchDraft(id, { parameters: { kind: "unexpected_error", error } });
      }
    });
    const job: ParseJob = { controller, promise };
    parses.set(id, job);
    patchDraft(id, { parameters: { kind: "loading" } });
    return promise;
  };
  const validated = async (id: Identifier) => {
    const job = parses.get(id);
    if (job) await job.promise;
    if (disposed || parses.get(id) !== job) return undefined;
    const draft = getDraft(id);
    if (draft?.parameters.kind === "unexpected_error") throw draft.parameters.error;
    return draft?.parameters.kind === "ready" ? draft.parameters.value : undefined;
  };
  const allocate = (
    selection: DraftSelection,
    selected: MethodContract,
    source: string,
    fields: Readonly<Record<string, ParameterFieldEdit>> = {},
  ): Identifier | null => {
    if (disposed) throw new Error("Advanced controller has been disposed.");
    if (state.drafts.length >= MAX_DRAFTS) {
      publish({
        notice: `Keep at most ${MAX_DRAFTS} open editors; close or discard an editor first.`,
      });
      return null;
    }
    if (!withinBudget(null, source, fields)) {
      publish({
        notice:
          "Raw source and staged fields exceed the 4 MiB per-draft or 16 MiB total editor budget.",
      });
      return null;
    }
    const valid = d.identifier.decode(d.jsonString(newId()));
    if (!valid.ok) throw new Error("Invalid Advanced draft ID generator.");
    const id = valid.value;
    if (getDraft(id) || operations.get(id)) throw new Error("Advanced draft ID was reused.");
    const slot = createReadSlot<ReadResponse>();
    reads.set(id, slot);
    slot.subscribe(() => patchDraft(id, { read: slot.get() }));
    const draft: AdvancedDraft = {
      id,
      selection: Object.freeze({
        ...selection,
        connection: Object.freeze({ ...selection.connection }),
      }),
      contract: selected,
      source,
      parameters: { kind: "loading" },
      preparing: false,
      preparationError: null,
      reading: false,
      fieldEdits: Object.freeze({ ...fields }),
      fieldErrors: {},
      locked: false,
      lane: "visible",
      read: slot.get(),
    };
    publish({ drafts: [...state.drafts, draft], activeDraftId: id, notice: "" });
    void parse(id);
    return id;
  };
  const updateSource = (
    id: Identifier,
    source: string,
    fields: Readonly<Record<string, ParameterFieldEdit>>,
    errors: Readonly<Record<string, string>>,
  ) => {
    cancelRead(id);
    patchDraft(id, {
      source,
      fieldEdits: fields,
      fieldErrors: errors,
      parameters: { kind: "loading" },
    });
    void parse(id);
  };
  const invoke = async (id: Identifier, method: string, params: JsonObject) => {
    const draft = getDraft(id),
      slot = reads.get(id);
    if (!draft || !slot) return;
    reading.get(id)?.controller.abort();
    const job = { controller: new AbortController() };
    reading.set(id, job);
    patchDraft(id, { reading: true });
    try {
      const s = draft.selection;
      const query = d.jsonObject([
        ["connection", d.jsonString(s.connection.id)],
        ["generation", d.jsonString(s.connection.generation)],
        ["workspace", s.workspaceId === null ? d.jsonNull() : d.jsonString(s.workspaceId)],
        ["project", s.projectId === null ? d.jsonNull() : d.jsonString(s.projectId)],
        ["actor", s.actorId === null ? d.jsonNull() : d.jsonString(s.actorId)],
        ["run", s.runId === null ? d.jsonNull() : d.jsonString(s.runId)],
        ["lane", d.jsonString(draft.lane)],
        ["method", d.jsonString(method)],
        ["params", params],
      ]);
      const key = await processing.encode(query, {
        canonical: true,
        signal: job.controller.signal,
        limits: {
          maxBytes: 16 * 1024 * 1024,
          maxDepth: 96,
          maxNodes: 400000,
          maxStringBytes: 16 * 1024 * 1024,
        },
      });
      if (reading.get(id) !== job) return;
      if (!key.ok) {
        publish({ notice: `${key.failure.kind}: ${key.failure.message}` });
        return;
      }
      if (!key.value.ok) {
        publish({ notice: key.value.error.message });
        return;
      }
      await slot.load(key.value.value, (signal) =>
        companion.read(
          {
            connection_id: s.connection.id,
            generation: s.connection.generation,
            method,
            params,
            lane: draft.lane,
          },
          signal,
        ),
      );
    } catch (error: unknown) {
      // An edited, discarded or replaced draft no longer owns this rejection.
      // Keep current unexpected failures observable and preserve their exception.
      if (reading.get(id) !== job) return;
      patchDraft(id, {
        read: { kind: "unexpected_error", key: "advanced-query-key", previous: undefined, error },
      });
      throw error;
    } finally {
      if (reading.get(id) === job) {
        reading.delete(id);
        patchDraft(id, { reading: false });
      }
    }
  };
  return {
    get: () => state,
    subscribe(listener) {
      if (disposed) throw new Error("Advanced controller has been disposed.");
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    loadCatalog: () =>
      catalog.load("executable-catalog", (signal) =>
        lookup({ path: "/catalog", method: "GET", codec: catalogCodec, signal }),
      ),
    selectMethod(name) {
      publish({ selectedMethod: name });
      return contract.load(JSON.stringify([name]), (signal) =>
        lookup({
          path: `/methods/${encodeURIComponent(name)}`,
          method: "GET",
          codec: methodCodec(name),
          signal,
        }),
      );
    },
    createDraft(context) {
      if (context.profileState !== "current") {
        publish({ notice: "Refresh the connection directory before capturing a new draft." });
        return null;
      }
      if (
        state.contract.kind !== "ready" ||
        state.contract.value.method.name !== state.selectedMethod
      ) {
        publish({ notice: "Load a method contract before creating its draft." });
        return null;
      }
      return allocate(
        {
          connection: context.connection,
          workspaceId: context.route.workspaceId,
          projectId: context.route.projectId,
          actorId: context.writer.actorId,
          runId: context.writer.runId,
        },
        state.contract.value,
        "{}",
      );
    },
    cloneDraft(id) {
      const draft = getDraft(id);
      return draft
        ? allocate(draft.selection, draft.contract, draft.source, draft.fieldEdits)
        : null;
    },
    selectDraft(id) {
      if (getDraft(id)) publish({ activeDraftId: id, notice: "" });
    },
    editSource(id, source) {
      const draft = getDraft(id);
      if (!draft || draft.locked || draft.preparing) return false;
      if (Object.keys(draft.fieldEdits).length > 0) {
        publish({ notice: "Apply or discard staged field edits before changing raw source." });
        return false;
      }
      if (!withinBudget(id, source, {})) {
        publish({ notice: "Raw source exceeds the editor byte budget." });
        return false;
      }
      cancelEdit(id);
      updateSource(id, source, {}, {});
      return true;
    },
    stageField(id, name, input) {
      const draft = getDraft(id);
      if (
        !draft ||
        draft.locked ||
        draft.preparing ||
        !draft.contract.fields.fields.some((f) => f.name === name)
      )
        return false;
      const fieldEdits = { ...draft.fieldEdits, [name]: Object.freeze({ ...input }) };
      if (!withinBudget(id, draft.source, fieldEdits)) {
        publish({ notice: "Staged fields exceed the editor byte budget." });
        return false;
      }
      const errors = { ...draft.fieldErrors };
      delete errors[name];
      cancelEdit(id);
      cancelRead(id);
      patchDraft(id, { fieldEdits, fieldErrors: errors });
      return true;
    },
    async applyField(id, name) {
      const draft = getDraft(id);
      if (!draft || draft.locked || draft.preparing || draft.parameters.kind !== "ready")
        return false;
      const field = draft.contract.fields.fields.find((f) => f.name === name),
        input = Object.hasOwn(draft.fieldEdits, name) ? draft.fieldEdits[name] : undefined;
      if (!field || !input) return false;
      cancelEdit(id);
      const job = { controller: new AbortController() },
        capture = parses.get(id);
      edits.set(id, job);
      try {
        const result = await editedParams(
          processing,
          draft.parameters.value.params,
          field,
          input,
          job.controller.signal,
        );
        const current = getDraft(id);
        if (
          disposed ||
          edits.get(id) !== job ||
          parses.get(id) !== capture ||
          current?.fieldEdits[name] !== input ||
          current.locked ||
          current.preparing
        )
          return false;
        if (!result.ok) {
          patchDraft(id, { fieldErrors: { ...current.fieldErrors, [name]: result.message } });
          return false;
        }
        const fields = { ...current.fieldEdits },
          errors = { ...current.fieldErrors };
        delete fields[name];
        delete errors[name];
        if (!withinBudget(id, result.value, fields)) {
          publish({ notice: "Applying this field exceeds the editor byte budget." });
          return false;
        }
        updateSource(id, result.value, fields, errors);
        return true;
      } catch (error: unknown) {
        if (edits.get(id) === job && parses.get(id) === capture)
          patchDraft(id, { parameters: { kind: "unexpected_error", error } });
        throw error;
      } finally {
        if (edits.get(id) === job) edits.delete(id);
      }
    },
    async fillScopeFields(id) {
      const draft = getDraft(id);
      if (
        !draft ||
        draft.locked ||
        draft.preparing ||
        draft.parameters.kind !== "ready" ||
        Object.keys(draft.fieldEdits).length > 0
      )
        return false;
      cancelEdit(id);
      const job = { controller: new AbortController() },
        capture = parses.get(id);
      edits.set(id, job);
      const s = draft.selection,
        values: Readonly<Record<string, string | null>> = {
          workspace_id: s.workspaceId,
          project_id: s.projectId,
          actor_id: s.actorId,
          run_id: s.runId,
        };
      const targets = new Set(
          draft.contract.fields.fields
            .map((f) => f.name)
            .filter((name) => Object.hasOwn(values, name)),
        ),
        fields = draft.parameters.value.params.fields.filter((f) => !targets.has(f.name));
      for (const name of targets) {
        const value = values[name];
        if (value !== null && value !== undefined)
          fields.push({ name, value: d.jsonString(value) });
      }
      try {
        const result = await encode(
          processing,
          d.jsonObject(fields.map((f) => [f.name, f.value] as const)),
          job.controller.signal,
        );
        if (
          disposed ||
          edits.get(id) !== job ||
          parses.get(id) !== capture ||
          !getDraft(id) ||
          getDraft(id)?.locked ||
          getDraft(id)?.preparing ||
          Object.keys(getDraft(id)?.fieldEdits ?? {}).length > 0
        )
          return false;
        if (!result.ok) {
          publish({ notice: result.message });
          return false;
        }
        if (!withinBudget(id, result.value, {})) {
          publish({ notice: "Scope fields exceed the editor byte budget." });
          return false;
        }
        updateSource(id, result.value, {}, {});
        return true;
      } catch (error: unknown) {
        if (edits.get(id) === job && parses.get(id) === capture)
          patchDraft(id, { parameters: { kind: "unexpected_error", error } });
        throw error;
      } finally {
        if (edits.get(id) === job) edits.delete(id);
      }
    },
    async validateParameters(id) {
      const draft = getDraft(id);
      if (!draft) return false;
      if (draft.parameters.kind === "failed") await parse(id);
      return (await validated(id)) !== undefined;
    },
    discardFieldEdits(id) {
      const draft = getDraft(id);
      if (draft && !draft.locked && !draft.preparing) {
        cancelEdit(id);
        patchDraft(id, { fieldEdits: {}, fieldErrors: {} });
      }
    },
    setLane(id, lane) {
      const draft = getDraft(id);
      if (draft && !draft.locked && !draft.preparing) {
        cancelRead(id);
        patchDraft(id, { lane });
      }
    },
    async runRead(id) {
      const draft = getDraft(id),
        capture = parses.get(id);
      if (!draft) return;
      if (draft.contract.method.mode !== "read") {
        publish({ notice: "Only a Read method can use the read lane." });
        return;
      }
      const params = await validated(id);
      if (parses.get(id) !== capture) return;
      if (Object.keys(getDraft(id)?.fieldEdits ?? {}).length > 0) {
        publish({ notice: "Apply or discard staged field edits before submitting parameters." });
        return;
      }
      if (!params) {
        publish({ notice: "Correct or retry parameter validation before running a read." });
        return;
      }
      publish({ notice: "" });
      await invoke(id, draft.contract.method.name, params.params);
    },
    async continueRead(id, kind) {
      const draft = getDraft(id);
      if (!draft || draft.read.kind !== "ready" || state.catalog.kind !== "ready") return;
      const next = continuation(draft.read.value, kind, state.catalog.value);
      if (!next) {
        publish({ notice: "No validated Read continuation is available." });
        return;
      }
      await invoke(id, next.method, next.params);
    },
    cancelRead,
    prepare(id) {
      const pending = preparing.get(id);
      if (pending) return pending;
      const draft = getDraft(id),
        capture = parses.get(id);
      if (!draft) return Promise.resolve(null);
      // A pending scope/field formatter must never publish over this preparation capture.
      cancelEdit(id);
      const promise = Promise.resolve()
        .then(async (): Promise<ManagedResult | null> => {
          if (draft.contract.method.mode === "read") {
            publish({ notice: "Read methods run directly and cannot be prepared as writes." });
            return null;
          }
          const params = await validated(id);
          if (parses.get(id) !== capture) return null;
          if (Object.keys(getDraft(id)?.fieldEdits ?? {}).length > 0) {
            publish({ notice: "Apply or discard staged field edits before preparing parameters." });
            return null;
          }
          if (!params) {
            publish({ notice: "Correct or retry parameter validation before preparing a write." });
            return null;
          }
          const s = draft.selection,
            actor = d.identifier.decode(s.actorId === null ? undefined : d.jsonString(s.actorId)),
            workspace =
              s.workspaceId === null ? null : d.identifier.decode(d.jsonString(s.workspaceId)),
            project = s.projectId === null ? null : d.identifier.decode(d.jsonString(s.projectId)),
            run = s.runId === null ? null : d.identifier.decode(d.jsonString(s.runId));
          if (
            !actor.ok ||
            (workspace !== null && !workspace.ok) ||
            (project !== null && !project.ok) ||
            (run !== null && !run.ok)
          ) {
            publish({
              notice:
                "Create a new draft with a valid captured writer and scope before preparing a write.",
            });
            return null;
          }
          patchDraft(id, { locked: true });
          const registered = await operations.register({
            intention_id: id,
            connection_id: s.connection.id,
            generation: s.connection.generation,
            context: {
              workspace_id: workspace?.value ?? null,
              project_id: project?.value ?? null,
              writer: { actor_id: actor.value, run_id: run?.value ?? null },
            },
            method: draft.contract.method.name,
            params: params.params,
          });
          if (!registered.ok) {
            // Local admission has no uncertain native write. Keep the source repairable
            // unless the shared owner actually retained this intention.
            patchDraft(id, { locked: operations.get(id) !== undefined });
            publish({
              notice:
                registered.failure.kind === "input"
                  ? registered.failure.message
                  : "Local intention admission failed; draft source is retained.",
            });
            return registered;
          }
          publish({ notice: "" });
          return operations.act(id, "prepare");
        })
        .catch((error: unknown) => {
          patchDraft(id, { preparationError: { error } });
          throw error;
        })
        .finally(() => {
          if (preparing.get(id) === promise) {
            preparing.delete(id);
            patchDraft(id, { preparing: false });
          }
        });
      preparing.set(id, promise);
      patchDraft(id, { preparing: true, preparationError: null });
      return promise;
    },
    act: (id, action) => operations.act(id, action),
    operation: (id) => operations.get(id),
    discardDraft(id) {
      const draft = getDraft(id);
      if (!draft || draft.preparing) return false;
      parses.get(id)?.controller.abort();
      parses.delete(id);
      cancelEdit(id);
      cancelRead(id);
      reads.get(id)?.dispose();
      reads.delete(id);
      const drafts = state.drafts.filter((d) => d.id !== id);
      publish({
        drafts,
        activeDraftId: state.activeDraftId === id ? (drafts[0]?.id ?? null) : state.activeDraftId,
      });
      return true;
    },
    dispose() {
      if (disposed) return;
      catalog.dispose();
      contract.dispose();
      for (const slot of reads.values()) slot.dispose();
      for (const job of parses.values()) job.controller.abort();
      for (const job of edits.values()) job.controller.abort();
      for (const job of reading.values()) job.controller.abort();
      unsubscribe();
      disposed = true;
      listeners.clear();
    },
  };
}
