import { waitForPageReads } from "../../e2e/support/readiness";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { test as base, expect } from "../../e2e/support/fixtures";
import {
  fixtureBinary,
  startDaemonFixture,
  type DaemonFixture,
} from "../../../../test-support/daemon-fixture.mjs";
import type { CompanionFixture } from "../../../../test-support/companion-fixture.mjs";
const test = base.extend<{ readonly secondary: DaemonFixture }>({
  // eslint-disable-next-line no-empty-pattern
  secondary: async ({}, runTest, info) => {
    const daemon = await startDaemonFixture({ binary: fixtureBinary() });
    try {
      await runTest(daemon);
    } finally {
      await daemon.dispose();
      await info.attach("secondary-daemon-after-dispose", {
        contentType: "application/json",
        body: JSON.stringify(daemon.diagnostics()),
      });
    }
  },
});
const execute = promisify(execFile);
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
test.use({ viewport: { width: 1600, height: 1050 }, colorScheme: "dark", actionTimeout: 12000 });
// External fixture writes native captured files directly. No execution helper is called.
async function stage(root: string, name: string, finished = true) {
  const directory = join(await realpath(root), name);
  await mkdir(directory, { mode: 0o700 });
  const command = {
    argv: ["/never-execute-this", "literal ; $(argument)", ""],
    cwd: "/tmp",
    output_limit: "4",
  };
  const commandBytes = JSON.stringify(command);
  await writeFile(join(directory, "command.json"), commandBytes);
  await writeFile(
    join(directory, "owner.json"),
    JSON.stringify({ version: "1", token: "a".repeat(64), command_sha256: sha(commandBytes) }),
  );
  const bytes = Buffer.from([0, 255, 97, 98]);
  // Native evidence-publish requires the exact canonical codec bytes, not merely equivalent JSON.
  if (finished)
    await writeFile(
      join(directory, "capture.json"),
      JSON.stringify({
        command,
        elapsed_ms: "3",
        finished_unix_ms: "1",
        outcome: { code: "7", kind: "exited" },
        source_after: { kind: "not_requested" },
        source_before: { kind: "not_requested" },
        started_unix_ms: "2",
        stderr: { base64: "", eof: true, observed_bytes: "0", observed_sha256: sha("") },
        stdout: {
          base64: bytes.toString("base64"),
          eof: true,
          observed_bytes: "9",
          observed_sha256: sha(Buffer.from([0, 255, 97, 98, 99, 100, 101, 102, 103])),
        },
      }),
    );
  return { directory, bytes };
}
async function actor(page: Page, id: string) {
  await waitForPageReads(page);
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill(id);
  await page.getByLabel("Run ID (optional)", { exact: true }).fill("");
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  await waitForPageReads(page);
  const tool = page.getByRole("button", { name: "Local execution evidence", exact: true });
  if (await tool.isVisible()) await tool.click();
}
async function mount(page: Page, companion: CompanionFixture, daemon: DaemonFixture) {
  const body = await page.request.get(companion.url),
    cap = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(await body.text())?.[1];
  if (cap === undefined) throw new Error("Missing bootstrap capability");
  const headers = { Origin: new URL(companion.url).origin, "X-Workgraph-UI-Capability": cap };
  for (const [path, data] of [
    ["/connections", { id: "local", label: "Local evidence fixture", socket: daemon.socket }],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const response = await page.request.post(new URL(`/ui-api/v1${path}`, companion.url).href, {
      headers,
      data,
    });
    expect(response.status()).toBe(200);
    await response.text();
  }
  await page.goto(
    new URL("/#/workflow?connection=local&workspace=demo&project=release", companion.url).href,
  );
  await expect(page.getByRole("heading", { name: "Graph", exact: true })).toBeVisible();
  await waitForPageReads(page);
  await actor(page, "fixture-author");
  const tool = page.getByRole("button", { name: "Local execution evidence", exact: true });
  if (await tool.isVisible()) await tool.click();
  await expect(
    page.getByRole("heading", { name: "Local execution evidence", exact: true }),
  ).toBeVisible();
}
async function inspect(page: Page, directory: string) {
  await page.getByLabel("Stage directory on companion host", { exact: true }).fill(directory);
  await page.getByRole("button", { name: "Inspect stage", exact: true }).click();
  await expect(page.getByText(directory, { exact: true })).toBeVisible();
  await expect(page.getByText("Reading local evidence…", { exact: true })).toHaveCount(0);
}
function job(page: Page) {
  return page.getByRole("region", { name: /^Publication /u }).first();
}
async function refreshJob(page: Page) {
  await job(page).getByRole("button", { name: "Inspect publication", exact: true }).click();
}

test("LE01 exact retained binary range/tail/download, unfinished and owned cleanup without execution", async ({
  page,
  daemon,
  companion,
}, info) => {
  const saved = await stage(companion.root, "binary-stage"),
    unfinished = await stage(companion.root, "unfinished-stage", false);
  await mount(page, companion, daemon);
  await inspect(page, saved.directory);
  await expect(page.getByText("literal ; $(argument)", { exact: true })).toBeVisible();
  await expect(page.getByText(/4 retained of 9 observed bytes/u)).toBeVisible();
  await page.getByRole("button", { name: "Read output", exact: true }).click();
  await expect(page.getByText(/Text contains replacement characters/u)).toBeVisible();
  await page.getByLabel("Byte selection", { exact: true }).selectOption("retained_tail");
  await page.getByLabel("Maximum bytes", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Read output", exact: true }).click();
  await expect(
    page.getByText("2–4 bytes · 2 retained bytes outside this range", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Verify complete retained stdout", exact: true }).click();
  const link = page.getByRole("link", { name: "Download verified bytes", exact: true });
  await expect(link).toBeVisible();
  const downloading = page.waitForEvent("download");
  await link.click();
  const download = await downloading;
  const path = info.outputPath("stdout.bin");
  await download.saveAs(path);
  expect(await readFile(path)).toEqual(saved.bytes);
  await inspect(page, unfinished.directory);
  await expect(
    page.getByRole("heading", { name: "No completion capture available", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Download verified bytes", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Clean owned stage", exact: true })).toHaveCount(0);
  await inspect(page, saved.directory);
  await page.getByRole("button", { name: "Clean owned stage", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Native cleanup completed");
  await expect
    .poll(async () => {
      try {
        await readFile(join(saved.directory, "command.json"));
        return false;
      } catch (error: unknown) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
        throw error;
      }
    })
    .toBe(true);
  expect(await readFile(join(unfinished.directory, "command.json"), "utf8")).toContain(
    "/never-execute-this",
  );
  await page.screenshot({ path: info.outputPath("inspection-cleanup.png") });
});

test("LE02 publication captures original writer and separates rejected ticket link from resource commit", async ({
  page,
  daemon,
  companion,
  secondary,
}, info) => {
  const saved = await stage(companion.root, "publish-stage");
  await mount(page, companion, daemon);
  await inspect(page, saved.directory);
  await page.getByRole("button", { name: "Prepare publication", exact: true }).click();
  await page.getByLabel("Resource ID", { exact: true }).fill("captured-resource");
  await page.getByLabel("Ticket ID to link (optional)", { exact: true }).fill("missing-ticket");
  await actor(page, "changed-current-writer");
  await page.getByRole("button", { name: "Review publication", exact: true }).click();
  await expect(
    job(page).getByRole("heading", { name: "Ready to publish", exact: true }),
  ).toBeVisible();
  await expect(job(page)).toContainText("fixture-author");
  await page.locator(".wg-workspace-switch").click();
  const manager = page.getByRole("dialog", { name: "Daemon connections", exact: true });
  await manager.getByRole("button", { name: "Edit profile", exact: true }).click();
  await manager.getByLabel("Connection label", { exact: true }).fill("Different current endpoint");
  await manager.getByLabel("Unix socket on companion host", { exact: true }).fill(secondary.socket);
  await manager.getByRole("button", { name: "Save new generation", exact: true }).click();
  await expect(
    manager.getByRole("heading", { name: "Manage Different current endpoint", exact: true }),
  ).toBeVisible();
  await waitForPageReads(page);
  await manager.getByRole("button", { name: "Use this connection", exact: true }).click();
  await waitForPageReads(page);
  const localTool = page.getByRole("button", { name: "Local execution evidence", exact: true });
  if (await localTool.isVisible()) await localTool.click();
  await expect(job(page)).toContainText("Local evidence fixture · original generation 1");
  await job(page).getByRole("button", { name: "Publish resource", exact: true }).click();
  await expect(
    job(page).getByRole("heading", { name: "Resource published", exact: true }),
  ).toBeVisible();
  await expect(job(page)).toContainText("ticket link rejected");
  const readback = await daemon.call(
    "resource.get",
    JSON.stringify({
      workspace_id: "demo",
      resource_id: "captured-resource",
      max_bytes: "1048576",
    }),
  );
  expect(readback).toContain('"actor_id":"fixture-author"');
  const intentBefore = await readFile(join(saved.directory, "publication.json"));
  await job(page).getByText("Exact saved request and receipts", { exact: true }).click();
  await expect(job(page)).toContainText(/local revision [0-9]+/u);
  const revisionText = await job(page).textContent(),
    beforeRevision = /local revision ([0-9]+)/u.exec(revisionText ?? "")?.[1];
  if (beforeRevision === undefined) throw new Error("Missing retained revision");
  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/retry-exact"),
  );
  await job(page).getByRole("button", { name: "Retry exact saved intent", exact: true }).click();
  const retryResponse = await responsePromise;
  expect(retryResponse.status()).toBe(200);
  await retryResponse.finished();
  await expect(
    job(page).getByRole("heading", { name: "Resource published", exact: true }),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        BigInt(/local revision ([0-9]+)/u.exec((await job(page).textContent()) ?? "")?.[1] ?? "0") >
        BigInt(beforeRevision),
    )
    .toBe(true);
  await expect(job(page)).toContainText("ticket link rejected");
  const after = await daemon.call(
    "resource.get",
    JSON.stringify({
      workspace_id: "demo",
      resource_id: "captured-resource",
      max_bytes: "1048576",
    }),
  );
  const resource = (
    JSON.parse(after) as {
      result: {
        data: {
          resource_id: string;
          version_count: string;
          current_version: { revision: string; actor_id: string; digest: string };
        };
      };
    }
  ).result.data;
  expect(resource.resource_id).toBe("captured-resource");
  expect(resource.version_count).toBe("1");
  expect(resource.current_version.revision).toBe("1");
  expect(resource.current_version.actor_id).toBe("fixture-author");
  const other = JSON.parse(
    await secondary.call(
      "resource.list",
      JSON.stringify({ workspace_id: "demo", limit: "100", max_bytes: "1048576" }),
    ),
  ) as { result: { data: { items: { resource_id: string }[] } } };
  expect(other.result.data.items.some((item) => item.resource_id === "captured-resource")).toBe(
    false,
  );
  expect(resource.current_version.digest).toBe(
    sha(await readFile(join(saved.directory, "capture.json"))),
  );
  expect(await readFile(join(saved.directory, "publication.json"))).toEqual(intentBefore);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("publication-original-writer.png") });
});

test("LE03 external already-published intent binds offline as unknown and recovers after source removal", async ({
  page,
  daemon,
  companion,
}, info) => {
  const saved = await stage(companion.root, "external-stage");
  try {
    await execute(daemon.binary, [
      "--socket",
      daemon.socket,
      "evidence-publish",
      "--stage",
      saved.directory,
      "--workspace-id",
      "demo",
      "--actor-id",
      "external-author",
      "--resource-id",
      "external-resource",
      "--expected-revision",
      "0",
      "--title",
      "External captured evidence",
    ]);
  } catch (error: unknown) {
    const detail =
      error instanceof Error ? error : new Error("External native CLI failed", { cause: error });
    await info.attach("external-cli-failure", {
      contentType: "application/json",
      body: JSON.stringify({
        message: detail.message,
        stdout: "stdout" in detail ? detail.stdout : null,
        stderr: "stderr" in detail ? detail.stderr : null,
      }),
    });
    throw detail;
  }
  const original = await readFile(join(saved.directory, "publication.json"));
  await rm(join(saved.directory, "capture.json"));
  await mount(page, companion, daemon);
  await inspect(page, saved.directory);
  await page.getByRole("button", { name: "Inspect saved native intent", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Associate an external saved intent", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Associate saved intent with this endpoint", exact: true })
    .click();
  await expect(
    job(page).getByRole("heading", { name: "Publication outcome unknown", exact: true }),
  ).toBeVisible();
  await expect(
    job(page).getByRole("button", { name: "Publish resource", exact: true }),
  ).toHaveCount(0);
  expect(await readFile(join(saved.directory, "publication.json"))).toEqual(original);
  await job(page).getByRole("button", { name: "Recover receipts only", exact: true }).click();
  await expect(
    job(page).getByRole("heading", { name: "Resource published", exact: true }),
  ).toBeVisible();
  await expect(job(page)).toContainText("No ticket link requested");
  await refreshJob(page);
  expect(await readFile(join(saved.directory, "publication.json"))).toEqual(original);
  const readback = await daemon.call(
    "resource.get",
    JSON.stringify({
      workspace_id: "demo",
      resource_id: "external-resource",
      max_bytes: "1048576",
    }),
  );
  expect(readback).toContain('"actor_id":"external-author"');
  await page.screenshot({ path: info.outputPath("external-receipt-recovery.png") });
});
