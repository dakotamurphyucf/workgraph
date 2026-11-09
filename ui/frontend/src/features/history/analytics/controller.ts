import type { Identifier } from "../../../core/protocol/types";
import { refreshSlots, createReadSlot, type ReadSlot } from "../../../core/state/read-slot";
import * as d from "../../../core/protocol/decoders";
import { failureText } from "../../connections/failure";
import { ActionInputError } from "../../work/actions/model";
import { current } from "../transcript/controller";
import { createAnalyticsClient, searchFields, usageInvocation, usageQueryMatches } from "./client";
import { AnalyticsInputError, identifier, reportPreparation } from "./model";
import type { EventRef } from "../transcript/types";
import type {
  AnalyticsSelection,
  HistoryAnalyticsController,
  HistoryAnalyticsOptions,
  HistoryAnalyticsState,
  PlanningCapture,
  SearchCapture,
  SearchQuery,
  UsageAggregate,
  UsageDraft,
  UsageInput,
  UsagePage,
  UsageQuery,
} from "./types";

const defaultSearch: SearchQuery = {
  text: "",
  sessionId: "",
  kinds: [],
  capture: { kind: "current" },
  limit: "25",
  maxBytes: "1048576",
};
export const defaultUsage: UsageQuery = {
  group: "workspace",
  layout: "nested",
  projectId: "",
  milestoneId: "",
  ticketId: "",
  runId: "",
  attemptId: "",
  actorId: "",
  limit: "25",
  maxBytes: "1048576",
};
const key = (selection: AnalyticsSelection) => JSON.stringify(selection.scope);
const sameSearch = (a: SearchQuery, b: SearchQuery) =>
  a.text === b.text &&
  a.sessionId === b.sessionId &&
  JSON.stringify(a.kinds) === JSON.stringify(b.kinds) &&
  JSON.stringify(a.capture) === JSON.stringify(b.capture);
