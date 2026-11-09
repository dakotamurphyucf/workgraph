import { writeFile } from "node:fs/promises";
import { test, expect } from "../e2e/support/fixtures";
import type { Page, TestInfo } from "@playwright/test";
import type { CompanionFixture } from "../../../test-support/companion-fixture.mjs";
import type { DaemonFixture } from "../../../test-support/daemon-fixture.mjs";

test.use({ colorScheme: "dark", viewport: { width: 1600, height: 1000 } });

async function mount(
  page: Page,
  companion: CompanionFixture,
  socket: string,
  entity: string | null = null,
) {
  const bootstrap = await page.request.get(companion.url);
  expect(bootstrap.status()).toBe(200);
  const matches = [
      ...(await bootstrap.text()).matchAll(
        /<meta name="workgraph-capability" content="([a-f0-9]{64})"/gu,
      ),
    ],
    capability = matches[0]?.[1];
  if (matches.length !== 1 || !capability) throw new Error("Missing exact native capability");
  for (const [endpoint, body] of [
    ["/connections", { id: "local", label: "Synthetic work qualification", socket }],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const response = await page.request.post(new URL(`/ui-api/v1${endpoint}`, companion.url).href, {
      headers: { "X-Workgraph-UI-Capability": capability, Origin: new URL(companion.url).origin },
      data: body,
    });
    expect(response.status()).toBe(200);
    await response.text();
  }
  await page.goto(
    new URL(
      `/#/work?connection=local&workspace=demo&project=release${entity === null ? "" : `&entity=${entity}`}`,
      companion.url,
    ).href,
  );
  await expect(page.getByRole("heading", { name: "Work", exact: true })).toBeVisible();
}
async function capture(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.getElementById("wg-content")?.scrollTo(0, 0);
  });
  const file = info.outputPath(name);
  await page.screenshot({ path: file, fullPage: true });
  await info.attach(name, { path: file, contentType: "image/png" });
}
function writer(daemon: DaemonFixture) {
  let serial = 0;
  return async (method: string, params: Record<string, unknown>) =>
    daemon.call(
      method,
      JSON.stringify({
        workspace_id: "demo",
        actor_id: "fixture-author",
        mutation_id: `work-browser-${++serial}`,
        ...params,
      }),
    );
}
async function read(daemon: DaemonFixture, ticket_id: string) {
  const source = await daemon.call(
    "ticket.read",
    JSON.stringify({ workspace_id: "demo", ticket_id, max_bytes: "1048576" }),
  );
  // Synthetic fixed protocol record only; arbitrary payloads remain lossless in production.
  return (
    JSON.parse(source) as {
      result: {
        data: {
          ticket: {
            ticket_id: string;
            revision: string;
            status: string;
            claim: { token: string } | null;
          };
        };
      };
    }
  ).result.data.ticket;
}

