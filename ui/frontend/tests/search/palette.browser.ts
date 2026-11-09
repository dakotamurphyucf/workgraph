import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { test, expect } from "@playwright/test";
test("S06 real rendered palette dismissal fences delayed success/failure while preserving queries", async ({
  page,
}, info) => {
  const frontend = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
    output = await mkdtemp(join(tmpdir(), "wg-search-palette-")),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("requestfailed", (request) =>
    errors.push(`${request.url()}: ${request.failure()?.errorText}`),
  );
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname,
        path = resolve(output, "." + pathname);
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
      } catch {
        response.writeHead(404).end();
      }
    })();
  });
  try {
    await build({
      configFile: false,
      root: frontend,
      plugins: [react()],
      build: {
        outDir: output,
        emptyOutDir: true,
        assetsInlineLimit: 0,
        rollupOptions: { input: join(frontend, "tests/search/palette.fixture.html") },
      },
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("No fixture server address");
    await page.goto(`http://127.0.0.1:${address.port}/tests/search/palette.fixture.html`);
    const open = async () => {
      await page.getByRole("button", { name: "Open palette", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Command menu", exact: true });
      await dialog.getByRole("tab", { name: "Search", exact: true }).click();
      return dialog;
    };
    let dialog = await open();
    await dialog.getByLabel("Search text", { exact: true }).fill("needle");
    await dialog.getByRole("button", { name: "Search", exact: true }).click();
    await expect(
      dialog.getByRole("heading", { name: "Results for “needle”", exact: true }),
    ).toBeVisible();
    for (const release of ["Release success", "Release failure"]) {
      await dialog.getByRole("button", { name: "resource resource text", exact: true }).click();
      await expect(
        dialog.getByRole("status").filter({ hasText: "Resolving the exact result destination" }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: release, exact: true }).click();
      dialog = await open();
      await expect(
        dialog.getByRole("heading", { name: "Results for “needle”", exact: true }),
      ).toBeVisible();
      await expect(dialog.getByLabel("Search text", { exact: true })).toHaveValue("needle");
      await expect(page.getByLabel("Navigation count", { exact: true })).toHaveText("0");
      await expect(page.getByLabel("Recent count", { exact: true })).toHaveText("0");
      await expect(dialog.getByRole("alert")).toHaveCount(0);
    }
    await dialog.getByRole("button", { name: "resource resource text", exact: true }).click();
    await dialog.getByRole("button", { name: "Release mounted success", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByLabel("Navigation count", { exact: true })).toHaveText("1");
    await expect(page.getByLabel("Recent count", { exact: true })).toHaveText("1");
    const screenshot = info.outputPath("palette-dismissal-settled.png");
    await page.screenshot({ path: screenshot, fullPage: false });
    await info.attach("palette-dismissal-settled", { path: screenshot, contentType: "image/png" });
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    await rm(output, { recursive: true, force: true });
  }
});
