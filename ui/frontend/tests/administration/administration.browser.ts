import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, realpath, rmdir, stat, writeFile } from "node:fs/promises";
import { test, expect } from "../e2e/support/fixtures";
import type { Locator, Page, TestInfo } from "@playwright/test";
import type { CompanionFixture } from "../../../test-support/companion-fixture.mjs";
import {
  fixtureBinary,
  startDaemonFixture,
  type DaemonFixture,
} from "../../../test-support/daemon-fixture.mjs";
import { parseJsonText, jsonField, type JsonValue } from "../../src/core/json";
import * as c from "../../src/core/protocol/codec";
import * as d from "../../src/core/protocol/decoders";
import { field } from "../../src/features/administration/model";
import { exportJobCodec } from "../../src/features/administration/client";
import type { ExportJob } from "../../src/features/administration/types";

const execute = promisify(execFile);
function parsed(source: string): JsonValue {
  const result = parseJsonText(source);
  if (!result.ok) throw new Error(result.error.message);
  return result.value.value;
}
function data(source: string) {
  return field(field(parsed(source), "result", c.object), "data", c.object);
}
async function call(
  daemon: DaemonFixture,
  method: string,
  params: Readonly<Record<string, unknown>>,
) {
  return data(await daemon.call(method, JSON.stringify(params)));
}
function exportJob(value: JsonValue): ExportJob {
  const decoded = exportJobCodec.decode(value);
  if (!decoded.ok) throw new Error(decoded.issue.expected);
  return decoded.value;
}
async function waitExport(daemon: DaemonFixture, job: ExportJob) {
  let result = job;
  await expect
    .poll(
      async () => {
        result = exportJob(await call(daemon, "export.get", { job_id: job.job_id }));
        return result.status;
      },
      { timeout: 30_000, intervals: [20, 50, 100] },
    )
    .not.toBe("running");
  return result;
}
async function profiles(
  page: Page,
  companion: CompanionFixture,
  entries: readonly (readonly [string, string])[],
) {
  const bootstrap = await page.request.get(companion.url);
  expect(bootstrap.status()).toBe(200);
  const capability = /<meta name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(
    await bootstrap.text(),
  )?.[1];
  if (!capability) throw new Error("Missing native capability");
  for (const [id, socket] of entries)
    for (const [endpoint, body] of [
      ["/connections", { id, label: `Administration ${id}`, socket }],
      [`/connections/${id}/attach`, { generation: "1" }],
    ] as const) {
      const response = await page.request.post(
        new URL(`/ui-api/v1${endpoint}`, companion.url).href,
        {
          headers: {
            Origin: new URL(companion.url).origin,
            "X-Workgraph-UI-Capability": capability,
          },
          data: body,
        },
      );
      expect(response.status()).toBe(200);
      await response.text();
    }
  return capability;
}
async function mount(
  page: Page,
  companion: CompanionFixture,
  connection = "local",
  workspace = "demo",
) {
  await page.goto(
    `${companion.url}#/overview?connection=${connection}${workspace === "" ? "" : `&workspace=${workspace}`}`,
  );
  await page
    .locator("summary")
    .filter({ hasText: /^Workspace and project management$/u })
    .click();
  await expect(page.getByRole("heading", { name: "Administration", exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
  return page.getByRole("region", { name: "Administration", exact: true });
}
async function writer(page: Page, beforeChange: () => void) {
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill("admin-browser");
  beforeChange();
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  await page.waitForLoadState("networkidle");
}
function panel(root: Locator, title: string) {
  return root
    .locator("section.wg-panel")
    .filter({ has: root.page().getByRole("heading", { name: title, exact: true }) });
}
async function apply(admin: Locator, state = "committed") {
  await admin.getByRole("button", { name: "Review and prepare action", exact: true }).click();
  const review = panel(admin, "Review captured action");
  await expect(review.locator(".wg-badge")).toHaveText("prepared_unsent");
  await review.getByRole("button", { name: "Execute saved request", exact: true }).click();
  await expect(review.locator(".wg-badge")).toHaveText(state, { timeout: 15_000 });
  await admin.page().waitForLoadState("networkidle");
  return review;
}
async function closeEditor(admin: Locator) {
  await admin.getByRole("button", { name: "Close editor", exact: true }).click();
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  const target = info.outputPath(name);
  await page.screenshot({ path: target, fullPage: true });
  await info.attach(name, { path: target, contentType: "image/png" });
}
async function hashTree(
  directory: string,
  relative = "",
): Promise<Readonly<Record<string, string>>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    if (entry.name === ".local") continue;
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(result, await hashTree(directory, name));
    else if (entry.isFile())
      result[name] = createHash("sha256")
        .update(await readFile(path.join(directory, name)))
        .digest("hex");
    else throw new Error("Unexpected source fixture link/special file");
  }
  return result;
}

test("tailored export, verify, durable operation reload and receipt recovery use the original identity", async ({
  page,
  daemon,
  companion,
  browserDiagnostics,
}, info) => {
  await profiles(page, companion, [["local", daemon.socket]]);
  let admin = await mount(page, companion);
  await writer(page, browserDiagnostics.markPendingReads);
  const destination = path.join(daemon.root, "ui-export");
  const canonicalDestination = path.join(await realpath(daemon.root), "ui-export");
  await admin.getByRole("button", { name: "Export workspace", exact: true }).click();
  await admin
    .getByLabel("Fresh export destination on daemon host", { exact: true })
    .fill(destination);
  const review = await apply(admin);
  await expect(review.getByText("admin-browser", { exact: true })).toBeVisible();
  const jobs = field(
    await call(daemon, "export.list", { limit: "100" }),
    "items",
    c.array(exportJobCodec, 100),
  );
  const initial = jobs.find((job) => job.destination === canonicalDestination);
  if (!initial) throw new Error("UI export job absent");
  expect((await waitExport(daemon, initial)).status).toBe("completed");
  await closeEditor(admin);
  await admin.getByRole("button", { name: "Read export jobs", exact: true }).click();
  await admin
    .getByRole("button", { name: "Use published directory for verification", exact: true })
    .click();
  await admin
    .getByRole("button", { name: "Verify export inventory and hashes", exact: true })
    .click();
  await expect(admin.getByText(/Inventory verification result for workspace/u)).toContainText(
    "demo",
  );
  await expect(admin.getByText(/Full canonical replay is not performed/u)).toBeVisible();
  await admin.getByRole("button", { name: "Journals and recovery", exact: true }).click();
  await admin.getByRole("button", { name: "List companion saved operations", exact: true }).click();
  const reload = admin.getByRole("button", { name: /^Reload saved operation /u });
  await expect(reload).toHaveCount(1);
  const label = await reload.textContent();
  if (!label) throw new Error("Missing operation ID label");
  await page.waitForLoadState("networkidle");
  await page.reload();
  await page
    .locator("summary")
    .filter({ hasText: /^Workspace and project management$/u })
    .click();
  admin = page.getByRole("region", { name: "Administration", exact: true });
  await admin.getByRole("button", { name: "Journals and recovery", exact: true }).click();
  await admin.getByRole("button", { name: "List companion saved operations", exact: true }).click();
  await admin.getByRole("button", { name: label, exact: true }).click();
  const recovered = panel(admin, "Review captured action");
  await expect(recovered.locator(".wg-badge")).toHaveText("committed");
  await recovered.getByRole("button", { name: "Recover receipt", exact: true }).click();
  await expect(recovered.locator(".wg-badge")).toHaveText("committed");
  await expect(recovered.getByText("admin-browser", { exact: true })).toBeVisible();
  expect((await call(daemon, "export.get", { job_id: initial.job_id })).fields).not.toHaveLength(0);
  await screenshot(page, info, "admin-export-recovered.png");
});

test("export all and explicit restore-all register complete captured workspaces closed; invalid cancellation never claims rollback", async ({
  page,
  daemon,
  companion,
  browserDiagnostics,
}, info) => {
  test.setTimeout(60_000);
  const fresh = await startDaemonFixture({ binary: fixtureBinary(), seed: false });
  try {
    await profiles(page, companion, [
      ["local", daemon.socket],
      ["fresh", fresh.socket],
    ]);
    let admin = await mount(page, companion);
    await writer(page, browserDiagnostics.markPendingReads);
    const destination = path.join(daemon.root, "ui-all");
    const canonicalDestination = path.join(await realpath(daemon.root), "ui-all");
    await admin.getByRole("button", { name: "Export all workspaces", exact: true }).click();
    await admin
      .getByLabel("Fresh export destination on daemon host", { exact: true })
      .fill(destination);
    await apply(admin);
    const jobs = field(
      await call(daemon, "export.list", { limit: "100" }),
      "items",
      c.array(exportJobCodec, 100),
    );
    const initial = jobs.find((job) => job.destination === canonicalDestination);
    if (!initial) throw new Error("all-export absent");
    expect((await waitExport(daemon, initial)).status).toBe("completed");
    await page.waitForLoadState("networkidle");
    browserDiagnostics.markPendingReads();
    await page.goto(`${companion.url}#/overview?connection=fresh`);
    await page
      .locator("summary")
      .filter({ hasText: /^Workspace and project management$/u })
      .click();
    admin = page.getByRole("region", { name: "Administration", exact: true });
    await admin.getByRole("button", { name: "Restore", exact: true }).click();
    await admin.getByRole("button", { name: "Restore all workspaces", exact: true }).click();
    await admin.getByLabel("Export directory on daemon host", { exact: true }).fill(destination);
    await admin
      .getByLabel("Exact workspace-to-root JSON", { exact: true })
      .fill(JSON.stringify({ demo: path.join(fresh.root, "restored-demo") }));
    await expect(admin.getByText(/There is no percentage progress value/u)).toBeVisible();
    await apply(admin);
    const listing = field(
      await call(fresh, "workspace.list", {}),
      "workspaces",
      c.array(c.object, 100),
    );
    expect(listing).toHaveLength(1);
    expect(field(listing[0] ?? d.jsonNull(), "workspace_id", d.identifier)).toBe("demo");
    expect(field(listing[0] ?? d.jsonNull(), "open", c.boolean)).toBe(false);
    await closeEditor(admin);
    await admin.getByRole("button", { name: "Cancel pending restore", exact: true }).click();
    await admin.getByLabel("Original restore actor", { exact: true }).fill("admin-browser");
    await admin.getByLabel("Original restore mutation", { exact: true }).fill("never-admitted");
    const rejected = await apply(admin, "rejected");
    await expect(rejected.getByRole("alert")).toContainText(/Conflict|Not_found/u);
    expect(
      field(await call(fresh, "workspace.list", {}), "workspaces", c.array(c.object, 100)),
    ).toHaveLength(1);
    await screenshot(page, info, "admin-restore-closed.png");
  } finally {
    await fresh.dispose();
  }
});

test("first-run offline conversion preserves released source bytes and complete history mapping report, reloads success and cancels unsent work", async ({
  page,
  companion,
}, info) => {
  test.setTimeout(60_000);
  const source = path.join(companion.root, "released-source"),
    destination = path.join(companion.root, "converted");
  await cp(path.resolve("../../test/migration/fixtures/v062"), source, { recursive: true });
  const before = await hashTree(source);
  await page.goto(companion.url);
  await page.getByRole("button", { name: "Connection profiles", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Daemon connections", exact: true });
  await dialog.getByText("Offline administration and journals", { exact: true }).click();
  let admin = dialog.getByRole("region", { name: "Administration", exact: true });
  await admin.getByRole("button", { name: "Migrate 0.6.2 workspace", exact: true }).click();
  await admin
    .getByLabel("Stopped 0.6.2 workspace source on companion host", { exact: true })
    .fill(source);
  await admin.getByLabel("Fresh destination on companion host", { exact: true }).fill(destination);
  await admin.getByRole("button", { name: "Review and prepare action", exact: true }).click();
  let review = panel(admin, "Review offline helper");
  await expect(review.locator(".wg-badge")).toHaveText("prepared_unsent");
  await expect(review.getByText(/Captured actor observer/u)).toBeVisible();
  await review.getByRole("button", { name: "Apply prepared offline helper", exact: true }).click();
  await expect(review.locator(".wg-badge")).toHaveText("succeeded", { timeout: 20_000 });
  expect(await hashTree(source)).toEqual(before);
  const reportNames = (await readdir(companion.ready.state_root)).filter((name) =>
    /^admin-report-.+\.data$/u.test(name),
  );
  expect(reportNames).toHaveLength(1);
  const name = reportNames[0];
  if (!name) throw new Error("Missing complete report");
  const reportBytes = await readFile(path.join(companion.ready.state_root, name));
  const report = parsed(reportBytes.toString("utf8"));
  const mappings = field(report, "history_heads", c.object);
  expect(mappings.fields).toHaveLength(5);
  const oldHead = field(report, "source_history_head", d.digest),
    newHead = field(report, "history_head", d.digest);
  expect(jsonField(mappings, oldHead)).toEqual(d.jsonString(newHead));
  await expect(
    review.getByText(createHash("sha256").update(reportBytes).digest("hex"), { exact: true }),
  ).toBeVisible();
  await expect(
    review.getByRole("button", { name: "Copy full-report command", exact: true }),
  ).toBeVisible();
  await screenshot(page, info, "admin-offline-report.png");
  await page.reload();
  await page.getByRole("button", { name: "Connection profiles", exact: true }).click();
  await dialog.getByText("Offline administration and journals", { exact: true }).click();
  admin = dialog.getByRole("region", { name: "Administration", exact: true });
  await admin.getByRole("button", { name: "List saved offline jobs", exact: true }).click();
  await admin.getByRole("button", { name: "Open saved offline helper", exact: true }).click();
  review = panel(admin, "Review offline helper");
  await expect(review.locator(".wg-badge")).toHaveText("succeeded");
  await closeEditor(admin);
  await admin.getByRole("button", { name: "Migrate 0.6.2 workspace", exact: true }).click();
  await admin
    .getByLabel("Stopped 0.6.2 workspace source on companion host", { exact: true })
    .fill(source);
  const canceledDestination = path.join(companion.root, "must-not-exist");
  await admin
    .getByLabel("Fresh destination on companion host", { exact: true })
    .fill(canceledDestination);
  await admin.getByRole("button", { name: "Review and prepare action", exact: true }).click();
  review = panel(admin, "Review offline helper");
  await expect(review.locator(".wg-badge")).toHaveText("prepared_unsent");
  await review.getByRole("button", { name: "Cancel unsent helper", exact: true }).click();
  await expect(review.locator(".wg-badge")).toHaveText("canceled_unsent");
  await expect(
    review.getByText("Canceled before execution. This helper was not run.", { exact: true }),
  ).toBeVisible();
  await expect(review.getByText(/does not prove rollback/u)).toHaveCount(0);
  await expect(stat(canceledDestination)).rejects.toMatchObject({ code: "ENOENT" });
  await closeEditor(admin);
  const damaged = path.join(companion.root, "damaged-source"),
    failed = path.join(companion.root, "failed");
  await cp(path.resolve("../../test/migration/fixtures/v062"), damaged, { recursive: true });
  const blob = (await readdir(path.join(damaged, "blobs")))[0];
  if (!blob) throw new Error("Released fixture has no source blob to corrupt");
  await writeFile(path.join(damaged, "blobs", blob), "deliberately corrupted fixture blob");
  await admin.getByRole("button", { name: "Migrate 0.6.2 workspace", exact: true }).click();
  await admin
    .getByLabel("Stopped 0.6.2 workspace source on companion host", { exact: true })
    .fill(damaged);
  await admin.getByLabel("Fresh destination on companion host", { exact: true }).fill(failed);
  await admin.getByRole("button", { name: "Review and prepare action", exact: true }).click();
  review = panel(admin, "Review offline helper");
  await expect(review.locator(".wg-badge")).toHaveText("prepared_unsent");
  await review.getByRole("button", { name: "Apply prepared offline helper", exact: true }).click();
  await expect(review.locator(".wg-badge")).toHaveText("failed", { timeout: 20_000 });
  await expect(review.getByRole("alert")).toContainText("owned stage:");
  const stages = (await readdir(companion.root)).filter((name) =>
    name.startsWith("failed.migrating-"),
  );
  expect(stages).toHaveLength(1);
  const stageName = stages[0];
  if (!stageName) throw new Error("Missing actual failed migration stage");
  const stage = path.join(companion.root, stageName);
  const marker = parsed(await readFile(path.join(stage, ".local/migration.json"), "utf8"));
  const token = field(marker, "owner_token", d.digest);
  await closeEditor(admin);
  await admin.getByRole("button", { name: "Clean owned migration stage", exact: true }).click();
  await admin.getByLabel("Owned unpublished stage on companion host", { exact: true }).fill(stage);
  await admin.getByLabel("Exact cleanup owner token", { exact: true }).fill(token);
  await admin.getByRole("button", { name: "Review and prepare action", exact: true }).click();
  review = panel(admin, "Review offline helper");
  await expect(review.locator(".wg-badge")).toHaveText("prepared_unsent");
  await review.getByRole("button", { name: "Apply prepared offline helper", exact: true }).click();
  await expect(review.locator(".wg-badge")).toHaveText("succeeded", { timeout: 20_000 });
  await expect(stat(stage)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await stat(damaged)).isDirectory()).toBe(true);
  expect((await stat(destination)).isDirectory()).toBe(true);
  expect(await hashTree(source)).toEqual(before);
  await screenshot(page, info, "admin-offline-cleanup.png");
});

test("external orphan journal inspection preserves exact actor/mutation/hash and hands off an unchanged explicit CLI retry", async ({
  page,
  daemon,
  companion,
}, info) => {
  const directory = path.join(companion.root, "external journals");
  await mkdir(directory);
  const file = path.join(directory, "request ' quoted.json"),
    absent = path.join(companion.root, "absent-socket");
  await expect(
    execute(
      daemon.binary,
      [
        "ticket",
        "create",
        absent,
        "--workspace-id",
        "demo",
        "--actor-id",
        "external-author",
        "--mutation-id",
        "external-exact",
        "--ticket-id",
        "external-ticket",
        "--title",
        "External exact retry",
        "--save-request",
        file,
      ],
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
    ),
  ).rejects.toBeDefined();
  const original = await readFile(file),
    originalHash = createHash("sha256").update(original).digest("hex");
  await profiles(page, companion, [["local", daemon.socket]]);
  const admin = await mount(page, companion);
  await admin.getByRole("button", { name: "Journals and recovery", exact: true }).click();
  await admin.getByLabel("Journal directory on companion host", { exact: true }).fill(directory);
  await admin.getByRole("button", { name: "Inspect journal directory", exact: true }).click();
  await expect(admin.getByText(/Directory observation complete: yes/u)).toBeVisible();
  await admin.getByLabel("Exact saved request path on companion host", { exact: true }).fill(file);
  await admin.getByRole("button", { name: "Inspect exact saved request", exact: true }).click();
  await expect(admin.getByText("external-author", { exact: true })).toBeVisible();
  await expect(admin.getByText("external-exact", { exact: true })).toBeVisible();
  await expect(admin.getByText(/commit unchecked · transmission unknown/u)).toBeVisible();
  await admin
    .getByRole("button", { name: "Use selected connection socket explicitly", exact: true })
    .click();
  await expect(admin.getByLabel("External exact retry command", { exact: true })).toContainText(
    "workgraph retry",
  );
  await expect(admin.getByLabel("External exact retry command", { exact: true })).toContainText(
    daemon.socket,
  );
  const first = await execute(daemon.binary, ["retry", daemon.socket, file], {
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const second = await execute(daemon.binary, ["retry", daemon.socket, file], {
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  expect(second.stdout).toBe(first.stdout);
  expect(
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex"),
  ).toBe(originalHash);
  expect(
    field(
      field(
        await call(daemon, "ticket.get", { workspace_id: "demo", ticket_id: "external-ticket" }),
        "ticket",
        c.object,
      ),
      "title",
      c.text,
    ),
  ).toBe("External exact retry");
  await info.attach("external-exact-retry-proof", {
    contentType: "application/json",
    body: JSON.stringify(
      {
        originalHash,
        afterHash: createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
        first: parsed(first.stdout),
        second: parsed(second.stdout),
      },
      null,
      2,
    ),
  });
  await screenshot(page, info, "admin-journal-exact.png");
});

test("failed export collision is repaired before deliberate UI retry; terminal cancellation remains a rejection", async ({
  page,
  daemon,
  companion,
  browserDiagnostics,
}, info) => {
  const destination = path.join(daemon.root, "retry-export");
  // Fixture-only deterministic collision at the current native worker's first
  // staging path, derived from an explicit registry mutation identity. The
  // destination itself remains fresh, so admission succeeds and the job fails.
  const jobId = `export_${createHash("sha256").update("admin-fixture:failed").digest("hex")}`;
  const collision = `${destination}.exporting-${jobId}-1`;
  await mkdir(collision);
  const initial = exportJob(
    await call(daemon, "workspace.export", {
      workspace_id: "demo",
      destination,
      actor_id: "admin-fixture",
      mutation_id: "failed",
    }),
  );
  expect(initial.job_id).toBe(jobId);
  expect((await waitExport(daemon, initial)).status).toBe("failed");
  // Only this owned, still-empty collision is removed; no exporter stage is adopted.
  await rmdir(collision);
  await profiles(page, companion, [["local", daemon.socket]]);
  const admin = await mount(page, companion);
  await writer(page, browserDiagnostics.markPendingReads);
  await admin.getByRole("button", { name: "Read export jobs", exact: true }).click();
  const card = admin
    .locator("article.wg-admin-job")
    .filter({ has: page.locator("h4 code", { hasText: jobId }) });
  await card.getByRole("button", { name: "Review retry of original capture", exact: true }).click();
  await apply(admin);
  const retried = await waitExport(daemon, initial);
  expect(retried.status).toBe("completed");
  expect(retried.attempt).toBe("2");
  expect(retried.captures).toEqual(initial.captures);
  await closeEditor(admin);
  await admin.getByLabel("Export job to inspect", { exact: true }).fill(jobId);
  await admin.getByRole("button", { name: "Cancel export by ID", exact: true }).click();
  const rejected = await apply(admin, "rejected");
  await expect(rejected.getByRole("alert")).toContainText("export is not running");
  expect((await waitExport(daemon, initial)).status).toBe("completed");
  await info.attach("export-retry-and-terminal-cancel-proof", {
    contentType: "application/json",
    body: JSON.stringify(
      {
        initial,
        retried,
        cancellation: "rejected-terminal-job; successful UI cancellation not claimed",
      },
      null,
      2,
    ),
  });
  await screenshot(page, info, "admin-export-retry.png");
});

test("Maintenance separates export and verification, retains captured drafts and exposes offline recovery", async ({
  page,
  daemon,
  companion,
  browserDiagnostics,
}) => {
  await profiles(page, companion, [["local", daemon.socket]]);
  await page.goto(`${companion.url}#/overview?connection=local&workspace=demo`);
  await expect(
    page.locator(".wg-prototype-overview").getByRole("button", { name: "Refresh", exact: true }),
  ).toBeEnabled();
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill("maintenance-author");
  browserDiagnostics.markPendingReads();
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Manage workspace", exact: true });
  const openMaintenance = async () => {
    browserDiagnostics.markPendingReads();
    await page.getByRole("button", { name: "Manage workspace", exact: true }).click();
    await dialog.getByRole("button", { name: /^Maintenance Backup/u }).click();
  };
  await openMaintenance();
  const admin = dialog.getByRole("region", { name: "Administration", exact: true });
  await expect(admin.getByRole("region", { name: "Workspace exports", exact: true })).toBeVisible();
  await expect(admin.getByRole("region", { name: "Verify an export", exact: true })).toBeVisible();
  await expect(admin.getByLabel("Export job to inspect", { exact: true })).toBeHidden();
  const destination = path.join(daemon.root, "maintenance-export");
  await admin.getByRole("button", { name: "Export workspace", exact: true }).click();
  await admin
    .getByLabel("Fresh export destination on daemon host", { exact: true })
    .fill(destination);
  browserDiagnostics.markPendingReads();
  await dialog.getByRole("button", { name: "Close Manage workspace", exact: true }).click();
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill("different-viewer");
  browserDiagnostics.markPendingReads();
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  await openMaintenance();
  await expect(
    admin.getByLabel("Fresh export destination on daemon host", { exact: true }),
  ).toHaveValue(destination);
  await admin.getByRole("button", { name: "Review and prepare action", exact: true }).click();
  const review = panel(admin, "Review captured action");
  await expect(review.locator(".wg-badge")).toHaveText("prepared_unsent");
  await expect(review.getByText("maintenance-author", { exact: true })).toBeVisible();
  await review.getByRole("button", { name: "Execute saved request", exact: true }).click();
  await expect(review.locator(".wg-badge")).toHaveText("committed");
  const jobs = field(
    await call(daemon, "export.list", { limit: "100" }),
    "items",
    c.array(exportJobCodec, 100),
  );
  const job = jobs.find((entry) => entry.destination.endsWith("/maintenance-export"));
  if (!job) throw new Error("Missing actual UI export");
  expect((await waitExport(daemon, job)).status).toBe("completed");
  await closeEditor(admin);
  await admin.getByRole("button", { name: "Read export jobs", exact: true }).click();
  await admin
    .getByRole("button", { name: "Use published directory for verification", exact: true })
    .click();
  await admin
    .getByRole("button", { name: "Verify export inventory and hashes", exact: true })
    .click();
  await expect(admin.getByText(/Inventory verification result for workspace/u)).toContainText(
    "demo",
  );
  await admin.getByText("Find an export by job ID", { exact: true }).click();
  await admin.getByLabel("Export job to inspect", { exact: true }).fill(job.job_id);
  await admin.getByRole("button", { name: "Inspect export current status", exact: true }).click();
  await expect(admin.locator(".wg-admin-inspector .wg-badge")).toHaveText("completed");
  browserDiagnostics.markPendingReads();
  await admin.getByRole("button", { name: "Restore", exact: true }).click();
  await admin.getByLabel("Registry receipt actor", { exact: true }).fill("retained-receipt-author");
  await admin.getByRole("button", { name: "Offline migration", exact: true }).click();
  await expect(
    admin.getByRole("button", { name: "Migrate 0.6.2 workspace", exact: true }),
  ).toBeVisible();
  await admin.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(admin.getByLabel("Registry receipt actor", { exact: true })).toHaveValue(
    "retained-receipt-author",
  );
  await admin.getByRole("button", { name: "Exports", exact: true }).click();
  await expect(admin.getByLabel("Directory to verify on daemon host", { exact: true })).toHaveValue(
    job.destination,
  );
  await page.setViewportSize({ width: 600, height: 850 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  browserDiagnostics.markPendingReads();
  await dialog.getByRole("button", { name: "Close Manage workspace", exact: true }).click();
});

test("Offline tools remain available before connection setup and retain an unsent migration plan", async ({
  page,
  companion,
  browserDiagnostics,
}) => {
  const source = path.join(companion.root, "offline-source");
  const destination = path.join(companion.root, "never-started-migration");
  await cp(
    fileURLToPath(new URL("../../../../test/migration/fixtures/v062", import.meta.url)),
    source,
    { recursive: true },
  );
  await page.goto(companion.url);
  const dialog = page.getByRole("dialog", { name: "Daemon connections", exact: true });
  const openOffline = async () => {
    await page.getByRole("button", { name: "Connection profiles", exact: true }).click();
    await dialog.getByRole("button", { name: "Offline tools", exact: true }).click();
  };
  await openOffline();
  const admin = dialog.getByRole("region", { name: "Administration", exact: true });
  await expect(admin.getByRole("button", { name: "Exports", exact: true })).toHaveCount(0);
  await admin.getByRole("button", { name: "Migrate 0.6.2 workspace", exact: true }).click();
  await admin
    .getByLabel("Stopped 0.6.2 workspace source on companion host", { exact: true })
    .fill(source);
  await admin.getByLabel("Fresh destination on companion host", { exact: true }).fill(destination);
  await admin.getByRole("button", { name: "Review and prepare action", exact: true }).click();
  const review = panel(admin, "Review offline helper");
  await expect(review.locator(".wg-badge")).toHaveText("prepared_unsent");
  browserDiagnostics.markPendingReads();
  await dialog.getByRole("button", { name: "Close Daemon connections", exact: true }).click();
  await openOffline();
  await expect(review.locator(".wg-badge")).toHaveText("prepared_unsent");
  await expect(
    admin.getByLabel("Fresh destination on companion host", { exact: true }),
  ).toHaveValue(destination);
  await review.getByRole("button", { name: "Cancel unsent helper", exact: true }).click();
  await expect(review.locator(".wg-badge")).toHaveText("canceled_unsent");
  await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  await admin.getByRole("button", { name: "Journals and recovery", exact: true }).click();
  await admin.getByRole("button", { name: "List companion saved operations", exact: true }).click();
  await expect(
    admin.getByRole("heading", { name: "Companion-owned saved operations", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 600, height: 850 });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  browserDiagnostics.markPendingReads();
  await dialog.getByRole("button", { name: "Close Daemon connections", exact: true }).click();
});
