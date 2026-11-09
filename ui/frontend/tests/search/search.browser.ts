import { createHash } from "node:crypto";
import type { Page, TestInfo } from "@playwright/test";
import { test, expect } from "../e2e/support/fixtures";
import type { DaemonFixture } from "../../../test-support/daemon-fixture.mjs";
import type { CompanionFixture } from "../../../test-support/companion-fixture.mjs";
import { parseJsonText, jsonField, type JsonValue } from "../../src/core/json";
import { searchPageCodec } from "../../src/features/search/codecs";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
test.use({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", actionTimeout: 12000 });
test.setTimeout(90000);
function result(source: string): JsonValue {
  const p = parseJsonText(source);
  if (!p.ok) throw new Error(p.error.message);
  const r = jsonField(p.value.value, "result");
  if (r === undefined) throw new Error(source);
  return r;
}
function writer(daemon: DaemonFixture) {
  let serial = 0;
  return async (method: string, params: object) =>
    result(
      await daemon.call(
        method,
        JSON.stringify({
          workspace_id: "demo",
          actor_id: "fixture-author",
          mutation_id: `search-${++serial}`,
          ...params,
        }),
      ),
    );
}
async function configure(page: Page, companion: CompanionFixture, daemon: DaemonFixture) {
  const html = await (await page.request.get(companion.url)).text(),
    cap = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(html)?.[1];
  if (cap === undefined) throw new Error("Missing actual capability");
  const headers = { Origin: new URL(companion.url).origin, "X-Workgraph-UI-Capability": cap };
  for (const [path, data] of [
    ["/connections", { id: "local", label: "Synthetic search workspace", socket: daemon.socket }],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const r = await page.request.post(new URL(`/ui-api/v1${path}`, companion.url).href, {
      headers,
      data,
    });
    expect(r.status(), await r.text()).toBe(200);
  }
  return headers;
}
async function seed(daemon: DaemonFixture) {
  const write = writer(daemon);
  await write("workspace.update", {
    expected_revision: "0",
    name: "copperfox workspace",
    description: "Search workspace",
  });
  await write("project.update", {
    project_id: "release",
    expected_revision: "1",
    title: "copperfox project",
  });
  await write("milestone.create", {
    milestone_id: "search-milestone",
    project_id: "release",
    title: "copperfox milestone",
  });
  await write("ticket.create", {
    ticket_id: "search-ticket",
    project_id: "release",
    title: "copperfox ticket",
    description: "Search exact ticket record",
  });
  await write("handoff.set", {
    ticket_id: "search-ticket",
    expected_revision: "0",
    summary: "copperfox handoff",
    next_steps: "Next explicit step",
    objective: "",
    completed: "",
    decisions: "",
    blockers: "",
    resource_ids: [],
    covers_through: "0",
    evidence: "",
  });
  await write("comment.add", {
    comment_id: "search-comment",
    target: { kind: "project", id: "release" },
    kind: "comment",
    body: "copperfox original comment",
  });
  await write("fact.put", {
    scope: { kind: "project", id: "release" },
    key: "search.setting",
    expected_revision: "0",
    value: "copperfox original fact",
  });
  await write("resource.put_text", {
    resource_id: "search-resource",
    expected_revision: "0",
    title: "copperfox resource",
    filename: "capture.md",
    mime_type: "text/markdown",
    text: "# copperfox original resource\n\nExact retained Markdown.",
  });
  return write;
}
async function mount(page: Page, companion: CompanionFixture) {
  await page.goto(new URL("/#/advanced?connection=local&workspace=demo", companion.url).href);
  await expect(page.getByRole("heading", { name: "Advanced", exact: true })).toBeVisible();
  // The application keeps live change waits open; readiness is a DOM state, not network idleness.
  await expect(page.getByText("Searching this captured scope…", { exact: true })).toHaveCount(0);
}
async function palette(page: Page, tab = "Search") {
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Command menu", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: tab, exact: true }).click();
  return dialog;
}
async function query(page: Page, text = "copperfox") {
  const dialog = await palette(page);
  await dialog.getByLabel("Search text", { exact: true }).fill(text);
  await dialog.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: `Results for “${text}”`, exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Searching this captured scope…", { exact: true })).toHaveCount(0);
  return dialog;
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  await expect(page.getByText("Searching this captured scope…", { exact: true })).toHaveCount(0);
  const file = info.outputPath(`${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  await info.attach(name, { path: file, contentType: "image/png" });
}
test("S00 actual native search exposes all nine qualified source shapes and truthful resource coverage", async ({
  daemon,
}, info) => {
  await seed(daemon);
  const raw = await daemon.call(
      "search.query",
      JSON.stringify({
        workspace_id: "demo",
        text: "copperfox",
        limit: "100",
        max_bytes: "1048576",
      }),
    ),
    envelope = result(raw),
    data = jsonField(envelope, "data"),
    page = searchPageCodec.decode(data);
  expect(page.ok, raw).toBe(true);
  if (!page.ok) throw new Error(page.issue.expected);
  expect(new Set(page.value.items.map((hit) => hit.source.kind))).toEqual(
    new Set([
      "workspace",
      "project",
      "milestone",
      "ticket",
      "handoff",
      "comment",
      "fact",
      "resource",
      "resource_text",
    ]),
  );
  expect(page.value.coverage.current_revisions_only).toBe(true);
  await info.attach("native-search-nine-source-envelope", {
    body: raw,
    contentType: "application/json",
  });
});
test("S01 palette preserves captured query and input across close, tabs and same-document back", async ({
  page,
  daemon,
  companion,
  browserFailures,
  browserDiagnostics,
}, info) => {
  await seed(daemon);
  await configure(page, companion, daemon);
  await mount(page, companion);
  let requests = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/read") && r.postData()?.includes('"method":"search.query"')) requests++;
  });
  let dialog = await query(page);
  expect(requests).toBe(1);
  await dialog.getByLabel("Search text", { exact: true }).fill("unsent query B");
  await page.keyboard.press("Escape");
  dialog = await palette(page);
  await expect(dialog.getByLabel("Search text", { exact: true })).toHaveValue("unsent query B");
  await expect(
    dialog.getByRole("heading", { name: "Results for “copperfox”", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("tab", { name: "Actions", exact: true }).click();
  await expect(dialog.getByLabel("Find a view or command")).toBeVisible();
  await dialog.getByRole("tab", { name: "Search", exact: true }).click();
  expect(requests).toBe(1);
  await screenshot(page, info, "search-captured-dark");
  await dialog.getByLabel("Search text", { exact: true }).fill("copperfox");
  const document = await page.evaluateHandle(() => globalThis.document);
  browserDiagnostics.markPendingReads();
  await dialog.getByRole("button", { name: "search-ticket ticket", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "Recorded ticket target", exact: true }),
  ).toBeVisible();
  expect(await document.evaluate((value) => value === globalThis.document)).toBe(true);
  browserDiagnostics.markPendingReads();
  await page.goBack();
  dialog = await palette(page);
  expect(requests).toBe(1);
  await expect(dialog.getByLabel("Search text", { exact: true })).toHaveValue("copperfox");
  await page.emulateMedia({ colorScheme: "light" });
  await screenshot(page, info, "search-captured-light");
  await page.setViewportSize({ width: 820, height: 760 });
  await screenshot(page, info, "search-captured-narrow");
  await dialog.getByLabel("Search text", { exact: true }).fill("unmatched-new-query");
  await dialog.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "Results for “unmatched-new-query”", exact: true }),
  ).toBeVisible();
  await expect(dialog.locator(".wg-search-result")).toHaveCount(0);
  await page.keyboard.press("Escape");
  dialog = await palette(page);
  await expect(dialog.getByLabel("Search text", { exact: true })).toHaveValue(
    "unmatched-new-query",
  );
  expect(requests).toBe(2);
  await page.keyboard.press("Escape");
  await document.dispose();
  expect(browserFailures).toEqual([]);
});
test("S02 exact comment, fact and resource content pins survive newer current revisions", async ({
  page,
  daemon,
  companion,
  browserFailures,
  browserDiagnostics,
}, info) => {
  const write = await seed(daemon);
  await configure(page, companion, daemon);
  await mount(page, companion);
  await query(page);
  await page.keyboard.press("Escape");
  await write("comment.edit", {
    comment_id: "search-comment",
    expected_revision: "1",
    body: "replacement current comment",
  });
  await write("fact.put", {
    scope: { kind: "project", id: "release" },
    key: "search.setting",
    expected_revision: "1",
    value: "replacement current fact",
  });
  await write("resource.put_text", {
    resource_id: "search-resource",
    expected_revision: "1",
    title: "replacement resource",
    filename: "capture.md",
    mime_type: "text/markdown",
    text: "Replacement current resource",
  });
  let dialog = await palette(page);
  browserDiagnostics.markPendingReads();
  await dialog.getByRole("button", { name: /^search-comment comment$/u }).click();
  await expect(page.getByText("copperfox original comment", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open project target · current resolution", exact: true }),
  ).toBeVisible();
  expect(page.url()).toContain("discussion=comment");
  expect(page.url()).toContain("comment_revision=1");
  await screenshot(page, info, "pinned-project-comment");
  dialog = await palette(page);
  browserDiagnostics.markPendingReads();
  await dialog.getByRole("button", { name: "search-resource resource text", exact: true }).click();
  await expect(page).toHaveURL(/content_version=1/u);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("copperfox original resource", { exact: true })).toBeVisible();
  expect(page.url()).toContain("content_version=1");
  expect(page.url()).toContain(
    `content_digest=${sha("# copperfox original resource\n\nExact retained Markdown.")}`,
  );
  await screenshot(page, info, "search-exact-resource-content");
  dialog = await palette(page);
  await dialog.getByLabel("Search text", { exact: true }).fill("retained original unsent");
  browserDiagnostics.markPendingReads();
  await dialog.getByRole("button", { name: /project:release \/ search.setting fact/u }).click();
  await expect(page).toHaveURL(/fact_revision=1/u);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/copperfox original fact/u)).toBeVisible();
  expect(page.url()).toContain("fact_revision=1");
  expect(page.url()).not.toContain("fact_at_revision");
  dialog = await palette(page);
  await expect(
    dialog.getByRole("heading", { name: "Results for “copperfox”", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  let rereads = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/read") && request.postData()?.includes('"method":"search.query"'))
      rereads++;
  });
  browserDiagnostics.markPendingReads();
  await page.goBack();
  dialog = await palette(page);
  await expect(
    dialog.getByRole("heading", { name: "Results for “copperfox”", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel("Search text", { exact: true })).toHaveValue(
    "retained original unsent",
  );
  await expect(
    dialog.getByRole("button", { name: /project:release \/ search.setting fact/u }),
  ).toBeFocused();
  expect(rereads).toBe(0);
  await screenshot(page, info, "search-cross-scope-return");
  await page.keyboard.press("Escape");
  expect(browserFailures).toEqual([]);
});
test("S03 planning continuation retains native capture and explicit coverage instead of combining revisions", async ({
  page,
  daemon,
  companion,
  browserFailures,
}) => {
  const write = await seed(daemon);
  for (let i = 0; i < 28; i++)
    await write("ticket.create", {
      ticket_id: `page-${String(i).padStart(2, "0")}`,
      title: `copperfox page ${i}`,
      project_id: "release",
    });
  await configure(page, companion, daemon);
  await mount(page, companion);
  const dialog = await query(page);
  const captured = /Current revisions at capture (\d+) · (\d+) sources scanned/u;
  const before = captured.exec((await dialog.getByText(/sources scanned/u).textContent()) ?? "");
  expect(before).not.toBeNull();
  await dialog.getByLabel("Search text", { exact: true }).fill("edited-unsubmitted");
  await dialog.getByText(/source kinds ·/u).click();
  await dialog.getByLabel("Include archived records", { exact: true }).check();
  await dialog.getByRole("button", { name: "Next captured page", exact: true }).click();
  await expect(dialog.getByLabel("Search text", { exact: true })).toHaveValue("edited-unsubmitted");
  await expect(dialog.getByLabel("Include archived records", { exact: true })).toBeChecked();
  await expect(dialog.locator(".wg-search-result")).toHaveCount(12);
  expect(
    captured.exec((await dialog.getByText(/sources scanned/u).textContent()) ?? "")?.slice(1),
  ).toEqual(before?.slice(1));
  await dialog.getByText(/Search coverage ·/u).click();
  await expect(
    dialog.getByText(/Historical resource versions, thread\/message text/u),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  expect(browserFailures).toEqual([]);
});
test("S04 history domain pins initial head and scanned cursor, separate from planning coverage", async ({
  page,
  daemon,
  companion,
  browserFailures,
  browserDiagnostics,
}, info) => {
  const write = await seed(daemon);
  await write("session.create", { session_id: "search-session", title: "Search history capture" });
  const event = (index: number) => ({
    client_id: `search-${index}`,
    role: "sensor",
    kind: "measurement",
    phase: "recorded",
    payload: {
      kind: "inline",
      bytes_base64: Buffer.from(`History payload ${index}`).toString("base64"),
    },
    searchable_text: {
      kind: "inline",
      bytes_base64: Buffer.from(`copperfox event ${index}`).toString("base64"),
    },
  });
  await write("session.append", {
    session_id: "search-session",
    events: Array.from({ length: 30 }, (_, i) => event(i)),
  });
  await configure(page, companion, daemon);
  await mount(page, companion);
  const dialog = await palette(page);
  await dialog.getByLabel("Search domain", { exact: true }).selectOption("history");
  await dialog.getByLabel("Search text", { exact: true }).fill("copperfox");
  await dialog.getByLabel("History session ID (optional)", { exact: true }).fill("search-session");
  await dialog.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "History results for “copperfox”", exact: true }),
  ).toBeVisible();
  await expect(dialog.locator(".wg-search-result")).toHaveCount(25);
  const head = await dialog.locator("code").textContent();
  await write("session.append", { session_id: "search-session", events: [event(31)] });
  await dialog.getByLabel("Search text", { exact: true }).fill("edited history input");
  await dialog.getByLabel("History session ID (optional)", { exact: true }).fill("other-session");
  await dialog.getByRole("button", { name: "Next scanned history page", exact: true }).click();
  await expect(dialog.getByLabel("History session ID (optional)", { exact: true })).toHaveValue(
    "other-session",
  );
  await expect(dialog.locator(".wg-search-result")).toHaveCount(5);
  expect(await dialog.locator("code").textContent()).toBe(head);
  await screenshot(page, info, "search-history-capture");
  browserDiagnostics.markPendingReads();
  await dialog
    .getByRole("button", { name: "search-session · event 30 measurement", exact: true })
    .click();
  expect(page.url()).toContain("event=30");
  expect(page.url()).toContain(`head=${head}`);
  await expect(page.getByText("History payload 29", { exact: true })).toBeVisible();
  expect(browserFailures).toEqual([]);
});
test("S05 unfamiliar pasted endpoint requires deliberate mapping; recents remain available offline", async ({
  page,
  daemon,
  companion,
  browserFailures,
  browserDiagnostics,
}, info) => {
  await seed(daemon);
  await configure(page, companion, daemon);
  await mount(page, companion);
  let dialog = await palette(page, "Jump");
  await dialog.getByText("Open a Workgraph link", { exact: true }).click();
  await dialog
    .getByLabel("Paste a Workgraph link", { exact: true })
    .fill(
      "https://untrusted.invalid/#/discussions?connection=unknown&workspace=demo&entity=search-comment&discussion=comment&generation=7&comment_revision=1",
    );
  await expect(dialog.getByText(/connection ID is unknown locally/u)).toBeVisible();
  await dialog.getByLabel("Map endpoint to saved profile", { exact: true }).selectOption("local");
  await dialog
    .getByRole("button", { name: "Map to selected endpoint and open", exact: true })
    .click();
  await expect(page.getByText("copperfox original comment", { exact: true })).toBeVisible();
  expect(page.url()).toContain("generation=1");
  expect(page.url()).toContain("comment_revision=1");
  await expect(page.getByText("Searching this captured scope…", { exact: true })).toHaveCount(0);
  await daemon.dispose();
  const readURL = new URL("/ui-api/v1/read", companion.url).href;
  browserDiagnostics.expectedHTTP.set(readURL, 503);
  try {
    dialog = await palette(page);
    await dialog.getByLabel("Search text", { exact: true }).fill("copperfox");
    const response = page.waitForResponse((r) => r.url() === readURL && r.status() === 503);
    await dialog.getByRole("button", { name: "Search", exact: true }).click();
    const failure = await response;
    expect(await failure.text()).toContain("Storage_unavailable");
    await expect(dialog.getByRole("alert")).toContainText("Storage_unavailable");
    await dialog.getByRole("tab", { name: "Jump", exact: true }).click();
    await expect(
      dialog
        .getByRole("region", { name: "Recent typed links", exact: true })
        .getByRole("button", { name: /discussions · search-comment/u }),
    ).toBeVisible();
    await screenshot(page, info, "search-offline-recents");
    await page.keyboard.press("Escape");
    await expect(page.getByText("Searching this captured scope…", { exact: true })).toHaveCount(0);
  } finally {
    browserDiagnostics.expectedHTTP.delete(readURL);
  }
  expect(browserFailures).toEqual([]);
});

test("Command menu keyboard navigation, source shortcuts and empty commands are usable", async ({
  page,
  companion,
  daemon,
  browserDiagnostics,
  browserFailures,
}) => {
  await configure(page, companion, daemon);
  await mount(page, companion);
  const dialog = await palette(page, "Jump");
  await expect(dialog.getByLabel("Find in current scope", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Paste a Workgraph link", { exact: true })).toBeHidden();
  await dialog.getByRole("tab", { name: "Search", exact: true }).click();
  await dialog.locator(".wg-search-filters > summary").click();
  await dialog.getByRole("button", { name: "Tickets only", exact: true }).click();
  await expect(dialog.getByRole("checkbox", { name: "Tickets", exact: true })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "Facts", exact: true })).not.toBeChecked();
  await dialog.getByRole("checkbox", { name: "Tickets", exact: true }).uncheck();
  await dialog.getByLabel("Search text", { exact: true }).fill("needle");
  await expect(dialog.getByRole("button", { name: "Search", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "All sources", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Search", exact: true })).toBeEnabled();
  await dialog.getByRole("tab", { name: "Search", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByRole("tab", { name: "Actions", exact: true })).toBeFocused();
  await expect(dialog.getByRole("tab", { name: "Actions", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const input = dialog.getByLabel("Find a view or command", { exact: true });
  await input.fill("no-such-command");
  await expect(
    dialog.getByRole("heading", { name: "No matching commands", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Clear command search", exact: true }).click();
  await expect(input).toBeFocused();
  await input.fill("Go to History");
  await page.keyboard.press("ArrowDown");
  await expect(dialog.locator(".wg-command")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(input).toBeFocused();
  browserDiagnostics.markPendingReads();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/#\/history\?/u);
  expect(browserFailures).toEqual([]);
});
