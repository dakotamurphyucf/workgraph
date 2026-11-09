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

test("Writer choices show people and runs, retain independent IDs and only apply explicitly", async ({
  page,
  daemon,
  companion,
  browserDiagnostics,
  browserFailures,
}) => {
  let serial = 0;
  const write = (method: string, params: object) =>
    daemon.call(
      method,
      JSON.stringify({
        workspace_id: "demo",
        actor_id: "fixture-author",
        mutation_id: `writer-${++serial}`,
        ...params,
      }),
    );
  for (const id of ["alice", "bob"]) {
    await write("actor.put", {
      target_actor_id: id,
      expected_revision: "0",
      name: id === "alice" ? "Alice Reviewer" : "Bob Builder",
      kind: id === "alice" ? "person" : "agent",
    });
    await write("run.register", {
      actor_id: id,
      target_run_id: `${id}-run`,
      objective: `${id} review work`,
    });
  }
  await configure(page, companion, daemon);
  await page.goto(new URL("/#/advanced?connection=local&workspace=demo", companion.url).href);
  await expect(page.getByRole("heading", { name: "Advanced", exact: true })).toBeVisible();
  const mutations: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/(prepare|operations)/u.test(r.url())) mutations.push(r.url());
  });
  await page.locator(".wg-actor-trigger").click();
  const d = page.getByRole("dialog", { name: "Acting actor & run", exact: true });
  const actors = d.getByLabel("Actor choices", { exact: true });
  const runs = d.getByLabel("Run choices", { exact: true });
  await expect(actors.getByRole("button", { name: /Alice Reviewer/u })).toBeVisible();
  await expect(runs.getByRole("button", { name: /bob review work/u })).toBeVisible();
  await d.getByLabel("Search actors", { exact: true }).fill("alice");
  await expect(actors.getByRole("button")).toHaveCount(1);
  await actors.getByRole("button").click();
  await expect(d.getByLabel("Acting actor ID", { exact: true })).toHaveValue("alice");
  await expect(runs.getByRole("button", { name: /bob review work/u })).toHaveCount(0);
  await runs.getByRole("button", { name: /alice review work/u }).click();
  await expect(d.getByLabel("Run ID (optional)", { exact: true })).toHaveValue("alice-run");
  await d.getByLabel("Show runs for other actors").check();
  await runs.getByRole("button", { name: /bob review work/u }).click();
  await expect(d.getByRole("status")).toContainText("This run belongs to");
  await expect(d.getByLabel("Acting actor ID", { exact: true })).toHaveValue("alice");
  await d.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".wg-actor-trigger")).toContainText("No acting actor");
  await page.locator(".wg-actor-trigger").click();
  await expect(actors.getByRole("button", { name: /Alice Reviewer/u })).toBeVisible();
  await actors.getByRole("button", { name: /Alice Reviewer/u }).click();
  await runs.getByRole("button", { name: /alice review work/u }).click();
  browserDiagnostics.markPendingReads();
  await d.getByRole("button", { name: "Use selection", exact: true }).click();
  await expect(d).toHaveCount(0);
  await expect(page.locator(".wg-actor-trigger")).toContainText("alice");
  await expect(page.locator(".wg-actor-trigger")).toContainText("alice-run");
  await page.locator(".wg-actor-trigger").click();
  await expect(d.getByLabel("Acting actor ID", { exact: true })).toHaveValue("alice");
  await d.getByRole("button", { name: "Clear acting actor", exact: true }).click();
  await expect(d.getByLabel("Run ID (optional)", { exact: true })).toHaveValue("alice-run");
  await d.getByRole("button", { name: "Use no run", exact: true }).click();
  await d.getByLabel("Acting actor ID", { exact: true }).fill("invalid id");
  await d.getByRole("button", { name: "Use selection", exact: true }).click();
  await expect(d.getByLabel("Acting actor ID", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  browserDiagnostics.markPendingReads();
  await page.keyboard.press("Escape");
  await expect(page.locator(".wg-actor-trigger")).toBeFocused();
  expect(mutations).toEqual([]);
  expect(browserFailures).toEqual([]);
});

test("Writer manual entry remains available without a workspace and fits a narrow window", async ({
  page,
  companion,
  browserFailures,
}) => {
  await page.setViewportSize({ width: 640, height: 850 });
  await page.goto(new URL("/#/overview", companion.url).href);
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.locator(".wg-actor-trigger").click();
  const d = page.getByRole("dialog", { name: "Acting actor & run", exact: true });
  await expect(d.getByText(/Choose a daemon and workspace to browse/u)).toBeVisible();
  await d.getByLabel("Acting actor ID", { exact: true }).fill("manual-person");
  await d.getByLabel("Run ID (optional)", { exact: true }).fill("manual-run");
  expect(await d.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  await d.getByRole("button", { name: "Use selection", exact: true }).click();
  await expect(d).toHaveCount(0);
  await expect(page.locator(".wg-actor-trigger")).toContainText("manual-person");
  await expect(page.locator(".wg-actor-trigger")).toContainText("manual-run");
  expect(browserFailures).toEqual([]);
});
