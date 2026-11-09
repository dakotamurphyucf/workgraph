import { test, expect } from "../../e2e/support/fixtures";
import { view, identifier } from "../config/fixtures";
import {
  editorPanel,
  editorScreenshot,
  mountEditor,
  nativeWriter,
  openConfiguration,
} from "./browser-fixtures";

test.use({ viewport: { width: 1480, height: 1000 }, actionTimeout: 12000 });
test("saved resource scopes explain unlinked omissions and inventory names only validated configurations", async ({
  page,
  companion,
  daemon,
  browserFailures,
}, info) => {
  const write = nativeWriter(daemon);
  await write("resource.put_text", {
    resource_id: "unlinked-notes",
    expected_revision: "0",
    title: "Visible unlinked notes",
    filename: "unlinked.md",
    mime_type: "text/markdown",
    text: "Unlinked content",
  });
  const [api] = await Promise.all([
    mountEditor(page, companion, daemon),
    page.getByText("Your saved configurations (0)", { exact: true }).click(),
  ]);
  const valid = view("resources", {
    id: identifier("resource-shelf"),
    title: "Readable resource shelf",
  });
  const documents = [
    { id: "resource-shelf", source: JSON.stringify(valid) },
    { id: "future-source", source: '{"config_version":99,"title":"Do not display future title"}' },
    { id: "invalid-source", source: '{"title":"Do not display invalid title"}' },
    { id: "broken-source", source: '{"title":"unfinished' },
    {
      id: "mismatched-id",
      source: JSON.stringify(view("resources", { title: "Do not borrow another ID title" })),
    },
  ];
  const saved = await api.request("/view-settings/replace", {
    connection_id: "local",
    generation: "1",
    workspace_id: "demo",
    expected_revision: "0",
    documents,
    selected_id: null,
  });
  expect(saved.status()).toBe(200);
  await saved.text();
  await page.getByRole("button", { name: "Inspect private settings", exact: true }).click();
  const inventory = page.locator(".wg-custom-saved");
  await expect(inventory.getByText("Readable resource shelf", { exact: true })).toBeVisible();
  for (const document of documents) {
    const row = inventory
      .locator("li")
      .filter({ has: page.locator("code").getByText(document.id, { exact: true }) });
    await expect(row.getByRole("button", { name: "Open", exact: true })).toBeEnabled();
    await expect(row.getByRole("button", { name: "Remove", exact: true })).toBeEnabled();
    if (document.id !== "resource-shelf") await expect(row.locator("strong")).toHaveCount(0);
  }
  await editorScreenshot(page, info, "validated-private-titles");
  await openConfiguration(page, "resource-shelf");
  await expect(
    page.getByText("Resources linked to this workspace.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Activate view", exact: true }).click();
  const working = editorPanel(page, "Working view");
  await expect(working).toContainText("0 matching / 0 captured rows");
  await expect(working).toContainText("Resources linked to this workspace.");
  await expect(working).toContainText(
    "Unlinked resources can still appear in the Resources directory",
  );
  await expect(working).toContainText("Collection traversal complete");
  await editorScreenshot(page, info, "empty-workspace-linked-resources");
  await page.getByRole("link", { name: "Resources", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Visible unlinked notes unlinked-notes/u }),
  ).toBeVisible();
  expect(browserFailures).toEqual([]);
});
