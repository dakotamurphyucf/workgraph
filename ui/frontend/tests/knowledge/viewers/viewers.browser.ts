import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Page, TestInfo } from "@playwright/test";
import { test, expect } from "../../e2e/support/fixtures";
import type { CompanionFixture } from "../../../../test-support/companion-fixture.mjs";
import type { DaemonFixture } from "../../../../test-support/daemon-fixture.mjs";
import { fixtureBytes } from "./raster-fixtures";
test.setTimeout(90000);
test.use({ viewport: { width: 1500, height: 1000 }, colorScheme: "dark", actionTimeout: 15000 });
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function setup(page: Page, companion: CompanionFixture, daemon: DaemonFixture) {
  const html = await (await page.request.get(companion.url)).text(),
    cap = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(html)?.[1];
  if (!cap) throw new Error("Missing actual capability");
  const headers = { Origin: new URL(companion.url).origin, "X-Workgraph-UI-Capability": cap };
  async function api(method: "GET" | "POST", path: string, data?: object) {
    const url = new URL(`/ui-api/v1${path}`, companion.url).href,
      r =
        method === "GET"
          ? await page.request.get(url, { headers })
          : await page.request.post(url, { headers, data: data ?? {} });
    expect(r.status(), await r.text()).toBe(200);
    return r;
  }
  await api("POST", "/connections", {
    id: "local",
    label: "Synthetic rich viewers",
    socket: daemon.socket,
  });
  await api("POST", "/connections/local/attach", { generation: "1" });
  let serial = 0;
  const write = (method: string, params: object) =>
    daemon.call(
      method,
      JSON.stringify({
        workspace_id: "demo",
        actor_id: "fixture-author",
        mutation_id: `viewers-${++serial}`,
        ...params,
      }),
    );
  async function text(id: string, body: string, mime = "application/json", revision = "0") {
    await write("resource.put_text", {
      resource_id: id,
      expected_revision: revision,
      title: `Synthetic ${id}`,
      filename: `${id}.${mime === "text/markdown" ? "md" : mime === "text/plain" ? "txt" : "json"}`,
      mime_type: mime,
      text: body,
    });
  }
  async function binary(id: string, bytes: Uint8Array, mime: string, revision = "0") {
    const intention = `${id}-${++serial}`,
      stage = `${intention}-source`;
    await api("POST", "/resource-stages/prepare", {
      stage_id: stage,
      digest: sha(bytes),
      size_bytes: String(bytes.length),
    });
    for (let offset = 0; offset < bytes.length; offset += 262144)
      await api("POST", `/resource-stages/${stage}/chunks`, {
        offset: String(offset),
        data_base64: Buffer.from(bytes.subarray(offset, offset + 262144)).toString("base64"),
      });
    await api("POST", `/resource-stages/${stage}/seal`);
    await api("POST", "/resource-uploads/prepare", {
      stage_id: stage,
      preparation: {
        intention_id: intention,
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
          resource_id: id,
          expected_revision: revision,
          title: `Synthetic ${id}`,
          filename: `${id}.${mime.split("/")[1] ?? "bin"}`,
          mime_type: mime,
        },
      },
    });
    await api("POST", `/resource-uploads/${intention}/start`);
    await expect
      .poll(
        async () => {
          const r = await api("GET", `/resource-uploads/${intention}`);
          return (await r.text()).includes('"kind":"published"');
        },
        { timeout: 15000 },
      )
      .toBe(true);
  }
  return { text, binary, write };
}
async function open(
  page: Page,
  companion: CompanionFixture,
  id: string,
  bytes: string | Uint8Array,
  version = "1",
) {
  await page.waitForLoadState("networkidle");
  const target = new URL(
    `/#/resources?connection=local&workspace=demo&entity=${id}&resource_generation=1&content_version=${version}&content_digest=${sha(bytes)}`,
    companion.url,
  );
  if (new URL(page.url()).origin === target.origin) {
    const document = await page.evaluateHandle(() => globalThis.document);
    await page.evaluate((hash) => {
      location.hash = hash;
    }, target.hash);
    expect(await document.evaluate((captured) => captured === globalThis.document)).toBe(true);
    await document.dispose();
  } else await page.goto(target.href);
  const viewer = page.getByRole("region", {
    name: "Resource rich content and comparison",
    exact: true,
  });
  await expect(viewer).toBeVisible();
  return viewer;
}
async function capture(page: Page, info: TestInfo, name: string) {
  await page.waitForLoadState("networkidle");
  const path = info.outputPath(name);
  await page.screenshot({ path, fullPage: false });
  await info.attach(name, { path, contentType: "image/png" });
}
async function download(
  page: Page,
  info: TestInfo,
  name: string,
  expected: string | Uint8Array,
  label = "Download verified file",
) {
  const waiting = page.waitForEvent("download");
  await page.getByRole("button", { name: label, exact: true }).click();
  const value = await waiting,
    path = info.outputPath(name);
  await value.saveAs(path);
  const bytes = await readFile(path);
  expect(sha(bytes)).toBe(sha(expected));
  expect(bytes.length).toBe(
    typeof expected === "string" ? Buffer.byteLength(expected) : expected.length,
  );
  await info.attach(name, { path, contentType: "application/octet-stream" });
}
test("rich JSON uses complete >1MiB verified Blob and independently pinned lexical comparison", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const f = await setup(page, companion, daemon),
    left = '{"padding":"' + "a".repeat(1200000) + '","tail":9007199254740993,"nullable":null}',
    right = '{"tail":9007199254740994,"nullable":null,"added":1.2300}';
  await f.binary("large-json", new TextEncoder().encode(left), "application/json");
  await f.text("large-json", right, "application/json", "1");
  const viewer = await open(page, companion, "large-json", left);
  await expect(viewer.getByRole("region", { name: "Lossless JSON tree" })).toContainText(
    "9007199254740993",
  );
  await expect(viewer).toContainText("null");
  const geometry = await viewer
    .locator(".wg-json-row")
    .filter({ hasText: "padding" })
    .evaluate((row) => ({
      name: row.querySelector(".wg-json-name")!.getBoundingClientRect().width,
      value: row.querySelector(".wg-json-value")!.getBoundingClientRect().width,
      type: row.querySelector(".wg-json-type")!.getBoundingClientRect().width,
    }));
  expect(geometry.name).toBeGreaterThan(40);
  expect(geometry.value).toBeGreaterThan(200);
  expect(geometry.type).toBeGreaterThan(20);
  expect(await viewer.locator("[role=tree]").count()).toBe(0);
  await viewer.getByText("Compare immutable content versions", { exact: true }).click();
  await viewer.getByLabel("Right content version", { exact: true }).fill("2");
  await viewer.getByRole("button", { name: "Load exact comparison", exact: true }).click();
  await expect(viewer.getByRole("region", { name: "JSON differences" })).toContainText(
    "9007199254740994",
  );
  await expect(viewer).toContainText("1.2300");
  await expect(viewer).toContainText("content v1");
  await expect(viewer).toContainText("content v2");
  await download(page, info, "large-left.json", left, "Download verified left");
  await download(page, info, "small-right.json", right, "Download verified right");
  await f.text("large-json", '{"latest":true}', "application/json", "2");
  await page.getByRole("button", { name: "Refresh metadata", exact: true }).click();
  await expect(viewer.getByRole("region", { name: "JSON differences" })).toContainText(
    "9007199254740994",
  );
  await expect(viewer).not.toContainText('"latest"');
  await capture(page, info, "viewer-json-large-tree-dark.png");
  await viewer.getByRole("region", { name: "JSON differences" }).scrollIntoViewIfNeeded();
  await capture(page, info, "viewer-json-comparison-dark.png");
  expect(browserFailures).toEqual([]);
});
test("independent PNG JPEG WebP GIF posters retain pixels, transparency, EXIF and keyboard zoom without motion", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const f = await setup(page, companion, daemon);
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const [key, mime] of [
    ["png", "image/png"],
    ["jpeg", "image/jpeg"],
    ["webp", "image/webp"],
    ["gif", "image/gif"],
    ["animatedGif", "image/gif"],
    ["animatedWebp", "image/webp"],
    ["manyFramesGif", "image/gif"],
    ["rotatedJpeg", "image/jpeg"],
    ["transparentPng", "image/png"],
  ] as const) {
    const bytes = fixtureBytes(key);
    await f.binary(key, bytes, mime);
    const viewer = await open(page, companion, key, bytes);
    const canvas = viewer.locator(".wg-raster-stage canvas");
    await expect(canvas).toHaveCount(1);
    await expect(canvas).toBeVisible();
    const actual = await canvas.evaluate((node: HTMLCanvasElement) => ({
      width: node.width,
      height: node.height,
      pixel: Array.from(node.getContext("2d")!.getImageData(1, 1, 1, 1).data),
    }));
    expect([actual.width, actual.height]).toEqual(key === "rotatedJpeg" ? [4, 6] : [6, 4]);
    if (key === "transparentPng") expect(actual.pixel[3]).toBe(0);
    else {
      expect(actual.pixel[0]).toBeGreaterThan(200);
      expect(actual.pixel[2]).toBeLessThan(80);
    }
    if (key.startsWith("animated") || key === "manyFramesGif") {
      await expect(viewer).toContainText("Animated file; static first frame/poster only");
      await page.waitForTimeout(180);
      expect(
        await canvas.evaluate((node: HTMLCanvasElement) =>
          Array.from(node.getContext("2d")!.getImageData(1, 1, 1, 1).data),
        ),
      ).toEqual(actual.pixel);
    }
  }
  const viewport = page.getByRole("region", { name: /image viewport$/ });
  await viewport.focus();
  await page.keyboard.press("0");
  await page.keyboard.press("+");
  await expect(page.getByLabel("Image zoom", { exact: true })).toHaveText("110%");
  await page.keyboard.press("f");
  await expect(page.getByRole("button", { name: "Fit", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.setViewportSize({ width: 800, height: 760 });
  await capture(page, info, "viewer-raster-narrow.png");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(browserFailures).toEqual([]);
});
test("image comparisons expose exact pins and bounded side-by-side/overlay with owned static canvases", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const f = await setup(page, companion, daemon),
    left = fixtureBytes("png"),
    right = fixtureBytes("transparentPng");
  await f.binary("image-diff", left, "image/png");
  await f.binary("image-diff", right, "image/png", "1");
  const viewer = await open(page, companion, "image-diff", left);
  await expect(viewer.locator(".wg-raster-stage canvas")).toHaveCount(1);
  await viewer.getByText("Compare immutable content versions", { exact: true }).click();
  await viewer.getByLabel("Right content version", { exact: true }).fill("2");
  await viewer.getByRole("button", { name: "Load exact comparison", exact: true }).click();
  await expect(viewer.getByRole("button", { name: "Overlay", exact: true })).toBeVisible();
  await expect(viewer.locator(".wg-raster-stage canvas")).toHaveCount(3);
  await viewer.getByRole("button", { name: "Overlay", exact: true }).click();
  await expect(viewer.getByLabel("Right overlay opacity", { exact: true })).toBeVisible();
  await viewer.getByLabel("Right overlay opacity", { exact: true }).press("End");
  for (let i = 0; i < 5; i++)
    await viewer.getByLabel("Right overlay opacity", { exact: true }).press("ArrowLeft");
  await expect(viewer.locator(".wg-raster-stage canvas").last()).toHaveCSS("opacity", "0.75");
  await download(page, info, "right-transparent.png", right, "Download verified right");
  await capture(page, info, "viewer-image-overlay-dark.png");
  expect(browserFailures).toEqual([]);
});
test("malformed unsupported and over-budget content retain exact Raw/download and never fetch external markup", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const f = await setup(page, companion, daemon),
    external: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith(companion.url)) external.push(r.url());
  });
  const invalid = '{"x":1,"x":2}',
    svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://untrusted.invalid/pixel"/></svg>';
  await f.text("duplicate-json", invalid);
  let viewer = await open(page, companion, "duplicate-json", invalid);
  await expect(viewer.getByRole("alert")).toContainText("malformed");
  await viewer.getByText("Source, Raw bytes and language override", { exact: true }).click();
  await viewer.getByRole("button", { name: "Raw bytes", exact: true }).click();
  await expect(viewer.locator('pre[aria-label="Raw byte window"]')).toContainText("7b");
  await download(page, info, "invalid-exact.json", invalid);
  await f.text("passive-svg", svg, "image/svg+xml");
  viewer = await open(page, companion, "passive-svg", svg);
  await expect(viewer.getByRole("alert")).toContainText("unsupported");
  expect(await viewer.locator("img,svg,iframe,object,script").count()).toBe(0);
  const huge = fixtureBytes("png");
  new DataView(huge.buffer).setUint32(16, 100000);
  await f.binary("huge-header", huge, "image/png");
  viewer = await open(page, companion, "huge-header", huge);
  await expect(viewer.getByRole("alert")).toContainText("budget");
  await expect(viewer).toContainText("Decode was not started");
  expect(await viewer.locator("canvas").count()).toBe(0);
  await download(page, info, "huge-header-exact.png", huge);
  const broken = fixtureBytes("png");
  broken[45] = broken[45]! ^ 255;
  await f.binary("broken-pixels", broken, "image/png");
  viewer = await open(page, companion, "broken-pixels", broken);
  await expect(viewer.getByRole("alert")).toContainText("malformed");
  await capture(page, info, "viewer-raster-malformed.png");
  expect(external).toEqual([]);
  expect(browserFailures).toEqual([]);
});
test("actual viewer Worker admission failure and deadline keep source downloadable without treating content as malformed", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const f = await setup(page, companion, daemon),
    bytes = fixtureBytes("png");
  await f.binary("worker-control", bytes, "image/png");
  await page.addInitScript(() => {
    const NativeWorker = Worker;
    globalThis.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        if (String(url).includes("viewer.worker"))
          throw new DOMException("Synthetic worker admission denial", "SecurityError");
        super(url, options);
      }
    };
  });
  let viewer = await open(page, companion, "worker-control", bytes);
  await expect(viewer.getByRole("alert")).toContainText("worker");
  await download(page, info, "worker-failure-source.png", bytes);
  // New context page removes the earlier denial init script; both controls remain test-owned.
  const context = page.context(),
    other = await context.newPage();
  const errors: string[] = [];
  other.on("pageerror", (error) => errors.push(error.message));
  other.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  other.on("requestfailed", (request) =>
    errors.push(`${request.url()}: ${request.failure()?.errorText}`),
  );
  try {
    await other.addInitScript(() => {
      const NativeWorker = Worker;
      globalThis.Worker = class extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          if (String(url).includes("viewer.worker")) this.postMessage = () => {};
        }
      };
    });
    viewer = await open(other, companion, "worker-control", bytes);
    await expect(viewer.getByRole("alert")).toContainText("timeout");
    await expect(viewer).not.toContainText("malformed");
    await download(other, info, "worker-timeout-source.png", bytes);
    expect(other.workers().filter((w) => w.url().includes("viewer.worker"))).toHaveLength(0);
    await other.waitForLoadState("networkidle");
    expect(errors).toEqual([]);
  } finally {
    await other.close();
  }
  expect(browserFailures).toEqual([]);
});
test("text JSON and binary comparisons keep bounded fallbacks and independent verified downloads", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const f = await setup(page, companion, daemon),
    left = "alpha\nbeta\n",
    right = "alpha\ngamma\n";
  await f.text("line-diff", left, "text/plain");
  await f.text("line-diff", right, "text/plain", "1");
  const viewer = await open(page, companion, "line-diff", left);
  await viewer.getByText("Compare immutable content versions", { exact: true }).click();
  await viewer.getByLabel("Right content version", { exact: true }).fill("2");
  await viewer.getByRole("button", { name: "Load exact comparison", exact: true }).click();
  await expect(viewer.locator(".wg-diff-row--removed")).toContainText("beta");
  await expect(viewer.locator(".wg-diff-row--added")).toContainText("gamma");
  await viewer.getByLabel("Comparison", { exact: true }).selectOption("binary");
  await expect(viewer).toContainText("Different verified bytes");
  await download(page, info, "line-right.txt", right, "Download verified right");
  await viewer.getByLabel("Comparison", { exact: true }).selectOption("json");
  await expect(viewer.getByRole("alert")).toContainText("malformed");
  const longLeft = "alpha\n".repeat(1100),
    longRight = "gamma\n".repeat(1100);
  await f.text("budget-diff", longLeft, "text/plain");
  await f.text("budget-diff", longRight, "text/plain", "1");
  const bounded = await open(page, companion, "budget-diff", longLeft);
  await bounded.getByText("Compare immutable content versions", { exact: true }).click();
  await bounded.getByLabel("Right content version", { exact: true }).fill("2");
  await bounded.getByRole("button", { name: "Load exact comparison", exact: true }).click();
  await expect(bounded.getByRole("alert")).toContainText("budget");
  await bounded.getByText("Pinned sources side by side", { exact: true }).click();
  await expect(bounded.locator(".wg-comparison-columns .wg-content-viewer")).toHaveCount(2);
  await download(page, info, "bounded-right.txt", longRight, "Download verified right");
  await capture(page, info, "viewer-comparison-fallback-dark.png");
  expect(browserFailures).toEqual([]);
});
test("resource Markdown tables fixed code grammar and passive source controls remain real rich renderers", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const f = await setup(page, companion, daemon),
    body =
      "# Synthetic renderer\n\n| Language | State |\n|---|---|\n| OCaml | verified |\n\n```ocaml\nlet value = 42\n```\n\n```python\ndef value():\n    return 42\n```\n\n<script>globalThis.viewerExploit=true</script>\n![passive](https://untrusted.invalid/pixel)\n";
  await f.text("render-guide", body, "text/markdown");
  const viewer = await open(page, companion, "render-guide", body);
  await expect(viewer.locator("table tbody tr")).toHaveCount(1);
  await expect(viewer.locator(".wg-syntax-keyword").filter({ hasText: /^let$/ })).toBeVisible();
  await expect(viewer.locator(".wg-syntax-keyword").filter({ hasText: /^def$/ })).toBeVisible();
  expect(await viewer.locator("img,script,iframe,a[href]").count()).toBe(0);
  expect(await page.evaluate(() => Object.hasOwn(globalThis, "viewerExploit"))).toBe(false);
  await viewer.getByRole("button", { name: "Source", exact: true }).click();
  await expect(viewer.locator(".wg-code-block code").first()).toContainText("# Synthetic renderer");
  await viewer.getByRole("button", { name: "Raw bytes", exact: true }).click();
  await expect(viewer.locator('pre[aria-label="Raw byte window"]')).toContainText("23");
  await download(page, info, "render-guide-exact.md", body);
  await capture(page, info, "viewer-source-dark.png");
  expect(browserFailures).toEqual([]);
});
