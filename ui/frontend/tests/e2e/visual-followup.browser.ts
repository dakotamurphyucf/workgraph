import { waitForPageReads } from "./support/readiness";
import type { Page, TestInfo } from "@playwright/test";
import type { CompanionFixture } from "../../../test-support/companion-fixture.mjs";
import type { DaemonFixture } from "../../../test-support/daemon-fixture.mjs";
import { test, expect } from "./support/fixtures";
test.use({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", actionTimeout: 10000 });
test.setTimeout(60000);
type RecordValue = Record<string, unknown>;
function object(v: unknown): RecordValue {
  if (v === null || typeof v !== "object" || Array.isArray(v))
    throw new Error("Expected native object");
  return Object.fromEntries(Object.entries(v));
}
async function read(daemon: DaemonFixture, method: string, p: RecordValue) {
  const envelope = object(
    JSON.parse(await daemon.call(method, JSON.stringify({ workspace_id: "demo", ...p }))),
  );
  if (envelope.error !== undefined) throw new Error(JSON.stringify(envelope.error));
  return object(object(envelope.result).data);
}
function writer(daemon: DaemonFixture) {
  let n = 0;
  return (method: string, p: RecordValue) =>
    read(daemon, method, {
      actor_id: "fixture-author",
      mutation_id: `visual-followup-${++n}`,
      ...p,
    });
}
async function setup(
  page: Page,
  companion: CompanionFixture,
  daemon: DaemonFixture,
  query: string,
) {
  const html = await (await page.request.get(companion.url)).text();
  const cap = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(html)?.[1];
  if (!cap) throw new Error("Missing bootstrap capability");
  for (const [path, data] of [
    ["connections", { id: "local", label: "Visual followup", socket: daemon.socket }],
    ["connections/local/attach", { generation: "1" }],
  ] as const) {
    const response = await page.request.post(new URL(`/ui-api/v1/${path}`, companion.url).href, {
      headers: { Origin: new URL(companion.url).origin, "X-Workgraph-UI-Capability": cap },
      data,
    });
    expect(response.status(), await response.text()).toBe(200);
  }
  await page.goto(new URL(`/#/${query}`, companion.url).href);
  await waitForPageReads(page);
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill("fixture-author");
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  await waitForPageReads(page);
}
async function shot(page: Page, info: TestInfo, name: string) {
  await waitForPageReads(page);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const geometry = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    documentWidth: document.documentElement.scrollWidth,
    roots: document.querySelectorAll("#root").length,
  }));
  expect(geometry.roots).toBe(1);
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.width);
  const path = info.outputPath(name + ".png");
  await page.screenshot({ path, fullPage: false });
  await info.attach(name, { path, contentType: "image/png" });
  await info.attach(name + "-geometry", {
    body: JSON.stringify(geometry),
    contentType: "application/json",
  });
}

