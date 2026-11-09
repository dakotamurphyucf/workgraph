import { readTicketCollection } from "./collection";
import type { WriterSelection } from "../../app/types";
import type { JsonValue } from "../../core/json";
import { createCompanion } from "../../core/protocol/client";
import type { Codec } from "../../core/protocol/codec";
import * as c from "../../core/protocol/codec";
import * as d from "../../core/protocol/decoders";
import type { Decimal, Identifier, JsonObject } from "../../core/protocol/types";
import {
  refreshSlots,
  createReadSlot,
  readKey,
  type ReadSlot,
  type ReadState,
} from "../../core/state/read-slot";
import { committedWorkWrite } from "./freshness";
import {
  atPath,
  contextCodec,
  decodeCapture,
  factPageCodec,
  listCodec,
  pageCodec,
  readinessCodec,
  ticketReadCodec,
} from "./read-model.codec";
import type {
  Capture,
  Continuation,
  Page,
  Readiness,
  Ticket,
  TicketContext,
  TicketRead,
  WorkController,
  WorkControllerOptions,
  WorkFilters,
  WorkScope,
  WorkState,
} from "./read-model.types";

export const DEFAULT_WORK_FILTERS: WorkFilters = Object.freeze({
  text: "",
  status: "",
  priority: "",
  assigneeId: "",
  labelId: "",
  milestoneId: "",
  includeArchived: false,
});
export function current<T>(state: ReadState<T>): T | undefined {
  return state.kind === "ready" ? state.value : state.kind === "idle" ? undefined : state.previous;
}
export function workScopeKey(scope: WorkScope): string {
  return JSON.stringify([
    scope.connection.id,
    scope.connection.generation,
    scope.connection.socket,
    scope.workspaceId,
    scope.projectId,
  ]);
}
function validatedWriterId(value: string | null | undefined): Identifier | undefined {
  if (value == null) return undefined;
  const result = d.identifier.decode(d.jsonString(value));
  if (!result.ok) throw new Error("Invalid writer identity.");
  return result.value;
}
function scopeReadKey(
  scope: WorkScope,
  method: string,
  params: JsonObject,
  writer: WriterSelection | null = null,
): string {
  return readKey(
    {
      connectionId: scope.connection.id,
      generation: scope.connection.generation,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId ?? undefined,
      actorId: validatedWriterId(writer?.actorId),
      runId: validatedWriterId(writer?.runId),
      history: { kind: "current" },
    },
    method,
    params,
  );
}
function baseParams(scope: WorkScope, revision: Decimal | undefined): [string, JsonValue][] {
  return [
    ["workspace_id", d.jsonString(scope.workspaceId)],
    ["max_bytes", d.jsonString("1048576")],
    ...(revision === undefined
      ? []
      : [["at_revision", d.jsonString(revision)] as [string, JsonValue]]),
  ];
}
export function queryParams(scope: WorkScope, filters: WorkFilters): JsonObject {
  const fields = baseParams(scope, undefined);
  fields.push(
    ["limit", d.jsonString("40")],
    ["include_archived", d.jsonBoolean(filters.includeArchived)],
  );
  if (scope.projectId !== null) fields.push(["project_id", d.jsonString(scope.projectId)]);
  for (const [key, value] of [
    ["text", filters.text],
    ["status", filters.status],
    ["priority", filters.priority],
    ["assignee_id", filters.assigneeId],
    ["label_id", filters.labelId],
    ["milestone_id", filters.milestoneId],
  ] as const)
    if (value !== "") fields.push([key, d.jsonString(value)]);
  return d.jsonObject(fields);
}
export function createWorkController({
  client,
  operations,
}: WorkControllerOptions): WorkController {
  const companion = createCompanion(client),
    list = createReadSlot<Capture<Page<Ticket>>>(),
    ticket = createReadSlot<Capture<TicketRead>>(),
    detail = createReadSlot<Capture<TicketContext>>(),
    readiness = createReadSlot<Capture<Readiness>>();
  const listeners = new Set<() => void>(),
    sections = new Map<string, ReadSlot<Capture<Page<JsonValue>>>>(),
    assessed = new Map<string, ReadSlot<Capture<Readiness>>>();
  let disposed = false,
    epoch = 0,
    queryEpoch = 0;
  let listRequest: Continuation | null = null;
  let previousPages: readonly Continuation[] = [];
  // Only page navigation may retain the last page across offset keys. Scope,
  // filter and explicit refresh reset this before starting a different query.
  let retainedPage: Capture<Page<Ticket>> | undefined;
  let state: WorkState = {
    ownWrite: null,
    scope: null,
    filters: DEFAULT_WORK_FILTERS,
    layout: "list",
    grouping: "status",
    tab: "activity",
    list: list.get(),
    canPageBack: false,
    selectedId: null,
    ticket: ticket.get(),
    context: detail.get(),
    readiness: readiness.get(),
    readinessTarget: null,
    sections: {},
    assessed: {},
    assessing: false,
  };
  const publish = (patch: Partial<WorkState>) => {
    state = { ...state, ...patch };
    if (!disposed) for (const listener of listeners) listener();
  };
  const observeWrites = () => {
    const ownWrite =
      state.scope === null || operations === undefined
        ? null
        : committedWorkWrite(state.scope, operations.list());
    if (
      ownWrite?.workspaceRevision !== state.ownWrite?.workspaceRevision ||
      ownWrite?.operationId !== state.ownWrite?.operationId
    )
      publish({ ownWrite });
  };
  const stopWrites = operations?.subscribe(observeWrites);
  list.subscribe(() => {
    const read = list.get();
    publish({
      list:
        read.kind === "loading" || read.kind === "failed" || read.kind === "unexpected_error"
          ? { ...read, previous: read.previous ?? retainedPage }
          : read,
    });
  });
  ticket.subscribe(() => publish({ ticket: ticket.get() }));
  detail.subscribe(() => publish({ context: detail.get() }));
  readiness.subscribe(() => publish({ readiness: readiness.get() }));
  const clearMap = <T>(map: Map<string, ReadSlot<T>>) => {
    for (const slot of map.values()) slot.dispose();
    map.clear();
  };
  const clearDetail = () => {
    ticket.clear();
    detail.clear();
    readiness.clear();
    clearMap(sections);
    publish({ sections: {}, readinessTarget: null });
  };
  const clearAssessments = () => {
    epoch++;
    clearMap(assessed);
    publish({ assessed: {}, assessing: false });
  };
  async function load<T>(
    slot: ReadSlot<Capture<T>>,
    scope: WorkScope,
    request: Continuation | { readonly method: string; readonly params: JsonObject },
    codec: Codec<T>,
    writer: WriterSelection | null = null,
    live = false,
  ) {
    await slot.load(
      scopeReadKey(scope, request.method, request.params, writer),
      async (signal) => {
        const result = await companion.read(
          {
            connection_id: scope.connection.id,
            generation: scope.connection.generation,
            method: request.method,
            params: request.params,
            lane: "visible",
          },
          signal,
        );
        if (!result.ok) return result;
        const decoded = decodeCapture(result.data, codec, scope, request.method, request.params);
        return decoded.ok
          ? { ok: true, data: decoded.value, httpStatus: result.httpStatus }
          : {
              ok: false,
              failure: {
                kind: "protocol",
                message: "Invalid ticket read response.",
                issue: decoded.issue,
              },
            };
      },
      { live },
    );
  }
  async function loadCollection(scope: WorkScope, request: Continuation) {
    await list.load(
      scopeReadKey(scope, request.method, request.params),
      (signal) =>
        readTicketCollection(
          request,
          async (next) => {
            const result = await companion.read(
              {
                connection_id: scope.connection.id,
                generation: scope.connection.generation,
                method: next.method,
                params: next.params,
                lane: "visible",
              },
              signal,
            );
            if (!result.ok) return result;
            const decoded = decodeCapture(result.data, listCodec, scope, next.method, next.params);
            return decoded.ok
              ? { ok: true, data: decoded.value, httpStatus: result.httpStatus }
              : {
                  ok: false,
                  failure: {
                    kind: "protocol",
                    message: "Invalid ticket collection response.",
                    issue: decoded.issue,
                  },
                };
          },
          signal,
        ),
      { live: true },
    );
  }
  function selectedParams(scope: WorkScope, id: Identifier, revision: Decimal | undefined) {
    return d.jsonObject([...baseParams(scope, revision), ["ticket_id", d.jsonString(id)]]);
  }
  async function select(id: Identifier | null) {
    const scope = state.scope;
    clearDetail();
    publish({ selectedId: id, tab: "activity" });
    if (scope === null || id === null) return;
    const params = selectedParams(scope, id, undefined);
    await Promise.all([
      load(ticket, scope, { method: "ticket.read", params }, ticketReadCodec, null, true),
      load(
        detail,
        scope,
        {
          method: "ticket.context",
          params: d.jsonObject([
            ...params.fields.map((f) => [f.name, f.value] as [string, JsonValue]),
            ["limit", d.jsonString("20")],
            ["include_archived", d.jsonBoolean(state.filters.includeArchived)],
          ]),
        },
        contextCodec,
        null,
        true,
      ),
      load(readiness, scope, { method: "ticket.readiness", params }, readinessCodec, null, true),
    ]);
  }
  function pinListRequest(request: Continuation, revision: Decimal): Continuation {
    return {
      method: "ticket.list",
      params: d.jsonObject([
        ...request.params.fields
          .filter((f) => f.name !== "at_revision")
          .map((f) => [f.name, f.value] as [string, JsonValue]),
        ["at_revision", d.jsonString(revision)],
      ]),
    };
  }
  async function loadList() {
    const scope = state.scope;
    if (scope === null) return;
    const identity = ++queryEpoch;
    clearAssessments();
    listRequest = null;
    previousPages = [];
    retainedPage = undefined;
    publish({ canPageBack: false });
    const request: Continuation = {
      method: "ticket.list",
      params: queryParams(scope, state.filters),
    };
    await loadCollection(scope, request);
    const result = list.get();
    if (identity === queryEpoch && state.scope === scope && result.kind === "ready")
      listRequest = pinListRequest(request, result.value.revision);
    return identity;
  }
  async function refresh() {
    const scope = state.scope,
      selected = state.selectedId;
    const identity = await loadList();
    if (identity === queryEpoch && scope === state.scope && selected === state.selectedId)
      await refreshSlots([ticket, detail, readiness], new AbortController().signal);
  }
  const controller: WorkController = {
    refreshLive: async (signal) => {
      const identity = queryEpoch;
      const result = await refreshSlots([list, ticket, detail, readiness], signal);
      const observed = list.get();
      if (
        !signal.aborted &&
        identity === queryEpoch &&
        previousPages.length === 0 &&
        observed.kind === "ready" &&
        state.scope !== null &&
        listRequest !== null
      )
        listRequest = pinListRequest(listRequest, observed.value.revision);
      return result;
    },
    get: () => state,
    subscribe(listener) {
      if (disposed) throw new Error("Work controller disposed");
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async open(scope, id) {
      if (disposed) throw new Error("Work controller disposed");
      if (state.scope === null || workScopeKey(state.scope) !== workScopeKey(scope)) {
        list.clear();
        clearDetail();
        clearAssessments();
        publish({ scope, selectedId: id, tab: "activity", ownWrite: null });
        observeWrites();
        const identity = await loadList();
        if (identity === queryEpoch && state.scope === scope && state.selectedId === id)
          await select(id);
      } else if (state.selectedId !== id) await select(id);
    },
    async setFilters(filters) {
      const size = new TextEncoder().encode(filters.text).byteLength;
      if (size > 256) throw new Error("Search text exceeds 256 UTF-8 bytes.");
      for (const id of [filters.assigneeId, filters.labelId, filters.milestoneId])
        if (id !== "" && !d.identifier.decode(d.jsonString(id)).ok)
          throw new Error("Filters require valid identifiers.");
      publish({ filters: Object.freeze({ ...filters }) });
      await refresh();
    },
    setPresentation(patch) {
      publish(patch);
    },
    refresh,
    async page(kind) {
      const scope = state.scope,
        read = state.list,
        from = listRequest;
      if (scope === null || read.kind === "loading" || from === null) return;
      const capture = current(read);
      if (capture === undefined) return;
      const request =
        kind === "previous"
          ? previousPages.at(-1)
          : capture.controls.find((c) => c.path === "/data")?.[kind];
      if (!request) return;
      const identity = ++queryEpoch;
      clearAssessments();
      retainedPage = capture;
      await load(list, scope, request, listCodec);
      const result = list.get();
      if (identity !== queryEpoch || state.scope !== scope || result.kind !== "ready") return;
      if (kind === "previous") previousPages = previousPages.slice(0, -1);
      else if (kind === "next") previousPages = [...previousPages, from];
      listRequest = pinListRequest(request, result.value.revision);
      publish({ canPageBack: previousPages.length > 0 });
    },
    select,
    async assess(writer) {
      const scope = state.scope,
        id = state.selectedId;
      if (scope === null || id === null) return;
      const target = writer === null ? null : Object.freeze({ ...writer });
      const fields = selectedParams(
        scope,
        id,
        current(ticket.get())?.revision ?? current(list.get())?.revision,
      ).fields.map((f) => [f.name, f.value] as [string, JsonValue]);
      if (target !== null) {
        if (target.runId !== null) fields.push(["target_run_id", d.jsonString(target.runId)]);
        else if (target.actorId !== null)
          fields.push([
            "candidate",
            d.jsonObject([
              ["actor_id", d.jsonString(target.actorId)],
              ["capabilities", d.jsonArray([])],
            ]),
          ]);
        else return;
      }
      publish({ readinessTarget: target });
      await load(
        readiness,
        scope,
        { method: "ticket.readiness", params: d.jsonObject(fields) },
        readinessCodec,
        target,
      );
    },
    async assessLoaded() {
      const scope = state.scope,
        capture = current(list.get());
      if (scope === null || capture === undefined || state.assessing) return;
      clearAssessments();
      const identity = epoch;
      publish({ assessing: true });
      let index = 0;
      async function worker() {
        while (identity === epoch && index < capture!.value.items.length) {
          const item = capture!.value.items[index++];
          if (!item) break;
          const slot = createReadSlot<Capture<Readiness>>();
          assessed.set(item.ticket_id, slot);
          slot.subscribe(() =>
            publish({ assessed: { ...state.assessed, [item.ticket_id]: slot.get() } }),
          );
          await load(
            slot,
            scope!,
            {
              method: "ticket.readiness",
              params: selectedParams(scope!, item.ticket_id, capture!.revision),
            },
            readinessCodec,
          );
        }
      }
      try {
        await Promise.all([worker(), worker(), worker(), worker()]);
      } finally {
        if (identity === epoch) publish({ assessing: false });
      }
    },
    async section(path, kind) {
      const scope = state.scope,
        context = current(detail.get());
      if (scope === null || context === undefined) return;
      const previous = current(sections.get(path)?.get() ?? { kind: "idle" });
      const control =
        (previous ?? context).controls.find((p) => p.path === path) ??
        previous?.controls.find((p) => p.path === "/data");
      const request = control?.[kind];
      if (!request) return;
      let slot = sections.get(path);
      if (!slot) {
        slot = createReadSlot<Capture<Page<JsonValue>>>();
        sections.set(path, slot);
        const owned = slot;
        slot.subscribe(() => publish({ sections: { ...state.sections, [path]: owned.get() } }));
      }
      const sourceCodec =
        request.method === "fact.keys"
          ? pageCodec(c.raw)
          : path === "/data/fact_keys"
            ? factPageCodec
            : pageCodec(c.raw);
      const codec: Codec<Page<JsonValue>> = {
        decode: (value, at = []) =>
          sourceCodec.decode(atPath(value, control.responsePath.replace(/^\/data\/?/u, "")), at),
      };
      await load(slot, scope, request, codec);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopWrites?.();
      epoch++;
      list.dispose();
      ticket.dispose();
      detail.dispose();
      readiness.dispose();
      clearMap(sections);
      clearMap(assessed);
      listeners.clear();
    },
  };
  return controller;
}
