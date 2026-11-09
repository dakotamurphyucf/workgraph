import type { Page } from "@playwright/test";
import { test, expect } from "../e2e/support/fixtures";
import type { DaemonFixture } from "../../../test-support/daemon-fixture.mjs";
import type { CompanionFixture } from "../../../test-support/companion-fixture.mjs";
async function configure(page: Page, companion: CompanionFixture, daemon: DaemonFixture) {
  const html = await (await page.request.get(companion.url)).text(),
    cap = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(html)?.[1];
  if (cap === undefined) throw new Error("Missing actual capability");
  const headers = { Origin: new URL(companion.url).origin, "X-Workgraph-UI-Capability": cap };
  for (const [path, data] of [
    ["/connections", { id: "local", label: "Synthetic search workspace", socket: daemon.socket }],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const r = await page.request.post(new URL(`/ui-api/v1${path}`, companion.url).href, {
      headers,
      data,
    });
    expect(r.status(), await r.text()).toBe(200);
  }
  return headers;
}

test("Scope choices search, cancel, workspace reset and apply without mutations", async ({
  page,
  daemon,
  companion,
  browserDiagnostics,
  browserFailures,
}) => {
  await configure(page, companion, daemon);
  await daemon.call(
    "workspace.create",
    JSON.stringify({
      actor_id: "fixture-author",
      mutation_id: "scope-other",
      workspace_id: "other",
      name: "Another workspace",
      root: `${daemon.root}/other`,
    }),
  );
  await page.goto(
    new URL("/#/advanced?connection=local&workspace=demo&project=release", companion.url).href,
  );
  await expect(page.getByRole("heading", { name: "Advanced", exact: true })).toBeVisible();
  const mutations: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/operations") && r.method() === "POST") mutations.push(r.url());
  });
  await page.locator(".wg-scope-navigation").click();
  const dialog = page.getByRole("dialog", { name: "Workspace & project scope", exact: true });
  const workspaces = dialog.getByLabel("Workspace choices", { exact: true });
  const projects = dialog.getByLabel("Project choices", { exact: true });
  await expect(workspaces.getByRole("button", { name: /Another workspace/u })).toBeVisible();
  await expect(projects.getByRole("button", { name: /release/u })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await dialog.getByLabel("Search workspaces", { exact: true }).fill("another");
  await expect(workspaces.getByRole("button")).toHaveCount(1);
  await workspaces.getByRole("button", { name: /Another workspace/u }).click();
  await expect(dialog.locator(".sc-summary")).toContainText("All projects");
  await expect(projects.getByRole("button", { name: /release/u })).toHaveCount(0);
  await expect(projects.getByRole("button", { name: /All projects/u })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(page.url()).toContain("workspace=demo");
  expect(page.url()).toContain("project=release");
  await page.locator(".wg-scope-navigation").click();
  await expect(projects.getByRole("button", { name: /release/u })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await dialog.getByText("Enter a workspace ID", { exact: true }).click();
  await dialog.getByLabel("Workspace ID", { exact: true }).fill("invalid id");
  await dialog.getByRole("button", { name: "Open scope", exact: true }).click();
  await expect(dialog.getByLabel("Workspace ID", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await workspaces.getByRole("button", { name: /Another workspace/u }).click();
  await expect(projects.getByRole("button", { name: /All projects/u })).toBeVisible();
  browserDiagnostics.markPendingReads();
  await dialog.getByRole("button", { name: "Open scope", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(page.url()).toContain("workspace=other");
  expect(page.url()).not.toContain("project=");
  expect(mutations).toEqual([]);
  expect(browserFailures).toEqual([]);
});

test("Scope without a connection explains setup and keeps manual validation accessible", async ({
  page,
  companion,
  browserFailures,
}) => {
  await page.setViewportSize({ width: 640, height: 850 });
  await page.goto(new URL("/#/overview", companion.url).href);
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.locator(".wg-scope-navigation").click();
  const dialog = page.getByRole("dialog", { name: "Workspace & project scope", exact: true });
  await expect(dialog.getByText(/Close this menu and use Workgraph/u)).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "Choose a workspace first", exact: true }),
  ).toBeVisible();
  await dialog.getByText("Enter a workspace ID", { exact: true }).click();
  await dialog.getByLabel("Workspace ID", { exact: true }).fill("demo");
  await dialog.getByRole("button", { name: "Open scope", exact: true }).click();
  await expect(dialog.getByLabel("Workspace ID", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".wg-scope-navigation")).toBeFocused();
  expect(browserFailures).toEqual([]);
});
