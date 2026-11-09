import { waitForPageReads } from "../e2e/support/readiness";
import path from "node:path";
import { test, expect } from "../e2e/support/fixtures";
import type { Page, Locator, TestInfo } from "@playwright/test";
import type { CompanionFixture } from "../../../test-support/companion-fixture.mjs";

async function mount(page: Page, companion: CompanionFixture, socket: string, view: string) {
  const bootstrap = await page.request.get(companion.url);
  const capability = /<meta\s+name="workgraph-capability"\s+content="([a-f0-9]{64})"\s*\/?>/u.exec(
    await bootstrap.text(),
  )?.[1];
  if (!capability) throw new Error("Missing native launch capability");
  for (const [endpoint, body] of [
    ["/connections", { id: "local", label: "Observation daemon", socket }],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const response = await page.request.post(new URL(`/ui-api/v1${endpoint}`, companion.url).href, {
      headers: { Origin: new URL(companion.url).origin, "X-Workgraph-UI-Capability": capability },
      data: body,
    });
    expect(response.status()).toBe(200);
    await response.text();
  }
  await page.goto(
    new URL(`/#/${view}?connection=local&workspace=demo&project=release`, companion.url).href,
  );
  await waitForPageReads(page);
  if (view === "overview")
    await page
      .locator("summary")
      .filter({ hasText: /^Workspace and project management$/u })
      .click();
  return page.locator("#root");
}
async function actor(root: Locator, value: string) {
  await root.locator(".wg-actor-trigger").click();
  await root.getByLabel("Acting actor ID").fill(value);
  await root.getByRole("button", { name: "Use selection", exact: true }).click();
}
function panel(root: Locator, title: string) {
  return root
    .locator("section.wg-panel")
    .filter({ has: root.page().getByRole("heading", { name: title, exact: true }) });
}
async function capture(
  page: Page,
  info: TestInfo,
  name: string,
  requests: readonly { method: string; path: string }[],
) {
  await expect(page.getByText("Preparing passive JSON view…", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Preparing content", exact: true })).toHaveCount(
    0,
  );
  await waitForPageReads(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    for (const element of document.querySelectorAll<HTMLElement>(".wg-content")) {
      element.scrollTop = 0;
      element.scrollLeft = 0;
    }
  });
  const screenshot = info.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  await info.attach(name, { path: screenshot, contentType: "image/png" });
  await info.attach(`${name}-requests`, {
    body: JSON.stringify(requests, null, 2),
    contentType: "application/json",
  });
}
function requests(page: Page) {
  const result: { method: string; path: string }[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      pathname.startsWith("/ui-api/v1/operations/") ||
      pathname.startsWith("/ui-api/v1/daemon-launches/")
    )
      result.push({ method: request.method(), path: pathname });
  });
  return result;
}
function assertOneExecution(observed: readonly { method: string; path: string }[]) {
  const executions = observed.filter((r) => r.method === "POST" && r.path.endsWith("/execute"));
  expect(executions).toHaveLength(1);
  const operationPath = executions[0]!.path.slice(0, -"/execute".length);
  expect(
    observed.filter((r) => r.method === "GET" && r.path === operationPath).length,
  ).toBeGreaterThanOrEqual(1);
  expect(
    observed.filter(
      (r) => r.method === "POST" && !r.path.endsWith("/prepare") && !r.path.endsWith("/execute"),
    ),
  ).toEqual([]);
}

