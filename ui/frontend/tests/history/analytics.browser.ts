import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import { test as parityTest, type Page, type TestInfo } from "@playwright/test";
import { test, expect } from "../e2e/support/fixtures";
import { fixtureBinary, type DaemonFixture } from "../../../test-support/daemon-fixture.mjs";
import type { CompanionFixture } from "../../../test-support/companion-fixture.mjs";
import { stringifyJson, parseJsonText } from "../../src/core/json";
import * as c from "../../src/core/protocol/codec";
import * as d from "../../src/core/protocol/decoders";
import {
  searchInvocation,
  usageInvocation,
  recordsInvocation,
} from "../../src/features/history/analytics/client";
import { defaultUsage } from "../../src/features/history/analytics/controller";
import { reportPreparation } from "../../src/features/history/analytics/model";
import type { SearchQuery, UsageDraft } from "../../src/features/history/analytics/types";
import type { FeatureContext } from "../../src/app/types";
import { createTestProcessor } from "../core/processing-harness";
import { result, responses } from "./formats/fixtures";
const execute = promisify(execFile);
type ObjectRecord = Record<string, unknown>;
function object(x: unknown): ObjectRecord {
  if (typeof x !== "object" || x === null || Array.isArray(x))
    throw new Error("Native object required");
  return Object.fromEntries(Object.entries(x));
}
function rows(x: unknown): readonly ObjectRecord[] {
  if (!Array.isArray(x)) throw new Error("Native rows required");
  return x.map(object);
}
function text(x: unknown): string {
  if (typeof x !== "string") throw new Error("Native text required");
  return x;
}
function json<T>(codec: c.Codec<T>, x: unknown): T {
  const p = parseJsonText(JSON.stringify(x));
  if (!p.ok) throw new Error(p.error.message);
  const v = codec.decode(p.value.value);
  if (!v.ok) throw new Error(v.issue.expected);
  return v.value;
}
function plain(x: Parameters<typeof stringifyJson>[0]): ObjectRecord {
  const p = stringifyJson(x);
  if (!p.ok) throw new Error(p.error.message);
  return object(JSON.parse(p.value));
}
function writer(daemon: DaemonFixture) {
  let n = 0;
  return async (method: string, params: ObjectRecord = {}) => {
    const value = object(
      JSON.parse(
        await daemon.call(
          method,
          JSON.stringify({
            workspace_id: "demo",
            actor_id: "fixture-author",
            mutation_id: `analytics-browser-${++n}`,
            ...params,
          }),
        ),
      ),
    );
    if (value.error !== undefined) throw new Error(JSON.stringify(value.error));
    return object(value.result);
  };
}
async function read(daemon: DaemonFixture, method: string, params: ObjectRecord = {}) {
  const value = object(
    JSON.parse(await daemon.call(method, JSON.stringify({ workspace_id: "demo", ...params }))),
  );
  if (value.error !== undefined) throw new Error(JSON.stringify(value.error));
  return object(value.result);
}
async function mount(
  page: Page,
  companion: CompanionFixture,
  daemon: DaemonFixture,
  session?: string,
) {
  const bootstrap = await page.request.get(companion.url),
    capability = /<meta\s+name="workgraph-capability"\s+content="([a-f0-9]{64})"\s*\/?>/u.exec(
      await bootstrap.text(),
    )?.[1];
  if (capability === undefined) throw new Error("Capability missing");
  const headers = {
    Origin: new URL(companion.url).origin,
    "X-Workgraph-UI-Capability": capability,
  };
  for (const [route, data] of [
    ["/connections", { id: "local", label: "History analytics fixture", socket: daemon.socket }],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const response = await page.request.post(new URL(`/ui-api/v1${route}`, companion.url).href, {
      headers,
      data,
    });
    expect(response.status()).toBe(200);
    await response.text();
  }
  await page.goto(
    new URL(
      `/#/history?connection=local&workspace=demo${session === undefined ? "" : `&entity=${session}`}`,
      companion.url,
    ).href,
  );
  await page.waitForLoadState("networkidle");
  await page
    .locator("summary")
    .filter({ hasText: /^Search and reported usage$/u })
    .click();
  return page.locator(".ha-root");
}
async function selectActor(page: Page, actor: string, run?: string) {
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill(actor);
  await page.getByLabel("Run ID (optional)", { exact: true }).fill(run ?? "");
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  await page.waitForLoadState("networkidle");
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  await page.waitForLoadState("networkidle");
  const file = info.outputPath(`${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await info.attach(name, { path: file, contentType: "image/png" });
}
async function afterRead(page: Page, method: string, action: () => Promise<unknown>) {
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/ui-api/v1/read") &&
      r.request().postData()?.includes(`"method":"${method}"`) === true,
  );
  await action();
  const r = await response;
  await r.finished();
  return r;
}
function event(client_id: string, body: string, searchable?: string, kind = "measurement") {
  return {
    client_id,
    role: "sensor",
    kind,
    phase: "recorded",
    payload: { kind: "inline", bytes_base64: Buffer.from(body).toString("base64") },
    ...(searchable === undefined
      ? {}
      : {
          searchable_text: {
            kind: "inline",
            bytes_base64: Buffer.from(searchable).toString("base64"),
          },
        }),
  };
}
async function seedReports(daemon: DaemonFixture, large = false) {
  const write = writer(daemon);
  await write("run.register", {
    target_run_id: "shared-run",
    objective: "Synthetic reported usage",
  });
  await write("ticket.start", {
    ticket_id: "design",
    run_id: "shared-run",
    attempt_id: "usage-attempt",
  });
  for (const session_id of ["shared-one", "shared-two"])
    await write("session.create", { session_id, title: session_id, run_id: "shared-run" });
  const source = {
    reported_actor_id: "fixture-author",
    provenance: "Synthetic source observation",
    timestamp: "source time unavailable",
  };
  await write("usage.report", {
    ...source,
    usage_id: "run-max",
    scope: { kind: "run", run_id: "shared-run" },
    tokens: "9223372036854775807",
    elapsed_ms: "9007199254740993",
    metrics: [{ name: "bytes", unit: "bytes", value: "9223372036854775807" }],
  });
  await write("usage.report", {
    ...source,
    usage_id: "run-overflow",
    scope: { kind: "run", run_id: "shared-run" },
    tokens: "1",
    elapsed_ms: "0",
    metrics: [{ name: "bytes", unit: "bytes", value: "1" }],
  });
  await write("usage.report", {
    ...source,
    usage_id: "attempt-zero",
    scope: { kind: "attempt", attempt_id: "usage-attempt" },
    tokens: "0",
    elapsed_ms: "5",
    metrics: [{ name: "bytes", unit: "KiB", value: "7" }],
  });
  if (large)
    for (let b = 0; b < 4; b++)
      await write("usage.report", {
        ...source,
        usage_id: `many-${b}`,
        scope: { kind: "run", run_id: "shared-run" },
        tokens: "0",
        elapsed_ms: "0",
        metrics: Array.from({ length: 16 }, (_, i) => ({
          name: `metric${String(b * 16 + i).padStart(3, "0")}` + "_".repeat(55),
          unit: "u".repeat(32),
          value: "1",
        })),
      });
  return write;
}
test.use({ colorScheme: "dark", viewport: { width: 1600, height: 1000 }, actionTimeout: 10000 });
test.setTimeout(90000);
// eslint-disable-next-line no-empty-pattern
parityTest("Analytics exact forms and selectors match fresh native schemas", async ({}, info) => {
  const processing = createTestProcessor(),
    http = { processing, request: () => Promise.reject(new Error("Offline parity")) },
    context: FeatureContext = {
      client: http,
      connection: json(d.connectionProfile, {
        id: "local",
        generation: "1",
        label: "fixture",
        socket: "/tmp/fixture.sock",
      }),
      profileState: "current",
      route: {
        view: "history",
        connectionId: "local",
        workspaceId: "demo",
        projectId: null,
        entityId: null,
      },
      writer: { actorId: "fixture-author", runId: "shared-run" },
      navigate: () => {},
    },
    scope = {
      connectionId: context.connection.id,
      generation: context.connection.generation,
      workspaceId: json(d.identifier, "demo"),
    };
  const base: SearchQuery = {
      text: "needle",
      sessionId: "",
      kinds: [],
      capture: { kind: "current" },
      limit: "1",
      maxBytes: "4096",
    },
    forms: { method: string; params: ObjectRecord }[] = [];
  for (const capture of [
    { kind: "current" },
    { kind: "pinned", head: null },
    { kind: "pinned", head: json(d.digest, "a".repeat(64)) },
  ] as const)
    for (const filtered of [false, true]) {
      const request = searchInvocation(
        scope,
        {
          ...base,
          capture,
          sessionId: filtered ? "session" : "",
          kinds: filtered ? ["message", "measurement"] : [],
        },
        filtered
          ? { session_id: json(d.identifier, "session"), sequence: json(d.decimal, "1") }
          : null,
      );
      forms.push({ method: request.method, params: plain(request.params) });
    }
  for (const group of ["workspace", "project", "milestone", "ticket", "run", "attempt"] as const)
    for (const layout of ["rows", "nested", "totals_only"] as const) {
      const request = usageInvocation(
        scope,
        {
          ...defaultUsage,
          group,
          layout,
          projectId: "release",
          milestoneId: "milestone",
          ticketId: "design",
          runId: "shared-run",
          attemptId: "usage-attempt",
          actorId: "fixture-author",
        },
        "opaque-cursor",
        json(d.decimal, "3"),
      );
      forms.push({ method: request.method, params: plain(request.params) });
    }
  for (const next of [false, true]) {
    const request = recordsInvocation(
      scope,
      next ? json(d.decimal, "25") : undefined,
      next ? json(d.decimal, "2") : undefined,
    );
    forms.push({ method: request.method, params: plain(request.params) });
  }
  for (const scopeKind of ["run", "attempt"] as const) {
    const draft: UsageDraft = {
      id: json(d.identifier, "intention"),
      context,
      input: {
        usageId: "report",
        scopeKind,
        scopeId: scopeKind === "run" ? "shared-run" : "usage-attempt",
        tokens: "9223372036854775807",
        elapsedMs: "0",
        metrics: [{ name: "bytes", unit: "KiB", value: "9007199254740993" }],
        provenance: "Literal provenance",
        timestamp: "Caller source text",
      },
      frozen: null,
      pending: false,
      issue: null,
      unexpected: null,
    };
    const p = reportPreparation(draft);
    forms.push({ method: p.method, params: plain(p.params) });
  }
  const ajv = new Ajv2020({ strict: false, allErrors: true }),
    results: unknown[] = [];
  ajv.addKeyword({
    keyword: "x-maximumDecimal",
    type: "string",
    validate: (max: string, v: string) => /^(0|[1-9][0-9]*)$/u.test(v) && BigInt(v) <= BigInt(max),
  });
  ajv.addKeyword({
    keyword: "x-maxUtf8Bytes",
    type: "string",
    validate: (max: number, v: string) => Buffer.byteLength(v) <= max,
  });
  try {
    for (const form of forms) {
      const schema = object(
          JSON.parse(
            (
              await execute(fixtureBinary(), ["schema", form.method], {
                maxBuffer: 8 * 1024 * 1024,
              })
            ).stdout,
          ),
        ),
        validate = ajv.compile(object(rows(schema.methods)[0]?.params)),
        valid = validate(form.params);
      results.push({ ...form, valid, errors: validate.errors });
      expect(valid, `${form.method}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
    await info.attach("native-parity", {
      body: JSON.stringify(results, null, 2),
      contentType: "application/json",
    });
  } finally {
    processing.dispose();
  }
});
test("A01 native search continuation pins head, reports coverage and opens exact hit", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  await write("session.create", { session_id: "search-capture", title: "Search retained source" });
  await write("session.append", {
    session_id: "search-capture",
    events: Array.from({ length: 35 }, (_, i) =>
      event(
        `search-${i + 1}`,
        `# Retained event ${i + 1}\n\nExact source body.`,
        `${"noise ".repeat(i === 34 ? 12000 : 100)}needle event ${i + 1} ${"source ".repeat(100)}`,
        i % 2 ? "message" : "measurement",
      ),
    ),
  });
  const root = await mount(page, companion, daemon);
  await expect(root.getByLabel("Search retained text")).toHaveCount(0);
  await root.getByRole("button", { name: "Search history", exact: true }).click();
  const search = root.getByRole("region", { name: "History search" });
  await search.getByLabel("Search retained text").fill("needle");
  await search.getByText("Search filters and capture", { exact: true }).click();
  await search.getByLabel("Search session ID (blank for all)").fill("search-capture");
  await afterRead(page, "history.search", () =>
    search.getByRole("button", { name: "Search history", exact: true }).click(),
  );
  await expect(search.locator(".ha-hits li")).toHaveCount(25);
  const first = await search
    .locator(".ha-hits a")
    .evaluateAll((a) => a.map((x) => x.getAttribute("href")));
  const firstHref = first[0];
  if (firstHref === null || firstHref === undefined) throw new Error("Missing hit");
  const firstUrl = new URL(firstHref, companion.url),
    head = new URLSearchParams(firstUrl.hash.split("?")[1]).get("head");
  if (head === null) throw new Error("Missing captured head");
  await write("session.append", {
    session_id: "search-capture",
    events: [event("late", "Late append", "needle late append")],
  });
  await afterRead(page, "history.search", () =>
    search.getByRole("button", { name: "Next search page", exact: true }).click(),
  );
  await expect(search.locator(".ha-hits li")).toHaveCount(10);
  const second = await search
    .locator(".ha-hits a")
    .evaluateAll((a) => a.map((x) => x.getAttribute("href")));
  const native = await read(daemon, "history.search", {
      text: "needle",
      session_id: "search-capture",
      head,
      limit: "100",
    }),
    expected = rows(object(native.data).items).map((v) => text(object(v.event_ref).sequence));
  expect(
    [...first, ...second].map((href) =>
      new URLSearchParams(new URL(href ?? "", companion.url).hash.split("?")[1]).get("event"),
    ),
  ).toEqual(expected);
  await expect(search).toContainText("Index complete for these filters");
  await search.getByLabel("Search byte budget").fill("4096");
  await afterRead(page, "history.search", () =>
    search.getByRole("button", { name: "Search history", exact: true }).click(),
  );
  await expect(search).toContainText("matching record omitted at this byte boundary");
  const target = search.locator(".ha-hits a").first(),
    href = await target.getAttribute("href");
  if (href === null) throw new Error("hit");
  await target.click();
  await page.waitForLoadState("networkidle");
  expect(page.url()).toContain("generation=1");
  expect(page.url()).toContain("head=");
  const seq = new URLSearchParams(new URL(href, companion.url).hash.split("?")[1]).get("event");
  await page.locator(`#history-event-${seq}`).scrollIntoViewIfNeeded();
  await expect(page.locator(`#history-event-${seq}`)).toBeVisible();
  await screenshot(page, info, "analytics-exact-search-hit");
  expect(browserFailures).toEqual([]);
});
test("A02 empty capture, unsearchable events and lexical beyond64KiB coverage stay distinct", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  await write("session.create", { session_id: "deep-text", title: "Search full retained text" });
  await write("session.append", {
    session_id: "deep-text",
    events: [event("deep", "Generic content", `${"x".repeat(70000)} far-edge-match`)],
  });
  const root = await mount(page, companion, daemon);
  await root.getByRole("button", { name: "Search history", exact: true }).click();
  const search = root.getByRole("region", { name: "History search" });
  await search.getByLabel("Search retained text").fill("far-edge-match");
  await afterRead(page, "history.search", () =>
    search.getByRole("button", { name: "Search history", exact: true }).click(),
  );
  await expect(search.locator(".ha-hits li")).toHaveCount(1);
  await expect(search).toContainText("events have no searchable text");
  await expect(search).toContainText("byte offset 70001");
  await search.getByText("Search filters and capture", { exact: true }).click();
  await search.getByLabel("Search capture", { exact: true }).selectOption("empty");
  await afterRead(page, "history.search", () =>
    search.getByRole("button", { name: "Search history", exact: true }).click(),
  );
  await expect(search.locator(".ha-hits li")).toHaveCount(0);
  await expect(search).toContainText("candidate traversal exhausted");
  await expect(
    search.getByRole("button", { name: "Next search page", exact: true }),
  ).toBeDisabled();
  await screenshot(page, info, "analytics-explicit-empty-search");
  expect(browserFailures).toEqual([]);
});
test("A03 usage report retains original writer and literal samples through explicit review/apply", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  await write("run.register", {
    target_run_id: "report-run",
    objective: "Owned report qualification",
  });
  const root = await mount(page, companion, daemon);
  await selectActor(page, "fixture-author", "report-run");
  await root.getByRole("button", { name: "Usage reports", exact: true }).click();
  await root.getByRole("button", { name: "Report usage", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Report usage", exact: true });
  await dialog.getByLabel("Reported tokens", { exact: true }).fill("9007199254740993");
  await dialog.getByLabel("Reported elapsed milliseconds", { exact: true }).fill("0");
  await dialog
    .getByLabel("Usage source / provenance", { exact: true })
    .fill("Synthetic source bookkeeping");
  await dialog.getByLabel("Source-reported timestamp", { exact: true }).fill("Caller time unknown");
  await dialog.getByText("Stable report identity", { exact: true }).click();
  await dialog.getByLabel("Usage report ID", { exact: true }).fill("browser-reported");
  await dialog.getByText("Additive named samples (0/16)", { exact: true }).click();
  await dialog.getByRole("button", { name: "Add named sample", exact: true }).click();
  await dialog.getByLabel("Sample 1 name").fill("bytes");
  await dialog.getByLabel("Sample 1 unit").fill("KiB");
  await dialog.getByLabel("Sample 1 value").fill("7");
  await dialog.getByRole("button", { name: "Close Report usage", exact: true }).click();
  await selectActor(page, "human");
  await root.getByText("Retained usage editors (1)", { exact: true }).click();
  await root
    .getByRole("button", { name: "browser-reported · fixture-author", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "Report usage", exact: true });
  await expect(dialog).toContainText("Original writer retained after switch");
  await dialog.getByRole("button", { name: "Review usage report", exact: true }).click();
  await expect(dialog).toContainText("prepared_unsent");
  await dialog.getByRole("button", { name: "Apply usage report", exact: true }).click();
  await expect(
    dialog.getByRole("status").filter({ hasText: /^Usage report saved\.$/u }),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Apply usage report", exact: true })).toHaveCount(
    0,
  );
  await expect(
    dialog.getByRole("button", { name: "Inspect saved report", exact: true }),
  ).toBeEnabled();
  const list = await read(daemon, "usage.list"),
    report = rows(object(list.data).items).find((v) => v.usage_id === "browser-reported");
  expect(report).toMatchObject({
    actor_id: "fixture-author",
    tokens: "9007199254740993",
    elapsed_ms: "0",
    scope: { kind: "run", run_id: "report-run" },
    metrics: [{ name: "bytes", unit: "KiB", value: "7" }],
  });
  await screenshot(page, info, "analytics-original-reporter-committed");
  for (const [width, height, colorScheme] of [
    [1440, 900, "dark"],
    [390, 844, "light"],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme });
    await dialog.locator(".wg-dialog-body").evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.waitForLoadState("networkidle");
    const file = info.outputPath(`analytics-saved-top-${colorScheme}-${width}.png`);
    await page.screenshot({ path: file, fullPage: false });
    await info.attach(`analytics-saved-top-${colorScheme}-${width}`, {
      path: file,
      contentType: "image/png",
    });
  }
  expect(browserFailures).toEqual([]);
});
test("A04 usage layouts, overflow, unassigned attribution and whole-group budget retry use native captures", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  await seedReports(daemon, true);
  const root = await mount(page, companion, daemon);
  await root.getByRole("button", { name: "Usage reports", exact: true }).click();
  const usage = root.getByRole("region", { name: "Reported usage" });
  await usage.getByText("Grouping, filters and page budget", { exact: true }).click();
  await usage.getByLabel("Group reported usage by").selectOption("run");
  await usage.getByText("Literal usage filters and page budget", { exact: true }).click();
  await usage.getByLabel("Usage byte budget").fill("4096");
  await usage.getByLabel("Usage page size").fill("1");
  await afterRead(page, "usage.aggregate", () =>
    usage.getByRole("button", { name: "Rescan usage", exact: true }).click(),
  );
  await expect(usage).toContainText("A whole group does not fit this budget");
  await afterRead(page, "usage.aggregate", () =>
    usage
      .getByRole("button", { name: "Retry whole group with required budget", exact: true })
      .click(),
  );
  await expect(usage.locator(".ha-usage-row")).toHaveCount(1);
  await expect(usage).toContainText("9223372036854775807");
  await expect(usage).toContainText("Token or elapsed total saturated");
  await expect(usage.locator("table")).toContainText("KiB");
  await expect(usage.locator("table")).toContainText("bytes");
  await screenshot(page, info, "analytics-native-whole-group-and-overflow");
  await usage.getByLabel("Usage metric layout").selectOption("rows");
  await usage.getByLabel("Usage byte budget").fill("1048576");
  await afterRead(page, "usage.aggregate", () =>
    usage.getByRole("button", { name: "Rescan usage", exact: true }).click(),
  );
  await expect(usage.locator(".ha-usage-row")).toHaveCount(1);
  await afterRead(page, "usage.aggregate", () =>
    usage.getByRole("button", { name: "Next usage page", exact: true }).click(),
  );
  await expect(usage.locator(".ha-usage-row table")).toHaveCount(1);
  await usage.getByLabel("Usage metric layout").selectOption("totals_only");
  await usage.getByLabel("Usage page size").fill("25");
  await usage.getByLabel("Usage Project ID").fill("release");
  await afterRead(page, "usage.aggregate", () =>
    usage.getByRole("button", { name: "Rescan usage", exact: true }).click(),
  );
  await expect(usage).toContainText("Excluded in filtered totals");
  await expect(usage).toContainText("named series omitted by the selected totals-only layout");
  await afterRead(page, "usage.list", () =>
    usage.getByRole("button", { name: "Browse report records", exact: true }).click(),
  );
  await expect(usage).toContainText("Immutable source reports · policy capture");
  await screenshot(page, info, "analytics-unassigned-reports-distinct-from-membership");
  expect(browserFailures).toEqual([]);
});
test("A05 selected metric reports remain separate from shared run attribution and generic unknown", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = await seedReports(daemon);
  await write("session.append", {
    session_id: "shared-one",
    events: [
      event("sdk-one", JSON.stringify(result)),
      event("sdk-two", JSON.stringify({ ...result, uuid: "00000000-0000-4000-8000-000000000009" })),
      event(
        "response",
        JSON.stringify(responses).replace('"input_tokens":12', '"input_tokens":9007199254740993'),
      ),
      event("generic", "# General observations\n\nNo provider metrics."),
    ],
  });
  const root = await mount(page, companion, daemon, "shared-one");
  await root.getByRole("button", { name: "Session summary", exact: true }).click();
  const summary = root.getByRole("region", { name: "Session summary" });
  await summary.getByText("Window, payload and origin details", { exact: true }).click();
  await expect(summary).toContainText("4 committed events");
  await expect(summary.getByLabel("Select exact source metric report")).toHaveCount(1);
  await summary.getByLabel("Select exact source metric report").selectOption("shared-one/1");
  await expect(summary).toContainText("reported-main-agent-only-usage-per-turn-in-streaming");
  await expect(summary).toContainText("model_round_trips");
  await summary.getByLabel("Select exact source metric report").selectOption("shared-one/3");
  await expect(summary).toContainText("9007199254740993");
  await expect(summary).toContainText("No totals are added across reports");
  await screenshot(page, info, "analytics-selected-exact-provider-report");
  await summary
    .getByRole("button", { name: "Load originating run usage separately", exact: true })
    .click();
  await expect(root.getByRole("region", { name: "Reported usage" })).toContainText(
    "no per-session share is inferred",
  );
  await expect(root.getByRole("region", { name: "Reported usage" })).toContainText(
    "Reported totals",
  );
  expect(browserFailures).toEqual([]);
});
