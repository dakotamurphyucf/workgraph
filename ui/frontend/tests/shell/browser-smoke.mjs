/** Synthetic transport fixture only. This never runs in or supplies fallback data to the production app. */
import process from "node:process";
import console from "node:console";
import { setTimeout } from "node:timers";
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const base = process.env.WORKGRAPH_UI_TEST_URL;
const evidence = process.env.WORKGRAPH_SHELL_EVIDENCE_DIR;
if (!base || !evidence)
  throw new Error("Set WORKGRAPH_UI_TEST_URL and WORKGRAPH_SHELL_EVIDENCE_DIR explicitly.");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.WORKGRAPH_CHROME ? { executablePath: process.env.WORKGRAPH_CHROME } : {}),
});
const page = await browser.newPage({ viewport: { width: 1512, height: 982 } });
const errors = [];
page.on("pageerror", (error) => {
  errors.push(error.message);
});
const checks = [];
const profiles = [
  {
    id: "local",
    generation: "9007199254740993",
    label: "Local development",
    socket: "/synthetic/local-daemon.sock",
  },
  {
    id: "second",
    generation: "2",
    label: "Isolated validation",
    socket: "/synthetic/validation-daemon.sock",
  },
];
let scenario = "profiles";
let responseDelay = 0;
let featureFixture = false;
const requests = [];
await page.route(`${base}/`, async (route) => {
  const response = await route.fetch();
  await route.fulfill({
    response,
    body: (await response.text())
      .replace("__WORKGRAPH_UI_CAPABILITY__", "a".repeat(64))
      .replace("/src/main.tsx", featureFixture ? "/tests/shell/fixture.tsx" : "/src/main.tsx"),
  });
});
await page.route("**/ui-api/v1/connections", async (route) => {
  requests.push({
    method: route.request().method(),
    capability: route.request().headers()["x-workgraph-ui-capability"],
  });
  if (scenario === "offline") {
    await route.abort("connectionrefused");
    return;
  }
  const items =
    scenario === "empty"
      ? []
      : scenario === "without-local"
        ? profiles.filter((profile) => profile.id !== "local")
        : profiles;
  if (responseDelay) await new Promise((resolve) => setTimeout(resolve, responseDelay));
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, data: { items } }),
  });
});
async function shot(name) {
  await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true });
}
async function widthCheck() {
  expect(
    await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
    ),
  ).toBe(true);
}
try {
  await page.goto(base);
  await expect(page.getByRole("heading", { name: "Overview is not available yet" })).toBeVisible();
  await expect(page.getByText("9007199254740993", { exact: true })).toBeVisible();
  await expect(page.getByText("Saved profile · daemon status unchecked")).toBeVisible();
  expect(
    requests.every((request) => request.method === "GET" && request.capability === "a".repeat(64)),
  ).toBe(true);
  checks.push(
    "capability-bound real client + exact large generation; no synthetic production fallback",
  );
  await page.getByRole("button", { name: "Appearance settings" }).click();
  await page.getByLabel("Theme", { exact: true }).selectOption("dark");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await shot("shell-dark");
  const commandTrigger = page.getByRole("button", { name: /Find or jump to/ });
  await commandTrigger.click();
  await expect(
    page.getByRole("searchbox").or(page.getByRole("textbox", { name: "Find a view or command" })),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(commandTrigger).toBeFocused();
  await page.keyboard.press("Control+k");
  await page.getByRole("textbox", { name: "Find a view or command" }).fill("history");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "History is not available yet" })).toBeVisible();
  await expect(page.getByRole("main")).toBeFocused();
  checks.push("command keyboard, Escape focus return, route focus + full generic History label");
  await page.getByRole("button", { name: /No acting actor/ }).click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill("mira");
  await page.getByLabel("Run ID (optional)").fill("rowan-run");
  await page.getByRole("button", { name: "Use selection" }).click();
  await expect(page.getByText("Acting as mira", { exact: true })).toBeVisible();
  await expect(page.getByText("Run · rowan-run", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: /All workspaces/ })
    .first()
    .click();
  await page.getByLabel("Workspace ID", { exact: true }).fill("northstar");
  await page.getByLabel("Project ID (optional)").fill("release");
  await page.getByRole("button", { name: "Open scope" }).click();
  expect(page.url()).toContain("workspace=northstar&project=release");
  await page.getByRole("button", { name: /Workgraph Local development/ }).click();
  await page.getByRole("button", { name: /Isolated validation/ }).click();
  expect(page.url()).toContain("connection=second");
  expect(page.url()).not.toContain("workspace=");
  await expect(page.getByText("Acting as mira", { exact: true })).toBeVisible();
  checks.push(
    "independent arbitrary actor/run, scoped navigation, connection change clears endpoint scope but retains writer",
  );
  const separator = page.getByRole("separator", { name: "Resize navigation" });
  await separator.focus();
  await page.keyboard.press("End");
  await expect(separator).toHaveAttribute("aria-valuenow", "320");
  await page.keyboard.press("Home");
  await expect(separator).toHaveAttribute("aria-valuenow", "208");
  checks.push("keyboard resizer minimum/maximum bounds");
  await page.getByRole("button", { name: "Appearance settings" }).click();
  await page.getByLabel("Theme", { exact: true }).selectOption("light");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await shot("shell-light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  checks.push("light/dark theme and device preference persistence");
  await page.goto(`${base}/#/work?connection=missing`);
  await expect(page.getByRole("heading", { name: "Saved connection not found" })).toBeVisible();
  expect(page.url()).toContain("connection=missing");
  checks.push("unknown deep-linked connection never silently redirects to another daemon");
  await page.goto(`${base}/#/work?workspace=northstar`);
  await expect(page.getByRole("heading", { name: "This link could not be opened" })).toBeVisible();
  await expect(
    page.getByText("A scoped link must name its daemon connection.", { exact: true }),
  ).toBeVisible();
  checks.push(
    "scoped deep link without connection is rejected rather than applied to an arbitrary daemon",
  );
  scenario = "empty";
  await page.goto(base);
  await expect(page.getByRole("heading", { name: "Connect your first daemon" })).toBeVisible();
  await shot("shell-empty");
  scenario = "offline";
  await page.getByRole("button", { name: "Refresh connection" }).click();
  await expect(page.getByRole("heading", { name: "Companion is unavailable" })).toBeVisible();
  await shot("shell-offline");
  scenario = "profiles";
  responseDelay = 500;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Connecting to your companion" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Overview is not available yet" })).toBeVisible();
  responseDelay = 0;
  checks.push("distinct actual empty/offline/loading + explicit recovery states");
  await page.setViewportSize({ width: 390, height: 844 });
  await widthCheck();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("dialog", { name: "Workspace navigation" })).toBeVisible();
  expect(await page.locator(".wg-main").evaluate((element) => element.inert)).toBe(true);
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: /No acting actor/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeFocused();
  await shot("shell-mobile");
  checks.push("390px wrapping; narrow drawer inert background, focus containment, Escape return");
  await page.setViewportSize({ width: 1512, height: 982 });
  const longId = "a".repeat(96);
  await page.goto(`${base}/#/resources?connection=local&workspace=${longId}&project=${longId}`);
  await widthCheck();
  await shot("shell-long-identifiers");
  checks.push("full long scope identifiers wrap without viewport overflow");
  featureFixture = true;
  await page.goto(base);
  await page
    .getByLabel("Captured draft", { exact: true })
    .fill("Draft remains captured while refreshing");
  profiles.reverse();
  await page.getByRole("button", { name: "Refresh connection" }).click();
  await expect(page.getByText("Directory freshness: current", { exact: true })).toBeVisible();
  await expect(page.getByText("Connection: local", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Captured draft", { exact: true })).toHaveValue(
    "Draft remains captured while refreshing",
  );
  expect(page.url()).not.toContain("connection=");
  checks.push(
    "implicit initial connection pinned through directory reorder; mounted draft is unchanged",
  );
  profiles.reverse();
  responseDelay = 300;
  await page.getByRole("button", { name: "Refresh connection" }).click();
  await expect(page.getByText("Directory freshness: refreshing", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Captured draft", { exact: true })).toHaveValue(
    "Draft remains captured while refreshing",
  );
  await expect(page.getByText("Directory freshness: current", { exact: true })).toBeVisible();
  responseDelay = 0;
  scenario = "offline";
  await page.getByRole("button", { name: "Refresh connection" }).click();
  await expect(
    page.getByRole("heading", { name: "Connection profile refresh failed" }),
  ).toBeVisible();
  await expect(page.getByText("Directory freshness: unavailable", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Captured draft", { exact: true })).toHaveValue(
    "Draft remains captured while refreshing",
  );
  await shot("shell-retained-draft");
  scenario = "profiles";
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Directory freshness: current", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open inspector", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Full ticket title is retained in the reusable inspector" }),
  ).toBeVisible();
  await page.getByRole("separator", { name: "Resize inspector" }).focus();
  await page.keyboard.press("End");
  await expect(page.getByRole("separator", { name: "Resize inspector" })).toHaveAttribute(
    "aria-valuenow",
    "720",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open inspector", exact: true })).toBeFocused();
  checks.push(
    "explicit feature test composition preserves mounted draft through refresh/offline/recovery; reusable content controls and inspector resize",
  );
  const localIndex = profiles.findIndex((profile) => profile.id === "local");
  profiles[localIndex] = { ...profiles[localIndex], generation: "9007199254740994" };
  await page.getByRole("button", { name: "Refresh connection" }).click();
  await expect(page.getByText("Directory freshness: current", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Captured draft", { exact: true })).toHaveValue("");
  checks.push(
    "changed endpoint generation remounts scoped feature, never reuses stale endpoint state",
  );
  scenario = "without-local";
  await page.getByRole("button", { name: "Refresh connection" }).click();
  await expect(page.getByRole("heading", { name: "Saved connection not found" })).toBeVisible();
  await expect(page.getByText("local", { exact: true })).toBeVisible();
  checks.push("removed pinned profile reports missing without switching to a surviving daemon");
  expect(errors).toEqual([]);
  await writeFile(
    path.join(evidence, "result.json"),
    JSON.stringify(
      {
        kind: "production-shell-browser-smoke",
        transport: "explicit synthetic interception, no real daemon claim",
        browser: await browser.version(),
        checks,
        errors,
        requests: requests.length,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ checks: checks.length, errors, evidence }));
} finally {
  await browser.close();
}
