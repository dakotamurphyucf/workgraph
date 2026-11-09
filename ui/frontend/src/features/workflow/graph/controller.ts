import { jsonField } from "../../../core/json";
import { createCompanion } from "../../../core/protocol/client";
import type { Codec } from "../../../core/protocol/codec";
import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type { Decimal, Identifier, JsonObject } from "../../../core/protocol/types";
import {
  createReadSlot,
  readKey,
  type ReadSlot,
  type ReadCompletion,
} from "../../../core/state/read-slot";
import { workScopeKey } from "../../work/read-model";
import { failureText } from "../../connections/failure";
import { decodeCapture, ticketReadCodec } from "../../work/read-model.codec";
import type { Capture, Ticket, TicketRead, WorkScope } from "../../work/read-model.types";
import {
  GRAPH_LIMITS,
  ancestryGap,
  GraphInputError,
  captureRelationDraft,
  graphRecord,
  graphPositionBounds,
  hierarchyCodec,
  projectGraph,
} from "./model";
import type {
  GraphController,
  GraphControllerOptions,
  GraphRecord,
  GraphState,
  HierarchyPolicy,
} from "./types";

const emptyProjection = () => projectGraph(new Map(), new Map(), new Set());

export function createGraphController({
  http,
  readController,
}: GraphControllerOptions): GraphController {
  const companion = createCompanion(http),
    listeners = new Set<() => void>(),
    reference = createReadSlot<Capture<TicketRead>>(),
    policy = createReadSlot<Capture<HierarchyPolicy>>(),
    ancestorReference = createReadSlot<Capture<TicketRead>>(),
    ancestorPolicy = createReadSlot<Capture<HierarchyPolicy>>(),
    resolution =
      createReadSlot<Capture<{ readonly ticket_id: Identifier; readonly display_key: string }>>();
  let disposed = false,
    epoch = 0,
    lastPageId: string | null = null,
    lastTicketId: string | null = null;
  let state: GraphState = {
    scope: null,
    queryKey: null,
    revision: null,
    pages: [],
    expanded: new Map(),
    policies: new Map(),
    referenceRead: reference.get(),
    policyRead: policy.get(),
    resolutionRead: resolution.get(),
    projection: emptyProjection(),
    layers: { prerequisite: true, inherited: true, hierarchy: true, related: true },
    focus: "connected",
    grouping: "project",
    positions: new Map(),
    zoom: 1,
    ancestryLoading: false,
    ancestryIssue: null,
    issue: null,
    unexpected: null,
    composer: null,
    composerOpen: false,
  };
  const publish = (patch: Partial<GraphState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  function project() {
    const records = new Map<Identifier, GraphRecord>(),
      inQuery = new Set<Identifier>();
    let issue: string | null = null;
    function add(ticket: Ticket, capture: Capture<unknown>) {
      const record = graphRecord(ticket, capture);
      if (!record.ok) {
        issue = `Graph source rejected: ${record.issue.path.join(".")} must contain ${record.issue.expected}. Raw captured ticket remains available in the inspector.`;
        return;
      }
      records.set(ticket.ticket_id, record.value);
    }
    for (const page of state.pages)
      for (const ticket of page.value.items) {
        add(ticket, page);
        inQuery.add(ticket.ticket_id);
      }
    for (const capture of state.expanded.values()) add(capture.value.ticket, capture);
    publish({ projection: projectGraph(records, state.policies, inQuery), issue });
  }
  function reset(scope: WorkScope | null, queryKey: string | null) {
    epoch++;
    reference.clear();
    policy.clear();
    resolution.clear();
    ancestorReference.clear();
    ancestorPolicy.clear();
    lastPageId = null;
    lastTicketId = null;
    publish({
      scope,
      queryKey,
      revision: null,
      pages: [],
      expanded: new Map(),
      policies: new Map(),
      projection: emptyProjection(),
      positions: new Map(),
      issue: null,
      unexpected: null,
      ancestryLoading: false,
      ancestryIssue: null,
    });
  }
  function synchronize() {
    const work = readController.get(),
      scope = work.scope;
    const key = scope === null ? null : JSON.stringify([workScopeKey(scope), work.filters]);
    if (key !== state.queryKey) {
      const initial = state.queryKey === null;
      reset(scope, key);
      // Work publishes new filters before starting their read. Its previous ready
      // page still belongs to the old query and cannot enter this new projection.
      if (!initial && work.list.kind === "ready") lastPageId = work.list.value.id;
    }
    const page = work.list.kind === "ready" ? work.list.value : undefined;
    let changed = false;
    if (page !== undefined && page.id !== lastPageId) {
      lastPageId = page.id;
      if (page.value.offset === "0") {
        epoch++;
        reference.clear();
        policy.clear();
        resolution.clear();
        ancestorReference.clear();
        ancestorPolicy.clear();
        lastTicketId = null;
        publish({
          revision: page.revision,
          pages: [page],
          expanded: new Map(),
          policies: new Map(),
          positions: new Map(),
          issue: null,
          ancestryLoading: false,
          ancestryIssue: null,
        });
        changed = true;
      } else if (page.revision !== state.revision) {
        publish({
          issue:
            "The returned page belongs to a different capture. Refresh the graph to begin one coherent capture.",
        });
      } else {
        const before = state.pages.filter(
          (p) => BigInt(p.value.offset) < BigInt(page.value.offset),
        );
        const expected = before.reduce((count, p) => count + p.value.items.length, 0);
        if (BigInt(expected) !== BigInt(page.value.offset)) {
          publish({
            issue:
              "This page does not continue the loaded graph. Refresh before loading a new sequence.",
          });
        } else if (expected + page.value.items.length > GRAPH_LIMITS.tickets) {
          publish({
            issue: `The graph holds at most ${GRAPH_LIMITS.tickets} captured tickets. Narrow the query; this page was not added.`,
          });
        } else {
          publish({ pages: [...before, page], issue: null });
          changed = true;
        }
      }
    }
    const selected = work.ticket.kind === "ready" ? work.ticket.value : undefined;
    if (selected !== undefined && selected.id !== lastTicketId) {
      lastTicketId = selected.id;
      if (
        selected.revision === state.revision &&
        !state.pages.some((p) =>
          p.value.items.some((t) => t.ticket_id === selected.value.ticket.ticket_id),
        )
      ) {
        if (
          state.expanded.size + state.pages.reduce((n, p) => n + p.value.items.length, 0) <
          GRAPH_LIMITS.tickets
        ) {
          const expanded = new Map(state.expanded);
          expanded.set(selected.value.ticket.ticket_id, selected);
          publish({ expanded });
          changed = true;
        } else
          publish({
            issue:
              "The captured-ticket budget is full. Narrow the graph query before expanding another boundary.",
          });
      }
    }
    if (changed) project();
  }
  const unsubRead = readController.subscribe(synchronize),
    unsubReference = reference.subscribe(() => publish({ referenceRead: reference.get() })),
    unsubPolicy = policy.subscribe(() => publish({ policyRead: policy.get() })),
    unsubResolution = resolution.subscribe(() => publish({ resolutionRead: resolution.get() }));
  synchronize();
  async function load<T>(
    slot: ReadSlot<Capture<T>>,
    scope: WorkScope,
    revision: Decimal,
    method: "ticket.read" | "ticket.resolve" | "ticket.hierarchy.get",
    id: string,
    codec: Codec<T>,
  ): Promise<ReadCompletion<Capture<T>>> {
    const params: JsonObject = d.jsonObject([
      ["workspace_id", d.jsonString(scope.workspaceId)],
      [method === "ticket.resolve" ? "display_key" : "ticket_id", d.jsonString(id)],
      ...(method === "ticket.hierarchy.get"
        ? []
        : ([
            ["at_revision", d.jsonString(revision)],
            ["max_bytes", d.jsonString("1048576")],
          ] as const)),
    ]);
    const key = readKey(
      {
        connectionId: scope.connection.id,
        generation: scope.connection.generation,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId ?? undefined,
        actorId: undefined,
        runId: undefined,
        history: { kind: "current" },
      },
      method,
      params,
    );
    return slot.load(key, async (signal) => {
      const result = await companion
        .read(
          {
            connection_id: scope.connection.id,
            generation: scope.connection.generation,
            method,
            params,
            lane: "visible",
          },
          signal,
        )
        .catch((error: unknown) => {
          // The slot will report a superseded completion for its canceled owner.
          // Current defects still propagate to its visible error boundary.
          if (signal.aborted) return { ok: false as const, failure: { kind: "aborted" as const } };
          throw error;
        });
      if (!result.ok) return result;
      const decoded = decodeCapture(result.data, codec, scope, method, params);
      if (!decoded.ok)
        return {
          ok: false,
          failure: {
            kind: "protocol",
            message: "Invalid captured graph reference.",
            issue: decoded.issue,
          },
        };
      if (method === "ticket.hierarchy.get") {
        const identity = d.identifier.decode(jsonField(result.data.response.data, "ticket_id"));
        if (!identity.ok || identity.value !== id)
          return {
            ok: false,
            failure: {
              kind: "protocol",
              message: "Hierarchy policy identity does not match its requested ticket.",
              issue: undefined,
            },
          };
      }
      return { ok: true, data: decoded.value, httpStatus: result.httpStatus };
    });
  }
  const controller: GraphController = {
    get: () => state,
    subscribe(listener) {
      if (disposed) throw new Error("Graph controller disposed");
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    present(patch) {
      const zoom = patch.zoom ?? state.zoom;
      if (!Number.isFinite(zoom) || zoom < 0.25 || zoom > 2)
        throw new RangeError("Graph zoom must be finite and between 0.25 and 2.");
      publish({ ...patch, layers: { ...state.layers, ...patch.layers }, zoom });
    },
    move(id, position) {
      const bounds = graphPositionBounds(state.projection);
      if (
        ![position.x, position.y].every(Number.isFinite) ||
        position.x < 0 ||
        position.x > bounds.maxX ||
        position.y < 0 ||
        position.y > bounds.maxY
      )
        throw new RangeError("Graph position outside local layout bounds.");
      if (!state.projection.nodes.some((n) => n.id === id)) return;
      const positions = new Map(state.positions);
      positions.set(id, Object.freeze({ ...position }));
      publish({ positions });
    },
    resetLayout: () => publish({ positions: new Map(), zoom: 1 }),
    async loadAncestry() {
      const scope = state.scope,
        revision = state.revision,
        identity = epoch;
      if (scope === null || revision === null || state.ancestryLoading || disposed) return;
      const attempted = new Set<string>();
      publish({ ancestryLoading: true, ancestryIssue: null });
      try {
        while (!disposed && identity === epoch) {
          const gap = state.projection.unknownAncestry
            .map((id) => ancestryGap(state, id))
            .find((gap) => gap !== null && !attempted.has(`${gap.kind}:${gap.id}`));
          if (gap == null) break;
          attempted.add(`${gap.kind}:${gap.id}`);
          if (gap.kind === "record") {
            const result: ReadCompletion<Capture<TicketRead>> = await load(
              ancestorReference,
              scope,
              revision,
              "ticket.read",
              gap.id,
              ticketReadCodec,
            );
            if (disposed || identity !== epoch) return;
            if (!result.ok) {
              if ("failure" in result)
                publish({
                  ancestryIssue: `Could not load a parent ticket: ${failureText(result.failure)}`,
                });
              return;
            }
            if (
              result.data.value.ticket.ticket_id !== gap.id ||
              result.data.revision !== revision ||
              result.data.partial
            ) {
              publish({
                ancestryIssue:
                  "A parent ticket could not be read completely at this graph revision. Refresh the graph to try again.",
              });
              return;
            }
            const expanded = new Map(state.expanded);
            expanded.set(gap.id, result.data);
            publish({ expanded });
          } else {
            const result: ReadCompletion<Capture<HierarchyPolicy>> = await load(
              ancestorPolicy,
              scope,
              revision,
              "ticket.hierarchy.get",
              gap.id,
              hierarchyCodec,
            );
            if (disposed || identity !== epoch) return;
            if (!result.ok) {
              if ("failure" in result)
                publish({
                  ancestryIssue: `Could not load parent rules: ${failureText(result.failure)}`,
                });
              return;
            }
            if (result.data.revision !== revision || result.data.partial) {
              publish({
                ancestryIssue:
                  "Parent rules changed or were incomplete while this graph loaded. Refresh to read tickets and rules from the same workspace revision.",
              });
              return;
            }
            const policies = new Map(state.policies);
            policies.set(gap.id, result.data);
            publish({ policies });
          }
          project();
        }
        if (!disposed && identity === epoch && state.projection.unknownAncestry.length > 0)
          publish({
            ancestryIssue:
              "Some parent chains could not be resolved. They may contain a cycle or unavailable records; incomplete inherited links are not shown.",
          });
      } catch (error: unknown) {
        if (!disposed && identity === epoch) publish({ unexpected: { error } });
      } finally {
        if (!disposed && identity === epoch) publish({ ancestryLoading: false });
      }
    },
    async expand(id) {
      const scope = state.scope,
        revision = state.revision,
        identity = epoch;
      if (scope === null || revision === null) return;
      if (
        state.expanded.size + state.pages.reduce((n, p) => n + p.value.items.length, 0) >=
        GRAPH_LIMITS.tickets
      ) {
        publish({
          issue:
            "The captured-ticket budget is full. Narrow the query before expanding another boundary.",
        });
        return;
      }
      const result = await load(reference, scope, revision, "ticket.read", id, ticketReadCodec);
      if (!result.ok || identity !== epoch || disposed) return;
      const expanded = new Map(state.expanded);
      expanded.set(id, result.data);
      publish({ expanded });
      project();
    },
    async policy(id) {
      const scope = state.scope,
        revision = state.revision,
        identity = epoch;
      if (scope === null || revision === null) return;
      if (!state.projection.nodes.some((node) => node.id === id && node.record !== null)) {
        publish({ issue: "Expand the actual ticket record before loading its hierarchy policy." });
        return;
      }
      const result = await load(
        policy,
        scope,
        revision,
        "ticket.hierarchy.get",
        id,
        hierarchyCodec,
      );
      if (!result.ok || identity !== epoch || disposed) return;
      // This native method reads current state and has no at_revision guard.
      // Its returned provenance must still match the graph before projection.
      if (result.data.revision !== revision) {
        publish({
          issue: `Hierarchy policy was captured at workspace revision ${result.data.revision}, while this graph is revision ${revision}. Refresh the graph before capturing the policy again. No policy from a different revision was added.`,
        });
        return;
      }
      const policies = new Map(state.policies);
      policies.set(id, result.data);
      publish({ policies });
      project();
    },
    async resolve(displayKey) {
      const scope = state.scope,
        revision = state.revision,
        identity = epoch;
      if (scope === null || revision === null) return null;
      if (displayKey.trim() === "" || new TextEncoder().encode(displayKey).byteLength > 96) {
        publish({ issue: "A display key must be nonblank and at most 96 UTF-8 bytes." });
        return null;
      }
      const codec = c.refine(
        c.record({ ticket_id: d.identifier, display_key: c.text }),
        (value) => value.display_key === displayKey,
        "requested display key",
      );
      const result = await load(resolution, scope, revision, "ticket.resolve", displayKey, codec);
      return result.ok && identity === epoch && !disposed ? result.data.value.ticket_id : null;
    },
    compose(context, initial) {
      if (state.composer !== null) {
        publish({
          composerOpen: true,
          issue:
            "The retained relationship draft still belongs to its original capture. Review or discard it before starting another.",
        });
        return;
      }
      try {
        publish({
          composer: captureRelationDraft(state, context, initial),
          composerOpen: true,
          issue: null,
        });
      } catch (error: unknown) {
        if (error instanceof GraphInputError) publish({ issue: error.message });
        else publish({ unexpected: { error } });
      }
    },
    editComposer(patch) {
      const draft = state.composer;
      if (draft === null) return;
      for (const id of [patch.from, patch.to])
        if (id != null && !draft.tickets.some((capture) => capture.value.ticket.ticket_id === id)) {
          publish({
            issue:
              "An endpoint must belong to this draft's original capture. Start a new draft to use newly loaded tickets.",
          });
          return;
        }
      publish({
        composer: Object.freeze({ ...draft, input: Object.freeze({ ...draft.input, ...patch }) }),
      });
    },
    closeComposer: () => publish({ composer: null, composerOpen: false }),
    hideComposer: () => publish({ composerOpen: false }),
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubRead();
      unsubReference();
      unsubPolicy();
      unsubResolution();
      reference.dispose();
      policy.dispose();
      resolution.dispose();
      ancestorReference.dispose();
      ancestorPolicy.dispose();
      listeners.clear();
    },
  };
  return controller;
}
