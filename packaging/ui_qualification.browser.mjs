#!/usr/bin/env node
/** External installed-package browser check; Node is never a native runtime dependency. */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

const [modulePath, executable, url, phase, output] = process.argv.slice(2);
if (![modulePath, executable, url, phase, output].every((x) => typeof x === "string" && x !== "") ||
    !["create", "restart", "reinstall"].includes(phase)) throw new Error("Expected exact installed browser arguments");
const { chromium, expect } = await import(pathToFileURL(modulePath).href);
await mkdir(output, { recursive: false });
const server = await chromium.launchServer({ executablePath: executable, headless: true });
let browser;
let result;
const failures = [], requests = [], active = new Set(), closingReads = new Set();
const owned = server.process();
const shutdown = () => {
  process.exitCode = 143;
  void server.close().catch(error => { failures.push(`shutdown: ${String(error)}`); });
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
try {
  browser = await chromium.connect(server.wsEndpoint());
  const context = await browser.newContext({ colorScheme: "dark", viewport: { width: 1480, height: 1000 } });
  const page = await context.newPage();
  const origin = new URL(url).origin;
  page.on("pageerror", error => failures.push(`pageerror: ${error.message}`));
  page.on("console", message => { if (message.type() === "error") failures.push(`console.error: ${message.text()}`); });
  page.on("request", request => {
    active.add(request);
    if (new URL(request.url()).origin !== origin) failures.push(`external request: ${request.url()}`);
    const body = request.postData();
    requests.push({ method: request.method(), url: request.url(),
      postDataSha256: body === null ? null : createHash("sha256").update(body).digest("hex") });
  });
  page.on("requestfinished", request => active.delete(request));
  page.on("requestfailed", request => {
    active.delete(request);
    if (!(closingReads.delete(request) && request.failure()?.errorText === "net::ERR_ABORTED"))
      failures.push(`requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText}`);
  });
  try {
    const route = phase === "create" ? "&project=release" : "&entity=installed-browser-ticket&planning_kind=ticket&planning_generation=1";
    await page.goto(new URL(`/#/work?connection=installed&workspace=demo${route}`, url).href);
    await page.waitForLoadState("networkidle");
    if (phase === "create") {
      await page.locator(".wg-actor-trigger").click();
      await page.getByLabel("Acting actor ID", { exact: true }).fill("installed-author");
      await page.getByLabel("Run ID (optional)", { exact: true }).fill("");
      await page.getByRole("button", { name: "Use selection", exact: true }).click();
      await page.getByRole("button", { name: "New ticket", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Create ticket", exact: true });
      const field = async (label, value) => {
        const control = dialog.getByLabel(label, { exact: true });
        await expect(control).toBeAttached();
        while (!(await control.isVisible())) {
          const details = control.locator("xpath=ancestor::details[not(@open)]").first();
          if ((await details.count()) === 0) throw new Error(`Hidden field: ${label}`);
          await details.locator(":scope > summary").click();
        }
        await control.fill(value);
      };
      await field("Title", "Installed browser publication");
      await field("Description", "Installed exact Unicode 雪\nTrailing LF preserved.\n");
      await field("Ticket ID (optional)", "installed-browser-ticket");
      await field("Project", "release");
      await dialog.getByRole("button", { name: "Review action", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "Apply action", exact: true })).toBeEnabled();
      await dialog.getByRole("button", { name: "Apply action", exact: true }).click();
      const created = dialog.getByRole("link", { name: "Open created ticket", exact: true });
      await expect(created).toBeVisible();
      await created.click();
    }
    await expect(page.getByRole("article", { name: "Recorded ticket target", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Installed browser publication", exact: true })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: path.join(output, `${phase}-installed.png`) });
    result = { browserVersion: browser.version(), phase, observedTicketId: "installed-browser-ticket", failures, requests };
  } finally {
    const beforeClose = [...active].map(request => ({ method: request.method(), url: request.url() }));
    for (const request of active) {
      const target = new URL(request.url());
      if (target.origin === origin && ((request.method() === "POST" && target.pathname === "/ui-api/v1/read") ||
          (request.method() === "GET" && target.pathname === "/ui-api/v1/connections"))) closingReads.add(request);
    }
    await page.close();
    await context.close();
    await writeFile(path.join(output, "diagnostics.json"), JSON.stringify({ failures, requests, beforeClose }, null, 2));
  }
} finally {
  try { if (browser) await browser.close(); } finally { await server.close(); }
  process.removeListener("SIGTERM", shutdown);
  process.removeListener("SIGINT", shutdown);
  await writeFile(path.join(output, "owned-browser.json"), JSON.stringify({ pid: owned.pid, exitCode: owned.exitCode, signalCode: owned.signalCode }, null, 2));
}
if (!result || failures.length !== 0) throw new Error(`Installed graphical proof failed: ${JSON.stringify(failures)}`);
console.log(JSON.stringify(result));
