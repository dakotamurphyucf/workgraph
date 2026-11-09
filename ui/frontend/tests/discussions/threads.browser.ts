import type { Locator, Page, TestInfo } from "@playwright/test";
import type { CompanionFixture } from "../../../test-support/companion-fixture.mjs";
import {
  fixtureBinary,
  startDaemonFixture,
  type DaemonFixture,
} from "../../../test-support/daemon-fixture.mjs";
import { test, expect } from "../e2e/support/fixtures";
test.use({ colorScheme: "dark", viewport: { width: 1600, height: 1000 }, actionTimeout: 10000 });
test.setTimeout(90000);
type NativeRecord = Record<string, unknown>;
function object(value: unknown): NativeRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Malformed synthetic native record");
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Missing synthetic native string");
  return value;
}
function rows(value: unknown): readonly NativeRecord[] {
  if (!Array.isArray(value)) throw new Error("Missing synthetic native page");
  return value.map(object);
}
async function native(
  daemon: DaemonFixture,
  method: string,
  params: NativeRecord,
): Promise<NativeRecord> {
  const result = object(
    JSON.parse(await daemon.call(method, JSON.stringify({ workspace_id: "demo", ...params }))),
  );
  if (result.error !== undefined) throw new Error(JSON.stringify(result.error));
  return object(object(result.result).data);
}
function writer(daemon: DaemonFixture) {
  let serial = 0;
  return (method: string, params: NativeRecord) =>
    native(daemon, method, {
      actor_id: "fixture-author",
      mutation_id: `threads-browser-${++serial}`,
      ...params,
    });
}
async function capability(page: Page, companion: CompanionFixture) {
  const html = await (await page.request.get(companion.url)).text(),
    matches = [...html.matchAll(/<meta name="workgraph-capability" content="([a-f0-9]{64})"/gu)];
  const value = matches[0]?.[1];
  if (matches.length !== 1 || value === undefined)
    throw new Error("Missing actual bootstrap capability");
  return value;
}
async function metadata(
  page: Page,
  companion: CompanionFixture,
  path: string,
  body: NativeRecord,
  method: "POST" | "PUT" = "POST",
) {
  const token = await capability(page, companion),
    response = await page.request.fetch(new URL(`/ui-api/v1${path}`, companion.url).href, {
      method,
      headers: { "X-Workgraph-UI-Capability": token, Origin: new URL(companion.url).origin },
      data: body,
    });
  expect(response.status()).toBe(200);
  return object(await response.json());
}
async function actor(page: Page, id: string) {
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill(id);
  await page.getByLabel("Run ID (optional)", { exact: true }).fill("");
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Act as", exact: true })).toHaveCount(0);
  await expect(page.locator(".wg-actor-trigger")).toContainText(id);
}
async function mount(
  page: Page,
  companion: CompanionFixture,
  daemon: DaemonFixture,
  hash = "#/discussions?connection=local&workspace=demo&project=release",
) {
  await metadata(page, companion, "/connections", {
    id: "local",
    label: "Synthetic discussions qualification",
    socket: daemon.socket,
  });
  await metadata(page, companion, "/connections/local/attach", { generation: "1" });
  await page.goto(new URL(`/${hash}`, companion.url).href);
  await expect(page.getByRole("heading", { name: "Discussions", exact: true })).toBeVisible();
  await expect(page.locator(".dc-threads")).toBeVisible();
  await actor(page, "fixture-author");
}
async function navigate(page: Page, companion: CompanionFixture, hash: string) {
  await page.goto(new URL(`/${hash}`, companion.url).href);
  await page.waitForLoadState("networkidle");
}
function panel(page: Page, title: string) {
  return page
    .locator(".wg-panel")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) })
    .first();
}
async function editor(page: Page, label: string) {
  const dialog = page.getByRole("dialog", { name: label, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function review(dialog: Locator) {
  await dialog.getByRole("button", { name: "Review", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Apply captured action", exact: true }),
  ).toBeEnabled();
}
async function committed(dialog: Locator) {
  await expect(
    dialog.getByRole("status").filter({ hasText: "Saved action: committed" }),
  ).toBeVisible();
}
async function apply(dialog: Locator) {
  await dialog.getByRole("button", { name: "Apply captured action", exact: true }).click();
  await committed(dialog);
}
async function close(dialog: Locator) {
  await dialog.getByRole("button", { name: "Keep draft and close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(name);
  await page.screenshot({ path, fullPage: false });
  await info.attach(name, { path, contentType: "image/png" });
}
async function refresh(page: Page, title: string) {
  await panel(page, title)
    .getByRole("button", { name: "Refresh current capture", exact: true })
    .click();
  await page.waitForLoadState("networkidle");
}
async function commentList(daemon: DaemonFixture, id = "design") {
  return rows(
    (
      await native(daemon, "comment.list", {
        target: { kind: "ticket", id },
        include_tombstones: true,
        include_archived: true,
        limit: "100",
        max_bytes: "1048576",
      })
    ).items,
  );
}

test("actual boards and threads support metadata, replies, attachment and pinning", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  await mount(page, companion, daemon);
  await page.getByRole("button", { name: "Create board", exact: true }).click();
  let dialog = await editor(page, "Board details");
  await dialog.getByLabel("Board ID", { exact: true }).fill("ui-board");
  await dialog.getByLabel("Board title", { exact: true }).fill("Team delivery room");
  await review(dialog);
  await apply(dialog);
  await close(dialog);
  expect((await native(daemon, "board.get", { board_id: "ui-board" })).scope).toEqual({
    kind: "project",
    id: "release",
  });
  await refresh(page, "Boards");
  await page.getByRole("button", { name: "Team delivery room", exact: true }).click();
  await page.getByRole("button", { name: "Edit board", exact: true }).click();
  dialog = await editor(page, "Board details");
  await dialog.getByRole("button", { name: "Load current board", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Copy loaded values into editor", exact: true }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "Copy loaded values into editor", exact: true }).click();
  await expect(dialog.getByLabel("Board title", { exact: true })).toHaveValue("Team delivery room");
  await dialog.getByLabel("Board title", { exact: true }).fill("Delivery conversations");
  await review(dialog);
  await apply(dialog);
  await close(dialog);
  await page.getByRole("button", { name: "Create thread", exact: true }).click();
  dialog = await editor(page, "Thread details");
  await dialog.getByLabel("Thread ID", { exact: true }).fill("ui-thread");
  await dialog.getByLabel("Thread title", { exact: true }).fill("Ship the reviewed workflow");
  await dialog.getByLabel("Mentions", { exact: true }).fill("human");
  await review(dialog);
  await apply(dialog);
  await close(dialog);
  await refresh(page, "Threads");
  await page.getByRole("button", { name: "Ship the reviewed workflow", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Ship the reviewed workflow", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Write reply", exact: true }).click();
  dialog = await editor(page, "Write reply");
  await dialog
    .getByLabel("Body", { exact: true })
    .fill("Reviewed plan is ready. <script>unsafe()</script> 雪");
  await dialog.getByRole("button", { name: "Post", exact: true }).click();
  await committed(dialog);
  await close(dialog);
  await refresh(page, "Conversation");
  await expect(
    page.getByText("Reviewed plan is ready. <script>unsafe()</script> 雪", { exact: true }),
  ).toBeVisible();
  const attached = await write("comment.add", {
    comment_id: "existing-scope-comment",
    target: { kind: "project", id: "release" },
    body: "Existing authored context",
    kind: "decision",
  });
  expect(text(attached.comment_id)).toBe("existing-scope-comment");
  await page.getByRole("button", { name: "Attach existing comment", exact: true }).click();
  dialog = await editor(page, "Attach existing comment");
  await dialog.getByLabel("Existing comment ID", { exact: true }).fill("existing-scope-comment");
  await review(dialog);
  await apply(dialog);
  await close(dialog);
  await refresh(page, "Conversation");
  const card = page.getByRole("article", {
    name: "Comment existing-scope-comment revision 1",
    exact: true,
  });
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByText("Existing authored context", { exact: true })).toBeVisible();
  await card.getByText("More actions", { exact: true }).click();
  await card.getByRole("button", { name: "Pin message", exact: true }).click();
  dialog = await editor(page, "Pin message");
  await review(dialog);
  await apply(dialog);
  await close(dialog);
  await page.getByRole("button", { name: "Edit thread", exact: true }).click();
  dialog = await editor(page, "Thread details");
  await dialog.getByRole("button", { name: "Load current thread", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Copy loaded values into editor", exact: true }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "Copy loaded values into editor", exact: true }).click();
  await dialog.getByLabel("Thread title", { exact: true }).fill("Reviewed and pinned delivery");
  await dialog.getByLabel("Thread status", { exact: true }).selectOption("awaiting_response");
  await dialog.getByLabel("Pin thread", { exact: true }).check();
  await review(dialog);
  await apply(dialog);
  await close(dialog);
  await refresh(page, "Conversation");
  const thread = await native(daemon, "thread.get", {
    thread_id: "ui-thread",
    include_messages: true,
    message_limit: "25",
    max_bytes: "1048576",
  });
  expect(thread.title).toBe("Reviewed and pinned delivery");
  expect(thread.state).toBe("awaiting_response");
  expect(thread.pinned_comment_ids).toContain("existing-scope-comment");
  expect(
    rows(
      object(thread.related).messages === undefined
        ? undefined
        : object(object(thread.related).messages).items,
    ).map((value) => text(value.comment_id)),
  ).toContain("existing-scope-comment");
  await screenshot(page, info, "threads-native-conversation.png");
  await page.getByRole("button", { name: "Thread metadata history", exact: true }).click();
  await expect(
    panel(page, "Thread metadata history").getByText(/metadata revision 1/u),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit thread", exact: true }).click();
  dialog = await editor(page, "Thread details");
  await dialog.getByRole("button", { name: "Load current thread", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Copy loaded values into editor", exact: true }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "Copy loaded values into editor", exact: true }).click();
  await dialog
    .getByLabel("Thread title", { exact: true })
    .fill("Frozen title must not overwrite a concurrent edit");
  await review(dialog);
  await write("thread.put", {
    thread_id: "ui-thread",
    expected_revision: text(thread.revision),
    board_id: "ui-board",
    title: "Concurrent current title",
    participants: thread.participants,
    mentions: thread.mentions,
    links: thread.links,
    state: thread.state,
    closure_policy: thread.closure_policy,
    pinned: thread.pinned,
  });
  await dialog.getByRole("button", { name: "Apply captured action", exact: true }).click();
  await expect(
    dialog.getByRole("status").filter({ hasText: "Saved action: rejected" }),
  ).toBeVisible();
  await expect(dialog.getByLabel("Thread title", { exact: true })).toHaveValue(
    "Frozen title must not overwrite a concurrent edit",
  );
  expect((await native(daemon, "thread.get", { thread_id: "ui-thread" })).title).toBe(
    "Concurrent current title",
  );
  await close(dialog);
  expect(browserFailures).toEqual([]);
});

test("ticket comments keep original author through edits, tombstones and the actual Progress historical link", async ({
  page,
  daemon,
  companion,
  browserFailures,
  browserDiagnostics,
}, info) => {
  const write = writer(daemon);
  await mount(
    page,
    companion,
    daemon,
    "#/discussions?connection=local&workspace=demo&project=release&entity=design&discussion=ticket&generation=1",
  );
  await page.getByRole("button", { name: "Write ticket comment", exact: true }).click();
  let dialog = await editor(page, "Write ticket comment");
  await dialog.getByLabel("Body", { exact: true }).fill("Ticket discussion original body");
  await dialog.getByRole("button", { name: "Post", exact: true }).click();
  await committed(dialog);
  await close(dialog);
  await refresh(page, "Ticket discussion");
  let list = await commentList(daemon),
    comment = list.find((value) => value.body === "Ticket discussion original body");
  if (comment === undefined) throw new Error("Missing UI-created comment");
  const id = text(comment.comment_id);
  let card = page.getByRole("article", { name: `Comment ${id} revision 1`, exact: true });
  await card.getByText("More actions", { exact: true }).click();
  await card.getByRole("button", { name: "Edit own comment", exact: true }).click();
  dialog = await editor(page, "Edit own comment");
  await dialog
    .getByLabel("Body", { exact: true })
    .fill("Edited by the captured original author 雪");
  await close(dialog);
  browserDiagnostics.markPendingReads();
  await actor(page, "human");
  await page
    .getByRole("group", { name: "Retained discussion drafts", exact: true })
    .getByRole("button", { name: /Edit own comment · fixture-author/u })
    .click();
  dialog = await editor(page, "Edit own comment");
  await expect(
    dialog.getByText("Original writer retained after switch", { exact: true }),
  ).toBeVisible();
  await review(dialog);
  await apply(dialog);
  await close(dialog);
  await refresh(page, "Ticket discussion");
  comment = await native(daemon, "comment.get", { comment_id: id });
  expect(comment.author_id).toBe("fixture-author");
  expect(comment.actor_id).toBe("fixture-author");
  expect(comment.body).toBe("Edited by the captured original author 雪");
  browserDiagnostics.markPendingReads();
  await actor(page, "fixture-author");
  card = page.getByRole("article", { name: `Comment ${id} revision 2`, exact: true });
  await card.getByText("More actions", { exact: true }).click();
  await card.getByRole("button", { name: "Remove own comment", exact: true }).click();
  dialog = await editor(page, "Remove own comment");
  await review(dialog);
  await apply(dialog);
  await close(dialog);
  await refresh(page, "Ticket discussion");
  expect((await native(daemon, "comment.get", { comment_id: id })).tombstone).toBe(true);
  await write("comment.add", {
    comment_id: "exact-progress-comment",
    target: { kind: "ticket", id: "design" },
    body: "Historical original selected in Progress",
    kind: "comment",
  });
  await navigate(
    page,
    companion,
    "#/work?connection=local&workspace=demo&project=release&entity=design",
  );
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("button", { name: "Load ticket comments", exact: true }).click();
  await expect(
    page.getByText("Historical original selected in Progress", { exact: true }),
  ).toBeVisible();
  await write("comment.edit", {
    comment_id: "exact-progress-comment",
    expected_revision: "1",
    body: "Current body must never replace the linked old version",
  });
  const original = page
    .locator("article")
    .filter({ has: page.getByText("Historical original selected in Progress", { exact: true }) });
  await original.getByRole("button", { name: "Open exact comment revision", exact: true }).click();
  await expect(page).toHaveURL(/discussion=ticket/u);
  await expect(page).toHaveURL(/comment_revision=1/u);
  const history = panel(page, "Comment history");
  await history.scrollIntoViewIfNeeded();
  await expect(
    history.getByText("Historical original selected in Progress", { exact: true }),
  ).toBeVisible();
  await expect(
    history.getByText("Current body must never replace the linked old version", { exact: true }),
  ).toHaveCount(0);
  await expect(
    history
      .getByRole("article", { name: "Comment exact-progress-comment revision 1", exact: true })
      .getByText("Historical revision 1", { exact: true }),
  ).toBeVisible();
  await screenshot(page, info, "threads-exact-progress-comment.png");
  await navigate(
    page,
    companion,
    "#/discussions?connection=local&workspace=demo&project=release&entity=design&discussion=ticket&generation=1&comment=exact-progress-comment&comment_revision=9999",
  );
  await expect(
    panel(page, "Comment history").getByText(/unavailable in this complete history/u),
  ).toBeVisible();

  list = await commentList(daemon);
  expect(list.find((value) => value.comment_id === "exact-progress-comment")?.revision).toBe("2");
  expect(browserFailures).toEqual([]);
});

test("received direct messages preserve captured body, explicit recipient filters and independent unread consumer", async ({
  page,
  daemon,
  companion,
  browserFailures,
  browserDiagnostics,
}, info) => {
  const write = writer(daemon);
  await write("run.register", {
    target_run_id: "recipient-run",
    objective: "Owned browser-fixture recipient record",
    process_ref: "synthetic-browser-qualification",
  });
  await write("team.put", {
    team_id: "delivery-team",
    expected_revision: "0",
    title: "Synthetic delivery group",
    members: [
      { kind: "actor", id: "human" },
      { kind: "run", id: "recipient-run" },
    ],
  });
  await mount(page, companion, daemon);
  await page.getByLabel("More discussion actions", { exact: true }).click();
  await page.getByRole("button", { name: "New direct message", exact: true }).click();
  const dialog = await editor(page, "Send direct message");
  await dialog.getByLabel("Body", { exact: true }).fill("Original immutable delivery 雪");
  await dialog.getByLabel("Actor recipients", { exact: true }).fill("human");
  await dialog.getByLabel("Run recipients", { exact: true }).fill("recipient-run");
  await dialog.getByLabel("Recipient teams", { exact: true }).fill("delivery-team");
  await dialog.getByLabel("Related ticket ID (optional)", { exact: true }).fill("design");
  await dialog.getByRole("button", { name: "Send message", exact: true }).click();
  await committed(dialog);
  await close(dialog);
  await write("team.put", {
    team_id: "delivery-team",
    expected_revision: "1",
    title: "Synthetic group changed later",
    members: [],
  });
  await page.getByRole("button", { name: "Received messages", exact: true }).click();
  await page.getByLabel("Recipient ID", { exact: true }).fill("human");
  await page.getByText("Ticket, interval and reading queue", { exact: true }).click();
  await page.getByLabel("Related ticket filter (optional)", { exact: true }).fill("design");
  await page.getByLabel("Exclude recipient's own actions", { exact: true }).check();
  const consumer = await page
    .getByLabel("Received-message browser consumer", { exact: true })
    .inputValue();
  expect(consumer).toMatch(/^ui-received-/u);
  await expect(
    page.getByLabel("Received-message browser consumer", { exact: true }),
  ).toHaveAttribute("readonly", "");
  await page.getByRole("button", { name: "Read received messages", exact: true }).click();
  const message = page.getByRole("article", { name: /^Received message /u }).first();
  await message.scrollIntoViewIfNeeded();
  await expect(message.getByText("Original immutable delivery 雪", { exact: true })).toBeVisible();
  const incoming = await native(daemon, "inbox.read", {
    consumer_id: consumer,
    recipient: { kind: "actor", id: "human" },
    after: "0",
    kinds: ["message_received"],
    exclude_self: true,
    ticket_id: "design",
    limit: "100",
    max_bytes: "1048576",
  });
  const item = rows(incoming.items)[0];
  if (item === undefined) throw new Error("Missing actual notification");
  const body = object(item.body_source),
    source = object(item.source);
  await write("comment.edit", {
    comment_id: text(body.comment_id),
    expected_revision: "1",
    body: "Current edited source is a different fact",
  });
  await write("inbox.ack", {
    actor_id: "human",
    consumer_id: "actionable-inbox-qualification",
    recipient: { kind: "actor", id: "human" },
    notification_ids: [text(item.notification_id)],
  });
  browserDiagnostics.markPendingReads();
  await actor(page, "human");
  await message
    .getByRole("button", { name: "Open exact received-message capture", exact: true })
    .click();
  await expect(page.getByLabel("Recipient ID", { exact: true })).toHaveValue("human");
  await expect(page.getByLabel("Related ticket filter (optional)", { exact: true })).toHaveValue(
    "design",
  );
  await expect(page.getByLabel("Exclude recipient's own actions", { exact: true })).toBeChecked();
  await expect(page.getByText("Original immutable delivery 雪", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Current edited source is a different fact", { exact: true }),
  ).toHaveCount(0);
  expect(
    (await native(daemon, "comment.get", { comment_id: text(body.comment_id) })).revision,
  ).toBe("2");
  const unacked = await native(daemon, "inbox.read", {
    consumer_id: consumer,
    recipient: { kind: "actor", id: "human" },
    after: "0",
    kinds: ["message_received"],
    exclude_self: true,
    ticket_id: "design",
    limit: "100",
    max_bytes: "1048576",
  });
  expect(rows(unacked.items).map((value) => object(value.source).id)).toContain(source.id);
  await screenshot(page, info, "threads-immutable-received-body.png");
  await page.getByRole("button", { name: "Received messages", exact: true }).click();
  await page.getByLabel("Recipient kind", { exact: true }).selectOption("run");
  await page.getByLabel("Recipient ID", { exact: true }).fill("recipient-run");
  await page.getByRole("button", { name: "Read received messages", exact: true }).click();
  const runMessage = page.getByRole("article", { name: /^Received message /u }).first();
  await runMessage.scrollIntoViewIfNeeded();
  await expect(
    runMessage.getByText("Original immutable delivery 雪", { exact: true }),
  ).toBeVisible();
  const runRead = await native(daemon, "inbox.read", {
    consumer_id: consumer,
    recipient: { kind: "run", id: "recipient-run" },
    after: "0",
    kinds: ["message_received"],
    exclude_self: true,
    ticket_id: "design",
    limit: "100",
    max_bytes: "1048576",
  });
  expect(rows(runRead.items)).toHaveLength(1);
  expect(object(rows(runRead.items)[0]?.source).id).toBe(source.id);
  expect(browserFailures).toEqual([]);
});

test("native ticket and nested thread pagination traverse exact records in their declared order", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  for (let index = 0; index < 28; index++)
    await write("comment.add", {
      comment_id: `ticket-page-${String(index).padStart(2, "0")}`,
      target: { kind: "ticket", id: "design" },
      body: `Ticket page item ${index}\n\n\`\`\`ocaml\nlet page = ${index}\n\`\`\``,
      kind: "comment",
    });
  const thread = await native(daemon, "thread.get", { thread_id: "planning" });
  let revision = text(thread.revision);
  for (let index = 0; index < 27; index++) {
    const result = await write("thread.reply", {
      thread_id: "planning",
      expected_revision: revision,
      comment_id: `thread-page-${String(index).padStart(2, "0")}`,
      body: `Thread attachment item ${index}`,
    });
    revision = text(object(result.thread).revision);
  }
  await mount(
    page,
    companion,
    daemon,
    "#/discussions?connection=local&workspace=demo&project=release&entity=design&discussion=ticket&generation=1",
  );
  const comments = panel(page, "Ticket discussion"),
    seen = new Set<string | null>();
  const firstLabels = await comments
    .locator('article[aria-label^="Comment "]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
  expect(firstLabels).toHaveLength(25);
  const firstCards = comments.locator('article[aria-label^="Comment "]');
  for (let index = 0; index < 25; index++) {
    const card = firstCards.nth(index);
    await card.scrollIntoViewIfNeeded();
    await expect(card.locator(".wg-code-block code")).toContainText(`let page = ${index}`);
    await expect(card.getByRole("button", { name: /Retry/u })).toHaveCount(0);
    await expect(card.locator(".wg-syntax-keyword").first()).toBeVisible();
  }

  firstLabels.forEach((value) => seen.add(value));
  await comments.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(comments.locator('article[aria-label^="Comment "]')).toHaveCount(3);
  const nextLabels = await comments
    .locator('article[aria-label^="Comment "]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
  nextLabels.forEach((value) => seen.add(value));
  expect([...seen].sort()).toEqual(
    (await commentList(daemon))
      .map((value) => `Comment ${text(value.comment_id)} revision ${text(value.revision)}`)
      .sort(),
  );
  await navigate(
    page,
    companion,
    "#/discussions?connection=local&workspace=demo&project=release&entity=planning&discussion=thread&generation=1",
  );
  const conversation = panel(page, "Conversation");
  await expect(conversation.locator('article[aria-label^="Comment "]')).toHaveCount(25);
  const firstThreadLabels = await conversation
    .locator('article[aria-label^="Comment "]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
  await conversation.getByRole("button", { name: "Next messages", exact: true }).click();
  await expect(conversation.locator('article[aria-label^="Comment "]')).toHaveCount(3);
  const nextThreadLabels = await conversation
    .locator('article[aria-label^="Comment "]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
  const messages = object(
    object(
      await native(daemon, "thread.get", {
        thread_id: "planning",
        include_messages: true,
        message_limit: "100",
        max_bytes: "1048576",
      }),
    ).related,
  ).messages;
  const actual = rows(object(messages).items).map(
    (value) => `Comment ${text(value.comment_id)} revision ${text(value.revision)}`,
  );
  expect([...firstThreadLabels, ...nextThreadLabels]).toEqual(actual);
  expect(actual).toHaveLength(28);
  await screenshot(page, info, "threads-native-nested-page.png");
  expect(browserFailures).toEqual([]);
});

test("project and endpoint navigation retain drafts and refuse stale exact generations", async ({
  page,
  daemon,
  companion,
  browserFailures,
  browserDiagnostics,
}, info) => {
  const write = writer(daemon),
    other = await startDaemonFixture({ binary: fixtureBinary() });
  try {
    await write("project.create", {
      project_id: "second-project",
      title: "Second discussion project",
    });
    await write("board.put", {
      board_id: "second-board",
      expected_revision: "0",
      scope: { kind: "project", id: "second-project" },
      title: "Second project board",
    });
    await mount(page, companion, daemon);
    await expect(page.getByText("Browsing project release.", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Second project board", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Create board", exact: true }).click();
    let dialog = await editor(page, "Board details");
    await dialog.getByLabel("Board title", { exact: true }).fill("Unsent original project text");
    await close(dialog);
    browserDiagnostics.markPendingReads();
    await navigate(
      page,
      companion,
      "#/discussions?connection=local&workspace=demo&project=second-project",
    );
    await expect(
      page.getByRole("button", { name: "Second project board", exact: true }),
    ).toBeVisible();
    await page.goBack();
    await expect(page.getByText("Browsing project release.", { exact: true })).toBeVisible();
    await page
      .getByRole("group", { name: "Retained discussion drafts", exact: true })
      .getByRole("button", { name: /Board details · fixture-author/u })
      .click();
    dialog = await editor(page, "Board details");
    await expect(dialog.getByLabel("Board title", { exact: true })).toHaveValue(
      "Unsent original project text",
    );
    await expect(dialog.getByLabel("Board project ID", { exact: true })).toHaveValue("release");
    await close(dialog);
    const otherWrite = writer(other);
    await otherWrite("board.put", {
      board_id: "team",
      expected_revision: "1",
      scope: { kind: "project", id: "release" },
      title: "Other endpoint same board ID",
    });
    await metadata(
      page,
      companion,
      "/connections/local",
      { expected_generation: "1", label: "Second endpoint generation", socket: other.socket },
      "PUT",
    );
    await metadata(page, companion, "/connections/local/attach", { generation: "2" });
    await page.locator(".wg-workspace-switch").click();
    const manager = page.getByRole("dialog", { name: "Daemon connections", exact: true });
    await manager.getByRole("button", { name: "Refresh profiles", exact: true }).click();
    await expect(manager.getByText(/local · generation 2/u)).toBeVisible();
    await manager.getByRole("button", { name: "Close Daemon connections", exact: true }).click();
    await navigate(
      page,
      companion,
      "#/discussions?connection=local&workspace=demo&project=release&entity=team&discussion=board&generation=1",
    );
    await expect(page.getByText(/This link retains connection generation 1/u)).toBeVisible();
    await expect(
      panel(page, "Selected board").getByRole("heading", { name: "Team discussion", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Other endpoint same board ID", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Boards and threads", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Other endpoint same board ID", exact: true }),
    ).toBeVisible();
    await daemon.dispose();
    browserDiagnostics.expectedHTTP.set(new URL("/ui-api/v1/read", companion.url).href, 503);
    await navigate(
      page,
      companion,
      "#/discussions?connection=local&workspace=demo&project=release&entity=team&discussion=board&generation=1",
    );
    await expect(panel(page, "Selected board").getByRole("alert")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Other endpoint same board ID", exact: true }),
    ).toHaveCount(0);
    await screenshot(page, info, "threads-generation-fence.png");
    await navigate(
      page,
      companion,
      "#/discussions?connection=local&workspace=demo&discussion=ticket&generation=1&entity=design&comment=comment&comment_revision=0",
    );
    await expect(
      page.getByRole("heading", { name: "This link could not be opened", exact: true }),
    ).toBeVisible();
    expect(browserFailures).toEqual([]);
  } finally {
    await other.dispose();
  }
});

test("opening neighboring threads preserves sidebar scroll, selection and latest-message previews", async ({
  page,
  daemon,
  companion,
}) => {
  const write = writer(daemon);
  await write("board.put", {
    board_id: "scroll-board",
    expected_revision: "0",
    title: "Scroll checks",
    scope: { kind: "project", id: "release" },
  });
  for (let index = 0; index < 12; index++) {
    const threadId = `scroll-${String(index).padStart(2, "0")}`;
    await write("thread.put", {
      thread_id: threadId,
      board_id: "scroll-board",
      expected_revision: "0",
      title: `Conversation ${index}`,
      state: "open",
      participants: ["fixture-author"],
    });
    await write("thread.reply", {
      thread_id: threadId,
      expected_revision: "1",
      comment_id: `${threadId}-first`,
      body: "Earlier message",
    });
    await write("thread.reply", {
      thread_id: threadId,
      expected_revision: "2",
      comment_id: `${threadId}-latest`,
      body: `Latest update ${index}`,
    });
  }
  await mount(page, companion, daemon);
  const list = page.getByRole("complementary", { name: "Discussion collection", exact: true });
  await list.getByRole("button", { name: "Scroll checks", exact: true }).click();
  await expect(list.locator(".dc-thread-row")).toHaveCount(12);
  const last = list.locator(".dc-thread-row").filter({ hasText: "Conversation 11" });
  await last.scrollIntoViewIfNeeded();
  await expect(last.locator(".dc-message-excerpt")).toHaveText("Latest update 11");
  await expect(last.locator("time")).toBeVisible();
  await list.evaluate((element) => {
    element.dataset.continuity = "retained";
  });
  const before = await list.evaluate((element) => element.scrollTop);
  expect(before).toBeGreaterThan(0);
  await last.getByRole("button", { name: "Conversation 11", exact: true }).click();
  await expect(page.locator(".dc-conversation-heading h2")).toHaveText("Conversation 11");
  await expect(last).toHaveAttribute("data-selected", "true");
  await expect(list).toHaveAttribute("data-continuity", "retained");
  expect(
    Math.abs((await list.evaluate((element) => element.scrollTop)) - before),
  ).toBeLessThanOrEqual(2);
  const adjacent = list.locator(".dc-thread-row").filter({ hasText: "Conversation 10" });
  await adjacent.getByRole("button", { name: "Conversation 10", exact: true }).click();
  await expect(page.locator(".dc-conversation-heading h2")).toHaveText("Conversation 10");
  await expect(adjacent).toHaveAttribute("data-selected", "true");
  expect(
    Math.abs((await list.evaluate((element) => element.scrollTop)) - before),
  ).toBeLessThanOrEqual(2);
  await page.getByRole("button", { name: "← All discussions", exact: true }).click();
  await expect(list.locator(".dc-thread-row")).toHaveCount(13);
});

test("received-message choices include actors observed through runs without directory registration", async ({
  page,
  daemon,
  companion,
  browserFailures,
}) => {
  const write = writer(daemon);
  await write("run.register", {
    actor_id: "observed-worker",
    target_run_id: "observed-worker-run",
    objective: "Participant without an actor catalog entry",
  });
  await write("message.send", {
    message_id: "observed-worker-message",
    recipients: [{ kind: "actor", id: "observed-worker" }],
    body: "Delivery to an actor known through workspace activity",
  });
  await mount(page, companion, daemon);
  await page.getByRole("button", { name: "Received messages", exact: true }).click();
  const recipient = page.getByLabel("Recipient ID", { exact: true });
  await expect(recipient.locator('option[value="observed-worker"]')).toHaveCount(1, {
    timeout: 5000,
  });
  await recipient.selectOption("observed-worker");
  await expect(recipient).toHaveValue("observed-worker");
  await page.getByRole("button", { name: "Read received messages", exact: true }).click();
  await page
    .getByRole("article", { name: "Received message observed-worker-message", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByText("Delivery to an actor known through workspace activity", { exact: true }),
  ).toBeVisible();

  await write("actor.put", {
    target_actor_id: "registered-person",
    expected_revision: "0",
    name: "Registered Reviewer",
    kind: "person",
  });
  await write("actor.put", {
    target_actor_id: "archived-worker",
    expected_revision: "0",
    name: "Archived Worker",
    kind: "agent",
    archived: true,
  });
  await page.getByRole("button", { name: "Choose actor", exact: true }).click();
  await expect(recipient.locator('option[value="registered-person"]')).toHaveText(
    "Registered Reviewer · registered-person",
  );
  await expect(recipient.locator('option[value="observed-worker"]')).toHaveCount(1);
  await expect(recipient.locator('option[value="archived-worker"]')).toHaveCount(0);
  await expect(recipient).toHaveValue("observed-worker");
  await recipient.selectOption("registered-person");
  await expect(recipient).toHaveValue("registered-person");
  await page.getByRole("button", { name: "Enter ID", exact: true }).click();
  await expect(page.getByLabel("Recipient ID", { exact: true })).toHaveValue("registered-person");
  await page.getByLabel("Recipient ID", { exact: true }).fill("external-recipient");
  await page.getByRole("button", { name: "Choose actor", exact: true }).click();
  await expect(page.getByLabel("Recipient ID", { exact: true })).toHaveValue("external-recipient");
  expect(browserFailures).toEqual([]);
});
