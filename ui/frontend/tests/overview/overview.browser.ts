import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import { test as parityTest, type Page } from "@playwright/test";
import { test, expect } from "../e2e/support/fixtures";
import {
  fixtureBinary,
  startDaemonFixture,
  type DaemonFixture,
} from "../../../test-support/daemon-fixture.mjs";
import type { CompanionFixture } from "../../../test-support/companion-fixture.mjs";
import { stringifyJson } from "../../src/core/json";
import * as d from "../../src/core/protocol/decoders";
import type { OverviewScope } from "../../src/features/overview/types";
import {
  attentionInvocation,
  coordinationInvocation,
  defaultAttention,
  defaultDigest,
  digestInvocation,
  summaryInvocation,
} from "../../src/features/overview/model";
const execute = promisify(execFile);
test.use({ viewport: { width: 1400, height: 850 }, colorScheme: "dark", actionTimeout: 10000 });
test.setTimeout(90000);
type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("native object");
  return Object.fromEntries(Object.entries(value));
}
function array(value: unknown): readonly RecordValue[] {
  if (!Array.isArray(value)) throw new Error("native rows");
  return value.map(object);
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("native text");
  return value;
}
function writer(daemon: DaemonFixture) {
  let n = 0;
  const ajv = new Ajv2020({ strict: false }),
    schemas = new Map<string, ReturnType<Ajv2020["compile"]>>();
  return async (method: string, params: RecordValue) => {
    const captured = {
      workspace_id: "demo",
      actor_id: "fixture-author",
      mutation_id: `overview-${++n}`,
      ...params,
    };
    let validate = schemas.get(method);
    if (validate === undefined) {
      const catalog = object(
          JSON.parse(
            (await execute(daemon.binary, ["schema", method], { maxBuffer: 2 ** 24 })).stdout,
          ),
        ),
        definition = array(catalog.methods).find((value) => value.name === method);
      if (definition === undefined) throw new Error("Missing fixture method schema");
      validate = ajv.compile(object(definition.params));
      schemas.set(method, validate);
    }
    expect(validate(captured), JSON.stringify(validate.errors)).toBe(true);
    const reply = object(JSON.parse(await daemon.call(method, JSON.stringify(captured))));
    if (reply.error !== undefined) throw new Error(JSON.stringify(reply.error));
    return object(object(reply.result).data);
  };
}
async function read(daemon: DaemonFixture, method: string, params: RecordValue = {}) {
  const reply = object(
    JSON.parse(await daemon.call(method, JSON.stringify({ workspace_id: "demo", ...params }))),
  );
  if (reply.error !== undefined) throw new Error(JSON.stringify(reply.error));
  return object(object(reply.result).data);
}
async function configure(page: Page, companion: CompanionFixture, daemon: DaemonFixture) {
  const capability = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(
    await (await page.request.get(companion.url)).text(),
  )?.[1];
  if (!capability) throw new Error("bootstrap");
  const headers = {
    Origin: new URL(companion.url).origin,
    "X-Workgraph-UI-Capability": capability,
  };
  const post = async (path: string, data: RecordValue, method = "POST") => {
    const response = await page.request.fetch(new URL(`/ui-api/v1${path}`, companion.url).href, {
      method,
      headers,
      data,
    });
    expect(response.status(), await response.text()).toBe(200);
  };
  await post("/connections", {
    id: "local",
    label: "Overview qualification",
    socket: daemon.socket,
  });
  await post("/connections/local/attach", { generation: "1" });
  return post;
}
async function mount(
  page: Page,
  companion: CompanionFixture,
  daemon: DaemonFixture,
  view = "overview",
  project = "release",
  openManagement = false,
) {
  const post = await configure(page, companion, daemon);
  await page.goto(
    new URL(
      `/#/${view}?connection=local&workspace=demo${project === "" ? "" : `&project=${project}`}`,
      companion.url,
    ).href,
  );
  const root = page.locator(`[data-feature="${view}"]`);
  await expect(root).toBeVisible();
  if (openManagement) {
    await root
      .locator("summary")
      .filter({ hasText: /^Workspace and project management$/u })
      .click();
    await expect(root.getByRole("button", { name: "Create project", exact: true })).toBeVisible();
  }
  await page.waitForLoadState("networkidle");
  return { root, post };
}
async function drain(page: Page) {
  const root = page.locator('[data-feature="overview"]');
  for (
    let i = 0;
    i < 20 &&
    (await root.getByRole("button", { name: "Next captured changes", exact: true }).isEnabled());
    i++
  ) {
    await root.getByRole("button", { name: "Next captured changes", exact: true }).click();
    await page.waitForLoadState("networkidle");
  }
  await expect(root.getByRole("button", { name: "Wait for changes", exact: true })).toBeEnabled();
}
function isWait(request: import("@playwright/test").Request) {
  if (request.method() !== "POST" || new URL(request.url()).pathname !== "/ui-api/v1/read")
    return false;
  const body: unknown = request.postDataJSON();
  return object(body).method === "attention.wait";
}

