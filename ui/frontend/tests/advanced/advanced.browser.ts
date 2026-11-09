import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, expect } from "../e2e/support/fixtures";
import type { Catalog } from "../../src/features/advanced";
import type { Page, TestInfo } from "@playwright/test";
import type { CompanionFixture } from "../../../test-support/companion-fixture.mjs";
async function capture(page: Page, info: TestInfo, name: string) {
  const file = info.outputPath(name);
  // Element focus may scroll the outer document in addition to the shell's content pane.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: file, fullPage: true });
  await info.attach(name, { path: file, contentType: "image/png" });
}
async function mount(page: Page, companion: CompanionFixture, socket: string) {
  // Read the actual launch capability before navigating; API metadata setup is
  // isolated test data. All page assets and UI flows are the embedded application.
  const bootstrap = await page.request.get(companion.url);
  if (!bootstrap.ok()) throw new Error(`Native bootstrap ${bootstrap.status()}`);
  const capability = /<meta\s+name="workgraph-capability"\s+content="([a-f0-9]{64})"\s*\/?>/u.exec(
    await bootstrap.text(),
  )?.[1];
  if (!capability) throw new Error("Missing exact native bootstrap capability");
  for (const [endpoint, body] of [
    ["/connections", { id: "local", label: "Synthetic qualification daemon", socket }],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const response = await page.request.post(new URL(`/ui-api/v1${endpoint}`, companion.url).href, {
      headers: { "X-Workgraph-UI-Capability": capability, Origin: new URL(companion.url).origin },
      data: body,
    });
    if (!response.ok()) throw new Error(`Native fixture setup ${response.status()}`);
  }
  await page.goto(
    new URL("/#/advanced?connection=local&workspace=demo&project=release", companion.url).href,
  );
  await expect(
    page.locator("#root").getByRole("heading", { name: "Advanced", exact: true }),
  ).toBeVisible();
}
async function select(page: Page, name: string) {
  const root = page.locator("#root");
  await root.getByRole("button", { name: "Methods", exact: true }).click();
  await root.getByLabel("Search catalogue").fill(name);
  await root
    .locator(".adv-item")
    .filter({
      has: page.locator("code", { hasText: new RegExp(`^${name.replaceAll(".", "\\.")}$`, "u") }),
    })
    .click();
  await expect(
    root.getByRole("button", { name: `New draft for ${name}`, exact: true }),
  ).toBeVisible();
  await root.getByRole("button", { name: `New draft for ${name}`, exact: true }).click();
  return root;
}
test("real catalogue, exact read, staged draft remount, explicit prepare/execute and retained journal", async ({
  page,
  daemon,
  companion,
  browserFailures,
  browserDiagnostics,
}, info) => {
  await mount(page, companion, daemon.socket);
  await page.getByRole("button", { name: "Appearance settings", exact: true }).click();
  await page.getByLabel("Theme", { exact: true }).selectOption("dark");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const root = page.locator("#root");
  await expect(
    root.getByText("269 methods · 44 helper / host surfaces", { exact: true }),
  ).toBeVisible();
  const runtime = await promisify(execFile)(
    daemon.binary,
    ["discover", "--catalog", "--output", "json"],
    { maxBuffer: 2 * 1024 * 1024 },
  );
  // Only bounded executable metadata is decoded here; arbitrary daemon payloads use the production lossless client.
  const names = JSON.parse(runtime.stdout) as {
    entries: {
      kind: string;
      name: string;
      effect: string | null;
      tier: string | null;
      summary: string;
    }[];
    capabilities: unknown[];
  };
  const catalogue = await page.evaluate(async () => {
    const capability = document
      .querySelector('meta[name="workgraph-capability"]')
      ?.getAttribute("content");
    if (!capability) throw new Error("Missing capability");
    const r = await fetch("/ui-api/v1/catalog", {
      headers: { "X-Workgraph-UI-Capability": capability },
    });
    return (await r.json()) as { data: Catalog };
  });
  const byName = <T extends { readonly name: string }>(items: readonly T[]) =>
    [...items].sort((a, b) => a.name.localeCompare(b.name));
  expect(byName(catalogue.data.methods)).toEqual(
    byName(
      names.entries
        .filter((e) => e.kind === "method")
        .map((e) => ({ name: e.name, mode: e.effect, tier: e.tier, summary: e.summary })),
    ),
  );
  expect(byName([...catalogue.data.helpers, ...catalogue.data.workflows])).toEqual(
    byName(names.entries.filter((e) => e.kind !== "method")),
  );
  expect(catalogue.data.capabilities).toEqual(names.capabilities);
  await select(page, "fact.get");
  await root.getByRole("button", { name: "Raw JSON", exact: true }).click();
  await root
    .getByLabel("Exact parameter source")
    .fill(
      '{"workspace_id":"demo","scope":{"kind":"project","id":"release"},"key":"fixture.settings"}',
    );
  await root.getByRole("button", { name: "Run read", exact: true }).click();
  await expect(root.getByText("9007199254740993", { exact: true })).toBeVisible();
  await expect(root.locator(".wg-content-status")).toHaveCount(0);
  await root.getByText("9007199254740993", { exact: true }).scrollIntoViewIfNeeded();
  await capture(page, info, "advanced-dark-read.png");
  await root.getByRole("button", { name: "No acting actor No run selected" }).click();
  await root.getByLabel("Acting actor ID").fill("human");
  browserDiagnostics.markPendingReads();
  await root.getByRole("button", { name: "Use selection", exact: true }).click();
  await select(page, "ticket.create");
  await root.getByRole("button", { name: "Form", exact: true }).click();
  await root.getByLabel("title presence", { exact: true }).selectOption("value");
  await root
    .getByLabel("title value", { exact: true })
    .fill("Unapplied title retained through navigation");
  const historyLoaded = page.waitForResponse((response) => {
    if (!response.url().endsWith("/ui-api/v1/read")) return false;
    const body: unknown = response.request().postDataJSON();
    return (
      typeof body === "object" &&
      body !== null &&
      "method" in body &&
      body.method === "session.list"
    );
  });
  browserDiagnostics.markPendingReads();
  await root.getByRole("link", { name: "History", exact: false }).first().click();
  await historyLoaded;
  await expect(root.getByRole("heading", { name: "History", exact: true })).toBeVisible();
  browserDiagnostics.markPendingReads();
  await root.getByRole("link", { name: "Advanced", exact: false }).first().click();
  await expect(root.getByLabel("title value", { exact: true })).toHaveValue(
    "Unapplied title retained through navigation",
  );
  await expect(
    root.getByRole("button", { name: "Validate & prepare", exact: true }),
  ).toBeDisabled();
  await root.getByRole("button", { name: "Discard staged field edits", exact: true }).click();
  await root.getByRole("button", { name: "Raw JSON", exact: true }).click();
  await root
    .getByLabel("Exact parameter source")
    .fill(
      '{"workspace_id":"demo","actor_id":"human","project_id":"release","ticket_id":"advanced-created","title":"Created through Advanced production controls"}',
    );
  await root.getByRole("button", { name: "Validate & prepare", exact: true }).click();
  await expect(root.locator(".wg-badge").filter({ hasText: /^prepared_unsent$/u })).toBeVisible();
  await expect(
    daemon.call("ticket.get", '{"workspace_id":"demo","ticket_id":"advanced-created"}'),
  ).rejects.toThrow("Not_found");
  await root.getByRole("button", { name: "human No run selected" }).click();
  await root.getByLabel("Acting actor ID").fill("other-actor");
  browserDiagnostics.markPendingReads();
  await root.getByRole("button", { name: "Use selection", exact: true }).click();
  await root.getByRole("button", { name: "Execute saved request", exact: true }).click();
  await expect
    .poll(
      async () => {
        await root.getByRole("button", { name: "Inspect", exact: true }).click();
        return root
          .locator(".wg-badge")
          .filter({ hasText: /^committed$/u })
          .count();
      },
      { timeout: 15000 },
    )
    .toBe(1);
  await expect(root.getByText("committed", { exact: true }).last()).toBeVisible();
  const observed = await daemon.call(
    "ticket.get",
    '{"workspace_id":"demo","ticket_id":"advanced-created"}',
  );
  expect(observed).toContain("Created through Advanced production controls");
  const captured = root
    .locator(".wg-panel")
    .filter({ has: page.getByRole("heading", { name: "Captured operation", exact: true }) });
  await expect(captured).toContainText(/writer\s+human/u);
  await root
    .getByRole("button", { name: "Close editor; keep saved intention", exact: true })
    .click();
  await expect(
    root.getByRole("heading", { name: "Captured operation", exact: true }),
  ).toBeVisible();
  await root.getByRole("button", { name: "Inspect", exact: true }).click();
  await expect(root.getByRole("button", { name: "Inspect", exact: true })).toBeEnabled();
  await capture(page, info, "advanced-dark-operation.png");
  await info.attach("visible-operation-observation", {
    contentType: "text/plain",
    body: await captured.innerText(),
  });
  expect(browserFailures).toEqual([]);
});
test("host/helper guidance stays passive; empty search and light/mobile layout remain usable", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  await mount(page, companion, daemon.socket);
  const root = page.locator("#root");
  await root.getByRole("button", { name: "Helpers", exact: true }).click();
  await root.getByLabel("Search catalogue").fill("resource.upload");
  await root
    .locator(".adv-item")
    .filter({ has: page.locator("code", { hasText: /^resource\.upload$/u }) })
    .click();
  await expect(root.getByText("workgraph help resource.upload", { exact: true })).toBeVisible();
  await root.getByRole("button", { name: "Host tools", exact: true }).click();
  await root.getByLabel("Search catalogue").fill("wgx");
  await root
    .locator(".adv-item")
    .filter({ has: page.locator("code", { hasText: /^wgx$/u }) })
    .click();
  await expect(
    root.getByText("bash /ABSOLUTE/SKILL/scripts/wgx.sh --help", { exact: true }),
  ).toBeVisible();
  expect(await root.locator(".adv-command a").count()).toBe(0);
  await page.getByRole("button", { name: "Appearance settings", exact: true }).click();
  await page.getByLabel("Theme", { exact: true }).selectOption("light");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await capture(page, info, "advanced-light-host.png");
  await root.getByRole("button", { name: "Methods", exact: true }).click();
  await root.getByLabel("Search catalogue").fill("no-such-method-qualification");
  await expect(root.getByText("No matching methods. Try another family or phrase.")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(root.getByLabel("Search catalogue")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await capture(page, info, "advanced-mobile.png");
  expect(browserFailures).toEqual([]);
});

test("invalid raw/staged parameters and missing captured writer remain editable without submitting", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  await mount(page, companion, daemon.socket);
  const root = page.locator("#root");
  let prepareRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/ui-api/v1/operations/prepare") prepareRequests++;
  });
  await select(page, "ticket.create");
  await root.getByRole("button", { name: "Raw JSON", exact: true }).click();
  await root.getByLabel("Exact parameter source").fill("{");
  await expect(
    root.getByRole("button", { name: "Validate & prepare", exact: true }),
  ).toBeDisabled();
  await expect(root.getByRole("alert")).toContainText(/JSON|property|end|offset/iu);
  await expect(
    root.getByRole("button", { name: "Retry parameter validation", exact: true }),
  ).toBeVisible();
  expect(prepareRequests).toBe(0);
  await root
    .getByLabel("Exact parameter source")
    .fill(
      '{"workspace_id":"demo","actor_id":"human","project_id":"release","ticket_id":"never-submitted","title":"No captured writer"}',
    );
  await root.getByRole("button", { name: "Validate & prepare", exact: true }).click();
  await expect(root.locator(".adv-notice")).toContainText("valid captured writer");
  expect(prepareRequests).toBe(0);
  await select(page, "ticket.ready");
  await root.getByRole("button", { name: "Form", exact: true }).click();
  await root.getByText("Optional and conditional inputs", { exact: true }).click();
  await root.getByLabel("leaf_only presence", { exact: true }).selectOption("value");
  await root.getByLabel("leaf_only JSON value", { exact: true }).fill("tru");
  await root.getByRole("button", { name: "Apply leaf_only", exact: true }).click();
  await expect(
    root
      .locator(".adv-field")
      .filter({ has: page.getByLabel("leaf_only JSON value", { exact: true }) })
      .getByRole("alert"),
  ).toBeVisible();
  await expect(root.getByRole("button", { name: "Run read", exact: true })).toBeDisabled();
  await root.getByRole("button", { name: "Raw JSON", exact: true }).click();
  await expect(root.getByLabel("Exact parameter source")).toBeDisabled();
  await root.getByRole("button", { name: "Form", exact: true }).click();
  await root.getByText("Optional and conditional inputs", { exact: true }).click();
  await root.getByLabel("leaf_only JSON value", { exact: true }).fill("true");
  await root.getByRole("button", { name: "Apply leaf_only", exact: true }).click();
  await expect(root.getByRole("button", { name: "Run read", exact: true })).toBeEnabled();
  await root.getByLabel("leaf_only JSON value", { exact: true }).scrollIntoViewIfNeeded();
  await capture(page, info, "advanced-form-validation.png");
  expect(prepareRequests).toBe(0);
  expect(browserFailures).toEqual([]);
});
test("local envelope rejection stays repairable and unsaved discard never implies a saved intention", async ({
  page,
  daemon,
  companion,
  browserFailures,
}) => {
  await mount(page, companion, daemon.socket);
  const root = page.locator("#root");
  await root.getByRole("button", { name: "No acting actor No run selected" }).click();
  await root.getByLabel("Acting actor ID").fill("human");
  await root.getByRole("button", { name: "Use selection", exact: true }).click();
  let prepares = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/ui-api/v1/operations/prepare") prepares++;
  });
  const oversizedEnvelope = '{"body":"' + "x".repeat(4 * 1024 * 1024 - 24) + '"}';
  async function rejectLocally() {
    await select(page, "ticket.create");
    await root.getByRole("button", { name: "Raw JSON", exact: true }).click();
    await root.getByLabel("Exact parameter source").fill(oversizedEnvelope);
    await root.getByRole("button", { name: "Validate & prepare", exact: true }).click();
    await expect(root.locator(".adv-notice")).toContainText(/byte|budget|exceed/iu);
    await expect(root.getByLabel("Exact parameter source")).toBeEnabled();
    await expect(root.getByLabel("Exact parameter source")).toHaveValue(oversizedEnvelope);
    await expect(
      root.getByRole("button", { name: "Discard unsent draft", exact: true }),
    ).toBeVisible();
    await expect(
      root.getByRole("button", { name: "Close editor; keep saved intention", exact: true }),
    ).toHaveCount(0);
  }
  await rejectLocally();
  expect(prepares).toBe(0);
  await root
    .getByLabel("Exact parameter source")
    .fill(
      '{"workspace_id":"demo","actor_id":"human","project_id":"release","ticket_id":"repaired-unsent","title":"Repaired local draft"}',
    );
  await root.getByRole("button", { name: "Validate & prepare", exact: true }).click();
  await expect(root.locator(".wg-badge").filter({ hasText: /^prepared_unsent$/u })).toBeVisible();
  expect(prepares).toBe(1);
  await root
    .getByRole("button", { name: "Close editor; keep saved intention", exact: true })
    .click();
  await rejectLocally();
  expect(prepares).toBe(1);
  await root.getByRole("button", { name: "Discard unsent draft", exact: true }).click();
  await expect(
    root.getByRole("region", { name: "Recovery and host tools", exact: true }),
  ).toBeVisible();
  await expect(root.getByRole("navigation", { name: "Advanced drafts" })).toHaveCount(0);
  await root.getByRole("button", { name: "Saved (1)", exact: true }).click();
  await expect(
    root.getByRole("region", { name: "Saved intentions" }).getByRole("button"),
  ).toHaveCount(1);
  await expect(root.getByRole("region", { name: "Saved intentions" })).toContainText(
    "prepared_unsent",
  );
  await expect(
    daemon.call("ticket.get", '{"workspace_id":"demo","ticket_id":"repaired-unsent"}'),
  ).rejects.toThrow("Not_found");
  expect(browserFailures).toEqual([]);
});

