import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect } from "../../e2e/support/fixtures";
import type { DaemonFixture } from "../../../../test-support/daemon-fixture.mjs";
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
        mutation_id: `coord-${++serial}`,
        ...params,
      }),
    );
}
async function read(daemon: DaemonFixture, method: string, params: Record<string, unknown> = {}) {
  return (
    JSON.parse(await daemon.call(method, JSON.stringify({ workspace_id: "demo", ...params }))) as {
      result: { data: Record<string, unknown>; meta: Record<string, unknown> };
    }
  ).result;
}
async function actor(page: Page, id = "fixture-author", run = "coord-run") {
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill(id);
  await page.getByLabel("Run ID (optional)", { exact: true }).fill(run);
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  await expect(page.locator(".wg-actor-trigger")).toContainText(id);
}

async function mount(page: Page, companion: CompanionFixture, daemon: DaemonFixture) {
  const write = writer(daemon);
  await write("run.register", {
    target_run_id: "coord-run",
    objective: "Actual disposable Coordination browser qualification",
    capabilities: ["build"],
  });
  const response = await page.request.get(companion.url),
    cap = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(await response.text())?.[1];
  if (!cap) throw new Error("Missing bootstrap capability");
  const headers = { Origin: new URL(companion.url).origin, "X-Workgraph-UI-Capability": cap };
  for (const [path, data] of [
    ["/connections", { id: "local", label: "Coordination qualification", socket: daemon.socket }],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const response = await page.request.post(new URL(`/ui-api/v1${path}`, companion.url).href, {
      headers,
      data,
    });
    expect(response.status()).toBe(200);
    await response.text();
  }
  await page.goto(
    new URL("/#/participants?connection=local&workspace=demo&project=release", companion.url).href,
  );
  await expect(
    page.getByRole("group", { name: "Participants workspace", exact: true }),
  ).toBeVisible();
  await actor(page);
  return { root: page.locator(".wg-coordination"), write, headers };
}
async function open(root: Locator, name: string) {
  await root
    .getByRole("group", { name: "New coordination action", exact: true })
    .getByRole("button", { name, exact: true })
    .click();
  const draft = root.getByRole("complementary", { name: "Retained coordination forms" });
  await expect(draft.getByRole("button", { name: "Review", exact: true })).toBeVisible();
  return draft;
}
async function review(draft: Locator) {
  await draft.getByRole("button", { name: "Review", exact: true }).click();
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
async function commit(draft: Locator) {
  await review(draft);
  await execute(draft);
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  await page.waitForLoadState("networkidle");
  await expect(page.locator(".wg-content-status")).toHaveCount(0);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    for (const element of document.querySelectorAll<HTMLElement>(".wg-content"))
      element.scrollTop = 0;
  });
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: "image/png" });
}

