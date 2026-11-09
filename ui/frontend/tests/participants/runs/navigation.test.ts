import { describe, expect, it } from "vitest";
import { changeConnection, changeView, parseRoute, routeHref } from "../../../src/app/navigation";
import {
  canOpenHistoryRun,
  historyRunRoute,
  sessionRoute,
} from "../../../src/features/participants/runs/navigation";
import * as d from "../../../src/core/protocol/decoders";
import type { Codec } from "../../../src/core/protocol/codec";
const decode = <T>(codec: Codec<T>, value: string): T => {
  const result = codec.decode(d.jsonString(value));
  if (!result.ok) throw new Error(result.issue.expected);
  return result.value;
};
const id = (value: string) => decode(d.identifier, value),
  decimal = (value: string) => decode(d.positiveDecimal, value);
const association = {
  kind: "run" as const,
  connectionId: id("daemon"),
  generation: decimal("2"),
  workspaceId: id("workspace"),
  runId: id("same-run"),
};
describe("exact participant routes", () => {
  it("History run links retain old endpoint generation and do not carry writer attribution", () => {
    const route = historyRunRoute(association);
    expect(canOpenHistoryRun(association)).toBe(true);
    expect(route).toEqual({
      view: "participants",
      connectionId: "daemon",
      workspaceId: "workspace",
      projectId: null,
      entityId: "same-run",
      participant: { kind: "run", generation: "2" },
    });
    expect(parseRoute(routeHref(route))).toEqual({ ok: true, route });
    expect(
      canOpenHistoryRun({
        ...association,
        kind: "resource-version",
        resourceId: id("resource"),
        contentVersion: decimal("1"),
      }),
    ).toBe(false);
  });
  it.each(["actor", "run", "attempt"] as const)("roundtrips discriminated %s identity", (kind) => {
    const route = { ...historyRunRoute(association), participant: { kind, generation: "3" } };
    expect(parseRoute(routeHref(route))).toEqual({ ok: true, route });
    expect(changeView(route, "work").participant).toBeUndefined();
    expect(changeConnection(route, "other").participant).toBeUndefined();
  });
  it.each([
    "#/participants?connection=c&workspace=w&entity=x",
    "#/participants?connection=c&workspace=w&entity=x&participant=run",
    "#/participants?connection=c&workspace=w&entity=x&participant=run&generation=0",
    "#/participants?connection=c&workspace=w&entity=x&participant=run&generation=01",
    "#/participants?connection=c&workspace=w&entity=x&participant=run&generation=4611686018427387904",
    "#/participants?connection=c&workspace=w&entity=x&participant=run&generation=1&generation=2",
    "#/participants?connection=c&workspace=w&entity=x&participant=run&participant=actor&generation=1",
    "#/participants?connection=c&workspace=w&entity=x&participant=unknown&generation=1",
    "#/participants?connection=c&workspace=w&participant=run&generation=1",
    "#/participants?connection=c&entity=x&participant=run&generation=1",
    "#/participants?connection=c&workspace=w&entity=x&participant=run&generation=1&head=empty",
    "#/participants?connection=c&workspace=w&entity=x&participant=run&generation=1&discussion=thread",
    "#/work?connection=c&workspace=w&entity=x&participant=run&generation=1",
  ])("rejects incomplete, duplicate or mixed target %s", (link) =>
    expect(parseRoute(link).ok).toBe(false),
  );
  it("session links preserve explicit empty and retained heads without selecting an event", () => {
    const connection = {
      id: id("daemon"),
      generation: decimal("2"),
      label: "old endpoint",
      socket: "/tmp/old.sock",
    };
    for (const head of [null, decode(d.digest, "a".repeat(64))]) {
      const route = sessionRoute({
        connection,
        workspaceId: id("workspace"),
        sessionId: id("session"),
        head,
      });
      expect(parseRoute(routeHref(route))).toEqual({ ok: true, route });
      expect(route.history?.sequence).toBeUndefined();
    }
  });
  it("refuses composing two immutable feature targets", () =>
    expect(() =>
      routeHref({ ...historyRunRoute(association), history: { generation: "2", head: null } }),
    ).toThrow("combine immutable"));
});
