import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import { test as parityTest, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { CompanionFixture } from "../../../test-support/companion-fixture.mjs";
import {
  fixtureBinary,
  startDaemonFixture,
  type DaemonFixture,
} from "../../../test-support/daemon-fixture.mjs";
import { test, expect } from "../e2e/support/fixtures";
import { createTestProcessor } from "../core/processing-harness";
import type { HttpClient } from "../../src/core/protocol/http";
import { stringifyJson } from "../../src/core/json";
import { preparation } from "../../src/features/discussions/requests/model";
import { invocation } from "../../src/features/discussions/requests/client";
import type { RequestsInput, RequestsRead } from "../../src/features/discussions/requests/types";
import { validRequestsDraft } from "./requests-native-fixtures";
const execute = promisify(execFile);
function idRequired<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing form guard");
  return value;
}
test.use({ colorScheme: "dark", viewport: { width: 1600, height: 1000 }, actionTimeout: 10000 });
test.setTimeout(90000);
type NativeRecord = Record<string, unknown>;
function object(value: unknown): NativeRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Native fixture object required");
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Native fixture text required");
  return value;
}
function rows(value: unknown): readonly NativeRecord[] {
  if (!Array.isArray(value)) throw new Error("Native fixture array required");
  return value.map(object);
}
function plain(value: Parameters<typeof stringifyJson>[0]): NativeRecord {
  const encoded = stringifyJson(value);
  if (!encoded.ok) throw new Error(encoded.error.message);
  return object(JSON.parse(encoded.value));
}
parityTest(
  "Requests forms and all read selectors match fresh executable schemas",
  // Playwright offline parity requires a destructured fixture argument.
  // eslint-disable-next-line no-empty-pattern
  async ({}, info) => {
    const processing = createTestProcessor(),
      http: HttpClient = {
        processing,
        request: () => Promise.reject(new Error("Offline parity never sends HTTP")),
      };
    const fields = {
      id: "new-question",
      kind: "clarification" as const,
      recipients: [{ kind: "actor" as const, id: "human" }],
      resolverId: "fixture-author",
      priority: "4",
      deadlineUnixMs: "9223372036854775807",
      relatedIds: ["related"],
      supersedesIds: ["superseded"],
    };
    const sample = validRequestsDraft(http, {
        method: "request.cancel",
        requestId: "probe-question",
      }),
      threadId = sample.guards.thread?.value.id,
      commentId = sample.guards.comment?.value.id,
      inbox = sample.guards.inbox?.value,
      team = sample.guards.team?.value,
      sub = sample.guards.subscription?.value;
    if (
      threadId === undefined ||
      commentId === undefined ||
      inbox === undefined ||
      team === undefined ||
      sub === undefined
    )
      throw new Error("Native form fixture guards");
    const forms: readonly RequestsInput[] = [
      {
        method: "request.ask",
        fields,
        body: "Question",
        destination: { kind: "new", title: "Title", boardId: "", ticketId: "" },
      },
      {
        method: "request.ask",
        fields: { ...fields, kind: "review" },
        body: "Question",
        destination: { kind: "thread", threadId },
      },
      {
        method: "request.create",
        fields,
        threadId,
        commentId,
        teams: ["team"],
        correlationId: "correlation",
        replyToId: "earlier",
      },
      {
        method: "request.acknowledge",
        requestId: "probe-question",
        recipient: { kind: "actor", id: "human" },
      },
      {
        method: "request.accept",
        requestId: "probe-question",
        recipient: { kind: "actor", id: "human" },
      },
      {
        method: "request.reassign",
        requestId: "probe-question",
        recipient: { kind: "run", id: "recipient-run" },
      },
      { method: "request.reassign", requestId: "probe-question", recipient: null },
      { method: "request.resolve", requestId: "probe-question", body: "Answer" },
      { method: "request.resolve", requestId: "probe-question", body: "" },
      { method: "request.cancel", requestId: "probe-question" },
      {
        method: "request.metadata",
        requestId: "probe-question",
        priority: { kind: "value", value: "0" },
        deadlineUnixMs: { kind: "clear" },
        relatedIds: { kind: "value", value: [] },
        supersedesIds: { kind: "keep" },
      },
      {
        method: "request.metadata",
        requestId: "probe-question",
        priority: { kind: "keep" },
        deadlineUnixMs: { kind: "value", value: "9223372036854775807" },
        relatedIds: { kind: "keep" },
        supersedesIds: { kind: "value", value: ["other"] },
      },
      {
        method: "inbox.ack",
        consumerId: inbox.consumerId,
        recipient: inbox.recipient,
        notificationIds: inbox.items.slice(0, 2).map((item) => item.id),
      },
      {
        method: "team.put",
        existing: false,
        teamId: "new-team",
        title: "Team",
        members: [{ kind: "run", id: "recipient-run" }],
      },
      { method: "team.put", existing: true, teamId: team.id, title: "Team changed", members: [] },
      {
        method: "subscription.put",
        existing: false,
        subscriptionId: "new-sub",
        recipient: { kind: "actor", id: "human" },
        filter: {
          scope: { kind: "project", id: "release" },
          threadId,
          kinds: ["request_created", "request_resolved"],
        },
        active: true,
      },
      {
        method: "subscription.put",
        existing: true,
        subscriptionId: sub.id,
        recipient: sub.recipient,
        filter: { scope: null, threadId: "", kinds: [] },
        active: false,
      },
    ];
    const selectors: readonly RequestsRead[] = [
      {
        kind: "requests",
        filter: {
          scope: { kind: "workspace" },
          threadId,
          ticketId: "build",
          resolverId: "fixture-author",
          recipient: { kind: "actor", id: "human" },
          responsible: { kind: "run", id: "recipient-run" },
          kind: "review",
          priority: "2",
          openOnly: true,
          unanswered: true,
          overdueAtUnixMs: "9223372036854775807",
          relatedToId: "r",
          supersedesId: "s",
          supersededById: "t",
        },
      },
      { kind: "request", requestId: idRequired(sample.guards.request?.value.id) },
      {
        kind: "history",
        requestId: idRequired(sample.guards.request?.value.id),
        selectedRevision: null,
      },
      {
        kind: "historical_comment",
        pin: { id: commentId, revision: idRequired(sample.guards.comment?.value.revision) },
      },
      ...[false, true].map((wait) => ({
        kind: "inbox" as const,
        wait,
        filter: {
          consumerId: "ui-inbox-human",
          recipient: { kind: "actor" as const, id: "human" },
          after: "0",
          through: "20",
          kinds: ["request_created" as const],
          ticketId: "build",
          excludeSelf: true,
        },
      })),
      { kind: "teams" },
      { kind: "team", teamId: team.id },
      { kind: "subscriptions", recipient: { kind: "run", id: "recipient-run" } },
      { kind: "subscription", subscriptionId: sub.id },
    ];
    const ajv = new Ajv2020({ strict: false, allErrors: true }),
      checks: unknown[] = [];
    ajv.addKeyword({
      keyword: "x-maxUtf8Bytes",
      type: "string",
      validate: (maximum: number, value: string) => Buffer.byteLength(value) <= maximum,
    });
    ajv.addKeyword({
      keyword: "x-maximumDecimal",
      type: "string",
      validate: (maximum: string, value: string) =>
        /^(0|[1-9][0-9]*)$/u.test(value) && BigInt(value) <= BigInt(maximum),
    });
    try {
      for (const value of [
        ...forms.map((input) => {
          const result = preparation(validRequestsDraft(http, input));
          return {
            method: result.method,
            params: { ...plain(result.params), mutation_id: "requests-schema-parity" },
          };
        }),
        ...selectors.map((selector) => {
          const result = invocation(sample.endpoint, selector);
          return { method: result.method, params: plain(result.params) };
        }),
      ]) {
        const schema = object(
            JSON.parse(
              (
                await execute(fixtureBinary(), ["schema", value.method], {
                  maxBuffer: 8 * 1024 * 1024,
                })
              ).stdout,
            ),
          ),
          methods = rows(schema.methods),
          params = object(methods[0]?.params),
          validate = ajv.compile(params);
        const valid = validate(value.params);
        checks.push({ method: value.method, params: value.params, valid, errors: validate.errors });
        expect(valid, `${value.method}: ${JSON.stringify(validate.errors)}`).toBe(true);
      }
      await info.attach("fresh-native-schema-parity", {
        contentType: "application/json",
        body: JSON.stringify(checks, null, 2),
      });
    } finally {
      processing.dispose();
    }
  },
);
async function native(
  daemon: DaemonFixture,
  method: string,
  params: NativeRecord,
): Promise<NativeRecord> {
  const response = object(
    JSON.parse(await daemon.call(method, JSON.stringify({ workspace_id: "demo", ...params }))),
  );
  if (response.error !== undefined) throw new Error(JSON.stringify(response.error));
  return object(object(response.result).data);
}
function writer(daemon: DaemonFixture) {
  let serial = 0;
  return (method: string, params: NativeRecord) =>
    native(daemon, method, {
      actor_id: "fixture-author",
      mutation_id: `requests-browser-${++serial}`,
      ...params,
    });
}
async function metadata(
  page: Page,
  companion: CompanionFixture,
  path: string,
  body: NativeRecord,
  method: "POST" | "PUT" = "POST",
) {
  const html = await (await page.request.get(companion.url)).text(),
    matches = [...html.matchAll(/<meta name="workgraph-capability" content="([a-f0-9]{64})"/gu)],
    token = matches[0]?.[1];
  if (matches.length !== 1 || token === undefined) throw new Error("Native bootstrap capability");
  const result = await page.request.fetch(new URL(`/ui-api/v1${path}`, companion.url).href, {
    method,
    headers: { "X-Workgraph-UI-Capability": token, Origin: new URL(companion.url).origin },
    data: body,
  });
  expect(result.status()).toBe(200);
  return object(await result.json());
}
async function actor(page: Page, id: string, run = "") {
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill(id);
  await page.getByLabel("Run ID (optional)", { exact: true }).fill(run);
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Acting actor & run", exact: true })).toBeHidden();
  await expect(page.locator(".wg-actor-trigger strong")).toHaveText(id);
}
async function mount(
  page: Page,
  companion: CompanionFixture,
  daemon: DaemonFixture,
  hash = "#/discussions?connection=local&workspace=demo&project=release&req_view=requests&req_generation=1",
) {
  await metadata(page, companion, "/connections", {
    id: "local",
    label: "Synthetic Requests qualification",
    socket: daemon.socket,
  });
  await metadata(page, companion, "/connections/local/attach", { generation: "1" });
  await page.goto(new URL(`/${hash}`, companion.url).href);
  await expect(page.locator(".wg-discussions-feature")).toBeVisible();
  await actor(page, "fixture-author");
}
async function go(page: Page, companion: CompanionFixture, hash: string) {
  await page.goto(new URL(`/${hash}`, companion.url).href);
  await expect(page.locator(".wg-discussions-feature")).toBeVisible();
}
async function editor(page: Page, title: string) {
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function review(dialog: Locator) {
  await dialog.getByRole("button", { name: "Review", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Apply captured action", exact: true }),
  ).toBeEnabled();
}
async function apply(dialog: Locator) {
  await dialog.getByRole("button", { name: "Apply captured action", exact: true }).click();
  await expect(
    dialog.getByRole("status").filter({ hasText: "Saved action: committed" }),
  ).toBeVisible();
}
async function close(dialog: Locator) {
  await dialog.getByRole("button", { name: "Keep draft and close", exact: true }).click();
}
async function requestRoute(
  page: Page,
  companion: CompanionFixture,
  id: string,
  revision: string | null = null,
  generation = "1",
) {
  await go(
    page,
    companion,
    `#/discussions?connection=local&workspace=demo&project=release&req_view=request&req_generation=${generation}&req_id=${id}${revision === null ? "" : `&req_revision=${revision}`}`,
  );
}
async function question(
  daemon: DaemonFixture,
  write: ReturnType<typeof writer>,
  id: string,
  body = "Original **question**",
  recipients: unknown[] = [{ kind: "actor", id: "human" }],
) {
  const thread = await native(daemon, "thread.get", { thread_id: "planning" });
  return write("request.ask", {
    request_id: id,
    kind: "clarification",
    resolver_id: "fixture-author",
    recipients,
    thread_id: "planning",
    expected_thread_revision: text(thread.revision),
    body,
  });
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
}

test("real questions preserve original author, independent acknowledgement/responsibility, context reply and resolver answer", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  await mount(page, companion, daemon);
  await page.getByRole("button", { name: "Ask a question", exact: true }).click();
  let dialog = await editor(page, "Ask a question");
  await dialog
    .getByLabel("Question", { exact: true })
    .fill(
      "## Ship decision\n\nWhich reviewed change should ship?\n\n```ocaml\nlet safe = true\n```",
    );
  await dialog.getByRole("button", { name: "Add direct recipients", exact: true }).click();
  await dialog.getByLabel("Direct recipients 1 ID", { exact: true }).fill("human");
  await dialog.getByText("Priority, deadline and related requests", { exact: true }).click();
  await dialog.getByLabel("Request ID", { exact: true }).fill("ui-question");
  await dialog.getByLabel("Discussion title", { exact: true }).fill("Release decision question");
  await expect(dialog.getByText(/workspace's default discussion board/)).toBeVisible();
  await review(dialog);
  await close(dialog);
  await actor(page, "human");
  await page
    .getByRole("button", { name: "Ask a question · original writer fixture-author", exact: true })
    .click();
  dialog = await editor(page, "Ask a question");
  await expect(
    dialog.getByText("Original writer retained after switch", { exact: true }),
  ).toBeVisible();
  await apply(dialog);
  await close(dialog);
  let current = await native(daemon, "request.get", { request_id: "ui-question" });
  expect(object(current.created).actor_id).toBe("fixture-author");
  const thread = await native(daemon, "thread.get", { thread_id: text(current.thread_id) });
  const board = await native(daemon, "board.get", { board_id: text(thread.board_id) });
  expect(board.scope).toEqual({ kind: "workspace" });
  await requestRoute(page, companion, "ui-question");
  await expect(page.getByRole("heading", { name: "Ship decision", exact: true })).toBeVisible();
  await actor(page, "fixture-author");
  await page.getByRole("button", { name: "Edit request metadata", exact: true }).click();
  dialog = await editor(page, "Edit request metadata");
  await dialog.getByLabel("Priority change", { exact: true }).selectOption("value");
  await dialog.getByLabel("New priority 0–4", { exact: true }).fill("3");
  await dialog.getByLabel("Deadline change", { exact: true }).selectOption("clear");
  await review(dialog);
  await apply(dialog);
  await close(dialog);
  await actor(page, "human");
  for (const label of ["Acknowledge delivery", "Accept responsibility"]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    dialog = await editor(page, label);
    await review(dialog);
    await apply(dialog);
    await close(dialog);
  }
  current = await native(daemon, "request.get", { request_id: "ui-question" });
  expect(object(rows(current.deliveries)[0]?.acknowledged).actor_id).toBe("human");
  expect(object(current.responsibility).kind).toBe("accepted");
  expect(object(current.status).kind).toBe("open");
  expect(current.priority).toBe("3");
  await page.getByRole("button", { name: "Answer and resolve", exact: true }).click();
  dialog = await editor(page, "Answer and resolve");
  await dialog.getByLabel("Answer", { exact: true }).fill("Not my authority");
  await dialog.getByRole("button", { name: "Review", exact: true }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "designated resolver" })).toBeVisible();
  await close(dialog);
  expect(
    object((await native(daemon, "request.get", { request_id: "ui-question" })).status).kind,
  ).toBe("open");
  await page.getByRole("button", { name: "Reply with context", exact: true }).click();
  dialog = await editor(page, "Write reply");
  await dialog.getByLabel("Body", { exact: true }).fill("Recipient context without resolution");
  await dialog.getByRole("button", { name: "Post", exact: true }).click();
  await expect(
    dialog.getByRole("status").filter({ hasText: "Saved action: committed" }),
  ).toBeVisible();
  await close(dialog);
  expect(
    object((await native(daemon, "request.get", { request_id: "ui-question" })).status).kind,
  ).toBe("open");
  await requestRoute(page, companion, "ui-question");
  await actor(page, "fixture-author");
  await page.getByRole("button", { name: "Answer and resolve", exact: true }).click();
  dialog = await editor(page, "Answer and resolve");
  await dialog
    .getByLabel("Answer", { exact: true })
    .fill("Ship the reviewed change with **exact evidence**.");
  await review(dialog);
  await apply(dialog);
  await close(dialog);
  await page
    .locator('section[aria-label="request results"]')
    .getByRole("button", { name: "Refresh current capture", exact: true })
    .click();
  await expect(page.getByText("Ship the reviewed change with", { exact: false })).toBeVisible();
  current = await native(daemon, "request.get", { request_id: "ui-question" });
  expect(object(current.status).kind).toBe("resolved");
  expect(object(current.answer).author_id).toBe("fixture-author");
  await screenshot(page, info, "request-original-author-resolved");
  expect(browserFailures).toEqual([]);
});

test("real routing freezes team delivery, creates attached requests and keeps reassignment/cancellation separate", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  await write("run.register", {
    target_run_id: "recipient-run",
    objective: "Synthetic recipient run",
    capabilities: [],
  });
  await mount(page, companion, daemon);
  await page.getByRole("button", { name: "Routing", exact: true }).click();
  await page.getByRole("button", { name: "Create team", exact: true }).click();
  let dialog = await editor(page, "Team configuration");
  await dialog.getByLabel("Team ID", { exact: true }).fill("ui-team");
  await dialog.getByLabel("Team title", { exact: true }).fill("Delivery reviewers");
  await dialog.getByRole("button", { name: "Add team members", exact: true }).click();
  await dialog.getByLabel("Team members 1 ID", { exact: true }).fill("human");
  await dialog.getByRole("button", { name: "Add team members", exact: true }).click();
  await dialog.getByLabel("Team members 2 kind", { exact: true }).selectOption("run");
  await dialog.getByLabel("Team members 2 ID", { exact: true }).fill("recipient-run");
  await review(dialog);
  await apply(dialog);
  await close(dialog);
  const thread = await native(daemon, "thread.get", { thread_id: "planning" });
  const commentIds = thread.comment_ids;
  if (!Array.isArray(commentIds)) throw new Error("Thread comments");
  const commentId = text(commentIds[0]);
  await page.getByRole("button", { name: "Requests", exact: true }).click();
  await page.getByRole("button", { name: "Create from attached comment", exact: true }).click();
  dialog = await editor(page, "Create request from attached comment");
  await dialog.getByLabel("Discussion ID", { exact: true }).fill("planning");
  await dialog.getByLabel("Attached question comment ID", { exact: true }).fill(commentId);
  await dialog.getByLabel("Team IDs, one per line", { exact: true }).fill("ui-team");
  await dialog.getByText("Priority, deadline and related requests", { exact: true }).click();
  await dialog.getByLabel("Request ID", { exact: true }).fill("ui-attached");
  await review(dialog);
  await apply(dialog);
  await close(dialog);
  let current = await native(daemon, "request.get", { request_id: "ui-attached" });
  expect(rows(current.deliveries).map((item) => item.recipient)).toEqual([
    { kind: "actor", id: "human" },
    { kind: "run", id: "recipient-run" },
  ]);
  await page.getByRole("button", { name: "Routing", exact: true }).click();
  await page.getByRole("button", { name: "Edit team ui-team", exact: true }).click();
  dialog = await editor(page, "Team configuration");
  await dialog.getByRole("button", { name: "Remove recipient 2", exact: true }).click();
  await dialog.getByRole("button", { name: "Remove recipient 1", exact: true }).click();
  await review(dialog);
  await apply(dialog);
  await close(dialog);
  expect((await native(daemon, "team.get", { team_id: "ui-team" })).members).toEqual([]);
  expect(
    rows((await native(daemon, "request.get", { request_id: "ui-attached" })).deliveries),
  ).toHaveLength(2);
  await actor(page, "human");
  await page.getByRole("button", { name: "Create subscription", exact: true }).click();
  dialog = await editor(page, "Subscription configuration");
  await dialog.getByLabel("Subscription ID", { exact: true }).fill("ui-sub");
  await dialog.getByLabel("Subscription scope", { exact: true }).selectOption("project");
  await dialog.getByLabel("Subscription project ID", { exact: true }).fill("release");
  await dialog.getByLabel("request created", { exact: true }).check();
  await review(dialog);
  await apply(dialog);
  await close(dialog);
  expect(
    object((await native(daemon, "subscription.get", { subscription_id: "ui-sub" })).recipient),
  ).toEqual({ kind: "actor", id: "human" });
  await page
    .locator('section[aria-label="subscriptions results"]')
    .getByRole("button", { name: "Refresh current capture", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit subscription ui-sub", exact: true }).click();
  dialog = await editor(page, "Subscription configuration");
  await dialog.getByLabel("Active for future notifications", { exact: true }).uncheck();
  await review(dialog);
  await apply(dialog);
  await close(dialog);
  expect((await native(daemon, "subscription.get", { subscription_id: "ui-sub" })).active).toBe(
    false,
  );
  await actor(page, "fixture-author");
  await requestRoute(page, companion, "ui-attached");
  await page.getByRole("button", { name: "Reassign responsibility", exact: true }).click();
  dialog = await editor(page, "Reassign responsibility");
  await dialog.getByLabel("Clear accepted responsibility", { exact: true }).uncheck();
  await dialog.getByLabel("New responsible recipient kind", { exact: true }).selectOption("run");
  await dialog.getByLabel("New responsible recipient ID", { exact: true }).fill("recipient-run");
  await review(dialog);
  await apply(dialog);
  await close(dialog);
  current = await native(daemon, "request.get", { request_id: "ui-attached" });
  expect(object(object(current.responsibility).recipient)).toEqual({
    kind: "run",
    id: "recipient-run",
  });
  await page.getByRole("button", { name: "Cancel request", exact: true }).click();
  dialog = await editor(page, "Cancel request");
  await review(dialog);
  await apply(dialog);
  await close(dialog);
  current = await native(daemon, "request.get", { request_id: "ui-attached" });
  expect(object(current.status).kind).toBe("cancelled");
  expect(current.resolver_id).toBe("fixture-author");
  await screenshot(page, info, "routing-frozen-deliveries");
  expect(browserFailures).toEqual([]);
});

test("historical request links traverse separate captures and retain exact original bodies after edits", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  await question(daemon, write, "ui-history", "Original **immutable question**");
  for (let revision = 1; revision < 29; revision++)
    await write("request.metadata", {
      request_id: "ui-history",
      expected_revision: String(revision),
      priority: String(revision % 5),
    });
  await write("request.resolve", {
    request_id: "ui-history",
    expected_revision: "29",
    body: "Original **immutable answer**",
  });
  const current = await native(daemon, "request.get", { request_id: "ui-history" }),
    questionId = text(current.comment_id),
    answerId = text(object(object(current.status).answer).comment_id);
  await write("comment.edit", {
    comment_id: questionId,
    expected_revision: "1",
    body: "Later current question must not replace the pin",
  });
  await write("comment.edit", {
    comment_id: answerId,
    expected_revision: "1",
    body: "Later current answer must not replace the pin",
  });
  await mount(
    page,
    companion,
    daemon,
    "#/discussions?connection=local&workspace=demo&project=release&req_view=request&req_generation=1&req_id=ui-history&req_revision=29",
  );
  await expect(
    page.getByRole("article", { name: "Request ui-history revision 29", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("immutable question", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Later current question must not replace the pin", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Answer and resolve", exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Open current request", exact: true }),
  ).toBeVisible();
  const readCalls: unknown[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/ui-api/v1/read")) readCalls.push(request.postData());
  });
  await requestRoute(page, companion, "ui-history", "30");
  await page.getByRole("button", { name: "Load original answer", exact: true }).click();
  await expect(page.getByText("immutable answer", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Later current answer must not replace the pin", { exact: true }),
  ).toHaveCount(0);
  await screenshot(page, info, "request-exact-historical-answer");
  await page.getByRole("button", { name: "Open current request", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "Request ui-history revision 30", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Question", exact: true })).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("button", { name: "Load original answer", exact: true }),
  ).toBeVisible();
  await info.attach("actual-history-read-requests", {
    contentType: "application/json",
    body: JSON.stringify(readCalls, null, 2),
  });
  expect(browserFailures).toEqual([]);
});

test("actionable Inbox keeps recipient and consumer isolated through actor switches and explicit waits", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  await question(daemon, write, "ui-inbox-question", "Inbox **causal body**");
  await mount(page, companion, daemon);
  await actor(page, "human");
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await page.getByRole("button", { name: "Use current actor as recipient", exact: true }).click();
  await page.getByText("Consumer, interval and Inbox filters", { exact: true }).click();
  await page.getByLabel("Inbox consumer ID", { exact: true }).fill("ui-inbox-isolated");
  await page.getByLabel("request created", { exact: true }).check();
  await page
    .getByRole("button", { name: "Wait once for notifications (up to 25 seconds)", exact: true })
    .click();
  await page
    .getByRole("article", { name: /Notification [0-9]+/ })
    .first()
    .scrollIntoViewIfNeeded();
  await expect(page.getByText("causal body", { exact: true })).toBeVisible();
  const original = await native(daemon, "inbox.read", {
      consumer_id: "ui-inbox-isolated",
      recipient: { kind: "actor", id: "human" },
      after: "0",
      kinds: ["request_created"],
      limit: "100",
    }),
    notification = rows(original.items).find(
      (item) => object(item.source).id === "ui-inbox-question",
    );
  if (notification === undefined) throw new Error("Causal request notification");
  const notificationId = text(notification.notification_id);
  await page.getByLabel(`Select notification ${notificationId}`, { exact: true }).check();
  await page
    .getByRole("button", { name: "Acknowledge selected for this consumer", exact: true })
    .click();
  let dialog = await editor(page, "Acknowledge selected notifications");
  await review(dialog);
  await close(dialog);
  await actor(page, "fixture-author");
  await expect(page.getByLabel("Inbox recipient ID", { exact: true })).toHaveValue("human");
  await page
    .getByRole("button", {
      name: "Acknowledge selected notifications · original writer human",
      exact: true,
    })
    .click();
  dialog = await editor(page, "Acknowledge selected notifications");
  await expect(
    dialog.getByText("Original writer retained after switch", { exact: true }),
  ).toBeVisible();
  await apply(dialog);
  await close(dialog);
  const remaining = await native(daemon, "inbox.read", {
      consumer_id: "ui-inbox-isolated",
      recipient: { kind: "actor", id: "human" },
      after: "0",
      kinds: ["request_created"],
      limit: "100",
    }),
    independent = await native(daemon, "inbox.read", {
      consumer_id: "ui-inbox-other",
      recipient: { kind: "actor", id: "human" },
      after: "0",
      kinds: ["request_created"],
      limit: "100",
    });
  expect(rows(remaining.items).some((item) => item.notification_id === notificationId)).toBe(false);
  expect(rows(independent.items).some((item) => item.notification_id === notificationId)).toBe(
    true,
  );
  const request = await native(daemon, "request.get", { request_id: "ui-inbox-question" });
  expect(rows(request.deliveries)[0]?.acknowledged).toBeNull();
  expect(object(request.responsibility).kind).toBe("unaccepted");
  expect(object(request.status).kind).toBe("open");
  await page
    .getByRole("button", { name: "Keep captured notification link", exact: true })
    .first()
    .click();
  await expect(
    page.getByText(/original recipient, consumer, filters and through boundary/),
  ).toBeVisible();
  await expect(page.getByLabel("Inbox recipient ID", { exact: true })).toHaveValue("human");
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: `Selected notification ${notificationId} is unavailable` }),
  ).toBeVisible();
  await expect(
    page.getByRole("article", { name: `Notification ${notificationId}`, exact: true }),
  ).toHaveCount(0);
  await screenshot(page, info, "inbox-explicit-consumer-original-recipient");
  expect(browserFailures).toEqual([]);
});

test("Requests preserve draft/project history, reject stale guards and keep same-ID endpoint generations separate", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const other = await startDaemonFixture({ binary: fixtureBinary() }),
    write = writer(daemon),
    otherWrite = writer(other);
  try {
    await question(daemon, write, "same-request", "First daemon original question");
    await question(other, otherWrite, "same-request", "Second daemon different question");
    await write("project.create", { project_id: "second-project", title: "Second project" });
    await mount(page, companion, daemon);
    await page.getByRole("button", { name: "Ask a question", exact: true }).click();
    let dialog = await editor(page, "Ask a question");
    await dialog
      .getByLabel("Question", { exact: true })
      .fill("Unsent question retained through project navigation");
    await close(dialog);
    const scopedRead = page.waitForResponse(
      (response) =>
        response.url().endsWith("/ui-api/v1/read") &&
        response.request().postData()?.includes('"id":"second-project"') === true,
    );
    await go(
      page,
      companion,
      "#/discussions?connection=local&workspace=demo&project=second-project&req_view=requests&req_generation=1",
    );
    await (await scopedRead).finished();
    await page.goBack();
    await page
      .getByRole("button", { name: "Ask a question · original writer fixture-author", exact: true })
      .click();
    dialog = await editor(page, "Ask a question");
    await expect(dialog.getByLabel("Question", { exact: true })).toHaveValue(
      "Unsent question retained through project navigation",
    );
    await close(dialog);
    await requestRoute(page, companion, "same-request");
    await page.getByRole("button", { name: "Edit request metadata", exact: true }).click();
    dialog = await editor(page, "Edit request metadata");
    await dialog.getByLabel("Priority change", { exact: true }).selectOption("value");
    await dialog.getByLabel("New priority 0–4", { exact: true }).fill("3");
    await review(dialog);
    await write("request.metadata", {
      request_id: "same-request",
      expected_revision: "1",
      priority: "4",
    });
    await dialog.getByRole("button", { name: "Apply captured action", exact: true }).click();
    await expect(
      dialog.getByRole("status").filter({ hasText: "Saved action: rejected" }),
    ).toBeVisible();
    expect((await native(daemon, "request.get", { request_id: "same-request" })).priority).toBe(
      "4",
    );
    await close(dialog);
    await metadata(
      page,
      companion,
      "/connections/local",
      { expected_generation: "1", label: "Second endpoint", socket: other.socket },
      "PUT",
    );
    await metadata(page, companion, "/connections/local/attach", { generation: "2" });
    await page.locator(".wg-workspace-switch").click();
    const manager = page.getByRole("dialog", { name: "Daemon connections", exact: true });
    await manager.getByRole("button", { name: "Refresh profiles", exact: true }).click();
    await expect(manager.getByText(/local · generation 2/u)).toBeVisible();
    await manager.getByRole("button", { name: "Close Daemon connections", exact: true }).click();
    await requestRoute(page, companion, "same-request", null, "1");
    await expect(page.getByText("First daemon original question", { exact: true })).toBeVisible();
    await expect(page.getByText("Second daemon different question", { exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByText(/Retained endpoint generation 1/)).toBeVisible();
    await page.getByRole("button", { name: "Ask a question", exact: true }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "retained endpoint view" }),
    ).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Ask a question", exact: true })).toHaveCount(0);
    await requestRoute(page, companion, "same-request", null, "2");
    await expect(page.getByText("Second daemon different question", { exact: true })).toBeVisible();
    await expect(page.getByText("First daemon original question", { exact: true })).toHaveCount(0);
    await screenshot(page, info, "requests-same-id-distinct-generation");
    expect(browserFailures).toEqual([]);
  } finally {
    await other.dispose();
  }
});