test("visual Discussions compact messages preserve exact source and discoverable actions with adjustable collection", async ({
  page,
  daemon,
  companion,
}, info) => {
  const write = writer(daemon);
  await write("comment.add", {
    comment_id: "visual-short",
    target: { kind: "ticket", id: "design" },
    body: "Ready for **review**.\n\n```ocaml\nlet answer = 42\n```",
    kind: "comment",
  });
  await write("comment.add", {
    comment_id: "visual-next",
    target: { kind: "ticket", id: "design" },
    body: "I will check the original capture.",
    kind: "comment",
  });
  await setup(
    page,
    companion,
    daemon,
    "discussions?connection=local&workspace=demo&project=release&entity=design&discussion=ticket&generation=1",
  );
  const card = page
    .locator(".wg-panel")
    .filter({ has: page.getByRole("heading", { name: "Ticket discussion", exact: true }) })
    .getByRole("article", { name: "Comment visual-short revision 1", exact: true });
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByText("review", { exact: true })).toBeVisible();
  await expect(card.locator("code")).toContainText("let answer = 42");
  const time = card.locator("header time").first();
  const exact = await time.getAttribute("title");
  expect(exact).toMatch(/Z$/u);
  expect(await time.innerText()).not.toBe(exact);
  await expect(card.getByRole("button", { name: "Reply", exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Edit own comment", exact: true })).toBeHidden();
  const more = card.locator("summary").filter({ hasText: /^More actions$/u });
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(card.getByRole("button", { name: "Edit own comment", exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Comment history", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Comment history", exact: true })).toBeVisible();
  await more.click();
  await card.getByRole("button", { name: "Source and display controls", exact: true }).click();
  await card.getByRole("button", { name: "Source", exact: true }).click();
  await expect
    .poll(() => card.locator(".wg-rich-content code").textContent())
    .toBe("Ready for **review**.\n\n```ocaml\nlet answer = 42\n```");
  await card.getByRole("button", { name: "Rendered", exact: true }).click();
  await card.getByRole("button", { name: "Hide source and display controls", exact: true }).click();
  const separator = page.getByRole("separator", {
    name: "Resize discussion collection",
    exact: true,
  });
  await separator.focus();
  await page.keyboard.press("End");
  await expect(separator).toHaveAttribute("aria-valuenow", "440");
  await page.keyboard.press("Home");
  await expect(separator).toHaveAttribute("aria-valuenow", "240");
  const bounds = await separator.boundingBox();
  if (!bounds) throw new Error("Missing separator");
  await page.mouse.move(bounds.x + 3, bounds.y + 20);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 63, bounds.y + 20);
  await page.mouse.up();
  await expect(separator).toHaveAttribute("aria-valuenow", "300");
  await card.scrollIntoViewIfNeeded();
  const height = await card.evaluate((e) => e.getBoundingClientRect().height);
  expect(height).toBeLessThan(420);
  await info.attach("message-height", {
    body: JSON.stringify({
      height,
      fixture: "two short Markdown messages; one contains three-line fenced code",
    }),
    contentType: "application/json",
  });
  await shot(page, info, "discussions-readable-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 844 });
  await card.scrollIntoViewIfNeeded();
  await expect(separator).toBeHidden();
  await expect(card.getByRole("button", { name: "Reply", exact: true })).toBeVisible();
  await shot(page, info, "discussions-readable-light-390");
});

test("visual Participants recorded identity leads without duplicate headings or empty paging", async ({
  page,
  daemon,
  companion,
}, info) => {
  const write = writer(daemon);
  await write("run.register", {
    target_run_id: "visual-invocation",
    objective: "Inspect this recorded invocation; no process is launched",
  });
  await setup(
    page,
    companion,
    daemon,
    "participants?connection=local&workspace=demo&project=release&entity=visual-invocation&participant=run&generation=1",
  );
  const root = page.getByRole("region", { name: "Participants", exact: true });
  await expect(page.getByRole("heading", { name: "Participants", exact: true })).toHaveCount(1);
  await expect(
    root.getByRole("heading", { name: "Run visual-invocation", exact: true }),
  ).toBeVisible();
  await expect(
    root.getByText("No sessions associated at this captured History head.", { exact: true }),
  ).toBeVisible();
  await expect(
    root.getByRole("button", { name: "Next session associations", exact: true }),
  ).toHaveCount(0);
  await expect(
    root.getByRole("group", { name: "Captured page continuation", exact: true }),
  ).toHaveCount(0);
  await expect(root.getByText(/not live process monitoring/u)).toBeVisible();
  await shot(page, info, "participants-recorded-identity-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 844 });
  await root
    .getByRole("heading", { name: "Run visual-invocation", exact: true })
    .scrollIntoViewIfNeeded();
  await shot(page, info, "participants-recorded-identity-light-390");
});

test("visual request wait fields wrap accessibly and retain exact pinned answer", async ({
  page,
  daemon,
  companion,
}, info) => {
  const write = writer(daemon),
    thread = await read(daemon, "thread.get", { thread_id: "planning" });
  await write("request.ask", {
    request_id: "visual-wait",
    kind: "clarification",
    resolver_id: "fixture-author",
    recipients: [{ kind: "actor", id: "human" }],
    thread_id: "planning",
    expected_thread_revision: thread.revision,
    body: "Review the captured result",
  });
  const request = await read(daemon, "request.get", { request_id: "visual-wait" });
  await write("request.resolve", {
    request_id: "visual-wait",
    expected_revision: request.revision,
    body: "Original **pinned answer**",
  });
  const resolvedSnapshot = await read(daemon, "request.get", { request_id: "visual-wait" });
  expect(resolvedSnapshot.status).toMatchObject({ kind: "resolved" });
  await setup(
    page,
    companion,
    daemon,
    "discussions?connection=local&workspace=demo&project=release&req_view=request&req_generation=1&req_id=visual-wait",
  );
  const panel = page.getByRole("region", { name: "Foreground request wait", exact: true });
  await panel.getByLabel("Wait total milliseconds", { exact: true }).fill("1000");
  await panel.getByLabel("Wait poll interval milliseconds", { exact: true }).fill("250");
  await panel.getByRole("button", { name: "Start wait", exact: true }).click();
  await expect(panel.getByText("Resolved with a pinned answer.", { exact: true })).toBeVisible();
  await panel.locator(".wg-discussion-body").scrollIntoViewIfNeeded();
  await expect(panel.getByText("pinned answer", { exact: true })).toBeVisible();
  await panel.scrollIntoViewIfNeeded();
  await shot(page, info, "request-wait-pinned-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  const a = await panel.getByLabel("Wait total milliseconds", { exact: true }).boundingBox(),
    b = await panel.getByLabel("Wait poll interval milliseconds", { exact: true }).boundingBox();
  if (!a || !b) throw new Error("Missing wait fields");
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height + 8);
  await shot(page, info, "request-wait-pinned-light-390");
  expect(await read(daemon, "request.get", { request_id: "visual-wait" })).toEqual(
    resolvedSnapshot,
  );
});

test("visual remaining Overview Facts and retained lifecycle scope are captured without executing drafts", async ({
  page,
  daemon,
  companion,
  browserDiagnostics,
}, info) => {
  const write = writer(daemon);
  await write("fact.put", {
    scope: { kind: "project", id: "release" },
    key: "visual-null",
    expected_revision: "0",
    value: null,
  });
  await setup(page, companion, daemon, "overview?connection=local&workspace=demo&project=release");
  await expect(page.locator(".ov-counts strong").first()).toBeVisible();
  await shot(page, info, "overview-current-dark");
  await page.getByText("Workspace and project management", { exact: true }).click();
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Unsent original endpoint draft");
  const html = await (await page.request.get(companion.url)).text(),
    cap = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(html)?.[1];
  if (!cap) throw new Error("Missing capability");
  for (const [path, data] of [
    ["connections", { id: "mirror", label: "Other selected profile", socket: daemon.socket }],
    ["connections/mirror/attach", { generation: "1" }],
  ] as const) {
    const r = await page.request.post(new URL(`/ui-api/v1/${path}`, companion.url).href, {
      headers: { Origin: new URL(companion.url).origin, "X-Workgraph-UI-Capability": cap },
      data,
    });
    expect(r.status(), await r.text()).toBe(200);
  }
  await page.getByRole("button", { name: "Refresh connection", exact: true }).click();
  await waitForPageReads(page);
  browserDiagnostics.markPendingReads();
  await page.evaluate(() => {
    location.hash = "#/overview?connection=mirror&workspace=demo&project=release";
  });
  await expect(page.locator(".ov-counts strong").first()).toBeVisible();
  const management = page.getByText("Workspace and project management", { exact: true });
  if (!(await management.locator("..").evaluate((e) => (e as HTMLDetailsElement).open)))
    await management.click();
  const title = page.getByLabel("Title", { exact: true });
  await expect(title).toHaveValue("Unsent original endpoint draft");
  await title.scrollIntoViewIfNeeded();
  await expect(page.getByText(/Draft captured actor/u)).toContainText(
    "original endpoint Visual followup (generation 1)",
  );
  await shot(page, info, "lifecycle-retained-original-target-dark");
  await info.attach("retained-label-text", {
    body: await page.getByText(/Draft captured actor/u).innerText(),
    contentType: "text/plain",
  });
  browserDiagnostics.markPendingReads();
  await page.evaluate(() => {
    location.hash = "#/facts?connection=local&workspace=demo&project=release";
  });
  await page.getByLabel("New or existing fact key", { exact: true }).fill("visual-null");
  await page.getByRole("button", { name: "Inspect exact key", exact: true }).click();
  const fact = page
    .locator(".wg-panel")
    .filter({ has: page.getByRole("heading", { name: "Fact visual-null", exact: true }) });
  await expect(fact).toBeVisible();
  await page.evaluate(() => {
    for (const e of document.querySelectorAll<HTMLElement>(".wg-content")) e.scrollTop = 0;
    window.scrollTo(0, 0);
  });
  expect(await fact.evaluate((e) => e.getBoundingClientRect().top)).toBeLessThan(400);
  await shot(page, info, "facts-null-ordinary-top-dark");
  await info.attach("facts-value-position", {
    body: JSON.stringify(
      await fact.evaluate((e) => ({
        top: e.getBoundingClientRect().top,
        height: e.getBoundingClientRect().height,
        viewport: innerHeight,
      })),
    ),
    contentType: "application/json",
  });
  expect(
    await read(daemon, "fact.get", {
      scope: { kind: "project", id: "release" },
      key: "visual-null",
    }),
  ).toMatchObject({ value: null });
});

test("visual current long comparison and raster remain readable in ordinary settled viewports", async ({
  page,
  daemon,
  companion,
  browserDiagnostics,
}, info) => {
  const write = writer(daemon),
    left =
      Array.from({ length: 140 }, (_, i) => `Original record ${i}: reviewed value`).join("\n") +
      "\n",
    right =
      Array.from({ length: 140 }, (_, i) => `Updated record ${i}: exact new value`).join("\n") +
      "\n";
  for (const [revision, text] of [
    ["0", left],
    ["1", right],
  ] as const)
    await write("resource.put_text", {
      resource_id: "visual-diff",
      expected_revision: revision,
      title: "Reviewed long comparison",
      filename: "review.txt",
      mime_type: "text/plain",
      text,
    });
  await setup(
    page,
    companion,
    daemon,
    "resources?connection=local&workspace=demo&entity=visual-diff&resource_generation=1&content_version=1",
  );
  const viewer = page.getByRole("region", {
    name: "Resource rich content and comparison",
    exact: true,
  });
  await expect(viewer).toBeVisible();
  await viewer.getByText("Compare immutable content versions", { exact: true }).click();
  await viewer.getByLabel("Right content version", { exact: true }).fill("2");
  await viewer.getByRole("button", { name: "Load exact comparison", exact: true }).click();
  const diff = viewer.locator(".wg-text-diff");
  await expect(diff).toContainText("Updated record 139");
  await diff.scrollIntoViewIfNeeded();
  await shot(page, info, "long-diff-dark-1440");
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 844 });
  await diff.scrollIntoViewIfNeeded();
  await shot(page, info, "long-diff-light-390");
  await page.setViewportSize({ width: 1440, height: 900 });
  const encoded = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 640;
    c.height = 360;
    const g = c.getContext("2d");
    if (!g) throw new Error("No fixture canvas");
    g.fillStyle = "#254e7a";
    g.fillRect(0, 0, 640, 360);
    g.fillStyle = "#e4efff";
    g.fillRect(40, 60, 560, 60);
    g.fillStyle = "#f2ad4f";
    g.fillRect(40, 160, 360, 140);
    return c.toDataURL("image/png").split(",")[1];
  });
  if (!encoded) throw new Error("Missing fixture PNG");
  const bytes = Buffer.from(encoded, "base64"),
    { createHash } = await import("node:crypto"),
    digest = createHash("sha256").update(bytes).digest("hex");
  const html = await (await page.request.get(companion.url)).text(),
    cap = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(html)?.[1];
  if (!cap) throw new Error("Missing bootstrap capability");
  const headers = { Origin: new URL(companion.url).origin, "X-Workgraph-UI-Capability": cap };
  async function api(path: string, data: object = {}) {
    const response = await page.request.post(new URL(`/ui-api/v1${path}`, companion.url).href, {
      headers,
      data,
    });
    expect(response.status(), await response.text()).toBe(200);
    return response;
  }
  await api("/resource-stages/prepare", {
    stage_id: "visual-raster-source",
    digest,
    size_bytes: String(bytes.length),
  });
  await api("/resource-stages/visual-raster-source/chunks", { offset: "0", data_base64: encoded });
  await api("/resource-stages/visual-raster-source/seal");
  await api("/resource-uploads/prepare", {
    stage_id: "visual-raster-source",
    preparation: {
      intention_id: "visual-raster-upload",
      connection_id: "local",
      generation: "1",
      context: {
        workspace_id: "demo",
        project_id: null,
        writer: { actor_id: "fixture-author", run_id: null },
      },
      method: "resource.upload",
      params: {
        workspace_id: "demo",
        actor_id: "fixture-author",
        resource_id: "visual-raster",
        expected_revision: "0",
        title: "Reviewed raster fixture",
        filename: "review.png",
        mime_type: "image/png",
      },
    },
  });
  await api("/resource-uploads/visual-raster-upload/start");
  await expect
    .poll(async () => {
      const response = await page.request.get(
        new URL("/ui-api/v1/resource-uploads/visual-raster-upload", companion.url).href,
        { headers },
      );
      return (await response.text()).includes('"kind":"published"');
    })
    .toBe(true);
  browserDiagnostics.markPendingReads();
  await page.evaluate((hash) => {
    location.hash = hash;
  }, `#/resources?connection=local&workspace=demo&entity=visual-raster&resource_generation=1&content_version=1&content_digest=${digest}`);
  const canvas = page.locator(".wg-raster-stage canvas");
  await expect(canvas).toHaveCount(1);
  await expect(canvas).toBeVisible();
  expect(await canvas.evaluate((c: HTMLCanvasElement) => [c.width, c.height])).toEqual([640, 360]);
  await canvas.scrollIntoViewIfNeeded();
  await shot(page, info, "raster-light-1440");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 844 });
  await canvas.scrollIntoViewIfNeeded();
  await shot(page, info, "raster-dark-390");
  await info.attach("visual-content-workload", {
    body: JSON.stringify({
      textLinesPerVersion: 140,
      leftBytes: Buffer.byteLength(left),
      rightBytes: Buffer.byteLength(right),
      rasterWidth: 640,
      rasterHeight: 360,
      rasterBytes: bytes.length,
      rasterDigest: digest,
    }),
    contentType: "application/json",
  });
});
