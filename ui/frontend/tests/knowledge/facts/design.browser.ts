import { test, expect } from "../../e2e/support/fixtures";
import type { Page } from "@playwright/test";
import type { DaemonFixture } from "../../../../test-support/daemon-fixture.mjs";
import type { CompanionFixture } from "../../../../test-support/companion-fixture.mjs";

test.use({ viewport: { width: 1500, height: 1050 }, actionTimeout: 12000 });
async function mount(page: Page, companion: CompanionFixture, daemon: DaemonFixture) {
  const body = await page.request.get(companion.url);
  const cap = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(await body.text())?.[1];
  if (!cap) throw new Error("Native bootstrap missing");
  for (const [path, data] of [
    ["/connections", { id: "local", label: "Facts walkthrough", socket: daemon.socket }],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const response = await page.request.post(new URL(`/ui-api/v1${path}`, companion.url).href, {
      headers: { Origin: new URL(companion.url).origin, "X-Workgraph-UI-Capability": cap },
      data,
    });
    expect(response.status()).toBe(200);
    await response.text();
  }
  await page.goto(
    new URL("/#/facts?connection=local&workspace=demo&project=release", companion.url).href,
  );
  await expect(page.getByRole("heading", { name: "Facts", exact: true })).toBeVisible();
}
async function actor(page: Page) {
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill("fixture-author");
  await page.getByLabel("Run ID (optional)", { exact: true }).fill("");
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
}

test("Facts guide creation, searchable links, retained editing, deletion and restoration", async ({
  page,
  daemon,
  companion,
  browserFailures,
}) => {
  await mount(page, companion, daemon);
  await expect(page.locator(".fact-guide")).toContainText("a small piece of shared information");
  await actor(page);
  await page.getByRole("button", { name: "New or existing fact", exact: true }).click();
  await page.getByLabel("New or existing fact key", { exact: true }).fill("design.review");
  await page.getByRole("button", { name: "Edit or create fact", exact: true }).click();
  let draft = page.getByRole("dialog", { name: "Create fact · design.review", exact: true });
  await expect(draft).toContainText("confirmed missing key");
  await draft.getByRole("button", { name: "Raw JSON source", exact: true }).click();
  await draft
    .getByLabel("Fact JSON source", { exact: true })
    .fill(
      '{"summary":"Reviewed","ready":true,"exact":900719925474099312345,"nested":{"items":["a",null]}}',
    );
  await draft.getByRole("button", { name: "Edit references", exact: true }).click();
  await draft.getByRole("button", { name: "Add reference", exact: true }).click();
  await draft.getByRole("button", { name: "Reference 1 ID", exact: true }).click();
  await draft.getByRole("textbox", { name: "Search tickets", exact: true }).fill("build");
  await draft.locator("[data-reference-option]").filter({ hasText: "build" }).first().click();
  await expect(draft.getByRole("button", { name: "Reference 1 ID", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await page
    .getByRole("button", { name: "Close Create fact · design.review", exact: true })
    .click();
  await page.getByRole("button", { name: "Drafts · 1", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Retained fact drafts", exact: true })
    .getByRole("button")
    .filter({ hasText: "design.review" })
    .click();
  await draft.getByRole("button", { name: "Raw JSON source", exact: true }).click();
  await expect(draft.getByLabel("Fact JSON source", { exact: true })).toContainText(
    "900719925474099312345",
  );
  await draft.getByRole("button", { name: "Review replacement", exact: true }).click();
  await draft.getByRole("button", { name: "Execute saved request", exact: true }).click();
  await expect(draft.getByRole("status").filter({ hasText: /^committed$/u })).toBeVisible();
  await page
    .getByRole("button", { name: "Close Create fact · design.review", exact: true })
    .click();
  await page.locator(".fact-keys").getByRole("button").filter({ hasText: "design.review" }).click();
  const reader = page.getByRole("region", { name: "Selected fact", exact: true });
  await expect(reader.locator(".fact-structure").first()).toContainText("900719925474099312345");
  await reader.locator(".fact-nested > summary").first().click();
  await expect(reader.locator(".fact-nested[open]")).toContainText("items");
  await reader.getByRole("button", { name: "Delete selected fact", exact: true }).click();
  draft = page.getByRole("dialog", { name: "Delete fact · design.review", exact: true });
  await expect(draft).toContainText("hidden from the normal list");
  await draft.getByRole("button", { name: "Review deletion", exact: true }).click();
  await draft.getByRole("button", { name: "Execute saved request", exact: true }).click();
  await expect(draft.getByRole("status").filter({ hasText: /^committed$/u })).toBeVisible();
  await page
    .getByRole("button", { name: "Close Delete fact · design.review", exact: true })
    .click();
  await reader.getByRole("button", { name: "Read fact history", exact: true }).click();
  const history = page.getByRole("dialog", { name: "Fact history", exact: true });
  await expect(history.locator(".fact-history-list > li")).toHaveCount(2);
  await history
    .getByRole("button", { name: "Restore this value into a new draft", exact: true })
    .first()
    .click();
  draft = page.getByRole("dialog", { name: "Edit fact · design.review", exact: true });
  await draft.getByRole("button", { name: "Review replacement", exact: true }).click();
  await draft.getByRole("button", { name: "Execute saved request", exact: true }).click();
  await expect(draft.getByRole("status").filter({ hasText: /^committed$/u })).toBeVisible();
  const raw = await daemon.call(
    "fact.get",
    JSON.stringify({
      workspace_id: "demo",
      scope: { kind: "project", id: "release" },
      key: "design.review",
    }),
  );
  expect(raw).toContain('"exact":900719925474099312345');
  expect(raw).toContain('"revision":"3"');
  expect(browserFailures).toEqual([]);
});

test("Facts scope choices, no-match guidance and advanced field filters stay distinct", async ({
  page,
  daemon,
  companion,
  browserFailures,
  browserDiagnostics,
}) => {
  for (const [key, value] of [
    ["ready.one", { ready: true }],
    ["ready.two", { ready: false }],
  ] as const)
    await daemon.call(
      "fact.put",
      JSON.stringify({
        workspace_id: "demo",
        actor_id: "fixture-author",
        mutation_id: key.replaceAll(".", "-"),
        scope: { kind: "project", id: "release" },
        key,
        expected_revision: "0",
        value,
      }),
    );
  await mount(page, companion, daemon);
  await expect(page.locator(".fact-keys > li")).toHaveCount(3);
  await page.getByLabel("Filter loaded keys", { exact: true }).fill("nothing");
  await expect(page.locator(".fact-no-match")).toContainText("No loaded keys match");
  await page.getByLabel("Filter loaded keys", { exact: true }).fill("");
  await page.getByRole("button", { name: "Scope & filters", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Fact scope & filters", exact: true });
  await dialog.getByText("Match a field value · advanced (0/8)", { exact: true }).click();
  await dialog.getByRole("button", { name: "Add predicate", exact: true }).click();
  await dialog.getByLabel("Predicate 1 pointer", { exact: true }).fill("/ready");
  await dialog.getByLabel("Predicate 1 scalar JSON", { exact: true }).fill("true");
  await dialog.getByRole("button", { name: "Apply fact filters", exact: true }).click();
  await expect(page.locator(".fact-keys > li")).toHaveCount(1);
  await expect(page.locator(".fact-keys")).toContainText("ready.one");
  await page.getByRole("button", { name: "Scope & filters", exact: true }).click();
  await dialog.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(page.locator(".fact-keys > li")).toHaveCount(3);
  await page.getByRole("button", { name: "Scope & filters", exact: true }).click();
  await dialog.getByRole("combobox", { name: "Fact scope", exact: true }).selectOption("ticket");
  await dialog.getByRole("button", { name: "Fact scope ID", exact: true }).click();
  await dialog.locator("[data-reference-option]").first().click();
  // Changing scope cancels the old scope's active changes.wait subscription.
  browserDiagnostics.markPendingReads();
  await dialog.getByRole("button", { name: "Browse scope", exact: true }).click();
  await expect(page.locator(".fact-directory")).toContainText("No facts match here yet");
  await page.getByRole("button", { name: "Find references", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Find referencing facts", exact: true });
  await dialog.getByRole("button", { name: "Referenced entity ID", exact: true }).click();
  await dialog.locator("[data-reference-option]").first().click();
  await dialog.getByRole("button", { name: "Find referencing facts", exact: true }).click();
  await expect(dialog).toContainText("No active referencing facts");
  await page.getByRole("button", { name: "Close Find referencing facts", exact: true }).click();
  await page.setViewportSize({ width: 700, height: 900 });
  await page.getByRole("button", { name: "About facts", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "About facts", exact: true })).toContainText(
    "Use Resources for longer notes",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(browserFailures).toEqual([]);
});