parityTest(
  "Overview six read families and captured selector variants match fresh executable schemas",
  // eslint-disable-next-line no-empty-pattern
  async ({}, info) => {
    const id = (v: string) => {
      const r = d.identifier.decode(d.jsonString(v));
      if (!r.ok) throw new Error("id");
      return r.value;
    };
    const dec = (v: string) => {
      const r = d.decimal.decode(d.jsonString(v));
      if (!r.ok) throw new Error("decimal");
      return r.value;
    };
    const scope: OverviewScope = {
      connection: {
        id: id("local"),
        generation: dec("1"),
        label: "probe",
        socket: "/tmp/probe.sock",
      },
      workspaceId: id("demo"),
      projectId: id("release"),
      actorId: id("fixture-author"),
      runId: id("reported-run"),
    };
    const requests = [
      summaryInvocation(scope),
      summaryInvocation({ ...scope, projectId: null }),
      coordinationInvocation(scope),
      coordinationInvocation(scope, true),
      attentionInvocation(scope, defaultAttention),
      attentionInvocation(scope, {
        ...defaultAttention,
        kinds: ["communication", "readiness"],
        recipient: { kind: "actor", id: id("fixture-author") },
        excludeSelf: true,
      }),
      attentionInvocation(scope, defaultAttention, {
        cursor: "opaque",
        readinessCursor: "independent",
      }),
      attentionInvocation(scope, defaultAttention, { cursor: "opaque", wait: true }),
      digestInvocation(scope, defaultDigest),
      digestInvocation({ ...scope, projectId: null }, { ...defaultDigest, ticketId: "design" }),
    ];
    const ajv = new Ajv2020({ strict: false }),
      report: unknown[] = [];
    for (const request of requests) {
      const schema = object(
        JSON.parse(
          (await execute(fixtureBinary(), ["schema", request.method], { maxBuffer: 2 ** 24 }))
            .stdout,
        ),
      );
      const definition = array(schema.methods).find((m) => m.name === request.method);
      if (!definition) throw new Error("catalog method");
      const validate = ajv.compile(object(definition.params));
      const encoded = stringifyJson(request.params);
      if (!encoded.ok) throw new Error(encoded.error.message);
      const params: unknown = JSON.parse(encoded.value);
      expect(validate(params), JSON.stringify(validate.errors)).toBe(true);
      report.push({ method: request.method, params, valid: true });
    }
    await info.attach("fresh-native-overview-selector-parity", {
      body: JSON.stringify(report, null, 2),
      contentType: "application/json",
    });
  },
);

