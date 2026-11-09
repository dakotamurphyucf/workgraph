import { test, expect } from "./support/fixtures";

/** Metadata-only profile setup; arbitrary daemon values use production lossless client below. */
test("native shell, captured operation, exact read and independent durable write", async ({
  page,
  daemon,
  companion,
  bridge,
  browserFailures,
  browserDiagnostics,
}, info) => {
  void bridge;
  await expect(page.getByText("Connect your first daemon", { exact: true })).toBeVisible();
  await page.evaluate(
    async ({ socket }) => {
      const cap = document
        .querySelector('meta[name="workgraph-capability"]')
        ?.getAttribute("content");
      if (!cap) throw new Error("Missing launch capability");
      for (const [path, body] of [
        ["/connections", { id: "local", label: "Synthetic integration daemon", socket }],
        ["/connections/local/attach", { generation: "1" }],
      ] as const) {
        const response = await fetch(`/ui-api/v1${path}`, {
          method: "POST",
          headers: { "X-Workgraph-UI-Capability": cap, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`Fixture setup failed: ${response.status}`);
        await response.text();
      }
    },
    { socket: daemon.socket },
  );
  browserDiagnostics.markPendingDirectoryReads();
  await page.reload();
  await expect(page.getByText("Synthetic integration daemon").first()).toBeVisible();
  // Reinstall the memory-only test module after reload; production bootstrap remains intact.
  await page.addScriptTag({
    type: "module",
    url: new URL("/__workgraph-test__/client-bridge.js", companion.url).href,
  });
  await page.waitForFunction(() => window.workgraphIntegration !== undefined);
  const source = await page.evaluate(() =>
    window.workgraphIntegration.read({
      connection_id: "local",
      generation: "1",
      method: "fact.get",
      params:
        '{"workspace_id":"demo","scope":{"kind":"project","id":"release"},"key":"fixture.settings"}',
      lane: "visible",
    }),
  );
  expect(source).toContain("9007199254740993");
  expect(source).toContain('"exponent":1e99');
  expect(source).toContain('"negative_zero":-0');
  const preparation = JSON.stringify({
    intention_id: "integration-create",
    connection_id: "local",
    generation: "1",
    context: {
      workspace_id: "demo",
      project_id: "release",
      writer: { actor_id: "human", run_id: null },
    },
    method: "ticket.create",
    params: {
      workspace_id: "demo",
      actor_id: "human",
      project_id: "release",
      ticket_id: "browser-created",
      title: "Created by production operation controller",
    },
  });
  expect(
    await page.evaluate((source) => window.workgraphIntegration.register(source), preparation),
  ).toContain('"phase":"draft"');
  const prepared = await page.evaluate(() =>
    window.workgraphIntegration.act("integration-create", "prepare"),
  );
  expect(prepared).toContain('"state":"prepared_unsent"');
  // Navigate and change the visible actor. Captured operation identity must remain unchanged.
  await page.getByRole("button", { name: "No acting actor No run selected" }).click();
  await page.getByLabel("Acting actor ID").fill("another-actor");
  await page.getByRole("button", { name: "Use selection" }).click();
  await page.getByRole("link", { name: "History", exact: false }).first().click();
  const retained = await page.evaluate(() =>
    window.workgraphIntegration.snapshot("integration-create"),
  );
  expect(retained).toBe(prepared);
  let intercepted = 0;
  const executeUrl = /\/ui-api\/v1\/operations\/[^/]+\/execute$/u;
  await page.route(executeUrl, async (route) => {
    intercepted += 1;
    browserDiagnostics.expectedHTTP.set(route.request().url(), 503);
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"ok":false,"error":{"kind":"Unavailable","message":"Deliberate integration failure"}}',
    });
  });
  await expect(
    page.evaluate(() => window.workgraphIntegration.act("integration-create", "execute")),
  ).rejects.toThrow("Operation failure: remote");
  expect(
    await page.evaluate(() => window.workgraphIntegration.snapshot("integration-create")),
  ).toContain('"phase":"unconfirmed"');
  await expect(page.getByRole("link", { name: "History", exact: false }).first()).toBeVisible();
  expect(intercepted).toBe(1);
  await expect(
    daemon.call("ticket.get", '{"workspace_id":"demo","ticket_id":"browser-created"}'),
  ).rejects.toThrow("Not_found");
  // Explicit second click is required; no retry is initiated by navigation or transport failure.
  await page.unroute(executeUrl);
  await page.evaluate(() => window.workgraphIntegration.act("integration-create", "execute"));
  await expect
    .poll(async () =>
      page.evaluate(() => window.workgraphIntegration.act("integration-create", "inspect")),
    )
    .toContain('"state":"committed"');
  const committed = await page.evaluate(() =>
    window.workgraphIntegration.snapshot("integration-create"),
  );
  expect(committed).toContain('"actor":"human"');
  const exactRequest = await page.evaluate(() =>
    window.workgraphIntegration.exactRequest("integration-create"),
  );
  await page.evaluate(() => window.workgraphIntegration.act("integration-create", "recover"));
  expect(
    await page.evaluate(() => window.workgraphIntegration.exactRequest("integration-create")),
  ).toBe(exactRequest);
  const direct = await daemon.call(
    "ticket.get",
    '{"workspace_id":"demo","ticket_id":"browser-created"}',
  );
  expect(direct).toContain("Created by production operation controller");
  // A failed explicit directory refresh retains the saved endpoint without asserting daemon health.
  // Finish independent connection-dialog reads before introducing the directory-only outage.
  const capabilities = page.waitForResponse(
    (response) =>
      response.url() === new URL("/ui-api/v1/daemon-capabilities", companion.url).href &&
      response.request().method() === "GET",
  );
  const launches = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/ui-api/v1/daemon-launches" &&
      response.request().method() === "GET",
  );
  await page
    .getByRole("button", { name: "Synthetic integration daemon", exact: true })
    .first()
    .click();
  for (const response of await Promise.all([capabilities, launches])) {
    expect(response.status()).toBe(200);
    expect(await response.finished()).toBeNull();
  }
  await expect(page.getByText(/Paired core .* available/)).toBeVisible();
  await expect(page.locator("ul.wg-lifecycle-recent")).toHaveCount(1);
  const directoryUrl = new URL("/ui-api/v1/connections", companion.url).href;
  browserDiagnostics.expectedHTTP.set(directoryUrl, 503);
  await page.route(directoryUrl, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"ok":false,"error":{"kind":"Unavailable","message":"Deliberate directory outage"}}',
    }),
  );
  browserDiagnostics.markPendingDirectoryReads();
  await page.getByRole("button", { name: "Refresh profiles", exact: true }).click();
  await expect(
    page.getByText("Deliberate directory outage", { exact: false }).first(),
  ).toBeVisible();
  await expect(page.getByText("Synthetic integration daemon").first()).toBeVisible();
  expect(
    await page.evaluate(() => window.workgraphIntegration.exactRequest("integration-create")),
  ).toBe(exactRequest);
  await page.unroute(directoryUrl);
  await page.screenshot({ path: info.outputPath("native-shell.png"), fullPage: true });
  expect(browserFailures).toEqual([]);
});

