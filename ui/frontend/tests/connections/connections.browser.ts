import path from "node:path";
import { test as base, expect } from "../e2e/support/fixtures";
import { mkdtemp, symlink, rm } from "node:fs/promises";
import {
  fixtureBinary,
  startDaemonFixture,
  type DaemonFixture,
} from "../../../test-support/daemon-fixture.mjs";
import {
  companionBinary,
  startCompanionFixture,
} from "../../../test-support/companion-fixture.mjs";
import type { Page, Locator, TestInfo } from "@playwright/test";
import type { CompanionFixture } from "../../../test-support/companion-fixture.mjs";

const test = base.extend<{ readonly secondary: DaemonFixture }>({
  // eslint-disable-next-line no-empty-pattern
  secondary: async ({}, runTest) => {
    const daemon = await startDaemonFixture({ binary: fixtureBinary() });
    try {
      await runTest(daemon);
    } finally {
      await daemon.dispose();
    }
  },
  // Real same-version sibling layout; no installed-package qualification is inferred from these symlinks.
  // eslint-disable-next-line no-empty-pattern
  companion: async ({}, runTest) => {
    const installation = await mkdtemp("/tmp/wgui-pair-");
    try {
      await symlink(companionBinary(), path.join(installation, "workgraph-ui"));
      await symlink(fixtureBinary(), path.join(installation, "workgraph"));
      const companion = await startCompanionFixture({
        binary: path.join(installation, "workgraph-ui"),
      });
      try {
        await runTest(companion);
      } finally {
        await companion.dispose();
      }
    } finally {
      await rm(installation, { recursive: true, force: true });
    }
  },
});
/** Actual embedded production Application. No route interception, test module or alternate composition. */
async function mount(page: Page, companion: CompanionFixture, socket?: string) {
  if (socket !== undefined) {
    const bootstrap = await page.request.get(companion.url);
    expect(bootstrap.status()).toBe(200);
    const source = await bootstrap.text();
    const tokens = [
      ...source.matchAll(/<meta name="workgraph-capability" content="([a-f0-9]{64})"/gu),
    ];
    const capability = tokens[0]?.[1];
    if (tokens.length !== 1 || capability === undefined)
      throw new Error("Native bootstrap capability missing or ambiguous");
    for (const [endpoint, body] of [
      ["/connections", { id: "local", label: "Qualification daemon", socket }],
      ["/connections/local/attach", { generation: "1" }],
    ] as const) {
      const response = await page.request.post(
        new URL(`/ui-api/v1${endpoint}`, companion.url).href,
        {
          headers: {
            Origin: new URL(companion.url).origin,
            "X-Workgraph-UI-Capability": capability,
          },
          data: body,
        },
      );
      expect(response.status()).toBe(200);
      await response.text();
    }
  }
  await page.goto(
    companion.url + (socket === undefined ? "" : "#/overview?connection=local&workspace=demo"),
  );
  const root = page.locator("#root");
  await expect(root.getByText("Companion reachable", { exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
  if (socket !== undefined) await openManagement(root);
  return root;
}
function panel(root: Locator, title: string) {
  return root
    .locator("section.wg-panel")
    .filter({ has: root.page().getByRole("heading", { name: title, exact: true }) });
}
async function writer(root: Locator, actor: string, beforeChange: () => void) {
  await root.locator(".wg-actor-trigger").click();
  await root.getByLabel("Acting actor ID").fill(actor);
  beforeChange();
  await root.getByRole("button", { name: "Use selection", exact: true }).click();
}
async function openManagement(root: Locator) {
  const summary = root
    .locator("summary")
    .filter({ hasText: /^Workspace and project management$/u });
  await expect(summary).toBeVisible();
  if ((await summary.locator("..").getAttribute("open")) === null) await summary.click();
}
async function readyForNavigation(page: Page) {
  await page.waitForLoadState("networkidle");
}
async function connect(
  root: Locator,
  socket: string,
  id = "local",
  label = "Qualification daemon",
) {
  await root.getByRole("button", { name: "Connection profiles", exact: true }).click();
  const dialog = root.getByRole("dialog", { name: "Daemon connections" });
  await expect(
    dialog.getByRole("heading", { name: "Your first connection", exact: true }),
  ).toBeVisible();
  await dialog.getByLabel("Profile ID", { exact: true }).fill(id);
  await dialog.getByLabel("Connection label", { exact: true }).fill(label);
  await dialog.getByLabel("Unix socket on companion host", { exact: true }).fill(socket);
  await dialog.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: `Manage ${label}`, exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Attach & inspect capabilities", exact: true }).click();
  await expect(dialog.getByText("handshake observed", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Use this connection", exact: true }).click();
}
async function selectDemo(page: Page, root: Locator) {
  await openManagement(root);
  await root.getByRole("button", { name: "Synthetic UI qualification", exact: true }).click();
  await expect(page).toHaveURL(/workspace=demo(?:&|$)/u);
  await expect(root.getByRole("heading", { name: "Choose a workspace", exact: true })).toHaveCount(
    0,
  );
  await openManagement(root);
  await expect(root.getByRole("button", { name: "Create project", exact: true })).toBeVisible();
  await readyForNavigation(page);
}
async function apply(
  root: Locator,
  page: Page,
  method: string,
  state = "committed",
  currentConnection = true,
) {
  await root.getByRole("button", { name: "Review changes", exact: true }).click();
  const review = panel(root, "Review captured action");
  await expect(review.locator(".wg-badge")).toHaveText("prepared_unsent");
  if (currentConnection)
    await expect(
      panel(root, "Retained lifecycle actions").getByRole("button", {
        name: `${method} · prepared_unsent`,
        exact: true,
      }),
    ).toBeVisible();
  await expect(
    review.getByRole("button", { name: "Validate & prepare same intention", exact: true }),
  ).toHaveCount(0);
  await review.getByRole("button", { name: "Execute saved request", exact: true }).click();
  await expect
    .poll(async () => {
      const observed = await review.locator(".wg-badge").textContent();
      if (observed === "sending")
        await review.getByRole("button", { name: "Inspect saved action", exact: true }).click();
      return observed;
    })
    .toBe(state);
  await readyForNavigation(page);
}
async function capture(page: Page, info: TestInfo, name: string) {
  const target = info.outputPath(name);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: target, fullPage: true });
  await info.attach(name, { path: target, contentType: "image/png" });
}
async function theme(root: Locator, preference: "dark" | "light") {
  await root.getByRole("button", { name: "Appearance settings", exact: true }).click();
  const dialog = root.getByRole("dialog", { name: "Appearance", exact: true });
  await dialog.getByLabel("Theme", { exact: true }).selectOption(preference);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(root.page().locator("html")).toHaveAttribute("data-theme", preference);
}
test("first-run profile/attach, retained scoped draft, actor switch, two-step prepare/apply and CLI readback", async ({
  page,
  companion,
  daemon,
  secondary,
  browserFailures,
  browserDiagnostics,
}, info) => {
  const root = await mount(page, companion);
  await connect(root, daemon.socket);
  await readyForNavigation(page);
  await root.locator(".wg-workspace-switch").click();
  const startupDialog = root.getByRole("dialog", { name: "Daemon connections" });
  await startupDialog
    .getByLabel("Registry directory on companion host", { exact: true })
    .fill(path.join(daemon.root, "unused-startup-registry"));
  await startupDialog
    .getByLabel("Private startup log on companion host", { exact: true })
    .fill(path.join(daemon.root, "startup.log"));
  await startupDialog.getByLabel("Startup timeout in seconds", { exact: true }).fill("4");
  await startupDialog.getByRole("button", { name: "Review startup plan", exact: true }).click();
  const startup = panel(startupDialog, "Captured startup plan");
  await expect(startup.locator(".wg-badge")).toHaveText("prepared unsent");
  await expect(startup.getByText(/Captured actor observer/u)).toBeVisible();
  await startup.getByRole("button", { name: "Start saved plan", exact: true }).click();
  await expect
    .poll(async () => {
      const state = await startup.locator(".wg-badge").textContent();
      if (state === "starting")
        await startup.getByRole("button", { name: "Inspect saved launch", exact: true }).click();
      return state;
    })
    .toBe("Existing endpoint observed ready");
  await expect(
    startup.getByText(/Readiness is historical and ownership is unknown/u),
  ).toBeVisible();
  await startupDialog
    .getByRole("button", { name: "Close Daemon connections", exact: true })
    .click();
  browserDiagnostics.markPendingReads();
  await selectDemo(page, root);
  browserDiagnostics.markPendingReads();
  await writer(root, "lifecycle-author", browserDiagnostics.markPendingReads);
  await root.getByRole("button", { name: "Create project", exact: true }).click();
  await root.getByLabel("ID (optional)", { exact: true }).fill("retained-project");
  await root
    .getByLabel("Title", { exact: true })
    .fill("Unsent exact text 雪 survives scope changes");
  await root
    .getByLabel("Description", { exact: true })
    .fill("Original captured workspace and actor remain effective.");
  await readyForNavigation(page);
  await root.locator(".wg-workspace-switch").click();
  const connections = root.getByRole("dialog", { name: "Daemon connections" });
  await connections.getByLabel("Profile ID", { exact: true }).fill("mirror");
  await connections.getByLabel("Connection label", { exact: true }).fill("Second saved endpoint");
  await connections
    .getByLabel("Unix socket on companion host", { exact: true })
    .fill(secondary.socket);
  browserDiagnostics.markPendingReads();
  browserDiagnostics.markPendingDirectoryReads();
  await connections.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(
    connections.getByRole("heading", { name: "Manage Second saved endpoint", exact: true }),
  ).toBeVisible();
  browserDiagnostics.markPendingReads();
  await connections.getByRole("button", { name: "Use this connection", exact: true }).click();
  await expect(
    root.getByRole("heading", { name: "Choose a workspace", exact: true }),
  ).toBeVisible();
  await openManagement(root);
  await expect(root.getByLabel("Title", { exact: true })).toHaveValue(
    "Unsent exact text 雪 survives scope changes",
  );
  await readyForNavigation(page);
  await root.locator(".wg-workspace-switch").click();
  browserDiagnostics.markPendingReads();
  await connections.getByRole("button", { name: "Disconnect selection", exact: true }).click();
  await expect(
    root.getByRole("button", { name: "Choose a connection", exact: true }),
  ).toBeVisible();
  await root.getByRole("button", { name: "Choose a connection", exact: true }).click();
  await secondary.call("daemon.health", "{}"); // Disconnect left the independently owned daemon running.
  const second = connections
    .locator("article")
    .filter({ has: page.getByText("Second saved endpoint", { exact: true }) });
  await second.getByRole("button", { name: "Use connection", exact: true }).click();
  await expect(
    root.getByRole("heading", { name: "Choose a workspace", exact: true }),
  ).toBeVisible();
  await openManagement(root);
  await expect(root.getByLabel("Title", { exact: true })).toHaveValue(
    "Unsent exact text 雪 survives scope changes",
  );
  await readyForNavigation(page);
  browserDiagnostics.markPendingReads();
  await writer(root, "different-current-actor", browserDiagnostics.markPendingReads);
  browserDiagnostics.markPendingReads();
  await page.evaluate(() => {
    window.location.hash = "#/overview?connection=mirror";
  });
  await expect(
    root.getByRole("heading", { name: "Choose a workspace", exact: true }),
  ).toBeVisible();
  await openManagement(root);
  await expect(
    root.getByRole("heading", { name: "Select a workspace", exact: true }),
  ).toBeVisible();
  await expect(root.getByLabel("Title", { exact: true })).toHaveValue(
    "Unsent exact text 雪 survives scope changes",
  );
  browserDiagnostics.markPendingReads();
  await selectDemo(page, root);
  await expect(root.getByText(/Draft captured actor/u)).toContainText("lifecycle-author");
  await expect(root.getByText(/Draft captured actor/u)).toContainText("demo");
  await expect(root.getByText(/Draft captured actor/u)).toContainText(
    "original endpoint Qualification daemon (generation 1)",
  );
  await theme(root, "dark");
  await root.getByLabel("Title", { exact: true }).scrollIntoViewIfNeeded();
  await capture(page, info, "connections-dark-retained.png");
  await apply(root, page, "project.create", "committed", false);
  const result = JSON.parse(
    await daemon.call("project.get", '{"workspace_id":"demo","project_id":"retained-project"}'),
  ) as { result: { data: { title: string } } };
  expect(result.result.data.title).toBe("Unsent exact text 雪 survives scope changes");
  const untouched = JSON.parse(
    await secondary.call("project.list", '{"workspace_id":"demo","offset":"0","limit":"100"}'),
  ) as { result: { data: { items: { project_id: string }[] } } };
  expect(untouched.result.data.items.some((item) => item.project_id === "retained-project")).toBe(
    false,
  );
  await expect(
    panel(root, "Review captured action").getByText("lifecycle-author", { exact: true }),
  ).toBeVisible();
  await root.getByRole("button", { name: "Close draft", exact: true }).click();
  await root.locator(".wg-workspace-switch").click();
  const primary = connections
    .locator("article")
    .filter({ has: page.getByText("Qualification daemon", { exact: true }) });
  browserDiagnostics.markPendingReads();
  await primary.getByRole("button", { name: "Use connection", exact: true }).click();
  await selectDemo(page, root);
  await panel(root, "Projects").getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    root.getByRole("button", { name: "Unsent exact text 雪 survives scope changes", exact: true }),
  ).toBeVisible();
  await theme(root, "light");
  await panel(root, "Projects").scrollIntoViewIfNeeded();
  await capture(page, info, "connections-light-projects.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, info, "connections-narrow.png");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  browserDiagnostics.markPendingReads();
  expect(browserFailures).toEqual([]);
});
test("workspace settings revision zero and explicit archive/close/open/unregister/register", async ({
  page,
  companion,
  daemon,
  browserFailures,
  browserDiagnostics,
}) => {
  const root = await mount(page, companion, daemon.socket);
  browserDiagnostics.markPendingReads();
  await writer(root, "workspace-author", browserDiagnostics.markPendingReads);
  await readyForNavigation(page);
  const row = root.getByRole("row").filter({
    has: root.page().getByRole("button", { name: "Synthetic UI qualification", exact: true }),
  });
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(root.getByLabel("Version being edited", { exact: true })).toHaveValue("0");
  await root.getByLabel("Workspace name", { exact: true }).fill("Lifecycle edited workspace");
  await root
    .getByLabel("Summary", { exact: true })
    .fill("Preserve unknown fields and use exact settings revision");
  await apply(root, page, "workspace.update");
  await root.getByRole("button", { name: "Close draft", exact: true }).click();
  await root.getByRole("button", { name: "Refresh registry", exact: true }).click();
  const edited = root.getByRole("row").filter({
    has: root.page().getByRole("button", { name: "Lifecycle edited workspace", exact: true }),
  });
  await expect(edited).toBeVisible();
  await edited.getByRole("button", { name: "Archive", exact: true }).click();
  await apply(root, page, "workspace.archive");
  await root.getByRole("button", { name: "Close draft", exact: true }).click();
  await edited.getByRole("button", { name: "Close", exact: true }).click();
  await apply(root, page, "workspace.close");
  await root.getByRole("button", { name: "Close draft", exact: true }).click();
  await root.getByRole("button", { name: "Refresh registry", exact: true }).click();
  await edited.getByRole("button", { name: "Open", exact: true }).click();
  await apply(root, page, "workspace.open");
  await root.getByRole("button", { name: "Close draft", exact: true }).click();
  await root.getByRole("button", { name: "Refresh registry", exact: true }).click();
  await edited.getByRole("button", { name: "Close", exact: true }).click();
  await apply(root, page, "workspace.close");
  await root.getByRole("button", { name: "Close draft", exact: true }).click();
  await root.getByRole("button", { name: "Refresh registry", exact: true }).click();
  await edited.getByRole("button", { name: "Unregister", exact: true }).click();
  await apply(root, page, "workspace.unregister");
  await root.getByRole("button", { name: "Close draft", exact: true }).click();
  await root.getByRole("button", { name: "Register existing", exact: true }).click();
  await root
    .getByLabel("Workspace folder", { exact: true })
    .fill(path.join(daemon.root, "workspace"));
  await apply(root, page, "workspace.register");
  const result = JSON.parse(await daemon.call("workspace.get", '{"workspace_id":"demo"}')) as {
    result: { data: { settings: { name: string; summary: string; archived: boolean } } };
  };
  expect(result.result.data.settings).toMatchObject({
    name: "Lifecycle edited workspace",
    summary: "Preserve unknown fields and use exact settings revision",
    archived: true,
  });
  browserDiagnostics.markPendingReads();
  expect(browserFailures).toEqual([]);
});
test("guard conflicts retain original request; milestone schedule/status and project completion use actual daemon gates", async ({
  page,
  companion,
  daemon,
  browserFailures,
  browserDiagnostics,
}) => {
  const root = await mount(page, companion, daemon.socket);
  browserDiagnostics.markPendingReads();
  await writer(root, "planning-author", browserDiagnostics.markPendingReads);
  await readyForNavigation(page);
  await root.getByRole("button", { name: "Create project", exact: true }).click();
  await root.getByLabel("ID (optional)", { exact: true }).fill("life-project");
  await root.getByLabel("Title", { exact: true }).fill("Lifecycle planning project");
  await apply(root, page, "project.create");
  await root.getByRole("button", { name: "Close draft", exact: true }).click();
  await panel(root, "Projects").getByRole("button", { name: "Refresh", exact: true }).click();
  const project = root
    .getByRole("row")
    .filter({ has: page.getByRole("button", { name: "Lifecycle planning project", exact: true }) });
  await project.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(root.getByLabel("Version being edited", { exact: true })).toHaveValue("1");
  await root
    .getByLabel("Title", { exact: true })
    .fill("Guarded UI edit must not replace concurrent edit");
  await daemon.call(
    "project.update",
    '{"workspace_id":"demo","project_id":"life-project","actor_id":"concurrent-author","mutation_id":"concurrent-project-edit","expected_revision":"1","title":"Concurrent project title"}',
  );
  await apply(root, page, "project.update", "rejected");
  await expect(root.getByLabel("Version being edited", { exact: true })).toHaveValue("1");
  await expect(
    panel(root, "Review captured action").getByRole("button", {
      name: "Execute saved request",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    panel(root, "Retained lifecycle actions").getByRole("button", {
      name: "project.update · rejected",
      exact: true,
    }),
  ).toHaveCount(1);
  await root.getByRole("button", { name: "Close draft", exact: true }).click();
  await root.getByRole("button", { name: "Create milestone", exact: true }).click();
  await root.getByLabel("ID (optional)", { exact: true }).fill("life-milestone");
  await root.getByLabel("Owning project ID", { exact: true }).fill("life-project");
  await root.getByLabel("Title", { exact: true }).fill("Lifecycle dated milestone");
  await root.getByLabel("Target date", { exact: true }).fill("2026-12-01");
  await apply(root, page, "milestone.create");
  await root.getByRole("button", { name: "Close draft", exact: true }).click();
  await panel(root, "Milestones").getByRole("button", { name: "Refresh", exact: true }).click();
  const milestone = root
    .getByRole("row")
    .filter({ has: page.getByRole("button", { name: "Lifecycle dated milestone", exact: true }) });
  await milestone.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(root.getByLabel("Target date", { exact: true })).toHaveValue("2026-12-01");
  await root.getByLabel("Target date", { exact: true }).fill("");
  await apply(root, page, "milestone.schedule");
  const cleared = JSON.parse(
    await daemon.call("milestone.get", '{"workspace_id":"demo","milestone_id":"life-milestone"}'),
  ) as { result: { data: { milestone: { target_date: null } } } };
  expect(cleared.result.data.milestone.target_date).toBeNull();
  await root.getByRole("button", { name: "Close draft", exact: true }).click();
  await milestone.getByRole("button", { name: "Edit / status", exact: true }).click();
  await root.getByLabel("Status", { exact: true }).selectOption("done");
  await apply(root, page, "milestone.update");
  await root.getByRole("button", { name: "Close draft", exact: true }).click();
  await panel(root, "Projects").getByRole("button", { name: "Refresh", exact: true }).click();
  const current = root
    .getByRole("row")
    .filter({ has: page.getByRole("button", { name: "Concurrent project title", exact: true }) });
  await current.getByRole("button", { name: "Readiness & finish", exact: true }).click();
  await expect(
    root.getByRole("heading", { name: "Observed project readiness", exact: true }),
  ).toBeVisible();
  await root
    .getByLabel("Completion evidence", { exact: true })
    .fill("Actual milestone complete and no open project tickets.");
  await root
    .getByLabel("Completion handoff summary", { exact: true })
    .fill("Validated lifecycle completion against real daemon.");
  await root.getByLabel("Handoff next steps", { exact: true }).fill("No remaining project work.");
  await apply(root, page, "project.finish");
  const finished = JSON.parse(
    await daemon.call("project.get", '{"workspace_id":"demo","project_id":"life-project"}'),
  ) as { result: { data: { status: string; title: string } } };
  expect(finished.result.data).toMatchObject({ status: "done", title: "Concurrent project title" });
  browserDiagnostics.markPendingReads();
  expect(browserFailures).toEqual([]);
});
test("UI workspace creation and explicit daemon shutdown remain distinct from browser disconnect", async ({
  page,
  companion,
  daemon,
  browserDiagnostics,
  browserFailures,
}) => {
  const root = await mount(page, companion, daemon.socket);
  await writer(root, "workspace-creator", browserDiagnostics.markPendingReads);
  await root.getByRole("button", { name: "Create workspace", exact: true }).click();
  await root.getByLabel("ID (optional)", { exact: true }).fill("created-ui");
  await root
    .getByLabel("Workspace name", { exact: true })
    .fill("Workspace created through actual UI");
  await root
    .getByLabel("Workspace folder", { exact: true })
    .fill(path.join(daemon.root, "created-workspace"));
  await apply(root, page, "workspace.create");
  const created = JSON.parse(
    await daemon.call("workspace.get", '{"workspace_id":"created-ui"}'),
  ) as { result: { data: { name: string; root: string } } };
  expect(created.result.data.name).toBe("Workspace created through actual UI");
  await root.getByRole("button", { name: "Close draft", exact: true }).click();
  await root.getByRole("button", { name: "Refresh registry", exact: true }).click();
  await expect(
    root.getByRole("button", { name: "Workspace created through actual UI", exact: true }),
  ).toBeVisible();
  await readyForNavigation(page);
  await root.locator(".wg-workspace-switch").click();
  const dialog = root.getByRole("dialog", { name: "Daemon connections" });
  await expect(dialog.getByText(/Disconnect changes the browser selection only/u)).toBeVisible();
  await dialog.getByRole("button", { name: "Review daemon shutdown", exact: true }).click();
  const shutdown = panel(dialog, "Review captured action");
  await expect(shutdown.locator(".wg-badge")).toHaveText("prepared_unsent");
  let executions = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/operations\/[^/]+\/execute$/u.test(new URL(request.url()).pathname)
    )
      executions++;
  });
  await shutdown.getByRole("button", { name: "Execute saved request", exact: true }).click();
  await expect
    .poll(async () => {
      const state = await shutdown.locator(".wg-badge").textContent();
      if (state === "sending")
        await shutdown.getByRole("button", { name: "Inspect saved action", exact: true }).click();
      return state;
    })
    .toBe("observed");
  await expect(shutdown.getByText(/ephemeral operation; no durable daemon receipt/u)).toBeVisible();
  expect(executions).toBe(1);
  // This checks endpoint reachability only. The owned daemon fixture confirms/reaps its own child during cleanup.
  await expect
    .poll(async () => {
      try {
        await daemon.call("daemon.health", "{}");
        return false;
      } catch {
        return true;
      }
    })
    .toBe(true);
  browserDiagnostics.markPendingReads();
  await dialog.getByRole("button", { name: "Disconnect selection", exact: true }).click();
  await expect(
    root.getByRole("button", { name: "Choose a connection", exact: true }),
  ).toBeVisible();
  expect(executions).toBe(1);
  expect(browserFailures).toEqual([]);
});

test("Connection sections retain profile drafts and captured startup plans across profile generations", async ({
  page,
  companion,
  daemon,
  secondary,
  browserFailures,
  browserDiagnostics,
}) => {
  await page.goto(companion.url);
  await page.locator(".wg-workspace-switch").click();
  const dialog = page.getByRole("dialog", { name: "Daemon connections", exact: true });
  await expect(
    dialog.getByRole("heading", { name: "Your first connection", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel("Profile ID", { exact: true })).toBeHidden();
  await dialog.getByRole("button", { name: "Startup history", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "No saved startup attempts on this page", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Previous page", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Offline tools", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "Local maintenance and recovery", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Migrate 0.6.2 workspace", exact: true }).click();
  await expect(
    dialog.getByRole("textbox", {
      name: "Stopped 0.6.2 workspace source on companion host",
      exact: true,
    }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Connections", exact: true }).click();
  await dialog.getByRole("button", { name: "Add connection", exact: true }).click();
  await dialog.getByLabel("Profile ID", { exact: true }).fill("local");
  await dialog.getByLabel("Connection label", { exact: true }).fill("Design daemon");
  await dialog.getByLabel("Unix socket on companion host", { exact: true }).fill(daemon.socket);
  await dialog.getByRole("button", { name: "Close Daemon connections", exact: true }).click();
  await page.locator(".wg-workspace-switch").click();
  await dialog.getByRole("button", { name: "Add connection", exact: true }).click();
  await expect(dialog.getByLabel("Connection label", { exact: true })).toHaveValue("Design daemon");
  await dialog.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "Manage Design daemon", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Attach & inspect capabilities", exact: true }).click();
  await expect(dialog.getByText("handshake observed", { exact: true })).toBeVisible();
  await dialog.getByText("Start a local daemon", { exact: true }).click();
  await dialog
    .getByLabel("Registry directory on companion host", { exact: true })
    .fill("/tmp/workgraph-ui-unstarted-design-registry");
  await dialog
    .getByLabel("Private startup log on companion host", { exact: true })
    .fill("/tmp/workgraph-ui-unstarted-design.log");
  await dialog.getByRole("button", { name: "Review startup plan", exact: true }).click();
  const plan = panel(dialog, "Captured startup plan");
  await expect(plan).toContainText("Design daemon · generation 1");
  await expect(plan.getByRole("button", { name: "Start saved plan", exact: true })).toBeEnabled();
  await plan.getByRole("button", { name: "Hide startup review", exact: true }).click();
  await expect(plan).toBeHidden();
  await dialog.getByRole("button", { name: "Show captured startup plan", exact: true }).click();
  await expect(plan).toBeVisible();
  await dialog.getByRole("button", { name: "Connections", exact: true }).click();
  await dialog.getByRole("button", { name: "Edit profile", exact: true }).click();
  await dialog.getByLabel("Connection label", { exact: true }).fill("Replacement endpoint");
  await dialog.getByLabel("Unix socket on companion host", { exact: true }).fill(secondary.socket);
  await dialog.getByRole("button", { name: "Save new generation", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "Manage Replacement endpoint", exact: true }),
  ).toBeVisible();
  await expect(plan).toContainText("Design daemon · generation 1");
  await dialog.getByRole("button", { name: "Attach & inspect capabilities", exact: true }).click();
  await expect(dialog.getByText("handshake observed", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Startup history", exact: true }).click();
  await dialog.getByRole("button", { name: "Refresh saved launches", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Design daemon · prepared unsent", exact: true })
    .click();
  await expect(plan).toBeVisible();
  await expect(plan).toContainText("Design daemon · generation 1");
  await dialog.getByRole("button", { name: "Connections", exact: true }).click();
  await dialog.getByRole("button", { name: "Add connection", exact: true }).click();
  await dialog.getByLabel("Profile ID", { exact: true }).fill("discard-this-draft");
  await dialog.getByRole("button", { name: "Discard profile draft", exact: true }).click();
  await expect(dialog.getByLabel("Profile ID", { exact: true })).toBeHidden();
  await dialog.getByRole("button", { name: "Add connection", exact: true }).click();
  await expect(dialog.getByLabel("Profile ID", { exact: true })).toHaveValue("");
  await dialog.getByRole("button", { name: /Back to connections/u }).click();
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(dialog.getByText("Replacement endpoint", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  browserDiagnostics.markPendingReads();
  await dialog.getByRole("button", { name: "Close Daemon connections", exact: true }).click();
  expect(browserFailures).toEqual([]);
});

test("Daemon shutdown review is explicit and disconnect leaves the daemon running", async ({
  page,
  companion,
  daemon,
  browserDiagnostics,
  browserFailures,
}) => {
  await page.goto(companion.url);
  await page.locator(".wg-workspace-switch").click();
  const dialog = page.getByRole("dialog", { name: "Daemon connections", exact: true });
  await dialog.getByRole("button", { name: "Add connection", exact: true }).click();
  await dialog.getByLabel("Profile ID", { exact: true }).fill("isolated");
  await dialog.getByLabel("Connection label", { exact: true }).fill("Isolated lifecycle test");
  await dialog.getByLabel("Unix socket on companion host", { exact: true }).fill(daemon.socket);
  await dialog.getByRole("button", { name: "Save profile", exact: true }).click();
  await dialog.getByRole("button", { name: "Use this connection", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.locator(".wg-workspace-switch").click();
  await dialog.getByRole("button", { name: "Manage", exact: true }).click();
  await dialog.getByText("Stop this daemon", { exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Review daemon shutdown", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Close Daemon connections", exact: true }).click();
  await writer(page.locator("#root"), "human", browserDiagnostics.markPendingReads);
  await page.locator(".wg-workspace-switch").click();
  await dialog.getByRole("button", { name: "Manage", exact: true }).click();
  await dialog.getByText("Stop this daemon", { exact: true }).click();
  await dialog.getByRole("button", { name: "Review daemon shutdown", exact: true }).click();
  const review = panel(dialog, "Review captured action");
  await expect(review.locator(".wg-badge")).toHaveText("prepared_unsent");
  await expect(review).toContainText("Original writer human");
  await review.getByRole("button", { name: "Hide review", exact: true }).click();
  await expect(review).toBeHidden();
  await dialog.getByRole("button", { name: /Show saved action review/u }).click();
  await expect(review).toBeVisible();
  let executions = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/operations\/[^/]+\/execute$/u.test(new URL(request.url()).pathname)
    )
      executions++;
  });
  browserDiagnostics.markPendingReads();
  await dialog.getByRole("button", { name: "Disconnect selection", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.locator(".wg-workspace-switch").click();
  await dialog
    .getByRole("button", { name: "Open captured startup or shutdown review", exact: true })
    .click();
  await expect(review.locator(".wg-badge")).toHaveText("prepared_unsent");
  expect(await daemon.call("daemon.health", "{}")).toContain('"result"');
  expect(executions).toBe(0);
  expect(browserFailures).toEqual([]);
});
