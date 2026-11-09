import { waitForPageReads } from "../../e2e/support/readiness";
import type { Locator, Page, TestInfo } from "@playwright/test";
import type { CompanionFixture } from "../../../../test-support/companion-fixture.mjs";
import type { DaemonFixture } from "../../../../test-support/daemon-fixture.mjs";
import { test, expect } from "../../e2e/support/fixtures";

test.use({ colorScheme: "dark", viewport: { width: 1600, height: 1050 }, actionTimeout: 10000 });
function writer(daemon: DaemonFixture) {
  let serial = 0;
  return async (method: string, params: Record<string, unknown>) =>
    JSON.parse(
      await daemon.call(
        method,
        JSON.stringify({
          workspace_id: "demo",
          actor_id: "fixture-author",
          mutation_id: `graph-browser-${++serial}`,
          ...params,
        }),
      ),
    ) as { result: { data: Record<string, unknown> } };
}
interface Ticket {
  readonly ticket_id: string;
  readonly display_key: string;
  readonly title: string;
  readonly revision: string;
  readonly project_id: string | null;
  readonly milestone_id: string | null;
  readonly parent_ticket_id: string | null;
  readonly prerequisite_ticket_ids: readonly string[];
  readonly related_ticket_ids: readonly string[];
  readonly waivers: readonly { readonly prerequisite_ticket_id: string; readonly reason: string }[];
}
async function read(daemon: DaemonFixture, id: string): Promise<Ticket> {
  // Fixed synthetic native ticket envelope only; arbitrary production content stays lossless.
  return (
    JSON.parse(
      await daemon.call(
        "ticket.read",
        JSON.stringify({ workspace_id: "demo", ticket_id: id, max_bytes: "1048576" }),
      ),
    ) as { result: { data: { ticket: Ticket } } }
  ).result.data.ticket;
}
async function actor(page: Page, id: string) {
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill(id);
  await page.getByLabel("Run ID (optional)", { exact: true }).fill("");
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  await waitForPageReads(page);
}
async function settle(page: Page) {
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /^Loading (ticket|graph|hierarchy|expanded|display)/u }),
  ).toHaveCount(0);
  await waitForPageReads(page);
}
async function refresh(page: Page) {
  await settle(page);
  await page.getByRole("button", { name: "Refresh graph", exact: true }).click();
  await settle(page);
}
async function mount(page: Page, companion: CompanionFixture, daemon: DaemonFixture) {
  const response = await page.request.get(companion.url),
    matches = [
      ...(await response.text()).matchAll(
        /<meta name="workgraph-capability" content="([a-f0-9]{64})"/gu,
      ),
    ],
    capability = matches[0]?.[1];
  expect(response.status()).toBe(200);
  if (matches.length !== 1 || !capability) throw new Error("Missing native capability");
  for (const [path, body] of [
    ["/connections", { id: "local", label: "Synthetic workflow graph", socket: daemon.socket }],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const result = await page.request.post(new URL(`/ui-api/v1${path}`, companion.url).href, {
      headers: { "X-Workgraph-UI-Capability": capability, Origin: new URL(companion.url).origin },
      data: body,
    });
    expect(result.status()).toBe(200);
    await result.text();
  }
  await page.goto(
    new URL("/#/workflow?connection=local&workspace=demo&project=release", companion.url).href,
  );
  await expect(
    page.getByRole("region", { name: "Workflow graph canvas", exact: true }),
  ).toBeVisible();
  await settle(page);
  await actor(page, "fixture-author");
}
async function select(page: Page, ticket: Ticket) {
  await page
    .getByRole("button", { name: `Select ${ticket.display_key}: ${ticket.title}`, exact: true })
    .click();
  await page
    .getByRole("button", { name: `Open ticket ${ticket.display_key}`, exact: true })
    .click();
  await expect(
    page.locator(".wg-inspector-header").getByRole("heading", { name: ticket.title, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Selected ticket actions", exact: true }),
  ).toBeVisible();
  await settle(page);
  expect(new URL(page.url()).hash).toContain("/workflow?");
}
async function reveal(field: Locator) {
  await expect(field).toBeAttached();
  while (!(await field.isVisible())) {
    const closed = field.locator("xpath=ancestor::details[not(@open)]").first();
    if ((await closed.count()) === 0) throw new Error("Control is hidden outside a disclosure.");
    await closed.locator(":scope > summary").click();
  }
}
async function set(dialog: Locator, label: string, value: string | null) {
  const presence = dialog.getByLabel(`${label} update`, { exact: true });
  if (await presence.count()) {
    await reveal(presence);
    await presence.selectOption(value === null ? "null" : "value");
  }
  if (value !== null) {
    const field = dialog.getByLabel(label, { exact: true });
    await reveal(field);
    await field.fill(value);
  }
}
async function capture(dialog: Locator) {
  await dialog.getByRole("button", { name: "Review action", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply action", exact: true })).toBeEnabled();
}
async function execute(dialog: Locator, expected = "committed") {
  await capture(dialog);
  await expect(dialog.getByRole("button", { name: "Apply action", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Apply action", exact: true }).click();
  await expect(
    dialog.getByRole("status").filter({ hasText: new RegExp(`^${expected}$`, "u") }),
  ).toBeVisible();
}
async function close(page: Page, dialog: Locator) {
  await dialog
    .getByRole("button", { name: "Close editor; keep captured intention", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await refresh(page);
}
async function relation(page: Page, kind: string, from: string, to: string, title: string) {
  await page.getByRole("button", { name: "Add relation", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Add relationship", exact: true });
  await sheet.getByLabel("Relationship kind", { exact: true }).selectOption(kind);
  await sheet.locator("select").nth(1).selectOption(from);
  await sheet.locator("select").nth(2).selectOption(to);
  await sheet.getByRole("button", { name: "Review relationship", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(name);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: "image/png" });
}

test("native atomic gated plan receipt projects actual IDs into graph and shared inspector", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const operations = [
    {
      method: "actor.put",
      params: {
        target_actor_id: "fixture-author",
        expected_revision: "0",
        kind: "agent",
        name: "Synthetic plan author",
      },
    },
    {
      method: "ticket.create",
      params: {
        ticket_id: "atomic-parent",
        project_id: "release",
        title: "Synthetic coherent parent",
      },
    },
    {
      method: "ticket.create",
      params: {
        ticket_id: "atomic-design",
        project_id: "release",
        parent_ticket_id: "atomic-parent",
        title: "Synthetic coherent Design",
      },
    },
    {
      method: "ticket.create",
      params: {
        ticket_id: "atomic-build",
        project_id: "release",
        parent_ticket_id: "atomic-parent",
        title: "Synthetic coherent Build",
      },
    },
    {
      method: "dependency.add",
      params: { ticket_id: "atomic-build", prerequisite_id: "atomic-design" },
    },
    {
      method: "allocation.ticket_policy_put",
      params: {
        ticket_id: "atomic-build",
        expected_revision: "0",
        required_capabilities: ["synthetic-build"],
        allowed_actor_ids: ["fixture-author"],
        pools: [],
      },
    },
  ];
  const preview = JSON.parse(
    await daemon.call(
      "transaction.preflight",
      JSON.stringify({ workspace_id: "demo", actor_id: "fixture-author", operations }),
    ),
  ) as { result: { data: { operation_count: string; validation: string } } };
  expect(preview.result.data.operation_count).toBe("6");
  expect(preview.result.data.validation).toBe("domain_preparation");
  const receipt = await writer(daemon)("transaction.apply", { operations });
  expect(receipt.result.data.results).toHaveLength(6);
  await info.attach("atomic-plan-preview-and-receipt", {
    contentType: "application/json",
    body: JSON.stringify({ preview, receipt }),
  });
  await mount(page, companion, daemon);
  await screenshot(page, info, "graph-initial-dark.png");
  await select(page, await read(daemon, "atomic-build"));
  await expect(page.locator(".graph-node--selected")).toContainText("Synthetic coherent Build");
  await expect(
    page.locator('.graph-relationships tr[data-relation-kind="prerequisite"]'),
  ).toContainText("atomic-design");
  await expect(
    page.locator('.graph-relationships tr[data-relation-kind="hierarchy"]'),
  ).toContainText("atomic-parent");
  await expect(page.locator(".work-ticket-inspector")).toContainText("Graph readiness");
  await screenshot(page, info, "graph-atomic-plan-dark.png");
  expect(browserFailures).toEqual([]);
});

test("native graph meanings, cross-project boundaries, local layers and shared inspector", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  await write("ticket.create", {
    ticket_id: "parent",
    project_id: "release",
    title: "Synthetic workflow parent",
  });
  await write("ticket.move", {
    ticket_id: "build",
    expected_revision: (await read(daemon, "build")).revision,
    project_id: "release",
    milestone_id: null,
    parent_ticket_id: "parent",
  });
  await write("related.add", {
    ticket_id: "build",
    related_id: "review",
    expected_revision: (await read(daemon, "build")).revision,
    related_expected_revision: (await read(daemon, "review")).revision,
  });
  await write("project.create", { project_id: "external", title: "Synthetic partner project" });
  await write("ticket.create", {
    ticket_id: "external-source",
    project_id: "external",
    title: "Synthetic cross-project prerequisite",
  });
  await write("dependency.add", { ticket_id: "build", prerequisite_id: "external-source" });
  await mount(page, companion, daemon);
  await expect(page.locator(".graph-edge--prerequisite")).toHaveCount(3);
  await expect(page.locator(".graph-edge--hierarchy")).toHaveCount(1);
  await expect(page.locator(".graph-edge--related")).toHaveCount(0);
  await reveal(page.getByLabel("Related", { exact: true }));
  await page.getByLabel("Related", { exact: true }).check();
  await expect(page.locator(".graph-edge--related")).toHaveCount(1);
  await select(page, await read(daemon, "build"));
  await expect(page.getByText("1 prerequisites outside this query", { exact: true })).toBeVisible();
  await expect(
    page.locator('.graph-relationships tr[data-relation-kind="hierarchy"]'),
  ).toContainText("no implicit prerequisite");
  await page
    .getByRole("button", { name: "Select external-source: outside captured view", exact: true })
    .click();
  await page.getByRole("button", { name: "Open ticket external-source", exact: true }).click();
  await expect(page.locator(".wg-inspector-header")).toContainText(
    "Synthetic cross-project prerequisite",
  );
  await settle(page);
  await expect(page.locator(".graph-node--selected")).toContainText("external");
  expect(new URL(page.url()).hash).toContain("project=release");
  await page.getByRole("button", { name: "Zoom to selection", exact: true }).click();
  await page.getByLabel("Focus trace", { exact: true }).selectOption("downstream");
  await screenshot(page, info, "graph-cross-project-dark.png");
  expect(browserFailures).toEqual([]);
});

test("native relationship keyboard forms keep related cycles informational and exact endpoint guards", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  await mount(page, companion, daemon);
  let dialog = await relation(page, "related", "design", "build", "Link related ticket");
  await dialog.getByRole("button", { name: "Load referenced record", exact: true }).click();
  await reveal(dialog.getByText("Exact loaded reference", { exact: true }));
  await expect(dialog.getByText("Exact loaded reference", { exact: true })).toBeVisible();
  await execute(dialog);
  await close(page, dialog);
  dialog = await relation(page, "related", "build", "review", "Link related ticket");
  await dialog.getByRole("button", { name: "Load referenced record", exact: true }).click();
  await reveal(dialog.getByText("Exact loaded reference", { exact: true }));
  await expect(dialog.getByText("Exact loaded reference", { exact: true })).toBeVisible();
  await execute(dialog);
  await close(page, dialog);
  dialog = await relation(page, "related", "review", "design", "Link related ticket");
  await dialog.getByRole("button", { name: "Load referenced record", exact: true }).click();
  await reveal(dialog.getByText("Exact loaded reference", { exact: true }));
  await expect(dialog.getByText("Exact loaded reference", { exact: true })).toBeVisible();
  await execute(dialog);
  await close(page, dialog);
  expect((await read(daemon, "review")).related_ticket_ids).toContain("design");
  await page.getByRole("button", { name: "Relationships", exact: true }).first().click();
  await reveal(page.getByLabel("All loaded tickets", { exact: true }));
  await page.getByLabel("All loaded tickets", { exact: true }).check();
  await expect(page.locator('.graph-relationships tr[data-relation-kind="related"]')).toHaveCount(
    3,
  );
  await expect(
    page.locator('.graph-relationships tr[data-relation-kind="related"]').first(),
  ).toContainText("no readiness effect");
  await screenshot(page, info, "graph-keyboard-relations-dark.png");
  expect(browserFailures).toEqual([]);
});

test("native inherited source policy, cycle rejection and source waiver preserve reviewed draft", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  await write("ticket.create", {
    ticket_id: "umbrella",
    project_id: "release",
    title: "Synthetic inherited source",
  });
  await write("dependency.add", { ticket_id: "umbrella", prerequisite_id: "design" });
  await write("ticket.hierarchy.put", {
    ticket_id: "umbrella",
    expected_revision: "0",
    descendant_prerequisites: "inherit",
    child_completion: "all_done",
    reason: "Synthetic source inheritance",
  });
  await write("ticket.create", {
    ticket_id: "child",
    project_id: "release",
    parent_ticket_id: "umbrella",
    title: "Synthetic inherited dependent",
  });
  await mount(page, companion, daemon);
  await page.locator(".graph-inheritance summary").click();
  await page.getByRole("button", { name: "Capture policy umbrella", exact: true }).click();
  await settle(page);
  await expect(page.locator(".graph-edge--inherited")).toHaveCount(1);
  let dialog = await relation(page, "prerequisite", "child", "design", "Add prerequisite");
  await execute(dialog, "rejected");
  await expect(dialog).toContainText("Dependency_cycle");
  await expect(dialog.getByLabel("Prerequisite ticket ID", { exact: true })).toHaveValue("child");
  expect((await read(daemon, "design")).prerequisite_ticket_ids).not.toContain("child");
  await screenshot(page, info, "graph-inherited-cycle-rejected-dark.png");
  await close(page, dialog);
  await select(page, await read(daemon, "child"));
  await page.getByRole("button", { name: "Capture policy umbrella", exact: true }).click();
  await settle(page);
  const inherited = page.locator('.graph-relationships tr[data-relation-kind="inherited"]');
  const source = await read(daemon, "umbrella");
  await expect(
    inherited.locator("td").nth(3).getByRole("button", { name: source.display_key, exact: true }),
  ).toBeVisible();
  await inherited.getByRole("button", { name: "Review source waiver", exact: true }).click();
  dialog = page.getByRole("dialog", {
    name: "Waive or restore prerequisite blocking",
    exact: true,
  });
  await expect(dialog.locator(".work-action-provenance")).toContainText("umbrella");
  await set(dialog, "Reason", "Synthetic explicit source waiver");
  await execute(dialog);
  await close(page, dialog);
  expect((await read(daemon, "umbrella")).waivers[0]?.reason).toBe(
    "Synthetic explicit source waiver",
  );
  expect((await read(daemon, "child")).waivers).toEqual([]);
  expect(browserFailures).toEqual([]);
});

test("native subtree move previews placement effects and preserves atomic descendants", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  await write("project.create", { project_id: "destination", title: "Synthetic destination" });
  await write("ticket.create", {
    ticket_id: "child",
    project_id: "release",
    parent_ticket_id: "build",
    title: "Synthetic child subtree",
  });
  await mount(page, companion, daemon);
  await select(page, await read(daemon, "build"));
  await expect(page.locator(".graph-selected-context")).toContainText("2 loaded subtree records");
  await page.getByRole("button", { name: "Review moving subtree", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Move ticket and descendants", exact: true });
  await set(dialog, "Destination project", "destination");
  await set(dialog, "Destination milestone", null);
  await set(dialog, "Destination parent", null);
  await execute(dialog);
  expect((await read(daemon, "build")).project_id).toBe("destination");
  expect((await read(daemon, "child")).project_id).toBe("destination");
  expect((await read(daemon, "child")).milestone_id).toBeNull();
  await screenshot(page, info, "graph-subtree-move-dark.png");
  await close(page, dialog);
  expect(browserFailures).toEqual([]);
});

test("native graph relationship draft and connection gesture remain bound through actor switch and same-ID refresh", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  await mount(page, companion, daemon);
  await page.getByRole("button", { name: "Add relation", exact: true }).click();
  let sheet = page.getByRole("dialog", { name: "Add relationship", exact: true });
  await sheet.getByLabel("Prerequisite", { exact: true }).selectOption("design");
  await sheet
    .getByLabel("Dependent · waits for prerequisite", { exact: true })
    .selectOption("review");
  await sheet.getByRole("button", { name: "Hide; keep relationship draft", exact: true }).click();
  await actor(page, "other-actor");
  await write("ticket.metadata", {
    ticket_id: "review",
    expected_revision: (await read(daemon, "review")).revision,
    priority: "1",
  });
  await refresh(page);
  await page.getByRole("button", { name: "Resume relationship draft", exact: true }).click();
  sheet = page.getByRole("dialog", { name: "Add relationship", exact: true });
  await expect(sheet).toContainText("Captured fixture-author");
  await expect(sheet).toContainText("current capture, actor or scope differs");
  await sheet.getByRole("button", { name: "Review relationship", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add prerequisite", exact: true });
  await expect(dialog.locator(".work-action-provenance")).toContainText("fixture-author");
  await expect(dialog.getByLabel("Prerequisite ticket ID", { exact: true })).toHaveValue("design");
  await dialog.getByRole("button", { name: "Discard unsent draft", exact: true }).click();
  const design = await read(daemon, "design"),
    review = await read(daemon, "review");
  await page
    .getByRole("button", { name: `Connect from ${design.display_key}`, exact: true })
    .click();
  await refresh(page);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Connection gesture belongs to an earlier capture" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: `Waits for source: ${review.display_key}`, exact: true })
    .click();
  await expect(page.getByRole("dialog", { name: "Add relationship", exact: true })).toHaveCount(0);
  await screenshot(page, info, "graph-retained-writer-gesture-dark.png");
  expect(browserFailures).toEqual([]);
});

test("native long and paged graph preserves 50 off-view relations, keyboard table and selected trace beyond200", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  test.setTimeout(120000);
  const write = writer(daemon);
  const longTitle =
    "Synthetic Northstar ownership and implementation checkpoint with a complete title that must remain readable through narrow layouts, captured prerequisites and exact source inspection — 雪";
  for (let index = 0; index < 205; index++)
    await write("ticket.create", {
      ticket_id: `busy-${index}`,
      project_id: "release",
      title:
        index === 204 ? longTitle : `Synthetic busy workflow ${String(index).padStart(3, "0")}`,
    });
  for (let index = 0; index < 50; index++)
    await write("dependency.add", { ticket_id: "busy-204", prerequisite_id: `busy-${index}` });
  await mount(page, companion, daemon);
  await reveal(page.getByText("Partial query capture", { exact: true }));
  await expect(page.getByText("Partial query capture", { exact: true })).toBeVisible();
  while (
    await page.getByRole("button", { name: "Load next captured page", exact: true }).isEnabled()
  ) {
    await page.getByRole("button", { name: "Load next captured page", exact: true }).click();
    await settle(page);
  }
  await expect(page.locator(".graph-node")).toHaveCount(200);
  const last = await read(daemon, "busy-204");
  await reveal(page.getByLabel("Jump to display key", { exact: true }));
  await page.getByLabel("Jump to display key", { exact: true }).fill(last.display_key);
  await page.getByRole("button", { name: "Resolve ticket", exact: true }).click();
  await expect(page.locator(".graph-node--selected")).toContainText(longTitle);
  await settle(page);
  const selectedNode = page.locator(".graph-node--selected"),
    beforeX = await selectedNode.evaluate((node) =>
      Number.parseFloat((node as HTMLElement).style.left),
    );
  await selectedNode
    .getByRole("button", { name: `Select ${last.display_key}: ${last.title}`, exact: true })
    .press("Alt+ArrowRight");
  await expect
    .poll(() =>
      selectedNode.evaluate((node) => Number.parseFloat((node as HTMLElement).style.left)),
    )
    .toBe(beforeX + 24);
  expect((await read(daemon, "busy-204")).revision).toBe(last.revision);
  await expect(
    page.locator('.graph-relationships tr[data-relation-kind="prerequisite"]'),
  ).toHaveCount(50);
  await reveal(page.getByLabel("Filter graph tickets", { exact: true }));
  await page
    .getByLabel("Filter graph tickets", { exact: true })
    .fill("Synthetic Northstar ownership");
  await page.getByRole("button", { name: "Apply graph query", exact: true }).click();
  await settle(page);
  await expect(
    page.getByText("50 prerequisites outside this query", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.getByRole("button", { name: "Appearance settings", exact: true }).click();
  await page.getByLabel("Theme", { exact: true }).selectOption("light");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await screenshot(page, info, "graph-long-partial-light.png");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(browserFailures).toEqual([]);
});
