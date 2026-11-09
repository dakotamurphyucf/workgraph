import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect } from "../../e2e/support/fixtures";
import {
  startDaemonFixture,
  fixtureBinary,
  type DaemonFixture,
} from "../../../../test-support/daemon-fixture.mjs";
import type { CompanionFixture } from "../../../../test-support/companion-fixture.mjs";
test.use({ viewport: { width: 1480, height: 1050 }, colorScheme: "dark", actionTimeout: 12000 });
function writer(daemon: DaemonFixture) {
  let serial = 0;
  return (method: string, params: Record<string, unknown>) =>
    daemon.call(
      method,
      JSON.stringify({
        workspace_id: "demo",
        actor_id: "fixture-author",
        mutation_id: `participants-${++serial}`,
        ...params,
      }),
    );
}
async function read(daemon: DaemonFixture, method: string, params: Record<string, unknown>) {
  return (
    JSON.parse(await daemon.call(method, JSON.stringify({ workspace_id: "demo", ...params }))) as {
      result: { data: Record<string, unknown>; meta: Record<string, unknown> };
    }
  ).result;
}
async function configure(page: Page, companion: CompanionFixture, daemon: DaemonFixture) {
  const response = await page.request.get(companion.url),
    cap = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(await response.text())?.[1];
  if (!cap) throw new Error("Missing native bootstrap capability");
  const headers = { Origin: new URL(companion.url).origin, "X-Workgraph-UI-Capability": cap };
  for (const [path, data] of [
    ["/connections", { id: "local", label: "Participants qualification", socket: daemon.socket }],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const value = await page.request.post(new URL(`/ui-api/v1${path}`, companion.url).href, {
      headers,
      data,
    });
    expect(value.status()).toBe(200);
    await value.text();
  }
  return headers;
}
async function actor(page: Page, id = "fixture-author", run = "") {
  await page.waitForLoadState("networkidle");
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill(id);
  await page.getByLabel("Run ID (optional)", { exact: true }).fill(run);
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  await page.waitForLoadState("networkidle");
}
async function mount(
  page: Page,
  companion: CompanionFixture,
  daemon: DaemonFixture,
  route = "/#/participants?connection=local&workspace=demo&project=release",
) {
  await configure(page, companion, daemon);
  await page.goto(new URL(route, companion.url).href);
  await expect(page.getByRole("heading", { name: "Participants", exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await actor(page);
  return page.getByRole("region", { name: "Participants", exact: true });
}
async function open(root: Locator, method: string) {
  await root.getByLabel("Action", { exact: true }).selectOption(method);
  await root.getByRole("button", { name: "Open form", exact: true }).click();
  const draft = root.getByRole("region", { name: "Participant change draft", exact: true });
  await expect(draft).toBeVisible();
  return draft;
}
async function review(draft: Locator) {
  await draft.getByRole("button", { name: "Review change", exact: true }).click();
  await expect(
    draft.getByRole("button", { name: "Execute saved request", exact: true }),
  ).toBeEnabled();
}
async function execute(draft: Locator, outcome = "committed") {
  await draft.getByRole("button", { name: "Execute saved request", exact: true }).click();
  await expect(
    draft.getByRole("status").filter({ hasText: new RegExp(`^${outcome}$`, "u") }),
  ).toBeVisible();
}
async function commit(draft: Locator, outcome = "committed") {
  await review(draft);
  await execute(draft, outcome);
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  await expect(page.getByRole("heading", { name: "Preparing content", exact: true })).toHaveCount(
    0,
  );
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    for (const element of document.querySelectorAll<HTMLElement>(".wg-content"))
      element.scrollTop = 0;
  });
  const file = info.outputPath(`${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await info.attach(name, { path: file, contentType: "image/png" });
}

test("Participants P01 ordinary actor and actual invocation records retain writer and never launch processes", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const root = await mount(page, companion, daemon);
  let draft = await open(root, "actor.put");
  await draft.getByLabel("Actor ID", { exact: true }).fill("recorded-person");
  await draft.getByLabel("Display name", { exact: true }).fill("Recorded person");
  await draft.getByLabel("Actor kind", { exact: true }).selectOption("person");
  await commit(draft);
  expect((await read(daemon, "actor.list", { include_archived: true })).data.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        actor_id: "recorded-person",
        name: "Recorded person",
        kind: "person",
      }),
    ]),
  );
  draft = await open(root, "run.register");
  await expect(draft.getByText(/Registration does not launch a process/u)).toBeVisible();
  await expect(draft.getByRole("checkbox")).toHaveCount(0);
  await draft.getByLabel("Existing invocation ID", { exact: true }).fill("browser-invocation");
  await draft
    .getByLabel("Invocation objective", { exact: true })
    .fill("Record this actual Playwright qualification invocation");
  await draft
    .getByLabel("Immutable capabilities", { exact: true })
    .fill("browser-verification\nui-implementation");
  await draft
    .getByLabel("External process reference (optional)", { exact: true })
    .fill(`playwright-worker:${process.pid}`);
  await review(draft);
  await actor(page, "different-current-writer");
  await expect(draft.getByText(/Captured writer fixture-author/u)).toBeVisible();
  await execute(draft);
  const registered = (await read(daemon, "run.get", { target_run_id: "browser-invocation" })).data;
  expect(registered.actor_id).toBe("fixture-author");
  expect(registered.capabilities).toEqual(["browser-verification", "ui-implementation"]);
  expect(registered.process_ref).toBe(`playwright-worker:${process.pid}`);
  await actor(page);
  draft = await open(root, "run.observe");
  await draft.getByLabel("Target run ID", { exact: true }).fill("browser-invocation");
  const when = String(Date.now());
  await draft.getByLabel("Observed Unix milliseconds", { exact: true }).fill(when);
  await commit(draft);
  expect(
    (await read(daemon, "run.get", { target_run_id: "browser-invocation" })).data
      .last_observed_unix_ms,
  ).toBe(when);
  draft = await open(root, "run.heartbeat");
  await draft.getByLabel("Target run ID", { exact: true }).fill("browser-invocation");
  await commit(draft, "observed");
  expect(
    (await read(daemon, "run.heartbeat_get", { target_run_id: "browser-invocation" })).data
      .advisory,
  ).toBe(true);
  draft = await open(root, "run.transition");
  await draft.getByLabel("Target run ID", { exact: true }).fill("browser-invocation");
  await draft.getByLabel("Recorded state", { exact: true }).selectOption("waiting");
  await draft.getByLabel("State evidence", { exact: true }).fill("Waiting for independent review");
  await commit(draft);
  expect((await read(daemon, "run.get", { target_run_id: "browser-invocation" })).data.status).toBe(
    "waiting",
  );
  await root.getByLabel("Browse", { exact: true }).selectOption("runs");
  await expect(root.getByRole("button", { name: "browser-invocation", exact: true })).toBeVisible();
  await root.getByRole("button", { name: "browser-invocation", exact: true }).click();
  await expect(
    root.getByRole("heading", { name: "Run browser-invocation", exact: true }),
  ).toBeVisible();
  await screenshot(page, info, "participants-recorded-run");
  expect(browserFailures).toEqual([]);
});

test("Participants P02 attempts require actual claim and preserve checkpoints across writer navigation", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  await write("run.register", {
    target_run_id: "actual-run",
    objective: "Actual isolated qualification runner",
  });
  await write("ticket.claim", {
    ticket_id: "design",
    run_id: "actual-run",
  });
  const root = await mount(page, companion, daemon);
  await actor(page, "fixture-author", "actual-run");
  let draft = await open(root, "attempt.start");
  await draft.getByLabel("Target run ID", { exact: true }).fill("actual-run");
  await draft.getByLabel("Claimed ticket ID", { exact: true }).fill("design");
  await draft.getByLabel("New attempt ID", { exact: true }).fill("actual-attempt");
  await commit(draft);
  const started = (await read(daemon, "attempt.get", { attempt_id: "actual-attempt" })).data;
  expect(started.run_id).toBe("actual-run");
  expect(started.ticket_id).toBe("design");
  draft = await open(root, "attempt.checkpoint");
  await draft.getByLabel("Attempt ID", { exact: true }).fill("actual-attempt");
  await draft.getByLabel("Checkpoint source", { exact: true }).selectOption("resource");
  await draft.getByLabel("Resource ID", { exact: true }).fill("notes");
  await draft.getByLabel("Exact source revision", { exact: true }).fill("1");
  await commit(draft);
  expect(
    (await read(daemon, "attempt.get", { attempt_id: "actual-attempt" })).data.checkpoints,
  ).toEqual([{ kind: "resource", resource_id: "notes", revision: "1" }]);
  draft = await open(root, "attempt.finish");
  await draft.getByLabel("Attempt ID", { exact: true }).fill("actual-attempt");
  await draft
    .getByLabel("Completion evidence", { exact: true })
    .fill("Actual native/browser checkpoint retained");
  await review(draft);
  await actor(page, "other-current-actor");
  await expect(draft.getByText(/Captured writer fixture-author \/ run actual-run/u)).toBeVisible();
  await execute(draft);
  expect((await read(daemon, "attempt.get", { attempt_id: "actual-attempt" })).data.state).toBe(
    "completed",
  );
  await root.getByLabel("Browse", { exact: true }).selectOption("attempts");
  await root.getByRole("button", { name: "actual-attempt", exact: true }).click();
  await expect(
    root.getByRole("heading", { name: "Attempt actual-attempt", exact: true }),
  ).toBeVisible();
  await expect(root.getByText("Resource notes content version 1", { exact: true })).toBeVisible();
  await screenshot(page, info, "participants-attempt-checkpoint");
  expect(browserFailures).toEqual([]);
});

test("Participants P03 runner requests and reported attention limits stay distinct from process control", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  await write("run.register", { target_run_id: "parent-run", objective: "Owned parent fixture" });
  await write("run.register", {
    target_run_id: "child-run",
    objective: "Owned child fixture",
    parent_run_id: "parent-run",
    parent_stop_policy: "request_cancel",
  });
  await write("run.transition", {
    target_run_id: "parent-run",
    expected_revision: "1",
    status: "cancelled",
    evidence: "Harness cancellation request recorded",
  });
  await write("run.budget_put", {
    target_run_id: "child-run",
    expected_revision: "0",
    max_attempts: null,
    max_active_attempts: null,
    reported_token_limit: null,
    reported_elapsed_ms_limit: null,
  });
  const root = await mount(page, companion, daemon);
  await root.getByLabel("Browse", { exact: true }).selectOption("actions");
  await expect(root.getByText(/Parent parent-run requests cancellation/u)).toBeVisible();
  let draft = await open(root, "run.action_acknowledge");
  await draft.getByLabel("Requested child run ID", { exact: true }).fill("child-run");
  await draft
    .getByLabel("Action acknowledgement evidence", { exact: true })
    .fill("Harness observed the request; no process was launched or stopped by this UI");
  await commit(draft);
  expect((await read(daemon, "run.actions", {})).data.items).toEqual([]);
  draft = await open(root, "run.budget_put");
  await draft.getByLabel("Target run ID", { exact: true }).fill("child-run");
  await draft.getByLabel("Maximum attempts", { exact: true }).fill("4");
  await draft.getByLabel("Maximum active attempts", { exact: true }).fill("2");
  await draft
    .getByLabel("Reported token attention limit", { exact: true })
    .fill("9007199254740993");
  await commit(draft);
  const budget = (await read(daemon, "run.budget_get", { target_run_id: "child-run" })).data;
  expect(budget.reported_token_limit).toBe("9007199254740993");
  expect(budget.reported_elapsed_ms_limit).toBeNull();
  await write("ticket.claim", { ticket_id: "design", run_id: "child-run" });
  await root.getByLabel("Browse", { exact: true }).selectOption("coordinator");
  await expect(
    root.getByText("Overview filtered to project release.", { exact: true }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(root.getByText(/Overview is missing its byte-budget status/u)).toHaveCount(0);
  const coordination = await read(daemon, "coordinator.overview", { project_id: "release" });
  await info.attach("native-project-coordinator", {
    body: JSON.stringify(coordination),
    contentType: "application/json",
  });
  expect(
    (coordination.data.items as { kind: string; source: { ticket_id?: string } }[]).some(
      (item) => item.kind === "dependency_bottleneck" && item.source.ticket_id === "design",
    ),
  ).toBe(true);
  await expect(
    root
      .locator("article")
      .filter({ has: page.getByRole("heading", { name: "dependency bottleneck", exact: true }) })
      .getByText("design", { exact: true }),
  ).toBeVisible();
  await root.getByLabel("Browse", { exact: true }).selectOption("actor-overview");
  await root.getByLabel("Actor filter / overview actor", { exact: true }).fill("fixture-author");
  await root.getByRole("button", { name: "Apply read filters", exact: true }).click();
  await expect(root.getByRole("heading", { name: "claim", exact: true })).toBeVisible();
  await expect(
    root
      .locator("article")
      .filter({ has: page.getByRole("heading", { name: "claim", exact: true }) })
      .getByText("design", { exact: true }),
  ).toBeVisible();
  await root.getByLabel("Browse", { exact: true }).selectOption("runs");
  await expect(root.getByLabel("Actor filter / overview actor", { exact: true })).toHaveCount(0);
  await expect(root.getByText(/Workspace-wide records/u)).toBeVisible();
  await screenshot(page, info, "participants-coordination-limits");
  expect(browserFailures).toEqual([]);
});

test("Participants P04 complete session paging and History originating-run links retain old endpoint generation", async ({
  page,
  daemon,
  companion,
  browserFailures,
  browserDiagnostics,
}, info) => {
  test.setTimeout(120000);
  const write = writer(daemon);
  await write("run.register", {
    target_run_id: "same-run",
    objective: "Original endpoint invocation",
  });
  for (let index = 0; index < 105; index++)
    await write("session.create", {
      session_id: `session-${String(index).padStart(3, "0")}`,
      title: `Original association ${index}`,
      run_id: "same-run",
      scopes: index === 104 ? [{ kind: "ticket", id: "design" }] : [],
    });
  const root = await mount(
    page,
    companion,
    daemon,
    "/#/participants?connection=local&workspace=demo&entity=same-run&participant=run&generation=1",
  );
  await expect(root.getByRole("heading", { name: "Run same-run", exact: true })).toBeVisible();
  await expect(
    root.getByRole("group", { name: "Captured run sessions", exact: true }).getByRole("button"),
  ).toHaveCount(100);
  const initialIds = await root
    .getByRole("group", { name: "Captured run sessions", exact: true })
    .getByRole("button")
    .allTextContents();
  const originalCapture = (await read(daemon, "run.get", { target_run_id: "same-run" })).data
    .session_associations as { history_head: string; total: string };
  expect(originalCapture.total).toBe("105");
  await write("session.create", {
    session_id: "session-105",
    title: "Appended after captured association page",
    run_id: "same-run",
  });
  expect(
    (
      (await read(daemon, "run.get", { target_run_id: "same-run" })).data.session_associations as {
        total: string;
      }
    ).total,
  ).toBe("106");
  await root.getByRole("button", { name: "Next session associations", exact: true }).click();
  const sessions = root.getByRole("group", { name: "Captured run sessions", exact: true });
  await expect(sessions.getByRole("button")).toHaveCount(5);
  const laterIds = await sessions.getByRole("button").allTextContents();
  expect([...initialIds, ...laterIds].sort()).toEqual(
    Array.from({ length: 105 }, (_, index) => `session-${String(index).padStart(3, "0")}`),
  );
  expect(laterIds).not.toContain("session-105");
  await root.getByText("Session association capture", { exact: true }).click();
  await expect(root.getByText(/0 remain after this page/u)).toBeVisible();
  await sessions.getByRole("button", { name: "session-104", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Original association 104", exact: true }),
  ).toBeVisible();
  const firstHistoryUrl = page.url();
  expect(firstHistoryUrl).toContain(`generation=1&head=${originalCapture.history_head}`);
  expect(firstHistoryUrl).not.toContain("event=");
  await page.locator(".ht-session-details > summary").click();
  await expect(page.getByRole("button", { name: "same-run", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "ticket:design", exact: true })).toBeVisible();
  await expect(
    page.getByText("ticket:design · exact target navigation unavailable in this build", {
      exact: true,
    }),
  ).toHaveCount(0);
  const second = await startDaemonFixture({ binary: fixtureBinary() });
  try {
    const secondWrite = writer(second);
    await secondWrite("run.register", {
      target_run_id: "same-run",
      objective: "Different daemon same ID",
    });
    const source = await page.request.get(companion.url),
      cap = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(await source.text())?.[1];
    if (!cap) throw new Error("Missing native bootstrap");
    const headers = { Origin: new URL(companion.url).origin, "X-Workgraph-UI-Capability": cap },
      changed = await page.request.put(
        new URL("/ui-api/v1/connections/local", companion.url).href,
        {
          headers,
          data: { expected_generation: "1", label: "Retargeted profile", socket: second.socket },
        },
      );
    expect(changed.status()).toBe(200);
    await changed.text();
    const attached = await page.request.post(
      new URL("/ui-api/v1/connections/local/attach", companion.url).href,
      { headers, data: { generation: "2" } },
    );
    expect(attached.status()).toBe(200);
    await attached.text();
    await page.waitForLoadState("networkidle");
    browserDiagnostics.markPendingReads();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Original association 104", exact: true }),
    ).toBeVisible();
    await page.locator(".ht-session-details > summary").click();
    await page.getByRole("button", { name: "same-run", exact: true }).click();
    await expect(root.getByRole("heading", { name: "Run same-run", exact: true })).toBeVisible();
    await expect(
      root.getByText("Original endpoint invocation", { exact: true }).first(),
    ).toBeVisible();
    await expect(root.getByText("Different daemon same ID", { exact: true })).toHaveCount(0);
    const retainedParams = new URLSearchParams(new URL(page.url()).hash.split("?")[1]);
    expect(retainedParams.get("participant")).toBe("run");
    expect(retainedParams.get("generation")).toBe("1");
    await expect(root.getByText(/Viewing retained endpoint generation 1/u)).toBeVisible();
    await expect(root.getByRole("button", { name: "Open form", exact: true })).toBeDisabled();
    await screenshot(page, info, "participants-retained-history-association");
  } finally {
    await second.dispose();
  }
  expect(browserFailures).toEqual([]);
});

test("Participants table keeps live records and modal drafts with their original author", async ({
  page,
  daemon,
  companion,
  browserFailures,
}) => {
  await configure(page, companion, daemon);
  const write = writer(daemon);
  await write("run.register", {
    target_run_id: "table-run",
    objective: "Observed native browser fixture",
    capabilities: ["review"],
  });
  await page.goto(
    new URL("/#/participants?connection=local&workspace=demo&project=release", companion.url).href,
  );
  const row = page.getByRole("row").filter({ hasText: "table-run" });
  await expect(row).toContainText("running");
  await row.getByRole("button", { name: "table-run", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "Run table-run", exact: true });
  await expect(detail).toContainText("Observed native browser fixture");
  expect(new URL(page.url()).hash).toContain("project=release");
  await page.goBack();
  await expect(detail).toHaveCount(0);
  await expect(row).toBeVisible();
  await write("run.transition", {
    target_run_id: "table-run",
    expected_revision: "1",
    status: "completed",
    evidence: "Synthetic native browser observation complete",
  });
  await expect(row).toContainText("completed", { timeout: 20000 });
  const chooseActor = async (id: string) => {
    await page.locator(".wg-actor-trigger").click();
    await page.getByLabel("Acting actor ID", { exact: true }).fill(id);
    await page.getByRole("button", { name: "Use selection", exact: true }).click();
    await expect(page.locator(".wg-actor-trigger")).toContainText(id);
  };
  await chooseActor("fixture-author");
  await page.getByRole("button", { name: "Record a change", exact: true }).click();
  const chooser = page.getByRole("dialog", { name: "Record a participant change", exact: true });
  await chooser.getByLabel("Action", { exact: true }).selectOption("run.register");
  await chooser.getByRole("button", { name: "Open form", exact: true }).click();
  const draft = page.getByRole("dialog", { name: "Register an existing invocation", exact: true });
  await draft.getByLabel("Existing invocation ID", { exact: true }).fill("retained-modal-run");
  await draft
    .getByLabel("Invocation objective", { exact: true })
    .fill("Keep the original captured writer");
  await draft
    .getByRole("button", { name: "Close Register an existing invocation", exact: true })
    .click();
  await chooseActor("different-current-writer");
  await page.getByRole("button", { name: "Record a change", exact: true }).click();
  await chooser
    .getByRole("button", { name: "Register an existing invocation · editing", exact: true })
    .click();
  await expect(draft.getByLabel("Invocation objective", { exact: true })).toHaveValue(
    "Keep the original captured writer",
  );
  await expect(draft).toContainText("Captured writer fixture-author");
  await review(draft);
  await execute(draft);
  const run = (await read(daemon, "run.get", { target_run_id: "retained-modal-run" })).data;
  expect(run.actor_id).toBe("fixture-author");
  expect(run.objective).toBe("Keep the original captured writer");
  await draft
    .getByRole("button", { name: "Close Register an existing invocation", exact: true })
    .click();
  await expect(page.getByRole("row").filter({ hasText: "retained-modal-run" })).toBeVisible();
  await page.getByRole("button", { name: "People and agents", exact: true }).click();
  await expect(page.locator(".pt-table thead")).toContainText("Person / agent");
  await page.setViewportSize({ width: 760, height: 1000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(browserFailures).toEqual([]);
});
