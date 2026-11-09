import { waitForPageReads } from "../e2e/support/readiness";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { Locator, Page, TestInfo } from "@playwright/test";
import type { CompanionFixture } from "../../../test-support/companion-fixture.mjs";
import type { DaemonFixture } from "../../../test-support/daemon-fixture.mjs";
import { stringifyJson } from "../../src/core/json";
import type { HttpClient } from "../../src/core/protocol/http";
import { COMMANDS, commandDefinition } from "../../src/features/work/actions/commands";
import { preparation } from "../../src/features/work/actions/model";
import type { WorkCommand } from "../../src/features/work/actions/types";
import { createTestProcessor } from "../core/processing-harness";
import { test, expect } from "../e2e/support/fixtures";
import { validDraft } from "./actions-fixtures";

const execute = promisify(execFile);
test.use({ colorScheme: "dark", viewport: { width: 1600, height: 1000 }, actionTimeout: 10000 });

async function mount(page: Page, companion: CompanionFixture, socket: string, entity = "design") {
  const bootstrap = await page.request.get(companion.url);
  expect(bootstrap.status()).toBe(200);
  const matches = [
      ...(await bootstrap.text()).matchAll(
        /<meta name="workgraph-capability" content="([a-f0-9]{64})"/gu,
      ),
    ],
    capability = matches[0]?.[1];
  if (matches.length !== 1 || !capability) throw new Error("Missing exact native capability");
  for (const [path, body] of [
    ["/connections", { id: "local", label: "Synthetic ticket actions", socket }],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const response = await page.request.post(new URL(`/ui-api/v1${path}`, companion.url).href, {
      headers: { "X-Workgraph-UI-Capability": capability, Origin: new URL(companion.url).origin },
      data: body,
    });
    expect(response.status()).toBe(200);
    await response.text();
  }
  await page.goto(
    new URL(
      `/#/work?connection=local&workspace=demo&project=release&entity=${entity}`,
      companion.url,
    ).href,
  );
  await expect(page.getByRole("heading", { name: "Tickets", exact: true })).toBeVisible();
  await waitForPageReads(page);
  await actor(page, "fixture-author");
}
async function actor(page: Page, id: string, run = "") {
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill(id);
  await page.getByLabel("Run ID (optional)", { exact: true }).fill(run);
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  await waitForPageReads(page);
}
function writer(daemon: DaemonFixture) {
  let serial = 0;
  return (method: string, params: Record<string, unknown>) =>
    daemon.call(
      method,
      JSON.stringify({
        workspace_id: "demo",
        actor_id: "fixture-author",
        mutation_id: `action-browser-${++serial}`,
        ...params,
      }),
    );
}
interface TicketRecord {
  readonly ticket_id: string;
  readonly revision: string;
  readonly project_id: string | null;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly archived: boolean;
  readonly assignee_id: string | null;
  readonly label_ids: readonly string[];
  readonly status_id: string | null;
  readonly hold: { readonly reason: string } | null;
  readonly prerequisite_ticket_ids: readonly string[];
  readonly related_ticket_ids: readonly string[];
  readonly claim: {
    readonly actor_id: string;
    readonly run_id: string | null;
    readonly token: string;
    readonly lease: { readonly revision: string } | null;
  } | null;
}
async function read(daemon: DaemonFixture, ticket_id: string): Promise<TicketRecord> {
  // Only this test's fixed native ticket envelope, never arbitrary captured payloads.
  return (
    JSON.parse(
      await daemon.call(
        "ticket.read",
        JSON.stringify({ workspace_id: "demo", ticket_id, max_bytes: "1048576" }),
      ),
    ) as { result: { data: { ticket: TicketRecord } } }
  ).result.data.ticket;
}
async function refresh(page: Page) {
  await waitForPageReads(page);
  await page.getByRole("button", { name: "Refresh tickets", exact: true }).click();
  // Worker-backed decode may schedule detail reads after an idle HTTP interval.
  // Wait for actual captured selection, rather than ending the test while its daemon is still needed.
  if (new URLSearchParams(new URL(page.url()).hash.split("?")[1]).has("entity")) {
    await expect(
      page.getByRole("region", { name: "Selected ticket actions", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: /^Loading ticket/u })).toHaveCount(0);
  }
  await waitForPageReads(page);
}
async function open(page: Page, method: WorkCommand): Promise<Locator> {
  const definition = commandDefinition(method);
  if (definition.target === "new")
    await page.getByRole("button", { name: "New ticket", exact: true }).click();
  else if (definition.target === "workflow") {
    const details = page.locator(".work-workspace-actions");
    if (!(await details.evaluate((node) => (node as HTMLDetailsElement).open)))
      await details.locator("summary").click();
    await page.getByLabel("Workspace ticket metadata action", { exact: true }).selectOption(method);
    await page.getByRole("button", { name: "Open metadata form", exact: true }).click();
  } else {
    await page.getByLabel("Action group", { exact: true }).selectOption(definition.group);
    await page.getByLabel("Ticket action", { exact: true }).selectOption(method);
    await page.getByRole("button", { name: "Open action form", exact: true }).click();
  }
  const dialog = page.getByRole("dialog", { name: definition.title, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function reveal(field: Locator) {
  await expect(field).toBeAttached();
  while (!(await field.isVisible())) {
    const closed = field.locator("xpath=ancestor::details[not(@open)]").first();
    if ((await closed.count()) === 0) throw new Error("Control is hidden outside a disclosure.");
    await closed.locator(":scope > summary").click();
  }
}
async function set(
  dialog: Locator,
  label: string,
  value: string | null,
  optional = false,
  select = false,
) {
  if (
    optional ||
    value === null ||
    (await dialog.getByLabel(`${label} update`, { exact: true }).count()) > 0
  ) {
    const presence = dialog.getByLabel(`${label} update`, { exact: true });
    await reveal(presence);
    await presence.selectOption(value === null ? "null" : "value");
  }
  if (value !== null) {
    const field = dialog.getByLabel(label, { exact: true });
    await reveal(field);
    if (select) await field.selectOption(value);
    else await field.fill(value);
  }
}
async function captureAction(dialog: Locator) {
  await dialog.getByRole("button", { name: "Review action", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply action", exact: true })).toBeEnabled();
}
async function prepare(dialog: Locator) {
  // Review owns capture and native preparation; Apply remains a separate explicit action.
  await expect(dialog.getByRole("button", { name: "Apply action", exact: true })).toBeEnabled();
}
async function commit(dialog: Locator) {
  await captureAction(dialog);
  await prepare(dialog);
  await dialog.getByRole("button", { name: "Apply action", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: /^committed$/u })).toBeVisible();
}
async function close(page: Page, dialog: Locator) {
  await dialog
    .getByRole("button", { name: "Close editor; keep captured intention", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await refresh(page);
}
async function load(dialog: Locator) {
  await dialog.getByRole("button", { name: "Load referenced record", exact: true }).click();
  await expect(dialog.getByText("Exact loaded reference", { exact: true })).toBeVisible();
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(name);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: "image/png" });
}

test("all 25 complete generated forms match fresh native schemas, optional/null variants and strict unknown fields", async ({
  daemon,
}, info) => {
  const processing = createTestProcessor(),
    client: HttpClient = {
      processing,
      request: () => Promise.reject(new Error("Parity must not send HTTP")),
    };
  try {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
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
    const evidence = [];
    for (const { method } of COMMANDS) {
      const { stdout } = await execute(daemon.binary, ["schema", method], {
          maxBuffer: 8 * 1024 * 1024,
        }),
        schema = (JSON.parse(stdout) as { methods: { params: object }[] }).methods[0]?.params;
      if (schema === undefined) throw new Error(`No native schema: ${method}`);
      const validate = ajv.compile(schema),
        original = validDraft(client, method),
        variants = [original];
      for (const field of commandDefinition(method).fields)
        if (field.kind === "scalar" && (field.optional || field.nullable)) {
          const input = original.inputs[field.name];
          if (input?.kind !== "scalar") throw new Error("Missing scalar fixture");
          for (const presence of [
            ...(field.optional ? ["omit" as const] : []),
            ...(field.nullable ? ["null" as const] : []),
          ])
            variants.push({
              ...original,
              inputs: {
                ...original.inputs,
                [field.name]: { ...input, presence },
                ...(method === "ticket.reassign" &&
                field.name === "claimant_id" &&
                presence === "null"
                  ? {
                      claimant_run_id: {
                        kind: "scalar" as const,
                        presence: "omit" as const,
                        text: "",
                      },
                    }
                  : {}),
              },
            });
        }
      // Resource-backed amendment projection is a separate exact source variant.
      if (method === "ticket.amendment.publish")
        variants.push({
          ...original,
          inputs: {
            ...original.inputs,
            source_kind: { kind: "scalar", presence: "value", text: "resource" },
          },
        });
      for (const variant of variants) {
        const encoded = stringifyJson(preparation(variant).params);
        if (!encoded.ok) throw new Error(encoded.error.message);
        const params: Record<string, unknown> = {
          ...(JSON.parse(encoded.value) as Record<string, unknown>),
          mutation_id: "native-parity",
        };
        expect(validate(params), `${method}: ${JSON.stringify(validate.errors)}`).toBe(true);
        expect(
          validate({ ...params, unsupported_guard: "1" }),
          `${method} rejects unknown fields`,
        ).toBe(false);
      }
      evidence.push({
        method,
        variants: variants.length,
        schema_sha256: createHash("sha256").update(stdout).digest("hex"),
      });
    }
    await info.attach("native-schema-parity.json", {
      body: JSON.stringify({ binary: daemon.binary, evidence }, null, 2),
      contentType: "application/json",
    });
  } finally {
    processing.dispose();
  }
});

test("native ticket creation, exact metadata replacement, reusable records, hold, move, archive and reopen", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  test.setTimeout(120000);
  const write = writer(daemon);
  await write("actor.put", {
    target_actor_id: "human",
    expected_revision: "0",
    kind: "person",
    name: "Synthetic human reviewer",
  });
  await write("project.create", { project_id: "destination", title: "Synthetic destination" });
  await mount(page, companion, daemon.socket);
  let dialog = await open(page, "label.put");
  await set(dialog, "Label ID", "qa-label");
  await set(dialog, "Name", "Quality review");
  await commit(dialog);
  await close(page, dialog);
  dialog = await open(page, "status.put");
  await set(dialog, "Status ID", "qa-status");
  await set(dialog, "Name", "Ready for review");
  await commit(dialog);
  await close(page, dialog);
  dialog = await open(page, "label.put");
  await dialog.getByRole("button", { name: "Load referenced record", exact: true }).click();
  await dialog.getByRole("button", { name: "Use qa-label", exact: true }).click();
  await expect(dialog.getByLabel("Create or edit", { exact: true })).toHaveValue("loaded");
  await set(dialog, "Name", "Quality evidence");
  await commit(dialog);
  await close(page, dialog);
  dialog = await open(page, "status.put");
  await dialog.getByRole("button", { name: "Load referenced record", exact: true }).click();
  await dialog.getByRole("button", { name: "Use qa-status", exact: true }).click();
  await expect(dialog.getByLabel("Create or edit", { exact: true })).toHaveValue("loaded");
  await set(dialog, "Name", "Exact review status");
  await commit(dialog);
  await close(page, dialog);
  await page.getByRole("button", { name: "Close inspector", exact: true }).click();
  dialog = await open(page, "ticket.create");
  await set(dialog, "Ticket ID (optional)", "created", true);
  await set(dialog, "Title", "Synthetic polished ticket workflow");
  await set(dialog, "Description", "## Exact instructions\n\nPreserve 雪 and source bytes.");
  await set(dialog, "Project", "release", true);
  await commit(dialog);
  await screenshot(page, info, "ticket-created-dark.png");
  await close(page, dialog);
  await page
    .locator(".work-ticket")
    .filter({ hasText: "Synthetic polished ticket workflow" })
    .click();
  dialog = await open(page, "ticket.update");
  await set(dialog, "Title", "Synthetic revised title", true);
  await commit(dialog);
  await close(page, dialog);
  dialog = await open(page, "ticket.metadata");
  await set(dialog, "Assigned actor", "human", true);
  await set(dialog, "Label IDs, one per line", "qa-label", true);
  await set(dialog, "Named status", "qa-status", true);
  await set(dialog, "Acceptance criteria", "Exact native metadata is observable.", true);
  await commit(dialog);
  await close(page, dialog);
  expect(await read(daemon, "created")).toMatchObject({
    assignee_id: "human",
    label_ids: ["qa-label"],
    status_id: "qa-status",
  });
  dialog = await open(page, "ticket.metadata");
  await set(dialog, "Assigned actor", null, true);
  await set(dialog, "Named status", null, true);
  await set(dialog, "Label IDs, one per line", "", true);
  await commit(dialog);
  await close(page, dialog);
  expect(await read(daemon, "created")).toMatchObject({
    assignee_id: null,
    status_id: null,
    label_ids: [],
  });
  dialog = await open(page, "ticket.hold");
  await set(dialog, "Reason", "Await synthetic review");
  await commit(dialog);
  await close(page, dialog);
  dialog = await open(page, "ticket.hold");
  await set(dialog, "Reason", null);
  await commit(dialog);
  await close(page, dialog);
  dialog = await open(page, "ticket.move");
  await set(dialog, "Destination project", "destination");
  await set(dialog, "Destination milestone", null);
  await set(dialog, "Destination parent", null);
  await commit(dialog);
  await close(page, dialog);
  expect((await read(daemon, "created")).project_id).toBe("destination");
  dialog = await open(page, "ticket.archive");
  await commit(dialog);
  await close(page, dialog);
  expect((await read(daemon, "created")).archived).toBe(true);
  dialog = await open(page, "ticket.archive");
  await set(dialog, "Archived", "false", false, true);
  await commit(dialog);
  await close(page, dialog);
  const claimed = JSON.parse(
    await write("ticket.claim", {
      ticket_id: "created",
      expected_revision: (await read(daemon, "created")).revision,
    }),
  ) as { result: { data: { token: string } } };
  await write("ticket.finish", {
    ticket_id: "created",
    token: claimed.result.data.token,
    evidence: "Synthetic fixture completion before reopen",
  });
  await refresh(page);
  dialog = await open(page, "ticket.reopen");
  await set(dialog, "Reason", "Newly reported synthetic requirement");
  await commit(dialog);
  await page.emulateMedia({ colorScheme: "light" });
  await screenshot(page, info, "ticket-reopened-light.png");
  await close(page, dialog);
  expect((await read(daemon, "created")).status).toBe("todo");
  await waitForPageReads(page);
  expect(browserFailures).toEqual([]);
});

test("native claim, timed renewal, release, start attempt, reassign and explicit expired recovery", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  test.setTimeout(120000);
  const write = writer(daemon);
  await write("run.register", {
    target_run_id: "synthetic-run",
    objective: "Synthetic UI ownership qualification",
  });
  await mount(page, companion, daemon.socket);
  let dialog = await open(page, "ticket.claim");
  await set(dialog, "Lease duration in milliseconds", "60000", true);
  await commit(dialog);
  await close(page, dialog);
  const initial = await read(daemon, "design");
  expect(initial.claim?.actor_id).toBe("fixture-author");
  dialog = await open(page, "ticket.renew_lease");
  await commit(dialog);
  await close(page, dialog);
  expect(BigInt((await read(daemon, "design")).claim?.lease?.revision ?? "0")).toBeGreaterThan(
    BigInt(initial.claim?.lease?.revision ?? "0"),
  );
  dialog = await open(page, "ticket.reassign");
  await set(dialog, "New claimant", "human");
  await set(dialog, "Reason", "Synthetic handoff without process control");
  await commit(dialog);
  await close(page, dialog);
  expect((await read(daemon, "design")).claim?.actor_id).toBe("human");
  dialog = await open(page, "ticket.release");
  await dialog.getByRole("button", { name: "Review action", exact: true }).click();
  await expect(
    dialog.getByRole("alert").filter({ hasText: "exact captured claim owner" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Discard unsent draft", exact: true }).click();
  await actor(page, "human");
  dialog = await open(page, "ticket.release");
  await commit(dialog);
  await close(page, dialog);
  await actor(page, "fixture-author", "synthetic-run");
  dialog = await open(page, "ticket.start");
  await set(dialog, "Attempt ID (optional)", "synthetic-attempt", true);
  await set(dialog, "Initial note", "Start only logical work, no process", true);
  await commit(dialog);
  await close(page, dialog);
  expect((await read(daemon, "design")).claim).toMatchObject({
    actor_id: "fixture-author",
    run_id: "synthetic-run",
  });
  dialog = await open(page, "ticket.release");
  await commit(dialog);
  await close(page, dialog);
  const attempt = JSON.parse(
    await daemon.call(
      "attempt.get",
      JSON.stringify({ workspace_id: "demo", attempt_id: "synthetic-attempt" }),
    ),
  ) as { result: { data: unknown } };
  expect(JSON.stringify(attempt.result.data)).toContain("cancelled");
  await actor(page, "fixture-author");
  await write("ticket.claim", {
    ticket_id: "design",
    expected_revision: (await read(daemon, "design")).revision,
    lease_duration_ms: "1",
  });
  await refresh(page);
  dialog = await open(page, "ticket.recover");
  await set(dialog, "Recovery audit ID", "synthetic-recovery");
  await set(dialog, "Reason", "Synthetic claim; no external execution was launched");
  await dialog.getByRole("button", { name: "Review action", exact: true }).click();
  await expect(
    dialog.getByRole("alert").filter({ hasText: "Confirm the prior execution" }),
  ).toBeVisible();
  await set(dialog, "I have actually stopped or isolated the prior execution", "yes", false, true);
  await set(dialog, "Ticket disposition", "requeue", false, true);
  await commit(dialog);
  await screenshot(page, info, "ticket-expired-recovery-dark.png");
  await close(page, dialog);
  expect((await read(daemon, "design")).claim).toBeNull();
  await waitForPageReads(page);
  expect(browserFailures).toEqual([]);
});

test("native typed hierarchy, logical paths, immutable amendment publish, exact own acknowledgement and withdrawal", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  test.setTimeout(120000);
  await mount(page, companion, daemon.socket);
  let dialog = await open(page, "ticket.hierarchy.put");
  await load(dialog);
  await set(dialog, "Descendant prerequisite rules", "inherit", false, true);
  await set(dialog, "Reason", "Explicit synthetic child policy");
  await commit(dialog);
  await close(page, dialog);
  dialog = await open(page, "ticket.paths.put");
  await set(dialog, "Create or edit", "new", false, true);
  await dialog.getByRole("button", { name: "Add logical path", exact: true }).click();
  await set(dialog, "Path 1 worktree", "synthetic-tree");
  await set(dialog, "Path 1 relative path", "src/feature");
  await set(dialog, "Require reservations on acquisition", "false", false, true);
  await commit(dialog);
  await close(page, dialog);
  dialog = await open(page, "ticket.paths.put");
  await load(dialog);
  await dialog.getByRole("button", { name: "Use loaded values", exact: true }).click();
  await expect(dialog.getByLabel("Path 1 relative path", { exact: true })).toHaveValue(
    "src/feature",
  );
  await set(dialog, "Path 1 relative path", "src/refined");
  await commit(dialog);
  await close(page, dialog);
  dialog = await open(page, "ticket.claim");
  await commit(dialog);
  await close(page, dialog);
  dialog = await open(page, "ticket.amendment.publish");
  await set(dialog, "Amendment ID", "synthetic-amendment");
  await set(dialog, "Title", "Refined exact instructions");
  await set(dialog, "Instruction text", "## New evidence\n\nPreserve exact amendment revision.");
  await commit(dialog);
  await close(page, dialog);
  dialog = await open(page, "ticket.amendment.acknowledge");
  await set(dialog, "Amendment ID", "synthetic-amendment");
  await load(dialog);
  await commit(dialog);
  await screenshot(page, info, "ticket-amendment-ack-dark.png");
  await close(page, dialog);
  dialog = await open(page, "ticket.amendment.withdraw");
  await set(dialog, "Amendment ID", "synthetic-amendment");
  await set(dialog, "Reason", "Superseded by synthetic review");
  await load(dialog);
  await commit(dialog);
  await close(page, dialog);
  const resource = JSON.parse(
    await daemon.call(
      "resource.get",
      JSON.stringify({ workspace_id: "demo", resource_id: "notes", max_bytes: "1048576" }),
    ),
  ) as { result: { data: { current_version: { revision: string; digest: string } } } };
  dialog = await open(page, "ticket.amendment.publish");
  await set(dialog, "Amendment ID", "synthetic-resource-amendment");
  await set(dialog, "Title", "Exact versioned source instructions");
  await set(dialog, "Instruction source", "resource", false, true);
  await set(dialog, "Resource ID", "notes", true);
  await set(dialog, "Resource version", resource.result.data.current_version.revision, true);
  await set(dialog, "Resource SHA-256", resource.result.data.current_version.digest, true);
  await set(dialog, "Require current claimant acknowledgement", "false", false, true);
  await commit(dialog);
  await close(page, dialog);
  await waitForPageReads(page);
  expect(browserFailures).toEqual([]);
});

test("cross-project relationship navigation captures actual target and stale requests retain their exact identity", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  test.setTimeout(120000);
  const write = writer(daemon);
  await write("project.create", { project_id: "other-project", title: "Synthetic other project" });
  await write("ticket.create", {
    ticket_id: "remote-target",
    project_id: "other-project",
    title: "Synthetic cross-project target",
  });
  await mount(page, companion, daemon.socket);
  let dialog = await open(page, "dependency.add");
  await set(dialog, "Prerequisite ticket ID", "remote-target");
  await commit(dialog);
  await close(page, dialog);
  dialog = await open(page, "dependency.waive");
  await set(dialog, "Prerequisite ticket ID", "remote-target");
  await set(dialog, "Reason", "Synthetic temporary waiver");
  await commit(dialog);
  await close(page, dialog);
  dialog = await open(page, "related.add");
  await set(dialog, "Related ticket ID", "remote-target");
  await load(dialog);
  await commit(dialog);
  await close(page, dialog);
  await page.getByRole("button", { name: "Links", exact: true }).click();
  await page
    .locator(".work-ticket-inspector")
    .getByRole("button", { name: "remote-target", exact: true })
    .first()
    .click();
  await expect(
    page
      .locator(".wg-inspector-header")
      .getByRole("heading", { name: "Synthetic cross-project target", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).hash).toContain("project=release");
  dialog = await open(page, "ticket.update");
  await expect(dialog.locator(".work-action-provenance")).toContainText("other-project");
  await set(dialog, "Title", "Cross-project guarded edit", true);
  await captureAction(dialog);
  await expect(dialog).toContainText("selected project other-project");
  await write("ticket.update", {
    ticket_id: "remote-target",
    expected_revision: (await read(daemon, "remote-target")).revision,
    title: "Concurrent synthetic update",
  });
  await prepare(dialog);
  await dialog.getByRole("button", { name: "Apply action", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: /^rejected$/u })).toBeVisible();
  await expect(dialog).toContainText("a new reviewed draft");
  await screenshot(page, info, "ticket-stale-cross-project-dark.png");
  await close(page, dialog);
  expect((await read(daemon, "remote-target")).title).toBe("Concurrent synthetic update");
  // The second relationship link reaches the same actual target; edits never inherit the route filter.
  await page.getByRole("button", { name: "Links", exact: true }).click();
  await page
    .locator(".work-ticket-inspector")
    .getByRole("button", { name: "design", exact: true })
    .click();
  await expect(
    page
      .locator(".wg-inspector-header")
      .getByRole("heading", { name: "Clarify the workflow and ownership rules", exact: true }),
  ).toBeVisible();
  await waitForPageReads(page);
  dialog = await open(page, "related.remove");
  await set(dialog, "Related ticket ID", "remote-target");
  await load(dialog);
  await commit(dialog);
  await close(page, dialog);
  dialog = await open(page, "dependency.remove");
  await set(dialog, "Prerequisite ticket ID", "remote-target");
  await commit(dialog);
  await close(page, dialog);
  expect((await read(daemon, "design")).related_ticket_ids).toEqual([]);
  expect((await read(daemon, "design")).prerequisite_ticket_ids).toEqual([]);
  dialog = await open(page, "ticket.metadata");
  await set(dialog, "Acceptance criteria", "Unsent draft survives remount and actor changes", true);
  await dialog.getByRole("button", { name: "Hide editor; keep draft", exact: true }).click();
  await page.getByRole("link", { name: "Advanced", exact: true }).click();
  await waitForPageReads(page);
  await actor(page, "human");
  await page.getByRole("link", { name: "Work", exact: true }).click();
  await waitForPageReads(page);
  const retained = await page
    .getByLabel("Open editor", { exact: true })
    .locator("option")
    .filter({ hasText: "Edit metadata and assignment" })
    .getAttribute("value");
  if (!retained) throw new Error("Retained editor is missing");
  await page.getByLabel("Open editor", { exact: true }).selectOption(retained);
  dialog = page.getByRole("dialog", { name: "Edit metadata and assignment", exact: true });
  await expect(dialog.getByLabel("Acceptance criteria", { exact: true })).toHaveValue(
    "Unsent draft survives remount and actor changes",
  );
  await expect(dialog.locator(".work-action-provenance")).toContainText("fixture-author");
  await waitForPageReads(page);
  expect(browserFailures).toEqual([]);
});

test("Ready board intent reviews computed checks and only offers an explicit existing hold change", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  await mount(page, companion, daemon.socket);
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await page.getByLabel("Group tickets", { exact: true }).selectOption("readiness");
  await page.getByRole("button", { name: "Assess loaded page", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Assessing loaded tickets…", exact: true }),
  ).toHaveCount(0);
  const build = page.getByRole("button", { name: /Open .*Implement the interface/u }),
    ready = page.getByRole("region", { name: "Graph ready tickets", exact: true });
  const design = page.getByRole("button", { name: /Open .*Clarify the workflow/u }),
    blocked = page.getByRole("region", { name: "Blocked tickets", exact: true });
  await design.dragTo(blocked.locator("header"));
  await page.getByRole("button", { name: "Review adding a hold", exact: true }).click();
  const adding = page.getByRole("dialog", { name: "Set or lift a hold", exact: true });
  await expect(adding.getByLabel("Reason update", { exact: true })).toHaveValue("value");
  await adding.getByRole("button", { name: "Review action", exact: true }).click();
  await expect(adding.getByRole("alert")).toContainText("Reason");
  await adding.getByRole("button", { name: "Discard unsent draft", exact: true }).click();
  await build.dragTo(ready.locator("header"));
  await expect(page.locator(".wg-inspector-header")).toContainText("build");
  await expect(
    page.getByRole("button", { name: "Review readiness checks", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Claim ticket", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Review readiness checks", exact: true }).click();
  await expect(page.getByRole("button", { name: "Who can work", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect((await read(daemon, "build")).claim).toBeNull();
  await write("ticket.hold", {
    ticket_id: "build",
    expected_revision: (await read(daemon, "build")).revision,
    reason: "Synthetic explicit hold",
  });
  await refresh(page);
  await build.dragTo(ready.locator("header"));
  await expect(
    page.getByRole("button", { name: "Review lifting hold", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Review lifting hold", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Set or lift a hold", exact: true });
  await expect(dialog.getByLabel("Reason update", { exact: true })).toHaveValue("null");
  await commit(dialog);
  await screenshot(page, info, "ticket-ready-explicit-hold-dark.png");
  expect((await read(daemon, "build")).claim).toBeNull();
  expect((await read(daemon, "build")).hold).toBeNull();
  await waitForPageReads(page);
  expect(browserFailures).toEqual([]);
});

/** Test-owned framing transport: forwards exact native bytes, loses one response only after a full upstream reply. */
async function lostReplyProxy(daemon: DaemonFixture) {
  const socket = join(daemon.root, "lost-reply"),
    connections = new Set<Socket>(),
    failures: string[] = [],
    updates: string[] = [],
    evidence: { method: string; request_sha256: string; response_sha256: string }[] = [];
  let armed = false;
  const server = createServer((client) => {
    const upstream = createConnection(daemon.socket);
    connections.add(client);
    connections.add(upstream);
    let request = Buffer.alloc(0),
      response = Buffer.alloc(0),
      drop = false,
      requestHash = "";
    for (const connection of [client, upstream]) {
      connection.on("close", () => connections.delete(connection));
      connection.on("error", (error) => {
        failures.push(error.message);
        client.destroy();
        upstream.destroy();
      });
    }
    client.on("data", (chunk: Buffer) => {
      upstream.write(chunk);
      request = Buffer.concat([request, chunk]);
      if (request.length >= 4 && request.length >= 4 + request.readUInt32BE(0)) {
        const length = request.readUInt32BE(0);
        if (length > 4194304) {
          failures.push("Unexpected oversized request");
          client.destroy();
          upstream.destroy();
          return;
        }
        const decoded = JSON.parse(request.subarray(4, 4 + length).toString("utf8")) as {
          method?: unknown;
        };
        if (decoded.method === "ticket.update")
          updates.push(
            createHash("sha256")
              .update(request.subarray(0, 4 + length))
              .digest("hex"),
          );
        if (armed && decoded.method === "ticket.update") {
          armed = false;
          drop = true;
          requestHash = createHash("sha256")
            .update(request.subarray(0, 4 + length))
            .digest("hex");
        }
      }
    });
    upstream.on("data", (chunk: Buffer) => {
      if (!drop) {
        client.write(chunk);
        return;
      }
      response = Buffer.concat([response, chunk]);
      if (response.length >= 4 && response.length >= 4 + response.readUInt32BE(0)) {
        evidence.push({
          method: "ticket.update",
          request_sha256: requestHash,
          response_sha256: createHash("sha256").update(response).digest("hex"),
        });
        client.end();
        upstream.end();
      }
    });
    client.on("end", () => upstream.end());
    upstream.on("end", () => client.end());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    socket,
    failures,
    evidence,
    updates,
    arm: () => {
      armed = true;
    },
    dispose: async () => {
      for (const connection of connections) connection.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

test("native lost reply retains exact saved intention; explicit receipt recovery observes one committed update", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  test.setTimeout(60000);
  const proxy = await lostReplyProxy(daemon);
  try {
    await mount(page, companion, proxy.socket);
    const original = await read(daemon, "design"),
      dialog = await open(page, "ticket.update");
    await set(dialog, "Title", "Synthetic durable lost-reply update", true);
    await captureAction(dialog);
    await prepare(dialog);
    proxy.arm();
    await dialog.getByRole("button", { name: "Apply action", exact: true }).click();
    await expect(
      dialog.getByRole("status").filter({ hasText: /^outcome_unknown$/u }),
    ).toBeVisible();
    const committed = await read(daemon, "design");
    expect(committed.title).toBe("Synthetic durable lost-reply update");
    expect(BigInt(committed.revision)).toBe(BigInt(original.revision) + 1n);
    expect(proxy.evidence).toHaveLength(1);
    expect(proxy.updates).toEqual([proxy.evidence[0]?.request_sha256]);
    await expect(
      dialog.getByRole("button", { name: "Retry exact saved request", exact: true }),
    ).toBeEnabled();
    await dialog.getByRole("button", { name: "Recover receipt", exact: true }).click();
    await expect(dialog.getByRole("status").filter({ hasText: /^committed$/u })).toBeVisible();
    expect((await read(daemon, "design")).revision).toBe(committed.revision);
    expect(proxy.evidence).toHaveLength(1);
    expect(proxy.updates).toHaveLength(1);
    await screenshot(page, info, "ticket-exact-receipt-recovery-dark.png");
    await info.attach("lost-reply-frames.json", {
      body: JSON.stringify(proxy.evidence, null, 2),
      contentType: "application/json",
    });
    expect(proxy.failures).toEqual([]);
    await waitForPageReads(page);
    expect(browserFailures).toEqual([]);
  } finally {
    await proxy.dispose();
  }
});
