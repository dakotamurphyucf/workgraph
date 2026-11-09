import { jsonField } from "../../../core/json";
import type { FeatureContext } from "../../../app/types";
import type { FormInput, WorkCommand, WorkTarget } from "../../work/actions/types";
import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type { Identifier } from "../../../core/protocol/types";
import type { Capture, Ticket } from "../../work/read-model.types";
import type {
  GraphFocus,
  GraphGrouping,
  GraphLayout,
  GraphPosition,
  GraphPositionBounds,
  GraphNode,
  GraphProjection,
  GraphRecord,
  GraphRelation,
  GraphState,
  GraphRelationDraft,
  ProposedRelation,
  HierarchyPolicy,
  Waiver,
} from "./types";

export class GraphInputError extends Error {
  override readonly name = "GraphInputError";
}
export function relationAction(draft: GraphRelationDraft): {
  readonly context: FeatureContext;
  readonly method: WorkCommand;
  readonly target: WorkTarget;
  readonly edits: readonly (readonly [string, FormInput])[];
} {
  const { from, to, kind } = draft.input;
  if (from === null || to === null || from === to)
    throw new GraphInputError("Choose two distinct captured endpoints.");
  const source = draft.tickets.find((ticket) => ticket.value.ticket.ticket_id === from),
    destination = draft.tickets.find((ticket) => ticket.value.ticket.ticket_id === to);
  if (source === undefined || destination === undefined)
    throw new GraphInputError("Both endpoints must belong to the original relationship capture.");
  const value = (text: string | null): FormInput => ({
    kind: "scalar",
    presence: text === null ? "null" : "value",
    text: text ?? "",
  });
  const method =
    kind === "prerequisite" ? "dependency.add" : kind === "related" ? "related.add" : "ticket.move";
  return {
    context: draft.context,
    method,
    target: { scope: draft.scope, ticket: kind === "related" ? source : destination },
    edits:
      kind === "hierarchy"
        ? [
            ["parent_ticket_id", value(from)],
            ["project_id", value(source.value.ticket.project_id)],
            ["milestone_id", value(source.value.ticket.milestone_id)],
          ]
        : [
            [
              kind === "related" ? "related_id" : "prerequisite_id",
              value(kind === "related" ? to : from),
            ],
          ],
  };
}
export function captureRelationDraft(
  state: GraphState,
  context: FeatureContext,
  initial: Partial<ProposedRelation>,
): GraphRelationDraft {
  const scope = state.scope;
  if (
    scope === null ||
    state.revision === null ||
    context.profileState !== "current" ||
    scope.connection.id !== context.connection.id ||
    scope.connection.generation !== context.connection.generation ||
    scope.workspaceId !== context.route.workspaceId ||
    scope.projectId !== context.route.projectId
  )
    throw new GraphInputError(
      "Open a current matching graph capture before starting a relationship draft.",
    );
  if (
    context.writer.actorId === null ||
    !d.identifier.decode(d.jsonString(context.writer.actorId)).ok ||
    (context.writer.runId !== null && !d.identifier.decode(d.jsonString(context.writer.runId)).ok)
  )
    throw new GraphInputError(
      "Choose a valid acting identity before starting a relationship draft.",
    );
  const tickets = state.projection.nodes.flatMap((node) => {
    const capture = ticketCapture(state, node.id);
    return capture === null ? [] : [capture];
  });
  const input = Object.freeze({
    kind: initial.kind ?? "prerequisite",
    from: initial.from ?? tickets[0]?.value.ticket.ticket_id ?? null,
    to: initial.to ?? null,
  });
  for (const value of [input.from, input.to])
    if (value !== null && !tickets.some((ticket) => ticket.value.ticket.ticket_id === value))
      throw new GraphInputError("The selected endpoint is not part of this exact captured graph.");
  return Object.freeze({
    id: crypto.randomUUID(),
    context: Object.freeze({
      ...context,
      connection: Object.freeze({ ...context.connection }),
      route: Object.freeze({ ...context.route }),
      writer: Object.freeze({ ...context.writer }),
    }),
    scope: Object.freeze({ ...scope }),
    revision: state.revision,
    captureId: state.pages[0]?.id ?? "expanded-only",
    tickets: Object.freeze(tickets),
    input,
  });
}

