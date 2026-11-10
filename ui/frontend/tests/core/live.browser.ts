import { trackPageReads, waitForPageReads } from "../e2e/support/readiness";
import { test, expect } from "../e2e/support/fixtures";

test.setTimeout(90000);
test("background overview keeps observing and refreshes only after a real change", async ({
  page,
  daemon,
  companion,
  browserDiagnostics,
}, info) => {
  const html = await (await page.request.get(companion.url)).text();
  const capability = html.match(/<meta name="workgraph-capability" content="([a-f0-9]{64})"/u)?.[1];
  if (!capability) throw new Error("Missing capability");
  const origin = new URL(companion.url).origin;
  const response = await page.request.post(`${origin}/ui-api/v1/connections`, {
    headers: { "X-Workgraph-UI-Capability": capability, Origin: origin },
    data: { id: "local", label: "Live test", socket: daemon.socket },
  });
  expect(response.status()).toBe(200);
  const requests: { path: string; method: unknown }[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/ui-api/"))
      requests.push({
        path: new URL(request.url()).pathname,
        method:
          request.method() === "POST"
            ? (request.postDataJSON() as { method?: unknown }).method
            : request.method(),
      });
  });
  await page.goto(`${origin}/#/overview?connection=local&workspace=demo&project=release`);
  await expect(page.locator(".wg-live-indicator")).toHaveText("Live");
  // Wait for the initial observer-fenced refresh and incidental mounts to settle.
  await page.waitForTimeout(1500);
  // Simulate the browser lifecycle signal deterministically in headless Chrome.
  // Actual browser tab suspension is outside application control.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const start = requests.length;
  // Cross a full long-poll timeout, not just the removed three-second timer.
  await page.waitForTimeout(27000);
  const idle = requests.slice(start);
  expect(idle.length).toBeGreaterThanOrEqual(1);
  expect(idle.every((request) => request.path === "/ui-api/v1/live-observations")).toBe(true);
  expect(idle.length).toBeLessThanOrEqual(2);
  const changed = page.waitForRequest(
    (request) =>
      request.url().endsWith("/ui-api/v1/read") &&
      (request.postDataJSON() as { method?: string }).method === "project.brief",
  );
  const mutation = JSON.parse(
    await daemon.call(
      "ticket.create",
      JSON.stringify({
        workspace_id: "demo",
        actor_id: "test-author",
        mutation_id: "live-change",
        ticket_id: "live-changed-ticket",
        project_id: "release",
        title: "Arrived through live observation",
      }),
    ),
  ) as { error?: unknown };
  expect(mutation.error).toBeUndefined();
  await changed;
  await expect(
    page.getByText("Arrived through live observation", { exact: true }).first(),
  ).toBeVisible();
  await waitForPageReads(page);
  const beforeReturn = requests.length;
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
  await page.waitForTimeout(500);
  expect(
    requests
      .slice(beforeReturn)
      .every((request) => request.path === "/ui-api/v1/live-observations"),
  ).toBe(true);
  await info.attach("idle-request-counts", {
    contentType: "application/json",
    body: JSON.stringify({ idleMilliseconds: 27000, requests: idle }, null, 2),
  });
  browserDiagnostics.markPendingReads();
});