test("Coordination C01 structured allocation and logical paths use complete guards and actual ticket membership", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const { root } = await mount(page, companion, daemon);
  await root.getByRole("button", { name: "Allocation rules", exact: true }).click();
  let draft = await open(root, "Configure a pool");
  await draft.getByLabel("Pool name", { exact: true }).fill("compiler");
  await draft.getByLabel("Concurrent slots", { exact: true }).fill("2");
  await commit(draft);
  expect((await read(daemon, "allocation.pools")).data.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "compiler", limit: "2", revision: "1" }),
    ]),
  );
  draft = await open(root, "Configure ticket eligibility");
  await draft.getByLabel("Ticket ID", { exact: true }).fill("build");
  await draft.getByRole("button", { name: "Add capabilities", exact: true }).click();
  await draft.getByLabel("Capabilities 1", { exact: true }).fill("build");
  await draft.getByRole("button", { name: "Add pools", exact: true }).click();
  await draft.getByLabel("Pools 1", { exact: true }).fill("compiler");
  await draft.getByLabel("Eligible actors", { exact: true }).selectOption("allow");
  await draft.getByRole("button", { name: "Add allowed actors", exact: true }).click();
  await draft.getByLabel("Allowed actors 1", { exact: true }).fill("fixture-author");
  await commit(draft);
  expect((await read(daemon, "allocation.ticket_policies")).data.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        ticket_id: "build",
        required_capabilities: ["build"],
        pools: ["compiler"],
        allowed_actor_ids: ["fixture-author"],
      }),
    ]),
  );
  draft = await open(root, "Declare ticket paths");
  await draft.getByLabel("Ticket ID", { exact: true }).fill("build");
  await draft.getByRole("checkbox", { name: "Require matching reservations for claims" }).check();
  await draft.getByRole("button", { name: "Add path declaration", exact: true }).click();
  await draft.getByLabel("Logical worktree", { exact: true }).fill("fixture-tree");
  await draft.getByLabel("Relative path", { exact: true }).fill("src//./lib");
  await draft.getByLabel("Path kind", { exact: true }).selectOption("subtree");
  await commit(draft);
  expect((await read(daemon, "ticket.paths.list")).data.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        ticket_id: "build",
        require_reservations: true,
        declarations: [
          {
            mode: "exclusive",
            target: { worktree_id: "fixture-tree", kind: "subtree", path: "src/lib" },
          },
        ],
      }),
    ]),
  );
  await root.getByRole("button", { name: "Path declarations", exact: true }).click();
  await expect(root.getByText("1 logical paths", { exact: false })).toBeVisible();
  await screenshot(page, info, "coordination-allocation");
  expect(browserFailures).toEqual([]);
});

test("Coordination C02 atomic holds retain captured writer and explicit lease guards across navigation", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const { root } = await mount(page, companion, daemon);
  await root.getByRole("button", { name: "Reservations", exact: true }).click();
  let draft = await open(root, "Acquire reservations");
  await draft.getByLabel("Reservation ID", { exact: true }).fill("compiler");
  await draft.getByLabel("Lease duration (ms, optional)", { exact: true }).fill("60000");
  await draft.getByRole("button", { name: "Add request", exact: true }).click();
  await draft
    .getByRole("group", { name: "Request 2", exact: true })
    .getByLabel("Reservation ID", { exact: true })
    .fill("database");
  await review(draft);
  await actor(page, "different-current-writer", "");
  await expect(draft.getByText(/writer fixture-author \/ coord-run/u)).toBeVisible();
  await execute(draft);
  const held = (await read(daemon, "reservation.get", { reservation_id: "compiler" })).data;
  expect(held.holders).toEqual([
    expect.objectContaining({
      actor_id: "fixture-author",
      run_id: "coord-run",
      token: "1",
      lease: expect.objectContaining({ revision: "1", duration_ms: "60000" }),
    }),
  ]);
  await actor(page);
  await root.getByRole("button", { name: "Refresh records", exact: true }).click();
  const row = root
    .locator(".wg-coord-record")
    .filter({ has: page.getByText("compiler", { exact: true }) });
  await expect(row.getByText(/Expiry does not release/u)).toBeVisible();
  await row.getByRole("button", { name: "Renew lease", exact: true }).click();
  draft = root.getByRole("complementary", { name: "Retained coordination forms" });
  await commit(draft);
  expect(
    (await read(daemon, "reservation.get", { reservation_id: "compiler" })).data.holders,
  ).toEqual([expect.objectContaining({ lease: expect.objectContaining({ revision: "2" }) })]);
  await root.getByRole("button", { name: "Refresh records", exact: true }).click();
  await row.getByRole("button", { name: "Release hold", exact: true }).click();
  await commit(draft);
  expect(
    (await read(daemon, "reservation.get", { reservation_id: "compiler" })).data.holders,
  ).toEqual([]);
  await screenshot(page, info, "coordination-retained-owner");
  expect(browserFailures).toEqual([]);
});

