import { describe, expect, it } from "vitest";
import { clearHistoryTarget, parseRoute, routeHref } from "../../src/app/navigation";
import type { Route, RequestsRouteTarget } from "../../src/app/types";
const base: Route = {
  view: "discussions",
  connectionId: "local",
  workspaceId: "demo",
  projectId: "project",
  entityId: null,
};
function roundtrip(requests: RequestsRouteTarget) {
  const route = { ...base, requests };
  expect(parseRoute(routeHref(route))).toEqual({ ok: true, route });
  return route;
}
describe("closed immutable Requests links", () => {
  it("retains an ordinary Requests list as an addressable section", () => {
    roundtrip({ kind: "requests", generation: "1" });
  });
  it("separates exact request entity snapshot from communication pagination revision", () => {
    roundtrip({
      kind: "request",
      generation: "1",
      requestId: "question",
      revision: "9007199254740993",
    });
    roundtrip({ kind: "request", generation: "2", requestId: "question", revision: null });
  });
  it("restores complete Inbox filters, interval, consumer and recipient independently of current writer", () => {
    roundtrip({
      kind: "inbox",
      generation: "1",
      capture: {
        consumerId: "ui-inbox-human",
        recipient: { kind: "run", id: "original-run" },
        after: "8",
        through: "30",
        kinds: ["request_created", "request_resolved"],
        ticketId: "ticket",
        excludeSelf: true,
        notificationId: "25",
      },
    });
    roundtrip({ kind: "inbox", generation: "1", capture: null });
    roundtrip({
      kind: "inbox",
      generation: "1",
      capture: {
        consumerId: "consumer",
        recipient: { kind: "actor", id: "human" },
        after: "0",
        through: "0",
        kinds: [],
        ticketId: null,
        excludeSelf: false,
        notificationId: null,
      },
    });
  });
  it("retains explicit team/subscription identity and clears on ordinary navigation", () => {
    for (const kind of ["team", "subscription"] as const) {
      const route = roundtrip({
        kind: "routing",
        generation: "4",
        entity: { kind, id: "configuration" },
      });
      expect(clearHistoryTarget(route)).toEqual(base);
    }
    roundtrip({ kind: "routing", generation: "4", entity: null });
  });
  it("rejects mixed, incomplete, duplicated or invented targets and selector values", () => {
    const valid = routeHref({
      ...base,
      requests: { kind: "request", generation: "1", requestId: "q", revision: "2" },
    });
    for (const suffix of [
      "&discussion=thread&generation=1&entity=t",
      "&head=empty&generation=1",
      "&req_id=other",
      "&req_unknown=true",
      "&req_revision=0",
      "&req_consumer=x",
    ]) {
      expect(parseRoute(valid + suffix).ok).toBe(false);
    }
    expect(
      parseRoute("#/discussions?connection=local&workspace=demo&req_view=request&req_id=q").ok,
    ).toBe(false);
    expect(() =>
      routeHref({
        ...base,
        discussion: { kind: "board", generation: "1" },
        requests: { kind: "routing", generation: "1", entity: null },
      }),
    ).toThrow(/combine/);
    expect(() =>
      routeHref({
        ...base,
        requests: {
          kind: "inbox",
          generation: "1",
          capture: {
            consumerId: "c",
            recipient: { kind: "actor", id: "human" },
            after: "10",
            through: "9",
            kinds: [],
            ticketId: null,
            excludeSelf: false,
            notificationId: null,
          },
        },
      }),
    ).toThrow(/Invalid/);
    expect(() =>
      routeHref({
        ...base,
        requests: {
          kind: "inbox",
          generation: "1",
          capture: {
            consumerId: "c",
            recipient: { kind: "actor", id: "human" },
            after: "0",
            through: "9",
            kinds: ["invented"],
            ticketId: null,
            excludeSelf: false,
            notificationId: null,
          },
        },
      }),
    ).toThrow(/Invalid/);
  });
});