test("Advanced explicit send reaches committed without Inspect and keeps the captured writer", async ({
  page,
  daemon,
  companion,
  browserFailures,
  browserDiagnostics,
}, info) => {
  const root = await mount(page, companion, daemon.socket, "advanced"),
    observed = requests(page);
  await actor(root, "human");
  await root.getByRole("button", { name: "Methods", exact: true }).click();
  await root.getByLabel("Search catalogue").fill("ticket.create");
  await root
    .locator(".adv-item")
    .filter({ has: page.locator("code", { hasText: /^ticket\.create$/u }) })
    .click();
  await root.getByRole("button", { name: "New draft for ticket.create", exact: true }).click();
  await root.getByRole("button", { name: "Raw JSON", exact: true }).click();
  await root
    .getByLabel("Exact parameter source")
    .fill(
      '{"workspace_id":"demo","actor_id":"human","project_id":"release","ticket_id":"observed-ticket","title":"Observed without manual inspect"}',
    );
  await root.getByRole("button", { name: "Validate & prepare", exact: true }).click();
  await expect(root.locator(".wg-badge").filter({ hasText: /^prepared_unsent$/u })).toBeVisible();
  await waitForPageReads(page);
  browserDiagnostics.markPendingReads();
  await actor(root, "different-current-actor");
  await root.getByRole("button", { name: "Execute saved request", exact: true }).click();
  const captured = panel(root, "Captured operation");
  await expect(captured.locator(".wg-badge")).toHaveText("committed", { timeout: 15_000 });
  await expect(captured).toContainText(/writer\s+human/u);
  expect(
    await daemon.call("ticket.get", '{"workspace_id":"demo","ticket_id":"observed-ticket"}'),
  ).toContain("Observed without manual inspect");
  await root
    .getByRole("button", { name: "Close editor; keep saved intention", exact: true })
    .click();
  await expect(panel(root, "Captured operation").locator(".wg-badge")).toHaveText("committed");
  assertOneExecution(observed);
  await capture(page, info, "advanced-automatic-observation", observed);
  expect(browserFailures).toEqual([]);
});

test("tailored lifecycle send reaches committed with read-only observation and one execution", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const root = await mount(page, companion, daemon.socket, "overview"),
    observed = requests(page);
  await actor(root, "human");
  await root.getByRole("button", { name: "Create project", exact: true }).click();
  await root.getByLabel("ID (optional)", { exact: true }).fill("observed-project");
  await root.getByLabel("Title", { exact: true }).fill("Tailored action observed automatically");
  await root.getByRole("button", { name: "Review captured action", exact: true }).click();
  const review = panel(root, "Review captured action");
  await expect(review.locator(".wg-badge")).toHaveText("prepared_unsent");
  await review.getByRole("button", { name: "Execute saved request", exact: true }).click();
  await expect(review.locator(".wg-badge")).toHaveText("committed", { timeout: 15_000 });
  expect(
    await daemon.call("project.get", '{"workspace_id":"demo","project_id":"observed-project"}'),
  ).toContain("Tailored action observed automatically");
  assertOneExecution(observed);
  await capture(page, info, "lifecycle-automatic-observation", observed);
  expect(browserFailures).toEqual([]);
});

test("explicit saved startup is observed after dialog remount without Inspect or process ownership inference", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const root = await mount(page, companion, daemon.socket, "overview"),
    observed = requests(page);
  await root.locator(".wg-workspace-switch").click();
  const dialog = root.getByRole("dialog", { name: "Daemon connections" });
  await expect(
    dialog.getByRole("heading", { name: "Manage Observation daemon", exact: true }),
  ).toBeVisible();
  await waitForPageReads(page);
  await dialog
    .getByLabel("Registry directory on companion host", { exact: true })
    .fill(path.join(daemon.root, "unused-startup-registry"));
  await dialog
    .getByLabel("Private startup log on companion host", { exact: true })
    .fill(path.join(daemon.root, "startup.log"));
  await dialog.getByLabel("Startup timeout in seconds", { exact: true }).fill("4");
  await dialog.getByRole("button", { name: "Review startup plan", exact: true }).click();
  const startup = panel(dialog, "Captured startup plan");
  await expect(startup.locator(".wg-badge")).toHaveText("prepared unsent");
  await startup.getByRole("button", { name: "Start saved plan", exact: true }).click();
  await dialog.getByRole("button", { name: "Close Daemon connections", exact: true }).click();
  await root.locator(".wg-workspace-switch").click();
  await expect(panel(dialog, "Captured startup plan").locator(".wg-badge")).toHaveText(
    "Existing endpoint observed ready",
    { timeout: 15_000 },
  );
  await expect(dialog.getByText(/Readiness is historical and ownership is unknown/u)).toBeVisible();
  const starts = observed.filter((r) => r.method === "POST" && r.path.endsWith("/start"));
  expect(starts).toHaveLength(1);
  const launchPath = starts[0]!.path.slice(0, -"/start".length);
  expect(
    observed.filter((r) => r.method === "GET" && r.path === launchPath).length,
  ).toBeGreaterThanOrEqual(1);
  expect(observed.filter((r) => r.method === "POST" && r.path.endsWith("/retry"))).toEqual([]);
  await daemon.call("daemon.health", "{}");
  await capture(page, info, "startup-automatic-observation", observed);
  expect(browserFailures).toEqual([]);
});
