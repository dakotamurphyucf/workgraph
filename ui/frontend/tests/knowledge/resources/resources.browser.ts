import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { Page, TestInfo } from "@playwright/test";
import type { CompanionFixture } from "../../../../test-support/companion-fixture.mjs";
import type { DaemonFixture } from "../../../../test-support/daemon-fixture.mjs";
import { test, expect } from "../../e2e/support/fixtures";
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
test.use({ viewport: { width: 1500, height: 1000 }, colorScheme: "dark", actionTimeout: 12000 });
async function configure(page: Page, companion: CompanionFixture, daemon: DaemonFixture) {
  const response = await page.request.get(companion.url),
    cap = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(await response.text())?.[1];
  if (!cap) throw new Error("Missing native capability");
  const headers = { Origin: new URL(companion.url).origin, "X-Workgraph-UI-Capability": cap };
  for (const [path, data] of [
    ["/connections", { id: "local", label: "Synthetic Resources", socket: daemon.socket }],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const r = await page.request.post(new URL(`/ui-api/v1${path}`, companion.url).href, {
      headers,
      data,
    });
    expect(r.status()).toBe(200);
    await r.text();
  }
  return headers;
}
async function actor(page: Page, id = "fixture-author") {
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill(id);
  await page.getByLabel("Run ID (optional)", { exact: true }).fill("");
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  await expect(page.locator(".wg-actor-trigger")).toContainText(id);
}
async function readWhenCreated(daemon: DaemonFixture, resourceId: string): Promise<string> {
  try {
    return await daemon.call(
      "resource.get",
      JSON.stringify({ workspace_id: "demo", resource_id: resourceId }),
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes('"kind":"Not_found"'))
      return "Not created yet";
    throw error;
  }
}
function writer(daemon: DaemonFixture) {
  let serial = 0;
  return (method: string, params: object) =>
    daemon.call(
      method,
      JSON.stringify({
        workspace_id: "demo",
        actor_id: "fixture-author",
        mutation_id: `resources-dom-${++serial}`,
        ...params,
      }),
    );
}
async function mount(page: Page, companion: CompanionFixture, query = "") {
  await page.goto(
    new URL(`/#/resources?connection=local&workspace=demo${query}`, companion.url).href,
  );
  await expect(
    page.getByRole("region", { name: "Resources workspace", exact: true }),
  ).toBeVisible();
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  // Live workspace reads stay connected; assertions at each call site establish readiness.
  const path = info.outputPath(name);
  await page.screenshot({ path, fullPage: false });
  await info.attach(name, { path, contentType: "image/png" });
}
const source =
  "# Synthetic guide\n\nA **published** reference.\n\n```ocaml\nlet value = 42\n```\n\n<script>globalThis.resourceInjected = true</script>\n";
test("Resource immutable Markdown/code/source/raw view and complete verified download survive metadata refresh", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  await write("resource.put_text", {
    resource_id: "guide",
    expected_revision: "0",
    title: "Reference document",
    filename: "guide.md",
    mime_type: "text/markdown",
    text: source,
  });
  await configure(page, companion, daemon);
  await mount(
    page,
    companion,
    `&entity=guide&resource_generation=1&content_version=1&content_digest=${sha(source)}`,
  );
  const viewer = page.getByRole("region", { name: "Content: guide.md · content v1", exact: true });
  await expect(viewer.getByRole("heading", { name: "Synthetic guide", exact: true })).toBeVisible();
  await expect(
    viewer.locator(".wg-code-block .wg-syntax-keyword").filter({ hasText: /^let$/u }),
  ).toContainText("let");
  expect(await page.evaluate(() => Object.hasOwn(globalThis, "resourceInjected"))).toBe(false);
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download verified file", exact: true }).click();
  const download = await downloadEvent,
    path = info.outputPath("guide-v1.md");
  await download.saveAs(path);
  expect(sha(await readFile(path))).toBe(sha(source));
  expect((await readFile(path)).toString()).toBe(source);
  await viewer.getByRole("button", { name: "Source", exact: true }).click();
  const sourceCode = viewer.locator(".wg-code-block code");
  await expect(sourceCode).toContainText("# Synthetic guide");
  expect(await sourceCode.textContent()).toBe(source);
  await viewer.getByRole("button", { name: "Raw bytes", exact: true }).click();
  await expect(viewer.locator('pre[aria-label="Raw byte window"]')).toContainText("23");
  await viewer.getByRole("button", { name: "Rendered", exact: true }).click();
  await expect(viewer.getByRole("heading", { name: "Synthetic guide", exact: true })).toBeVisible();
  await viewer.getByLabel("Language override", { exact: true }).selectOption("plain");
  await expect(viewer.getByRole("heading", { name: "Synthetic guide", exact: true })).toHaveCount(
    0,
  );
  await expect(viewer).toContainText("# Synthetic guide");
  await viewer.getByLabel("Language override", { exact: true }).selectOption("auto");
  await expect(viewer.getByRole("heading", { name: "Synthetic guide", exact: true })).toBeVisible();
  await screenshot(page, info, "resource-markdown-dark.png");
  await write("resource.put_text", {
    resource_id: "guide",
    expected_revision: "1",
    title: "Current publication",
    filename: "current.md",
    mime_type: "text/markdown",
    text: "# Current replacement\n",
  });
  await page.getByRole("button", { name: "Refresh metadata", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Current publication", exact: true }),
  ).toBeVisible();
  await expect(viewer.getByRole("heading", { name: "Synthetic guide", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Current replacement", exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Published versions", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open content v1", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open content v2", exact: true })).toBeVisible();
  expect(browserFailures).toEqual([]);
});
test("Resource current editor keeps original writer, preserves metadata omission, and closes without losing saved intention", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  await configure(page, companion, daemon);
  await mount(page, companion);
  await actor(page);
  await page.getByRole("button", { name: "New document", exact: true }).click();
  const editors = page.getByRole("region", { name: "Resource editors", exact: true });
  await editors.getByLabel("Resource ID", { exact: true }).fill("browser-document");
  await editors.getByLabel("Title", { exact: true }).fill("Browser document");
  await editors.getByLabel("Resource document", { exact: true }).fill("# Draft document\n");
  await actor(page, "other-actor");
  await expect(editors).toContainText("Captured writer fixture-author");
  await editors.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editors.getByRole("status").filter({ hasText: /^committed$/u })).toBeVisible();
  await editors.getByRole("button", { name: "Close editor; keep intention", exact: true }).click();
  await expect(editors.getByLabel("Resource ID", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh directory", exact: true }).click();
  await page.getByRole("button", { name: /Browser document.*browser-document/u }).click();
  await expect(
    page.getByRole("region", { name: "Content: document.md · content v1", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit metadata", exact: true }).click();
  await editors.getByLabel("Replace description", { exact: true }).check();
  await editors.getByLabel("Description", { exact: true }).fill("");
  await editors.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editors.getByRole("status").filter({ hasText: /^committed$/u })).toBeVisible();
  const result = await daemon.call(
    "resource.get",
    JSON.stringify({ workspace_id: "demo", resource_id: "browser-document" }),
  );
  expect(result).toContain("Browser document");
  expect(result).toContain("fixture-author");
  await screenshot(page, info, "resource-captured-editor-dark.png");
  expect(browserFailures).toEqual([]);
});
test("Resource exact old-generation link stays pinned after retarget and rejects wrong SHA without current fallback", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  await write("resource.put_text", {
    resource_id: "guide",
    expected_revision: "0",
    title: "Retained resource",
    filename: "guide.md",
    mime_type: "text/markdown",
    text: source,
  });
  const headers = await configure(page, companion, daemon);
  const changed = await page.request.put(
    new URL("/ui-api/v1/connections/local", companion.url).href,
    {
      headers,
      data: {
        expected_generation: "1",
        label: "Changed endpoint",
        socket: "/tmp/synthetic-unavailable-resource.sock",
      },
    },
  );
  expect(changed.status()).toBe(200);
  await changed.text();
  await mount(
    page,
    companion,
    `&entity=guide&resource_generation=1&content_version=1&content_digest=${sha(source)}`,
  );
  await expect(page.getByRole("heading", { name: "Synthetic guide", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "New document", exact: true })).toBeDisabled();
  await expect(
    page.getByText(
      "Viewing retained connection generation 1; new edits require the matching current profile.",
      { exact: true },
    ),
  ).toBeVisible();
  await mount(
    page,
    companion,
    "&entity=guide&resource_generation=1&content_version=1&content_digest=" + "0".repeat(64),
  );
  await expect(
    page.getByRole("heading", { name: "Publication unavailable", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/SHA-256 differs from the exact evidence pin/u)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Synthetic guide", exact: true })).toHaveCount(0);
  await screenshot(page, info, "resource-retained-sha-mismatch.png");
  expect(browserFailures).toEqual([]);
});

async function stageFile(
  page: Page,
  id: string,
  bytes: Buffer,
  name = "artifact.bin",
  sourcePath?: string,
) {
  await page.getByRole("button", { name: "Upload file", exact: true }).click();
  const transfers = page.getByRole("region", { name: "Native Resource transfers", exact: true });
  await transfers.getByLabel("Upload resource ID", { exact: true }).fill(id);
  await transfers.getByLabel("Upload title", { exact: true }).fill(`Synthetic ${id}`);
  await transfers.getByLabel("Complete source file", { exact: true }).setInputFiles(
    sourcePath ?? {
      name,
      mimeType: "application/octet-stream",
      buffer: bytes,
    },
  );
  await transfers.getByRole("button", { name: "Stage exact file", exact: true }).click();
  await expect(transfers.getByRole("status").filter({ hasText: /^sealed ·/u })).toBeVisible({
    timeout: 180000,
  });
  return transfers;
}
async function publishFile(page: Page) {
  const transfers = page.getByRole("region", { name: "Native Resource transfers", exact: true });
  await transfers.getByRole("button", { name: "Prepare native upload", exact: true }).click();
  await expect(
    transfers.getByRole("button", { name: "Start prepared upload", exact: true }),
  ).toBeEnabled();
  await transfers.getByRole("button", { name: "Start prepared upload", exact: true }).click();
  // Inspect is read-only. Each explicit native Start owns the bounded publication;
  // the browser does not retry the mutation while waiting for its result.
  await expect
    .poll(
      async () => {
        await transfers
          .getByRole("button", { name: "Inspect saved transfer", exact: true })
          .click();
        // Live workspace reads stay connected; assertions at each call site establish readiness.
        return transfers
          .getByRole("button", { name: "Open exact published resource", exact: true })
          .count();
      },
      { timeout: 300000, intervals: [500, 1000, 2000] },
    )
    .toBe(1);
  return transfers;
}
test("binary staging cleanup and native publication remain distinct from optional duplicate-link failure", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  test.setTimeout(120000);
  const bytes = Buffer.from([0, 255, 17, 128, 42]),
    write = writer(daemon);
  await configure(page, companion, daemon);
  await mount(page, companion);
  await actor(page);
  let transfers = await stageFile(page, "abandoned-input", bytes);
  await transfers
    .getByRole("button", { name: "Close editor; retain native inputs", exact: true })
    .click();
  await transfers
    .getByRole("button", { name: "Load native transfers and staged inputs", exact: true })
    .click();
  await expect(transfers).toContainText("1 / 2 unprepared inputs");
  await transfers.getByRole("button", { name: "Clean up unprepared input", exact: true }).click();
  await expect(transfers).toContainText("Unprepared input cleanup requested");
  await transfers
    .getByRole("button", { name: "Load native transfers and staged inputs", exact: true })
    .click();
  await expect(transfers).toContainText("0 / 2 unprepared inputs");
  await stageFile(page, "browser-binary", bytes);
  transfers = await publishFile(page);
  await expect(transfers).toContainText(
    "Publication succeeded: browser-binary metadata revision 1, content v1",
  );
  await expect(
    transfers.getByText("No uploads in this loaded capture.", { exact: true }),
  ).toBeVisible();
  await expect(transfers).toContainText("Last-loaded local inventory");
  await expect(
    page.getByRole("complementary", { name: "Resource directory", exact: true }),
  ).toContainText("Last-loaded directory capture");
  await transfers
    .getByRole("heading", { name: "Saved native upload identities", exact: true })
    .scrollIntoViewIfNeeded();
  await screenshot(page, info, "resource-inventory-after-publication-dark.png");
  await transfers
    .getByRole("button", { name: "Open exact published resource", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Download verified file", exact: true }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download verified file", exact: true }).click();
  const result = await download,
    path = info.outputPath("browser-binary-v1.bin");
  await result.saveAs(path);
  expect(await readFile(path)).toEqual(bytes);
  await page
    .getByRole("button", { name: "Download verified file", exact: true })
    .scrollIntoViewIfNeeded();
  await screenshot(page, info, "resource-verified-file-preview-dark.png");
  await write("ticket.create", { ticket_id: "linked-ticket", title: "Synthetic linked ticket" });
  await write("resource.link", {
    resource_id: "browser-binary",
    expected_revision: "1",
    target: { kind: "ticket", id: "linked-ticket" },
  });
  await page.locator(".rs-resource-details > summary").click();
  await page.getByRole("button", { name: "Refresh metadata", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Resources workspace", exact: true }),
  ).toContainText("metadata revision 2");
  await page.getByRole("button", { name: "Replace binary publication", exact: true }).click();
  await transfers.getByLabel("Complete source file", { exact: true }).setInputFiles({
    name: "replacement.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from([0, 254, 18]),
  });
  await transfers.getByLabel("Link to ticket ID (optional)", { exact: true }).fill("linked-ticket");
  await transfers.getByRole("button", { name: "Stage exact file", exact: true }).click();
  await expect(transfers.getByRole("status").filter({ hasText: /^sealed ·/u })).toBeVisible();
  transfers = await publishFile(page);
  await expect(transfers).toContainText(
    "Publication succeeded: browser-binary metadata revision 3, content v2",
  );
  await expect(transfers).toContainText("Conflict");
  await expect(transfers).toContainText("The publication is independently committed");
  await screenshot(page, info, "resource-publication-partial-link-dark.png");
  expect(browserFailures).toEqual([]);
});

test("64MiB Resource stages through emitted digest worker and downloads complete verified bytes with bounded binary preview", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  test.setTimeout(600000);
  const bytes = Buffer.alloc(64 * 1024 * 1024);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  const expected = sha(bytes),
    sourcePath = info.outputPath("full-size.bin");
  await writeFile(sourcePath, bytes);
  await configure(page, companion, daemon);
  await mount(page, companion);
  await actor(page);
  const transfers = await stageFile(page, "full-size-binary", bytes, "full-size.bin", sourcePath);
  await expect(transfers).toContainText(`SHA-256 ${expected}`);
  await publishFile(page);
  await transfers
    .getByRole("button", { name: "Open exact published resource", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Download verified file", exact: true }),
  ).toBeVisible({ timeout: 300000 });
  const viewer = page.getByRole("region", {
    name: "Content: full-size.bin · content v1",
    exact: true,
  });
  await expect(viewer).toContainText("Partial content");
  await expect(viewer.locator('pre[aria-label="Raw byte window"]')).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit text publication", exact: true }),
  ).toBeDisabled();
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download verified file", exact: true }).click();
  const download = await pending,
    path = info.outputPath("full-size-verified.bin");
  await download.saveAs(path);
  const saved = await readFile(path);
  expect(saved.length).toBe(64 * 1024 * 1024);
  expect(sha(saved)).toBe(expected);
  await info.attach("independent-file-verification.json", {
    body: JSON.stringify({
      bytes: saved.length,
      expected,
      saved: sha(saved),
      previewOnly: 1048576,
    }),
    contentType: "application/json",
  });
  await screenshot(page, info, "resource-full-size-binary-dark.png");
  expect(browserFailures).toEqual([]);
});

test("History exact event resource reference opens immutable v1 after current v2 exists", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon),
    original = "# Recorded evidence\n\nOriginal immutable publication.\n";
  await write("resource.put_text", {
    resource_id: "history-artifact",
    expected_revision: "0",
    title: "Recorded evidence",
    filename: "recorded.md",
    mime_type: "text/markdown",
    text: original,
  });
  await write("session.create", {
    session_id: "resource-history",
    title: "Synthetic resource provenance",
  });
  await write("session.append", {
    session_id: "resource-history",
    events: [
      {
        client_id: "recorded-resource",
        role: "sensor",
        kind: "artifact",
        phase: "recorded",
        payload: {
          kind: "inline",
          bytes_base64: Buffer.from("Synthetic recorded artifact").toString("base64"),
        },
        resource_versions: [{ resource_id: "history-artifact", revision: "1" }],
      },
    ],
  });
  await write("resource.put_text", {
    resource_id: "history-artifact",
    expected_revision: "1",
    title: "Current replacement",
    filename: "current.md",
    mime_type: "text/markdown",
    text: "# Current replacement\n",
  });
  await configure(page, companion, daemon);
  await page.goto(
    new URL("/#/history?connection=local&workspace=demo&entity=resource-history", companion.url)
      .href,
  );
  const event = page.locator("#history-event-1");
  await event.getByRole("link", { name: "Exact event link", exact: true }).click();
  await expect(page).toHaveURL(/event=1/u);
  await event
    .getByRole("button", {
      name: "Resource history-artifact · immutable content version 1",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/content_version=1/u);
  const viewer = page.getByRole("region", {
    name: "Content: recorded.md · content v1",
    exact: true,
  });
  await expect(
    viewer.getByRole("heading", { name: "Recorded evidence", exact: true }),
  ).toBeVisible();
  await expect(
    viewer.getByRole("heading", { name: "Current replacement", exact: true }),
  ).toHaveCount(0);
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download verified file", exact: true }).click();
  const result = await pending,
    path = info.outputPath("history-pinned-resource.md");
  await result.saveAs(path);
  expect(await readFile(path, "utf8")).toBe(original);
  expect(sha(await readFile(path))).toBe(sha(original));
  await screenshot(page, info, "history-exact-resource-version.png");
  expect(browserFailures).toEqual([]);
});
test("guarded Resource association and archive forms preserve content version and project-filter truth", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  await write("resource.put_text", {
    resource_id: "associated",
    expected_revision: "0",
    title: "Synthetic associated document",
    filename: "associated.txt",
    mime_type: "text/plain",
    text: "Original source",
  });
  await configure(page, companion, daemon);
  await mount(page, companion, "&entity=associated&resource_generation=1");
  await actor(page);
  const editors = page.getByRole("region", { name: "Resource editors", exact: true });
  async function save() {
    await editors.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editors.getByRole("status").filter({ hasText: /^committed$/u })).toBeVisible();
    await editors
      .getByRole("button", { name: "Close editor; keep intention", exact: true })
      .click();
    await page.getByRole("button", { name: "Refresh metadata", exact: true }).click();
    // Live workspace reads stay connected; assertions at each call site establish readiness.
  }
  await page.getByRole("button", { name: "Link", exact: true }).click();
  await editors.getByLabel("Association type", { exact: true }).selectOption("project");
  await editors.getByLabel("Association ID", { exact: true }).fill("release");
  await save();
  await expect(
    page.getByRole("region", { name: "Resources workspace", exact: true }),
  ).toContainText("metadata revision 2");
  const raw: unknown = JSON.parse(
    await daemon.call(
      "resource.get",
      JSON.stringify({ workspace_id: "demo", resource_id: "associated" }),
    ),
  );
  expect(
    (raw as { result: { data: { metadata: { targets: unknown[] } } } }).result.data.metadata
      .targets,
  ).toContainEqual({ kind: "project", id: "release" });
  await page.getByRole("button", { name: "Unlink", exact: true }).click();
  await editors.getByLabel("Association type", { exact: true }).selectOption("project");
  await editors.getByLabel("Association ID", { exact: true }).fill("release");
  await save();
  await expect(
    page.getByRole("region", { name: "Resources workspace", exact: true }),
  ).toContainText("metadata revision 3");
  for (const archived of [true, false]) {
    await page.getByRole("button", { name: "Archive / restore", exact: true }).click();
    await editors.getByLabel("Archived", { exact: true }).setChecked(archived);
    await save();
    const value: unknown = JSON.parse(
      await daemon.call(
        "resource.get",
        JSON.stringify({ workspace_id: "demo", resource_id: "associated" }),
      ),
    );
    const resource = (
      value as {
        result: {
          data: {
            metadata: { archived: boolean; targets: unknown[] };
            current_version: { revision: string };
          };
        };
      }
    ).result.data;
    expect(resource.metadata.archived).toBe(archived);
    expect(resource.metadata.targets).not.toContainEqual({ kind: "project", id: "release" });
    expect(resource.current_version.revision).toBe("1");
  }
  await screenshot(page, info, "resource-association-archive-forms.png");
  expect(browserFailures).toEqual([]);
});

