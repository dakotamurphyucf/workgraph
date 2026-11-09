import { trackPageReads, waitForPageReads } from "../support/readiness";
import type { Browser, Page, Request, TestInfo, Locator } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import type { DaemonFixture } from "../../../../test-support/daemon-fixture.mjs";
import type { CompanionFixture } from "../../../../test-support/companion-fixture.mjs";
import type { CommunicationWitness } from "./types";

test.use({ colorScheme: "dark", viewport: { width: 1480, height: 1000 }, actionTimeout: 12000 });
test.setTimeout(90000);
type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected native fixture record");
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected native text");
  return value;
}
function recorder(daemon: DaemonFixture, info: TestInfo) {
  const reads: { method: string; params: RecordValue; response: RecordValue }[] = [];
  let serial = 0;
  async function native(method: string, params: RecordValue = {}) {
    const request = { workspace_id: "demo", ...params };
    const response = object(JSON.parse(await daemon.call(method, JSON.stringify(request))));
    reads.push({ method, params: request, response });
    await info.attach(`native-${reads.length}-${method}`, {
      body: JSON.stringify({ method, params: request, response }, null, 2),
      contentType: "application/json",
    });
    if (response.error !== undefined)
      throw new Error(`${method}: ${JSON.stringify(response.error)}`);
    return object(object(response.result).data);
  }
  return {
    reads,
    native,
    write: (method: string, params: RecordValue) =>
      native(method, {
        actor_id: "fixture-author",
        mutation_id: `comms-tabs-${++serial}`,
        ...params,
      }),
  };
}
async function connect(page: Page, companion: CompanionFixture, daemon: DaemonFixture) {
  const html = await (await page.request.get(companion.url)).text();
  const token = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(html)?.[1];
  if (token === undefined) throw new Error("Missing bootstrap capability");
  for (const [path, data] of [
    [
      "/connections",
      { id: "local", label: "Communication two-tab qualification", socket: daemon.socket },
    ],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const response = await page.request.post(new URL(`/ui-api/v1${path}`, companion.url).href, {
      headers: { Origin: new URL(companion.url).origin, "X-Workgraph-UI-Capability": token },
      data,
    });
    expect(response.status()).toBe(200);
    await response.text();
  }
}
async function navigate(page: Page, companion: CompanionFixture, route: string) {
  await page.goto(new URL(`/#/${route}`, companion.url).href);
  await waitForPageReads(page);
}
async function actor(page: Page, id: string, run = "") {
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill(id);
  await page.getByLabel("Run ID (optional)", { exact: true }).fill(run);
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  await waitForPageReads(page);
}
async function questionAction(page: Page, name: string) {
  await page.getByRole("button", { name, exact: true }).click();
  const dialog = page.getByRole("dialog", { name, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function commitQuestion(dialog: Locator) {
  await dialog.getByRole("button", { name: "Review", exact: true }).click();
  await dialog.getByRole("button", { name: "Apply captured action", exact: true }).click();
  await expect(
    dialog.getByRole("status").filter({ hasText: "Saved action: committed" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Keep draft and close", exact: true }).click();
}
async function shot(page: Page, info: TestInfo, name: string) {
  await waitForPageReads(page);
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}
/** Second tab owns independent storage, strict diagnostics, and closes before services. */
async function withPeer(
  browser: Browser,
  companion: CompanionFixture,
  info: TestInfo,
  run: (page: Page) => Promise<void>,
) {
  const context = await browser.newContext({
    viewport: { width: 1480, height: 1000 },
    colorScheme: "light",
  });
  try {
    const page = await context.newPage(),
      failures: string[] = [],
      active = new Set<Request>();
    const teardownReads = new Set<Request>(),
      requests: { method: string; url: string; body: string | null }[] = [];
    trackPageReads(page);
    const origin = new URL(companion.url).origin;
    page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") failures.push(`console.error: ${message.text()}`);
    });
    page.on("request", (request) => {
      active.add(request);
      if (new URL(request.url()).origin !== origin)
        failures.push(`external request: ${request.url()}`);
      if (request.url().includes("/ui-api/"))
        requests.push({ method: request.method(), url: request.url(), body: request.postData() });
    });
    page.on("requestfinished", (request) => active.delete(request));
    page.on("requestfailed", (request) => {
      active.delete(request);
      const error = request.failure()?.errorText;
      if (!(teardownReads.delete(request) && error === "net::ERR_ABORTED"))
        failures.push(`requestfailed: ${request.method()} ${request.url()} ${error}`);
    });
    try {
      await run(page);
    } finally {
      const beforeClose = [...active].map((r) => ({ method: r.method(), url: r.url() }));
      for (const request of active) {
        const url = new URL(request.url());
        if (
          url.origin === origin &&
          ((request.method() === "POST" &&
            ["/ui-api/v1/read", "/ui-api/v1/live-observations"].includes(url.pathname)) ||
            (request.method() === "GET" && url.pathname === "/ui-api/v1/connections"))
        )
          teardownReads.add(request);
      }
      await page.close();
      await info.attach("independent-tab-diagnostics", {
        body: JSON.stringify({ failures, beforeClose, requests }, null, 2),
        contentType: "application/json",
      });
      expect(failures).toEqual([]);
    }
  } finally {
    await context.close();
  }
}

test("Communication T01 independent tabs separate delivery acknowledgement, responsibility and designated resolver", async ({
  page,
  browser,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const record = recorder(daemon, info);
  const thread = await record.native("thread.get", { thread_id: "planning" });
  await record.write("request.ask", {
    request_id: "two-tab-question",
    kind: "clarification",
    resolver_id: "fixture-author",
    recipients: [{ kind: "actor", id: "human" }],
    thread_id: "planning",
    expected_thread_revision: text(thread.revision),
    body: "Two tabs: who may resolve this?",
  });
  await connect(page, companion, daemon);
  const route =
    "discussions?connection=local&workspace=demo&project=release&req_view=request&req_generation=1&req_id=two-tab-question";
  await navigate(page, companion, route);
  await actor(page, "fixture-author");
  await withPeer(browser, companion, info, async (peer) => {
    await navigate(peer, companion, route);
    await actor(peer, "human");
    await expect(page.locator(".wg-actor-trigger")).toContainText("fixture-author");
    for (const name of ["Acknowledge delivery", "Accept responsibility"])
      await commitQuestion(await questionAction(peer, name));
    const accepted = await record.native("request.get", { request_id: "two-tab-question" });
    expect(object(accepted.status).kind).toBe("open");
    expect(object(accepted.responsibility).kind).toBe("accepted");
    expect(accepted.resolver_id).toBe("fixture-author");
    const deliveries = accepted.deliveries;
    if (!Array.isArray(deliveries)) throw new Error("Expected actual deliveries");
    expect(object(object(deliveries[0]).acknowledged).actor_id).toBe("human");
    const invalid = await questionAction(peer, "Answer and resolve");
    await invalid.getByLabel("Answer", { exact: true }).fill("Wrong resolver cannot resolve");
    await invalid.getByRole("button", { name: "Review", exact: true }).click();
    await expect(
      invalid.getByRole("alert").filter({ hasText: "designated resolver" }),
    ).toBeVisible();
    await shot(peer, info, "recipient-unavailable-resolver-light");
    await invalid.getByRole("button", { name: "Keep draft and close", exact: true }).click();
    expect(
      object((await record.native("request.get", { request_id: "two-tab-question" })).status).kind,
    ).toBe("open");
    await page
      .locator('section[aria-label="request results"]')
      .getByRole("button", { name: "Refresh current capture", exact: true })
      .click();
    await waitForPageReads(page);
    const answer = await questionAction(page, "Answer and resolve");
    await answer
      .getByLabel("Answer", { exact: true })
      .fill("Exact resolver answer from the original tab.\n");
    await commitQuestion(answer);
    const resolved = await record.native("request.get", { request_id: "two-tab-question" });
    expect(object(resolved.status).kind).toBe("resolved");
    expect(object(resolved.answer).author_id).toBe("fixture-author");
    await peer
      .locator('section[aria-label="request results"]')
      .getByRole("button", { name: "Refresh current capture", exact: true })
      .click();
    await expect(
      peer.getByText("Exact resolver answer from the original tab.", { exact: false }),
    ).toBeVisible();
    await shot(page, info, "original-tab-resolver-dark");
    const witness: CommunicationWitness = {
      scenario: "independent-request-tabs",
      requirements: ["R04", "R10", "R13", "R25"],
      reads: record.reads,
    };
    await info.attach("native-accountability-readbacks", {
      body: JSON.stringify(witness, null, 2),
      contentType: "application/json",
    });
  });
  expect(browserFailures).toEqual([]);
});

test("Communication T02 independent tabs cannot borrow another claim or reservation token", async ({
  page,
  browser,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const record = recorder(daemon, info);
  for (const [id, actorId] of [
    ["owner-run", "fixture-author"],
    ["peer-run", "human"],
  ] as const)
    await record.write("run.register", {
      target_run_id: id,
      actor_id: actorId,
      objective: "Actual disposable two-tab communication qualification",
      capabilities: [],
    });
  await record.write("ticket.claim", {
    ticket_id: "design",
    run_id: "owner-run",
    expected_revision: text(
      object((await record.native("ticket.read", { ticket_id: "design" })).ticket).revision,
    ),
  });
  await record.write("reservation.acquire", {
    target_run_id: "owner-run",
    run_id: "owner-run",
    requests: [{ reservation_id: "comms-shared", mode: "exclusive" }],
  });
  await connect(page, companion, daemon);
  const work = "work?connection=local&workspace=demo&project=release&entity=design";
  const participants = "participants?connection=local&workspace=demo&project=release";
  await navigate(page, companion, participants);
  await actor(page, "fixture-author", "owner-run");
  await withPeer(browser, companion, info, async (peer) => {
    await navigate(peer, companion, work);
    await actor(peer, "human", "peer-run");
    await expect(peer.getByLabel("Ticket action", { exact: true })).toBeVisible();
    await peer.getByLabel("Action group", { exact: true }).selectOption("ownership");
    await peer.getByLabel("Ticket action", { exact: true }).selectOption("ticket.release");
    await peer.getByRole("button", { name: "Open action form", exact: true }).click();
    const release = peer.getByRole("dialog", { name: "Release own claim", exact: true });
    await release.getByRole("button", { name: "Review action", exact: true }).click();
    await expect(
      release.getByRole("alert").filter({ hasText: "exact captured claim owner and run" }),
    ).toBeVisible();
    const ticket = object((await record.native("ticket.read", { ticket_id: "design" })).ticket);
    expect(object(ticket.claim).actor_id).toBe("fixture-author");
    expect(object(ticket.claim).run_id).toBe("owner-run");
    expect(object(ticket.claim).token).toBe("1");
    await shot(peer, info, "other-owner-claim-unavailable");
    await peer.getByRole("button", { name: "Hide editor; keep draft", exact: true }).click();
    await navigate(peer, companion, participants);
    const peerRoot = peer.locator(".wg-coordination"),
      ownerRoot = page.locator(".wg-coordination");
    for (const root of [peerRoot, ownerRoot])
      await root.getByRole("button", { name: "Reservations", exact: true }).click();
    const held = (root: Locator) =>
      root.locator(".wg-coord-record").filter({ hasText: "comms-shared" });
    await held(peerRoot).getByRole("button", { name: "Release hold", exact: true }).click();
    const draft = peerRoot.getByRole("complementary", { name: "Retained coordination forms" });
    await draft.getByRole("button", { name: "Review", exact: true }).click();
    await expect(
      draft.getByRole("alert").filter({ hasText: "observed token alone is not ownership" }),
    ).toBeVisible();
    const before = await record.native("reservation.get", { reservation_id: "comms-shared" });
    expect(before.holders).toEqual([
      expect.objectContaining({ actor_id: "fixture-author", run_id: "owner-run", token: "1" }),
    ]);
    await shot(peer, info, "other-owner-reservation-unavailable");
    await held(ownerRoot).getByRole("button", { name: "Release hold", exact: true }).click();
    const own = ownerRoot.getByRole("complementary", { name: "Retained coordination forms" });
    await own.getByRole("button", { name: "Review", exact: true }).click();
    await own.getByRole("button", { name: "Execute saved request", exact: true }).click();
    await expect(own.getByRole("status").filter({ hasText: /^committed$/u })).toBeVisible();
    expect(
      (await record.native("reservation.get", { reservation_id: "comms-shared" })).holders,
    ).toEqual([]);
    await peerRoot.getByRole("button", { name: "Refresh records", exact: true }).click();
    await expect(
      held(peerRoot).getByText("No current holders in this capture", { exact: false }),
    ).toBeVisible();
    expect(
      object(object((await record.native("ticket.read", { ticket_id: "design" })).ticket).claim)
        .token,
    ).toBe("1");
    const witness: CommunicationWitness = {
      scenario: "independent-ownership-tabs",
      requirements: ["R04", "R14", "R25"],
      reads: record.reads,
    };
    await info.attach("native-ownership-readbacks", {
      body: JSON.stringify(witness, null, 2),
      contentType: "application/json",
    });
  });
  expect(browserFailures).toEqual([]);
});
