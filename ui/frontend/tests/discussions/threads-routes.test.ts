import { describe, expect, it } from "vitest";
import { changeConnection, changeView, parseRoute, routeHref } from "../../src/app/navigation";
import type { DiscussionRouteTarget, Route } from "../../src/app/types";
const base: Route = {
  view: "discussions",
  connectionId: "local",
  workspaceId: "demo",
  projectId: "navigation-filter",
  entityId: null,
};
function exact(target: DiscussionRouteTarget, entityId: string | null): Route {
  return { ...base, discussion: target, entityId };
}
describe("typed exact discussion routes", () => {
  it("round trips board/thread/ticket and exact historical comment without changing project context", () => {
    const targets: readonly Route[] = [
      exact({ kind: "board", generation: "2" }, "board"),
      exact({ kind: "thread", generation: "2" }, "thread"),
      exact({ kind: "ticket", generation: "2", comment: null }, "ticket"),
      exact(
        {
          kind: "ticket",
          generation: "4611686018427387903",
          comment: { id: "comment", revision: "9007199254740993" },
        },
        "ticket",
      ),
    ];
    for (const route of targets) {
      const parsed = parseRoute(routeHref(route));
      expect(parsed).toEqual({ ok: true, route });
      expect(changeView(route, "work").discussion).toBeUndefined();
      expect(changeConnection(route, "second")).toEqual({
        ...base,
        connectionId: "second",
        workspaceId: null,
        projectId: null,
      });
    }
  });
  it("round trips explicit received-message consumer/recipient/range independent of acting author", () => {
    for (const kind of ["actor", "run"] as const)
      for (const notificationId of [null, "15"]) {
        const route = exact(
          {
            kind: "messages",
            generation: "2",
            capture: {
              consumerId: "received-browser",
              recipient: { kind, id: "original-recipient" },
              after: "10",
              through: "20",
              ticketId: "actual-ticket",
              excludeSelf: true,
              notificationId,
            },
          },
          null,
        );
        expect(parseRoute(routeHref(route))).toEqual({ ok: true, route });
      }
    const unfiltered = exact(
      {
        kind: "messages",
        generation: "1",
        capture: {
          consumerId: "received-browser",
          recipient: { kind: "actor", id: "recipient" },
          after: "0",
          through: "0",
          ticketId: null,
          excludeSelf: false,
          notificationId: null,
        },
      },
      null,
    );
    expect(parseRoute(routeHref(unfiltered))).toEqual({ ok: true, route: unfiltered });
    const general = exact({ kind: "messages", generation: "1", capture: null }, null);
    expect(parseRoute(routeHref(general))).toEqual({ ok: true, route: general });
  });
  it.each([
    "discussion=thread&generation=1",
    "discussion=ticket&entity=ticket",
    "discussion=ticket&generation=0&entity=ticket",
    "discussion=ticket&generation=01&entity=ticket",
    "discussion=ticket&generation=4611686018427387904&entity=ticket",
    "discussion=ticket&generation=1&entity=ticket&comment=comment",
    "discussion=ticket&generation=1&entity=ticket&comment_revision=1",
    "discussion=ticket&generation=1&entity=ticket&comment=comment&comment_revision=0",
    "discussion=thread&generation=1&entity=thread&comment=comment&comment_revision=1",
    "discussion=board&generation=1&entity=board&consumer=inbox",
    "discussion=messages&generation=1&entity=message",
    "discussion=messages&generation=1&consumer=received",
    "discussion=messages&generation=1&consumer=received&recipient_kind=team&recipient=team&after=0&through=1",
    "discussion=messages&generation=1&consumer=received&recipient_kind=actor&recipient=actor&after=2&through=1&exclude_self=false",
    "discussion=messages&generation=1&consumer=received&recipient_kind=actor&recipient=actor&after=0&through=2&exclude_self=false&notification=3",
    "discussion=messages&generation=1&consumer=received&recipient_kind=actor&recipient=actor&after=1&through=2&exclude_self=false&notification=1",
    "discussion=messages&generation=1&consumer=received&recipient_kind=actor&recipient=actor&after=0&through=2&exclude_self=false&notification=01",
    "discussion=messages&generation=1&consumer=received&recipient_kind=actor&recipient=actor&after=0&through=2",
    "discussion=messages&generation=1&consumer=received&recipient_kind=actor&recipient=actor&after=0&through=2&exclude_self=maybe",
    "discussion=messages&generation=1&consumer=received&recipient_kind=actor&recipient=actor&after=0&through=2&exclude_self=false&message_ticket=bad%2Fticket",
    "discussion=ticket&generation=1&entity=ticket&discussion=thread",
    "discussion=ticket&generation=1&entity=ticket&extra=unknown",
    "discussion=ticket&generation=1&entity=ticket&head=empty",
    "entity=ambiguous-current-target",
  ])("rejects partial/mismatched/repeated/unknown target %s", (query) => {
    expect(parseRoute(`#/discussions?connection=local&workspace=demo&${query}`).ok).toBe(false);
  });
  it("rejects exact discussion parameters on another view or absent endpoint scope", () => {
    expect(
      parseRoute("#/work?connection=local&workspace=demo&discussion=thread&generation=1&entity=t")
        .ok,
    ).toBe(false);
    expect(parseRoute("#/discussions?connection=local&discussion=messages&generation=1").ok).toBe(
      false,
    );
    expect(() =>
      routeHref({
        ...exact({ kind: "thread", generation: "2" }, "thread"),
        history: { generation: "1", head: null },
      }),
    ).toThrow("cannot combine");
  });
});