test("inline request answers preserve their author through actor switches and update the live detail", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  await question(daemon, write, "inline-answer", "Keep **this original question** intact.");
  await mount(page, companion, daemon);
  await requestRoute(page, companion, "inline-answer");
  await expect(page.locator(".rq-message .wg-rich-content").first()).toBeVisible();
  const answer = page.getByRole("textbox", { name: "Answer to request", exact: true });
  await answer.fill("The reviewed answer retains its original writer.");
  await actor(page, "human");
  await expect(answer).toHaveValue("The reviewed answer retains its original writer.");
  await expect(page.locator(".dc-writer-warning")).toContainText("Original author retained");
  await page.getByRole("button", { name: "Review answer & resolve", exact: true }).click();
  const dialog = await editor(page, "Answer and resolve");
  await expect(
    dialog.getByRole("button", { name: "Apply captured action", exact: true }),
  ).toBeEnabled();
  await apply(dialog);
  await close(dialog);
  await expect(page.locator(".rq-responsibility")).toContainText("This request is resolved");
  await expect(page.locator(".rq-answer")).toContainText(
    "The reviewed answer retains its original writer.",
  );
  await expect(page.locator(".rq-answer")).toContainText("fixture-author");
  const result = await native(daemon, "request.get", { request_id: "inline-answer" });
  expect(object(result.status).kind).toBe("resolved");
  expect(object(result.answer).author_id).toBe("fixture-author");
  expect(object(result.question).body).toBe("Keep **this original question** intact.");
  await page.setViewportSize({ width: 760, height: 1000 });
  await expect(page.locator(".rq-detail")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "← All requests", exact: true }).click();
  await expect(page.locator(".rq-collection")).toBeVisible();
  await page.goBack();
  await expect(page.locator(".rq-responsibility")).toContainText("This request is resolved");
  await screenshot(page, info, "inline-answer-narrow");
  expect(browserFailures).toEqual([]);
});

