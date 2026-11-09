import { describe, expect, it } from "vitest";
import { changeConnection, changeView, parseRoute, routeHref } from "../../../src/app/navigation";
const base = "#/history?connection=local&workspace=demo&entity=conversation";
const digest = "a".repeat(64);
describe("immutable history links", () => {
  it("round trips exact session capture without inventing an event, and exact event links", () => {
    for (const suffix of [
      `&generation=2&head=${digest}`,
      `&generation=2&head=${digest}&event=90`,
      `&generation=2&head=empty`,
    ]) {
      const parsed = parseRoute(base + suffix);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error(parsed.message);
      expect(parseRoute(routeHref(parsed.route))).toEqual(parsed);
      expect(changeView(parsed.route, "work").history).toBeUndefined();
      expect(changeConnection(parsed.route, "second").history).toBeUndefined();
    }
  });
  it.each([
    "&generation=2",
    "&head=empty",
    "&event=1",
    "&generation=0&head=empty",
    "&generation=02&head=empty",
    "&generation=2&head=empty&event=1",
    `&generation=2&head=${digest}&event=0`,
    `&generation=2&head=${digest}&event=1000001`,
    `&generation=2&head=${digest}&event=01`,
    `&generation=2&head=${digest}&head=${digest}`,
    "&generation=2&head=nope",
  ])("rejects malformed/partial/repeated target %s", (suffix) =>
    expect(parseRoute(base + suffix).ok).toBe(false),
  );
  it("rejects exact history parameters on unrelated or insufficiently scoped views", () => {
    expect(parseRoute(base.replace("/history", "/work") + `&generation=2&head=${digest}`).ok).toBe(
      false,
    );
    expect(
      parseRoute(base.replace("&entity=conversation", "") + `&generation=2&head=${digest}`).ok,
    ).toBe(false);
  });
});
