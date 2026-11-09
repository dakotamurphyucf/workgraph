import { test as base, expect, type Page, type Request } from "@playwright/test";
import {
  startDaemonFixture,
  fixtureBinary,
  type DaemonFixture,
} from "../../../../test-support/daemon-fixture.mjs";
import {
  startCompanionFixture,
  companionBinary,
  type CompanionFixture,
} from "../../../../test-support/companion-fixture.mjs";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected native object");
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected native text");
  return value;
}
const test = base.extend<{
  daemon: DaemonFixture;
  companion: CompanionFixture;
  diagnostics: { markWait: () => void; failures: string[] };
}>({
  // eslint-disable-next-line no-empty-pattern
  daemon: async ({}, runTest, info) => {
    const daemon = await startDaemonFixture({ binary: fixtureBinary() });
    try {
      await runTest(daemon);
    } finally {
      await daemon.dispose();
      await info.attach("daemon-cleanup", {
        contentType: "application/json",
        body: JSON.stringify(daemon.diagnostics()),
      });
    }
  },
  // eslint-disable-next-line no-empty-pattern
  companion: async ({}, runTest, info) => {
    const companion = await startCompanionFixture({ binary: companionBinary() });
    try {
      await runTest(companion);
    } finally {
      await companion.dispose();
      await info.attach("companion-cleanup", {
        contentType: "application/json",
        body: JSON.stringify(companion.diagnostics()),
      });
    }
  },
  diagnostics: [
    async ({ page, companion }, runTest, info) => {
      const active = new Set<Request>(),
        allowed = new Set<Request>(),
        failures: string[] = [],
        cancellations: unknown[] = [];
      const origin = new URL(companion.url).origin,
        waitURL = new URL("/ui-api/v1/request-waits", origin).href;
      page.on("request", (request) => {
        active.add(request);
        if (new URL(request.url()).origin !== origin) failures.push(`external:${request.url()}`);
      });
      page.on("requestfinished", (request) => active.delete(request));
      page.on("requestfailed", (request) => {
        active.delete(request);
        const error = request.failure()?.errorText;
        const expected = allowed.delete(request) && error === "net::ERR_ABORTED";
        cancellations.push({ url: request.url(), method: request.method(), error, expected });
        if (!expected) failures.push(`requestfailed:${request.method()}:${request.url()}:${error}`);
      });
      page.on("pageerror", (error) => failures.push(`pageerror:${error.message}`));
      page.on("console", (message) => {
        if (message.type() === "error") failures.push(`console:${message.text()}`);
      });
      await runTest({
        failures,
        markWait() {
          for (const request of active)
            if (request.method() === "POST" && request.url() === waitURL) allowed.add(request);
        },
      });
      for (const request of active)
        if (
          request.method() === "POST" &&
          [waitURL, new URL("/ui-api/v1/read", origin).href].includes(request.url())
        )
          allowed.add(request);
      await page.close();
      await info.attach("strict-diagnostics", {
        contentType: "application/json",
        body: JSON.stringify({ failures, cancellations }),
      });
      expect(failures).toEqual([]);
    },
    { auto: true },
  ],
});
test.use({ colorScheme: "dark", viewport: { width: 1440, height: 1000 }, actionTimeout: 10000 });
test.setTimeout(60000);
async function native(
  daemon: DaemonFixture,
  method: string,
  params: ObjectValue,
): Promise<ObjectValue> {
  const result = object(
    JSON.parse(await daemon.call(method, JSON.stringify({ workspace_id: "demo", ...params }))),
  );
  if (result.error !== undefined) throw new Error(JSON.stringify(result.error));
  return object(object(result.result).data);
}
function writer(daemon: DaemonFixture) {
  let serial = 0;
  return (method: string, params: ObjectValue) =>
    native(daemon, method, {
      actor_id: "fixture-author",
      mutation_id: `foreground-wait-${++serial}`,
      ...params,
    });
}
async function setup(
  page: Page,
  companion: CompanionFixture,
  daemon: DaemonFixture,
  id = "foreground",
) {
  const write = writer(daemon),
    thread = await native(daemon, "thread.get", { thread_id: "planning" });
  await write("request.ask", {
    request_id: id,
    kind: "clarification",
    resolver_id: "fixture-author",
    recipients: [{ kind: "actor", id: "human" }],
    thread_id: "planning",
    expected_thread_revision: text(thread.revision),
    body: "Read-only foreground question",
  });
  const html = await (await page.request.get(companion.url)).text(),
    capability = /<meta name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(html)?.[1];
  if (capability === undefined) throw new Error("Missing bootstrap capability");
  const response = await page.request.post(new URL("/ui-api/v1/connections", companion.url).href, {
    headers: { Origin: new URL(companion.url).origin, "X-Workgraph-UI-Capability": capability },
    data: { id: "local", label: "Foreground wait qualification", socket: daemon.socket },
  });
  expect(response.status()).toBe(200);
  await page.goto(
    new URL(
      `/#/discussions?connection=local&workspace=demo&project=release&req_view=request&req_generation=1&req_id=${id}`,
      companion.url,
    ).href,
  );
  const panel = page.getByRole("region", { name: "Foreground request wait", exact: true });
  await expect(panel).toBeVisible();
  return { panel, write };
}