test("live Inbox keeps checked notifications and expanded sources until explicit acknowledgement", async ({
  page,
  daemon,
  companion,
  browserFailures,
}) => {
  const write = writer(daemon);
  await question(daemon, write, "live-inbox-first", "The first retained notification");
  await mount(page, companion, daemon);
  await actor(page, "human");
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await page.getByRole("button", { name: "Use current actor as recipient", exact: true }).click();
  // The initial no-kinds-selected UI means all, not the native empty-kind set.
  await page.getByRole("button", { name: "Read Inbox", exact: true }).click();
  await expect(page.locator(".rq-notification").first()).toBeVisible();
  await page.getByText("Consumer, interval and Inbox filters", { exact: true }).click();
  await page.getByLabel("Inbox consumer ID", { exact: true }).fill("live-selection-consumer");
  await page.getByLabel("request created", { exact: true }).check();
  await page.getByRole("button", { name: "Read Inbox", exact: true }).click();
  const query = {
    consumer_id: "live-selection-consumer",
    recipient: { kind: "actor", id: "human" },
    after: "0",
    kinds: ["request_created"],
  };
  const initial = await native(daemon, "inbox.read", query);
  const item = rows(initial.items).find((item) => object(item.source).id === "live-inbox-first");
  if (!item) throw new Error("Missing seeded notification");
  const notificationId = text(item.notification_id);
  const notification = page.getByRole("article", {
    name: `Notification ${notificationId}`,
    exact: true,
  });
  const checkbox = notification.getByLabel(`Select notification ${notificationId}`, {
    exact: true,
  });
  await checkbox.check();
  await notification.getByText("Notification source and consumer", { exact: true }).click();
  await expect(notification.locator(":scope > details")).toHaveAttribute("open", "");
  await notification.evaluate((element) => element.setAttribute("data-retained-test", "original"));
  await question(daemon, write, "live-inbox-second", "A newer live notification");
  const updated = await native(daemon, "inbox.read", query);
  const newest = rows(updated.items).find((item) => object(item.source).id === "live-inbox-second");
  if (!newest) throw new Error("Missing newer notification");
  const newCard = page.getByRole("article", {
    name: `Notification ${text(newest.notification_id)}`,
    exact: true,
  });
  await expect(newCard).toHaveCount(1);
  await newCard.scrollIntoViewIfNeeded();
  await expect(newCard).toContainText("A newer live notification");
  await expect(checkbox).toBeChecked();
  await expect(notification.locator(":scope > details")).toHaveAttribute("open", "");
  await expect(notification).toHaveAttribute("data-retained-test", "original");
  const beforeAck = await native(daemon, "inbox.read", query);
  expect(rows(beforeAck.items).some((item) => item.notification_id === notificationId)).toBe(true);
  await page
    .getByRole("button", { name: "Acknowledge selected for this consumer", exact: true })
    .click();
  const dialog = await editor(page, "Acknowledge selected notifications");
  await review(dialog);
  await apply(dialog);
  await close(dialog);
  await expect(notification).toHaveCount(0);
  const afterAck = await native(daemon, "inbox.read", query);
  expect(rows(afterAck.items).some((item) => item.notification_id === notificationId)).toBe(false);
  const independent = await native(daemon, "inbox.read", {
    ...query,
    consumer_id: "other-consumer",
  });
  expect(rows(independent.items).some((item) => item.notification_id === notificationId)).toBe(
    true,
  );
  const request = await native(daemon, "request.get", { request_id: "live-inbox-first" });
  expect(rows(request.deliveries)[0]?.acknowledged).toBeNull();
  expect(object(request.responsibility).kind).toBe("unaccepted");
  expect(object(request.status).kind).toBe("open");
  expect(browserFailures).toEqual([]);
});