test("Attached empty registry offers explicit workspace creation and selection into Overview", async ({
  page,
  companion,
  browserFailures,
}, info) => {
  const empty = await startDaemonFixture({ binary: fixtureBinary(), seed: false });
  try {
    await configure(page, companion, empty);
    await page.goto(`${companion.url}#/overview?connection=local`);
    const root = page.locator('[data-feature="overview"]');
    await expect(
      root.getByRole("heading", { name: "Choose a workspace", exact: true }),
    ).toBeVisible();
    await expect(root.getByRole("button", { name: "Create workspace", exact: true })).toHaveCount(
      0,
    );
    await root
      .locator("summary")
      .filter({ hasText: /^Workspace and project management$/u })
      .click();
    await page.locator(".wg-actor-trigger").click();
    await page.getByLabel("Acting actor ID", { exact: true }).fill("first-workspace-author");
    await page.getByRole("button", { name: "Use selection", exact: true }).click();
    await root.getByRole("button", { name: "Create workspace", exact: true }).click();
    await root.getByLabel("ID (optional)", { exact: true }).fill("first");
    await root
      .getByLabel("Workspace name", { exact: true })
      .fill("First workspace from empty registry");
    await root
      .getByLabel("Workspace root on companion host", { exact: true })
      .fill(`${empty.root}/first-workspace`);
    await root.getByRole("button", { name: "Review captured action", exact: true }).click();
    const review = root
      .locator("section.wg-panel")
      .filter({ has: page.getByRole("heading", { name: "Review captured action", exact: true }) });
    await expect(review.locator(".wg-badge")).toHaveText("prepared_unsent");
    await review.getByRole("button", { name: "Execute saved request", exact: true }).click();
    await expect(review.locator(".wg-badge")).toHaveText("committed");
    await root.getByRole("button", { name: "Close draft", exact: true }).click();
    await root.getByRole("button", { name: "Refresh registry", exact: true }).click();
    await root
      .getByRole("button", { name: "First workspace from empty registry", exact: true })
      .click();
    await expect(page).toHaveURL(/workspace=first/u);
    await expect(
      root.getByRole("heading", { name: "First workspace from empty registry", exact: true }),
    ).toBeVisible();
    await expect(root).toContainText("0 unanswered requests");
    await expect(root).not.toContainText("capacity is full");
    expect(text((await read(empty, "workspace.get", { workspace_id: "first" })).name)).toBe(
      "First workspace from empty registry",
    );
    await page.screenshot({
      path: info.outputPath("overview-first-workspace.png"),
      fullPage: true,
    });
    expect(browserFailures).toEqual([]);
  } finally {
    await empty.dispose();
  }
});

test("Overview distinguishes complete native counts, active status totals and bounded work excerpts", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  for (let i = 0; i < 30; i++) {
    await write("ticket.create", {
      ticket_id: `overview-${i}`,
      project_id: "release",
      title: `Additional ready task ${i}`,
    });
    await write("ticket.update", {
      ticket_id: `overview-${i}`,
      expected_revision: "1",
      status: "todo",
    });
  }
  const native = await read(daemon, "project.brief", {
      project_id: "release",
      limit: "1",
      max_bytes: "65536",
    }),
    progress = object(native.progress);
  const { root } = await mount(page, companion, daemon, "overview", "release", true);
  await expect(root).not.toContainText("capacity is full");
  await root.getByRole("button", { name: "Create project", exact: true }).click();
  const title = root.getByLabel("Title", { exact: true });
  await title.fill("Unsent management draft survives Overview refresh");
  const editor = await title.elementHandle();
  const refresh = page.waitForResponse((response) => {
    const request = response.request();
    return (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/ui-api/v1/read" &&
      object(request.postDataJSON()).method === "activity.digest"
    );
  });
  await root.getByRole("button", { name: "Refresh Overview", exact: true }).click();
  await (await refresh).finished();
  expect(await editor?.evaluate((element) => element.isConnected)).toBe(true);
  await expect(title).toHaveValue("Unsent management draft survives Overview refresh");
  await root.getByRole("button", { name: "Close draft", exact: true }).click();
  await editor?.dispose();
  await root
    .locator("summary")
    .filter({ hasText: /^Workspace and project management$/u })
    .click();
  await root.getByRole("button", { name: "Refresh Overview", exact: true }).click();
  await root
    .locator("summary")
    .filter({ hasText: /^Workspace and project management$/u })
    .click();
  await expect(root.getByRole("button", { name: "Create project", exact: true })).toBeVisible();
  await expect(root).not.toContainText("capacity is full");
  const counts = root.locator(".ov-counts > div");
  await expect(
    counts.filter({ has: page.getByText("Tickets", { exact: true }) }).locator("strong"),
  ).toHaveText(text(progress.total));
  await expect(root).toContainText("more in this captured collection");
  await expect(root.getByRole("button", { name: "More ready work", exact: true })).toBeEnabled();
  await root.getByRole("button", { name: "More ready work", exact: true }).click();
  await page.waitForLoadState("networkidle");
  await expect(root.getByRole("button", { name: "More ready work", exact: true })).toBeDisabled();
  await expect(
    root.getByRole("button", { name: "Next captured changes", exact: true }),
  ).toBeEnabled();
  await page.screenshot({ path: info.outputPath("overview-project-counts.png"), fullPage: true });
  await page.evaluate(() => {
    location.hash = "#/overview?connection=local&workspace=demo";
  });
  await page.waitForLoadState("networkidle");
  await expect(root.getByRole("heading", { name: "Claimed work", exact: true })).toBeVisible();
  await root.getByText("Active ticket status totals", { exact: true }).click();
  await expect(root).toContainText("do not sum to the all-record ticket counter");
  expect(browserFailures).toEqual([]);
});

