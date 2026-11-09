import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { test, expect, type Page } from "@playwright/test";
const frontend = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.."),
  hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let output = "",
  origin = "",
  server: Server | undefined;
let pins: Record<string, string> = {},
  assets: Record<string, string> = {};
const serverErrors: string[] = [],
  diagnostics = new Map<Page, string[]>();
async function tree(path: string): Promise<string[]> {
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
  output = await mkdtemp(join(tmpdir(), "wg-custom-forms-"));
  const sources = (
    await Promise.all(
      [
        "src/features/custom/editor/forms",
        "src/features/custom/editor/presentation",
        "tests/custom/editor/forms",
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
      rollupOptions: { input: join(frontend, "tests/custom/editor/forms/component.fixture.html") },
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
  await page.goto(origin + "/tests/custom/editor/forms/component.fixture.html");
  await expect(
    page.getByRole("heading", { name: "Custom view components", exact: true }),
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
test("controlled field typing, moved-row focus and incomplete text survive unmount and Raw return", async ({
  page,
}, info) => {
  const name = page.getByLabel("Name", { exact: true });
  await name.fill("");
  await name.focus();
  for (const char of "Roadmap") {
    await name.pressSequentially(char);
    await expect(name).toBeFocused();
  }
  await expect(name).toHaveValue("Roadmap");
  await page.getByRole("button", { name: "Add Column", exact: true }).click();
  await page.getByLabel("Column 2 label", { exact: true }).fill("Estimate");
  await page.getByLabel("Set column 2 width", { exact: true }).check();
  const width = page.getByLabel("Column 2 width", { exact: true });
  await width.fill("1e");
  await expect(page.getByRole("status").filter({ hasText: "Parent blocked" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply working configuration" })).toBeDisabled();
  const up = page.getByRole("button", { name: "Move Column 2 up", exact: true });
  await up.focus();
  await up.press("Enter");
  await expect(page.getByLabel("Column 1 width", { exact: true })).toHaveValue("1e");
  await expect(page.getByLabel("Column 1 label", { exact: true })).toBeFocused();
  await page.keyboard.type(" moved");
  await expect(page.getByLabel("Column 1 label", { exact: true })).toHaveValue("Estimate moved");
  await page.getByRole("button", { name: "Hide or restore editor", exact: true }).click();
  await page.getByRole("button", { name: "Hide or restore editor", exact: true }).click();
  await expect(page.getByLabel("Column 1 width", { exact: true })).toHaveValue("1e");
  await page.getByRole("button", { name: "Raw configuration", exact: true }).click();
  await expect(page.getByLabel("Raw candidate", { exact: true })).not.toHaveValue(/1e/u);
  await expect(
    page.getByText("Raw is the last representable candidate.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Return to form", exact: true }).click();
  await expect(page.getByLabel("Column 1 width", { exact: true })).toHaveValue("1e");
  await page.getByLabel("Column 1 width", { exact: true }).fill("180");
  await expect(page.getByRole("button", { name: "Apply working configuration" })).toBeEnabled();
  await page.getByRole("button", { name: "Remove Column 1", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove Column 1", exact: true })).toBeFocused();
  await expect(page.getByLabel("Column 1 label", { exact: true })).toHaveValue("Title");
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("view-form-dark-top.png"), fullPage: false });
  await page
    .getByRole("region", { name: "View builder", exact: true })
    .screenshot({ path: info.outputPath("whole-view-form.png") });
});
test("view and renderer controls edit full typed fields with explicit scalar types", async ({
  page,
}) => {
  await page.getByLabel("Source", { exact: true }).selectOption("facts");
  await page.getByLabel("Scope", { exact: true }).selectOption("project");
  await page.getByLabel("Scope ID", { exact: true }).fill("project-a");
  await page.getByText("Filter rows", { exact: true }).click();
  await page.getByRole("button", { name: "Add Filter", exact: true }).click();
  await page.getByLabel("Filter 1 selector", { exact: true }).selectOption("pointer");
  await page.getByLabel("Filter 1 pointer", { exact: true }).fill("/score");
  await page.getByLabel("Filter 1 value type", { exact: true }).selectOption("number");
  await page.getByLabel("Filter 1 value", { exact: true }).fill("9007199254740993.0");
  await page.getByLabel("Column 1 selector", { exact: true }).selectOption("pointer");
  await page.getByLabel("Column 1 pointer", { exact: true }).fill("/name");
  await page.getByLabel("Column 1 format", { exact: true }).selectOption("text");
  await expect(page.getByRole("button", { name: "Apply working configuration" })).toBeEnabled();
  await expect(page.getByLabel("Candidate JSON")).toContainText("9007199254740993.0");
  await page.getByRole("button", { name: "New renderer", exact: true }).click();
  await page.getByLabel("Match a fact key prefix", { exact: true }).check();
  await page.getByLabel("Fact key prefix", { exact: true }).fill("report.");
  await page.getByLabel("Match a reported schema", { exact: true }).check();
  await page.getByLabel("Schema ID", { exact: true }).fill("report");
  await page.getByLabel("Schema version", { exact: true }).fill("v2");
  await page.getByLabel("Match a JSON root type", { exact: true }).check();
  await page.getByLabel("Root type", { exact: true }).selectOption("object");
  await page.getByLabel("Field 1 format", { exact: true }).selectOption("enum");
  await page.getByLabel("Field 1 value 1", { exact: true }).fill("ok");
  await page.getByLabel("Field 1 label 1", { exact: true }).fill("Approved");
  await page.getByLabel("Field 1 tone 1", { exact: true }).selectOption("success");
  await expect(page.getByRole("button", { name: "Apply working configuration" })).toBeEnabled();
  await page.getByLabel("Value presentation", { exact: true }).selectOption("code");
  await page.getByLabel("Content pointer", { exact: true }).fill("/body");
  await page.getByLabel("Code language", { exact: true }).selectOption("ocaml");
  await expect(page.getByRole("button", { name: "Apply working configuration" })).toBeEnabled();
  await page.getByLabel("Value source", { exact: true }).selectOption("resource");
  await expect(page.getByRole("button", { name: "Apply working configuration" })).toBeDisabled();
  await page.getByLabel("Match a fact key prefix", { exact: true }).uncheck();
  await page.getByLabel("Match a resource MIME type", { exact: true }).check();
  await page.getByLabel("MIME type", { exact: true }).fill("application/json");
  await expect(page.getByRole("button", { name: "Apply working configuration" })).toBeEnabled();
});
test("unknown versions stay inactive and unknown closed fields survive edits; Raw replacement resets staged text", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Unknown field", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Retained future");
  await expect(page.getByRole("button", { name: "Apply working configuration" })).toBeDisabled();
  await expect(page.getByLabel("Candidate JSON")).toContainText('"future":{"n":9007199254740993}');
  await page.getByRole("button", { name: "Unknown version", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Source retained", exact: true })).toBeVisible();
  await expect(page.getByLabel("Name", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Inspect Raw configuration", exact: true }).click();
  await expect(page.getByLabel("Raw candidate", { exact: true })).toHaveValue(
    '{"config_version":99,"kind":"view","future":"retain me"}',
  );
  await page.getByRole("button", { name: "New view", exact: true }).click();
  await page.getByLabel("Set column 1 width", { exact: true }).check();
  await page.getByLabel("Column 1 width", { exact: true }).fill("-");
  await page.getByRole("button", { name: "Raw configuration", exact: true }).click();
  const raw = page.getByLabel("Raw candidate", { exact: true });
  const source = await raw.inputValue();
  await raw.fill(source.replace('"width":160', '"width":220'));
  await page.getByRole("button", { name: "Replace from Raw", exact: true }).click();
  await page.getByRole("button", { name: "Return to form", exact: true }).click();
  await expect(page.getByLabel("Column 1 width", { exact: true })).toHaveValue("220");
  await expect(page.getByRole("button", { name: "Apply working configuration" })).toBeEnabled();
});
test("grouped tables, generic boards, session Unknown time and independent partial value coverage", async ({
  page,
}, info) => {
  const rows = page.getByRole("region", { name: "Captured records", exact: true });
  await page.getByRole("button", { name: "groupedtable fixture", exact: true }).click();
  await expect(rows.getByRole("rowgroup")).toHaveCount(3);
  await expect(rows.getByRole("columnheader", { name: "Title", exact: true })).toBeVisible();
  await expect(rows.getByRole("rowheader", { name: /todo/u })).toBeVisible();
  await page.getByRole("button", { name: "runboard fixture", exact: true }).click();
  await expect(rows.locator(".wg-custom-board")).toBeVisible();
  await expect(rows.getByText("This layout is not applicable", { exact: false })).toHaveCount(0);
  await rows.getByRole("button", { name: "task-a", exact: true }).click();
  await expect(page.getByLabel("Opened record")).toHaveText("task-a");
  await page.getByRole("button", { name: "timeline fixture", exact: true }).click();
  await expect(rows.getByRole("region", { name: "Unknown time", exact: true })).toContainText(
    "session-unknown",
  );
  await expect(rows.getByRole("region", { name: "Unknown time", exact: true })).toContainText(
    "session-range",
  );
  await expect(rows.getByRole("region", { name: "1970-01-01", exact: true })).toContainText(
    "session-old",
  );
  await page.getByRole("button", { name: "values fixture", exact: true }).click();
  await expect(rows).toContainText("Value budget: Metadata loaded");
  await expect(rows).toContainText("Field completeness not established");
  await expect(rows).toContainText("Partial collection");
  await expect(rows).not.toContainText("Selected field is missing");
  await rows.getByText("Inspect JSON value", { exact: true }).click();
  await expect(rows.getByText("Preparing passive JSON view…", { exact: true })).toHaveCount(0);
  await expect(
    rows.getByRole("region", { name: "Content: Selected JSON value", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "factfilter fixture", exact: true }).click();
  await expect(rows).toContainText("Collection traversal complete");
  await expect(rows).toContainText("1 captured row could not be evaluated against pointer filters");
  await expect(rows).toContainText(
    "No confirmed matching captured rows; some matches remain unknown.",
  );
  await rows.getByText("Inspect unevaluated rows", { exact: true }).click();
  await expect(rows).toContainText("budget: Metadata loaded");
  await page.getByRole("button", { name: "values fixture", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(rows).toBeVisible();
  await rows.screenshot({ path: info.outputPath("captured-values-narrow.png") });
});
test("passive Markdown/code/fallbacks and captured content identity reset local source position", async ({
  page,
}) => {
  await page.getByRole("button", { name: "markdown value", exact: true }).click();
  const content = page.getByRole("region", { name: "Content: Summary", exact: true });
  await expect(content.getByRole("heading", { name: "Hello", exact: true })).toBeVisible();
  await expect(content.locator("a,img,script,iframe")).toHaveCount(0);
  await expect(content).toContainText("External");
  await page.getByRole("button", { name: "missing value", exact: true }).click();
  await expect(
    page.getByText("The content pointer is missing or is not text. Generic viewer retained.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("Generic source retained", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "code value", exact: true }).click();
  await expect(content).toContainText("let item_0");
  await content.getByRole("button", { name: "Source", exact: true }).click();
  await content.getByLabel("Language override", { exact: true }).selectOption("plain");
  await expect(
    content.getByRole("list", { name: "Source line window", exact: true }),
  ).toBeVisible();
  await content.getByRole("button", { name: "Next lines", exact: true }).click();
  await expect(content).toContainText("Showing lines 201–230");
  await page.getByRole("button", { name: "Switch captured value", exact: true }).click();
  await expect(content).toContainText("let replacement = 1");
  await expect(content.getByRole("button", { name: "Rendered", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await content.getByRole("button", { name: "Source", exact: true }).click();
  await content.getByLabel("Language override", { exact: true }).selectOption("plain");
  await expect(content).toContainText("Showing lines 1–2");
  await expect(content.getByRole("button", { name: "Previous lines", exact: true })).toBeDisabled();
});
