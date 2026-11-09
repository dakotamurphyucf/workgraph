import { waitForPageReads } from "../../e2e/support/readiness";
import type { Page, TestInfo } from "@playwright/test";
import { test, expect } from "../../e2e/support/fixtures";
import {
  startDaemonFixture,
  fixtureBinary,
  type DaemonFixture,
} from "../../../../test-support/daemon-fixture.mjs";
import type { CompanionFixture } from "../../../../test-support/companion-fixture.mjs";
function writer(daemon: DaemonFixture) {
  let serial = 0;
  return async (method: string, params: Record<string, unknown>) => {
    const value: unknown = JSON.parse(
      await daemon.call(
        method,
        JSON.stringify({
          workspace_id: "demo",
          actor_id: "fixture-author",
          mutation_id: `scope-${++serial}`,
          ...params,
        }),
      ),
    );
    if (typeof value !== "object" || value === null || !("result" in value))
      throw new Error(JSON.stringify(value));
    return value;
  };
}
async function configure(page: Page, companion: CompanionFixture, daemon: DaemonFixture) {
  const capability = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(
    await (await page.request.get(companion.url)).text(),
  )?.[1];
  if (!capability) throw new Error("Actual bootstrap capability missing");
  const headers = {
    Origin: new URL(companion.url).origin,
    "X-Workgraph-UI-Capability": capability,
  };
  const create = await page.request.post(new URL("/ui-api/v1/connections", companion.url).href, {
    headers,
    data: { id: "local", label: "Recorded planning fixture", socket: daemon.socket },
  });
  expect(create.status()).toBe(200);
  await create.text();
  return headers;
}
const sessionHash = "#/history?connection=local&workspace=demo&entity=scopes";
async function history(page: Page, companion: CompanionFixture) {
  await page.goto(new URL(`/${sessionHash}`, companion.url).href);
  await expect(page.getByRole("button", { name: "project:release", exact: true })).toBeVisible();
  await waitForPageReads(page);
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  await expect(page.getByRole("heading", { name: "Preparing content", exact: true })).toHaveCount(
    0,
  );
  await page.evaluate(() => {
    for (const node of document.querySelectorAll<HTMLElement>(".wg-content")) node.scrollTop = 0;
  });
  const file = info.outputPath(`${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  await info.attach(name, { path: file, contentType: "image/png" });
}
async function seed(daemon: DaemonFixture, suffix = "original") {
  const write = writer(daemon);
  await write("workspace.update", {
    expected_revision: "0",
    name: `Workspace ${suffix}`,
    description: `Workspace description ${suffix}`,
    summary: "Recorded workspace summary",
    instructions: "Workspace instructions",
  });
  await write("project.update", {
    project_id: "release",
    expected_revision: "1",
    title: `Project ${suffix}`,
    description: `Project description ${suffix}`,
    summary: "Recorded project summary",
    acceptance_criteria: "Project acceptance",
  });
  await write("milestone.create", {
    milestone_id: "checkpoint",
    project_id: "release",
    title: `Milestone ${suffix}`,
    description: `Milestone description ${suffix}`,
  });
  await write("ticket.create", {
    ticket_id: "target-ticket",
    project_id: "release",
    title: `Ticket ${suffix}`,
    description: `Ticket description ${suffix}`,
  });
  await write("session.create", {
    session_id: "scopes",
    title: "Recorded planning associations",
    scopes: [
      { kind: "workspace" },
      { kind: "project", id: "release" },
      { kind: "milestone", id: "checkpoint" },
      { kind: "ticket", id: "target-ticket" },
    ],
  });
  return write;
}
test("History all four planning associations open useful exact read-only details, refresh and same-document back/forward", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  await seed(daemon);
  await configure(page, companion, daemon);
  await history(page, companion);
  const documents: string[] = [],
    writes: string[] = [];
  page.on("request", (request) => {
    if (request.isNavigationRequest()) documents.push(request.url());
    if (/\/ui-api\/v1\/(operations|daemon-launches|administration)/u.test(request.url()))
      writes.push(request.url());
  });
  for (const [label, kind, title, body] of [
    ["Workspace", "workspace", "Workspace original", "Workspace description original"],
    ["project:release", "project", "Project original", "Project description original"],
    ["milestone:checkpoint", "milestone", "Milestone original", "Milestone description original"],
    ["ticket:target-ticket", "ticket", "Ticket original", "Ticket description original"],
  ] as const) {
    await page.getByRole("button", { name: label, exact: true }).click();
    const target = page.getByRole("article", { name: `Recorded ${kind} target`, exact: true });
    await expect(target.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(target.getByText(body, { exact: true })).toBeVisible();
    await expect(target.getByText(/not a historical planning snapshot/u)).toBeVisible();
    expect(page.url()).toContain("planning_generation=1");
    await page.getByRole("button", { name: "Refresh target", exact: true }).click();
    await expect(target.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await waitForPageReads(page);
    await expect(target.getByText(body, { exact: true })).toBeVisible();
    if (kind === "ticket") await screenshot(page, info, "recorded-ticket-detail");
    await page.goBack();
    await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
  }
  await page.goForward();
  await expect(page.getByRole("article", { name: "Recorded ticket target" })).toBeVisible();
  expect(documents).toEqual([]);
  expect(writes).toEqual([]);
  await page
    .getByRole("navigation", { name: "Primary", exact: true })
    .getByRole("link", { name: "Work", exact: true })
    .click();
  await expect(page.getByLabel("Ticket query", { exact: true })).toBeVisible();
  expect(page.url()).not.toContain("planning_kind");
  expect(browserFailures).toEqual([]);
});
test("retargeted profile retains original endpoint despite same IDs; missing record and missing generation fail explicitly", async ({
  page,
  daemon,
  companion,
  browserFailures,
  browserDiagnostics,
}, info) => {
  await seed(daemon);
  const headers = await configure(page, companion, daemon);
  const second = await startDaemonFixture({ binary: fixtureBinary() });
  try {
    await seed(second, "replacement");
    const captured = JSON.parse(
      await daemon.call(
        "session.get",
        JSON.stringify({ workspace_id: "demo", session_id: "scopes" }),
      ),
    ) as {
      readonly result: {
        readonly meta: { readonly history_capture: { readonly head: string | null } };
      };
    };
    const head = captured.result.meta.history_capture.head;
    if (head === null || !/^[a-f0-9]{64}$/u.test(head))
      throw new Error("Actual created-session capture head missing");
    await page.goto(new URL(`/${sessionHash}&generation=1&head=${head}`, companion.url).href);
    await expect(page.getByRole("button", { name: "project:release", exact: true })).toBeVisible();
    await waitForPageReads(page);
    const changed = await page.request.put(
      new URL("/ui-api/v1/connections/local", companion.url).href,
      {
        headers,
        data: { expected_generation: "1", label: "Replacement endpoint", socket: second.socket },
      },
    );
    expect(changed.status()).toBe(200);
    await changed.text();
    await page.getByRole("button", { name: "Refresh connection", exact: true }).click();
    await expect(
      page.getByText("Replacement endpoint · generation 2", { exact: true }),
    ).toBeVisible();
    await waitForPageReads(page);
    const observed: { method: string; generation: string }[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/ui-api/v1/read")) {
        const data = request.postDataJSON() as { method: string; generation: string };
        observed.push({ method: data.method, generation: data.generation });
      }
    });
    // Follow the actual recorded association after the profile directory retarget.
    await page.getByRole("button", { name: "project:release", exact: true }).click();
    const target = page.getByRole("article", { name: "Recorded project target" });
    await expect(
      target.getByRole("heading", { name: "Project original", exact: true }),
    ).toBeVisible();
    await expect(
      target.getByText(/Recorded endpoint generation 1; the profile now selects generation 2/u),
    ).toBeVisible();
    await expect(target.getByText("Project replacement", { exact: true })).toHaveCount(0);
    await waitForPageReads(page);
    expect(observed.filter((value) => value.method === "project.get")).toEqual([
      { method: "project.get", generation: "1" },
    ]);
    await page.reload();
    await expect(
      target.getByRole("heading", { name: "Project original", exact: true }),
    ).toBeVisible();
    await screenshot(page, info, "retained-endpoint-detail");
    const url = new URL("/ui-api/v1/read", companion.url).href;
    browserDiagnostics.expectedHTTP.set(url, 404);
    const missing = page.waitForResponse(
      (response) => response.url() === url && response.status() === 404,
    );
    await page.evaluate(() => {
      window.location.hash =
        "#/work?connection=local&workspace=demo&entity=absent-ticket&planning_kind=ticket&planning_generation=1";
    });
    const rejected = await missing;
    expect(rejected.request().postDataJSON()).toMatchObject({
      generation: "1",
      method: "ticket.read",
      params: { workspace_id: "demo", ticket_id: "absent-ticket" },
    });
    expect(await rejected.text()).toContain("Not_found");
    await expect(
      page.getByRole("heading", { name: "Recorded target unavailable", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("article", { name: "Recorded project target" })).toHaveCount(0);
    browserDiagnostics.expectedHTTP.delete(url);
    const profileURL = new URL("/ui-api/v1/connections/local/generations/999", companion.url).href;
    browserDiagnostics.expectedHTTP.set(profileURL, 404);
    const priorReads = observed.length;
    const noProfile = page.waitForResponse((response) => response.url() === profileURL);
    await page.evaluate(() => {
      window.location.hash =
        "#/overview?connection=local&workspace=demo&planning_kind=workspace&planning_generation=999";
    });
    expect((await noProfile).status()).toBe(404);
    await expect(
      page.getByRole("heading", { name: "Recorded target unavailable", exact: true }),
    ).toBeVisible();
    await screenshot(page, info, "missing-retained-profile");
    await waitForPageReads(page);
    expect(observed).toHaveLength(priorReads);
    expect(browserFailures).toEqual([]);
  } finally {
    await second.dispose();
  }
});
test("actual originating-run and immutable resource-version History navigation remain composed alongside scope links", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = await seed(daemon);
  await write("run.register", {
    target_run_id: "recorded-run",
    objective: "Original recorded invocation",
  });
  await write("session.create", {
    session_id: "links",
    title: "Run, planning and resource links",
    run_id: "recorded-run",
    scopes: [{ kind: "ticket", id: "target-ticket" }],
  });
  await write("session.append", {
    session_id: "links",
    run_id: "recorded-run",
    events: [
      {
        client_id: "artifact",
        role: "sensor",
        kind: "artifact",
        phase: "recorded",
        payload: {
          kind: "inline",
          bytes_base64: Buffer.from("Recorded source").toString("base64"),
        },
        resource_versions: [{ resource_id: "notes", revision: "1" }],
      },
    ],
  });
  await write("resource.put_text", {
    resource_id: "notes",
    expected_revision: "2",
    title: "Changed current source",
    filename: "current.md",
    mime_type: "text/markdown",
    text: "# Current replacement must not replace v1",
  });
  await configure(page, companion, daemon);
  await page.goto(
    new URL("/#/history?connection=local&workspace=demo&entity=links", companion.url).href,
  );
  await page.getByRole("button", { name: "recorded-run", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Run recorded-run", exact: true })).toBeVisible();
  expect(page.url()).toContain("participant=run");
  await waitForPageReads(page);
  await page.goBack();
  const event = page.locator("#history-event-1");
  await event.getByRole("link", { name: "Exact event link", exact: true }).click();
  await event
    .getByRole("button", { name: "Resource notes · immutable content version 1", exact: true })
    .click();
  expect(page.url()).toContain("content_version=1");
  const content = page.getByRole("region", { name: "Content: notes.md · content v1", exact: true });
  await expect(
    content.getByRole("heading", { name: "Synthetic notes", exact: true }),
  ).toBeVisible();
  await expect(
    content.getByText("Current replacement must not replace v1", { exact: true }),
  ).toHaveCount(0);
  await screenshot(page, info, "preserved-exact-resource-version");
  expect(browserFailures).toEqual([]);
});
