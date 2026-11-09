import { waitForPageReads } from "../e2e/support/readiness";
import type { Locator, Page, TestInfo } from "@playwright/test";
import type { CompanionFixture } from "../../../test-support/companion-fixture.mjs";
import type { DaemonFixture } from "../../../test-support/daemon-fixture.mjs";
import { test, expect } from "../e2e/support/fixtures";
test.use({ colorScheme: "dark", viewport: { width: 1600, height: 1000 }, actionTimeout: 10000 });
function writer(daemon: DaemonFixture) {
  let serial = 0;
  return async (method: string, params: Record<string, unknown>) =>
    JSON.parse(
      await daemon.call(
        method,
        JSON.stringify({
          workspace_id: "demo",
          actor_id: "fixture-author",
          mutation_id: `progress-browser-${++serial}`,
          ...params,
        }),
      ),
    ) as { result: { data: Record<string, unknown> } };
}
async function ticket(daemon: DaemonFixture, id = "design") {
  return (
    JSON.parse(
      await daemon.call(
        "ticket.read",
        JSON.stringify({ workspace_id: "demo", ticket_id: id, max_bytes: "1048576" }),
      ),
    ) as {
      result: {
        data: {
          ticket: {
            status: string;
            revision: string;
            claim: { actor_id: string; run_id: string | null; token: string } | null;
          };
        };
      };
    }
  ).result.data.ticket;
}
async function actor(page: Page, id: string, run = "") {
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill(id);
  await page.getByLabel("Run ID (optional)", { exact: true }).fill(run);
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  await waitForPageReads(page);
}
async function retained(page: Page, label: RegExp) {
  const picker = page.getByLabel("Retained participation editor", { exact: true });
  const value = await picker
    .locator("option")
    .filter({ hasText: label })
    .first()
    .getAttribute("value");
  if (!value) throw new Error("Missing retained editor");
  await picker.selectOption(value);
}
async function mount(page: Page, companion: CompanionFixture, daemon: DaemonFixture, run = "") {
  const html = await page.request.get(companion.url),
    matches = [
      ...(await html.text()).matchAll(
        /<meta name="workgraph-capability" content="([a-f0-9]{64})"/gu,
      ),
    ],
    capability = matches[0]?.[1];
  if (matches.length !== 1 || !capability) throw new Error("Missing native capability");
  for (const [path, body] of [
    [
      "/connections",
      { id: "local", label: "Synthetic progress qualification", socket: daemon.socket },
    ],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const result = await page.request.post(new URL(`/ui-api/v1${path}`, companion.url).href, {
      headers: { "X-Workgraph-UI-Capability": capability, Origin: new URL(companion.url).origin },
      data: body,
    });
    expect(result.status()).toBe(200);
    await result.text();
  }
  await page.goto(
    new URL("/#/work?connection=local&workspace=demo&project=release&entity=design", companion.url)
      .href,
  );
  await expect(page.getByRole("heading", { name: "Tickets", exact: true })).toBeVisible();
  await waitForPageReads(page);
  await actor(page, "fixture-author", run);
  await activity(page);
}
async function activity(page: Page) {
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Progress and handoff", exact: true }),
  ).toBeVisible();
  await waitForPageReads(page);
}
async function open(page: Page, method: string, label: string) {
  await page.getByLabel("Participation action", { exact: true }).selectOption(method);
  await page.getByRole("button", { name: "Open participation composer", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: label, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function review(dialog: Locator) {
  await dialog.getByRole("button", { name: "Review action", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply action", exact: true })).toBeEnabled();
}
async function apply(dialog: Locator) {
  await dialog.getByRole("button", { name: "Apply action", exact: true }).click();
  await expect(dialog.getByText("Committed", { exact: true })).toBeVisible();
}
async function close(dialog: Locator) {
  await dialog.getByRole("button", { name: "Hide editor; keep draft", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
async function refresh(page: Page) {
  await page.getByRole("button", { name: "Refresh tickets", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Loading ticket/u })).toHaveCount(0);
  await waitForPageReads(page);
  await activity(page);
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(name);
  await page.screenshot({ path, fullPage: false });
  await info.attach(name, { path, contentType: "image/png" });
}
function panel(page: Page, title: string) {
  return page
    .locator(".wg-panel")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
}

test("native owner progress and ticket comment revisions retain original author across navigation", async ({
  page,
  daemon,
  companion,
  browserFailures,
  browserDiagnostics,
}, info) => {
  const write = writer(daemon);
  await write("ticket.claim", { ticket_id: "design" });
  await mount(page, companion, daemon);
  let dialog = await open(page, "ticket.progress", "Post owner progress");
  await dialog.getByLabel("Message", { exact: true }).fill("Exact original owner update 雪");
  await close(dialog);
  browserDiagnostics.markPendingReads();
  await actor(page, "human");
  await activity(page);
  await retained(page, /Post owner progress/u);
  dialog = page.getByRole("dialog", { name: "Post owner progress", exact: true });
  await expect(dialog.getByLabel("Message", { exact: true })).toHaveValue(
    "Exact original owner update 雪",
  );
  await expect(dialog).toContainText("this editor keeps its original author");
  await dialog.getByRole("button", { name: "Post", exact: true }).click();
  await expect(dialog.getByText("Committed", { exact: true })).toBeVisible();
  await screenshot(page, info, "progress-original-author-committed.png");
  await close(dialog);
  dialog = await open(page, "comment.add", "Post ticket comment");
  await dialog
    .getByLabel("Message", { exact: true })
    .fill("Exact human comment <script>window.progressPayloadExecuted=true</script>");
  await dialog.getByRole("button", { name: "Post", exact: true }).click();
  await expect(dialog.getByText("Committed", { exact: true })).toBeVisible();
  await close(dialog);
  const listed = JSON.parse(
    await daemon.call(
      "comment.list",
      JSON.stringify({
        workspace_id: "demo",
        target: { kind: "ticket", id: "design" },
        max_bytes: "1048576",
      }),
    ),
  ) as {
    result: {
      data: { items: { comment_id: string; author_id: string; body: string; revision: string }[] };
    };
  };
  expect(
    listed.result.data.items.filter((item) => item.body === "Exact original owner update 雪"),
  ).toHaveLength(1);
  expect(
    listed.result.data.items.find((item) => item.body === "Exact original owner update 雪")
      ?.author_id,
  ).toBe("fixture-author");
  const comment = listed.result.data.items.find((item) => item.author_id === "human");
  if (!comment) throw new Error("Missing human comment");
  dialog = await open(page, "comment.edit", "Edit own comment");
  await dialog.getByLabel("Comment ID", { exact: true }).fill(comment.comment_id);
  await dialog.getByLabel("Edited message", { exact: true }).fill("Exact edited human comment");
  await review(dialog);
  await apply(dialog);
  await close(dialog);
  dialog = await open(page, "comment.tombstone", "Tombstone own comment");
  await dialog.getByLabel("Comment ID", { exact: true }).fill(comment.comment_id);
  await review(dialog);
  await apply(dialog);
  await close(dialog);
  const comments = panel(page, "Ticket comments");
  await comments.getByRole("button", { name: "Load ticket comments", exact: true }).click();
  await expect(
    comments.getByText("Comment tombstoned; historical revisions remain inspectable.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(await page.evaluate(() => Object.hasOwn(window, "progressPayloadExecuted"))).toBe(false);
  for (let index = 0; index < 26; index++)
    await write("comment.add", {
      target: { kind: "ticket", id: "design" },
      body: `Bounded pagination fixture ${index}`,
    });
  await comments.getByRole("button", { name: "Load ticket comments", exact: true }).click();
  await expect(comments).toContainText("3 items remain beyond this page.");
  await expect(comments.locator("article")).toHaveCount(25);
  const firstPageIds = await comments.locator("article > p > code:first-child").allTextContents();
  await comments.getByRole("button", { name: "Next ticket comments page", exact: true }).click();
  await expect(comments.locator("article")).toHaveCount(3);
  const lastPageIds = await comments.locator("article > p > code:first-child").allTextContents();
  const allComments = JSON.parse(
    await daemon.call(
      "comment.list",
      JSON.stringify({
        workspace_id: "demo",
        target: { kind: "ticket", id: "design" },
        include_tombstones: true,
        include_archived: true,
        max_bytes: "1048576",
      }),
    ),
  ) as { result: { data: { items: { comment_id: string }[] } } };
  const traversedIds = [...firstPageIds, ...lastPageIds];
  expect(new Set(traversedIds).size).toBe(28);
  expect([...traversedIds].sort()).toEqual(
    allComments.result.data.items.map((item) => item.comment_id).sort(),
  );
  await expect(
    comments.getByRole("button", { name: "Next ticket comments page", exact: true }),
  ).toBeDisabled();

  await page.getByText("Exact comment and acknowledgement history", { exact: true }).click();
  await page.getByLabel("History comment ID", { exact: true }).fill(comment.comment_id);
  const history = panel(page, "Comment revision history");
  await history.getByRole("button", { name: "Load comment revision history", exact: true }).click();
  await expect(history.getByText("Exact edited human comment", { exact: true })).toBeVisible();
  await expect(history.getByText(/Exact human comment <script>/u)).toBeVisible();
  await waitForPageReads(page);
  expect(browserFailures).toEqual([]);
});

test("native handoff replacement preserves immutable history and explicit empty-field clearing", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  await write("ticket.claim", { ticket_id: "design" });
  await mount(page, companion, daemon);
  let dialog = await open(page, "handoff.set", "Save handoff");
  await dialog.getByLabel("Handoff summary", { exact: true }).fill("First exact handoff");
  await dialog.getByLabel("Next steps", { exact: true }).fill("Continue from the captured state");
  await dialog.getByLabel("Handoff evidence", { exact: true }).fill("Verified first state");
  await dialog.getByLabel("Decisions", { exact: true }).fill("Keep this decision in history");
  await dialog.getByLabel("Linked resource IDs", { exact: true }).fill("notes");
  await review(dialog);
  await expect(dialog.getByLabel("Handoff summary", { exact: true })).toHaveValue(
    "First exact handoff",
  );
  await apply(dialog);
  await close(dialog);
  dialog = await open(page, "handoff.set", "Save handoff");
  await dialog.getByLabel("Handoff summary", { exact: true }).fill("Second exact handoff");
  await review(dialog);
  await apply(dialog);
  await close(dialog);
  const current = panel(page, "Current handoff");
  await current.getByRole("button", { name: "Load current handoff", exact: true }).click();
  await expect(current.getByText("Second exact handoff", { exact: true })).toBeVisible();
  const history = panel(page, "Handoff history");
  await history.getByRole("button", { name: "Load handoff history", exact: true }).click();
  await expect(history.getByText("First exact handoff", { exact: true })).toBeVisible();
  await expect(history.getByText("Second exact handoff", { exact: true })).toBeVisible();
  const result = JSON.parse(
    await daemon.call(
      "handoff.get",
      JSON.stringify({ workspace_id: "demo", ticket_id: "design", max_bytes: "1048576" }),
    ),
  ) as {
    result: {
      data: { revision: string; next_steps: string; decisions: string; resource_ids: string[] };
    };
  };
  expect(result.result.data).toMatchObject({
    revision: "2",
    next_steps: "",
    decisions: "",
    resource_ids: [],
  });
  await current.scrollIntoViewIfNeeded();
  await screenshot(page, info, "handoff-replacement-and-history.png");
  await waitForPageReads(page);
  expect(browserFailures).toEqual([]);
});

test("native recorded attempts checkpoint and outcome remain distinct from claim release and ticket completion", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  await write("run.register", {
    target_run_id: "progress-run",
    objective: "Actual maintained browser progress qualification",
    process_ref: `playwright:${process.pid}`,
  });
  await write("ticket.claim", { ticket_id: "design", run_id: "progress-run" });
  await mount(page, companion, daemon, "progress-run");
  let dialog = await open(page, "attempt.start", "Start recorded attempt");
  const attemptId = await dialog.getByLabel("Attempt ID", { exact: true }).inputValue();
  await dialog.getByLabel("Conversation session IDs", { exact: true }).fill("generic");
  await review(dialog);
  await apply(dialog);
  await close(dialog);
  dialog = await open(page, "attempt.checkpoint", "Pin attempt checkpoint");
  await dialog.getByLabel("Attempt ID", { exact: true }).fill(attemptId);
  await dialog.getByLabel("Checkpoint target ID", { exact: true }).fill("notes");
  await dialog
    .getByLabel("Checkpoint content version or handoff revision", { exact: true })
    .fill("1");
  await review(dialog);
  await apply(dialog);
  await close(dialog);
  dialog = await open(page, "attempt.finish", "Finish recorded attempt");
  await dialog.getByLabel("Attempt ID", { exact: true }).fill(attemptId);
  await dialog.getByLabel("Attempt outcome", { exact: true }).selectOption("failed");
  await dialog
    .getByLabel("Attempt outcome evidence", { exact: true })
    .fill("Recorded test outcome; external process lifecycle is separate");
  await review(dialog);
  await apply(dialog);
  await close(dialog);
  expect(await ticket(daemon)).toMatchObject({
    status: "in_progress",
    claim: { actor_id: "fixture-author", run_id: "progress-run" },
  });
  const attempts = panel(page, "Recorded attempts");
  await attempts.getByRole("button", { name: "Load recorded attempts", exact: true }).click();
  await expect(
    attempts.getByRole("heading", { name: `${attemptId} · failed`, exact: true }),
  ).toBeVisible();
  await expect(attempts).toContainText("1 returned checkpoint");
  await attempts.scrollIntoViewIfNeeded();
  await screenshot(page, info, "attempt-outcome-with-claim-retained.png");
  // The existing ownership action owns release; it does not complete the ticket.
  await page.getByLabel("Action group", { exact: true }).selectOption("ownership");
  await page.getByLabel("Ticket action", { exact: true }).selectOption("ticket.release");
  await page.getByRole("button", { name: "Open action form", exact: true }).click();
  const release = page.getByRole("dialog", { name: "Release own claim", exact: true });
  await release.getByRole("button", { name: "Review action", exact: true }).click();
  await expect(release.getByRole("button", { name: "Apply action", exact: true })).toBeEnabled();
  await release.getByRole("button", { name: "Apply action", exact: true }).click();
  await expect(release.getByRole("status").filter({ hasText: /^committed$/u })).toBeVisible();
  expect(await ticket(daemon)).toMatchObject({ status: "todo", claim: null });
  await waitForPageReads(page);
  expect(browserFailures).toEqual([]);
});

test("native ticket finish, completion evidence and guarded reopen preserve earlier attempt history", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  await write("run.register", {
    target_run_id: "finish-run",
    objective: "Actual maintained finish/reopen qualification",
    process_ref: `playwright:${process.pid}`,
  });
  await write("ticket.claim", { ticket_id: "design", run_id: "finish-run" });
  await write("attempt.start", {
    ticket_id: "design",
    run_id: "finish-run",
    target_run_id: "finish-run",
    attempt_id: "finish-attempt",
    token: (await ticket(daemon)).claim?.token,
  });
  await mount(page, companion, daemon, "finish-run");
  let dialog = await open(page, "ticket.finish", "Finish ticket");
  await dialog
    .getByLabel("Completion evidence", { exact: true })
    .fill("Verified ticket completion with durable evidence");
  await dialog.getByLabel("Include a completion handoff", { exact: true }).check();
  await dialog.getByLabel("Handoff summary", { exact: true }).fill("Completed captured work");
  await review(dialog);
  await apply(dialog);
  expect(await ticket(daemon)).toMatchObject({ status: "done", claim: null });
  const completedAttempt = JSON.parse(
    await daemon.call(
      "attempt.get",
      JSON.stringify({ workspace_id: "demo", attempt_id: "finish-attempt" }),
    ),
  ) as { result: { data: { state: string } } };
  expect(completedAttempt.result.data.state).toBe("completed");
  await close(dialog);
  await refresh(page);
  const comments = panel(page, "Ticket comments");
  await comments.getByRole("button", { name: "Load ticket comments", exact: true }).click();
  await expect(
    comments.getByText(
      "Completion evidence is immutable. Append a correction reply to preserve its history.",
      { exact: true },
    ),
  ).toBeVisible();
  dialog = await open(page, "ticket.reopen", "Reopen ticket");
  await dialog
    .getByLabel("Reopening reason", { exact: true })
    .fill("Additional verified work remains");
  await review(dialog);
  await apply(dialog);
  expect(await ticket(daemon)).toMatchObject({ status: "todo", claim: null });
  await screenshot(page, info, "ticket-reopened-original-evidence-retained.png");
  await close(dialog);
  await write("ticket.claim", { ticket_id: "design", run_id: "finish-run" });
  await refresh(page);
  dialog = await open(page, "ticket.complete", "Complete ticket without handoff");
  await dialog
    .getByLabel("Completion evidence", { exact: true })
    .fill("Second completion retains prior handoff and evidence");
  await review(dialog);
  await apply(dialog);
  expect(await ticket(daemon)).toMatchObject({ status: "done", claim: null });
  await close(dialog);
  await waitForPageReads(page);
  expect(browserFailures).toEqual([]);
});

test("native current review gate rejects a stale finish and explicit refreshed copy retains original writer", async ({
  page,
  daemon,
  companion,
  browserFailures,
  browserDiagnostics,
}, info) => {
  const write = writer(daemon);
  await write("ticket.claim", { ticket_id: "design" });
  await mount(page, companion, daemon);
  let dialog = await open(page, "ticket.finish", "Finish ticket");
  await dialog
    .getByLabel("Completion evidence", { exact: true })
    .fill("Original exact finish evidence");
  await review(dialog);
  await write("review.policy.put", {
    ticket_id: "design",
    expected_revision: "0",
    enabled: true,
    reviewers: [{ kind: "actor", actor_id: "independent-reviewer" }],
    separate_actor: true,
    validators: [],
  });
  await dialog.getByRole("button", { name: "Apply action", exact: true }).click();
  await expect(dialog.getByText("Rejected", { exact: true })).toBeVisible();
  expect((await ticket(daemon)).status).toBe("in_progress");
  await close(dialog);
  const gate = panel(page, "Review gate");
  await gate.getByRole("button", { name: "Load review gate", exact: true }).click();
  await expect(
    gate.getByText("Current evidence/review gate blocks completion", { exact: true }),
  ).toBeVisible();
  await screenshot(page, info, "finish-current-gate-blocked.png");
  await write("review.policy.put", {
    ticket_id: "design",
    expected_revision: "1",
    enabled: false,
    reviewers: [],
    separate_actor: false,
    validators: [],
    weakening_reason: "Owned test deliberately removes its injected review requirement",
  });
  browserDiagnostics.markPendingReads();
  await actor(page, "human");
  await refresh(page);
  await retained(page, /Finish ticket/u);
  dialog = page.getByRole("dialog", { name: "Finish ticket", exact: true });
  await dialog.getByRole("button", { name: "Copy to refreshed ticket", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Finish ticket", exact: true });
  await expect(dialog.getByLabel("Completion evidence", { exact: true })).toHaveValue(
    "Original exact finish evidence",
  );
  await expect(dialog).toContainText("this editor keeps its original author");
  await review(dialog);
  await apply(dialog);
  expect(await ticket(daemon)).toMatchObject({ status: "done", claim: null });
  await screenshot(page, info, "finish-refreshed-copy-original-author.png");
  await close(dialog);
  await waitForPageReads(page);
  expect(browserFailures).toEqual([]);
});