test("routing edits preserve native recipients and support all nine notification kinds", async ({
  page,
  daemon,
  companion,
  browserFailures,
}) => {
  await mount(page, companion, daemon);
  await page.getByRole("button", { name: "Routing", exact: true }).click();
  await page.getByRole("button", { name: "Create team", exact: true }).click();
  let dialog = await editor(page, "Team configuration");
  await dialog.getByLabel("Team ID", { exact: true }).fill("routing-design-team");
  await dialog.getByLabel("Team title", { exact: true }).fill("Design reviewers");
  await dialog.getByRole("button", { name: "Add team members", exact: true }).click();
  await dialog.getByLabel("Team members 1 ID", { exact: true }).fill("human");
  await review(dialog);
  await apply(dialog);
  await close(dialog);
  await expect(
    page.locator(".rq-routing-card").filter({ hasText: "Design reviewers" }),
  ).toBeVisible();
  expect((await native(daemon, "team.get", { team_id: "routing-design-team" })).members).toEqual([
    { kind: "actor", id: "human" },
  ]);
  await page.getByRole("button", { name: "Create subscription", exact: true }).click();
  dialog = await editor(page, "Subscription configuration");
  await dialog.getByLabel("Subscription ID", { exact: true }).fill("routing-all-kinds");
  const kinds = [
    "thread_changed",
    "message_received",
    "request_created",
    "request_acknowledged",
    "request_accepted",
    "request_reassigned",
    "request_resolved",
    "request_cancelled",
    "request_updated",
  ];
  for (const kind of kinds)
    await dialog.getByLabel(kind.replaceAll("_", " "), { exact: true }).check();
  await review(dialog);
  await apply(dialog);
  await close(dialog);
  const created = await native(daemon, "subscription.get", {
    subscription_id: "routing-all-kinds",
  });
  expect(object(created.filter).kinds).toEqual([...kinds].sort());
  expect(created.recipient).toEqual({ kind: "actor", id: "fixture-author" });
  await page
    .getByRole("button", { name: "Edit subscription routing-all-kinds", exact: true })
    .click();
  dialog = await editor(page, "Subscription configuration");
  await dialog.getByLabel("Active for future notifications", { exact: true }).uncheck();
  await review(dialog);
  await apply(dialog);
  await close(dialog);
  const updated = await native(daemon, "subscription.get", {
    subscription_id: "routing-all-kinds",
  });
  expect(updated.active).toBe(false);
  expect(updated.recipient).toEqual(created.recipient);
  expect(object(updated.filter).kinds).toEqual([...kinds].sort());
  expect(browserFailures).toEqual([]);
});