test("Resource browser follows latest content, retains pinned history and preserves modal draft authors", async ({
  page,
  companion,
  daemon,
  browserFailures,
}) => {
  const write = writer(daemon);
  await write("resource.put_text", {
    resource_id: "reading-guide",
    expected_revision: "0",
    title: "Reading guide",
    filename: "guide.md",
    mime_type: "text/markdown",
    text: "# First publication\n",
  });
  await configure(page, companion, daemon);
  await mount(page, companion);
  await actor(page);
  await page
    .locator(".rs-list")
    .getByRole("button", { name: /Reading guide/u })
    .click();
  await expect(page.getByRole("heading", { name: "First publication", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Details & actions", exact: true }).click();
  const details = page.getByRole("dialog", { name: "Resource details & actions", exact: true });
  await expect(details).toBeVisible();
  await write("resource.put_text", {
    resource_id: "reading-guide",
    expected_revision: "1",
    title: "Reading guide updated",
    filename: "guide.md",
    mime_type: "text/markdown",
    text: "# Second publication\n",
  });
  await expect(details).toContainText("metadata revision 2", { timeout: 20000 });
  await details
    .getByRole("button", { name: "Close Resource details & actions", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Second publication", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "History 2", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Published versions", exact: true })
    .getByRole("button", { name: "Open content v1", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "First publication", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Details & actions", exact: true }).click();
  await details.getByRole("button", { name: "Refresh metadata", exact: true }).click();
  await details
    .getByRole("button", { name: "Close Resource details & actions", exact: true })
    .click();
  await write("resource.put_text", {
    resource_id: "reading-guide",
    expected_revision: "2",
    title: "Third metadata title",
    filename: "guide.md",
    mime_type: "text/markdown",
    text: "# Third publication\n",
  });
  await expect(page.locator(".rs-document-heading")).toContainText("Third metadata title", {
    timeout: 20000,
  });
  await expect(page.getByRole("heading", { name: "First publication", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Third publication", exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "New document", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Resource editor", exact: true });
  await editor.getByLabel("Resource ID", { exact: true }).fill("retained-note");
  await editor.getByLabel("Title", { exact: true }).fill("Retained author note");
  await editor.getByLabel("Resource document", { exact: true }).fill("# Original author\n");
  await editor.getByRole("button", { name: "Close Resource editor", exact: true }).click();
  await actor(page, "other-editor");
  await page.locator(".rs-draft-list > summary").click();
  await page
    .getByLabel("Retained resource editors", { exact: true })
    .selectOption({ label: "text · retained-note · editing" });
  await expect(editor).toContainText("Captured writer fixture-author");
  await expect(editor.getByLabel("Resource document", { exact: true })).toHaveValue(
    "# Original author\n",
  );
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor.getByRole("status").filter({ hasText: /^committed$/u })).toBeVisible();
  const result: unknown = JSON.parse(
    await daemon.call(
      "resource.get",
      JSON.stringify({ workspace_id: "demo", resource_id: "retained-note" }),
    ),
  );
  expect(result).toMatchObject({
    result: { data: { current_version: { actor_id: "fixture-author" } } },
  });
  expect(browserFailures).toEqual([]);
});

test("Resource document and directory scroll independently with the mouse wheel on desktop and narrow layouts", async ({
  page,
  companion,
  daemon,
  browserFailures,
}) => {
  await page.setViewportSize({ width: 1440, height: 850 });
  const write = writer(daemon);
  for (let index = 0; index < 24; index++) {
    const result = await write("resource.put_text", {
      resource_id: `scroll-${index}`,
      expected_revision: "0",
      title: `Scroll document ${index}`,
      filename: "scroll.md",
      mime_type: "text/markdown",
      text:
        index === 0
          ? "# Long scrolling document\n\n" +
            Array.from(
              { length: 100 },
              (_, i) => `## Section ${i}\n\nA retained document paragraph for scrolling.\n`,
            ).join("\n")
          : "Short file.\n",
    });
    expect(result).not.toContain('"error":');
  }
  await configure(page, companion, daemon);
  await mount(page, companion);
  const directory = page.locator(".rs-directory"),
    reader = page.locator(".rs-reader");
  await directory.getByRole("button", { name: /^Scroll document 0 /u }).click();
  await expect(
    reader.getByRole("heading", { name: "Long scrolling document", exact: true }),
  ).toBeVisible();
  const scrollTop = async (target: import("@playwright/test").Locator) =>
    target.evaluate((element) => element.scrollTop);
  await reader.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => scrollTop(reader)).toBeGreaterThan(200);
  expect(await scrollTop(directory)).toBe(0);
  const readerPosition = await scrollTop(reader);
  await directory.hover();
  await page.mouse.wheel(0, 500);
  await expect.poll(() => scrollTop(directory)).toBeGreaterThan(100);
  expect(await scrollTop(reader)).toBe(readerPosition);
  expect(
    await page
      .locator(".wg-content")
      .evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
  ).toBe(true);
  await page.setViewportSize({ width: 760, height: 850 });
  await reader.evaluate((element) => {
    element.scrollTop = 0;
  });
  await reader.hover();
  await page.mouse.wheel(0, 500);
  await expect.poll(() => scrollTop(reader)).toBeGreaterThan(100);
  await page.getByRole("button", { name: "← All resources", exact: true }).click();
  await expect(directory).toBeVisible();
  await directory.evaluate((element) => {
    element.scrollTop = 0;
  });
  await directory.hover();
  await page.mouse.wheel(0, 500);
  await expect.poll(() => scrollTop(directory)).toBeGreaterThan(100);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(browserFailures).toEqual([]);
});

test("Resource directory Previous and Next retain the selected document", async ({
  page,
  daemon,
  companion,
}) => {
  const write = writer(daemon);
  for (let index = 0; index < 101; index++) {
    await write("resource.put_text", {
      resource_id: `page-${String(index).padStart(3, "0")}`,
      expected_revision: "0",
      title: `Paged document ${String(index).padStart(3, "0")}`,
      filename: "page.md",
      mime_type: "text/markdown",
      text: `# Document ${index}\n\nRetain this document while browsing the directory.`,
    });
  }
  await configure(page, companion, daemon);
  await mount(page, companion);
  const directory = page.locator(".rs-directory"),
    reader = page.locator(".rs-reader");
  await expect(
    directory.getByRole("button", { name: "Previous resources page", exact: true }),
  ).toBeDisabled();
  await directory.getByRole("button", { name: "Next resources page", exact: true }).click();
  await directory.getByRole("button").filter({ hasText: "Paged document 100" }).click();
  await expect(reader.getByRole("heading", { name: "Document 100", exact: true })).toBeVisible();
  await expect(
    directory.getByRole("button", { name: "Next resources page", exact: true }),
  ).toBeDisabled();
  await directory.getByRole("button", { name: "Previous resources page", exact: true }).click();
  await expect(
    directory.getByRole("button").filter({ hasText: "Paged document 000" }),
  ).toBeVisible();
  await expect(reader.getByRole("heading", { name: "Document 100", exact: true })).toBeVisible();
  await directory.getByRole("button", { name: "Next resources page", exact: true }).click();
  await expect(
    directory.getByRole("button").filter({ hasText: "Paged document 100" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Refresh directory", exact: true }).click();
  await expect(
    directory.getByRole("button").filter({ hasText: "Paged document 000" }),
  ).toBeVisible();
  await expect(
    directory.getByRole("button", { name: "Previous resources page", exact: true }),
  ).toBeDisabled();
  await expect(reader.getByRole("heading", { name: "Document 100", exact: true })).toBeVisible();
});

test("Published versions paginate both ways while retaining the selected publication", async ({
  page,
  daemon,
  companion,
}) => {
  const write = writer(daemon);
  for (let index = 0; index < 101; index++)
    await write("resource.put_text", {
      resource_id: "versions",
      expected_revision: String(index),
      title: "Versioned guide",
      filename: "guide.md",
      mime_type: "text/markdown",
      text: `# Version ${index + 1}`,
    });
  await configure(page, companion, daemon);
  await mount(page, companion, "&entity=versions");
  await expect(page.getByRole("heading", { name: "Version 101", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^History /u }).click();
  const dialog = page.getByRole("dialog", { name: "Published versions", exact: true });
  await expect(dialog.getByRole("button", { name: "Open content v1", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Next versions page", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Open content v101", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Next versions page", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Previous versions page", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Open content v1", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close Published versions", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Version 101", exact: true })).toBeVisible();
});

test("Resources walkthrough creates, links, archives and compares documents with clear retained drafts", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  await configure(page, companion, daemon);
  await mount(page, companion);
  await actor(page);
  await page.getByRole("button", { name: "New document", exact: true }).click();
  let editor = page.getByRole("dialog", { name: "New document", exact: true });
  await editor.getByLabel("Resource ID", { exact: true }).fill("walkthrough-doc");
  await editor.getByLabel("Title", { exact: true }).fill("Walkthrough guide");
  await editor
    .getByLabel("Resource document", { exact: true })
    .fill("# First version\n\nReadable documentation.");
  await editor.getByRole("button", { name: "Close New document", exact: true }).click();
  await page.locator(".rs-draft-list summary").click();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  editor = page.getByRole("dialog", { name: "New document", exact: true });
  await expect(editor.getByLabel("Title", { exact: true })).toHaveValue("Walkthrough guide");
  await editor.getByRole("button", { name: "Save document", exact: true }).click();
  await expect
    .poll(() => readWhenCreated(daemon, "walkthrough-doc"))
    .toContain("Walkthrough guide");
  await editor.getByRole("button", { name: "Close editor; keep operation", exact: true }).click();
  await page.getByRole("button", { name: "Refresh library", exact: true }).click();
  await page.locator(".rs-list button").filter({ hasText: "Walkthrough guide" }).click();
  await expect(page.getByRole("heading", { name: "First version", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Details & actions", exact: true }).click();
  await page.getByRole("button", { name: "Add link", exact: true }).click();
  editor = page.getByRole("dialog", { name: "Link resource to work", exact: true });
  await editor.getByLabel("Association type").selectOption("project");
  await editor.getByRole("button", { name: "Association ID", exact: true }).click();
  await expect(editor.locator("[data-reference-option]").first()).toBeVisible();
  await editor.locator("[data-reference-option]").first().click();
  await expect(editor.getByRole("button", { name: "Association ID", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await editor.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    editor.getByRole("button", { name: "Close editor; keep operation", exact: true }),
  ).toBeVisible();
  await expect.poll(() => readWhenCreated(daemon, "walkthrough-doc")).toContain('"kind":"project"');
  await editor.getByRole("button", { name: "Close editor; keep operation", exact: true }).click();
  await write("resource.put_text", {
    resource_id: "walkthrough-doc",
    expected_revision: "2",
    title: "Walkthrough guide",
    filename: "document.md",
    mime_type: "text/markdown",
    text: "# Second version\n\nUpdated documentation.",
  });
  await expect(page.getByRole("heading", { name: "Second version", exact: true })).toBeVisible();
  await page.locator(".wg-resource-comparison > summary").click();
  await page.getByLabel("Choose a saved version", { exact: true }).selectOption("1");
  await page.getByRole("button", { name: "Compare versions", exact: true }).click();
  await expect(page.locator(".wg-text-diff")).toContainText("First version");
  await expect(page.locator(".wg-text-diff")).toContainText("Second version");
  await screenshot(page, info, "resources-comparison-redesign.png");
  await page.getByRole("button", { name: "Details & actions", exact: true }).click();
  await page.getByRole("button", { name: "Archive resource", exact: true }).click();
  editor = page.getByRole("dialog", { name: "Archive or restore resource", exact: true });
  await expect(editor).toContainText("previous versions and existing links remain available");
  await editor.getByRole("button", { name: "Archive resource", exact: true }).click();
  await expect.poll(() => readWhenCreated(daemon, "walkthrough-doc")).toContain('"archived":true');
  await editor.getByRole("button", { name: "Close editor; keep operation", exact: true }).click();
  await page.getByRole("checkbox", { name: "Include archived", exact: true }).check();
  await expect(page.locator(".rs-list")).toContainText("Archived");
  expect(browserFailures).toEqual([]);
});

test("Resources file upload explains staging and publishes only after explicit start", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  await configure(page, companion, daemon);
  await mount(page, companion);
  await actor(page);
  await page.getByRole("button", { name: "Upload file", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "File transfers", exact: true });
  await expect(dialog).toContainText("Nothing is published yet");
  await dialog.getByLabel("Upload resource ID", { exact: true }).fill("uploaded-guide");
  await dialog.getByLabel("Upload title", { exact: true }).fill("Uploaded guide");
  await dialog.getByLabel("Complete source file", { exact: true }).setInputFiles({
    name: "guide.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Uploaded guide\n\nA complete file."),
  });
  await screenshot(page, info, "resources-upload-redesign.png");
  await dialog.getByRole("button", { name: "Stage file", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Prepare upload", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Prepare upload", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Publish file", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Publish file", exact: true }).click();
  await expect(dialog).toContainText("File published:");
  await expect
    .poll(() =>
      daemon.call(
        "resource.get",
        JSON.stringify({ workspace_id: "demo", resource_id: "uploaded-guide" }),
      ),
    )
    .toContain("Uploaded guide");
  await dialog.getByRole("button", { name: "Close transfer details", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Selected transfer", exact: true })).toHaveCount(
    0,
  );
  expect(browserFailures).toEqual([]);
});

test("JSON expansion keeps the scrolled resource and clicked field in place", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const text = JSON.stringify(
    Object.fromEntries(
      Array.from({ length: 180 }, (_, i) => [
        `section_${i}`,
        { [`details_${i}`]: { input: i, output: `Result ${i}` } },
      ]),
    ),
  );
  await writer(daemon)("resource.put_text", {
    resource_id: "long-json",
    expected_revision: "0",
    title: "Long JSON",
    filename: "long.json",
    mime_type: "application/json",
    text,
  });
  await configure(page, companion, daemon);
  await mount(page, companion, "&entity=long-json");
  const expand = page.getByRole("button", { name: "Expand details_120", exact: true });
  await expect(expand).toBeAttached();
  await expand.evaluate((node) => node.scrollIntoView({ block: "center" }));
  const reader = page.locator(".rs-reader");
  const before = await reader.evaluate((node) => node.scrollTop);
  expect(before).toBeGreaterThan(1000);
  const y = (await expand.boundingBox())!.y;
  await expand.click();
  const collapse = page.getByRole("button", { name: "Collapse details_120", exact: true });
  await expect(collapse).toBeEnabled();
  expect(Math.abs((await reader.evaluate((node) => node.scrollTop)) - before)).toBeLessThan(5);
  expect(Math.abs((await collapse.boundingBox())!.y - y)).toBeLessThan(5);
  await collapse.click();
  await expect(expand).toBeEnabled();
  expect(Math.abs((await reader.evaluate((node) => node.scrollTop)) - before)).toBeLessThan(5);
  await screenshot(page, info, "json-expanded-position.png");
  expect(browserFailures).toEqual([]);
});
