import { describe, expect, it } from "vitest";
import { historyNavigationTarget } from "../../../src/features/history/transcript/navigation-target";
import { decimal, id } from "../../../src/features/history/transcript/controller";
describe("exact host navigation payload capture", () => {
  it("resource intent retains content version and endpoint generation after current selection changes", () => {
    const scope = { connectionId: id("local"), generation: decimal("1"), workspaceId: id("demo") },
      resource = {
        kind: "resource-version" as const,
        resourceId: id("notes"),
        contentVersion: decimal("3"),
      };
    const target = historyNavigationTarget(scope, resource);
    scope.generation = decimal("2");
    resource.contentVersion = decimal("9");
    expect(target).toEqual({
      kind: "resource-version",
      connectionId: "local",
      generation: "1",
      workspaceId: "demo",
      resourceId: "notes",
      contentVersion: "3",
    });
    expect(Object.isFrozen(target)).toBe(true);
  });
  it("run and scope intents copy exact IDs without choosing writer, current target or historical planning state", () => {
    const scope = { connectionId: id("local"), generation: decimal("1"), workspaceId: id("demo") },
      planning = { kind: "ticket" as const, id: id("original") };
    const target = historyNavigationTarget(scope, { kind: "scope", scope: planning });
    planning.id = id("changed");
    expect(target.kind === "scope" ? target.scope : null).toEqual({
      kind: "ticket",
      id: "original",
    });
    expect(target.kind === "scope" && Object.isFrozen(target.scope)).toBe(true);
    expect(historyNavigationTarget(scope, { kind: "run", runId: id("recorded-run") })).toEqual({
      kind: "run",
      runId: "recorded-run",
      connectionId: "local",
      generation: "1",
      workspaceId: "demo",
    });
  });
});