test("explicit foreground wait observes another client resolving and retains the exact pinned answer", async ({
  page,
  daemon,
  companion,
}, info) => {
  const { panel, write } = await setup(page, companion, daemon);
  const request = await native(daemon, "request.get", { request_id: "foreground" });
  await panel.getByLabel("Wait poll interval milliseconds").fill("250");
  await panel.getByRole("button", { name: "Start wait", exact: true }).click();
  await expect(
    panel.getByText("Waiting for this captured request…", { exact: true }),
  ).toBeVisible();
  await write("request.resolve", {
    request_id: "foreground",
    expected_revision: text(request.revision),
    body: "Original **pinned answer** from another client",
  });
  await expect(panel.getByText("Resolved with a pinned answer.", { exact: true })).toBeVisible();
  await expect(panel.getByText("pinned answer", { exact: true })).toBeVisible();
  const resolved = await native(daemon, "request.get", { request_id: "foreground" }),
    answer = object(resolved.answer);
  await write("comment.edit", {
    comment_id: text(answer.comment_id),
    expected_revision: text(answer.revision),
    body: "Later current comment must not replace pinned answer",
  });
  await expect(panel.getByText("pinned answer", { exact: true })).toBeVisible();
  await expect(panel.getByText("Later current comment", { exact: false })).toHaveCount(0);
  const nativePinned = await native(daemon, "request.get", { request_id: "foreground" });
  expect(object(nativePinned.answer).body).toBe("Original **pinned answer** from another client");
  await panel.screenshot({ path: info.outputPath("foreground-pinned-answer.png") });
});

test("Stop and deadline are read-only and never acknowledge delivery or resolve a request", async ({
  page,
  daemon,
  companion,
  diagnostics,
}, info) => {
  const { panel } = await setup(page, companion, daemon),
    before = await native(daemon, "request.get", { request_id: "foreground" });
  await panel.getByLabel("Wait total milliseconds").fill("1000");
  await panel.getByRole("button", { name: "Start wait", exact: true }).click();
  await expect(panel.getByText("Wait deadline reached.", { exact: false })).toBeVisible();
  await panel.getByLabel("Wait total milliseconds").fill("300000");
  await panel.getByLabel("Wait poll interval milliseconds").fill("25000");
  const sent = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().endsWith("/ui-api/v1/request-waits"),
  );
  await panel.getByRole("button", { name: "Start wait", exact: true }).click();
  await sent;
  await expect(
    panel.getByText("Waiting for this captured request…", { exact: true }),
  ).toBeVisible();
  diagnostics.markWait();
  await panel.getByRole("button", { name: "Stop waiting", exact: true }).click();
  await expect(
    panel.getByText("Wait stopped locally. The request was not changed.", { exact: true }),
  ).toBeVisible();
  expect(await native(daemon, "request.get", { request_id: "foreground" })).toEqual(before);
  await panel.getByLabel("Wait total milliseconds").fill("999");
  await panel.getByRole("button", { name: "Start wait", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("1000..300000");
  await panel.screenshot({ path: info.outputPath("foreground-stop-deadline.png") });
});

async function spa(page: Page, target: string, requestId: string) {
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, target.slice(1));
  await expect(
    page.getByRole("article", { name: new RegExp(`^Request ${requestId} revision `) }),
  ).toBeVisible();
}

