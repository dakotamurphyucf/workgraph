import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { test, expect, type Page } from "@playwright/test";
const frontend = resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
  hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let output = "",
  origin = "",
  server: Server | undefined;
let pins: Record<string, string> = {},
  assets: Record<string, string> = {};
const serverErrors: string[] = [],
  diagnostics = new Map<Page, string[]>();
async function tree(path: string): Promise<string[]> {
  if (!(await stat(path)).isDirectory()) return [path];
  return (
    await Promise.all(
      (await readdir(path, { withFileTypes: true })).map((entry) =>
        entry.isDirectory()
          ? tree(join(path, entry.name))
          : Promise.resolve([join(path, entry.name)]),
      ),
    )
  ).flat();
}
test.beforeAll(async () => {
  output = await mkdtemp(join(tmpdir(), "wg-renderer-host-"));
  const sources = (
    await Promise.all(
      [
        "src/features/custom/editor/CustomValuePresentation.tsx",
        "src/features/custom/editor/presentation",
        "tests/custom/editor/renderer-host.fixture.tsx",
        "tests/custom/editor/renderer-host.fixture.html",
        "tests/custom/editor/renderer-host.browser.ts",
        "tests/custom/editor/presentation",
      ].map((path) => tree(join(frontend, path))),
    )
  ).flat();
  pins = Object.fromEntries(
    await Promise.all(
      sources.map(
        async (path) => [path.slice(frontend.length + 1), hash(await readFile(path))] as const,
      ),
    ),
  );
  await build({
    configFile: false,
    root: frontend,
    plugins: [react()],
    build: {
      outDir: output,
      emptyOutDir: true,
      assetsInlineLimit: 0,
      rollupOptions: { input: join(frontend, "tests/custom/editor/renderer-host.fixture.html") },
    },
  });
  assets = Object.fromEntries(
    await Promise.all(
      (await tree(output)).map(
        async (path) => [path.slice(output.length + 1), hash(await readFile(path))] as const,
      ),
    ),
  );
  server = createServer((request, response) => {
    void (async () => {
      const path = resolve(output, "." + new URL(request.url ?? "/", "http://127.0.0.1").pathname);
      if (!path.startsWith(output + "/")) {
        response.writeHead(403).end();
        return;
      }
      try {
        const bytes = await readFile(path);
        response
          .writeHead(200, {
            "content-type": path.endsWith(".html")
              ? "text/html"
              : path.endsWith(".js")
                ? "application/javascript"
                : path.endsWith(".css")
                  ? "text/css"
                  : "application/octet-stream",
          })
          .end(bytes);
      } catch (error) {
        serverErrors.push(String(error));
        response.writeHead(404).end();
      }
    })().catch((error: unknown) => {
      serverErrors.push(String(error));
      response.destroy(error instanceof Error ? error : undefined);
    });
  });
  await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Fixture did not listen");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  try {
    for (const [path, digest] of Object.entries(pins))
      expect(hash(await readFile(join(frontend, path)))).toBe(digest);
    expect(serverErrors).toEqual([]);
  } finally {
    try {
      if (server?.listening)
        await new Promise<void>((done, reject) =>
          server?.close((error) => (error ? reject(error) : done())),
        );
    } finally {
      if (output !== "") await rm(output, { recursive: true, force: true });
    }
  }
});
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  diagnostics.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("requestfailed", (request) =>
    errors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`),
  );
  await page.goto(origin + "/tests/custom/editor/renderer-host.fixture.html");
  await expect(
    page.getByRole("heading", { name: "Renderer host controls", exact: true }),
  ).toBeVisible();
});
test.afterEach(async ({ page }, info) => {
  await page.close();
  expect(diagnostics.get(page)).toEqual([]);
  await info.attach("component-source-assets-diagnostics", {
    body: JSON.stringify({ pins, assets, diagnostics: diagnostics.get(page), serverErrors }),
    contentType: "application/json",
  });
});
test("one original viewer owner for table and incompatible field fallbacks", async ({ page }) => {
  const chooser = page.getByLabel("Value renderer", { exact: true });
  for (const presentation of ["table", "fields"]) {
    await chooser.selectOption({ label: "Host renderer · host-config@1" });
    const disclosure = page
      .getByText("Original viewer · Source / Raw", { exact: true })
      .locator("..");
    if (!(await disclosure.getAttribute("open")) && (await disclosure.getAttribute("open")) !== "")
      await page.getByText("Original viewer · Source / Raw", { exact: true }).click();
    await expect(page.getByTestId("original-viewer")).toHaveCount(1);
    await expect(async () => {
      await page.getByRole("button", { name: "Count original owners", exact: true }).click();
      await expect(page.getByLabel("Original owners", { exact: true })).toHaveText("1");
    }).toPass();
    if (presentation === "table")
      await page.getByRole("button", { name: "Change presentation", exact: true }).click();
  }
});
test("same content key across workspace and endpoint resets selection and fences obsolete byte parse", async ({
  page,
}) => {
  const chooser = page.getByLabel("Value renderer", { exact: true });
  await chooser.selectOption("auto");
  await expect(page.getByRole("cell", { name: "demo", exact: true })).toBeVisible();
  for (const name of ["Change workspace", "Change endpoint"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(chooser).toHaveValue("generic");
    await chooser.selectOption("auto");
  }
  await page.getByRole("button", { name: "Delay byte parse", exact: true }).click();
  await page.getByRole("button", { name: "Change workspace", exact: true }).click();
  await expect(chooser).toHaveValue("generic");
  await expect(chooser.locator('option[value="auto"]')).toBeEnabled();
  await chooser.selectOption("auto");
  await expect(page.getByRole("cell", { name: "demo", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Complete obsolete parse", exact: true }).click();
  await expect(page.getByRole("cell", { name: "demo", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "other", exact: true })).toHaveCount(0);
});