test("Coordination C03 saved bounded waits cancel unsent, survive reload, and acquire only after real contention clears", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const { root, write } = await mount(page, companion, daemon);
  await write("run.register", {
    target_run_id: "old-run",
    objective: "Disposable logical reservation holder",
    capabilities: [],
  });
  await write("reservation.acquire", {
    run_id: "old-run",
    target_run_id: "old-run",
    requests: [{ reservation_id: "compiler", mode: "exclusive" }],
  });
  await root.getByRole("button", { name: "Reservations", exact: true }).click();
  const prepare = async (name: string) => {
    const draft = await open(root, "Acquire reservations");
    await draft.getByLabel("Reservation ID", { exact: true }).fill(name);
    await draft.getByText("Use an explicit bounded acquisition wait", { exact: true }).click();
    await draft.getByLabel("Total wait deadline (ms)", { exact: true }).fill("15000");
    await draft.getByLabel("Maximum acquisition attempts", { exact: true }).fill("20");
    await draft.getByLabel("Feed wait slice (ms)", { exact: true }).fill("500");
    await draft.getByRole("button", { name: "Review bounded wait", exact: true }).click();
    await expect(draft.getByText(/Bounded-wait path retained/u)).toBeVisible();
    return draft;
  };
  await prepare("never-started");
  let card = root
    .locator(".wg-coord-record")
    .filter({ has: page.getByRole("button", { name: "Start bounded wait", exact: true }) });
  await expect(card).toHaveCount(1);
  const canceledId = await card.locator("strong").textContent();
  if (!canceledId) throw new Error("Missing saved wait ID");
  card = root
    .locator(".wg-coord-record")
    .filter({ has: page.getByText(canceledId, { exact: true }) });
  await card.getByRole("button", { name: "Cancel wait", exact: true }).click();
  await expect(card.getByText("canceled unsent", { exact: true })).toBeVisible();
  expect((await read(daemon, "reservation.list")).data.items).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ reservation_id: "never-started" })]),
  );
  await prepare("compiler");
  card = root
    .locator(".wg-coord-record")
    .filter({ has: page.getByRole("button", { name: "Start bounded wait", exact: true }) });
  await expect(card).toHaveCount(1);
  const restoredId = await card.locator("strong").textContent();
  if (!restoredId) throw new Error("Missing prepared wait ID");
  await page.reload();
  await expect(
    page.getByRole("group", { name: "Participants workspace", exact: true }),
  ).toBeVisible();
  await root.getByRole("button", { name: "Reservations", exact: true }).click();
  const savedPages = root.getByRole("group", { name: "Saved wait pages", exact: true });
  await expect(root.getByText(/At last read: page offset 0, 1 remaining/)).toBeVisible();
  await expect(root.getByText(/1 distinct jobs inspected this launch/)).toBeVisible();
  await savedPages.getByRole("button", { name: "Next saved wait", exact: true }).click();
  await expect(root.getByText(/At last read: page offset 1, 0 remaining/)).toBeVisible();
  await expect(root.getByText(/2 distinct jobs inspected this launch/)).toBeVisible();
  await expect(
    root.locator(".wg-coord-record").filter({ has: page.getByText(canceledId, { exact: true }) }),
  ).toHaveCount(1);
  await expect(
    savedPages.getByRole("button", { name: "Next saved wait", exact: true }),
  ).toBeDisabled();
  card = root
    .locator(".wg-coord-record")
    .filter({ has: page.getByText(restoredId, { exact: true }) });
  await expect(card.getByText("prepared unsent", { exact: true })).toBeVisible();
  expect(
    (await read(daemon, "reservation.get", { reservation_id: "compiler" })).data.holders,
  ).toEqual([expect.objectContaining({ run_id: "old-run", token: "1" })]);
  const activeId = await card.locator("strong").textContent();
  if (!activeId) throw new Error("Missing restored wait ID");
  card = root
    .locator(".wg-coord-record")
    .filter({ has: page.getByText(activeId, { exact: true }) });
  await card.getByRole("button", { name: "Start bounded wait", exact: true }).click();
  await expect(card.getByText("running", { exact: true })).toBeVisible();
  await expect
    .poll(
      async () =>
        (
          (
            await read(daemon, "reservation.contention", {
              target: { kind: "named", reservation_id: "compiler" },
              include_inactive: true,
            })
          ).data.items as unknown[]
        ).length,
    )
    .toBeGreaterThan(0);
  await write("reservation.release", {
    run_id: "old-run",
    target_run_id: "old-run",
    reservation_id: "compiler",
    token: "1",
  });
  await expect(card.getByText("completed", { exact: true })).toBeVisible({ timeout: 20000 });
  expect(
    (await read(daemon, "reservation.get", { reservation_id: "compiler" })).data.holders,
  ).toEqual([
    expect.objectContaining({ actor_id: "fixture-author", run_id: "coord-run", token: "2" }),
  ]);
  await screenshot(page, info, "coordination-bounded-wait");
  for (const [width, height, colorScheme] of [
    [1440, 900, "dark"],
    [390, 844, "light"],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme });
    await page.waitForLoadState("networkidle");
    for (const [label, target] of [
      ["paging", savedPages],
      ["completed-card", card],
    ] as const) {
      await target.scrollIntoViewIfNeeded();
      const path = info.outputPath(`coordination-${label}-${colorScheme}-${width}.png`);
      await page.screenshot({ path, fullPage: false });
      await info.attach(`coordination-${label}-${colorScheme}-${width}`, {
        path,
        contentType: "image/png",
      });
    }
  }
  expect(browserFailures).toEqual([]);
});

