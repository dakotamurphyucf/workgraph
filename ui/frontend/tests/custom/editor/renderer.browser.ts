import { test, expect } from "../../e2e/support/fixtures";
import {
  editorActor,
  editorPanel,
  editorScreenshot,
  importConfigurations,
  mountEditor,
  nativeWriter,
  openConfiguration,
  reviewSharedPublication,
} from "./browser-fixtures";
import type { RendererConfig } from "../../../src/features/custom/config";
import { identifier } from "../config/fixtures";
test.use({ viewport: { width: 1480, height: 1000 }, actionTimeout: 15000 });
test("Editor E03 actual guarded shared publication and exact Fact/Resource/History renderer choice", async ({
  page,
  daemon,
  companion,
  browserFailures,
  browserDiagnostics,
}, info) => {
  test.setTimeout(90000);
  const write = nativeWriter(daemon),
    payload = JSON.stringify({ summary: "Observed subject", value: null });
  await write("fact.put", {
    scope: { kind: "workspace" },
    key: "Custom.subject",
    expected_revision: "0",
    value: { summary: "Observed subject", value: null },
  });
  await write("resource.put_text", {
    resource_id: "subject-resource",
    expected_revision: "0",
    title: "Subject resource",
    filename: "subject.json",
    mime_type: "application/json",
    text: payload,
  });
  await write("resource.link", {
    resource_id: "subject-resource",
    expected_revision: "1",
    target: { kind: "workspace" },
  });
  await write("session.create", {
    session_id: "subject-session",
    title: "Renderer history subject",
  });
  await write("session.append", {
    session_id: "subject-session",
    events: [
      {
        client_id: "subject-event",
        role: "sensor",
        kind: "measurement",
        phase: "recorded",
        payload: { kind: "inline", bytes_base64: Buffer.from(payload).toString("base64") },
      },
    ],
  });
  await mountEditor(page, companion, daemon);
  await editorActor(page);
  await page.getByRole("button", { name: "New renderer", exact: true }).click();
  const builder = editorPanel(page, "Renderer builder"),
    name = builder.getByLabel("Name", { exact: true });
  await name.fill("");
  await expect(builder.getByText("Draft needs attention", { exact: true })).toBeVisible();
  await expect(name).toBeFocused();
  await expect(builder.getByRole("heading", { name: "Source retained", exact: true })).toHaveCount(
    0,
  );
  for (const character of "Repaired renderer") {
    await name.pressSequentially(character);
    await expect(
      builder.getByText("Validating bounded configuration…", { exact: true }),
    ).toHaveCount(0);
    await expect(name).toBeFocused();
  }
  await expect(builder.getByRole("button", { name: "Save privately", exact: true })).toBeEnabled();
  const configurationId = builder.getByLabel("Configuration ID", { exact: true });
  await configurationId.fill("bad.id");
  await expect(builder.getByText("Draft needs attention", { exact: true })).toBeVisible();
  await expect(configurationId).toBeVisible();
  await expect(configurationId).toBeFocused();
  await expect(builder.getByRole("heading", { name: "Source retained", exact: true })).toHaveCount(
    0,
  );
  await configurationId.fill("repaired-renderer");
  await expect(builder.getByRole("button", { name: "Save privately", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Close draft", exact: true }).click();

  const renderer = (name: string, entity: RendererConfig["match"]["entity"]): RendererConfig => ({
    config_version: 1,
    kind: "renderer",
    id: identifier(name),
    title: name,
    match: { entity, root_type: "object" },
    presentation: {
      type: "fields",
      fields: [
        { pointer: "/summary", label: "Observed summary", format: { type: "text" } },
        { pointer: "/value", label: "Explicit null", format: { type: "json" } },
      ],
    },
    fallback: "generic",
  });
  const documents = [
    renderer("fact-one", "fact"),
    renderer("fact-two", "fact"),
    renderer("resource-one", "resource"),
    renderer("history-one", "history"),
  ];
  await importConfigurations(
    page,
    documents.map((document) => ({ id: document.id, source: JSON.stringify(document) })),
  );
  for (const document of documents) {
    await openConfiguration(page, document.id);
    await page.getByText("Share through guarded resources and catalog", { exact: true }).click();
    await page
      .getByLabel("Configuration resource ID", { exact: true })
      .fill(`config-${document.id}`);
    await page.getByLabel("Catalog resource ID", { exact: true }).fill("shared-catalog");
    await expect(
      page.getByRole("button", { name: "Review shared publication", exact: true }),
    ).toBeEnabled();
    await reviewSharedPublication(
      page,
      companion,
      browserDiagnostics,
      document === documents[0]
        ? [`config-${document.id}`, "shared-catalog"]
        : [`config-${document.id}`],
      info,
    );
    const captured = editorPanel(page, "Captured shared publication");
    await expect(
      captured.getByRole("button", { name: "Execute saved request", exact: true }),
    ).toBeEnabled();
    await expect(captured.getByText("fixture-author", { exact: true })).toBeVisible();
    await captured.getByRole("button", { name: "Execute saved request", exact: true }).click();
    await expect(captured.getByRole("status").filter({ hasText: /^committed$/u })).toBeVisible();
    await page.getByRole("button", { name: "Close captured review", exact: true }).click();
  }
  await page.getByText("Verified shared catalog", { exact: true }).click();
  await page.getByRole("button", { name: "Read shared catalog", exact: true }).click();
  await expect(
    page.getByText(/Verified catalog shared-catalog · content version 4/u),
  ).toBeVisible();
  // SPA navigation preserves the launch-owned, verified exact registry.
  await page.getByRole("link", { name: "Facts", exact: true }).click();
  await page.getByLabel("New or existing fact key", { exact: true }).fill("Custom.subject");
  await page.getByRole("button", { name: "Inspect exact key", exact: true }).click();
  const fact = editorPanel(page, "Fact Custom.subject"),
    chooser = fact.getByLabel("Value renderer", { exact: true });
  await expect(chooser).toHaveValue("generic");
  await chooser.selectOption("auto");
  await expect(fact.getByText(/Multiple verified renderers match/u)).toBeVisible();
  await chooser.selectOption({ label: "fact-one · config-fact-one@1" });
  await expect(fact.getByText("Observed summary", { exact: true })).toBeVisible();
  await expect(fact.getByText("Observed subject", { exact: true })).toBeVisible();
  await expect(fact.getByText("Original viewer · Source / Raw", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Resources", exact: true }).click();
  await page
    .getByRole("complementary", { name: "Resource directory", exact: true })
    .getByRole("button")
    .filter({ has: page.locator("strong").filter({ hasText: /^Subject resource$/u }) })
    .click();
  const resource = editorPanel(page, "subject.json · content v1");
  await expect(resource.getByLabel("Value renderer", { exact: true })).toBeVisible();
  await resource
    .getByLabel("Value renderer", { exact: true })
    .selectOption({ label: "resource-one · config-resource-one@1" });
  await expect(resource.getByText("Observed summary", { exact: true })).toBeVisible();
  const selectedRenderer = await resource
    .getByLabel("Value renderer", { exact: true })
    .inputValue();
  await page.getByRole("button", { name: "Published versions", exact: true }).click();
  await page.getByRole("button", { name: "Open content v1", exact: true }).click();
  await expect(page).toHaveURL(/content_version=1/u);
  // Let the route's selection effect commit: an exact same-pin transition must
  // keep this already interactive viewer and its deliberate renderer choice.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(resource.getByLabel("Value renderer", { exact: true })).toHaveValue(
    selectedRenderer,
  );
  await expect(resource.getByText("Observed summary", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "History", exact: true }).click();
  await page.getByRole("button", { name: "Renderer history subject", exact: false }).click();
  const event = page.locator("#history-event-1");
  const eventToggle = event.locator(":scope > header > button[aria-expanded]");
  if ((await eventToggle.getAttribute("aria-expanded")) !== "true") await eventToggle.click();
  const historyChooser = event.getByLabel("Value renderer", { exact: true });
  await expect(historyChooser).toBeVisible();
  await historyChooser.selectOption({ label: "history-one · config-history-one@1" });
  await expect(event.getByText("Observed summary", { exact: true })).toBeVisible();
  await expect(event.getByText("Original viewer · Source / Raw", { exact: true })).toBeVisible();
  await editorScreenshot(page, info, "exact-history-renderer-original-retained");
  expect(browserFailures).toEqual([]);
});
