import { describe, expect, it } from "vitest";
import { parseRoute, routeHref } from "../../../src/app/navigation";
import { factRoute } from "../../../src/features/knowledge/facts/navigation";
import { factSelection } from "../../../src/features/search/destinations";
import { decimal, identifier } from "../../../src/features/knowledge/facts/model";
import { target } from "./fixtures";

describe("explicit fact navigation", () => {
  it("round-trips a ticket-scoped directory without borrowing a project or choosing a key", () => {
    const selection = {
      ...target,
      scope: { kind: "ticket" as const, id: identifier("task") },
      key: null,
    };
    const route = factRoute(selection);
    expect(route.projectId).toBeNull();
    const hash = routeHref(route);
    expect(hash).toContain("fact_mode=directory");
    expect(hash).not.toContain("fact_key");
    expect(parseRoute(hash)).toEqual({ ok: true, route });
    expect(factSelection(route, target.connection)).toEqual(selection);
    expect(factSelection(route, { ...target.connection, generation: decimal("3") })).toBeNull();
  });
  it("keeps fact revision distinct from planning snapshot and preserves exact Unicode keys", () => {
    const selection = {
      ...target,
      key: "settings.雪 & mode",
      factRevision: decimal("2"),
      atRevision: decimal("17"),
    };
    const route = factRoute(selection);
    expect(parseRoute(routeHref(route))).toEqual({ ok: true, route });
    expect(factSelection(route, target.connection)).toEqual(selection);
  });
  it.each(["&fact_key=settings", "&fact_revision=2", "&fact_at_revision=17", "&project=wrong"])(
    "rejects an ambiguous directory %s",
    (suffix) => {
      const hash = routeHref(factRoute({ ...target, key: null }));
      expect(parseRoute(hash + suffix).ok).toBe(false);
    },
  );
  it("rejects invalid keys before writing browser history", () => {
    expect(() => factRoute({ ...target, key: "\u0000" })).toThrow();
  });
});
