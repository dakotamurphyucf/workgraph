import { test, expect } from "../e2e/support/fixtures";

test.use({ viewport: { width: 1580, height: 1080 }, colorScheme: "dark" });

test("Participants guided forms choose workspace records and preserve reviewed writes", async ({
  page,
  companion,
  daemon,
  browserDiagnostics,
  browserFailures,
}) => {
  const bootstrap = await page.request.get(companion.url);
  const capability = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(
    await bootstrap.text(),
  )?.[1];
  if (!capability) throw new Error("Missing companion capability");
  const headers = {
    Origin: new URL(companion.url).origin,
    "X-Workgraph-UI-Capability": capability,
  };
  for (const [path, data] of [
    ["/connections", { id: "local", label: "Participants design", socket: daemon.socket }],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const response = await page.request.post(new URL(`/ui-api/v1${path}`, companion.url).href, {
      headers,
      data,
    });
    expect(response.status()).toBe(200);
    await response.text();
  }
  await page.goto(
    new URL("/#/participants?connection=local&workspace=demo&project=release", companion.url).href,
  );
  await expect(page.locator(".pt-empty")).toBeVisible();
  await expect(page.getByText("A run is one working session", { exact: false })).toBeVisible();
  browserDiagnostics.markPendingReads();
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill("fixture-author");
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  const close = async () => {
    browserDiagnostics.markPendingReads();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^Close /u })
      .click();
  };
  const action = async (name: RegExp) => {
    await page.getByRole("button", { name: "Record a change", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name }).click();
    return page.getByRole("dialog");
  };
  const apply = async () => {
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Review change", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Apply change", exact: true })).toBeEnabled();
    await expect(dialog.getByRole("heading", { name: "Changes to apply" })).toBeVisible();
    await dialog.getByRole("button", { name: "Apply change", exact: true }).click();
    await expect(dialog.getByRole("status").filter({ hasText: /^committed$/u })).toBeVisible();
    await expect(dialog.getByText("Exact result JSON", { exact: true })).toHaveCount(0);
  };
  let dialog = await action(/^Register a run /u);
  await dialog.getByLabel("Existing invocation ID", { exact: true }).fill("design-run");
  await dialog
    .getByLabel("Invocation objective", { exact: true })
    .fill("Synthetic run for participant UI qualification");
  await apply();
  await close();
  dialog = await action(/^Record a run state /u);
  await dialog.getByRole("button", { name: "Target run ID", exact: true }).click();
  await dialog
    .getByRole("region", { name: "Choose run", exact: true })
    .locator("button[data-reference-option]")
    .filter({ hasText: "design-run" })
    .click();
  await expect(dialog.getByRole("region", { name: "Choose run", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Target run ID", exact: true })).toContainText(
    "design-run",
  );
  await dialog.getByRole("button", { name: "Discard unsent draft", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page
    .getByRole("group", { name: "Participants workspace", exact: true })
    .getByRole("button", { name: "Allocation rules", exact: true })
    .click();
  await expect(page.locator(".co-heading h2")).toHaveText("Allocation rules");
  await page.getByRole("button", { name: "Configure a pool", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Pool name", { exact: true }).fill("Review capacity");
  await dialog.getByLabel("Concurrent slots", { exact: true }).fill("2");
  await apply();
  await close();
  await page.getByRole("button", { name: "Configure ticket eligibility", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Ticket ID", exact: true }).click();
  await dialog
    .getByRole("region", { name: "Choose ticket", exact: true })
    .locator("button[data-reference-option]")
    .filter({ hasText: "Clarify the workflow" })
    .click();
  await expect(dialog.getByRole("button", { name: "Ticket ID", exact: true })).toContainText(
    "Clarify the workflow",
  );
  await dialog.getByRole("button", { name: "Add pools", exact: true }).click();
  await dialog.getByRole("button", { name: "Pool 1", exact: true }).click();
  await dialog
    .getByRole("region", { name: "Choose pool", exact: true })
    .locator("button[data-reference-option]")
    .filter({ hasText: "Review capacity" })
    .click();
  await apply();
  await close();
  await page.getByRole("button", { name: "Ticket policies", exact: true }).click();
  await expect(page.locator(".co-record").filter({ hasText: "Ticket design" })).toContainText(
    "Review capacity",
  );

  await daemon.call(
    "ticket.claim",
    JSON.stringify({
      workspace_id: "demo",
      actor_id: "fixture-author",
      run_id: "design-run",
      mutation_id: "continuity-claim",
      ticket_id: "design",
    }),
  );
  await page
    .getByRole("group", { name: "Participants workspace", exact: true })
    .getByRole("button", { name: "People and runs", exact: true })
    .click();
  browserDiagnostics.markPendingReads();
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Run ID (optional)", { exact: true }).fill("design-run");
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  dialog = await action(/^Start a recorded attempt /u);
  await dialog.getByRole("button", { name: "Claimed ticket ID", exact: true }).click();
  await dialog
    .getByRole("region", { name: "Choose ticket", exact: true })
    .locator("button[data-reference-option]")
    .filter({ hasText: "Clarify the workflow" })
    .click();
  await dialog.getByLabel("New attempt ID", { exact: true }).fill("design-attempt");
  await apply();
  await close();
  await page
    .getByRole("group", { name: "Common participant views", exact: true })
    .getByRole("button", { name: "Attempts", exact: true })
    .click();
  await page.getByRole("button", { name: "design-attempt", exact: true }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("heading", { name: "Work on a claimed ticket", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("dialog")
      .getByText("No checkpoints saved for this attempt yet.", { exact: true }),
  ).toBeVisible();
  await close();
  expect(browserFailures).toEqual([]);
});
