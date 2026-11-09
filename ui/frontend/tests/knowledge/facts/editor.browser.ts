import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { test, expect } from "@playwright/test";

test("Facts editor preserves typing focus, invalid candidates and raw-replacement ownership", async ({
  page,
}, info) => {
  const frontend = resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
    output = await mkdtemp(join(tmpdir(), "wg-fact-field-")),
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
        rollupOptions: { input: join(frontend, "tests/knowledge/facts/editor.fixture.html") },
      },
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("No component fixture address");
    await page.goto(`http://127.0.0.1:${address.port}/tests/knowledge/facts/editor.fixture.html`);
    const ready = page.getByRole("status").filter({ hasText: /^Parent ready/u }),
      word = page.getByLabel("word · Text", { exact: true }),
      number = page.getByLabel("number · Number", { exact: true });
    await expect(ready).toBeVisible();
    await word.focus();
    for (const char of "hello") {
      await word.pressSequentially(char);
      await expect(ready).toBeVisible();
      await expect(word).toBeFocused();
    }
    await expect(word).toHaveValue("hello");
    await expect(page.getByLabel("Retained fact source")).toContainText('"word":"hello"');
    await expect(ready).toBeVisible();
    const count = await page.getByLabel("Encoding count", { exact: true }).textContent();
    await page.waitForTimeout(100);
    await expect(page.getByLabel("Encoding count", { exact: true })).toHaveText(count ?? "missing");
    await expect(page.getByLabel("Retained fact source")).toContainText('"word":"hello"');
    await number.fill("1");
    await expect(ready).toBeVisible();
    await number.focus();
    for (const char of "2345") {
      await number.pressSequentially(char);
      await expect(ready).toBeVisible();
      await expect(number).toBeFocused();
    }
    await expect(number).toHaveValue("12345");
    await number.fill("1e");
    await expect(page.getByRole("alert")).toContainText("Repair");
    await expect(page.getByRole("status").filter({ hasText: /^Parent blocked/u })).toBeVisible();
    await page.getByRole("button", { name: "Navigate away or back", exact: true }).click();
    await page.getByRole("button", { name: "Navigate away or back", exact: true }).click();
    await expect(number).toHaveValue("1e");
    await expect(page.getByRole("alert")).toContainText("Repair");
    await page.getByRole("button", { name: "Raw JSON source", exact: true }).click();
    const raw = page.getByLabel("Fact JSON source", { exact: true });
    await raw.fill('{"word":"repaired","number":2,"__proto__":{"constructor":null}}');
    await expect(ready).toBeVisible();
    await page.getByRole("button", { name: "Structured value", exact: true }).click();
    await expect(word).toHaveValue("repaired");
    await page.getByLabel("Hold structured encoding", { exact: true }).check();
    await word.fill("obsolete");
    await expect(page.getByText("Validating fact value…", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Raw JSON source", exact: true }).click();
    await raw.fill('{"word":"new raw","number":3}');
    await page.getByLabel("Hold structured encoding", { exact: true }).uncheck();
    await page.getByRole("button", { name: "Release old encoding", exact: true }).click();
    await expect(ready).toBeVisible();
    await expect(raw).toHaveValue('{"word":"new raw","number":3}');
    await page.getByRole("button", { name: "Structured value", exact: true }).click();
    await expect(word).toHaveValue("new raw");
    expect(errors).toEqual([]);
    await info.attach("facts-editor-diagnostics", {
      body: JSON.stringify({
        errors,
        typingFocus: true,
        invalidCandidateRetained: true,
        staleEncodeIgnored: true,
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
