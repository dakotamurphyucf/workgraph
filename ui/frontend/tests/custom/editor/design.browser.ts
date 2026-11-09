import { test, expect } from "../../e2e/support/fixtures";
import { mountEditor, nativeWriter } from "./browser-fixtures";

test.use({ viewport: { width: 1440, height: 1000 }, actionTimeout: 12000 });
test("Saved views separate library, retained builder and live results with usable management dialogs", async ({
  page,
  companion,
  daemon,
  browserFailures,
}) => {
  const write = nativeWriter(daemon);
  await write("ticket.create", {
    ticket_id: "design-ticket",
    project_id: "release",
    title: "Visible native ticket",
  });
  await mountEditor(page, companion, daemon);
  await page.getByRole("button", { name: "New view", exact: true }).click();
  const builder = page.getByRole("region", { name: "Configuration builder", exact: true });
  const results = page.getByRole("region", { name: "Saved view results", exact: true });
  const library = page.getByRole("region", { name: "Saved configuration library", exact: true });
  await builder.getByLabel("Name", { exact: true }).fill("Release command board");
  await builder.getByRole("button", { name: "Save privately", exact: true }).click();
  await expect(
    page.getByText("Private settings saved at revision 1.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Saved view sections" })
    .getByRole("button", { name: /^Library/u })
    .click();
  await expect(library.locator(".sv-card-heading")).toContainText("Release command board");
  await expect(library.getByRole("button", { name: "Open", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Builder · Draft", exact: true }).click();
  await expect(builder.getByLabel("Name", { exact: true })).toHaveValue("Release command board");
  await builder.getByRole("button", { name: "Activate view", exact: true }).click();
  await expect(results.getByText("Visible native ticket", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Working view results", { exact: true })).toBeFocused();
  await write("ticket.create", {
    ticket_id: "second-ticket",
    project_id: "release",
    title: "External live result",
  });
  await expect(results.getByText("External live result", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Builder · Draft", exact: true }).click();
  await builder.getByRole("button", { name: "Raw source", exact: true }).click();
  await builder
    .getByLabel("Configuration source", { exact: true })
    .fill('{"config_version":1,"kind":"view"}');
  await expect(builder.getByRole("button", { name: "Activate view", exact: true })).toBeDisabled();
  await page
    .getByRole("navigation", { name: "Saved view sections" })
    .getByRole("button", { name: /^Results/u })
    .click();
  await expect(results.getByText("Visible native ticket", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Builder · Draft", exact: true }).click();
  await expect(builder.getByLabel("Configuration source", { exact: true })).toHaveValue(
    '{"config_version":1,"kind":"view"}',
  );
  await builder.getByRole("button", { name: "Discard draft", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Saved view sections" })
    .getByRole("button", { name: /^Library/u })
    .click();
  await library.getByRole("button", { name: "Set preferred", exact: true }).click();
  await expect(
    library.locator(".wg-custom-saved").getByText("Preferred", { exact: true }),
  ).toBeVisible();
  await library.getByRole("button", { name: "Open", exact: true }).click();
  await expect(builder.getByLabel("Name", { exact: true })).toHaveValue("Release command board");
  await builder.getByRole("button", { name: "Discard draft", exact: true }).click();
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByLabel("Portable settings JSON", { exact: true }).fill("unfinished portable text");
  await page.getByRole("button", { name: "Close Import portable settings", exact: true }).click();
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByLabel("Portable settings JSON", { exact: true })).toHaveValue(
    "unfinished portable text",
  );
  await page.getByRole("button", { name: "Close Import portable settings", exact: true }).click();
  await page.getByRole("button", { name: "Shared catalog", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Read shared catalog", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close Verified shared catalog", exact: true }).click();
  await page.getByRole("button", { name: "Saved targets", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Saved private targets", exact: true }),
  ).toContainText("Custom views qualification");
  await page.getByRole("button", { name: "Close Saved private targets", exact: true }).click();
  await page.getByRole("button", { name: "New renderer", exact: true }).click();
  await expect(
    builder.getByRole("heading", { name: "Renderer builder", exact: true }),
  ).toBeVisible();
  await builder.getByLabel("Name", { exact: true }).fill("Readable measurements");
  await page
    .getByRole("navigation", { name: "Saved view sections" })
    .getByRole("button", { name: /^Library/u })
    .click();
  await page.getByRole("button", { name: "Builder · Draft", exact: true }).click();
  await expect(builder.getByLabel("Name", { exact: true })).toHaveValue("Readable measurements");
  await builder.getByRole("button", { name: "Discard draft", exact: true }).click();
  await page.setViewportSize({ width: 760, height: 800 });
  await page
    .getByRole("navigation", { name: "Saved view sections" })
    .getByRole("button", { name: /^Library/u })
    .click();
  await expect(library.locator(".sv-card-heading")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(browserFailures).toEqual([]);
});

test("Saved view setup guides a new source, workspace choices and a renderer preview", async ({
  page,
  companion,
  daemon,
  browserFailures,
}) => {
  await mountEditor(page, companion, daemon);
  await expect(
    page.getByRole("region", { name: "Getting started with saved views" }),
  ).toContainText("does not copy, move or change");
  await page.getByRole("button", { name: "New view", exact: true }).click();
  const builder = page.getByRole("region", { name: "Configuration builder", exact: true });
  await builder.getByLabel("Name", { exact: true }).fill("Project resource library");
  await builder.getByLabel("Source", { exact: true }).selectOption("resources");
  await builder.getByRole("button", { name: "Use suggested setup", exact: true }).click();
  await expect(builder.getByLabel("Column 1 field", { exact: true })).toHaveValue("name");
  await builder.getByLabel("Scope", { exact: true }).selectOption("project");
  await builder.getByRole("button", { name: "Scope ID", exact: true }).click();
  const choice = builder.locator("[data-reference-option]").first();
  await expect(choice).toBeVisible();
  await choice.click();
  await expect(builder.getByRole("button", { name: "Scope ID", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(builder.getByRole("button", { name: "Activate view", exact: true })).toBeEnabled();
  await builder.getByLabel("Source", { exact: true }).selectOption("runs");
  await builder.getByRole("button", { name: "Use suggested setup", exact: true }).click();
  await expect(builder.getByLabel("Scope", { exact: true })).toHaveValue("workspace");
  await expect(builder.getByLabel("Name", { exact: true })).toHaveValue("Project resource library");
  await expect(builder.getByRole("button", { name: "Activate view", exact: true })).toBeEnabled();
  await builder.getByRole("button", { name: "Discard draft", exact: true }).click();
  await page.getByRole("button", { name: "New renderer", exact: true }).click();
  await builder.getByLabel("Field 1 pointer", { exact: true }).fill("/score");
  await builder.getByLabel("Field 1 format", { exact: true }).selectOption("number");
  await builder.getByText("3 · Try your renderer with sample data", { exact: true }).click();
  await builder.getByLabel("Preview JSON", { exact: true }).fill('{"score":42}');
  await builder.getByRole("button", { name: "Preview value", exact: true }).click();
  await expect(builder.locator(".wg-custom-render-fields")).toContainText("42");
  expect(browserFailures).toEqual([]);
});

test("Import explains scope, confirms before saving and never presents an old review for changed text", async ({
  page,
  companion,
  daemon,
  browserFailures,
}) => {
  await mountEditor(page, companion, daemon);
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Import portable settings", exact: true });
  const source = {
    config_version: 1,
    kind: "view",
    id: "imported-guide",
    title: "Imported ticket view",
    source: "tickets",
    scope: { kind: "workspace" },
    filter_mode: "server",
    filters: [],
    sort: [],
    group_by: null,
    presentation: "table",
    columns: [
      {
        id: "title",
        label: "Title",
        selector: { kind: "field", field: "title" },
        format: { type: "text" },
      },
    ],
  };
  await dialog.getByLabel("Portable settings JSON", { exact: true }).fill(
    JSON.stringify({
      settings_version: 1,
      documents: [{ id: "imported-guide", source: JSON.stringify(source) }],
      selected_id: null,
    }),
  );
  await dialog.getByRole("button", { name: "Review import", exact: true }).click();
  const save = dialog.getByRole("button", { name: "Save reviewed import privately", exact: true });
  await expect(save).toBeDisabled();
  await dialog.getByRole("button", { name: "Confirm scope", exact: true }).click();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(dialog).toContainText("Private settings saved.");
  await dialog
    .getByLabel("Portable settings JSON", { exact: true })
    .fill("this is not an exported settings file");
  await dialog.getByRole("button", { name: "Review import", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Review import", exact: true })).toBeEnabled();
  await expect(save).toHaveCount(0);
  await page.getByRole("button", { name: "Close Import portable settings", exact: true }).click();
  await expect(page.locator(".wg-custom-saved")).toContainText("Imported ticket view");
  expect(browserFailures).toEqual([]);
});
