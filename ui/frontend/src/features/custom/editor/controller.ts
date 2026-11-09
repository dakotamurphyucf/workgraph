import { captureJson } from "../../../core/json/capture";
import type { FormDraft } from "./forms/types";
import type { JsonValue } from "../../../core/json";
import type { JsonResult } from "../../../core/json";
import type { ProcessingResult } from "../../../core/protocol/worker";
import * as d from "../../../core/protocol/decoders";
import type { HttpResult } from "../../../core/protocol/http";
import { refreshSlots, createReadSlot } from "../../../core/state/read-slot";
import {
  CONFIG_LIMITS,
  configJson,
  decodeConfigSource,
  ConfigInputError,
  ConfigProcessingError,
} from "../config";
import { decodeConfigValue } from "../config/decode";
import { createSourceAdapter } from "./source";
import {
  captureSave,
  captureTarget,
  createPersonalClient,
  sameTarget,
  type PersonalInventory,
} from "./settings";
import {
  asJson,
  current,
  defaultRenderer,
  defaultView,
  editable,
  newId,
  planSaved,
  portableCodec,
  portableJson,
  privateLimits,
  replaceDocument,
  targetKey,
} from "./model";
import { SharedReadError, createSharedConfiguration } from "./shared";
import { validatedPersonalTitle } from "./personal-labels";
import type {
  ConfigurationDraft,
  CustomController,
  CustomControllerOptions,
  CustomPage,
  CustomState,
  CustomTarget,
  PersonalSavePlan,
  PersonalSettings,
  SharedCatalog,
} from "./types";

