import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { test, expect } from "@playwright/test";

test("component lifetime: raw return to verified source clears busy, stale encode cannot win, omitted invalid fields unblock", async ({
  page,
}, info) => {
  const frontend = resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
    output = await mkdtemp(join(tmpdir(), "wg-evidence-field-")),
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
        rollupOptions: { input: join(frontend, "tests/workflow/evidence/structured.fixture.html") },
      },
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("No component fixture address");
    await page.goto(
      `http://127.0.0.1:${address.port}/tests/workflow/evidence/structured.fixture.html`,
    );
    await expect(page.getByText("Parent ready; released 0", { exact: true })).toBeVisible();
    const inherited = page.getByRole("region", { name: "Inherited override", exact: true }),
      policy = page.getByRole("region", { name: "Policy scope", exact: true }),
      decision = page.getByRole("region", { name: "Decision scope", exact: true });
    await expect(inherited.getByLabel("Scope kind", { exact: true }).locator("option")).toHaveText([
      "Choose a scope",
      "project",
    ]);
    await expect(policy.getByLabel("Scope kind", { exact: true }).locator("option")).toHaveText([
      "Choose a scope",
      "ticket",
      "project",
    ]);
    await expect(decision.getByLabel("Scope kind", { exact: true }).locator("option")).toHaveText([
      "Choose a scope",
      "workspace",
      "project",
      "milestone",
      "ticket",
      "resource",
    ]);
    await inherited.getByLabel("Exact scope ID", { exact: true }).fill("corrected-project");
    await expect(
      inherited.getByLabel("Inherited override retained source", { exact: true }),
    ).toContainText('"project_id":"corrected-project"');
    await expect(
      inherited.getByLabel("Inherited override retained source", { exact: true }),
    ).toContainText('"kind":"project"');
    const inheritedRaw = inherited.getByLabel("Inherited override source", { exact: true }),
      unsupported =
        '{"against":{"scope":{"kind":"ticket","ticket_id":"retained-ticket"},"revision":"1"},"membership_revision":"1","reason":"Preserve raw unsupported scope"}';
    await inherited.getByText("Exact JSON source", { exact: true }).click();
    await inheritedRaw.fill(unsupported);
    await expect(inherited.getByRole("alert")).toContainText(
      "Inherited overrides require a project policy source",
    );
    await expect(inheritedRaw).toHaveValue(unsupported);
    await expect(inherited.getByLabel("Exact scope ID", { exact: true })).toHaveCount(0);
    await inheritedRaw.fill(
      '{"against":{"scope":{"kind":"project","project_id":"restored-project"},"revision":"1"},"membership_revision":"1","reason":"Repaired explicitly"}',
    );
    await expect(inherited.getByLabel("Exact scope ID", { exact: true })).toHaveValue(
      "restored-project",
    );
    await expect(inherited.getByRole("alert")).toHaveCount(0);

    await page.getByLabel("Name", { exact: true }).fill("optimistic");
    await expect(page.getByText("Saving structured field…", { exact: true })).toBeVisible();
    await page.getByText("Exact JSON source", { exact: true }).last().click();
    const raw = page.getByLabel("Output names source", { exact: true });
    await raw.fill("[");
    await raw.fill('["original"]');
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("original");
    await expect(page.getByText("Saving structured field…", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Parent ready; released 0", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Release deferred jobs", exact: true }).click();
    await expect(page.getByLabel("Retained source", { exact: true })).toHaveText('["original"]');
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("original");
    await page.getByLabel("Name", { exact: true }).fill("old structured");
    await raw.fill('["new raw"]');
    await page.getByRole("button", { name: "Release deferred jobs", exact: true }).click();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("new raw");
    await expect(page.getByLabel("Retained source", { exact: true })).toHaveText('["new raw"]');
    await page.getByLabel("Hold parse", { exact: true }).uncheck();
    await raw.fill("[");
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: /Parent blocked/u })).toBeVisible();
    await page.getByRole("button", { name: "Toggle optional field", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: /Parent ready/u })).toBeVisible();
    expect(errors).toEqual([]);
    await info.attach("component-lifetime-diagnostics", {
      body: JSON.stringify(
        { errors, verifiedSource: '["new raw"]', omittedInvalidFieldUnblocked: true },
        null,
        2,
      ),
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
