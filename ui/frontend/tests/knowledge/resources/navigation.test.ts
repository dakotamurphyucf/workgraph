import { describe, expect, it } from "vitest";
import { parseRoute, routeHref, changeConnection, changeView } from "../../../src/app/navigation";
import { resourceRoute } from "../../../src/features/knowledge/resources/navigation";
const target = {
  connectionId: "local",
  generation: "9007199254740993",
  workspaceId: "space",
  resourceId: "artifact",
  content: { version: "9007199254740994", expectedDigest: "a".repeat(64) },
};
describe("exact Resource navigation", () => {
  it("roundtrips independently pinned endpoint/content/digest without a current project filter", () => {
    const route = resourceRoute(target),
      href = routeHref(route);
    expect(parseRoute(href)).toEqual({ ok: true, route });
    expect(route.projectId).toBeNull();
    expect(href).toContain("resource_generation=9007199254740993");
    expect(href).toContain("content_version=9007199254740994");
  });
  it("keeps current resolution distinct from version without evidence SHA", () => {
    const current = resourceRoute({ ...target, content: null });
    const history = resourceRoute({ ...target, content: { version: "2", expectedDigest: null } });
    expect(parseRoute(routeHref(current))).toEqual({ ok: true, route: current });
    expect(parseRoute(routeHref(history))).toEqual({ ok: true, route: history });
    expect(routeHref(current)).not.toContain("content_version");
    expect(routeHref(history)).not.toContain("content_digest");
  });
  it.each([
    "#/resources?workspace=space&entity=artifact&resource_generation=1",
    "#/resources?connection=local&workspace=space&resource_generation=1&content_version=2",
    "#/resources?connection=local&workspace=space&entity=artifact&content_version=2",
    "#/resources?connection=local&workspace=space&entity=artifact&resource_generation=01&content_version=2",
    "#/resources?connection=local&workspace=space&entity=artifact&resource_generation=1&content_version=0",
    "#/resources?connection=local&workspace=space&entity=artifact&resource_generation=1&content_digest=" +
      "a".repeat(64),
    "#/resources?connection=local&workspace=space&entity=artifact&resource_generation=1&content_version=2&content_version=3",
    "#/history?connection=local&workspace=space&entity=artifact&resource_generation=1&content_version=2",
    "#/resources?connection=local&workspace=space&entity=artifact&resource_generation=1&content_version=2&generation=1&head=empty",
  ])("rejects ambiguous, incomplete or mixed immutable targets: %s", (href) =>
    expect(parseRoute(href).ok).toBe(false),
  );
  it("explicit view/connection navigation clears the whole resource pin", () => {
    const route = resourceRoute(target);
    expect(changeView(route, "facts").resource).toBeUndefined();
    expect(changeConnection(route, "other").resource).toBeUndefined();
  });
});
