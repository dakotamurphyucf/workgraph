import { describe, expect, it } from "vitest";
import {
  graphRecord,
  graphPositionBounds,
  clampGraphPosition,
  hierarchyCodec,
  focusedNodes,
  layoutGraph,
  projectGraph,
  relationKey,
} from "../../../src/features/workflow/graph/model";
import { ticketCodec } from "../../../src/features/work/read-model.codec";
import { decode, json } from "../../work/actions-fixtures";
import { id, policy, rawTicket, record, records } from "./fixtures";

describe("captured relation semantics", () => {
  it("traces the full connected component across branches and relation kinds without looping", () => {
    const source = records(
      record("a", { related_ticket_ids: ["d"] }),
      record("b", { prerequisite_ticket_ids: ["a"] }),
      record("c", { prerequisite_ticket_ids: ["b"] }),
      record("d", { related_ticket_ids: ["a"], parent_ticket_id: "c" }),
      record("sibling", { prerequisite_ticket_ids: ["a"] }),
      record("unconnected"),
    );
    const graph = projectGraph(source, new Map(), new Set(source.keys()));
    expect([...focusedNodes(graph, id("c"), "connected")].sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
      "sibling",
    ]);
    expect([...focusedNodes(graph, id("unconnected"), "connected")]).toEqual(["unconnected"]);
  });
  it("keeps prerequisite, hierarchy and symmetric related edges distinct", () => {
    const source = records(
      record("a", { related_ticket_ids: ["b"] }),
      record("b", {
        parent_ticket_id: "p",
        prerequisite_ticket_ids: ["a"],
        related_ticket_ids: ["a"],
      }),
      record("p"),
    );
    const graph = projectGraph(
      source,
      new Map([[id("p"), policy("p", "independent")]]),
      new Set([id("b")]),
    );
    expect(graph.relations.map((e) => [e.kind, e.from, e.to])).toEqual([
      ["related", "a", "b"],
      ["prerequisite", "a", "b"],
      ["hierarchy", "p", "b"],
    ]);
    expect(graph.nodes.find((n) => n.id === "a")?.inQuery).toBe(false);
    expect(graph.unknownAncestry).toEqual([]);
  });
  it("inherits across independent intermediates and retains duplicate declaring sources", () => {
    const source = records(
      record("x", { status: "done" }),
      record("p", { prerequisite_ticket_ids: ["x"] }),
      record("middle", { parent_ticket_id: "p" }),
      record("near", { parent_ticket_id: "middle", prerequisite_ticket_ids: ["x"] }),
      record("child", {
        parent_ticket_id: "near",
        prerequisite_ticket_ids: ["x"],
        waivers: [
          {
            prerequisite_ticket_id: "x",
            actor_id: "mira",
            reason: "Explicit synthetic waiver",
            timestamp: "2026-11-07T00:00:00Z",
          },
        ],
      }),
    );
    const policies = new Map(
      [policy("p", "inherit"), policy("middle", "independent"), policy("near", "inherit")].map(
        (p) => [p.value.ticket_id, p],
      ),
    );
    const graph = projectGraph(source, policies, new Set(source.keys()));
    const child = graph.relations.filter(
      (e) => e.to === "child" && (e.kind === "inherited" || e.kind === "prerequisite"),
    );
    expect(child.map((e) => [e.source, e.waiver?.reason ?? null])).toEqual([
      ["child", "Explicit synthetic waiver"],
      ["near", null],
      ["p", null],
    ]);
    expect(focusedNodes(graph, id("child"), "ancestors").has(id("x"))).toBe(true);
  });
  it("source waiver remains on the ancestor, canceled remains a recorded prerequisite", () => {
    const source = records(
      record("x", { status: "canceled" }),
      record("p", {
        prerequisite_ticket_ids: ["x"],
        waivers: [
          {
            prerequisite_ticket_id: "x",
            actor_id: "mira",
            reason: "Retained at source",
            timestamp: "stored",
          },
        ],
      }),
      record("child", { parent_ticket_id: "p" }),
    );
    const graph = projectGraph(
      source,
      new Map([[id("p"), policy("p", "inherit")]]),
      new Set(source.keys()),
    );
    const edge = graph.relations.find((e) => e.kind === "inherited");
    expect(edge?.source).toBe("p");
    expect(edge?.waiver?.reason).toBe("Retained at source");
    expect(source.get(id("x"))?.ticket.status).toBe("canceled");
  });
  it("does not invent inherited relations through missing or different-revision policy", () => {
    const source = records(
      record("p", { prerequisite_ticket_ids: ["x"] }),
      record("b", { parent_ticket_id: "p" }),
    );
    for (const policies of [new Map(), new Map([[id("p"), policy("p", "inherit", "99")]])]) {
      const graph = projectGraph(source, policies, new Set());
      expect(graph.unknownAncestry).toEqual(["b"]);
      expect(graph.relations.some((e) => e.kind === "inherited")).toBe(false);
    }
  });
  it("keeps off-view references explicit and discloses boundary/edge rendering limits", () => {
    const source = records(record("b", { prerequisite_ticket_ids: ["x", "y", "z"] }));
    const graph = projectGraph(source, new Map(), new Set([id("b")]), {
      tickets: 1000,
      relations: 3,
      boundaryNodes: 1,
    });
    expect(graph.nodes.filter((n) => n.record === null).map((n) => n.id)).toEqual(["x"]);
    expect(graph.omittedBoundaryNodes).toBe(2);
    expect(graph.relations).toHaveLength(3);
    expect(
      projectGraph(source, new Map(), new Set(), {
        tickets: 1000,
        relations: 1,
        boundaryNodes: 200,
      }).omittedRelations,
    ).toBe(2);
  });
  it("distinguishes absent/malformed waivers and validates the stored policy defaults", () => {
    for (const waivers of [
      undefined,
      [{ prerequisite_ticket_id: "unrelated", actor_id: "mira", reason: "Bad", timestamp: "t" }],
    ]) {
      const ticket = decode(ticketCodec, rawTicket("b", { waivers }));
      expect(graphRecord(ticket, { id: "c", revision: record("b").revision }).ok).toBe(false);
    }
    expect(
      hierarchyCodec.decode(
        json({
          ticket_id: "b",
          policy: null,
          effective: { descendant_prerequisites: "inherit", child_completion: "all_done" },
        }),
      ).ok,
    ).toBe(false);
  });
  it("uses tuple identities without separator collisions", () => {
    expect(relationKey("related", id("a-b"), id("c"), id("a-b"))).not.toBe(
      relationKey("related", id("a"), id("b-c"), id("a")),
    );
  });
  it("counts a budget-omitted symmetric related edge exactly once without an omitted-key cache", () => {
    const source = records(
      record("a", { prerequisite_ticket_ids: ["x"], related_ticket_ids: ["b"] }),
      record("b", { related_ticket_ids: ["a"] }),
    );
    const graph = projectGraph(source, new Map(), new Set(), {
      tickets: 1000,
      relations: 1,
      boundaryNodes: 200,
    });
    expect(graph.relations.map((edge) => edge.kind)).toEqual(["prerequisite"]);
    expect(graph.omittedRelations).toBe(1);
  });
});

