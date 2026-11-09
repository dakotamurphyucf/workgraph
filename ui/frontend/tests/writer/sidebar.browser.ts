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

test("Workspace shortcuts, persistent pins and identity, and read-only action guidance", async ({
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
      mutation_id: "sidebar-other",
      workspace_id: "other",
      name: "Another workspace",
      root: `${daemon.root}/other`,
    }),
  );
  await daemon.call(
    "project.create",
    JSON.stringify({
      workspace_id: "demo",
      actor_id: "fixture-author",
      mutation_id: "sidebar-second",
      project_id: "second",
      title: "Second project",
    }),
  );
  await page.goto(new URL("/#/work?connection=local&workspace=demo", companion.url).href);
  await expect(page.getByRole("button", { name: "New ticket", exact: true })).toBeEnabled();
  const mutations: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/(prepare|operations)/u.test(r.url())) mutations.push(r.url());
  });
  const identity = page.locator(".qs-identity");
  await expect(identity).toContainText("Read-only");
  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  const writer = page.getByRole("dialog", { name: "Acting actor & run", exact: true });
  await expect(writer).toContainText("Nothing will be submitted");
  await writer.getByLabel("Acting actor ID", { exact: true }).fill("alice");
  browserDiagnostics.markPendingReads();
  await writer.getByRole("button", { name: "Use selection", exact: true }).click();
  await expect(identity).toContainText("Acting as alice");
  expect(mutations).toEqual([]);
  await expect(page.getByRole("button", { name: /Open .*Clarify the workflow/u })).toBeVisible();
  browserDiagnostics.markPendingReads();
  await page.reload();
  await expect(page.getByRole("button", { name: /Open .*Clarify the workflow/u })).toBeVisible();
  await expect(identity).toContainText("Acting as alice");
  await page.getByRole("button", { name: /^Switch project:/u }).click();
  const picker = page.getByRole("dialog", { name: "Switch project", exact: true });
  await expect(picker.getByRole("button", { name: /^Pin project/u }).first()).toBeVisible();
  const pin = picker.getByRole("button", { name: /^Pin project/u }).first();
  await pin.click();
  await picker
    .getByRole("button", { name: /^Pin project/u })
    .first()
    .click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /^Switch project:/u })).toBeFocused();
  const pins = page.getByRole("region", { name: "Pinned projects", exact: true });
  await expect(pins.locator(".qs-pin-row")).toHaveCount(2);
  browserDiagnostics.markPendingReads();
  const projectRead = page.waitForResponse((r) => {
    const text = r.request().postData() ?? "";
    return (
      r.url().endsWith("/read") &&
      text.includes('"method":"ticket.list"') &&
      text.includes('"project_id":"release"')
    );
  });
  await pins.locator(".qs-pin-row > button").first().click();
  await projectRead;
  await expect(page.getByRole("button", { name: /Open .*Clarify the workflow/u })).toBeVisible();
  await expect(page).toHaveURL(/project=release/u);
  await expect(identity).toContainText("alice");
  await expect(page.getByRole("button", { name: /Open .*Clarify the workflow/u })).toBeVisible();
  browserDiagnostics.markPendingReads();
  await page.reload();
  await expect(page.getByRole("button", { name: /Open .*Clarify the workflow/u })).toBeVisible();
  await expect(pins.locator(".qs-pin-row")).toHaveCount(2);
  await expect(identity).toContainText("alice");
  await page.getByRole("button", { name: /^Switch workspace:/u }).click();
  const spaces = page.getByRole("dialog", { name: "Switch workspace", exact: true });
  browserDiagnostics.markPendingReads();
  await spaces.getByRole("button", { name: /Another workspace/u }).click();
  await expect(page).toHaveURL(/workspace=other/u);
  await expect(identity).toContainText("Read-only");
  await expect(pins.locator(".qs-pin-row")).toHaveCount(0);
  await page.getByRole("button", { name: /^Switch workspace:/u }).click();
  browserDiagnostics.markPendingReads();
  await spaces.locator(".qs-option > button").filter({ hasText: "demo" }).click();
  await expect(identity).toContainText("alice");
  await expect(pins.locator(".qs-pin-row")).toHaveCount(2);
  await identity.click();
  await writer.getByRole("button", { name: "Clear acting actor", exact: true }).click();
  browserDiagnostics.markPendingReads();
  await writer.getByRole("button", { name: "Use selection", exact: true }).click();
  await expect(page.getByRole("button", { name: /Open .*Clarify the workflow/u })).toBeVisible();
  browserDiagnostics.markPendingReads();
  await page.reload();
  await expect(page.getByRole("button", { name: /Open .*Clarify the workflow/u })).toBeVisible();
  await expect(identity).toContainText("Read-only");
  expect(mutations).toEqual([]);
  expect(browserFailures).toEqual([]);
});

test("An actor-required action inside a dialog keeps its form and cancels without a write", async ({
  page,
  daemon,
  companion,
  browserDiagnostics,
  browserFailures,
}) => {
  await configure(page, companion, daemon);
  await page.goto(new URL("/#/work?connection=local&workspace=demo", companion.url).href);
  await page.getByRole("button", { name: "Labels & statuses", exact: true }).click();
  const metadata = page.getByRole("dialog", { name: "Labels and statuses", exact: true });
  await metadata.getByRole("button", { name: /^Labels Reusable/u }).click();
  await metadata.getByRole("button", { name: "Open metadata form", exact: true }).click();
  const writer = page.getByRole("dialog", { name: "Acting actor & run", exact: true });
  await expect(writer).toBeVisible();
  browserDiagnostics.markPendingReads();
  await writer.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(metadata).toBeVisible();
  await expect(metadata.getByRole("button", { name: /^Labels Reusable/u })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await metadata.getByRole("button", { name: "Open metadata form", exact: true }).click();
  await writer.getByLabel("Acting actor ID", { exact: true }).fill("alice");
  browserDiagnostics.markPendingReads();
  await writer.getByRole("button", { name: "Use selection", exact: true }).click();
  await expect(metadata).toBeVisible();
  await metadata.getByRole("button", { name: "Open metadata form", exact: true }).click();
  await expect(metadata).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: /label/u })).toBeVisible();
  expect(browserFailures).toEqual([]);
});

test("Daemon settings remain open underneath the actor chooser", async ({
  page,
  daemon,
  companion,
  browserDiagnostics,
  browserFailures,
}) => {
  await configure(page, companion, daemon);
  await page.goto(new URL("/#/advanced?connection=local&workspace=demo", companion.url).href);
  await page.locator(".wg-workspace-switch").click();
  const connections = page.getByRole("dialog", { name: "Daemon connections", exact: true });
  await connections.getByRole("button", { name: "Manage", exact: true }).click();
  await connections.getByText("Stop this daemon", { exact: true }).click();
  await connections.getByRole("button", { name: /Review daemon shutdown/u }).click();
  const writer = page.getByRole("dialog", { name: "Acting actor & run", exact: true });
  await expect(writer).toBeVisible();
  browserDiagnostics.markPendingReads();
  await writer.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(connections.getByRole("button", { name: /Review daemon shutdown/u })).toBeVisible();
  expect(browserFailures).toEqual([]);
});