test("nullable resolution and daemon cancellation remain distinct native outcomes", async ({
  page,
  daemon,
  companion,
}, info) => {
  const { panel, write } = await setup(page, companion, daemon),
    request = await native(daemon, "request.get", { request_id: "foreground" });
  await write("request.resolve", {
    request_id: "foreground",
    expected_revision: text(request.revision),
  });
  await panel.getByRole("button", { name: "Start wait", exact: true }).click();
  await expect(panel.getByText("Resolved without an answer.", { exact: true })).toBeVisible();
  const thread = await native(daemon, "thread.get", { thread_id: "planning" });
  await write("request.ask", {
    request_id: "cancelled-question",
    kind: "clarification",
    resolver_id: "fixture-author",
    recipients: [{ kind: "actor", id: "human" }],
    thread_id: "planning",
    expected_thread_revision: text(thread.revision),
    body: "Cancelled request",
  });
  const open = await native(daemon, "request.get", { request_id: "cancelled-question" });
  await write("request.cancel", {
    request_id: "cancelled-question",
    expected_revision: text(open.revision),
  });
  await spa(
    page,
    "/#/discussions?connection=local&workspace=demo&req_view=request&req_generation=1&req_id=cancelled-question",
    "cancelled-question",
  );
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Start wait", exact: true }).click();
  await expect(panel.getByText("The request was cancelled.", { exact: true })).toBeVisible();
  await panel.screenshot({ path: info.outputPath("foreground-native-cancelled.png") });
});

test("navigation stops the captured foreground read and never shows its prior answer under another request", async ({
  page,
  daemon,
  companion,
  diagnostics,
}, info) => {
  let documents = 0;
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.resourceType() === "document") documents++;
  });
  const { panel, write } = await setup(page, companion, daemon),
    original = await native(daemon, "request.get", { request_id: "foreground" });
  await write("request.resolve", {
    request_id: "foreground",
    expected_revision: text(original.revision),
    body: "Only the original request owns this answer",
  });
  await panel.getByRole("button", { name: "Start wait", exact: true }).click();
  await expect(panel.getByText("Resolved with a pinned answer.", { exact: true })).toBeVisible();
  const thread = await native(daemon, "thread.get", { thread_id: "planning" });
  await write("request.ask", {
    request_id: "other-request",
    kind: "clarification",
    resolver_id: "fixture-author",
    recipients: [{ kind: "actor", id: "human" }],
    thread_id: "planning",
    expected_thread_revision: text(thread.revision),
    body: "Different captured question",
  });
  await spa(
    page,
    "/#/discussions?connection=local&workspace=demo&req_view=request&req_generation=1&req_id=other-request",
    "other-request",
  );
  await expect(panel).toBeVisible();
  await expect(
    panel.getByText("Only the original request owns this answer", { exact: true }),
  ).toHaveCount(0);
  await spa(
    page,
    "/#/discussions?connection=local&workspace=demo&req_view=request&req_generation=1&req_id=foreground",
    "foreground",
  );
  await panel.locator(".wg-discussion-body").scrollIntoViewIfNeeded();
  await expect(
    panel.getByText("Only the original request owns this answer", { exact: true }),
  ).toBeVisible();
  await spa(
    page,
    "/#/discussions?connection=local&workspace=demo&req_view=request&req_generation=1&req_id=other-request",
    "other-request",
  );
  await expect(
    panel.getByText("Only the original request owns this answer", { exact: true }),
  ).toHaveCount(0);
  const before = await native(daemon, "request.get", { request_id: "other-request" });
  await panel.getByLabel("Wait total milliseconds").fill("300000");
  await panel.getByLabel("Wait poll interval milliseconds").fill("25000");
  const sent = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().endsWith("/ui-api/v1/request-waits"),
  );
  await panel.getByRole("button", { name: "Start wait", exact: true }).click();
  await sent;
  await expect(
    panel.getByText("Waiting for this captured request…", { exact: true }),
  ).toBeVisible();
  diagnostics.markWait();
  await spa(
    page,
    "/#/discussions?connection=local&workspace=demo&req_view=request&req_generation=1&req_id=foreground",
    "foreground",
  );
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Waiting for this captured request…", { exact: true })).toHaveCount(
    0,
  );
  expect(await native(daemon, "request.get", { request_id: "other-request" })).toEqual(before);
  await spa(
    page,
    `/#/discussions?connection=local&workspace=demo&req_view=request&req_generation=1&req_id=foreground&req_revision=${text(original.revision)}`,
    "foreground",
  );
  await expect(
    page.getByText(`historical revision ${text(original.revision)}`, { exact: false }),
  ).toBeVisible();
  await expect(panel).toHaveCount(0);
  expect(documents).toBe(1);
  await page.screenshot({
    path: info.outputPath("foreground-historical-read-only.png"),
    fullPage: true,
  });
});
