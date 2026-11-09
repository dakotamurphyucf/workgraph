import type { Page } from "../../../frontend/node_modules/@playwright/test/index.js";
import { test, expect } from "../../../frontend/tests/e2e/support/fixtures";

test.use({ actionTimeout: 10000 });

async function actor(page: Page, id: string) {
  await page.waitForLoadState("networkidle");
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill(id);
  await page.getByLabel("Run ID (optional)", { exact: true }).fill("");
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  await page.waitForLoadState("networkidle");
}
const editor = (page: Page) =>
  page.getByRole("article", { name: "Workflow draft editor", exact: true });
async function settled(page: Page) {
  await expect(
    editor(page)
      .getByRole("status")
      .filter({
        hasText:
          /^(Saving structured source|Checking this exact batch|Saving exact native operation)/u,
      }),
  ).toHaveCount(0);
  await expect(editor(page).getByText("Saved on this origin", { exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
}

test("Plans structured fields publish and link one generated resource atomically with captured writer", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  test.setTimeout(60000);
  const bootstrap = await page.request.get(companion.url);
  const capability = /<meta\s+name="workgraph-capability"\s+content="([a-f0-9]{64})"\s*\/?>/u.exec(
    await bootstrap.text(),
  )?.[1];
  if (!capability) throw new Error("Missing native capability");
  const headers = {
    "X-Workgraph-UI-Capability": capability,
    Origin: new URL(companion.url).origin,
  };
  for (const [path, data] of [
    ["/connections", { id: "local", label: "Atomic publication", socket: daemon.socket }],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const response = await page.request.post(new URL(`/ui-api/v1${path}`, companion.url).href, {
      headers,
      data,
    });
    expect(response.ok()).toBe(true);
    await response.text();
  }
  await page.goto(
    new URL("/#/workflow?connection=local&workspace=demo&project=release", companion.url).href,
  );
  await expect(page.getByRole("heading", { name: "Graph", exact: true })).toBeVisible();
  await actor(page, "publication-author");
  await page.getByRole("button", { name: "Drafts", exact: true }).click();
  await page.getByRole("button", { name: "New workflow draft", exact: true }).click();
  await settled(page);
  const operations = editor(page).locator("details.plan-op");
  const first = operations.nth(0),
    second = operations.nth(1);
  await first.locator(":scope > summary").click();
  await first.getByLabel("Declared exposure", { exact: true }).selectOption("");
  await settled(page);
  await first.getByLabel("Native method", { exact: true }).fill("resource.put_text");
  await settled(page);
  await first.getByRole("button", { name: "Remove Project id", exact: true }).click();
  await settled(page);
  await first.getByLabel("Unpublished alias (optional)", { exact: true }).fill("published");
  await settled(page);
  await first.getByLabel("Title", { exact: true }).fill("Atomic Plans note");
  await settled(page);
  await first
    .getByRole("button", {
      name: "Add required Expected revision",
      exact: true,
    })
    .click();
  await settled(page);
  await first.getByLabel("Expected revision", { exact: true }).fill("0");
  await settled(page);
  await first.getByRole("button", { name: "Add required Text", exact: true }).click();
  await settled(page);
  await first.getByLabel("Text", { exact: true }).fill("Exact atomic text 💖\n");
  await expect(first.getByLabel("Text", { exact: true })).toHaveAttribute("rows", "4");
  await expect(first.getByLabel("Text", { exact: true })).toHaveValue("Exact atomic text 💖\n");
  await settled(page);
  await expect(first.getByLabel("Include Resource id", { exact: true })).not.toBeChecked();
  await editor(page).getByLabel("Operation to add", { exact: true }).selectOption("ticket.hold");
  await editor(page).getByRole("button", { name: "Add operation", exact: true }).click();
  await settled(page);
  await expect(operations).toHaveCount(2);
  await second.locator(":scope > summary").click();
  await second.getByLabel("Native method", { exact: true }).fill("resource.link");
  await settled(page);
  for (const field of ["Reason", "Ticket id"]) {
    await second.getByRole("button", { name: `Remove ${field}`, exact: true }).click();
    await settled(page);
  }
  await second.getByRole("button", { name: "Add required Resource id", exact: true }).click();
  await settled(page);
  await second.getByLabel("Resource id", { exact: true }).fill("$published");
  await expect(second.getByLabel("Resource id", { exact: true })).toHaveAttribute("rows", "1");
  await settled(page);
  await expect(second.getByLabel("Expected revision", { exact: true })).toHaveValue("1");
  await second.getByRole("button", { name: "Add required Target", exact: true }).click();
  await settled(page);
  await second.getByLabel("Target kind", { exact: true }).selectOption({ label: "Ticket" });
  await settled(page);
  await second.getByLabel("Id", { exact: true }).fill("build");
  await settled(page);
  const screenshot = info.outputPath("atomic-plans-structured.png");
  await page.screenshot({ path: screenshot, fullPage: false });
  await info.attach("atomic-plans-structured", {
    path: screenshot,
    contentType: "image/png",
  });
  await actor(page, "later-shell-actor");
  await expect(editor(page).getByText(/Switching the shell does not retarget/u)).toBeVisible();
  await editor(page).getByRole("button", { name: "Review batch 1", exact: true }).click();
  const review = editor(page).locator(".plan-review");
  await expect(
    review.getByRole("heading", { name: "Frozen batch review", exact: true }),
  ).toBeVisible();
  await settled(page);
  const preparation = page.waitForRequest((request) =>
    new URL(request.url()).pathname.endsWith("/operations/prepare"),
  );
  await review
    .getByRole("button", {
      name: "Save native operation (do not execute)",
      exact: true,
    })
    .click();
  const request = await preparation;
  const saved: unknown = JSON.parse(request.postData() ?? "null");
  expect(saved).toMatchObject({
    method: "transaction.apply",
    params: {
      actor_id: "publication-author",
      workspace_id: "demo",
      operations: [
        {
          method: "resource.put_text",
          as: "published",
          params: {
            title: "Atomic Plans note",
            expected_revision: "0",
            text: "Exact atomic text 💖\n",
          },
        },
        {
          method: "resource.link",
          params: {
            resource_id: "$published",
            expected_revision: "1",
            target: { kind: "ticket", id: "build" },
          },
        },
      ],
    },
  });
  await expect(review.getByRole("status").filter({ hasText: /^prepared_unsent$/u })).toBeVisible();
  await review.getByRole("button", { name: "Execute saved request", exact: true }).click();
  await expect(review.getByRole("status").filter({ hasText: /^committed$/u })).toBeVisible();
  const listing: unknown = JSON.parse(
    await daemon.call("resource.list", JSON.stringify({ workspace_id: "demo" })),
  );
  await info.attach("atomic-publication-proof", {
    contentType: "application/json",
    body: JSON.stringify({ saved, listing }, null, 2),
  });
  expect(listing).toMatchObject({
    result: {
      data: {
        items: expect.arrayContaining([
          expect.objectContaining({
            resource_id: expect.any(String),
            revision: "2",
            metadata: expect.objectContaining({
              title: "Atomic Plans note",
              targets: [{ kind: "ticket", id: "build" }],
            }),
            current_version: expect.objectContaining({
              revision: "1",
              actor_id: "publication-author",
            }),
          }),
        ]),
      },
    },
  });
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (
    !record(listing) ||
    !record(listing.result) ||
    !record(listing.result.data) ||
    !Array.isArray(listing.result.data.items)
  )
    throw new Error("Missing native resource listing");
  const matched = listing.result.data.items.filter(
    (value: unknown) =>
      record(value) && record(value.metadata) && value.metadata.title === "Atomic Plans note",
  );
  expect(matched).toHaveLength(1);
  const published: unknown = matched[0];
  if (!record(published) || typeof published.resource_id !== "string")
    throw new Error("Missing generated native resource ID");
  const readback: unknown = JSON.parse(
    await daemon.call(
      "resource.read",
      JSON.stringify({
        workspace_id: "demo",
        resource_id: published.resource_id,
        version: "1",
      }),
    ),
  );
  expect(readback).toMatchObject({
    result: { data: { text: "Exact atomic text 💖\n" } },
  });
  await info.attach("atomic-published-content", {
    contentType: "application/json",
    body: JSON.stringify(readback, null, 2),
  });
  expect(browserFailures).toEqual([]);
});
