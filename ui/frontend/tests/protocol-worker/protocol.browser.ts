import { build } from "vite";
import { fileURLToPath } from "node:url";
import { test, expect } from "../e2e/support/fixtures";
import type { BridgeAsset } from "../e2e/support/bridge-build";
import type {} from "./browser.fixture";
const assets = new Map<string, BridgeAsset>();
test.beforeAll(async () => {
  const output = await build({
    configFile: false,
    root: fileURLToPath(new URL("../../", import.meta.url)),
    base: "/__protocol_fixture__/",
    logLevel: "error",
    define: { "process.env.NODE_ENV": '"production"' },
    build: {
      write: false,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL("./browser.fixture.ts", import.meta.url)),
        formats: ["es"],
        fileName: () => "entry.js",
      },
    },
  });
  for (const result of Array.isArray(output) ? output : [output])
    if ("output" in result)
      for (const member of result.output)
        assets.set(`/__protocol_fixture__/${member.fileName}`, {
          body: member.type === "chunk" ? member.code : member.source,
          contentType: "text/javascript",
        });
});
test("full protocol budgets stay responsive, cancellable and exact over owned native services", async ({
  page,
  context,
  companion,
  daemon,
  browserFailures,
}, info) => {
  test.setTimeout(120000);
  await context.route("**/__protocol_fixture__/**", (route) => {
    const asset = assets.get(new URL(route.request().url()).pathname);
    return asset
      ? route.fulfill({
          status: 200,
          contentType: asset.contentType,
          body: typeof asset.body === "string" ? asset.body : Buffer.from(asset.body),
        })
      : route.fulfill({ status: 404 });
  });
  const full = '{"ok":true,"data":"' + "x".repeat(16 * 1024 * 1024 - 21) + '"}';
  expect(Buffer.byteLength(full)).toBe(16 * 1024 * 1024);
  // Explicit synthetic endpoint qualifies accepted response size; native APIs remain untouched.
  await context.route("**/ui-api/v1/protocol-qualification", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "content-length": String(Buffer.byteLength(full)) },
      body: full,
    }),
  );
  await page.goto(companion.url);
  await page.evaluate(async (socket) => {
    const capability = document
      .querySelector('meta[name="workgraph-capability"]')
      ?.getAttribute("content");
    if (!capability) throw new Error("Missing capability");
    for (const [path, body] of [
      ["/connections", { id: "local", label: "Protocol fixture", socket }],
      ["/connections/local/attach", { generation: "1" }],
    ] as const) {
      const response = await fetch(`/ui-api/v1${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Workgraph-UI-Capability": capability },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`Native setup ${response.status}`);
      await response.text();
    }
  }, daemon.socket);
  await page.addScriptTag({
    type: "module",
    url: new URL("/__protocol_fixture__/entry.js", companion.url).href,
  });
  await page.waitForFunction(() => window.protocolProbe !== undefined);
  const small = await page.evaluate(() => window.protocolProbe.small());
  expect(Math.max(...small.slice(1))).toBeLessThan(100);
  const metrics = [];
  for (const kind of ["graph", "full", "native"] as const) {
    if (kind === "native") await context.unrouteAll({ behavior: "wait" });
    await page.evaluate((kind) => {
      window.protocolProbe.pending = window.protocolProbe.run(kind);
    }, kind);
    await page.locator("#protocol-click").click();
    await page.getByLabel("Protocol responsiveness input").fill(`responsive-${kind}`);
    const result = await page.evaluate(() => window.protocolProbe.pending);
    if (!result) throw new Error("Missing metrics");
    expect(result.clicks).toBe(metrics.length + 1);
    // Includes browser/OS scheduling; renderer long tasks are checked separately.
    expect(result.maxGap).toBeLessThan(150);
    expect(result.longTasks).toEqual([]);
    expect(result.input).toBe(`responsive-${kind}`);
    metrics.push(result);
    await info.attach(`protocol-${kind}`, {
      contentType: "application/json",
      body: JSON.stringify(result, null, 2),
    });
  }
  await context.route("**/__protocol_fixture__/**", (route) => {
    const asset = assets.get(new URL(route.request().url()).pathname);
    return asset
      ? route.fulfill({
          status: 200,
          contentType: asset.contentType,
          body: typeof asset.body === "string" ? asset.body : Buffer.from(asset.body),
        })
      : route.fulfill({ status: 404 });
  });
  const cancellation = await page.evaluate(() => window.protocolProbe.cancel());
  expect(cancellation.cancelled).toMatchObject({ ok: false, failure: { kind: "aborted" } });
  expect(cancellation.after).toMatchObject({ ok: true, value: { ok: true } });
  await info.attach("protocol-responsiveness", {
    contentType: "application/json",
    body: JSON.stringify({ small, metrics, cancellation }, null, 2),
  });
  await page.screenshot({ path: info.outputPath("protocol-responsive.png"), fullPage: true });
  expect(browserFailures).toEqual([]);
  await page.evaluate(() => window.protocolProbe.dispose());
});