test("actual Application renders and observes the same controller across scope remounts", async ({
  page,
  daemon,
  bridge,
}) => {
  void bridge;
  await page.evaluate(async (socket) => {
    const capability = document
      .querySelector('meta[name="workgraph-capability"]')
      ?.getAttribute("content");
    if (!capability) throw new Error("Missing launch capability");
    const response = await fetch("/ui-api/v1/connections", {
      method: "POST",
      headers: { "X-Workgraph-UI-Capability": capability, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "local", label: "Composition fixture", socket }),
    });
    if (!response.ok) throw new Error(`Profile setup failed: ${response.status}`);
    await response.text();
    window.location.hash = "#/work?connection=local&workspace=demo&project=release";
    window.workgraphIntegration.mountApplication();
  }, daemon.socket);
  const application = page.locator("#integration-application");
  await expect(application.getByTestId("composition-operations")).toHaveText("No draft");
  const before = await page.evaluate(() => window.workgraphIntegration.composition());
  expect(before.sameServices).toBe(true);
  const preparation = JSON.stringify({
    intention_id: "composition-draft",
    connection_id: "local",
    generation: "1",
    context: {
      workspace_id: "demo",
      project_id: "release",
      writer: { actor_id: "human", run_id: null },
    },
    method: "ticket.create",
    params: {
      workspace_id: "demo",
      actor_id: "human",
      project_id: "release",
      ticket_id: "not-submitted",
      title: "Captured draft",
    },
  });
  const draft = await page.evaluate(
    (source) => window.workgraphIntegration.register(source),
    preparation,
  );
  await expect(application.getByTestId("composition-operations")).toHaveText(
    "composition-draft:draft",
  );
  await application
    .getByRole("button", { name: "No acting actor No run selected", exact: true })
    .click();
  await application.getByLabel("Acting actor ID").fill("different-visible-actor");
  await application.getByRole("button", { name: "Use selection", exact: true }).click();
  expect(await page.evaluate(() => window.workgraphIntegration.snapshot("composition-draft"))).toBe(
    draft,
  );
  await application.getByRole("button", { name: "release", exact: true }).click();
  await application.getByText("Enter a project ID", { exact: true }).click();
  await application.getByLabel("Project ID (optional)").fill("another-project");
  await application.getByRole("button", { name: "Open scope" }).click();
  await expect(application.getByTestId("composition-operations")).toHaveText(
    "composition-draft:draft",
  );
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.workgraphIntegration.composition())).featureMounts,
    )
    .toBeGreaterThan(before.featureMounts);
  expect(await page.evaluate(() => window.workgraphIntegration.composition())).toMatchObject({
    sameServices: true,
  });
  expect(await page.evaluate(() => window.workgraphIntegration.snapshot("composition-draft"))).toBe(
    draft,
  );
  // The fixture renderer observes the exact services passed to real Application; no tailored UI write is claimed.
});