test("Overview shows current dependency readiness, unanswered questions and attributed reported usage with real links", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  await write("run.register", {
    target_run_id: "reported-run",
    objective: "Overview reported samples",
  });
  await write("ticket.start", {
    ticket_id: "design",
    run_id: "reported-run",
    attempt_id: "reported-attempt",
  });
  await write("usage.report", {
    usage_id: "overview-usage",
    scope: { kind: "attempt", attempt_id: "reported-attempt" },
    tokens: "9007199254740993",
    elapsed_ms: "7",
    metrics: [],
    reported_actor_id: "fixture-author",
    provenance: "Synthetic observed report",
    timestamp: "source time unspecified",
  });
  const thread = await read(daemon, "thread.get", { thread_id: "planning" });
  await write("request.ask", {
    request_id: "overview-question",
    kind: "clarification",
    resolver_id: "fixture-author",
    recipients: [{ kind: "actor", id: "fixture-author" }],
    thread_id: "planning",
    expected_thread_revision: text(thread.revision),
    body: "Which dependency should proceed next?",
  });
  const { root } = await mount(page, companion, daemon);
  await expect(root).toContainText("1 unanswered requests");
  await expect(root).toContainText("9007199254740993 reported tokens");
  await expect(root).toContainText("depend on this prerequisite");
  await page.screenshot({
    path: info.outputPath("overview-attention-reported.png"),
    fullPage: true,
  });
  const requestLink = root.getByRole("link", { name: "Open current request", exact: true }).first();
  await requestLink.click();
  await expect(page).toHaveURL(/req_id=overview-question/u);
  await expect(
    page.getByText("Which dependency should proceed next?", { exact: true }).first(),
  ).toBeVisible();
  expect(browserFailures).toEqual([]);
});

test("Activity follows native captured pages with exact attribution, preserved window and historical comment navigation", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  const posted = await write("comment.add", {
    target: { kind: "ticket", id: "design" },
    body: "Original attributed overview comment",
  });
  const comment = posted;
  const native = await read(daemon, "activity.digest", {
    scope: { kind: "project", project_id: "release" },
    limit: "100",
    max_bytes: "1048576",
  });
  const { root } = await mount(page, companion, daemon, "activity");
  await root.getByLabel("Activity page size", { exact: true }).fill("2");
  await root.getByRole("button", { name: "Apply activity filters", exact: true }).click();
  await page.waitForLoadState("networkidle");
  const firstText = await root.locator(".ov-timeline").innerText();
  const through = object(native.capture).through;
  await expect(root).toContainText(`through ${text(through)}`);
  await write("comment.add", {
    target: { kind: "ticket", id: "design" },
    body: "AFTER_CAPTURE_SHOULD_NOT_APPEAR",
  });
  const seen: string[] = [];
  for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
    seen.push(...(await root.locator(".ov-timeline>li").allTextContents()));
    const next = root.getByRole("button", { name: "Next activity page", exact: true });
    if (!(await next.isEnabled())) break;
    const previous = await root.locator(".ov-timeline").innerText();
    const response = page.waitForResponse((response) => {
      const request = response.request();
      return (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/ui-api/v1/read" &&
        object(request.postDataJSON()).method === "activity.digest"
      );
    });
    await next.click();
    await (await response).finished();
    await expect.poll(() => root.locator(".ov-timeline").innerText()).not.toBe(previous);
    await expect(root).toContainText(`through ${text(through)}`);
  }
  expect(seen.join(" ")).not.toContain("AFTER_CAPTURE_SHOULD_NOT_APPEAR");
  expect(new Set(seen).size).toBe(seen.length);
  expect(firstText.length).toBeGreaterThan(0);
  await root.getByRole("button", { name: "Load activity", exact: true }).click();
  await page.waitForLoadState("networkidle");
  await root.getByLabel("Activity page size", { exact: true }).fill("100");
  await root.getByRole("button", { name: "Apply activity filters", exact: true }).click();
  await page.waitForLoadState("networkidle");
  const link = root
    .locator(`a[href*="entity=${text(comment.comment_id)}&"]`)
    .filter({ hasText: "Open comment revision" });
  await link.click();
  await expect(page).toHaveURL(new RegExp(`entity=${text(comment.comment_id)}`, "u"));
  await expect(
    page.getByText("Original attributed overview comment", { exact: true }).first(),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("activity-comment-revision.png"), fullPage: true });
  expect(browserFailures).toEqual([]);
});