test("reference search selection closes the picker and visibly retains the chosen ID", async ({
  page,
  daemon,
  companion,
}) => {
  await mount(page, companion, daemon);
  await page.getByRole("button", { name: "Ask a question", exact: true }).click();
  const dialog = await editor(page, "Ask a question");
  await dialog.getByLabel("Question", { exact: true }).fill("Keep my unsent question.");
  const trigger = dialog.getByRole("button", { name: "Linked ticket ID (optional)", exact: true });
  await trigger.click();
  const choices = dialog.getByRole("region", { name: "Choose ticket", exact: true });
  await choices.getByLabel("Search tickets", { exact: true }).fill("Unicode");
  await choices
    .locator("[data-reference-option]")
    .filter({ hasText: "Implement the interface" })
    .click();
  await expect(choices).toHaveCount(0);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toContainText("Implement the interface");
  await expect(trigger).toContainText("build");
  await trigger.click();
  await expect(choices.locator('[data-reference-option][aria-pressed="true"]')).toContainText(
    "build",
  );
  await choices.getByLabel("Search tickets", { exact: true }).press("Escape");
  await expect(dialog).toBeVisible();
  await expect(choices).toHaveCount(0);
  await trigger.click();
  await choices.getByLabel("Search tickets", { exact: true }).fill("Clarify");
  await choices.getByLabel("Search tickets", { exact: true }).press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(choices).toHaveCount(0);
  await expect(trigger).toContainText("design");
  await expect(dialog.getByLabel("Question", { exact: true })).toHaveValue(
    "Keep my unsent question.",
  );
});