const identity = () => identifier(`ui-usage-${crypto.randomUUID()}`, "Intention");
export function createHistoryAnalyticsController({
  http,
  operations,
}: HistoryAnalyticsOptions): HistoryAnalyticsController {
  const client = createAnalyticsClient(http),
    search = createReadSlot<SearchCapture>(),
    aggregate = createReadSlot<PlanningCapture<UsageAggregate>>(),
    records = createReadSlot<PlanningCapture<UsagePage>>(),
    listeners = new Set<() => void>(),
    flights = new Map<Identifier, Promise<void>>();
  let disposed = false;
  let state: HistoryAnalyticsState = {
    selection: null,
    searchQuery: defaultSearch,
    search: search.get(),
    searchCapture: null,
    usageQuery: defaultUsage,
    aggregate: aggregate.get(),
    aggregateCapture: null,
    records: records.get(),
    recordsCapture: null,
    drafts: [],
    selectedDraftId: null,
    issue: null,
    unexpected: null,
  };
  const publish = (patch: Partial<HistoryAnalyticsState>) => {
    if (disposed) return;
    state = Object.freeze({ ...state, ...patch });
    for (const l of listeners) l();
  };
  search.subscribe(() => publish({ search: search.get() }));
  aggregate.subscribe(() => publish({ aggregate: aggregate.get() }));
  records.subscribe(() => publish({ records: records.get() }));
  const patch = (id: Identifier, p: Partial<UsageDraft>) =>
    publish({ drafts: state.drafts.map((v) => (v.id === id ? Object.freeze({ ...v, ...p }) : v)) });
  const find = (id: Identifier) => state.drafts.find((v) => v.id === id);
  function inputError(error: unknown) {
    if (error instanceof ActionInputError) publish({ issue: error.message });
    else publish({ unexpected: { error } });
  }
  const selected = () => {
    if (state.selection === null) throw new AnalyticsInputError("Select a workspace first.");
    return state.selection;
  };
  // ReadSlot owns expected and unexpected failures for its exact query. Its catch
  // consumes only the rethrow; it must not repaint a newer selection globally.
  function run<T>(
    slot: ReadSlot<T>,
    identity: string,
    read: (signal: AbortSignal) => Promise<import("../../../core/protocol/http").HttpResult<T>>,
    completed: (value: T) => void,
    live = false,
  ) {
    void slot
      .load(identity, read, {
        live,
        after: (value) => {
          if (!disposed) completed(value);
          return Promise.resolve();
        },
      })
      .catch(() => {});
  }
  function review(id: Identifier): Promise<void> {
    const existing = flights.get(id);
    if (existing !== undefined) return existing;
    const draft = find(id);
    if (draft === undefined || disposed) return Promise.resolve();
    patch(id, { pending: true, issue: null, unexpected: null });
    const task = Promise.resolve().then(async () => {
      try {
        let managed = operations.get(id);
        if (managed === undefined) {
          const preparation = reportPreparation(draft);
          patch(id, { frozen: preparation });
          const result = await operations.register(preparation);
          if (disposed || find(id) === undefined) return;
          if (!result.ok) {
            patch(id, { issue: failureText(result.failure) });
            return;
          }
          managed = result.entry;
        }
        patch(id, { frozen: managed.preparation });
        if (managed.phase.kind === "draft" || managed.operation === null) {
          const result = await operations.act(id, "prepare");
          if (!result.ok) patch(id, { issue: failureText(result.failure) });
        }
      } catch (error: unknown) {
        patch(
          id,
          error instanceof ActionInputError ? { issue: error.message } : { unexpected: { error } },
        );
      } finally {
        flights.delete(id);
        patch(id, { pending: false });
      }
    });
    flights.set(id, task);
    return task;
  }
  return {
    refreshLive: (signal) => refreshSlots([search, aggregate, records], signal),
    get: () => state,
    subscribe: (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    select(selection) {
      if (disposed) return;
      const changed = state.selection === null || key(selection) !== key(state.selection);
      publish({
        selection: structuredClone(selection),
        ...(changed
          ? {
              issue: null,
              unexpected: null,
              searchQuery: {
                ...defaultSearch,
                capture:
                  selection.head === undefined
                    ? { kind: "current" }
                    : {
                        kind: "pinned",
                        head: selection.head === null ? null : importDigest(selection.head),
                      },
              },
              usageQuery: defaultUsage,
              searchCapture: null,
              aggregateCapture: null,
              recordsCapture: null,
            }
          : {}),
      });
      if (changed) {
        search.clear();
        aggregate.clear();
        records.clear();
      }
    },
    search(query, next = false) {
      try {
        const selection = selected(),
          previous = current(search.get()) ?? state.searchCapture ?? undefined;
        let frozen: SearchQuery = structuredClone(query),
          after: EventRef | null = null;
        if (next) {
          if (
            previous === undefined ||
            !sameSearch(previous.query, query) ||
            previous.data.next === null
          )
            throw new AnalyticsInputError(
              "Continue the unchanged, complete-index search capture, or start a new search explicitly.",
            );
          after = previous.data.next;
          frozen = { ...frozen, capture: { kind: "pinned", head: previous.capture.head } };
        }
        // Validate synchronously before creating the location-owned read.
        searchFields(frozen, after);
        const submitted = structuredClone(query);
        publish({ searchQuery: submitted, issue: null, ...(!next ? { searchCapture: null } : {}) });
        run(
          search,
          JSON.stringify([key(selection), frozen, after]),
          async (signal) => {
            const result = await client.search(selection.scope, frozen, after, signal);
            if (result.ok) return { ...result, data: { ...result.data, query: submitted } };
            return result;
          },
          (value) => publish({ searchCapture: value }),
          !next && frozen.capture.kind === "current",
        );
      } catch (error: unknown) {
        inputError(error);
      }
    },
    aggregate(query, next = false) {
      try {
        const selection = selected(),
          previous = current(aggregate.get()) ?? state.aggregateCapture ?? undefined;
        if (
          next &&
          (previous === undefined ||
            !usageQueryMatches(previous.invocation, selection.scope, query) ||
            previous.data.cursor === null)
        )
          throw new AnalyticsInputError(
            "Continue the unchanged usage filters/layout or explicitly rescan current membership.",
          );
        const frozen = structuredClone(query),
          cursor = next ? (previous?.data.cursor ?? undefined) : undefined,
          revision = next ? previous?.revision : undefined;
        usageInvocation(selection.scope, frozen, cursor, revision);
        publish({ usageQuery: frozen, issue: null, ...(!next ? { aggregateCapture: null } : {}) });
        run(
          aggregate,
          JSON.stringify([key(selection), frozen, cursor, revision]),
          (signal) => client.aggregate(selection.scope, frozen, cursor, revision, signal),
          (value) => publish({ aggregateCapture: value }),
          !next,
        );
      } catch (error: unknown) {
        inputError(error);
      }
    },
    records(next = false) {
      try {
        const selection = selected(),
          previous = current(records.get()) ?? state.recordsCapture ?? undefined;
        if (next && (previous === undefined || previous.data.next_offset === null))
          throw new AnalyticsInputError("There is no next captured usage page.");
        const offset = next ? (previous?.data.next_offset ?? undefined) : undefined,
          revision = next ? previous?.revision : undefined;
        if (!next) publish({ recordsCapture: null });
        run(
          records,
          JSON.stringify([key(selection), offset, revision]),
          (signal) => client.records(selection.scope, offset, revision, signal),
          (value) => publish({ recordsCapture: value }),
          !next,
        );
      } catch (error: unknown) {
        inputError(error);
      }
    },
    newReport(context) {
      try {
        const selection = selected();
        if (
          context.profileState !== "current" ||
          context.connection.id !== selection.scope.connectionId ||
          context.connection.generation !== selection.scope.generation ||
          context.route.workspaceId !== selection.scope.workspaceId
        )
          throw new AnalyticsInputError(
            "Open the current endpoint generation before creating a usage report. Retained history stays readable.",
          );
        identifier(context.writer.actorId ?? "", "Acting author");
        if (state.drafts.length >= 16)
          throw new AnalyticsInputError(
            "Discard an unused report editor before opening another (limit 16).",
          );
        const id = identity(),
          draft: UsageDraft = {
            id,
            context: {
              ...context,
              route: { ...context.route },
              writer: { ...context.writer },
              connection: { ...context.connection },
            },
            input: {
              usageId: identity(),
              scopeKind: "run",
              scopeId: context.writer.runId ?? "",
              tokens: "",
              elapsedMs: "",
              metrics: [],
              provenance: "",
              timestamp: "",
            },
            frozen: null,
            pending: false,
            issue: null,
            unexpected: null,
          };
        publish({ drafts: [...state.drafts, draft], selectedDraftId: id, issue: null });
      } catch (error: unknown) {
        inputError(error);
      }
    },
    editReport(id, input) {
      const draft = find(id);
      if (
        draft === undefined ||
        draft.pending ||
        draft.frozen !== null ||
        operations.get(id) !== undefined
      )
        return;
      const size = new TextEncoder().encode(JSON.stringify(input)).length;
      if (size > 12_000 || input.metrics.length > 16) {
        patch(id, {
          issue: "Report input exceeds the retained editor budget; previous text was preserved.",
        });
        return;
      }
      const frozen: UsageInput = structuredClone(input);
      patch(id, { input: frozen, issue: null });
    },
    selectReport(id) {
      if (id === null || find(id) !== undefined) publish({ selectedDraftId: id });
    },
    discardReport(id) {
      if (find(id)?.pending) return;
      publish({
        drafts: state.drafts.filter((v) => v.id !== id),
        selectedDraftId: state.selectedDraftId === id ? null : state.selectedDraftId,
      });
    },
    reviewReport: review,
    dispose() {
      disposed = true;
      search.dispose();
      aggregate.dispose();
      records.dispose();
      listeners.clear();
    },
  };
}
function importDigest(value: string) {
  const result = d.digest.decode(d.jsonString(value));
  if (!result.ok) throw new AnalyticsInputError("Invalid immutable History head.");
  return result.value;
}
