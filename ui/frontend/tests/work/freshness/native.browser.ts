import { test, expect } from "../../e2e/support/fixtures";
import type { Locator, Page, TestInfo } from "@playwright/test";
import type { CompanionFixture } from "../../../../test-support/companion-fixture.mjs";
import type { DaemonFixture } from "../../../../test-support/daemon-fixture.mjs";
import { startDaemonFixture, fixtureBinary } from "../../../../test-support/daemon-fixture.mjs";
test.use({ colorScheme: "dark", viewport: { width: 1440, height: 1000 }, actionTimeout: 10000 });
async function configure(
  page: Page,
  companion: CompanionFixture,
  daemon: DaemonFixture,
  project = "release",
  entity = "design",
) {
  const bootstrap = await page.request.get(companion.url);
  expect(bootstrap.status()).toBe(200);
  const capability = (await bootstrap.text()).match(
    /<meta name="workgraph-capability" content="([a-f0-9]{64})"/u,
  )?.[1];
  if (!capability) throw new Error("Missing capability");
  const headers = {
    "X-Workgraph-UI-Capability": capability,
    Origin: new URL(companion.url).origin,
  };
  for (const [path, data] of [
    ["/connections", { id: "local", label: "Original endpoint", socket: daemon.socket }],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const reply = await page.request.post(new URL("/ui-api/v1" + path, companion.url).href, {
      headers,
      data,
    });
    expect(reply.status()).toBe(200);
    await reply.text();
  }
  await page.goto(
    new URL(
      `/#/work?connection=local&workspace=demo&project=${project}${entity ? `&entity=${entity}` : ""}`,
      companion.url,
    ).href,
  );
  await expect(page.getByRole("heading", { name: "Tickets", exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await actor(page, "fixture-author");
  return headers;
}
let serial = 0;
async function write(daemon: DaemonFixture, method: string, params: Record<string, unknown>) {
  return daemon.call(
    method,
    JSON.stringify({
      workspace_id: "demo",
      actor_id: "fixture-author",
      mutation_id: `freshness-${++serial}`,
      ...params,
    }),
  );
}
async function read(daemon: DaemonFixture, ticket_id: string) {
  return (
    JSON.parse(
      await daemon.call(
        "ticket.read",
        JSON.stringify({ workspace_id: "demo", ticket_id, max_bytes: "1048576" }),
      ),
    ) as {
      result: {
        data: {
          ticket: {
            ticket_id: string;
            title: string;
            revision: string;
            status: string;
            claim: { actor_id: string; run_id: string | null } | null;
            prerequisite_ticket_ids: string[];
          };
        };
      };
    }
  ).result.data.ticket;
}
async function commit(dialog: Locator) {
  await dialog.getByRole("button", { name: "Review action", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply action", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Apply action", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: /^committed$/u })).toBeVisible();
}
async function create(page: Page, id: string, title: string) {
  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create ticket", exact: true });
  await set(dialog, "Ticket ID (optional)", id, true);
  await set(dialog, "Title", title);
  await set(dialog, "Description", "Original instructions — 雪\nKeep trailing LF.\n");
  await commit(dialog);
  return dialog;
}
async function close(dialog: Locator) {
  await dialog
    .getByRole("button", { name: "Close editor; keep captured intention", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(dialog.page().getByRole("dialog")).toHaveCount(0);
}
async function shot(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.getElementById("wg-content")?.scrollTo(0, 0);
  });
  const path = info.outputPath(name);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: "image/png" });
}
async function actor(page: Page, id: string, run = "") {
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill(id);
  await page.getByLabel("Run ID (optional)", { exact: true }).fill(run);
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  await page.waitForLoadState("networkidle");
}
async function reveal(field: Locator) {
  await expect(field).toBeAttached();
  while (!(await field.isVisible())) {
    const closed = field.locator("xpath=ancestor::details[not(@open)]").first();
    if ((await closed.count()) === 0) throw new Error("Control is hidden outside a disclosure.");
    await closed.locator(":scope > summary").click();
  }
}
async function set(
  dialog: Locator,
  label: string,
  value: string | null,
  optional = false,
  select = false,
) {
  if (
    optional ||
    value === null ||
    (await dialog.getByLabel(`${label} update`, { exact: true }).count()) > 0
  ) {
    const presence = dialog.getByLabel(`${label} update`, { exact: true });
    await reveal(presence);
    await presence.selectOption(value === null ? "null" : "value");
  }
  if (value !== null) {
    const field = dialog.getByLabel(label, { exact: true });
    await reveal(field);
    if (select) await field.selectOption(value);
    else await field.fill(value);
  }
}

test("newly created ticket opens the original actionable inspector; Start and nearby Progress/Review use that target", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  await write(daemon, "project.create", { project_id: "fresh", title: "Fresh empty project" });
  await configure(page, companion, daemon, "fresh", "");
  await expect(
    page.getByRole("heading", { name: "No tickets match this query", exact: true }),
  ).toBeVisible();
  const dialog = await create(page, "fresh-created", "Created through the real Work UI");
  const link = dialog.getByRole("link", { name: "Open created ticket", exact: true });
  const href = await link.getAttribute("href");
  expect(href).toContain("work_generation=1");
  expect(href).toContain("work_socket=");
  await link.click();
  await expect(
    page
      .locator(".wg-inspector-header")
      .getByRole("heading", { name: "Created through the real Work UI", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("article", { name: "Recorded ticket target" })).toHaveCount(0);
  await page.getByRole("button", { name: "Who can work", exact: true }).click();
  await page.getByRole("button", { name: "Start work", exact: true }).click();
  const start = page.getByRole("dialog", { name: "Start work", exact: true });
  await expect(start).toContainText("Created through the real Work UI");
  await commit(start);
  await close(start);
  expect((await read(daemon, "fresh-created")).claim?.actor_id).toBe("fixture-author");
  await expect(
    page.locator(".work-properties").getByText("Unclaimed", { exact: true }),
  ).toBeVisible();
  // Closing Start does not reopen Create, and its exact committed intention remains inspectable.
  await expect(
    page.getByLabel("Open editor", { exact: true }).getByRole("option", { name: /Create ticket/u }),
  ).toHaveCount(1);
  const prior = page
    .getByLabel("Captured intention", { exact: true })
    .getByRole("option", { name: /^ticket\.create · committed/u });
  const priorId = await prior.getAttribute("value");
  if (priorId === null) throw new Error("Committed create was lost");
  await page.getByLabel("Captured intention", { exact: true }).selectOption(priorId);
  const retained = page.getByRole("dialog", { name: "Captured ticket intention", exact: true });
  await expect(retained.getByRole("status").filter({ hasText: /^committed$/u })).toBeVisible();
  await retained
    .getByRole("button", { name: "Close Captured ticket intention", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({ hasText: "This captured view predates your saved action" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Refresh affected records", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "This captured view predates your saved action" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Progress and handoff", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Progress and handoff", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Completion", exact: true }).click();
  await page.getByRole("button", { name: "Open review and evidence", exact: true }).click();
  await expect
    .poll(() => new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("work_generation"))
    .toBe("1");
  expect(new URL(page.url()).hash).toContain("/workflow?");
  await page.waitForLoadState("networkidle");
  await shot(page, info, "created-actionable-workflow.png");
  expect(browserFailures).toEqual([]);
});
test("own create and dependency commits mark old captures until explicit refresh without automatic writes or rebase", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  await write(daemon, "project.create", { project_id: "fresh", title: "Fresh empty project" });
  await configure(page, companion, daemon, "fresh", "");
  const created = await create(page, "fresh-stale", "Retained empty capture becomes stale");
  await close(created);
  const warning = page
    .getByRole("status")
    .filter({ hasText: "This captured view predates your saved action" });
  await expect(warning).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "No tickets match this query", exact: true }),
  ).toBeVisible();
  await shot(page, info, "own-write-stale-empty-capture.png");
  await page.getByRole("button", { name: "Refresh affected records", exact: true }).click();
  await expect(warning).toHaveCount(0);
  await page
    .locator(".work-ticket")
    .filter({ hasText: "Retained empty capture becomes stale" })
    .click();
  await page.getByRole("button", { name: "Who can work", exact: true }).click();
  await expect(
    page.locator(".work-ticket-inspector").getByText("Graph ready", { exact: true }),
  ).not.toHaveCount(0);
  await page.getByLabel("Action group", { exact: true }).selectOption("relationships");
  await page.getByLabel("Ticket action", { exact: true }).selectOption("dependency.add");
  await page.getByRole("button", { name: "Open action form", exact: true }).click();
  const dependency = page.getByRole("dialog", { name: "Add prerequisite", exact: true });
  await set(dependency, "Prerequisite ticket ID", "build");
  await commit(dependency);
  await close(dependency);
  expect((await read(daemon, "fresh-stale")).prerequisite_ticket_ids).toContain("build");
  await expect(warning).toBeVisible();
  await expect(
    page.locator(".work-ticket-inspector").getByText("Graph ready", { exact: true }),
  ).not.toHaveCount(0);
  const before = await read(daemon, "fresh-stale");
  await page.getByRole("button", { name: "Refresh affected records", exact: true }).click();
  await expect(warning).toHaveCount(0);
  expect(await read(daemon, "fresh-stale")).toEqual(before);
  await expect(
    page.locator(".work-ticket-inspector").getByText("Blocked", { exact: true }),
  ).not.toHaveCount(0);
  await page.getByRole("button", { name: "Links", exact: true }).click();
  await expect(page.locator(".work-ticket-inspector")).toContainText("build");
  await page.waitForLoadState("networkidle");
  await shot(page, info, "explicitly-refreshed-dependency.png");
  expect(browserFailures).toEqual([]);
});
test("saved post-create link survives profile retarget and reload without reading or editing a repeated replacement ID", async ({
  page,
  daemon,
  companion,
  browserFailures,
  browserDiagnostics,
}, info) => {
  const headers = await configure(page, companion, daemon);
  const created = await create(page, "fresh-repeat", "Original endpoint created ticket");
  const second = await startDaemonFixture({ binary: fixtureBinary() });
  try {
    await write(second, "ticket.create", {
      ticket_id: "fresh-repeat",
      project_id: "release",
      title: "Replacement repeated ticket",
    });
    const beforeOriginal = await read(daemon, "fresh-repeat"),
      beforeReplacement = await read(second, "fresh-repeat");
    const changed = await page.request.put(
      new URL("/ui-api/v1/connections/local", companion.url).href,
      {
        headers,
        data: { expected_generation: "1", label: "Replacement endpoint", socket: second.socket },
      },
    );
    expect(changed.status()).toBe(200);
    await changed.text();
    // The shell refresh is outside the modal; retain editor then reopen its exact saved intention.
    const href = await created
      .getByRole("link", { name: "Open created ticket", exact: true })
      .getAttribute("href");
    if (href === null) throw new Error("No original saved destination");
    await close(created);
    browserDiagnostics.markPendingDirectoryReads();
    browserDiagnostics.markPendingReads();
    await page.getByRole("button", { name: "Refresh connection", exact: true }).click();
    await expect(
      page.getByText("Replacement endpoint · generation 2", { exact: true }),
    ).toBeVisible();
    await page.waitForLoadState("networkidle");
    const reads: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/ui-api/v1/read")) reads.push(request.postData() ?? "");
    });
    await page.goto(new URL(href, companion.url).href);
    const blocked = page.getByRole("heading", {
      name: "Original workbench endpoint is not current",
      exact: true,
    });
    await expect(blocked).toBeVisible();
    await expect(page.getByRole("button", { name: "Start work", exact: true })).toHaveCount(0);
    await page.reload();
    await expect(blocked).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(
      reads.filter((value) => value.includes("ticket.") || value.includes("transaction.")),
    ).toEqual([]);
    await page.getByRole("link", { name: "View original ticket read-only", exact: true }).click();
    await expect(page.getByRole("article", { name: "Recorded ticket target" })).toContainText(
      "Original endpoint created ticket",
    );
    await expect(page.getByText("Replacement repeated ticket", { exact: true })).toHaveCount(0);
    expect(await read(daemon, "fresh-repeat")).toEqual(beforeOriginal);
    expect(await read(second, "fresh-repeat")).toEqual(beforeReplacement);
    await page.waitForLoadState("networkidle");
    await shot(page, info, "retarget-original-read-only.png");
    expect(browserFailures).toEqual([]);
  } finally {
    try {
      await second.dispose();
    } finally {
      await info.attach("replacement-daemon-disposed", {
        body: JSON.stringify(second.diagnostics()),
        contentType: "application/json",
      });
    }
  }
});
