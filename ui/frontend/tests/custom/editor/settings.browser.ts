import { test, expect } from "../../e2e/support/fixtures";
import { view, identifier } from "../config/fixtures";
import {
  editorScreenshot,
  importConfigurations,
  mountEditor,
  openConfiguration,
} from "./browser-fixtures";
test.use({ viewport: { width: 1480, height: 1000 }, actionTimeout: 12000 });
test("Editor E04 private conflict retains original guard and old-generation inventory permits exact cleanup", async ({
  page,
  daemon,
  companion,
  browserFailures,
  browserDiagnostics,
}, info) => {
  const api = await mountEditor(page, companion, daemon);
  await importConfigurations(page, [
    {
      id: "saved-old",
      source: JSON.stringify(
        view("tickets", { id: identifier("saved-old"), title: "Original generation view" }),
      ),
    },
  ]);
  await openConfiguration(page, "saved-old");
  const snapshot = await api.request("/view-settings/inspect", {
    connection_id: "local",
    generation: "1",
    workspace_id: "demo",
  });
  expect(snapshot.status()).toBe(200);
  const observed = (await snapshot.json()) as {
    data: { revision: string; documents: readonly object[]; selected_id: string | null };
  };
  const external = await api.request("/view-settings/replace", {
    connection_id: "local",
    generation: "1",
    workspace_id: "demo",
    expected_revision: observed.data.revision,
    documents: observed.data.documents,
    selected_id: observed.data.selected_id,
  });
  expect(external.status()).toBe(200);
  await external.text();
  const url = new URL("/ui-api/v1/view-settings/replace", companion.url).href;
  browserDiagnostics.expectedHTTP.set(url, 409);
  try {
    const response = page.waitForResponse(
      (response) => response.url() === url && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Save privately", exact: true }).click();
    const rejection = await response;
    expect(rejection.status()).toBe(409);
    const body = (await rejection.json()) as { error: { kind: string } };
    expect(body.error.kind).toBe("Conflict");
    await expect(
      page.getByText(/The save was rejected; original target\/source\/guard remain retained/u),
    ).toBeVisible();
  } finally {
    browserDiagnostics.expectedHTTP.delete(url);
  }
  await expect(page.getByText(/private guard 1/u)).toBeVisible();
  await page.getByRole("button", { name: "Inspect original save target", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Use inspected revision for a new save", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Use inspected revision for a new save", exact: true })
    .click();
  await page.getByRole("button", { name: "Save privately", exact: true }).click();
  await expect(
    page.getByText("Private settings saved at revision 3.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close draft", exact: true }).click();
  // A second conflict is an ordinary no-draft preference, with a concurrent document.
  const latestResponse = await api.request("/view-settings/inspect", {
    connection_id: "local",
    generation: "1",
    workspace_id: "demo",
  });
  const latest = (await latestResponse.json()) as {
    data: { revision: string; documents: readonly object[]; selected_id: string | null };
  };
  const advanced = await api.request("/view-settings/replace", {
    connection_id: "local",
    generation: "1",
    workspace_id: "demo",
    expected_revision: latest.data.revision,
    documents: [...latest.data.documents, { id: "concurrent", source: '{"config_version":99}' }],
    selected_id: latest.data.selected_id,
  });
  expect(advanced.status()).toBe(200);
  await advanced.text();
  browserDiagnostics.expectedHTTP.set(url, 409);
  try {
    const rejection = page.waitForResponse(
      (r) => r.url() === url && r.request().method() === "POST",
    );
    await page
      .locator(".wg-custom-saved")
      .getByRole("button", { name: "Set preferred", exact: true })
      .click();
    const rejected = await rejection;
    expect(rejected.status()).toBe(409);
    expect(((await rejected.json()) as { error: { kind: string } }).error.kind).toBe("Conflict");
    await expect(page.getByText(/The save was rejected; original target/u)).toBeVisible();
  } finally {
    browserDiagnostics.expectedHTTP.delete(url);
  }
  await page.getByRole("button", { name: "Inspect original save target", exact: true }).click();
  const discard = page.getByRole("button", {
    name: "Discard intention and inspect current settings",
    exact: true,
  });
  await expect(discard).toBeEnabled();
  const duringDiscard: string[] = [];
  const observeWrite = (request: import("@playwright/test").Request) => {
    if (request.url() === url && request.method() === "POST")
      duringDiscard.push(request.postData() ?? "");
  };
  page.on("request", observeWrite);
  await discard.click();
  await expect(
    page.locator(".wg-custom-saved").getByText("concurrent", { exact: true }),
  ).toBeVisible();
  page.off("request", observeWrite);
  expect(duringDiscard).toEqual([]);
  const originalRow = page
    .locator(".wg-custom-saved > li")
    .filter({ has: page.getByText("saved-old", { exact: true }) });
  await originalRow.getByRole("button", { name: "Set preferred", exact: true }).click();
  await expect(
    page.getByText("Private settings saved at revision 5.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".wg-custom-saved").getByText("concurrent", { exact: true }),
  ).toBeVisible();

  await page.locator(".wg-workspace-switch").click();
  const manager = page.getByRole("dialog", { name: "Daemon connections", exact: true });
  await manager.getByRole("button", { name: "Edit profile", exact: true }).click();
  await manager.getByLabel("Connection label", { exact: true }).fill("Renamed current generation");
  await manager.getByRole("button", { name: "Save new generation", exact: true }).click();
  await expect(
    manager.getByRole("heading", { name: "Manage Renamed current generation", exact: true }),
  ).toBeVisible();
  await manager.getByRole("button", { name: "Use this connection", exact: true }).click();
  await page.locator(".wg-scope-navigation").click();
  const scope = page.getByRole("dialog", { name: "Workspace & project scope", exact: true });
  await scope.getByText("Enter a workspace ID", { exact: true }).click();
  await scope.getByLabel("Workspace ID", { exact: true }).fill("demo");
  await scope.getByRole("button", { name: "Open scope", exact: true }).click();

  await expect(
    page.getByText("No private configurations at this exact target.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Saved targets", exact: true }).click();
  await page.getByText(/All retained private targets \(1\)/u).click();
  await page
    .getByRole("button", { name: "Custom views qualification · generation 1 · demo", exact: true })
    .click();
  await expect(
    page.locator(".wg-custom-saved").getByText("saved-old", { exact: true }),
  ).toBeVisible();
  for (const id of ["saved-old", "concurrent"]) {
    const row = page
      .locator(".wg-custom-saved > li")
      .filter({ has: page.getByText(id, { exact: true }) });
    await row.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(row).toHaveCount(0);
  }
  await expect(
    page.getByText("No private configurations at this exact target.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Saved targets", exact: true }).click();
  await expect(page.getByText("All retained private targets (0)", { exact: true })).toBeVisible();
  await editorScreenshot(page, info, "exact-old-generation-settings-cleanup");
  expect(browserFailures).toEqual([]);
});