export function ancestryGap(
  state: GraphState,
  ticketId: Identifier,
): { readonly id: Identifier; readonly kind: "record" | "policy" } | null {
  const records = new Map(state.projection.nodes.map((node) => [node.id, node.record])),
    seen = new Set<Identifier>();
  let parent = records.get(ticketId)?.ticket.parent_ticket_id ?? null;
  while (parent !== null && !seen.has(parent)) {
    seen.add(parent);
    const record = records.get(parent);
    if (record == null) return { id: parent, kind: "record" };
    const policy = state.policies.get(parent);
    if (policy === undefined || policy.partial || policy.revision !== state.revision)
      return { id: parent, kind: "policy" };
    parent = record.ticket.parent_ticket_id;
  }
  return null;
}

/** Exact record derived from its retained native page, never a reconstructed current-head read. */
export function ticketCapture(state: GraphState, id: Identifier) {
  const expanded = state.expanded.get(id);
  if (expanded !== undefined) return expanded;
  for (const page of state.pages) {
    const ticket = page.value.items.find((value) => value.ticket_id === id);
    if (ticket !== undefined) return { ...page, id: `${page.id}:${id}`, value: { ticket } };
  }
  return null;
}

/** Fixed presentation/admission budgets are surfaced as omissions, never semantic completeness. */
export const GRAPH_LIMITS = Object.freeze({ tickets: 1000, relations: 20000, boundaryNodes: 200 });
const choice = <const T extends string>(values: readonly T[]): c.Codec<T> => ({
  decode(value, path = []) {
    const found = value?.kind === "string" ? values.find((s) => s === value.value) : undefined;
    return found === undefined ? c.mismatch(path, values.join(" | ")) : { ok: true, value: found };
  },
});
const boundedText = (maximum: number) =>
  c.refine(
    c.text,
    (text) => new TextEncoder().encode(text).byteLength <= maximum,
    `at most ${maximum} UTF-8 bytes`,
  );
const auditReason = c.refine(
  boundedText(65536),
  (text) => /[^ \t\r\n\v\f]/u.test(text),
  "nonblank audit reason",
);
export const waiverCodec: c.Codec<Waiver> = c.record({
  prerequisite_ticket_id: d.identifier,
  actor_id: d.identifier,
  reason: auditReason,
  timestamp: boundedText(128),
});
const policyFields = {
  descendant_prerequisites: choice(["independent", "inherit"]),
  child_completion: choice(["all_done", "done_or_canceled"]),
};
export const hierarchyCodec: c.Codec<HierarchyPolicy> = c.refine(
  c.record({
    ticket_id: d.identifier,
    policy: c.nullable(
      c.record({
        ticket_id: d.identifier,
        revision: d.positiveDecimal,
        ...policyFields,
        reason: auditReason,
      }),
    ),
    effective: c.record(policyFields),
  }),
  (value) =>
    value.policy === null
      ? value.effective.descendant_prerequisites === "independent" &&
        value.effective.child_completion === "all_done"
      : value.policy.ticket_id === value.ticket_id &&
        value.policy.descendant_prerequisites === value.effective.descendant_prerequisites &&
        value.policy.child_completion === value.effective.child_completion,
  "matching stored policy/effective defaults",
);

