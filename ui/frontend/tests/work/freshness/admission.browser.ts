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
  output = await mkdtemp(join(tmpdir(), "wg-workbench-admission-"));
  const sources = (
    await Promise.all(
      [
        "src/features/work/WorkbenchDestination.tsx",
        "src/features/work/destinations.ts",
        "src/app/navigation.ts",
        "src/features/discussions/requests/RequestFields.tsx",
        "tests/work/freshness",
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
      rollupOptions: { input: join(frontend, "tests/work/freshness/admission.fixture.html") },
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
  await page.goto(origin + "/tests/work/freshness/admission.fixture.html");
  await expect(
    page.getByRole("heading", { name: "Workbench admission controls", exact: true }),
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
test("retained generation admission fences delayed old success/rejection and socket reuse on reload", async ({
  page,
}) => {
  const editable = page.getByRole("heading", { name: "Editable original workbench", exact: true });
  await expect(editable).toHaveCount(0);
  await page.getByRole("button", { name: "Retarget current profile", exact: true }).click();
  await page.getByRole("button", { name: "Resolve latest original profile", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Original workbench endpoint is not current", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Resolve obsolete profile", exact: true }).click();
  await expect(editable).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "View original ticket read-only", exact: true }),
  ).toHaveAttribute("href", /planning_generation=1/u);
  await page.getByRole("button", { name: "Return original current profile", exact: true }).click();
  await page.getByRole("button", { name: "Resolve latest original profile", exact: true }).click();
  await expect(editable).toBeVisible();
  await page.getByRole("button", { name: "Retarget current profile", exact: true }).click();
  await expect(editable).toHaveCount(0);
  await page.getByRole("button", { name: "Return original current profile", exact: true }).click();
  await page.getByRole("button", { name: "Reject obsolete profile", exact: true }).click();
  await page.getByRole("button", { name: "Resolve latest original profile", exact: true }).click();
  await expect(editable).toBeVisible();
  // Recreate owner like a reload, same ID/generation but another companion root's socket.
  await page.getByRole("button", { name: "Reload with reused identity", exact: true }).click();
  await expect(editable).toHaveCount(0);
  await page.getByRole("button", { name: "Resolve reused identity", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Original workbench endpoint is not current", exact: true }),
  ).toBeVisible();
  await expect(editable).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "View original ticket read-only", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Editable mounts", { exact: true })).toHaveText("2");
});

test("failed retained lookup offers no original-link assertion; resolver guidance leaves delivery explicit", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Fail current lookup", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Retained profile unavailable");
  await expect(
    page.getByRole("link", { name: "View original ticket read-only", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Editable original workbench", exact: true }),
  ).toHaveCount(0);
  const fields = page.getByRole("region", { name: "Unsent question fields", exact: true });
  await fields.getByLabel("Designated resolver", { exact: true }).fill("original-resolver");
  await expect(fields).toContainText(
    "This does not deliver the question: add at least one direct recipient separately",
  );
  await expect(fields.getByLabel("Direct recipients 1 ID", { exact: true })).toHaveCount(0);
  await fields.getByRole("button", { name: "Add direct recipients", exact: true }).click();
  await fields.getByLabel("Direct recipients 1 ID", { exact: true }).fill("original-resolver");
  await expect(fields.getByLabel("Direct recipients 1 ID", { exact: true })).toHaveValue(
    "original-resolver",
  );
});