test("Coordination C04 exact condition signals and explicit outside recovery retain captured old owner and lease fences", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const { root, write } = await mount(page, companion, daemon);
  const digest = "a".repeat(64);
  await root.getByRole("button", { name: "Outside conditions", exact: true }).click();
  let draft = await open(root, "Declare an outside condition");
  await draft.getByLabel("Condition ID", { exact: true }).fill("external-check");
  await draft.getByLabel("Ticket ID", { exact: true }).fill("build");
  await draft.getByLabel("External operation ID", { exact: true }).fill("outside-build");
  await draft.getByLabel("Condition label", { exact: true }).fill("Outside fixture build verified");
  await draft.getByLabel("Proof kind", { exact: true }).selectOption("checksum");
  await draft.getByLabel("Source", { exact: true }).fill("fixture-build-output");
  await draft.getByLabel("SHA-256 digest", { exact: true }).fill(digest);
  await commit(draft);
  await root.getByRole("button", { name: "Refresh records", exact: true }).click();
  let row = root
    .locator(".wg-coord-record")
    .filter({ has: page.getByText("Outside fixture build verified", { exact: true }) });
  await expect(row.getByText("Awaiting matching signal", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "Record verified signal", exact: true }).click();
  draft = root.getByRole("complementary", { name: "Retained coordination forms" });
  await draft.getByRole("button", { name: "Add proof", exact: true }).click();
  await draft.getByLabel("Proof kind", { exact: true }).selectOption("checksum");
  await draft.getByLabel("Source", { exact: true }).fill("fixture-build-log");
  await draft.getByLabel("SHA-256 digest", { exact: true }).fill(digest);
  await draft
    .getByLabel("Verified result summary", { exact: true })
    .fill("Harness observed isolated synthetic build output and verified exact checksum.");
  await commit(draft);
  await root.getByRole("button", { name: "Refresh records", exact: true }).click();
  await expect(row.getByText("Matching verified signal recorded", { exact: true })).toBeVisible();
  expect(
    (await read(daemon, "condition.get", { condition_id: "external-check" })).data,
  ).toMatchObject({
    satisfied: true,
    declaration: { revision: "1", operation_id: "outside-build" },
    latest_signal: { actor_id: "fixture-author", run_id: "coord-run", condition_revision: "1" },
  });
  await row.getByRole("button", { name: "View recorded signals", exact: true }).click();
  await expect(
    root.getByText("Condition external-check · declaration 1 · operation outside-build", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    root.getByText(
      "Harness observed isolated synthetic build output and verified exact checksum.",
      { exact: true },
    ),
  ).toBeVisible();
  await write("run.register", {
    target_run_id: "old-run",
    objective: "Isolated fixture logical owner; no external process",
    capabilities: [],
  });
  await write("reservation.acquire", {
    run_id: "old-run",
    target_run_id: "old-run",
    requests: [{ reservation_id: "isolated-resource", mode: "exclusive", lease_duration_ms: "1" }],
  });
  await root.getByRole("button", { name: "Reservations", exact: true }).click();
  await root.getByRole("button", { name: "Refresh records", exact: true }).click();
  row = root
    .locator(".wg-coord-record")
    .filter({ has: page.getByText("isolated-resource", { exact: true }) });
  await row.getByRole("button", { name: "Review guarded recovery", exact: true }).click();
  draft = root.getByRole("complementary", { name: "Retained coordination forms" });
  await expect(draft.getByText(/captured owner fixture-author \/ old-run/u)).toBeVisible();
  await expect(
    draft.getByText(/Reservation epoch 1 · token 1 · lease epoch 1 · lease revision 1/u),
  ).toBeVisible();
  await draft.getByRole("button", { name: "Review", exact: true }).click();
  await expect(draft.getByRole("alert")).toContainText("outside observation");
  expect(
    (await read(daemon, "reservation.get", { reservation_id: "isolated-resource" })).data.holders,
  ).toEqual([expect.objectContaining({ run_id: "old-run", token: "1" })]);
  await draft.getByLabel("Outside confirmation", { exact: true }).selectOption("isolated");
  await draft
    .getByLabel("Recovery reason", { exact: true })
    .fill(
      "Harness confirms synthetic old owner has no process and is isolated in this disposable fixture.",
    );
  await draft.getByRole("button", { name: "Add proof", exact: true }).click();
  await draft.getByLabel("Proof kind", { exact: true }).selectOption("checksum");
  await draft.getByLabel("Source", { exact: true }).fill("fixture-isolation-log");
  await draft.getByLabel("SHA-256 digest", { exact: true }).fill(digest);
  await review(draft);
  await actor(page, "different-current-writer", "");
  await execute(draft);
  expect(
    (await read(daemon, "reservation.get", { reservation_id: "isolated-resource" })).data.holders,
  ).toEqual([]);
  expect((await read(daemon, "recovery.list")).data.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        actor_id: "fixture-author",
        run_id: "coord-run",
        request: expect.objectContaining({
          old_actor_id: "fixture-author",
          old_run_id: "old-run",
          token: "1",
          expected_lease_revision: "1",
          confirmation: "isolated",
        }),
      }),
    ]),
  );
  await root.getByRole("button", { name: "Recovery records", exact: true }).click();
  await expect(
    root.getByText("Previous owner: fixture-author / old-run", { exact: true }),
  ).toBeVisible();
  await expect(
    root.getByText("Recorded by fixture-author / coord-run", { exact: true }),
  ).toBeVisible();
  await expect(root.getByText(/isolated-resource · outside confirmation: isolated/u)).toBeVisible();
  await screenshot(page, info, "coordination-outside-proof-recovery");
  expect(browserFailures).toEqual([]);
});

