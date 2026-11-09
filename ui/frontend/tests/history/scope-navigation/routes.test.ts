import { describe, expect, it } from "vitest";
import { parseRoute, routeHref, changeView, changeConnection } from "../../../src/app/navigation";
import {
  planningRoute,
  planningTargetFromRoute,
} from "../../../src/features/history/scope-navigation/model";
import * as d from "../../../src/core/protocol/decoders";
function id(v: string) {
  const r = d.identifier.decode(d.jsonString(v));
  if (!r.ok) throw new Error("Invalid fixture");
  return r.value;
}
function generation(v: string) {
  const r = d.positiveDecimal.decode(d.jsonString(v));
  if (!r.ok) throw new Error("Invalid fixture");
  return r.value;
}
describe("typed recorded planning routes", () => {
  it.each(["workspace", "project", "milestone", "ticket"] as const)(
    "roundtrips %s including exact endpoint generation",
    (kind) => {
      const target = {
        connectionId: id("original"),
        generation: generation("9007199254740993"),
        workspaceId: id("workspace"),
        kind,
        id: id(kind === "workspace" ? "workspace" : "same-id"),
      };
      const route = planningRoute(target),
        parsed = parseRoute(routeHref(route));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error(parsed.message);
      expect(planningTargetFromRoute(parsed.route)).toEqual(target);
      expect(route.projectId).toBe(kind === "project" ? "same-id" : null);
      expect(changeView(route, "work").planning).toBeUndefined();
      expect(changeConnection(route, "other").planning).toBeUndefined();
    },
  );
  it.each([
    "#/work?connection=a&workspace=w&entity=t&planning_kind=ticket",
    "#/work?connection=a&workspace=w&entity=t&planning_kind=ticket&planning_generation=0",
    "#/work?connection=a&workspace=w&entity=t&planning_kind=ticket&planning_generation=01",
    "#/work?connection=a&workspace=w&entity=t&planning_kind=ticket&planning_generation=4611686018427387904",
    "#/overview?connection=a&workspace=w&entity=t&planning_kind=unknown&planning_generation=1",
    "#/overview?connection=a&workspace=w&entity=p&project=other&planning_kind=project&planning_generation=1",
    "#/overview?connection=a&workspace=w&entity=w&planning_kind=workspace&planning_generation=1",
    "#/work?connection=a&workspace=w&entity=t&project=p&planning_kind=ticket&planning_generation=1",
    "#/work?connection=a&workspace=w&entity=t&planning_kind=ticket&planning_generation=1&planning_generation=2",
    "#/history?connection=a&workspace=w&entity=t&generation=1&head=empty&planning_kind=ticket&planning_generation=1",
    "#/overview?connection=a&workspace=w&entity=t&planning_kind=ticket&planning_generation=1",
    "#/work?connection=a&workspace=w&entity=t&planning_kind=ticket&planning_generation=1&resource_generation=1",
  ])("rejects malformed or mixed capture %s", (hash) => {
    expect(parseRoute(hash).ok).toBe(false);
  });
  it("keeps accepted run, exact resource-version and empty history routes intact", () => {
    for (const hash of [
      "#/participants?connection=a&workspace=w&entity=r&participant=run&generation=1",
      "#/resources?connection=a&workspace=w&entity=doc&resource_generation=1&content_version=2",
      "#/history?connection=a&workspace=w&entity=session&generation=1&head=empty",
    ]) {
      const parsed = parseRoute(hash);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parseRoute(routeHref(parsed.route))).toEqual(parsed);
    }
  });
});
