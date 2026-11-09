import { waitForPageReads } from "../../e2e/support/readiness";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect } from "../../e2e/support/fixtures";
import type { DaemonFixture } from "../../../../test-support/daemon-fixture.mjs";
import type { CompanionFixture } from "../../../../test-support/companion-fixture.mjs";
test.use({ viewport: { width: 1480, height: 1050 }, colorScheme: "dark", actionTimeout: 12000 });
const project = { kind: "project", id: "release" };
function writer(daemon: DaemonFixture) {
  let serial = 0;
  return {
    put: (
      key: string,
      value: string,
      revision = "0",
      scope: object = project,
      references?: readonly object[],
    ) => {
      const base = JSON.stringify({
        workspace_id: "demo",
        actor_id: "fixture-author",
        mutation_id: `facts-${++serial}`,
        scope,
        key,
        expected_revision: revision,
        ...(references === undefined ? {} : { references }),
      });
      return daemon.call("fact.put", base.slice(0, -1) + ',"value":' + value + "}");
    },
  };
}
const inspect = async (daemon: DaemonFixture, key: string, scope: object = project) =>
  daemon.call(
    "fact.get",
    JSON.stringify({ workspace_id: "demo", scope, key, max_bytes: "1048576" }),
  );
async function configure(page: Page, companion: CompanionFixture, daemon: DaemonFixture) {
  const body = await page.request.get(companion.url),
    cap = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(await body.text())?.[1];
  if (cap === undefined) throw new Error("Native bootstrap missing");
  const headers = { Origin: new URL(companion.url).origin, "X-Workgraph-UI-Capability": cap };
  for (const [path, data] of [
    ["/connections", { id: "local", label: "Facts qualification", socket: daemon.socket }],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const r = await page.request.post(new URL(`/ui-api/v1${path}`, companion.url).href, {
      headers,
      data,
    });
    expect(r.status()).toBe(200);
    await r.text();
  }
}
async function actor(page: Page, id = "fixture-author") {
  await waitForPageReads(page);
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill(id);
  await page.getByLabel("Run ID (optional)", { exact: true }).fill("");
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  await waitForPageReads(page);
}
async function mount(page: Page, companion: CompanionFixture, daemon: DaemonFixture) {
  await configure(page, companion, daemon);
  await page.goto(
    new URL("/#/facts?connection=local&workspace=demo&project=release", companion.url).href,
  );
  await expect(page.getByRole("heading", { name: "Facts", exact: true })).toBeVisible();
  await waitForPageReads(page);
  await actor(page);
}
function panel(page: Page, title: string) {
  return page
    .locator(".wg-panel")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
}
async function exact(page: Page, key: string) {
  await page.getByLabel("New or existing fact key", { exact: true }).fill(key);
  await page.getByRole("button", { name: "Inspect exact key", exact: true }).click();
  const detail = panel(page, `Fact ${key}`);
  await expect(detail).toBeVisible();
  return detail;
}
async function open(page: Page, key: string) {
  await page.getByLabel("New or existing fact key", { exact: true }).fill(key);
  await page.getByRole("button", { name: "Edit or create fact", exact: true }).click();
  const draft = panel(page, `Edit ${key}`);
  await expect(draft).toBeVisible();
  return draft;
}
async function source(draft: Locator, value: string) {
  await draft.getByRole("button", { name: "Raw JSON source", exact: true }).click();
  await draft.getByLabel("Fact JSON source", { exact: true }).fill(value);
  await expect(
    draft.getByRole("button", { name: "Review replacement", exact: true }),
  ).toBeEnabled();
}
async function review(draft: Locator, deleted = false) {
  await draft
    .getByRole("button", { name: deleted ? "Review deletion" : "Review replacement", exact: true })
    .click();
  await expect(
    draft.getByRole("button", { name: "Execute saved request", exact: true }),
  ).toBeEnabled();
}
async function execute(draft: Locator, state = "committed") {
  await draft.getByRole("button", { name: "Execute saved request", exact: true }).click();
  await expect(
    draft.getByRole("status").filter({ hasText: new RegExp(`^${state}$`, "u") }),
  ).toBeVisible();
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  await expect(page.getByRole("heading", { name: "Preparing content", exact: true })).toHaveCount(
    0,
  );
  await waitForPageReads(page);
  await page.evaluate(() => {
    for (const e of document.querySelectorAll<HTMLElement>(".wg-content")) e.scrollTop = 0;
    window.scrollTo(0, 0);
  });
  const file = info.outputPath(`${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await info.attach(name, { path: file, contentType: "image/png" });
}

test("Facts F01 explicit scopes, case-sensitive literal predicates, exact numbers and missing/null", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  await write.put("Case.one", '{"x":null,"n":1}');
  await write.put("Case.spelling", '{"x":null,"n":1.0}');
  await write.put("Case.no-path", '{"other":true}');
  await write.put("case.lower", '{"x":null,"n":1.0}');
  await write.put("Case.workspace", "null", "0", { kind: "workspace" });
  await mount(page, companion, daemon);
  await page.getByLabel("Literal key prefix", { exact: true }).fill("Case.");
  await page.getByRole("button", { name: "Apply fact filters", exact: true }).click();
  await expect(page.locator(".fact-keys > li")).toHaveCount(3);
  await page.getByText("Literal scalar predicates (0/8)", { exact: true }).click();
  await page.getByRole("button", { name: "Add predicate", exact: true }).click();
  await page.getByLabel("Predicate 1 pointer", { exact: true }).fill("/x");
  await page.getByLabel("Predicate 1 scalar JSON", { exact: true }).fill("null");
  await page.getByRole("button", { name: "Apply fact filters", exact: true }).click();
  await expect(page.locator(".fact-keys > li")).toHaveCount(2);
  await page.getByRole("button", { name: "Add predicate", exact: true }).click();
  await page.getByLabel("Predicate 2 pointer", { exact: true }).fill("/n");
  await page.getByLabel("Predicate 2 scalar JSON", { exact: true }).fill("1.0");
  await page.getByRole("button", { name: "Apply fact filters", exact: true }).click();
  await expect(page.locator(".fact-keys > li")).toHaveCount(1);
  await expect(page.locator(".fact-keys")).toContainText("Case.spelling");
  await page
    .locator(".fact-keys")
    .getByRole("button", { name: "Case.spelling", exact: true })
    .click();
  await expect(panel(page, "Fact Case.spelling")).toContainText("1.0");
  const missing = await exact(page, "never-created");
  await expect(missing).toContainText("never been created");
  await page.getByRole("combobox", { name: "Fact scope", exact: true }).selectOption("workspace");
  await page.getByRole("button", { name: "Browse scope", exact: true }).click();
  await expect(page.locator(".fact-keys > li")).toHaveCount(1);
  await expect(page.locator(".fact-keys")).toContainText("Case.workspace");
  const nil = await exact(page, "Case.workspace");
  await expect(nil.getByText("null · revision 1", { exact: true })).toBeVisible();
  expect(await inspect(daemon, "Case.workspace", { kind: "workspace" })).toContain('"value":null');
  expect(browserFailures).toEqual([]);
  await screenshot(page, info, "facts-scope-and-null");
});

test("Facts F02 whole-value source, references, original writer, tombstone history and explicit restore", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  await mount(page, companion, daemon);
  let draft = await open(page, "browser.fact");
  const original =
    '{"large":900719925474099312345,"__proto__":{"constructor":null},"nullable":null}';
  await source(draft, original);
  await draft.getByRole("button", { name: "Edit references", exact: true }).click();
  await draft.getByRole("button", { name: "Add reference", exact: true }).click();
  await draft.getByLabel("Reference 1 ID", { exact: true }).fill("build");
  await draft.getByRole("button", { name: "Add reference", exact: true }).click();
  await draft.getByLabel("Reference 2 kind", { exact: true }).selectOption("resource");
  await draft.getByLabel("Reference 2 ID", { exact: true }).fill("notes");
  await review(draft);
  await actor(page, "human");
  await expect(draft.getByText("fixture-author", { exact: true }).first()).toBeVisible();
  await execute(draft);
  const raw = await inspect(daemon, "browser.fact");
  expect(raw).toContain('"large":900719925474099312345');
  expect(raw).toContain('"__proto__":{"constructor":null}');
  expect(raw).toContain('"actor_id":"fixture-author"');
  expect(raw).toContain(
    '"references":[{"id":"build","kind":"ticket"},{"id":"notes","kind":"resource"}]',
  );
  let detail = await exact(page, "browser.fact");
  await detail.getByRole("button", { name: "Delete selected fact", exact: true }).click();
  draft = panel(page, "Delete browser.fact");
  await review(draft, true);
  await execute(draft);
  expect(await inspect(daemon, "browser.fact")).toContain('"deleted":true');
  detail = await exact(page, "browser.fact");
  await detail.getByRole("button", { name: "Read fact history", exact: true }).click();
  const history = panel(page, "Fact history");
  await expect(history.locator("ol > li")).toHaveCount(2);
  await history
    .getByRole("button", { name: "Restore this value into a new draft", exact: true })
    .first()
    .click();
  draft = panel(page, "Edit browser.fact");
  await expect(draft).toContainText("Expected fact revision 2");
  await review(draft);
  await execute(draft);
  const restored = await inspect(daemon, "browser.fact");
  expect(restored).toContain('"revision":"3"');
  expect(restored).toContain('"large":900719925474099312345');
  expect(restored).toContain('"deleted":false');
  expect(browserFailures).toEqual([]);
  await screenshot(page, info, "facts-attributed-restore");
  const card = info.outputPath("facts-restored-saved-action.png");
  await draft
    .getByRole("heading", { name: "Review captured action", exact: true })
    .locator("..")
    .locator("..")
    .screenshot({ path: card });
  await info.attach("facts-restored-saved-action", { path: card, contentType: "image/png" });
});

test("Facts F03 conflict preserves base/local/current, rebase creates a new exact identity", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  await write.put("conflict", '{"value":"base","unknown":{"__proto__":null}}');
  await mount(page, companion, daemon);
  const prepared: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/ui-api/v1/operations/prepare")
      prepared.push(request.postData() ?? "");
  });
  let draft = await open(page, "conflict");
  await source(draft, '{"value":"local","unknown":{"__proto__":null}}');
  await review(draft);
  await write.put("conflict", '{"value":"remote","unknown":{"__proto__":null}}', "1");
  await execute(draft, "rejected");
  await expect(draft.getByRole("alert").filter({ hasText: /Conflict/u })).toBeVisible();
  await draft
    .getByRole("button", { name: "Read current value for comparison", exact: true })
    .click();
  await expect(
    draft.getByRole("heading", { name: "Current · newly observed", exact: true }),
  ).toBeVisible();
  await expect(draft.locator(".fact-comparison")).toContainText("local");
  await expect(draft.locator(".fact-comparison")).toContainText("remote");
  await draft
    .getByRole("button", { name: "Rebase local edit into a new draft", exact: true })
    .click();
  draft = panel(page, "Edit conflict");
  await expect(draft).toContainText("Expected fact revision 2");
  await review(draft);
  await execute(draft);
  expect(prepared).toHaveLength(2);
  expect(prepared[0]).toContain('"expected_revision":"1"');
  expect(prepared[1]).toContain('"expected_revision":"2"');
  const ids = prepared.map((text) => /"intention_id":"([^"]+)"/u.exec(text)?.[1]);
  expect(ids[0]).toBeDefined();
  expect(ids[1]).not.toBe(ids[0]);
  for (let i = 0; i < 2; i++) expect(prepared[i]).toContain(`"mutation_id":"${ids[i]}"`);
  const committed = await inspect(daemon, "conflict");
  expect(committed).toContain('"value":"local"');
  expect(committed).toContain('"unknown":{"__proto__":null}');
  expect(browserFailures).toEqual([]);
  await screenshot(page, info, "facts-explicit-rebase");
});

test("Facts F04 bounded key/history/reference pages preserve exact continuation and visible deletions", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  test.setTimeout(90000);
  const write = writer(daemon);
  for (let i = 0; i < 105; i++)
    await write.put(`page.${String(i).padStart(3, "0")}`, String(i), "0", project, [
      { kind: "ticket", id: "build" },
    ]);
  for (let i = 0; i < 101; i++) await write.put("versioned", String(i), String(i));
  await mount(page, companion, daemon);
  await page.getByLabel("Literal key prefix", { exact: true }).fill("page.");
  await page.getByRole("button", { name: "Apply fact filters", exact: true }).click();
  await expect(page.locator(".fact-keys > li")).toHaveCount(100);
  await page.getByRole("button", { name: "Next key page", exact: true }).click();
  await expect(page.locator(".fact-keys > li")).toHaveCount(5);
  await expect(page.locator(".fact-keys")).toContainText("page.104");
  const detail = await exact(page, "versioned");
  await detail.getByRole("button", { name: "Read fact history", exact: true }).click();
  const history = panel(page, "Fact history");
  await expect(history.locator("ol > li")).toHaveCount(100);
  await history.getByRole("button", { name: "Next history page", exact: true }).click();
  await expect(history.locator("ol > li")).toHaveCount(1);
  await expect(history).toContainText("revision 101");
  await page.getByLabel("Referenced entity ID", { exact: true }).fill("build");
  await page.getByRole("button", { name: "Find referencing facts", exact: true }).click();
  const reverse = panel(page, "Find referencing facts");
  await expect(reverse.locator("ul > li")).toHaveCount(100);
  await reverse.getByRole("button", { name: "Next referencing facts", exact: true }).click();
  await expect(reverse.locator("ul > li")).toHaveCount(5);
  await expect(reverse).toContainText("page.104");
  expect(browserFailures).toEqual([]);
  await screenshot(page, info, "facts-bounded-pages");
});

test("Facts split view preserves live details, exact values, scrolling and original draft author", async ({
  page,
  daemon,
  companion,
  browserFailures,
}) => {
  const write = writer(daemon);
  const initial =
    '{"number":900719925474099312345,"spelling":1.0,"nullable":null,"enabled":true,"description":"First captured value",' +
    Array.from({ length: 30 }, (_, index) => `"item${index}":"Recorded value ${index}"`).join(",") +
    "}";
  await write.put("release.detail", initial);
  for (let index = 0; index < 24; index++)
    await write.put(`release.item.${String(index).padStart(2, "0")}`, '"directory entry"');
  await configure(page, companion, daemon);
  await page.goto(
    new URL("/#/facts?connection=local&workspace=demo&project=release", companion.url).href,
  );
  const directory = page.getByRole("complementary", { name: "Fact key directory" });
  const reader = page.getByRole("region", { name: "Selected fact", exact: true });
  await directory.getByRole("button").filter({ hasText: "release.detail" }).click();
  await expect(reader.getByRole("heading", { name: "release.detail", exact: true })).toBeVisible();
  await expect(reader.locator(".fact-structure")).toContainText("900719925474099312345");
  await expect(reader.locator(".fact-structure")).toContainText("1.0");
  await reader.getByText("Exact fact attribution and capture", { exact: true }).click();
  const attribution = reader
    .locator("details")
    .filter({ hasText: "Exact fact attribution and capture" });
  await expect(attribution).toHaveAttribute("open", "");
  await write.put(
    "release.detail",
    initial.replace("First captured value", "External live publication"),
    "1",
  );
  await expect(reader.locator(".fact-structure")).toContainText("External live publication");
  await expect(attribution).toHaveAttribute("open", "");
  await reader.evaluate((element) => {
    element.scrollTop = 0;
  });
  await reader.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => reader.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
  await page.setViewportSize({ width: 760, height: 800 });
  await reader.evaluate((element) => {
    element.scrollTop = 0;
  });
  await reader.hover();
  await page.mouse.wheel(0, 500);
  await expect.poll(() => reader.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
  await page.setViewportSize({ width: 1480, height: 1050 });
  await reader.getByRole("button", { name: "Read fact history", exact: true }).click();
  const history = page.getByRole("dialog", { name: "Fact history", exact: true });
  await history.getByText("Value at fact revision 1", { exact: true }).click();
  await expect(history).toContainText("First captured value");
  await page.getByRole("button", { name: "Close Fact history", exact: true }).click();
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill("fixture-author");
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  await reader.getByRole("button", { name: "Edit selected fact", exact: true }).click();
  const draft = page.getByRole("dialog", { name: "Edit fact · release.detail", exact: true });
  await source(draft, '{"published":"retained original writer"}');
  await page.getByRole("button", { name: "Close Edit fact · release.detail", exact: true }).click();
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill("human");
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  await page.getByRole("button", { name: "Drafts · 1", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Retained fact drafts", exact: true })
    .getByRole("button")
    .filter({ hasText: "release.detail" })
    .click();
  await draft.getByRole("button", { name: "Raw JSON source", exact: true }).click();
  await expect(draft.getByLabel("Fact JSON source", { exact: true })).toHaveValue(
    '{"published":"retained original writer"}',
  );
  await review(draft);
  await execute(draft);
  const raw = await inspect(daemon, "release.detail");
  expect(raw).toContain('"actor_id":"fixture-author"');
  expect(raw).toContain('"published":"retained original writer"');
  await page.getByRole("button", { name: "Close Edit fact · release.detail", exact: true }).click();
  await directory.hover();
  await page.mouse.wheel(0, 700);
  await expect.poll(() => directory.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
  await page.setViewportSize({ width: 760, height: 800 });
  await expect(reader).toBeVisible();
  await page.getByRole("button", { name: "← All facts", exact: true }).click();
  await expect(directory).toBeVisible();
  await directory.evaluate((element) => {
    element.scrollTop = 0;
  });
  await directory.hover();
  await page.mouse.wheel(0, 500);
  await expect.poll(() => directory.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(browserFailures).toEqual([]);
});

test("Fact URLs restore keys and explicit scopes with Back and Forward, and refresh preserves historical pins", async ({
  page,
  daemon,
  companion,
  browserDiagnostics,
}) => {
  const write = writer(daemon);
  await write.put("nav.alpha", '{"message":"original alpha"}');
  await write.put("nav.beta", '{"message":"current beta"}');
  await write.put("nav.ticket", '{"message":"ticket scoped value"}', "0", {
    kind: "ticket",
    id: "design",
  });
  await configure(page, companion, daemon);
  await page.goto(
    new URL("/#/facts?connection=local&workspace=demo&project=release", companion.url).href,
  );
  const directory = page.getByRole("complementary", { name: "Fact key directory" });
  const reader = page.getByRole("region", { name: "Selected fact", exact: true });
  const choose = async (key: string) => {
    browserDiagnostics.markPendingReads();
    await directory.getByRole("button").filter({ hasText: key }).click();
    await expect(reader.getByRole("heading", { name: key, exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`fact_key=${key.replaceAll(".", "\\.")}`, "u"));
  };
  const back = async () => {
    browserDiagnostics.markPendingReads();
    await page.goBack();
  };
  const forward = async () => {
    browserDiagnostics.markPendingReads();
    await page.goForward();
  };
  await choose("nav.alpha");
  await choose("nav.beta");
  await back();
  await expect(reader.locator(".fact-structure")).toContainText("original alpha");
  await forward();
  await expect(reader.locator(".fact-structure")).toContainText("current beta");
  browserDiagnostics.markPendingReads();
  await page.reload();
  await expect(reader.locator(".fact-structure")).toContainText("current beta");
  await choose("nav.alpha");
  await write.put("nav.alpha", '{"message":"new alpha"}', "1");
  await expect(reader.locator(".fact-structure")).toContainText("new alpha");
  await reader.getByRole("button", { name: "Read fact history", exact: true }).click();
  const history = page.getByRole("dialog", { name: "Fact history", exact: true });
  browserDiagnostics.markPendingReads();
  await history.getByRole("button", { name: "Open this version", exact: true }).first().click();
  await expect(reader.locator(".fact-structure")).toContainText("original alpha");
  await expect(page).toHaveURL(/fact_mode=pinned.*fact_revision=1/u);
  const pinnedURL = page.url();
  await write.put("nav.alpha", '{"message":"third alpha"}', "2");
  const filters = page.getByRole("dialog", { name: "Fact scope & filters", exact: true });
  await page.getByRole("button", { name: "Scope & filters", exact: true }).click();
  browserDiagnostics.markPendingReads();
  await filters.getByRole("button", { name: "Refresh facts", exact: true }).click();
  await filters.getByLabel("Literal key prefix", { exact: true }).fill("nav.");
  browserDiagnostics.markPendingReads();
  await filters.getByRole("button", { name: "Apply fact filters", exact: true }).click();
  await expect(reader.locator(".fact-structure")).toContainText("original alpha");
  await expect(page).toHaveURL(pinnedURL);
  browserDiagnostics.markPendingReads();
  await page.reload();
  await expect(reader.locator(".fact-structure")).toContainText("original alpha");
  browserDiagnostics.markPendingReads();
  await reader.getByRole("button", { name: "Return to current value", exact: true }).click();
  await expect(reader.locator(".fact-structure")).toContainText("third alpha");
  await expect(page).toHaveURL(/fact_mode=current/u);
  await page.getByRole("button", { name: "Scope & filters", exact: true }).click();
  await filters.getByRole("combobox", { name: "Fact scope", exact: true }).selectOption("ticket");
  await filters.getByLabel("Fact scope ID", { exact: true }).fill("design");
  browserDiagnostics.markPendingReads();
  await filters.getByRole("button", { name: "Browse scope", exact: true }).click();
  await expect(page).toHaveURL(/fact_scope=ticket.*fact_scope_id=design.*fact_mode=directory/u);
  const directoryURL = page.url();
  await choose("nav.ticket");
  await expect(reader.locator(".fact-structure")).toContainText("ticket scoped value");
  await back();
  await expect(page).toHaveURL(directoryURL);
  await expect(
    reader.getByRole("heading", { name: "Shared context, one key at a time", exact: true }),
  ).toBeVisible();
  await forward();
  await expect(reader.locator(".fact-structure")).toContainText("ticket scoped value");
  browserDiagnostics.markPendingReads();
  await page.reload();
  await expect(reader.locator(".fact-structure")).toContainText("ticket scoped value");
});

test("Fact history pages go forward and back without replacing the selected fact", async ({
  page,
  daemon,
  companion,
}) => {
  const write = writer(daemon);
  for (let index = 0; index < 101; index++)
    await write.put("history.pages", JSON.stringify({ version: index + 1 }), String(index));
  await configure(page, companion, daemon);
  await page.goto(
    new URL("/#/facts?connection=local&workspace=demo&project=release", companion.url).href,
  );
  await page
    .getByRole("complementary", { name: "Fact key directory" })
    .getByRole("button")
    .filter({ hasText: "history.pages" })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Selected fact", exact: true })
      .getByRole("heading", { name: "history.pages", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Read fact history", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Fact history", exact: true });
  await expect(dialog.getByText("Value at fact revision 1", { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Previous history page", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Next history page", exact: true }).click();
  await expect(dialog.getByText("Value at fact revision 101", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Page 2", { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Next history page", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Previous history page", exact: true }).click();
  await expect(dialog.getByText("Value at fact revision 1", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Page 1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close Fact history", exact: true }).click();
  await expect(page).toHaveURL(/fact_key=history.pages/u);
  await expect(page.getByRole("region", { name: "Selected fact", exact: true })).toContainText(
    "revision 101",
  );
});

test("Selecting a fact on a later directory page preserves the page and Previous returns to its capture", async ({
  page,
  daemon,
  companion,
}) => {
  const write = writer(daemon);
  for (let index = 0; index < 101; index++)
    await write.put(`key.${String(index).padStart(3, "0")}`, JSON.stringify({ index }));
  await configure(page, companion, daemon);
  await page.goto(
    new URL("/#/facts?connection=local&workspace=demo&project=release", companion.url).href,
  );
  const directory = page.getByRole("complementary", { name: "Fact key directory" });
  await expect(
    directory.getByRole("button", { name: "Previous key page", exact: true }),
  ).toBeDisabled();
  await directory.getByRole("button", { name: "Next key page", exact: true }).click();
  await directory.getByRole("button").filter({ hasText: "key.100" }).click();
  await expect(
    page
      .getByRole("region", { name: "Selected fact", exact: true })
      .getByRole("heading", { name: "key.100", exact: true }),
  ).toBeVisible();
  await expect(directory.getByRole("button").filter({ hasText: "key.100" })).toBeVisible();
  await expect(
    directory.getByRole("button", { name: "Next key page", exact: true }),
  ).toBeDisabled();
  await directory.getByRole("button", { name: "Previous key page", exact: true }).click();
  await expect(directory.getByRole("button").filter({ hasText: "key.000" })).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Selected fact", exact: true })
      .getByRole("heading", { name: "key.100", exact: true }),
  ).toBeVisible();
  await directory.getByRole("button", { name: "Next key page", exact: true }).click();
  await expect(directory.getByRole("button").filter({ hasText: "key.100" })).toBeVisible();
});

test("Referencing facts paginate both ways without changing the reference", async ({
  page,
  daemon,
  companion,
}, info) => {
  const write = writer(daemon);
  for (let index = 0; index < 101; index++)
    await write.put(`ref.${String(index).padStart(3, "0")}`, "true", "0", project, [
      { kind: "ticket", id: "design" },
    ]);
  await configure(page, companion, daemon);
  await page.goto(
    new URL("/#/facts?connection=local&workspace=demo&project=release", companion.url).href,
  );
  await page.getByRole("button", { name: "Find references", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Find referencing facts", exact: true });
  await dialog
    .getByRole("combobox", { name: "Referenced entity kind", exact: true })
    .selectOption("ticket");
  await dialog.getByLabel("Referenced entity ID", { exact: true }).fill("design");
  await dialog.getByRole("button", { name: "Find referencing facts", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "ref.000", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Next referencing facts", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "ref.100", exact: true })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Next referencing facts", exact: true }),
  ).toBeDisabled();
  await page.screenshot({ path: info.outputPath("reference-pages.png") });
  await dialog.getByRole("button", { name: "Previous referencing facts", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "ref.000", exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Referenced entity ID", { exact: true })).toHaveValue("design");
});
