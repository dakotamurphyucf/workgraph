import { describe, expect, it } from "vitest";
import {
  changeConnection,
  changeScope,
  changeView,
  EMPTY_ROUTE,
  parseRoute,
  routeHref,
} from "../../src/app/navigation";
import { pinDefaultProfile } from "../../src/app/connectionSelection";
import { connectionDirectoryCodec } from "../../src/app/connections";
import { parseJsonText } from "../../src/core/json";
import { clampWidth, keyboardWidth } from "../../src/components/resize";

function parse(text: string) {
  const result = parseJsonText(text);
  if (!result.ok) throw new Error(result.error.message);
  return result.value.value;
}
describe("local scope navigation", () => {
  it("round trips an exact deep link without carrying endpoint paths", () => {
    const route = {
      view: "history" as const,
      connectionId: "local-2",
      workspaceId: "team_1",
      projectId: "project-3",
      entityId: "history-7",
    };
    expect(parseRoute(routeHref(route))).toEqual({ ok: true, route });
  });
  it.each([
    "#/bogus",
    "#/work?connection=one&connection=two",
    "#/work?socket=%2Ftmp%2Fdaemon.sock",
    "#/work?workspace=%2e%2e",
    "#/work?project=hello+world",
    "#/work?entity=evil%0A",
    "#/work?entity=",
    "#/work?project=unscoped",
    "#/work?workspace=valid",
    "#/work?workspace=valid&project=valid",
    "#/work?entity=valid",
    "https://example.test/#/work",
    "#/work#evil",
  ])("rejects invalid and ambiguous scope %s", (hash) => {
    expect(parseRoute(hash).ok).toBe(false);
  });
  it.each([
    ["work", "board"],
    ["work", "list"],
    ["workflow", "templates"],
    ["workflow", "relationships"],
    ["workflow", "drafts"],
    ["workflow", "local-evidence"],
    ["participants", "reservations"],
    ["history", "usage"],
  ] as const)("restores the %s / %s screen from a copied URL", (view, value) => {
    const hash = `#/${view}?connection=one&workspace=team&section=${value}`;
    const parsed = parseRoute(hash);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.route.section).toEqual({ view, value });
    expect(parseRoute(routeHref(parsed.route))).toEqual(parsed);
    expect(changeView(parsed.route, "overview").section).toBeUndefined();
  });
  it.each([
    "#/work?section=templates",
    "#/overview?section=board",
    "#/history?section=usage&section=search",
  ])("rejects a mismatched or ambiguous section %s", (hash) => {
    expect(parseRoute(hash).ok).toBe(false);
  });
  it("does not carry a pinned session or subview into a different project", () => {
    const route = {
      ...EMPTY_ROUTE,
      view: "history" as const,
      connectionId: "one",
      workspaceId: "old",
      projectId: "old-project",
      entityId: "session",
      history: { generation: "3", head: "a".repeat(64) },
      section: { view: "history" as const, value: "usage" as const },
    };
    const next = changeScope(route, "new", "new-project");
    expect(next).toEqual({
      view: "history",
      connectionId: "one",
      workspaceId: "new",
      projectId: "new-project",
      entityId: null,
    });
    expect(parseRoute(routeHref(next))).toEqual({ ok: true, route: next });
  });
  it("clears endpoint-local scope on connection change and entity on view change", () => {
    const route = {
      ...EMPTY_ROUTE,
      connectionId: "one",
      workspaceId: "workspace",
      projectId: "project",
      entityId: "ticket",
    };
    expect(changeConnection(route, "two")).toEqual({ ...EMPTY_ROUTE, connectionId: "two" });
    expect(changeView(route, "workflow")).toEqual({ ...route, view: "workflow", entityId: null });
    expect(() => routeHref({ ...route, workspaceId: "../../wrong" })).toThrow();
    expect(() => routeHref({ ...route, connectionId: null })).toThrow();
    expect(() => routeHref({ ...route, workspaceId: null })).toThrow();
  });
});
describe("real connection profile boundary", () => {
  it("pins the first resolved default through reordering, removal and empty captures", () => {
    const decoded = connectionDirectoryCodec.decode(
      parse(
        '{"items":[{"id":"first","generation":"1","label":"First","socket":"/synthetic/first.sock"},{"id":"second","generation":"1","label":"Second","socket":"/synthetic/second.sock"}]}',
      ),
    );
    if (!decoded.ok) throw new Error("Invalid test profiles");
    const profiles = decoded.value.items;
    expect(pinDefaultProfile(null, [])).toBeNull();
    const initial = pinDefaultProfile(null, profiles);
    expect(initial).toBe("first");
    expect(pinDefaultProfile(initial, [...profiles].reverse())).toBe("first");
    expect(pinDefaultProfile(initial, profiles.slice(1))).toBe("first");
    expect(pinDefaultProfile(initial, [])).toBe("first");
  });
  it("accepts actual empty directories and retains exact generations above Number precision", () => {
    expect(connectionDirectoryCodec.decode(parse('{"items":[]}'))).toEqual({
      ok: true,
      value: { items: [] },
    });
    const result = connectionDirectoryCodec.decode(
      parse(
        '{"items":[{"id":"local","generation":"9007199254740993","label":"Local daemon","socket":"/synthetic/daemon.sock"}]}',
      ),
    );
    expect(result.ok && result.value.items[0]?.generation).toBe("9007199254740993");
  });
  it("rejects profile overflow, zero or numeric generations and unknown fields", () => {
    const profile =
      '{"id":"local","generation":"1","label":"Local","socket":"/synthetic/daemon.sock"}';
    expect(
      connectionDirectoryCodec.decode(
        parse(`{"items":[${Array.from({ length: 101 }, () => profile).join(",")}]}`),
      ).ok,
    ).toBe(false);
    for (const bad of ["0", "01"])
      expect(
        connectionDirectoryCodec.decode(
          parse(`{"items":[${profile.replace('"1"', JSON.stringify(bad))}]}`),
        ).ok,
      ).toBe(false);
    expect(
      connectionDirectoryCodec.decode(parse(`{"items":[${profile.replace('"1"', "1")}]}`)).ok,
    ).toBe(false);
    expect(connectionDirectoryCodec.decode(parse('{"items":[],"sample_data":true}')).ok).toBe(
      false,
    );
  });
});
describe("resizable pane keyboard boundaries", () => {
  const limits = { minimum: 208, maximum: 320 };
  it("keeps pointer and keyboard sizing bounded in both orientations", () => {
    expect(clampWidth(100, limits)).toBe(208);
    expect(keyboardWidth(232, "ArrowRight", "start", limits)).toBe(248);
    expect(keyboardWidth(232, "ArrowRight", "end", limits)).toBe(216);
    expect(keyboardWidth(310, "ArrowRight", "start", limits)).toBe(320);
    expect(keyboardWidth(232, "Home", "start", limits)).toBe(208);
    expect(keyboardWidth(232, "End", "end", limits)).toBe(320);
    expect(keyboardWidth(232, "Tab", "start", limits)).toBeNull();
    expect(() => clampWidth(Number.NaN, limits)).toThrow();
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => clampWidth(232, { ...limits, minimum: value })).toThrow();
      expect(() => clampWidth(232, { ...limits, maximum: value })).toThrow();
      expect(() => keyboardWidth(232, "Home", "start", { ...limits, minimum: value })).toThrow();
      expect(() => keyboardWidth(232, "End", "start", { ...limits, maximum: value })).toThrow();
    }
  });
});
