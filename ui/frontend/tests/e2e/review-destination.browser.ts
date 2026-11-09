import { waitForPageReads } from "./support/readiness";
import path from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect } from "./support/fixtures";
import type { CompanionFixture } from "../../../test-support/companion-fixture.mjs";
import type { DaemonFixture } from "../../../test-support/daemon-fixture.mjs";
import { jsonField, parseJsonText, type JsonValue } from "../../src/core/json";
function field(value: JsonValue, name: string): JsonValue {
  const found = jsonField(value, name);
  if (found === undefined) throw new Error(`Missing ${name}`);
  return found;
}
function decoded(source: string): JsonValue {
  const parsed = parseJsonText(source);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value.value;
}
async function workspace(daemon: DaemonFixture, id: string) {
  const raw = await daemon.call("workspace.get", JSON.stringify({ workspace_id: id }));
  const data = field(field(decoded(raw), "result"), "data");
  const name = field(data, "name");
  if (name.kind !== "string") throw new Error("Invalid workspace name");
  return { raw, name: name.value };
}
async function seedOther(daemon: DaemonFixture) {
  await daemon.call(
    "workspace.create",
    JSON.stringify({
      workspace_id: "other",
      actor_id: "fixture-author",
      mutation_id: "other-create",
      name: "Other workspace",
      root: path.join(daemon.root, "other"),
    }),
  );
}
async function mount(page: Page, companion: CompanionFixture, socket: string, view = "overview") {
  const html = await page.request.get(companion.url);
  const capability = /<meta name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(
    await html.text(),
  )?.[1];
  if (!capability) throw new Error("Missing native capability");
  for (const [endpoint, body] of [
    ["/connections", { id: "local", label: "Original daemon", socket }],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const response = await page.request.post(new URL(`/ui-api/v1${endpoint}`, companion.url).href, {
      headers: { Origin: new URL(companion.url).origin, "X-Workgraph-UI-Capability": capability },
      data: body,
    });
    expect(response.status()).toBe(200);
    await response.text();
  }
  await page.goto(companion.url + `#/${view}?connection=local&workspace=demo&project=release`);
  await expect(
    page.locator("#root").getByText("Companion reachable", { exact: true }),
  ).toBeVisible();
  await waitForPageReads(page);
  return page.locator("#root");
}
async function management(root: Locator) {
  const summary = root
    .locator("summary")
    .filter({ hasText: /^Workspace and project management$/u });
  await expect(summary).toBeVisible();
  if ((await summary.locator("..").getAttribute("open")) === null) await summary.click();
  await expect(root.getByRole("button", { name: "Refresh registry", exact: true })).toBeVisible();
}
function panel(root: Locator, title: string) {
  return root
    .locator("section.wg-panel")
    .filter({ has: root.page().getByRole("heading", { name: title, exact: true }) });
}
async function writer(root: Locator, actor: string, mark: () => void) {
  await root.locator(".wg-actor-trigger").click();
  await root.getByLabel("Acting actor ID", { exact: true }).fill(actor);
  mark();
  await root.getByRole("button", { name: "Use selection", exact: true }).click();
  await waitForPageReads(root.page());
}
async function saved(review: Locator, button = "Execute saved request") {
  await review.getByRole("button", { name: button, exact: true }).click();
  await expect
    .poll(async () => {
      const state = await review.locator(".wg-badge").textContent();
      if (state === "sending")
        await review.getByRole("button", { name: /^Inspect(?: saved action)?$/u }).click();
      return state;
    })
    .toBe("committed");
}
async function shot(page: Page, info: TestInfo, name: string) {
  await waitForPageReads(page);
  const p = info.outputPath(name);
  await page.screenshot({ path: p, fullPage: false });
  await info.attach(name, { path: p, contentType: "image/png" });
}

test("F01 registry row destination differs from selection and survives scope switch before explicit Apply", async ({
  page,
  daemon,
  companion,
  browserDiagnostics,
  browserFailures,
}, info) => {
  await seedOther(daemon);
  const beforeA = await workspace(daemon, "demo");
  const beforeB = await workspace(daemon, "other");
  const root = await mount(page, companion, daemon.socket);
  await writer(root, "fixture-author", browserDiagnostics.markPendingReads);
  await management(root);
  const row = panel(root, "Workspaces")
    .getByRole("row")
    .filter({ has: page.getByRole("button", { name: "Other workspace", exact: true }) });
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await root.getByLabel("Workspace name", { exact: true }).fill("Changed target B 雪");
  await root.getByRole("button", { name: "Review captured action", exact: true }).click();
  const review = panel(root, "Review captured action");
  await expect(review.locator(".wg-badge")).toHaveText("prepared_unsent");
  await expect(review.getByText("Destination:", { exact: false })).toHaveText(
    "Destination: Workspace other.",
  );
  await expect(review.getByText("Original endpoint:", { exact: false })).toContainText(
    "Original daemon · generation 1",
  );
  await expect(review.getByText("Destination:", { exact: false })).not.toContainText("release");
  expect((await workspace(daemon, "other")).raw).toBe(beforeB.raw);
  await shot(page, info, "review-actual-other-before-apply.png");
  browserDiagnostics.markPendingReads();
  await page.evaluate(() => {
    window.location.hash = "/overview?connection=local&workspace=other";
  });
  await expect(page).toHaveURL(/workspace=other/u);
  await waitForPageReads(page);
  await management(root);
  await expect(review.getByText("Destination:", { exact: false })).toHaveText(
    "Destination: Workspace other.",
  );
  await writer(root, "changed-shell-writer", browserDiagnostics.markPendingReads);
  await expect(review.getByText("Original writer", { exact: false })).toContainText(
    "fixture-author",
  );
  const exact = review.locator("summary").filter({ hasText: /^Exact captured request$/u });
  await exact.click();
  await expect(review.getByText("Draft selection:", { exact: false })).toContainText(
    "Draft selection: workspace demo, project release",
  );
  await exact.click();
  await saved(review);
  const afterB = await workspace(daemon, "other");
  expect(afterB.name).toBe("Changed target B 雪");
  expect((await workspace(daemon, "demo")).raw).toBe(beforeA.raw);
  await info.attach("two-workspace-native-readback", {
    contentType: "application/json",
    body: JSON.stringify({ beforeA: beforeA.raw, beforeB: beforeB.raw, afterB: afterB.raw }),
  });
  // A separate real registry Close while A remains selected verifies the same row-only target.
  browserDiagnostics.markPendingReads();
  await page.evaluate(() => {
    window.location.hash = "/overview?connection=local&workspace=demo&project=release";
  });
  await waitForPageReads(page);
  await management(root);
  await root.getByRole("button", { name: "Close draft", exact: true }).click();
  await root.getByRole("button", { name: "Refresh registry", exact: true }).click();
  const changed = panel(root, "Workspaces")
    .getByRole("row")
    .filter({ has: page.getByRole("button", { name: "Changed target B 雪", exact: true }) });
  await changed.getByRole("button", { name: "Close", exact: true }).click();
  await root.getByRole("button", { name: "Review captured action", exact: true }).click();
  await expect(review.locator(".wg-badge")).toHaveText("prepared_unsent");
  await expect(review.getByText("Destination:", { exact: false })).toHaveText(
    "Destination: Workspace other.",
  );
  await saved(review);
  const registry = field(
    field(decoded(await daemon.call("workspace.list", "{}")), "result"),
    "data",
  );
  const rows = field(registry, "workspaces");
  if (rows.kind !== "array") throw new Error("Missing registry rows");
  const open = (id: string) =>
    field(
      rows.items.find((x) => {
        const v = field(x, "workspace_id");
        return v.kind === "string" && v.value === id;
      }) ?? { kind: "null" },
      "open",
    );
  expect(open("other")).toEqual({ kind: "boolean", value: false });
  expect(open("demo")).toEqual({ kind: "boolean", value: true });
  await shot(page, info, "registry-close-actual-other-saved.png");
  expect(browserFailures).toEqual([]);
});

test("F01 Advanced edited workspace is the displayed and native committed target", async ({
  page,
  daemon,
  companion,
  browserDiagnostics,
  browserFailures,
}, info) => {
  await seedOther(daemon);
  const beforeA = await workspace(daemon, "demo"),
    beforeB = await workspace(daemon, "other");
  const root = await mount(page, companion, daemon.socket, "advanced");
  await writer(root, "fixture-author", browserDiagnostics.markPendingReads);
  await root.getByRole("button", { name: "Methods", exact: true }).click();
  await root.getByLabel("Search catalogue").fill("workspace.update");
  await root
    .locator(".adv-item")
    .filter({ has: page.locator("code", { hasText: /^workspace\.update$/u }) })
    .click();
  await root.getByRole("button", { name: "New draft for workspace.update", exact: true }).click();
  await root.getByRole("button", { name: "Raw JSON", exact: true }).click();
  await root
    .getByLabel("Exact parameter source", { exact: true })
    .fill(
      '{"workspace_id":"other","actor_id":"fixture-author","expected_revision":"0","name":"Advanced target B 雪"}',
    );
  await root.getByRole("button", { name: "Validate & prepare", exact: true }).click();
  const review = panel(root, "Captured operation");
  await expect(review.locator(".wg-badge")).toHaveText("prepared_unsent");
  await expect(review.getByText("Destination:", { exact: false })).toHaveText(
    "Destination: Workspace other.",
  );
  await expect(review.getByText("Destination:", { exact: false })).not.toContainText("release");
  expect((await workspace(daemon, "other")).raw).toBe(beforeB.raw);
  await shot(page, info, "advanced-actual-target-before-apply.png");
  browserDiagnostics.markPendingReads();
  await page.evaluate(() => {
    window.location.hash = "/advanced?connection=local&workspace=demo";
  });
  await waitForPageReads(page);
  await writer(root, "changed-shell-writer", browserDiagnostics.markPendingReads);
  await expect(review.getByText("Destination:", { exact: false })).toHaveText(
    "Destination: Workspace other.",
  );
  await saved(review);
  const afterB = await workspace(daemon, "other");
  expect(afterB.name).toBe("Advanced target B 雪");
  expect((await workspace(daemon, "demo")).raw).toBe(beforeA.raw);
  await info.attach("advanced-two-workspace-native-readback", {
    contentType: "application/json",
    body: JSON.stringify({ beforeA: beforeA.raw, beforeB: beforeB.raw, afterB: afterB.raw }),
  });
  await shot(page, info, "advanced-actual-target-saved.png");
  expect(browserFailures).toEqual([]);
});
