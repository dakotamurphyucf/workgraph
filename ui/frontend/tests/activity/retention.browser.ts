import { test, expect } from "../e2e/support/fixtures";

/** Real daemon refreshes must not remount an expanded immutable audit record,
 * including after it falls outside the latest page. */
test("Activity preserves open details and reading position across a full page of new events", async ({
  page,
  daemon,
  companion,
  browserFailures,
  browserDiagnostics,
}) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const capability = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(
    await (await page.request.get(companion.url)).text(),
  )?.[1];
  if (!capability) throw new Error("Missing local bootstrap capability");
  const headers = {
    Origin: new URL(companion.url).origin,
    "X-Workgraph-UI-Capability": capability,
  };
  for (const [path, data] of [
    ["/connections", { id: "activity", label: "Activity test", socket: daemon.socket }],
    ["/connections/activity/attach", { generation: "1" }],
  ] as const) {
    const response = await page.request.post(new URL(`/ui-api/v1${path}`, companion.url).href, {
      headers,
      data,
    });
    expect(response.status(), await response.text()).toBe(200);
  }
  const write = async (index: number) => {
    const response = await daemon.call(
      "comment.add",
      JSON.stringify({
        workspace_id: "demo",
        actor_id: "fixture-author",
        mutation_id: `activity-retention-${index}`,
        target: { kind: "ticket", id: "design" },
        body: `Activity retention event ${index}`,
        kind: "progress",
      }),
    );
    expect(response).not.toContain('"error":');
  };
  for (let i = 0; i < 30; i++) await write(i);
  await page.goto(new URL("/#/activity?connection=activity&workspace=demo", companion.url).href);
  const entries = page.locator(".ac-entry");
  await expect(entries).toHaveCount(25);
  const revision = await entries.nth(5).getAttribute("data-revision");
  const row = page.locator(`.ac-entry[data-revision="${revision}"]`);
  const details = row.locator(".ac-audit-detail > details");
  await details.locator(":scope > summary").click();
  await expect(row.locator(".ac-change-list")).toBeVisible();
  await row.evaluate((element) => {
    element.scrollIntoView({ block: "start" });
    element.setAttribute("data-retained-test", "original");
  });
  const before = await row.boundingBox();
  if (!before) throw new Error("Missing visible row");
  // A concurrent write may invalidate the count probe's revision guard. The
  // feed must retain its prior rows, then catch up on the next live observation.
  // Accept only that exact native conflict, not arbitrary failed reads.
  browserDiagnostics.expectedHTTP.set(new URL("/ui-api/v1/read", companion.url).href, 409);
  const conflicts: Promise<void>[] = [];
  page.on("response", (response) => {
    if (response.status() !== 409) return;
    conflicts.push(
      (async () => {
        const request: unknown = response.request().postDataJSON();
        const reply: unknown = await response.json();
        expect(request).toMatchObject({
          method: "activity.since",
          params: { at_revision: expect.any(String) },
        });
        expect(reply).toMatchObject({
          ok: false,
          error: { kind: "Conflict", details: { type: "revision" } },
        });
      })(),
    );
  });
  for (let i = 30; i < 60; i++) await write(i);
  await expect(entries.first()).toContainText("Activity retention event 59", { timeout: 20000 });
  await expect(entries).toHaveCount(50);
  await expect(details).toHaveAttribute("open", "");
  await expect(row).toHaveAttribute("data-retained-test", "original");
  const response = page.waitForResponse((response) => {
    const body = response.request().postData();
    return (
      response.url().endsWith("/read") &&
      !!body?.includes("activity.since") &&
      body.includes("at_revision")
    );
  });
  // Programmatic click avoids Playwright scrolling to the toolbar and changing
  // the reading position this assertion is intended to protect.
  await page
    .getByRole("button", { name: "Show latest activity", exact: true })
    .evaluate((button) => {
      if (button instanceof HTMLButtonElement) button.click();
    });
  await response;
  await expect(details).toHaveAttribute("open", "");
  await expect(row).toHaveAttribute("data-retained-test", "original");
  const after = await row.boundingBox();
  if (!after) throw new Error("Expanded audit row disappeared");
  expect(Math.abs(after.y - before.y)).toBeLessThan(4);
  await details.locator(":scope > summary").click();
  await expect(row).toHaveCount(0);
  await expect(entries).toHaveCount(25);
  await entries.first().locator(".ac-audit-detail > details > summary").click();
  await expect(entries.first().locator(".ac-audit-detail > details")).toHaveAttribute("open", "");
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page
    .getByRole("group", { name: "Actor (optional) input mode" })
    .getByRole("button", { name: "Enter ID", exact: true })
    .click();
  await page.getByLabel("Actor (optional)", { exact: true }).fill("fixture-author");
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  await expect(entries).toHaveCount(25);
  await expect(page.locator(".ac-audit-detail > details[open]")).toHaveCount(0);
  await Promise.all(conflicts);
  expect(browserFailures).toEqual([]);
});