test("Coordination C05 logical path batches, exact holder notes and advisory waiters remain distinct", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const { root } = await mount(page, companion, daemon);
  await root.getByRole("button", { name: "Reservations", exact: true }).click();
  let draft = await open(root, "Acquire reservations");
  await draft.getByLabel("Atomic batch kind", { exact: true }).selectOption("paths");
  await draft.getByRole("button", { name: "Add request", exact: true }).click();
  let request = draft.getByRole("group", { name: "Request 1", exact: true });
  await request.getByLabel("Logical worktree", { exact: true }).fill("fixture-tree");
  await request.getByLabel("Relative path", { exact: true }).fill("src//./lib");
  await request.getByLabel("Path kind", { exact: true }).selectOption("subtree");
  await request.getByLabel("Lease duration (ms, optional)", { exact: true }).fill("60000");
  await draft.getByRole("button", { name: "Add request", exact: true }).click();
  request = draft.getByRole("group", { name: "Request 2", exact: true });
  await request.getByLabel("Logical worktree", { exact: true }).fill("fixture-tree");
  await request.getByLabel("Relative path", { exact: true }).fill("README.md");
  await commit(draft);
  expect((await read(daemon, "reservation.path.list")).data.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        target: { worktree_id: "fixture-tree", kind: "subtree", path: "src/lib" },
        holders: [expect.objectContaining({ run_id: "coord-run", token: "1" })],
      }),
      expect.objectContaining({
        target: { worktree_id: "fixture-tree", kind: "file", path: "README.md" },
        holders: [expect.objectContaining({ run_id: "coord-run", token: "1" })],
      }),
    ]),
  );
  await root.getByRole("button", { name: "Logical paths", exact: true }).click();
  let row = root
    .locator(".wg-coord-record")
    .filter({ has: page.getByText("fixture-tree / src/lib (subtree)", { exact: true }) });
  await row.getByRole("button", { name: "Set advisory note", exact: true }).click();
  draft = root.getByRole("complementary", { name: "Retained coordination forms" });
  await draft
    .getByLabel("Advisory note", { exact: true })
    .fill("Owner reports a bounded fixture build; not a release promise");
  await draft.getByRole("button", { name: "Review", exact: true }).click();
  await expect(draft.getByRole("alert")).toBeVisible();
  await draft.getByLabel("Expected note revision", { exact: true }).fill("0");
  await commit(draft);
  draft = await open(root, "Record advisory waiting");
  await draft.getByLabel("Reservation kind", { exact: true }).selectOption("path");
  await draft.getByLabel("Logical worktree", { exact: true }).fill("fixture-tree");
  await draft.getByLabel("Relative path", { exact: true }).fill("src/lib/test.ml");
  await draft
    .getByLabel("Advisory note", { exact: true })
    .fill("Waiting observation only; no grant or queue position");
  await commit(draft);
  const contention = root.locator(".wg-panel").filter({
    has: page.getByRole("heading", { name: "Who holds or reports waiting?", exact: true }),
  });
  await contention.getByLabel("Reservation kind", { exact: true }).selectOption("path");
  await contention.getByLabel("Logical worktree", { exact: true }).fill("fixture-tree");
  await contention.getByLabel("Relative path", { exact: true }).fill("src/lib/test.ml");
  await contention.getByRole("button", { name: "Inspect contention", exact: true }).click();
  await expect(
    contention.getByText("Actual holder: fixture-author / coord-run", { exact: true }),
  ).toBeVisible();
  await expect(
    contention.getByText("Advisory waiter: fixture-author / coord-run", { exact: true }),
  ).toBeVisible();
  await expect(contention.getByText(/Owner reports a bounded fixture build/u)).toBeVisible();
  await expect(
    contention.getByText("Waiting observation only; no grant or queue position", { exact: true }),
  ).toBeVisible();
  await contention.getByRole("button", { name: "Review waiter update", exact: true }).click();
  await draft.getByLabel("Waiter action", { exact: true }).selectOption("close");
  await draft
    .getByLabel("Close reason", { exact: true })
    .fill("Harness ended the advisory observation");
  await commit(draft);
  await contention.getByRole("button", { name: "Inspect contention", exact: true }).click();
  await expect(contention.getByText(/closed · revision 2/u)).toBeVisible();
  await root.getByRole("button", { name: "Refresh records", exact: true }).click();
  row = root
    .locator(".wg-coord-record")
    .filter({ has: page.getByText("fixture-tree / src/lib (subtree)", { exact: true }) })
    .filter({ has: page.getByRole("button", { name: "Renew lease", exact: true }) });
  await row.getByRole("button", { name: "Renew lease", exact: true }).click();
  await commit(draft);
  expect((await read(daemon, "reservation.path.list")).data.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        target: { worktree_id: "fixture-tree", kind: "subtree", path: "src/lib" },
        holders: [expect.objectContaining({ lease: expect.objectContaining({ revision: "2" }) })],
      }),
    ]),
  );
  await root.getByRole("button", { name: "Refresh records", exact: true }).click();
  await row.getByRole("button", { name: "Release hold", exact: true }).click();
  await commit(draft);
  expect((await read(daemon, "reservation.path.list")).data.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        target: { worktree_id: "fixture-tree", kind: "subtree", path: "src/lib" },
        holders: [],
      }),
    ]),
  );
  await screenshot(page, info, "coordination-path-advisories");
  expect(browserFailures).toEqual([]);
});