test("native Work complete board, growing list, full title, passive rich instructions and empty query", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  test.setTimeout(60000);
  const write = writer(daemon);
  const fullTitle =
    "Refine the complete Work inspector title — 雪 — with exact source relationships and carefully aligned typography across a busy project without clipping important context";
  await write("ticket.update", {
    ticket_id: "build",
    expected_revision: (await read(daemon, "build")).revision,
    title: fullTitle,
    description:
      "## Synthetic instructions\n\nRead **every** requirement.\n\n```ocaml\nlet untouched = 42\n```\n\n<script>window.workPayloadExecuted = true</script>\n\n![No fetch](https://invalid.example/synthetic.png)",
  });
  for (let index = 0; index < 40; index++)
    await write("ticket.create", {
      ticket_id: `busy-${index}`,
      project_id: "release",
      title: `Synthetic busy project item ${index}`,
    });
  await mount(page, companion, daemon.socket);
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await expect(page.locator(".work-ticket")).toHaveCount(43);
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "List", exact: true }).click();
  const todo = page.getByRole("region", { name: "To do tickets", exact: true });
  await expect(todo.locator(".work-ticket")).toHaveCount(20);
  await todo.getByRole("button", { name: /Load more to do/ }).click();
  await expect(todo.locator(".work-ticket")).toHaveCount(40);
  await capture(page, info, "work-busy-list-dark.png");
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByLabel("Search tickets", { exact: true }).fill("Refine the complete");
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  await expect(page.locator(".work-ticket")).toHaveCount(1);
  await page.locator(".work-ticket").click();
  await expect(page.locator(".work-inspector-title")).toHaveText(fullTitle);
  await expect(
    page
      .locator(".wg-rich-content")
      .getByRole("heading", { name: "Synthetic instructions", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".wg-rich-content .wg-code-block code")).toContainText(
    "let untouched = 42",
  );
  expect(await page.evaluate(() => Object.hasOwn(window, "workPayloadExecuted"))).toBe(false);
  await capture(page, info, "work-dense-list-inspector-dark.png");
  await page.getByRole("button", { name: "Close inspector", exact: true }).click();
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page
    .getByLabel("Search tickets", { exact: true })
    .fill("no-synthetic-ticket-matches-this-query");
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No tickets match this query", exact: true }),
  ).toBeVisible();
  expect(browserFailures).toEqual([]);
});