describe("local layout and focus", () => {
  const source = records(
    record("a"),
    record("b", {
      prerequisite_ticket_ids: ["a"],
      project_id: "other",
      related_ticket_ids: ["related"],
    }),
    record("c", { prerequisite_ticket_ids: ["b"], parent_ticket_id: "a" }),
    record("related", { related_ticket_ids: ["b"] }),
  );
  const graph = projectGraph(
    source,
    new Map([[id("a"), policy("a", "independent")]]),
    new Set(source.keys()),
  );
  it("uses prerequisite direction while related links have no ranking/readiness effect", () => {
    const layout = layoutGraph(graph, "project");
    expect(layout.positions.get(id("b"))!.x).toBeGreaterThan(layout.positions.get(id("a"))!.x);
    expect(layout.positions.get(id("c"))!.x).toBeGreaterThan(layout.positions.get(id("b"))!.x);
    expect(layout.lanes.map((l) => l.label)).toEqual(["northstar", "other"]);
  });
  it("provides exact directional focus and explicit subtree without mutating captured records", () => {
    expect([...focusedNodes(graph, id("b"), "ancestors")]).toEqual(["b", "a"]);
    expect([...focusedNodes(graph, id("b"), "downstream")]).toEqual(["b", "c"]);
    expect([...focusedNodes(graph, id("a"), "subtree")]).toEqual(["a", "c"]);
    expect(focusedNodes(graph, id("b"), "neighbors").has(id("related"))).toBe(true);
    expect(source.get(id("b"))?.ticket.project_id).toBe("other");
  });
  it("retains a malformed one-sided declaration with an explicit consistency warning", () => {
    const malformed = projectGraph(
      records(record("a"), record("b", { related_ticket_ids: ["a"] })),
      new Map(),
      new Set(),
    );
    expect(malformed.asymmetricRelatedPairs).toBe(1);
    expect(malformed.relations.map((edge) => [edge.kind, edge.from, edge.to, edge.source])).toEqual(
      [["related", "a", "b", "b"]],
    );
  });
  it("bounds every admitted initial lane layout and clamps boundary gestures without weakening direct validation", () => {
    const source = records(
      ...Array.from({ length: 1000 }, (_, index) =>
        record(`flat-${index}`, {
          title: index === 999 ? "X".repeat(512) : "Short",
          project_id: `project-${index % 8}`,
          milestone_id: `milestone-${index % 13}`,
          prerequisite_ticket_ids:
            index === 0 ? Array.from({ length: 200 }, (_, n) => `outside-${n}`) : [],
        }),
      ),
    );
    const projection = projectGraph(source, new Map(), new Set(source.keys())),
      bounds = graphPositionBounds(projection);
    expect(projection.nodes).toHaveLength(1200);
    for (const grouping of ["none", "project", "milestone"] as const) {
      const layout = layoutGraph(projection, grouping);
      expect(
        [...layout.positions.values()].every(
          (p) => p.x >= 0 && p.x <= bounds.maxX && p.y >= 0 && p.y <= bounds.maxY,
        ),
      ).toBe(true);
    }
    const initial = layoutGraph(projection, "none").positions.get(id("flat-999"))!;
    expect(initial.y).toBeGreaterThan(100000);
    expect(clampGraphPosition({ ...initial, y: initial.y + 24 }, bounds)?.y).toBe(initial.y + 24);
    expect(clampGraphPosition({ x: bounds.maxX + 24, y: bounds.maxY + 24 }, bounds)).toEqual({
      x: bounds.maxX,
      y: bounds.maxY,
    });
    expect(clampGraphPosition({ x: -24, y: -24 }, bounds)).toEqual({ x: 0, y: 0 });
    expect(clampGraphPosition({ x: NaN, y: 0 }, bounds)).toBeNull();
    expect(clampGraphPosition({ x: 0, y: Infinity }, bounds)).toBeNull();
  });
  it("supports complete long titles and bounded layout even if an invalid loaded cycle appears", () => {
    const cycle = projectGraph(
      records(
        record("a", { title: "Long synthetic title ".repeat(9), prerequisite_ticket_ids: ["b"] }),
        record("b", { prerequisite_ticket_ids: ["a"] }),
      ),
      new Map(),
      new Set(),
    );
    const layout = layoutGraph(cycle, "none");
    expect(layout.positions.size).toBe(2);
    expect(Number.isFinite(layout.height)).toBe(true);
    expect(cycle.nodes[0]?.record?.ticket.title).toContain("Long synthetic title ".repeat(9));
  });
});