test("Activity explains historical pages and filters by searchable ticket or a manually entered actor", async ({
  page,
  daemon,
  companion,
  browserFailures,
  browserDiagnostics,
}) => {
  const cap = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(
    await (await page.request.get(companion.url)).text(),
  )?.[1];
  if (!cap) throw new Error("Missing bootstrap capability");
  for (const [path, data] of [
    ["/connections", { id: "activity", label: "Activity test", socket: daemon.socket }],
    ["/connections/activity/attach", { generation: "1" }],
  ] as const) {
    const response = await page.request.post(new URL(`/ui-api/v1${path}`, companion.url).href, {
      headers: { Origin: new URL(companion.url).origin, "X-Workgraph-UI-Capability": cap },
      data,
    });
    expect(response.status(), await response.text()).toBe(200);
  }
  for (let i = 0; i < 28; i++) {
    const reply = await daemon.call(
      "comment.add",
      JSON.stringify({
        workspace_id: "demo",
        actor_id: "fixture-author",
        mutation_id: `activity-design-${i}`,
        target: { kind: "ticket", id: "design" },
        body: `Design progress ${i}`,
        kind: "progress",
      }),
    );
    expect(reply).not.toContain('"error":');
  }
  await page.goto(new URL("/#/activity?connection=activity&workspace=demo", companion.url).href);
  const rows = page.locator(".ac-entry");
  await expect(rows).toHaveCount(25);
  await page.getByRole("button", { name: "How activity works", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Times use your device’s time zone");
  await page.getByRole("button", { name: "Close How activity works", exact: true }).click();
  browserDiagnostics.markPendingReads();
  await page.getByRole("button", { name: "Earlier activity", exact: true }).click();
  await expect(page.locator(".ac-history-notice")).toContainText("saved capture");
  await expect(page.locator(".ac-audit-footer")).toContainText("Saved history");
  await page.getByRole("button", { name: "Return to live activity →", exact: true }).click();
  await expect(rows.first()).toContainText("Design progress 27");
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  let modal = page.getByRole("dialog", { name: "Filter activity", exact: true });
  await modal.getByRole("button", { name: "Ticket (optional)", exact: true }).click();
  await modal.getByRole("textbox", { name: "Search tickets", exact: true }).fill("design");
  await modal.locator("[data-reference-option]").filter({ hasText: "design" }).first().click();
  await expect(
    modal.getByRole("button", { name: "Ticket (optional)", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(modal.getByLabel("Actor (optional)", { exact: true })).toHaveJSProperty(
    "tagName",
    "SELECT",
  );
  await modal.getByRole("button", { name: "Apply filters", exact: true }).click();
  await expect(page.locator(".ac-filter-chips")).toContainText("Ticket · design");
  await expect(rows).toHaveCount(25);
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  modal = page.getByRole("dialog", { name: "Filter activity", exact: true });
  await modal
    .getByRole("group", { name: "Actor (optional) input mode" })
    .getByRole("button", { name: "Enter ID", exact: true })
    .click();
  await modal.getByLabel("Actor (optional)", { exact: true }).fill("no-activity-yet");
  await modal.getByRole("button", { name: "Apply filters", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No matching activity" })).toBeVisible();
  await page.getByRole("button", { name: "Remove actor filter", exact: true }).click();
  await expect(rows).toHaveCount(25);
  await page.getByRole("button", { name: "Remove ticket filter", exact: true }).click();
  await expect(page.locator(".ac-filter-chips")).toHaveCount(0);
  expect(browserFailures).toEqual([]);
});