test("three visible windows receive changes and repeated reloads release observations", async ({
  page,
  browser,
  daemon,
  companion,
  browserDiagnostics,
}) => {
  const html = await (await page.request.get(companion.url)).text();
  const capability = html.match(/<meta name="workgraph-capability" content="([a-f0-9]{64})"/u)?.[1];
  if (!capability) throw new Error("Missing capability");
  const origin = new URL(companion.url).origin;
  const response = await page.request.post(`${origin}/ui-api/v1/connections`, {
    headers: { "X-Workgraph-UI-Capability": capability, Origin: origin },
    data: { id: "local", label: "Multi-tab test", socket: daemon.socket },
  });
  expect(response.status()).toBe(200);
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    const pages = [page, ...(await Promise.all(contexts.map((context) => context.newPage())))];
    for (const current of pages) trackPageReads(current);
    const url = `${origin}/#/overview?connection=local&workspace=demo&project=release`;
    await Promise.all(
      pages.map(async (current) => {
        await current.goto(url);
        await expect(current.locator(".wg-live-indicator")).toHaveText("Live");
        await waitForPageReads(current);
      }),
    );
    // Every window has an outstanding native wait. More than two must still work.
    for (let index = 0; index < 18; index++) {
      browserDiagnostics.markPendingReads();
      browserDiagnostics.markPendingDirectoryReads();
      await page.reload();
      await expect(page.locator(".wg-live-indicator")).toHaveText("Live");
      await waitForPageReads(page);
    }
    const updates = pages.map((current) =>
      current.waitForRequest(
        (request) =>
          request.url().endsWith("/ui-api/v1/read") &&
          (request.postDataJSON() as { method?: string }).method === "project.brief",
      ),
    );
    const mutation = JSON.parse(
      await daemon.call(
        "ticket.create",
        JSON.stringify({
          workspace_id: "demo",
          actor_id: "test-author",
          mutation_id: "multi-tab-change",
          ticket_id: "multi-tab-ticket",
          project_id: "release",
          title: "Update seen in every window",
        }),
      ),
    ) as { error?: unknown };
    expect(mutation.error).toBeUndefined();
    await Promise.all(updates);
    await Promise.all(
      pages.map((current) =>
        expect(
          current.getByText("Update seen in every window", { exact: true }).first(),
        ).toBeVisible(),
      ),
    );
    browserDiagnostics.markPendingReads();
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("page navigation retains compatible observation and drains changed feeds normally", async ({
  page,
  daemon,
  companion,
  browserDiagnostics,
}) => {
  const html = await (await page.request.get(companion.url)).text();
  const capability = html.match(/<meta name="workgraph-capability" content="([a-f0-9]{64})"/u)?.[1];
  if (!capability) throw new Error("Missing capability");
  const origin = new URL(companion.url).origin;
  const created = await page.request.post(`${origin}/ui-api/v1/connections`, {
    headers: { "X-Workgraph-UI-Capability": capability, Origin: origin },
    data: { id: "local", label: "Navigation test", socket: daemon.socket },
  });
  expect(created.status()).toBe(200);
  const observations: import("@playwright/test").Request[] = [];
  const cancels: import("@playwright/test").Request[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/live-observations")) observations.push(request);
    if (request.url().endsWith("/live-observations/cancel")) cancels.push(request);
  });
  await page.goto(`${origin}/#/work?connection=local&workspace=demo&project=release`);
  await expect(page.locator(".wg-live-indicator")).toHaveText("Live");
  await waitForPageReads(page);
  await expect
    .poll(() =>
      observations.some(
        (r) => (r.postDataJSON() as { observation: { wait: boolean } }).observation.wait,
      ),
    )
    .toBe(true);
  const count = observations.length;
  const pending = observations.at(-1)!;
  for (const view of ["facts", "activity", "work", "resources", "work"]) {
    await page.evaluate((view) => {
      window.location.hash = `/${view}?connection=local&workspace=demo&project=release`;
    }, view);
    await waitForPageReads(page);
    await expect(page.locator(".wg-live-indicator")).toHaveText("Live");
    expect(observations.length).toBe(count);
    expect(cancels).toHaveLength(0);
  }
  await page.evaluate(() => {
    window.location.hash = "/history?connection=local&workspace=demo&project=release";
  });
  await expect.poll(() => cancels.length).toBe(1);
  const response = await pending.response();
  expect(response?.status()).toBe(200);
  expect(await response?.json()).toMatchObject({ ok: true, data: { cancelled: true } });
  expect(pending.failure()).toBeNull();
  await expect(page.locator(".wg-live-indicator")).toHaveText("Live");
  await waitForPageReads(page);
  browserDiagnostics.markPendingReads();
});