function processingMessage<T>(result: ProcessingResult<JsonResult<T>>): string {
  if (!result.ok) return `[${result.failure.kind}] ${result.failure.message}`;
  if (!result.value.ok) return result.value.error.message;
  return "Processing succeeded.";
}
async function decodeSource(
  http: CustomControllerOptions["http"],
  source: string,
  signal: AbortSignal,
) {
  const result = await decodeConfigSource(http.processing, source, signal);
  if (!result.ok) throw new ConfigProcessingError(result.failure);
  return result.value;
}
function failureText(result: Extract<HttpResult<unknown>, { ok: false }>): string {
  const error = result.failure;
  return error.kind === "remote"
    ? error.problem.message
    : "message" in error
      ? error.message
      : "Cancelled.";
}
export function createCustomController({
  http,
  operations,
}: CustomControllerOptions): CustomController {
  const personal = createReadSlot<PersonalSettings>(),
    inventory = createReadSlot<PersonalInventory>(),
    page = createReadSlot<CustomPage>(),
    shared = createReadSlot<SharedCatalog>(),
    activation = createReadSlot<CustomPage>();
  const settings = createPersonalClient(http),
    adapter = createSourceAdapter(http),
    catalogs = createSharedConfiguration(http);
  let state: CustomState = {
    target: null,
    personal: personal.get(),
    personalLabels: null,
    inventory: inventory.get(),
    shared: shared.get(),
    personalSave: { kind: "idle" },
    draft: null,
    active: null,
    page: page.get(),
    activation: activation.get(),
    loaded: [],
    loadedCoverage: [],
    loadedLimitReached: false,
    loadedPartial: false,
    loadedPages: [],
    imported: null,
    message: null,
    unexpected: null,
  };
  let activePage: CustomPage | null = null;
  let disposed = false,
    selection = "",
    epoch = 0,
    draftOwner: AbortController | null = null,
    preparing: AbortController | null = null,
    saveOwner: object | null = null,
    reconcileOwner: AbortController | null = null,
    importAdoption: AbortController | null = null;
  let labelOwner: AbortController | null = null,
    labelSettings: PersonalSettings | undefined,
    labelDeadline: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const emit = () => {
    if (!disposed) for (const listener of listeners) listener();
  };
  const publish = (patch: Partial<CustomState>) => {
    if (!disposed) {
      state = { ...state, ...patch };
      emit();
    }
  };
  const syncSlots = () => {
    if (disposed) return;
    const next = {
      personal: personal.get(),
      inventory: inventory.get(),
      page: page.get(),
      shared: shared.get(),
      activation: activation.get(),
    };
    if (
      state.personal === next.personal &&
      state.inventory === next.inventory &&
      state.page === next.page &&
      state.shared === next.shared &&
      state.activation === next.activation
    )
      return;
    state = { ...state, ...next };
    emit();
    // Optional read-side work starts only after the original read/save is published.
    syncPersonalLabels(current(next.personal));
  };
  for (const slot of [personal, inventory, page, shared, activation]) slot.subscribe(syncSlots);
  const get = (): CustomState => state;
  const unexpected = (cause: unknown) => publish({ unexpected: { cause } });
  function stopPersonalLabels() {
    labelOwner?.abort();
    labelOwner = null;
    if (labelDeadline !== undefined) clearTimeout(labelDeadline);
    labelDeadline = undefined;
  }
  function syncPersonalLabels(observed: PersonalSettings | undefined) {
    if (labelSettings === observed) return;
    stopPersonalLabels();
    labelSettings = observed;
    if (observed === undefined) {
      publish({ personalLabels: null });
      return;
    }
    const owner = new AbortController();
    labelOwner = owner;
    let documents = observed.documents.map((item) => ({ ...item, title: null as string | null }));
    const owns = () =>
      !disposed &&
      labelOwner === owner &&
      !owner.signal.aborted &&
      current(personal.get()) === observed &&
      state.target !== null &&
      sameTarget(state.target, observed.target);
    publish({ personalLabels: { settings: observed, status: "loading", documents } });
    labelDeadline = setTimeout(() => {
      if (!owns()) return;
      stopPersonalLabels();
      publish({ personalLabels: { settings: observed, status: "unavailable", documents } });
    }, 3000);
    void (async () => {
      for (const item of observed.documents) {
        const title = await validatedPersonalTitle(http.processing, item, owner.signal);
        if (!owns()) return;
        documents = documents.map((row) =>
          row.id === item.id && row.source === item.source ? { ...row, title } : row,
        );
        publish({ personalLabels: { settings: observed, status: "loading", documents } });
      }
      if (!owns()) return;
      stopPersonalLabels();
      publish({ personalLabels: { settings: observed, status: "complete", documents } });
    })().catch((cause: unknown) => {
      if (!owns()) return;
      stopPersonalLabels();
      publish({ personalLabels: { settings: observed, status: "unavailable", documents } });
      unexpected(cause);
    });
  }
  const ownDraft = (owner: AbortController, id: string) =>
    !disposed &&
    draftOwner === owner &&
    !owner.signal.aborted &&
    state.draft?.kind === "editing" &&
    state.draft.id === id;
  const stopDraft = () => {
    activation.clear();
    draftOwner?.abort();
    draftOwner = null;
    preparing?.abort();
    preparing = null;
  };
  function beginDraft(
    target: CustomTarget,
    source: string,
    origin: Extract<ConfigurationDraft, { kind: "editing" }>["origin"],
    id = newId("draft"),
  ) {
    stopDraft();
    const observed = current(personal.get());
    publish({
      draft: {
        kind: "editing",
        id,
        target: captureTarget(target),
        source,
        form: null,
        personalBase:
          observed !== undefined && sameTarget(observed.target, target) ? observed : null,
        decoded: null,
        origin,
        mode: "form",
        busy: true,
        message: null,
      },
    });
    void validateSource(id, source);
  }
  async function validateSource(id: string, source: string) {
    const owner = new AbortController();
    draftOwner?.abort();
    draftOwner = owner;
    try {
      const decoded = await decodeSource(http, source, owner.signal);
      if (ownDraft(owner, id) && state.draft?.kind === "editing")
        publish({ draft: { ...state.draft, source, decoded, busy: false, message: null } });
    } catch (error) {
      if (!ownDraft(owner, id) || state.draft?.kind !== "editing") return;
      if (error instanceof ConfigProcessingError)
        publish({
          draft: { ...state.draft, busy: false, message: `[${error.kind}] ${error.message}` },
        });
      else {
        publish({ draft: { ...state.draft, busy: false } });
        unexpected(error);
      }
    }
  }
  async function encodeCandidate(candidate: JsonValue, form: FormDraft | null = null) {
    const draft = state.draft;
    if (draft?.kind !== "editing" || preparing !== null) return;
    const owner = new AbortController();
    draftOwner?.abort();
    draftOwner = owner;
    activation.clear();
    publish({ draft: { ...draft, form, busy: true, message: null } });
    try {
      const encoded = await http.processing.encode(candidate, {
        canonical: true,
        limits: CONFIG_LIMITS,
        signal: owner.signal,
      });
      if (!ownDraft(owner, draft.id) || state.draft?.kind !== "editing") return;
      if (!encoded.ok || !encoded.value.ok) {
        publish({
          draft: {
            ...state.draft,
            busy: false,
            message: processingMessage(encoded),
          },
        });
        return;
      }
      const source = encoded.value.value;
      publish({ draft: { ...state.draft, source } });
      await validateSource(draft.id, source);
    } catch (error) {
      if (ownDraft(owner, draft.id)) {
        if (state.draft?.kind === "editing") publish({ draft: { ...state.draft, busy: false } });
        unexpected(error);
      }
    }
  }
  function chooseTarget(target: CustomTarget) {
    activePage = null;
    importAdoption?.abort();
    epoch++;
    personal.clear();
    page.clear();
    shared.clear();
    activation.clear();
    publish({
      target: captureTarget(target),
      active: null,
      loaded: [],
      loadedCoverage: [],
      loadedLimitReached: false,
      loadedPartial: false,
      loadedPages: [],
      message: null,
    });
    void personal
      .load(targetKey(target), (signal) => settings.inspect(target, signal))
      .catch(() => undefined);
  }
  async function inspectPersonal() {
    const saved = state.personalSave;
    if (saved.kind === "unknown" || saved.kind === "conflict" || saved.kind === "rejected") {
      const plan = saved.plan,
        owner = new AbortController();
      reconcileOwner?.abort();
      reconcileOwner = owner;
      try {
        const result = await settings.inspect(plan.target, owner.signal);
        if (
          disposed ||
          reconcileOwner !== owner ||
          owner.signal.aborted ||
          !(
            state.personalSave.kind === "unknown" ||
            state.personalSave.kind === "conflict" ||
            state.personalSave.kind === "rejected"
          ) ||
          state.personalSave.plan !== plan
        )
          return;
        if (!result.ok) {
          publish({ message: `Saved-intention reconciliation failed: ${failureText(result)}` });
          return;
        }
        publish({
          personalSave:
            saved.kind !== "rejected" && planSaved(plan, result.data)
              ? {
                  kind: "saved",
                  revision: result.data.revision,
                  confirmation: "desired_state_observed",
                }
              : {
                  kind: "conflict",
                  plan,
                  observed: result.data,
                  message:
                    "Observed settings do not prove the original save committed. Original target, source and guard remain retained.",
                },
        });
        if (state.target !== null && sameTarget(state.target, plan.target))
          await personal.load(targetKey(plan.target), () => Promise.resolve(result));
      } catch (error) {
        if (!disposed && reconcileOwner === owner && !owner.signal.aborted) unexpected(error);
      }
      return;
    }
    const target = state.target;
    if (target === null) return;
    // ReadSlot alone publishes current unexpected failures; obsolete rejections must not be republished.
    await personal
      .load(targetKey(target), (signal) => settings.inspect(target, signal))
      .catch(() => undefined);
  }
  async function save(plan: PersonalSavePlan) {
    if (disposed || saveOwner !== null) return;
    const retained = captureSave(plan),
      owner = {};
    saveOwner = owner;
    publish({ personalSave: { kind: "saving", plan: retained }, message: null });
    try {
      // Browser disposal does not own/cancel an admitted settings save.
      const result = await settings.replace(retained);
      if (disposed || saveOwner !== owner) return;
      if (result.ok) {
        publish({
          personalSave: {
            kind: "saved",
            revision: result.data.revision,
            confirmation: "acknowledged",
          },
        });
        if (state.target !== null && sameTarget(state.target, retained.target))
          await personal.load(targetKey(retained.target), () => Promise.resolve(result));
      } else {
        const definite =
          result.failure.kind === "remote" &&
          !["Outcome_unknown", "Local_io", "Storage_unavailable"].includes(
            result.failure.problem.kind,
          );
        publish({
          personalSave: definite
            ? {
                kind: "rejected",
                plan: retained,
                failure: result.failure,
                message: `${failureText(result)} The save was rejected; original target/source/guard remain retained. Inspect before deliberate rebase.`,
              }
            : {
                kind: "unknown",
                plan: retained,
                message: `${failureText(result)} Inspect before exact retry or an explicit new guard.`,
              },
        });
      }
    } catch (error) {
      if (!disposed && saveOwner === owner) {
        publish({
          personalSave: {
            kind: "unknown",
            plan: retained,
            message:
              "The local save response failed unexpectedly. Inspect the original target before any new save.",
          },
        });
        unexpected(error);
      }
    } finally {
      if (saveOwner === owner) saveOwner = null;
    }
  }
  async function loadPage(
    kind?: "next" | "retry",
    seed?: Extract<HttpResult<CustomPage>, { readonly ok: true }>,
  ) {
    // Activation already acquired the initial capture. Consume it once, then
    // register the ordinary current query for subsequent live refreshes.
    let firstCapture = seed;
    const active = state.active;
    if (active === null || (kind !== undefined && state.loadedLimitReached)) return;
    const old = activePage ?? undefined,
      capturedEpoch = epoch,
      priorRows = state.loaded,
      priorCoverage = state.loadedCoverage;
    if (kind !== undefined && old === undefined) return;
    const key = `${targetKey(active.target)}:${active.view.id}:${capturedEpoch}`;
    const accept = (value: CustomPage): Promise<void> => {
      if (disposed || capturedEpoch !== epoch || state.active !== active) return Promise.resolve();
      activePage = value;
      const frames =
        kind === undefined
          ? [value]
          : kind === "retry"
            ? [...state.loadedPages.filter((frame) => frame !== old), value]
            : [...state.loadedPages, value];
      const rows =
        kind === undefined
          ? value.rows
          : kind === "retry"
            ? [
                ...priorRows.filter(
                  (row) => !old?.rows.some((previous) => previous.identity === row.identity),
                ),
                ...value.rows,
              ]
            : [...priorRows, ...value.rows];
      publish({
        loaded: Object.freeze(rows.slice(0, 512)),
        loadedPages: Object.freeze(frames),
        loadedPartial: frames.some((frame) => frame.partial),
        loadedLimitReached: rows.length > 512 || (rows.length >= 512 && value.next !== null),
        loadedCoverage: Object.freeze(
          [
            ...(kind === undefined
              ? []
              : priorCoverage.filter(
                  (item) =>
                    !(kind === "retry" ? (old?.rows ?? []) : value.rows).some(
                      (next) => next.identity === item.identity,
                    ),
                )),
            ...(value.enrichment?.rows ?? []),
          ].filter((item) => rows.slice(0, 512).some((row) => row.identity === item.identity)),
        ),
        message:
          rows.length > 512
            ? "Loaded view limit reached: 512 rows. Narrow filters or start a fresh query; later rows were not retained."
            : null,
      });
      return Promise.resolve();
    };
    try {
      await page.load(
        key,
        async (signal) => {
          if (firstCapture !== undefined) {
            const captured = firstCapture;
            firstCapture = undefined;
            return captured;
          }
          const result =
            kind === undefined
              ? await adapter.initial(active.target, active.view, signal)
              : old === undefined
                ? null
                : await adapter.next(old, kind, signal);
          if (result === null)
            return {
              ok: false,
              failure: { kind: "input", message: "No captured source page is available." },
            };
          if (!result.ok) return result;
          if (
            kind === "next" &&
            result.data.rows.some((row) => priorRows.some((old) => old.identity === row.identity))
          )
            return {
              ok: false,
              failure: {
                kind: "protocol",
                message: "Source paging repeated an already loaded row.",
                issue: undefined,
              },
            };
          return result;
        },
        { live: kind === undefined, after: accept },
      );
    } catch {
      /* ReadSlot retains only its current unexpected throwable. */
    }
  }
  const controller: CustomController = {
    refreshLive: (signal) => refreshSlots([personal, inventory, shared, page], signal),
    get,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    select(context) {
      const workspace = d.identifier.decode(d.jsonString(context.route.workspaceId ?? ""));
      const key = workspace.ok
        ? targetKey({ connection: context.connection, workspaceId: workspace.value })
        : "none";
      if (selection === key) return;
      selection = key;
      if (!workspace.ok) {
        activePage = null;
        epoch++;
        personal.clear();
        page.clear();
        shared.clear();
        activation.clear();
        importAdoption?.abort();
        publish({
          target: null,
          active: null,
          loaded: [],
          loadedCoverage: [],
          loadedLimitReached: false,
          loadedPartial: false,
          loadedPages: [],
        });
        return;
      }
      chooseTarget({ connection: context.connection, workspaceId: workspace.value });
    },
    selectSavedTarget(target) {
      chooseTarget(captureTarget(target));
    },
    async inspectInventory() {
      await inventory
        .load("private-saved-targets", (signal) => settings.list(signal), { live: true })
        .catch(() => undefined);
    },
    newView(scope) {
      if (state.target === null || state.draft !== null) return;
      const document = defaultView(newId("view"), scope);
      beginDraft(state.target, "", { kind: "new" });
      void encodeCandidate(asJson(document));
    },
    newRenderer() {
      if (state.target === null || state.draft !== null) return;
      const document = defaultRenderer(newId("renderer"));
      beginDraft(state.target, "", { kind: "new" });
      void encodeCandidate(asJson(document));
    },
    editPersonal(id) {
      const observed = current(personal.get());
      if (state.draft !== null || observed === undefined) return;
      const document = observed.documents.find((item) => item.id === id);
      if (document !== undefined)
        beginDraft(observed.target, document.source, { kind: "personal", id });
    },
    editSource(source) {
      const draft = state.draft;
      if (draft?.kind !== "editing" || preparing !== null) return;
      activation.clear();
      draftOwner?.abort();
      publish({
        draft: { ...draft, source, form: null, busy: true, decoded: null, message: null },
      });
      void validateSource(draft.id, source);
    },
    editForm(form) {
      const draft = state.draft;
      if (draft?.kind !== "editing" || preparing !== null) return;
      const candidate = captureJson(form.candidate);
      const text = Object.entries(form.text);
      if (
        !candidate.ok ||
        text.length > 100 ||
        text.reduce(
          (sum, [key, value]) =>
            sum +
            new TextEncoder().encode(key).byteLength +
            new TextEncoder().encode(value).byteLength,
          0,
        ) > 65536 ||
        form.errors.length > 100
      ) {
        publish({
          draft: {
            ...draft,
            busy: false,
            message: "Form state exceeds the bounded editor budget. Repair in Raw source.",
          },
        });
        return;
      }
      const retained: FormDraft = Object.freeze({
        candidate: candidate.value,
        text: Object.freeze(Object.fromEntries(text)),
        errors: Object.freeze(
          form.errors.map((issue) =>
            Object.freeze({ path: Object.freeze([...issue.path]), message: issue.message }),
          ),
        ),
      });
      void encodeCandidate(retained.candidate, retained);
    },
    editDocument(document) {
      void encodeCandidate(asJson(document));
    },
    setMode(mode) {
      if (state.draft?.kind === "editing") publish({ draft: { ...state.draft, mode } });
    },
    async activate() {
      const draft = state.draft,
        document =
          draft?.kind === "editing" &&
          !draft.busy &&
          (draft.form === null || draft.form.errors.length === 0)
            ? editable(draft.decoded)
            : null;
      if (
        draft?.kind !== "editing" ||
        document?.kind !== "view" ||
        state.target === null ||
        !sameTarget(state.target, draft.target)
      )
        return;
      const before = epoch;
      const result = await activation
        .load(`${targetKey(draft.target)}:${draft.id}:${newId("activate")}`, (signal) =>
          adapter.initial(draft.target, document, signal),
        )
        .catch(() => null);
      if (
        disposed ||
        before !== epoch ||
        state.draft?.id !== draft.id ||
        result === null ||
        !result.ok
      )
        return;
      epoch++;
      activePage = result.data;
      publish({
        active: { target: draft.target, view: document, origin: draft.origin },
        loaded: Object.freeze(result.data.rows.slice(0, 512)),
        loadedCoverage: (result.data.enrichment?.rows ?? []).filter((item) =>
          result.data.rows.slice(0, 512).some((row) => row.identity === item.identity),
        ),
        loadedLimitReached:
          result.data.rows.length > 512 ||
          (result.data.rows.length >= 512 && result.data.next !== null),
        loadedPartial: result.data.partial,
        loadedPages: Object.freeze([result.data]),
        message: null,
      });
      await loadPage(undefined, result);
    },
    refresh: () => loadPage(),
    continue: (kind) => loadPage(kind),
    async savePersonal() {
      const draft = state.draft;
      if (
        draft?.kind !== "editing" ||
        draft.busy ||
        (draft.form !== null && draft.form.errors.length > 0) ||
        state.personalSave.kind === "saving" ||
        state.personalSave.kind === "unknown" ||
        state.personalSave.kind === "conflict" ||
        state.personalSave.kind === "rejected"
      )
        return;
      const base = draft.personalBase;
      if (base === null || !sameTarget(base.target, draft.target)) {
        publish({
          message:
            "Inspect the exact personal settings target, then explicitly rebase this draft before saving.",
        });
        return;
      }
      const document = editable(draft.decoded),
        id = document?.id ?? (draft.origin.kind === "personal" ? draft.origin.id : null);
      if (id === null) {
        publish({
          message:
            "Unknown/invalid new source needs an existing document ID before it can be preserved privately.",
        });
        return;
      }
      await save({
        target: draft.target,
        expectedRevision: base.revision,
        documents: replaceDocument(base.documents, { id, source: draft.source }),
        selectedId: base.selectedId,
      });
    },
    inspectPersonal,
    async retryPersonal() {
      const saved = state.personalSave;
      if (saved.kind !== "conflict" || saved.observed.revision !== saved.plan.expectedRevision) {
        publish({
          message:
            "Inspect the original save first. Exact retry is available only if its original private revision is still current.",
        });
        return;
      }
      await save(saved.plan);
    },
    async discardPersonalSave() {
      const saved = state.personalSave,
        target = state.target;
      if (disposed || state.draft !== null || saved.kind !== "conflict" || target === null) return;
      const retained = captureTarget(target);
      reconcileOwner?.abort();
      personal.clear();
      publish({
        personalSave: { kind: "idle" },
        message:
          "Saved intention explicitly discarded. This does not undo or resolve any earlier publication. Inspecting current settings before a new deliberate action.",
      });
      await personal
        .load(targetKey(retained), (signal) => settings.inspect(retained, signal))
        .catch(() => undefined);
    },
    rebasePersonal() {
      const draft = state.draft,
        saved = state.personalSave,
        observed = saved.kind === "conflict" ? saved.observed : current(personal.get());
      if (
        draft?.kind !== "editing" ||
        observed === undefined ||
        !sameTarget(observed.target, draft.target) ||
        saved.kind === "saving" ||
        saved.kind === "unknown" ||
        saved.kind === "rejected"
      )
        return;
      publish({
        draft: {
          ...draft,
          personalBase: observed,
          message: "Explicit new save guard captured. Review before saving.",
        },
        personalSave: { kind: "idle" },
      });
    },
    async setPersonalDefault(id) {
      const observed = current(personal.get());
      if (
        observed === undefined ||
        (id !== null && !observed.documents.some((item) => item.id === id)) ||
        ["saving", "unknown", "conflict", "rejected"].includes(state.personalSave.kind)
      )
        return;
      await save({
        target: observed.target,
        expectedRevision: observed.revision,
        documents: observed.documents,
        selectedId: id,
      });
    },
    async removePersonal(id) {
      if (
        state.personalSave.kind === "saving" ||
        state.personalSave.kind === "unknown" ||
        state.personalSave.kind === "conflict" ||
        state.personalSave.kind === "rejected"
      )
        return;
      const observed = current(personal.get());
      if (observed === undefined) return;
      await save({
        target: observed.target,
        expectedRevision: observed.revision,
        documents: observed.documents.filter((document) => document.id !== id),
        selectedId: observed.selectedId === id ? null : observed.selectedId,
      });
    },
    async exportPersonal() {
      const observed = current(personal.get());
      if (observed === undefined) return null;
      const encoded = await http.processing.encode(
        portableJson(observed.documents, observed.selectedId),
        { canonical: true, limits: privateLimits },
      );
      if (!encoded.ok || !encoded.value.ok) {
        publish({ message: processingMessage(encoded) });
        return null;
      }
      return new Blob([encoded.value.value], { type: "application/json" });
    },
    async importSource(source) {
      importAdoption?.abort();
      const owner = new AbortController();
      stopDraft();
      draftOwner = owner;
      try {
        const result = await http.processing.parse(source, {
          limits: privateLimits,
          signal: owner.signal,
        });
        if (disposed || draftOwner !== owner || owner.signal.aborted) return;
        if (!result.ok || !result.value.ok) {
          publish({ message: processingMessage(result) });
          return;
        }
        const portable = portableCodec.decode(result.value.value.value);
        if (!portable.ok) {
          publish({ message: `Portable settings: ${portable.issue.expected}` });
          return;
        }
        const documents = [];
        for (const document of portable.value.documents) {
          const decoded = await decodeSource(http, document.source, owner.signal);
          if (disposed || draftOwner !== owner || owner.signal.aborted) return;
          if (decoded.kind === "invalid_json") {
            publish({
              message:
                "Imported source contains invalid JSON. Repair it before import; existing settings are unchanged.",
            });
            return;
          }
          documents.push({ ...document, decoded, mappedScope: null });
        }
        publish({
          imported: { documents, selectedId: portable.value.selected_id },
          message:
            "Review imported sources and explicitly map each view scope. Nothing was saved or activated.",
        });
      } catch (error) {
        if (!disposed && draftOwner === owner && !owner.signal.aborted) {
          if (error instanceof ConfigProcessingError)
            publish({ message: `[${error.kind}] ${error.message}` });
          else unexpected(error);
        }
      }
    },
    mapImport(index, scope) {
      importAdoption?.abort();
      if (state.imported === null) return;
      publish({
        imported: {
          ...state.imported,
          documents: state.imported.documents.map((document, i) =>
            i === index
              ? { ...document, mappedScope: scope === null ? null : Object.freeze({ ...scope }) }
              : document,
          ),
        },
      });
    },
    async adoptImport() {
      const imported = state.imported,
        observed = current(personal.get()),
        target = state.target;
      if (
        imported === null ||
        observed === undefined ||
        target === null ||
        !sameTarget(target, observed.target) ||
        ["saving", "unknown", "conflict", "rejected"].includes(state.personalSave.kind)
      )
        return;
      const owner = new AbortController(),
        before = epoch;
      importAdoption?.abort();
      importAdoption = owner;
      const owns = () =>
        !disposed &&
        !owner.signal.aborted &&
        importAdoption === owner &&
        epoch === before &&
        state.imported === imported;
      try {
        let documents = observed.documents;
        for (const item of imported.documents) {
          let source = item.source;
          if (
            item.decoded.kind === "valid" &&
            "kind" in item.decoded.document &&
            item.decoded.document.kind === "view"
          ) {
            if (item.mappedScope === null) {
              publish({
                message: "Map every imported view to an explicit local scope before saving.",
              });
              return;
            }
            const mapped = configJson({ ...item.decoded.document, scope: item.mappedScope });
            const decoded = decodeConfigValue(mapped);
            if (decoded.kind !== "valid") {
              publish({
                message:
                  decoded.kind === "invalid"
                    ? decoded.issues
                        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                        .join("; ")
                    : "Mapped source is not a supported configuration.",
              });
              return;
            }
            const encoded = await http.processing.encode(mapped, {
              limits: CONFIG_LIMITS,
              canonical: true,
              signal: owner.signal,
            });
            if (!owns()) return;
            if (!encoded.ok || !encoded.value.ok) {
              publish({ message: processingMessage(encoded) });
              return;
            }
            source = encoded.value.value;
          }
          documents = replaceDocument(documents, { id: item.id, source });
        }
        if (!owns()) return;
        await save({
          target: observed.target,
          expectedRevision: observed.revision,
          documents,
          selectedId: imported.selectedId,
        });
      } catch (error) {
        if (owns()) unexpected(error);
      } finally {
        if (importAdoption === owner) importAdoption = null;
      }
    },
    async loadShared(scope) {
      const target = state.target;
      if (target === null) return;
      const retained = Object.freeze({ ...scope });
      await shared
        .load(
          `${targetKey(target)}:${retained.kind}:${"id" in retained ? retained.id : ""}`,
          (signal) => catalogs.load(target, retained, signal),
          { live: true },
        )
        .catch(() => undefined);
    },
    async openShared(id) {
      const catalog = current(shared.get());
      if (catalog === undefined || state.draft !== null) return;
      const owner = new AbortController(),
        before = epoch;
      stopDraft();
      draftOwner = owner;
      try {
        const result = await catalogs.open(catalog, id, owner.signal);
        if (disposed || before !== epoch || draftOwner !== owner || owner.signal.aborted) return;
        if (!result.ok) {
          publish({ message: `[${result.kind}] ${result.message}` });
          return;
        }
        const source = await result.capture.blob.text();
        if (disposed || before !== epoch || draftOwner !== owner || owner.signal.aborted) return;
        beginDraft(result.capture.scope, source, { kind: "shared", capture: result.capture });
      } catch (error) {
        if (!disposed && before === epoch && draftOwner === owner && !owner.signal.aborted) {
          if (error instanceof ConfigInputError) publish({ message: error.message });
          else unexpected(error);
        }
      }
    },
    async prepareShared(context, input) {
      const draft = state.draft,
        document =
          draft?.kind === "editing" &&
          !draft.busy &&
          (draft.form === null || draft.form.errors.length === 0)
            ? editable(draft.decoded)
            : null;
      if (draft?.kind !== "editing" || document === null || preparing !== null) return;
      const actor = d.identifier.decode(d.jsonString(context.writer.actorId ?? "")),
        run =
          context.writer.runId === null
            ? null
            : d.identifier.decode(d.jsonString(context.writer.runId));
      if (
        !actor.ok ||
        (run !== null && !run.ok) ||
        context.profileState !== "current" ||
        context.route.workspaceId !== draft.target.workspaceId ||
        !sameTarget(
          { connection: context.connection, workspaceId: draft.target.workspaceId },
          draft.target,
        )
      ) {
        publish({
          message:
            "Choose the draft's exact endpoint/workspace and explicit writer before preparing shared publication.",
        });
        return;
      }
      const owner = new AbortController();
      draftOwner?.abort();
      draftOwner = owner;
      preparing = owner;
      const retained = {
        documentResourceId: input.documentResourceId,
        catalogResourceId: input.catalogResourceId,
        indexScope: Object.freeze({ ...input.indexScope }),
        link: Object.freeze({ ...input.link }),
      };
      publish({
        draft: {
          ...draft,
          busy: true,
          message: "Capturing independent content, metadata and index guards…",
        },
      });
      try {
        const prepared = await catalogs.prepare(
          draft.target,
          document,
          newId("publish"),
          { actorId: actor.value, runId: run === null || !run.ok ? null : run.value },
          retained,
          owner.signal,
        );
        if (!ownDraft(owner, draft.id)) return;
        publish({ draft: { kind: "captured", id: draft.id, prepared } });
        const registered = await operations.register(prepared.preparation);
        if (!registered.ok) {
          if (!disposed) publish({ message: failureText(registered) });
          return;
        }
        if (
          disposed ||
          owner.signal.aborted ||
          draftOwner !== owner ||
          state.draft?.id !== draft.id
        )
          return;
        const preparedAction = await operations.act(prepared.preparation.intention_id, "prepare");
        if (!preparedAction.ok && !disposed) publish({ message: failureText(preparedAction) });
      } catch (error) {
        if (
          !disposed &&
          draftOwner === owner &&
          !owner.signal.aborted &&
          state.draft?.id === draft.id
        ) {
          if (
            state.draft.kind === "editing" &&
            (error instanceof ConfigInputError ||
              error instanceof ConfigProcessingError ||
              error instanceof SharedReadError)
          )
            publish({ draft: { ...state.draft, busy: false, message: error.message } });
          else {
            if (state.draft.kind === "editing") publish({ draft: { ...state.draft, busy: false } });
            unexpected(error);
          }
        }
      } finally {
        if (preparing === owner) preparing = null;
      }
    },
    discardDraft() {
      stopDraft();
      publish({ draft: null });
    },
    dispose() {
      disposed = true;
      stopPersonalLabels();
      epoch++;
      stopDraft();
      reconcileOwner?.abort();
      personal.dispose();
      inventory.dispose();
      page.dispose();
      shared.dispose();
      activation.dispose();
      importAdoption?.abort();
      catalogs.dispose();
      listeners.clear();
    },
  };
  return controller;
}
