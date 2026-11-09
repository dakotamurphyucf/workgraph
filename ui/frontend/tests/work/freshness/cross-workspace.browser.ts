import { test, expect } from "../../e2e/support/fixtures";

test.use({ colorScheme: "dark", viewport: { width: 1440, height: 1000 } });
test("Advanced write invalidates only its actual workspace, preserving the selected Work capture", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = async (method: string, params: Record<string, unknown>, mutation_id: string) =>
    daemon.call(
      method,
      JSON.stringify({
        workspace_id: "actual",
        actor_id: "fixture-author",
        mutation_id,
        ...params,
      }),
    );
  await write(
    "workspace.create",
    { name: "Actual write workspace", root: `${daemon.root}/actual-workspace` },
    "cross-create-workspace",
  );
  await write(
    "project.create",
    { project_id: "release", title: "Actual write project" },
    "cross-create-project",
  );
  await write(
    "ticket.create",
    { project_id: "release", ticket_id: "design", title: "Actual workspace repeated ticket" },
    "cross-create-ticket",
  );
  const beforeA = await daemon.call("ticket.read", '{"workspace_id":"demo","ticket_id":"design"}');
  const beforeB = JSON.parse(
    await daemon.call("ticket.read", '{"workspace_id":"actual","ticket_id":"design"}'),
  ) as { result: { data: { ticket: { revision: string } } } };
  const bootstrap = await page.request.get(companion.url);
  expect(bootstrap.status()).toBe(200);
  const capability = (await bootstrap.text()).match(
    /<meta name="workgraph-capability" content="([a-f0-9]{64})"/u,
  )?.[1];
  if (!capability) throw new Error("Missing capability");
  for (const [endpoint, data] of [
    [
      "/connections",
      { id: "local", label: "Cross-workspace original endpoint", socket: daemon.socket },
    ],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const reply = await page.request.post(new URL(`/ui-api/v1${endpoint}`, companion.url).href, {
      headers: { "X-Workgraph-UI-Capability": capability, Origin: new URL(companion.url).origin },
      data,
    });
    expect(reply.status()).toBe(200);
    await reply.text();
  }
  await page.goto(
    new URL("/#/work?connection=local&workspace=demo&project=release", companion.url).href,
  );
  await expect(page.getByRole("heading", { name: "Tickets", exact: true })).toBeVisible();
  await expect(
    page.getByText("Clarify the workflow and ownership rules", { exact: true }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill("fixture-author");
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  await page.waitForLoadState("networkidle");
  const selectedReads: string[] = [];
  page.on("request", (request) => {
    if (!request.url().endsWith("/read")) return;
    const body = request.postDataJSON() as {
      method?: string;
      params?: { workspace_id?: string };
    } | null;
    if (body?.params?.workspace_id === "demo" && body.method?.startsWith("ticket."))
      selectedReads.push(body.method);
  });
  await page.getByRole("link", { name: "Advanced", exact: false }).first().click();
  const root = page.locator("#root");
  await root.getByRole("button", { name: "Methods", exact: true }).click();
  await root.getByLabel("Search catalogue").fill("ticket.update");
  await root
    .locator(".adv-item")
    .filter({ has: page.locator("code", { hasText: /^ticket\.update$/u }) })
    .click();
  await root.getByRole("button", { name: "New draft for ticket.update", exact: true }).click();
  await root.getByRole("button", { name: "Raw JSON", exact: true }).click();
  await root.getByLabel("Exact parameter source").fill(
    JSON.stringify({
      workspace_id: "actual",
      actor_id: "fixture-author",
      ticket_id: "design",
      expected_revision: beforeB.result.data.ticket.revision,
      title: "Written only to actual workspace — 雪",
    }),
  );
  await root.getByRole("button", { name: "Validate & prepare", exact: true }).click();
  await expect(root.locator(".wg-badge").filter({ hasText: /^prepared_unsent$/u })).toBeVisible();
  await root.getByRole("button", { name: "Execute saved request", exact: true }).click();
  await expect(root.locator(".wg-badge").filter({ hasText: /^committed$/u })).toBeVisible();
  const afterA = await daemon.call("ticket.read", '{"workspace_id":"demo","ticket_id":"design"}');
  const afterB = await daemon.call("ticket.read", '{"workspace_id":"actual","ticket_id":"design"}');
  const record = (source: string) =>
    (JSON.parse(source) as { readonly result: { readonly data: { readonly ticket: unknown } } })
      .result.data.ticket;
  expect(record(afterA)).toEqual(record(beforeA));
  expect(afterB).toContain("Written only to actual workspace — 雪");
  await page.evaluate(() => {
    location.hash = "/work?connection=local&workspace=demo&project=release";
  });
  await expect(page.getByRole("heading", { name: "Tickets", exact: true })).toBeVisible();
  await expect(
    page.getByText("Clarify the workflow and ownership rules", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("status", { name: "Captured work freshness" })).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  expect(selectedReads).toEqual([]);
  const screenshot = info.outputPath("selected-workspace-capture-unchanged.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  await info.attach("selected-workspace-capture-unchanged", {
    path: screenshot,
    contentType: "image/png",
  });
  await page.evaluate(() => {
    location.hash = "/work?connection=local&workspace=actual&project=release";
  });
  await expect(
    page.getByText("Written only to actual workspace — 雪", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("status", { name: "Captured work freshness" })).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  await info.attach("native-cross-workspace-readback", {
    contentType: "application/json",
    body: JSON.stringify({
      selectedBefore: beforeA,
      selectedAfter: afterA,
      actualAfter: afterB,
      automaticSelectedReads: selectedReads,
    }),
  });
  expect(browserFailures).toEqual([]);
});