test("Coordination catalogs retain open sources through live changes and apply guarded modal edits", async ({
  page,
  daemon,
  companion,
  browserFailures,
}) => {
  const { root, write } = await mount(page, companion, daemon);
  await write("allocation.pool_put", { name: "browser-pool", expected_revision: "0", limit: "2" });
  await root.getByRole("button", { name: "Allocation rules", exact: true }).click();
  const record = root
    .locator(".co-record")
    .filter({ has: page.getByRole("heading", { name: "browser-pool", exact: true }) });
  await expect(record).toContainText("2 concurrent slots");
  const details = record.locator(":scope > details");
  await details.locator(":scope > summary").click();
  await expect(
    record.getByRole("region", { name: "Content: Captured coordination record JSON", exact: true }),
  ).toBeVisible();
  await record.evaluate((element) => element.setAttribute("data-original-record", "true"));
  await write("allocation.pool_put", { name: "browser-pool", expected_revision: "1", limit: "3" });
  await expect(record).toContainText("3 concurrent slots", { timeout: 20000 });
  await expect(details).toHaveAttribute("open", "");
  await expect(record).toHaveAttribute("data-original-record", "true");
  await root.getByRole("button", { name: "Refresh records", exact: true }).click();
  await expect(record).toContainText("revision 2");
  await expect(details).toHaveAttribute("open", "");
  await record.getByRole("button", { name: "Edit pool", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Configure pool", exact: true });
  await dialog.getByLabel("Concurrent slots", { exact: true }).fill("4");
  await commit(dialog);
  await dialog.getByRole("button", { name: "Close Configure pool", exact: true }).click();
  await expect(record).toContainText("4 concurrent slots");
  expect((await read(daemon, "allocation.pools")).data.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "browser-pool", limit: "4", revision: "3" }),
    ]),
  );
  await write("reservation.acquire", {
    target_run_id: "coord-run",
    requests: [{ reservation_id: "browser-resource", mode: "exclusive" }],
  });
  await root.getByRole("button", { name: "Reservations", exact: true }).click();
  await expect(root.locator(".co-record")).toContainText("browser-resource");
  await root.getByText("Inspect holders and waiting runs", { exact: true }).click();
  const inspector = root.locator(".co-utility").filter({
    has: page.getByText("Inspect holders and waiting runs", { exact: true }),
  });
  await inspector.getByLabel("Reservation ID", { exact: true }).fill("browser-resource");
  await inspector.getByRole("button", { name: "Inspect contention", exact: true }).click();
  await expect(inspector).toContainText("Actual holder: fixture-author / coord-run");
  await write("reservation.release", {
    target_run_id: "coord-run",
    reservation_id: "browser-resource",
    token: "1",
  });
  await expect(
    inspector.getByText("Actual holder: fixture-author / coord-run", { exact: true }),
  ).toHaveCount(0, { timeout: 20000 });
  await expect(root.locator(".co-record")).toContainText("No current holders");
  expect(browserFailures).toEqual([]);
});