export function graphRecord(
  ticket: Ticket,
  capture: Pick<Capture<unknown>, "id" | "revision">,
): c.DecodeResult<GraphRecord> {
  const result = c.array(waiverCodec, 100000).decode(jsonField(ticket.raw, "waivers"));
  if (!result.ok) return result;
  const seen = new Set<string>();
  for (const waiver of result.value) {
    if (
      seen.has(waiver.prerequisite_ticket_id) ||
      !ticket.prerequisite_ticket_ids.includes(waiver.prerequisite_ticket_id)
    )
      return c.mismatch(["waivers"], "unique waivers on declared prerequisites");
    seen.add(waiver.prerequisite_ticket_id);
  }
  return {
    ok: true,
    value: { ticket, waivers: result.value, captureId: capture.id, revision: capture.revision },
  };
}
export function relationKey(
  kind: GraphRelation["kind"],
  from: Identifier,
  to: Identifier,
  source: Identifier,
): string {
  return JSON.stringify([kind, from, to, source]);
}
export function projectGraph(
  records: ReadonlyMap<Identifier, GraphRecord>,
  policies: ReadonlyMap<Identifier, Capture<HierarchyPolicy>>,
  inQuery: ReadonlySet<Identifier>,
  limits: {
    readonly tickets: number;
    readonly relations: number;
    readonly boundaryNodes: number;
  } = GRAPH_LIMITS,
): GraphProjection {
  const nodes = new Map<Identifier, GraphNode>();
  for (const [id, record] of records) nodes.set(id, { id, record, inQuery: inQuery.has(id) });
  const relations = new Map<string, GraphRelation>(),
    unknown = new Set<Identifier>();
  let omittedRelations = 0,
    asymmetricRelatedPairs = 0;
  const add = (
    kind: GraphRelation["kind"],
    from: Identifier,
    to: Identifier,
    source: GraphRecord,
  ) => {
    const sourceId = kind === "related" ? from : source.ticket.ticket_id;
    const key = relationKey(kind, from, to, sourceId);
    if (relations.has(key)) return;
    if (relations.size >= limits.relations) {
      omittedRelations++;
      return;
    }
    relations.set(key, {
      id: key,
      kind,
      from,
      to,
      source: source.ticket.ticket_id,
      waiver:
        kind === "prerequisite" || kind === "inherited"
          ? (source.waivers.find((w) => w.prerequisite_ticket_id === from) ?? null)
          : null,
      captureId: source.captureId,
    });
  };
  for (const record of records.values()) {
    const ticket = record.ticket;
    for (const prerequisite of ticket.prerequisite_ticket_ids)
      add("prerequisite", prerequisite, ticket.ticket_id, record);
    if (ticket.parent_ticket_id !== null)
      add("hierarchy", ticket.parent_ticket_id, ticket.ticket_id, record);
    for (const related of ticket.related_ticket_ids) {
      const other = records.get(related);
      const inverse = other?.ticket.related_ticket_ids.includes(ticket.ticket_id);
      if (other !== undefined && !inverse) asymmetricRelatedPairs++;
      // Loaded symmetric endpoints emit once even when the edge budget omits it.
      if (related < ticket.ticket_id && inverse) continue;
      const [from, to] =
        ticket.ticket_id < related ? [ticket.ticket_id, related] : [related, ticket.ticket_id];
      // Symmetric links have one identity, independent of page/endpoint order.
      add("related", from, to, record);
    }
    const visited = new Set<Identifier>([ticket.ticket_id]);
    let ancestor = ticket.parent_ticket_id;
    while (ancestor !== null) {
      if (visited.has(ancestor)) {
        unknown.add(ticket.ticket_id);
        break;
      }
      visited.add(ancestor);
      const parent = records.get(ancestor),
        policy = policies.get(ancestor);
      if (
        parent === undefined ||
        policy === undefined ||
        policy.partial ||
        policy.revision !== record.revision
      ) {
        unknown.add(ticket.ticket_id);
        break;
      }
      if (policy.value.effective.descendant_prerequisites === "inherit") {
        for (const prerequisite of parent.ticket.prerequisite_ticket_ids) {
          add("inherited", prerequisite, ticket.ticket_id, parent);
        }
      }
      ancestor = parent.ticket.parent_ticket_id;
    }
  }
  const omittedBoundaryIds = new Set<Identifier>();
  let boundary = 0;
  for (const relation of relations.values())
    for (const id of [relation.from, relation.to]) {
      if (nodes.has(id)) continue;
      if (boundary >= limits.boundaryNodes) {
        omittedBoundaryIds.add(id);
        continue;
      }
      boundary++;
      nodes.set(id, { id, record: null, inQuery: false });
    }
  return {
    nodes: [...nodes.values()],
    relations: [...relations.values()],
    unknownAncestry: [...unknown],
    omittedRelations,
    omittedBoundaryNodes: omittedBoundaryIds.size,
    asymmetricRelatedPairs,
  };
}

export function focusedNodes(
  projection: GraphProjection,
  selected: Identifier | null,
  focus: GraphFocus,
): ReadonlySet<Identifier> {
  if (selected === null || focus === "all") return new Set(projection.nodes.map((n) => n.id));
  const result = new Set<Identifier>([selected]),
    pending = [selected];
  if (focus === "neighbors") {
    for (const edge of projection.relations) {
      if (edge.from === selected) result.add(edge.to);
      if (edge.to === selected) result.add(edge.from);
    }
    return result;
  }
  const adjacency = new Map<Identifier, Identifier[]>();
  for (const edge of projection.relations) {
    if (
      focus === "connected"
        ? false
        : focus === "subtree"
          ? edge.kind !== "hierarchy"
          : edge.kind !== "prerequisite" && edge.kind !== "inherited"
    )
      continue;
    const from = focus === "ancestors" ? edge.to : edge.from,
      to = focus === "ancestors" ? edge.from : edge.to;
    const values = adjacency.get(from) ?? [];
    values.push(to);
    adjacency.set(from, values);
    if (focus === "connected") {
      const reverse = adjacency.get(to) ?? [];
      reverse.push(from);
      adjacency.set(to, reverse);
    }
  }
  while (pending.length) {
    const id = pending.pop();
    if (id === undefined) break;
    for (const next of adjacency.get(id) ?? [])
      if (!result.has(next)) {
        result.add(next);
        pending.push(next);
      }
  }
  return result;
}

