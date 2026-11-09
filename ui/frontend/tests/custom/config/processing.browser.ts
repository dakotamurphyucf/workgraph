import { build } from "vite";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { test, expect } from "../../e2e/support/fixtures";
import type { BridgeAsset } from "../../e2e/support/bridge-build";
import type {} from "./browser.fixture";
import { identifier, decimal, view } from "./fixtures";
import { configJson } from "../../../src/features/custom/config/encode";
import { canonicalJson } from "../../../src/core/json";
const assets = new Map<string, BridgeAsset>();
test.beforeAll(async () => {
  const output = await build({
    configFile: false,
    root: fileURLToPath(new URL("../../../", import.meta.url)),
    base: "/__config_fixture__/",
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
        assets.set(`/__config_fixture__/${member.fileName}`, {
          body: member.type === "chunk" ? member.code : member.source,
          contentType: "text/javascript",
        });
});
test("Config verified loader uses real workers and exact old content without source execution or current fallback", async ({
  page,
  context,
  daemon,
  companion,
  browserFailures,
}, info) => {
  for (const [path, asset] of assets) {
    const body = typeof asset.body === "string" ? Buffer.from(asset.body) : Buffer.from(asset.body);
    await info.attach(`compiled-${path.split("/").at(-1)}`, {
      body,
      contentType: asset.contentType,
    });
  }
  const raw = canonicalJson(
    configJson(view("facts", { title: "<script>window.injected=true</script>" })),
  );
  if (!raw.ok) throw new Error(raw.error.message);
  const source = raw.value,
    hash = createHash("sha256").update(source).digest("hex");
  await daemon.call(
    "resource.put_text",
    JSON.stringify({
      workspace_id: "demo",
      actor_id: daemon.actor,
      mutation_id: "config-v1",
      resource_id: "browser-config",
      expected_revision: "0",
      title: "Config",
      filename: "config.json",
      mime_type: "application/json",
      text: source,
    }),
  );
  await daemon.call(
    "resource.put_text",
    JSON.stringify({
      workspace_id: "demo",
      actor_id: daemon.actor,
      mutation_id: "config-v2",
      resource_id: "browser-config",
      expected_revision: "1",
      text: '{"config_version":2,"future":9007199254740993}',
    }),
  );
  await context.route("**/__config_fixture__/**", (route) => {
    const asset = assets.get(new URL(route.request().url()).pathname);
    return asset
      ? route.fulfill({
          status: 200,
          contentType: asset.contentType,
          body: typeof asset.body === "string" ? asset.body : Buffer.from(asset.body),
        })
      : route.fulfill({ status: 404 });
  });
  await page.goto(companion.url);
  await page.evaluate(async (socket) => {
    const capability = document
      .querySelector('meta[name="workgraph-capability"]')
      ?.getAttribute("content");
    if (!capability) throw new Error("capability");
    for (const [path, body] of [
      ["/connections", { id: "config-fixture", label: "Config fixture", socket }],
      ["/connections/config-fixture/attach", { generation: "1" }],
    ] as const) {
      const result = await fetch(`/ui-api/v1${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Workgraph-UI-Capability": capability },
        body: JSON.stringify(body),
      });
      if (!result.ok) throw new Error(`Native setup ${result.status}`);
      await result.text();
    }
  }, daemon.socket);
  await page.addScriptTag({
    type: "module",
    url: new URL("/__config_fixture__/entry.js", companion.url).href,
  });
  await page.waitForFunction(() => window.configProbe !== undefined);
  const digest = await import("../../../src/core/protocol/decoders").then((d) =>
    d.digest.decode(d.jsonString(hash)),
  );
  if (!digest.ok) throw new Error("digest");
  const pin = {
    resource_id: identifier("browser-config"),
    version: decimal("1"),
    digest: digest.value,
    size_bytes: decimal(String(Buffer.byteLength(source))),
  };
  const result = await page.evaluate((pin) => window.configProbe.read(pin), pin);
  expect(result).toMatchObject({
    ok: true,
    version: "1",
    raw: source,
    kind: "valid",
    title: "<script>window.injected=true</script>",
  });
  expect(await page.evaluate(() => "injected" in window)).toBe(false);
  const absent = await page.evaluate(
    (pin) => window.configProbe.read({ ...pin, version: "3" as typeof pin.version }),
    pin,
  );
  expect(absent).toMatchObject({ ok: false, kind: "protocol" });
  const mismatch = await page.evaluate(
    (pin) => window.configProbe.read({ ...pin, size_bytes: "1" as typeof pin.size_bytes }),
    pin,
  );
  expect(mismatch).toMatchObject({ ok: false, kind: "integrity" });
  await page.evaluate((pin) => window.configProbe.read(pin), pin);
  await page.screenshot({ path: info.outputPath("verified-config-source.png"), fullPage: true });
  await info.attach("config-dedicated-worker-helper-proof", {
    body: JSON.stringify({ result, absent, mismatch, helperOnly: true }, null, 2),
    contentType: "application/json",
  });
  await page.evaluate(() => window.configProbe.dispose());
  expect(browserFailures).toEqual([]);
});