test("native readiness board offers computed-rule action without mutation and source parent navigation", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  await write("ticket.create", {
    ticket_id: "child",
    project_id: "release",
    parent_ticket_id: "review",
    title: "Synthetic inherited blocker with source parent",
  });
  await write("ticket.create", {
    ticket_id: "ready-second",
    project_id: "release",
    title: "Synthetic ready ticket for same-column drag",
  });
  await write("ticket.hierarchy.put", {
    ticket_id: "review",
    expected_revision: "0",
    descendant_prerequisites: "inherit",
    child_completion: "all_done",
    reason: "Synthetic explicit source rule for browser qualification",
  });
  await mount(page, companion, daemon.socket);
  const dragEvents: string[] = [];
  page.on("console", (message) => {
    if (message.text().startsWith("work-drag-evidence:")) dragEvents.push(message.text());
  });
  await page.evaluate(() => {
    for (const kind of ["dragstart", "drop", "dragend"]) {
      document.addEventListener(kind, (event) => {
        const target = event.target instanceof Element ? event.target.closest("button") : null;
        console.info(
          "work-drag-evidence:" +
            JSON.stringify({
              kind,
              target: target?.getAttribute("aria-label"),
              payload:
                event instanceof DragEvent
                  ? event.dataTransfer?.getData("application/x-workgraph-ticket")
                  : null,
            }),
        );
      });
    }
  });
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await page.getByLabel("Group tickets", { exact: true }).selectOption("readiness");
  await page.getByRole("button", { name: "Assess loaded page", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Assessing loaded tickets…", exact: true }),
  ).toHaveCount(0);
  const before = await read(daemon, "child");
  let operations = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.startsWith("/ui-api/v1/operations")
    )
      operations++;
  });
  const card = page.getByRole("button", {
    name: /Open .*Synthetic inherited blocker with source parent/u,
  });
  await card.dragTo(
    page
      .getByRole("region", { name: "Graph ready tickets", exact: true })
      .getByRole("button", { name: /Open .*Clarify the workflow/u }),
  );
  const dragFile = info.outputPath("actual-drag-events.json");
  await writeFile(dragFile, JSON.stringify(dragEvents, null, 2));
  await info.attach("actual-drag-events", { path: dragFile, contentType: "application/json" });
  await expect(page.locator(".wg-inspector-header")).toContainText("child");
  await expect(
    page.locator(".wg-inspector-header").getByRole("heading", {
      name: "Synthetic inherited blocker with source parent",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Readiness action required", exact: true }),
  ).toBeVisible();
  expect(await read(daemon, "child")).toEqual(before);
  expect(operations).toBe(0);
  await page.getByRole("button", { name: "Links", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Open source parent review", exact: true }),
  ).toBeVisible();
  await capture(page, info, "work-readiness-board-source-rule-dark.png");
  await page.getByRole("button", { name: "Open source parent review", exact: true }).click();
  await expect(
    page.locator(".wg-inspector-header").getByRole("heading", {
      name: "Review the exact implementation and browser evidence",
      exact: true,
    }),
  ).toBeVisible();
  // A normal drop over another card in the same computed column must retain the source ticket.
  await page
    .getByRole("button", { name: /Open .*Synthetic ready ticket for same-column drag/u })
    .dragTo(
      page
        .getByRole("region", { name: "Graph ready tickets", exact: true })
        .getByRole("button", { name: /Open .*Clarify the workflow/u }),
    );
  await expect(
    page
      .locator(".wg-inspector-header")
      .getByRole("heading", { name: "Synthetic ready ticket for same-column drag", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".work-action-offer")).toContainText("ready-second");
  expect(operations).toBe(0);
  await writeFile(dragFile, JSON.stringify(dragEvents, null, 2));
  expect(browserFailures).toEqual([]);
});

test("native context section continuation retains header/siblings and completion distinctions", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  test.setTimeout(60000);
  const write = writer(daemon);
  await write("ticket.claim", { ticket_id: "design" });
  const token = (await read(daemon, "design")).claim?.token;
  if (!token) throw new Error("Fixture claim missing");
  for (let index = 0; index < 25; index++)
    await write("ticket.progress", {
      ticket_id: "design",
      token,
      body: `Synthetic progress update ${index}`,
    });
  await write("ticket.create", {
    ticket_id: "child",
    project_id: "release",
    parent_ticket_id: "design",
    title: "Synthetic unfinished child",
  });
  await mount(page, companion, daemon.socket, "design");
  await expect(
    page
      .locator(".wg-inspector-header")
      .getByRole("heading", { name: "Clarify the workflow and ownership rules", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  const updates = page
    .locator(".work-context-section")
    .filter({ has: page.getByRole("heading", { name: "Progress updates", exact: true }) });
  await expect(updates.getByText("20 loaded · 5 remaining", { exact: true })).toBeVisible();
  await updates.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(updates.getByText("5 loaded · 0 remaining", { exact: true })).toBeVisible();
  await expect(updates.getByText("Synthetic progress update 24", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Completion", exact: true }).click();
  await expect(
    page.getByText("Unfinished children: 1 · blocked prerequisites: 0", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Unmet completion gate", { exact: true })).toBeVisible();
  await capture(page, info, "work-completion-gates-dark.png");
  await page.getByRole("button", { name: "Links", exact: true }).click();
  await expect(
    page.locator(".wg-inspector").getByRole("button", { name: /Synthetic unfinished child/u }),
  ).toBeVisible();
  expect(browserFailures).toEqual([]);
});

test("native assessment preserves candidate identity across actor switch and presentation survives route remount", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  await mount(page, companion, daemon.socket, "build");
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill("fixture-author");
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  await page.getByRole("button", { name: "Who can work", exact: true }).click();
  await page.getByRole("button", { name: "Assess candidate fixture-author", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Candidate assessment · fixture-author · no capabilities supplied",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText(/Unknown checks:/u)).toBeVisible();
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill("human");
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Candidate assessment · fixture-author · no capabilities supplied",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Assess candidate human", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Appearance settings", exact: true }).click();
  await page.getByLabel("Theme", { exact: true }).selectOption("light");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await capture(page, info, "work-captured-candidate-light.png");
  await page.getByRole("button", { name: "Close inspector", exact: true }).click();
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await page.getByLabel("Group tickets", { exact: true }).selectOption("priority");
  await page.getByRole("link", { name: "Advanced", exact: true }).click();
  await page.getByRole("link", { name: "Work", exact: true }).click();
  await expect(page.getByRole("button", { name: "Board", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByLabel("Group tickets", { exact: true })).toHaveValue("priority");
  expect(browserFailures).toEqual([]);
});
