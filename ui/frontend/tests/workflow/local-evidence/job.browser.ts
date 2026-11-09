import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { test, expect } from "@playwright/test";

test("LE04 known publication while linking offers observation only until terminal", async ({
  page,
}, info) => {
  const frontend = resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
    output = await mkdtemp(join(tmpdir(), "wg-execution-phase-")),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("requestfailed", (request) =>
    errors.push(request.url() + ":" + request.failure()?.errorText),
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
        response.writeHead(200, {
          "content-type": path.endsWith(".html")
            ? "text/html"
            : path.endsWith(".js")
              ? "application/javascript"
              : path.endsWith(".css")
                ? "text/css"
                : "application/octet-stream",
        });
        response.end(bytes);
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
        rollupOptions: { input: join(frontend, "tests/workflow/local-evidence/job.fixture.html") },
      },
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("No component fixture address");
    await page.goto(
      `http://127.0.0.1:${address.port}/tests/workflow/local-evidence/job.fixture.html`,
    );
    const area = page.getByRole("region", { name: "Publication publish", exact: true });
    await expect(
      area.getByRole("heading", {
        name: "Resource published · ticket link in progress",
        exact: true,
      }),
    ).toBeVisible();
    await expect(area).toContainText("Ticket linking is still in progress");
    await expect(
      area.getByRole("button", { name: "Retry exact saved intent", exact: true }),
    ).toHaveCount(0);
    await expect(
      area.getByRole("button", { name: "Recover receipts only", exact: true }),
    ).toHaveCount(0);
    await expect(
      area.getByRole("button", { name: "Inspect publication", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Complete pending link", exact: true }).click();
    await expect(
      area.getByRole("heading", { name: "Resource published", exact: true }),
    ).toBeVisible();
    await expect(
      area.getByRole("button", { name: "Retry exact saved intent", exact: true }),
    ).toBeVisible();
    await expect(
      area.getByRole("button", { name: "Recover receipts only", exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
    await info.attach("publication-phase-diagnostics", {
      body: JSON.stringify({
        errors,
        pendingLinkKeepsPublication: true,
        mutationsUnavailableWhileRunning: true,
      }),
      contentType: "application/json",
    });
  } finally {
    await page.close();
    if (server.listening)
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
    await rm(output, { recursive: true, force: true });
  }
});