test("Foreground attention wait observes actual change, Stop and same-document navigation cancel without acknowledgements", async ({
  page,
  daemon,
  companion,
  browserDiagnostics,
  browserFailures,
}, info) => {
  const write = writer(daemon),
    { root } = await mount(page, companion, daemon);
  await drain(page);
  const doc = await page.evaluateHandle(() => document);
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && new URL(request.url()).pathname !== "/ui-api/v1/read")
      writes.push(request.url());
  });
  let pending = page.waitForRequest(isWait);
  await root.getByRole("button", { name: "Wait for changes", exact: true }).click();
  await pending;
  await write("fact.put", {
    scope: { kind: "project", id: "release" },
    key: "overview.changed",
    expected_revision: "0",
    value: "actual event",
  });
  await expect(root.getByRole("button", { name: "Stop waiting", exact: true })).toBeDisabled();
  await expect(root).toContainText("fact changed");
  await drain(page);
  pending = page.waitForRequest(isWait);
  await root.getByRole("button", { name: "Wait for changes", exact: true }).click();
  await pending;
  browserDiagnostics.markPendingReads();
  await root.getByRole("button", { name: "Stop waiting", exact: true }).click();
  await expect(root).toContainText("Previous capture retained");
  pending = page.waitForRequest(isWait);
  await root.getByRole("button", { name: "Wait for changes", exact: true }).click();
  await pending;
  browserDiagnostics.markPendingReads();
  await root.getByRole("link", { name: "View activity", exact: true }).click();
  await expect(page.locator('[data-feature="activity"]')).toBeVisible();
  expect(await page.evaluate((old) => old === document, doc)).toBe(true);
  expect(writes).toEqual([]);
  await page.screenshot({
    path: info.outputPath("activity-after-stopped-wait.png"),
    fullPage: true,
  });
  expect(browserFailures).toEqual([]);
  await doc.dispose();
});

test("Overview same-ID endpoint generation and project transitions retain no misleading previous summary", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const second = await startDaemonFixture({ binary: fixtureBinary() });
  try {
    const write = writer(second);
    await write("project.update", {
      project_id: "release",
      expected_revision: "1",
      title: "Second endpoint project",
    });
    const { root, post } = await mount(page, companion, daemon);
    await expect(root).toContainText("Synthetic delivery workflow");
    await post(
      "/connections/local",
      {
        expected_generation: "1",
        label: "Second endpoint",
        socket: second.socket,
      },
      "PUT",
    );
    await post("/connections/local/attach", { generation: "2" });
    await page.locator(".wg-workspace-switch").click();
    const manager = page.getByRole("dialog", { name: "Daemon connections", exact: true });
    await manager.getByRole("button", { name: "Refresh profiles", exact: true }).click();
    await expect(manager.getByText(/local · generation 2/u)).toBeVisible();
    await manager.getByRole("button", { name: "Close Daemon connections", exact: true }).click();
    await page.waitForLoadState("networkidle");
    await expect(root).toContainText("Second endpoint project");
    await expect(root).not.toContainText("Synthetic delivery workflow");
    await page.evaluate(() => {
      location.hash = "#/overview?connection=local&workspace=demo";
    });
    await page.waitForLoadState("networkidle");
    await expect(root.getByRole("heading", { name: "Claimed work", exact: true })).toBeVisible();
    await page.goBack();
    await expect(root).toContainText("Second endpoint project");
    await page.screenshot({
      path: info.outputPath("overview-second-endpoint.png"),
      fullPage: true,
    });
    expect(browserFailures).toEqual([]);
  } finally {
    await second.dispose();
  }
});