export function visibleGraphNodes(
  projection: GraphProjection,
  selected: Identifier | null,
  focus: ReadonlySet<Identifier>,
  limit = 200,
): readonly GraphNode[] {
  const ordered = new Map<Identifier, GraphNode>();
  const selectedNode = projection.nodes.find((node) => node.id === selected);
  if (selectedNode !== undefined) ordered.set(selectedNode.id, selectedNode);
  for (const node of projection.nodes) if (focus.has(node.id)) ordered.set(node.id, node);
  for (const node of projection.nodes) if (!ordered.has(node.id)) ordered.set(node.id, node);
  return [...ordered.values()].slice(0, limit);
}

export function nodeHeight(node: GraphNode): number {
  return node.record === null ? 92 : 104;
}
/** Covers every admitted initial layout, including one lane per node. */
export function graphPositionBounds(projection: GraphProjection): GraphPositionBounds {
  // Each lane adds 34px inset and 24px separation; stacking every node in its
  // own lane bounds all project/milestone/none arrangements and dependency ranks.
  // Retain the ordinary 100,000px editor space and 10,000px beyond the total layout.
  const stacked = projection.nodes.reduce(
    (height, node) => height + Math.max(100, nodeHeight(node) + 28) + 58,
    28,
  );
  return { maxX: 100000, maxY: Math.max(100000, stacked + 10000) };
}
/** Browser gestures may meet an edge; direct controller callers still validate. */
export function clampGraphPosition(
  position: GraphPosition,
  bounds: GraphPositionBounds,
): GraphPosition | null {
  if (![position.x, position.y].every(Number.isFinite)) return null;
  return {
    x: Math.max(0, Math.min(bounds.maxX, position.x)),
    y: Math.max(0, Math.min(bounds.maxY, position.y)),
  };
}
/** Bounded deterministic loaded-graph layout. Related links never affect dependency rank. */
export function layoutGraph(projection: GraphProjection, grouping: GraphGrouping): GraphLayout {
  const indegree = new Map<Identifier, number>(),
    adjacency = new Map<Identifier, Identifier[]>(),
    rank = new Map<Identifier, number>();
  for (const node of projection.nodes) {
    indegree.set(node.id, 0);
    rank.set(node.id, 0);
  }
  for (const edge of projection.relations) {
    if (
      (edge.kind !== "prerequisite" && edge.kind !== "inherited") ||
      !indegree.has(edge.from) ||
      !indegree.has(edge.to)
    )
      continue;
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    const next = adjacency.get(edge.from) ?? [];
    next.push(edge.to);
    adjacency.set(edge.from, next);
  }
  const queue = projection.nodes
    .filter((node) => indegree.get(node.id) === 0)
    .map((node) => node.id);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (id === undefined) continue;
    for (const next of adjacency.get(id) ?? []) {
      rank.set(next, Math.max(rank.get(next) ?? 0, Math.min(30, (rank.get(id) ?? 0) + 1)));
      const count = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, count);
      if (count === 0) queue.push(next);
    }
  }
  const groups = new Map<string, GraphNode[]>();
  for (const node of projection.nodes) {
    const ticket = node.record?.ticket;
    const label =
      grouping === "none"
        ? "Captured tickets"
        : ticket === undefined
          ? "Outside this capture"
          : grouping === "project"
            ? (ticket.project_id ?? "No project")
            : (ticket.milestone_id ?? "No milestone");
    const group = groups.get(label) ?? [];
    group.push(node);
    groups.set(label, group);
  }
  const positions = new Map<Identifier, { x: number; y: number }>(),
    lanes: { label: string; y: number; height: number }[] = [];
  let y = 28,
    width = 360;
  for (const [label, nodes] of groups) {
    const columns = new Map<number, number>(),
      top = y + 34;
    for (const node of nodes) {
      const column = rank.get(node.id) ?? 0,
        x = 32 + column * 334,
        nodeY = columns.get(column) ?? top;
      positions.set(node.id, { x, y: nodeY });
      columns.set(column, nodeY + nodeHeight(node) + 28);
      width = Math.max(width, x + 316);
    }
    const bottom = Math.max(top + 100, ...columns.values());
    lanes.push({ label, y, height: bottom - y });
    y = bottom + 24;
  }
  return { positions, lanes, width, height: Math.max(280, y) };
}