test("Advanced explorer matches landing flow and preserves exact read drafts across discovery and navigation", async ({
  page,
  daemon,
  companion,
  browserFailures,
  browserDiagnostics,
}) => {
  await mount(page, companion, daemon.socket);
  await expect(page.getByRole("heading", { name: "Advanced", exact: true })).toHaveCount(1);
  await expect(
    page.getByRole("region", { name: "Recovery and host tools", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^CLI helpers & recipes/u }).click();
  await expect(page.getByRole("button", { name: "Helpers", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: /^Saved intentions Inspect/u }).click();
  await expect(page.getByRole("region", { name: "Saved intentions", exact: true })).toBeVisible();
  const root = await select(page, "fact.get");
  await root.getByRole("button", { name: "Raw JSON", exact: true }).click();
  const params =
    '{"workspace_id":"demo","scope":{"kind":"project","id":"release"},"key":"fixture.settings"}';
  await root.getByLabel("Exact parameter source").fill(params);
  await root.getByRole("button", { name: "Run read", exact: true }).click();
  await root
    .getByRole("region", { name: "Content: Read response (decoded JSON)", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(root.getByText("9007199254740993", { exact: true })).toBeVisible();
  await root.getByRole("button", { name: "Explorer", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Recovery and host tools", exact: true }),
  ).toBeVisible();
  const resourcesLoaded = page.waitForResponse((response) => {
    if (!response.url().endsWith("/ui-api/v1/read")) return false;
    const body: unknown = response.request().postDataJSON();
    return (
      typeof body === "object" &&
      body !== null &&
      "method" in body &&
      body.method === "resource.list"
    );
  });
  browserDiagnostics.markPendingReads();
  await root.getByRole("button", { name: /^Resource transfers Browse/u }).click();
  await resourcesLoaded;
  await expect(page.getByRole("heading", { name: "Resources", exact: true })).toBeVisible();
  browserDiagnostics.markPendingReads();
  await page.goBack();
  await root.getByRole("button", { name: "Raw JSON", exact: true }).click();
  await expect(root.getByLabel("Exact parameter source")).toHaveValue(params);
  await page.setViewportSize({ width: 760, height: 850 });
  await root.getByRole("button", { name: "Explorer", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Recovery and host tools", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(browserFailures).toEqual([]);
});

test("Advanced guidance, operation filter and captured ticket choices help build a read", async ({
  page,
  daemon,
  companion,
  browserFailures,
}) => {
  await mount(page, companion, daemon.socket);
  await page.getByRole("button", { name: "How Advanced works", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Opening one does not send a request");
  await page.getByRole("button", { name: "Close How Advanced works", exact: true }).click();
  await page.getByLabel("Operation type", { exact: true }).selectOption("read");
  await expect(page.locator(".adv-mode-badge[data-effect='write']")).toHaveCount(0);
  const root = await select(page, "ticket.context");
  await root
    .getByRole("button", { name: "Fill scope fields from captured context", exact: true })
    .click();
  await expect(root.getByLabel("workspace_id value", { exact: true })).toHaveValue("demo");
  await root.getByLabel("ticket_id presence", { exact: true }).selectOption("value");
  await root.getByRole("button", { name: "ticket_id value", exact: true }).click();
  await root.getByRole("textbox", { name: "Search tickets", exact: true }).fill("design");
  await root.locator("[data-reference-option]").filter({ hasText: "design" }).first().click();
  await expect(root.getByRole("button", { name: "ticket_id value", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(root.getByRole("button", { name: "Run read", exact: true })).toBeDisabled();
  await root.getByRole("button", { name: "Apply ticket_id", exact: true }).click();
  await root.getByRole("button", { name: "Run read", exact: true }).click();
  await root
    .getByRole("region", { name: "Content: Read response (decoded JSON)", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    root.getByRole("region", { name: "Content: Read response (decoded JSON)", exact: true }),
  ).toContainText("design");
  await root.getByRole("button", { name: "Explorer", exact: true }).click();
  await expect(root.getByRole("navigation", { name: "Advanced drafts" })).toContainText(
    "ticket.context",
  );
  await root.getByRole("button", { name: "Helpers", exact: true }).click();
  await root.getByLabel("Search catalogue").fill("no-matching-guide");
  await expect(
    root.getByText("No matching guides. Try a task such as upload or planning."),
  ).toBeVisible();
  await root.getByRole("button", { name: "Saved (0)", exact: true }).click();
  await expect(root.getByRole("region", { name: "Saved intentions" })).toContainText(
    "No saved requests yet",
  );
  expect(browserFailures).toEqual([]);
});
