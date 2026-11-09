import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect } from "../../e2e/support/fixtures";
import type { DaemonFixture } from "../../../../test-support/daemon-fixture.mjs";
import type { CompanionFixture } from "../../../../test-support/companion-fixture.mjs";
import { assistant, chat, codex, messages, responses, result, user } from "./fixtures";

const encoded = (value: unknown) => JSON.stringify(value);
function writer(daemon: DaemonFixture) {
  let serial = 0;
  return async (method: string, params: Readonly<Record<string, unknown>>) => {
    const json = JSON.stringify({
      workspace_id: "demo",
      actor_id: "fixture-author",
      mutation_id: `format-${++serial}`,
      ...params,
    });
    // Large synthetic bodies exceed OS argv limits. Keep them in this fixture's
    // owned temporary directory and use the CLI's supported file input.
    let raw: string;
    if (Buffer.byteLength(json) > 64 * 1024) {
      const dir = await mkdtemp(path.join(daemon.root, "format-input-"));
      try {
        const file = path.join(dir, "params.json");
        await writeFile(file, json, { mode: 0o600 });
        raw = (
          await promisify(execFile)(
            daemon.binary,
            ["request", daemon.socket, method, "--params-file", file],
            { timeout: 15_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
          )
        ).stdout;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } else raw = await daemon.call(method, json);
    return JSON.parse(raw) as {
      readonly result: { readonly data: unknown; readonly meta: unknown };
    };
  };
}
function event(id: string, source: string | Uint8Array) {
  return {
    client_id: id,
    role: "arbitrary-recorded-role",
    kind: "caller-record",
    phase: "recorded",
    payload: { kind: "inline", bytes_base64: Buffer.from(source).toString("base64") },
  };
}
async function mount(
  page: Page,
  companion: CompanionFixture,
  daemon: DaemonFixture,
  session: string,
) {
  const html = await (await page.request.get(companion.url)).text();
  const capability = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(html)?.[1];
  if (!capability) throw new Error("actual native bootstrap capability missing");
  for (const [route, data] of [
    ["/connections", { id: "local", label: "Formats fixture", socket: daemon.socket }],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const response = await page.request.post(new URL(`/ui-api/v1${route}`, companion.url).href, {
      headers: { Origin: new URL(companion.url).origin, "X-Workgraph-UI-Capability": capability },
      data,
    });
    expect(response.status()).toBe(200);
    await response.text();
  }
  await page.goto(
    new URL(`/#/history?connection=local&workspace=demo&entity=${session}`, companion.url).href,
  );
  const root = page.locator(".ht-root");
  await expect(root.getByLabel("Payload format")).toBeVisible();
  return root;
}
async function open(root: Locator, sequence: number) {
  const row = root.locator(`#history-event-${sequence}`);
  const control = row.locator(":scope > header button[aria-expanded]");
  if ((await control.getAttribute("aria-expanded")) !== "true") await control.click();
  await expect(row.locator(".ht-payload")).toBeVisible();
  return row;
}
async function reveal(root: Locator, name: string) {
  const summary = root.locator("summary").filter({ hasText: new RegExp(`^${name}$`, "u") });
  if (!(await summary.locator("..").evaluate((element) => element.hasAttribute("open"))))
    await summary.click();
}
async function picture(page: Page, info: TestInfo, name: string) {
  await expect(page.getByRole("heading", { name: "Preparing content", exact: true })).toHaveCount(
    0,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  const file = info.outputPath(`${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await info.attach(name, { path: file, contentType: "image/png" });
}
async function sourceBytes(page: Page, viewer: Locator) {
  await reveal(viewer, "Content options");
  const received = page.waitForEvent("download");
  await viewer.getByRole("button", { name: "Download source", exact: true }).click();
  const download = await received;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    const bytes: unknown = chunk;
    if (!(bytes instanceof Uint8Array)) throw new Error("download emitted non-byte chunk");
    chunks.push(Buffer.from(bytes));
  }
  return Buffer.concat(chunks);
}

test("all six precise adapters validate actual stored records; explicit selection and Generic preserve exact source", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  const responseText = encoded(responses).replace(
    '"input_tokens":12',
    '"input_tokens":9007199254740993',
  );
  const records = [
    {
      id: "anthropic.messages.response.v1",
      label: "Anthropic Messages response",
      text: encoded(messages),
    },
    { id: "openai.responses.object.v1", label: "OpenAI Responses object", text: responseText },
    {
      id: "openai.responses.event.v1",
      label: "OpenAI Responses complete event",
      text: encoded({ type: "response.completed", sequence_number: 1, response: responses }),
    },
    {
      id: "openai.chat-completions.object.v1",
      label: "OpenAI Chat Completions object",
      text: encoded(chat),
    },
    {
      id: "claude.agent-sdk.message.v1",
      label: "Claude Agent SDK message (0.3.319)",
      text: encoded(assistant),
    },
    {
      id: "codex.rollout-jsonl.7cdb219.v1",
      label: "Codex rollout (7cdb219)",
      text: encoded(codex),
    },
  ];
  await write("session.create", { session_id: "formats", title: "Six exact source formats" });
  await write("session.append", {
    session_id: "formats",
    events: records.map((record, i) => event(`record-${i}`, record.text)),
  });
  const before = await daemon.call("session.get", '{"workspace_id":"demo","session_id":"formats"}');
  const root = await mount(page, companion, daemon, "formats");
  const coverage = root.getByLabel("Current window format coverage");
  await expect(coverage.getByRole("status")).toHaveText("6 validated · 0 Generic");
  for (const [index, record] of records.entries()) {
    const row = await open(root, index + 1);
    await expect(row.locator(".ht-payload-summary")).toContainText(record.label);
    await root.getByLabel("Payload format").selectOption(record.id);
    await expect(row.locator(".ht-payload-summary")).toContainText(record.label);
    await expect(
      root.getByText("Validating loaded bounded payload formats…", { exact: true }),
    ).toHaveCount(0);
    await expect(coverage.getByRole("status")).toHaveText("1 validated · 5 Generic");
    await row.getByText("Format recognition and source metadata", { exact: true }).click();
    await expect(row.getByText(/validated shape only; producer not asserted/u)).toBeVisible();
    await root.getByLabel("Payload format").selectOption("auto");
    await expect(coverage.getByRole("status")).toHaveText("6 validated · 0 Generic");
  }
  const response = await open(root, 2);
  await response
    .getByText("Reported metrics · exact source scopes, never session totals", { exact: true })
    .click();
  await expect(response.getByText("9007199254740993 tokens", { exact: true })).toBeVisible();
  await expect(response.getByText(/^Source \/usage\/input_tokens · response /u)).toBeVisible();
  await expect(
    response.getByText(
      "No metrics are summed, distributed from run usage or inferred from missing fields.",
      { exact: true },
    ),
  ).toBeVisible();
  await picture(page, info, "formats-openai-reported-lossless-metrics");
  await root.getByLabel("Payload format").selectOption("generic");
  await expect(coverage.getByRole("status")).toHaveText("6 loaded payloads in Generic view");
  const viewer = response.getByRole("region", { name: "Content: Event 2 payload", exact: true });
  const bytes = await sourceBytes(page, viewer);
  expect(bytes.toString("utf8")).toBe(responseText);
  await info.attach("exact-original-source-sha256", {
    body: createHash("sha256").update(bytes).digest("hex"),
    contentType: "text/plain",
  });
  expect(await daemon.call("session.get", '{"workspace_id":"demo","session_id":"formats"}')).toBe(
    before,
  );
  await picture(page, info, "formats-generic-exact-original-bytes");
  expect(browserFailures).toEqual([]);
});

test("mixed unknown, malformed, ambiguous, drifted and partial payloads stay readable without promoting a vendor hint", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  const hybrid = { ...responses, ...codex, payload: codex.payload };
  const records = [
    encoded(messages),
    encoded({ model: "OpenAI", role: "assistant", reading: "23.5C" }),
    '{"duplicate":1,"duplicate":2}',
    encoded(hybrid),
    encoded({ ...messages, content: "future schema" }),
    new Uint8Array([0xff, 0x00, 0x80]),
    "x".repeat(40 * 1024),
  ];
  await write("session.create", { session_id: "mixed", title: "Mixed recorded data" });
  await write("session.append", {
    session_id: "mixed",
    events: records.map((source, i) => event(`mixed-${i}`, source)),
  });
  const root = await mount(page, companion, daemon, "mixed");
  const coverage = root.getByLabel("Current window format coverage");
  await expect(coverage.getByRole("status")).toContainText("1 validated · 6 Generic");
  await expect(coverage.getByRole("status")).toContainText("1 partial prefixes");
  const ambiguous = await open(root, 4);
  await expect(ambiguous.getByText(/ambiguous matching formats/u)).toBeVisible();
  await root.getByLabel("Payload format").selectOption("openai.responses.object.v1");
  await expect(ambiguous.locator(".ht-payload-summary")).toContainText("OpenAI Responses object");
  const unknown = await open(root, 2);
  await expect(unknown.getByText(/schema-mismatch/u)).toBeVisible();
  await root.getByLabel("Payload format").selectOption("generic");
  const malformed = await open(root, 3);
  const original = malformed.getByRole("region", { name: "Content: Event 3 payload", exact: true });
  await expect(original.getByRole("button", { name: "Raw bytes", exact: true })).toBeVisible();
  const bytes = await sourceBytes(page, original);
  expect(bytes.toString()).toBe(records[2]);
  const binary = await open(root, 6);
  await binary.getByRole("button", { name: "Raw bytes", exact: true }).click();
  await expect(binary.getByLabel("Raw byte window")).toContainText("ff");
  const partial = await open(root, 7);
  await expect(partial.locator(".ht-payload-summary")).toContainText("partial prefix");
  await reveal(
    partial.getByRole("region", { name: "Content: Event 7 payload", exact: true }),
    "Content options",
  );
  await expect(
    partial.getByRole("button", { name: "Download loaded bytes", exact: true }),
  ).toBeVisible();
  await root.getByLabel("Payload format").selectOption("auto");
  await open(root, 5);
  await coverage.getByText("Format view details", { exact: true }).click();
  await expect(coverage.getByLabel("Generic fallback reasons")).toContainText("invalid-json");
  await expect(coverage.getByLabel("Generic fallback reasons")).toContainText("partial");
  await picture(page, info, "formats-mixed-fallback-coverage");
  expect(browserFailures).toEqual([]);
});

test("opaque retained reasoning, reported error and shared Markdown/code views stay passive; format preferences stay session-scoped", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon);
  const prose =
    "# Retained Markdown\n\n```ocaml\nlet answer = 42\n```\n\n<script>globalThis.formatProbe=true</script>";
  const tool = {
    ...user,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "only-retained-data",
          content: "```python\ndef captured():\n    return 'captured'\n```",
          is_error: false,
        },
      ],
    },
  };
  const records = [
    prose,
    encoded({
      ...messages,
      content: [
        { type: "thinking", thinking: "", signature: "opaque-signature" },
        { type: "redacted_thinking", data: "redacted-value" },
      ],
    }),
    encoded({
      ...responses,
      output: [
        { type: "reasoning", id: "reasoning", summary: [], encrypted_content: "opaque-ciphertext" },
      ],
    }),
    encoded({ ...result, is_error: true, result: "Reported API error, not successful completion" }),
    encoded(tool),
    encoded({
      ...messages,
      content: [
        { type: "text", text: "Known retained text" },
        { type: "future_source_block", payload: "unknown content retained" },
      ],
    }),
  ];
  for (const session_id of ["presentation", "other"])
    await write("session.create", { session_id, title: session_id });
  await write("session.append", {
    session_id: "presentation",
    events: records.map((source, i) => event(`presentation-${i}`, source)),
  });
  await write("session.append", {
    session_id: "other",
    events: [event("other-source", encoded(chat))],
  });
  const root = await mount(page, companion, daemon, "presentation");
  await expect(root.getByLabel("Current window format coverage").getByRole("status")).toHaveText(
    "5 validated · 1 Generic",
  );
  const signature = await open(root, 2);
  await signature.getByRole("button", { name: "2. opaque-reasoning", exact: true }).click();
  await expect(
    signature.getByRole("heading", { name: "Opaque reasoning · signature", exact: true }),
  ).toBeVisible();
  await signature.getByRole("button", { name: "3. opaque-reasoning", exact: true }).click();
  await expect(
    signature.getByRole("heading", { name: "Opaque reasoning · redacted", exact: true }),
  ).toBeVisible();
  const encrypted = await open(root, 3);
  await expect(
    encrypted.getByRole("heading", { name: "Opaque reasoning · encrypted", exact: true }),
  ).toBeVisible();
  await expect(encrypted.getByText(/no text is reconstructed/u)).toBeVisible();
  const error = await open(root, 4);
  await expect(
    error.getByText("Reported API error, not successful completion", { exact: true }),
  ).toBeVisible();
  await expect(error.getByText(/Source reported error: true/u)).toBeVisible();
  await expect(error.getByText(/does not mark a ticket or project complete/u)).toBeVisible();
  const output = await open(root, 5);
  await expect(
    output.getByRole("heading", { name: "Tool result · only-retained-data", exact: true }),
  ).toBeVisible();
  await expect(output.locator(".wg-syntax-keyword")).not.toHaveCount(0);
  const unknown = await open(root, 6);
  await unknown.getByRole("button", { name: "2. unsupported", exact: true }).click();
  await expect(
    unknown.getByText(
      /Unsupported source block: Unsupported Messages block type: future_source_block/u,
    ),
  ).toBeVisible();
  const markdown = await open(root, 1);
  const viewer = markdown.getByRole("region", { name: "Content: Event 1 payload", exact: true });
  await expect(
    viewer.getByRole("heading", { name: "Retained Markdown", exact: true }),
  ).toBeVisible();
  await expect(viewer.locator(".wg-syntax-keyword")).not.toHaveCount(0);
  await reveal(viewer, "Content options");
  await viewer.getByLabel("Language override").selectOption("plain");
  await expect(viewer.locator(".wg-syntax-keyword")).toHaveCount(0);
  await viewer.getByRole("button", { name: "Source", exact: true }).click();
  await expect(viewer.getByLabel("Source line window")).toContainText("let answer = 42");
  await viewer.getByRole("button", { name: "Raw bytes", exact: true }).click();
  await expect(viewer.getByLabel("Raw byte window")).toContainText("23");
  expect((await sourceBytes(page, viewer)).toString()).toBe(prose);
  expect(await page.evaluate(() => Object.hasOwn(globalThis, "formatProbe"))).toBe(false);
  await root.getByLabel("Payload format").selectOption("generic");
  await page.goto(
    new URL("/#/history?connection=local&workspace=demo&entity=other", companion.url).href,
  );
  await expect(root.getByLabel("Payload format")).toHaveValue("auto");
  await page.goBack();
  await expect(root.getByLabel("Payload format")).toHaveValue("generic");
  await write("session.append", {
    session_id: "presentation",
    events: [event("new-event", encoded(messages))],
  });
  await root.getByRole("button", { name: "Refresh current capture", exact: true }).click();
  await expect(root.getByLabel("Payload format")).toHaveValue("generic");
  await expect(root.getByLabel("Current window format coverage").getByRole("status")).toHaveText(
    "7 loaded payloads in Generic view",
  );
  await picture(page, info, "formats-passive-content-and-session-preference");
  expect(browserFailures).toEqual([]);
});

test("individual conversation items render together and shared run usage is counted once", async ({
  page,
  daemon,
  companion,
  browserFailures,
  browserDiagnostics,
}) => {
  const write = writer(daemon);
  await write("run.register", {
    target_run_id: "single-run",
    objective: "Synthetic single-session usage fixture",
  });
  await write("run.register", {
    target_run_id: "extra-run",
    objective: "Second run for same session",
  });
  await write("run.register", {
    target_run_id: "shared-run",
    objective: "Synthetic shared usage fixture",
  });
  for (const [id, run] of [
    ["single", "single-run"],
    ["shared-a", "shared-run"],
    ["shared-b", "shared-run"],
  ])
    await write("session.create", { session_id: id, title: `Conversation ${id}`, run_id: run });
  await write("run.link_session", {
    target_run_id: "extra-run",
    session_id: "single",
    expected_revision: "1",
  });
  await write("session.append", {
    session_id: "single",
    events: [
      event("user", encoded({ role: "user", content: "Inspect the retry path." })),
      event(
        "assistant",
        encoded({
          role: "assistant",
          content: [
            { type: "text", text: "First visible paragraph." },
            { type: "tool_use", id: "call-1", name: "Read", input: { path: "retry.ts" } },
            { type: "text", text: "Second visible paragraph." },
          ],
        }),
      ),
      event(
        "result",
        encoded({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-1",
              content: "The request identity is preserved.",
            },
          ],
        }),
      ),
    ],
  });
  for (const [run, input, cost] of [
    ["single-run", "1000", "1200000"],
    ["shared-run", "2000", "2400000"],
    ["extra-run", "500", "600000"],
  ])
    await write("usage.report", {
      usage_id: `usage-${run}`,
      scope: { kind: "run", run_id: run },
      reported_actor_id: "fixture-author",
      tokens: input,
      elapsed_ms: "10",
      timestamp: "synthetic",
      provenance: "Synthetic measurement and illustrative prices for browser test",
      metrics: [
        { name: "estimated_cost_usd_micros", unit: "microUSD", value: cost },
        { name: "input_tokens", unit: "tokens", value: input },
        { name: "output_tokens", unit: "tokens", value: "0" },
      ],
    });
  const root = await mount(page, companion, daemon, "single");
  await expect(root.locator(".ht-session-metrics")).toContainText("$1.80");
  await expect(root.locator(".ht-session-metrics")).toContainText("1,500");
  await root.locator("#history-event-2 .ht-chat-body").first().scrollIntoViewIfNeeded();
  await expect(
    root.locator(".ht-chat-body").filter({ hasText: "First visible paragraph." }),
  ).toBeVisible();
  await root.locator("#history-event-2 .ht-chat-body").last().scrollIntoViewIfNeeded();
  await expect(
    root.locator(".ht-chat-body").filter({ hasText: "Second visible paragraph." }),
  ).toBeVisible();
  const tool = root.locator(".ht-chat-tool").filter({ hasText: "Read" });
  await expect(tool).toContainText("retry.ts");
  const output = tool.locator(".ht-paired-result");
  await output.locator("summary").click();
  await expect(output).toContainText("The request identity is preserved.");
  await expect(root.locator(".ht-chat-block .wg-content-reading-options")).toHaveCount(0);
  browserDiagnostics.markPendingReads();
  await root.getByRole("button", { name: "← All sessions", exact: true }).click();
  const usage = root.getByRole("region", { name: "Session and shared run usage" });
  await expect(usage).toContainText("Sole session · run-reported usage");
  await expect(usage).toContainText("Shared by 2 sessions · counted once");
  await expect(usage.locator("tbody tr")).toHaveCount(3);
  await expect(usage.locator(".ht-consumption-cards")).toContainText("3,500");
  await expect(usage.locator(".ht-consumption-cards")).toContainText("$4.20");
  expect(browserFailures).toEqual([]);
});

test("chronological transcript loads 60, appends all and follows live without moving an older reader", async ({
  page,
  daemon,
  companion,
  browserFailures,
}) => {
  const write = writer(daemon);
  await write("session.create", { session_id: "long", title: "Chronological conversation" });
  await write("session.append", {
    session_id: "long",
    events: Array.from({ length: 125 }, (_, i) =>
      event(
        `ordered-${i + 1}`,
        encoded({
          role: i % 2 ? "assistant" : "user",
          content: `Message ${i + 1}: **retained** text.`,
        }),
      ),
    ),
  });
  const root = await mount(page, companion, daemon, "long");
  await expect(root.locator(".ht-event")).toHaveCount(60);
  await expect(root.locator(".ht-event").first()).toHaveAttribute("id", "history-event-1");
  await expect(
    root.getByRole("button", { name: "Load 60 more events", exact: true }),
  ).toBeEnabled();
  await root.getByRole("button", { name: "Load 60 more events", exact: true }).click();
  await expect(root.locator(".ht-event")).toHaveCount(120);
  await expect(root.getByRole("button", { name: "Load all", exact: true })).toBeEnabled();
  await root.getByRole("button", { name: "Load all", exact: true }).click();
  await expect(root.locator(".ht-event")).toHaveCount(125);
  await expect(root.getByRole("button", { name: "Stop loading", exact: true })).toHaveCount(0);
  const timeline = root.getByRole("region", { name: "Session timeline" });
  await root.locator(".ht-transcript-footer").scrollIntoViewIfNeeded();
  await timeline.focus();
  await page.keyboard.press("End");
  await timeline.dispatchEvent("scroll");
  await expect(root.locator(".ht-following")).toContainText("Following live");
  await write("session.append", {
    session_id: "long",
    events: [event("ordered-126", encoded({ role: "assistant", content: "New live **answer**." }))],
  });
  await expect(root.locator("#history-event-126")).toBeVisible({ timeout: 20000 });
  await expect(
    root.locator("#history-event-126 strong").filter({ hasText: "answer" }),
  ).toBeVisible();
  await timeline.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  await expect(root.locator(".ht-following")).toHaveCount(0);
  await write("session.append", {
    session_id: "long",
    events: [event("ordered-127", encoded({ role: "user", content: "Another message." }))],
  });
  await expect(root.locator(".ht-session-heading")).toContainText("127 events", { timeout: 20000 });
  expect(await timeline.evaluate((el) => el.scrollTop)).toBe(0);
  await expect(root.locator(".ht-event")).toHaveCount(126);
  await root.getByRole("button", { name: "Show JSON for event 1", exact: true }).click();
  const raw = root.locator("#history-event-1 .ht-event-source");
  await raw.scrollIntoViewIfNeeded();
  await expect(raw.locator("pre").first()).toContainText('\n  "role": "user"');
  expect(browserFailures).toEqual([]);
});

test("Codex JavaScript and Claude Bash pair with their exact output and retain both sources", async ({
  page,
  daemon,
  companion,
  browserFailures,
}) => {
  const write = writer(daemon);
  await write("session.create", { session_id: "paired", title: "Tool conversations" });
  const claude = (type: string, n: number, content: unknown) => ({
    type,
    uuid: `claude-${n}`,
    parentUuid: n === 1 ? null : `claude-${n - 1}`,
    sessionId: "claude-test",
    timestamp: "2026-11-09T01:00:00Z",
    message: { role: type, content },
  });
  await write("session.append", {
    session_id: "paired",
    events: [
      event(
        "js-call",
        encoded({
          type: "response_item",
          timestamp: "2026-11-09T01:00:00Z",
          payload: {
            type: "custom_tool_call",
            call_id: "js-1",
            name: "exec",
            input: 'text(await tools.exec_command({cmd: "pwd"}));',
          },
        }),
      ),
      event(
        "js-result",
        encoded({
          type: "response_item",
          timestamp: "2026-11-09T01:00:01Z",
          payload: {
            type: "custom_tool_call_output",
            call_id: "js-1",
            output: [
              {
                type: "input_text",
                text: '{"output":"/synthetic/repo","exit_code":0,"wall_time_seconds":0.1}{"data":{"ok":true}}',
              },
            ],
          },
        }),
      ),
      event(
        "bash-call",
        encoded(
          claude("assistant", 1, [
            {
              type: "tool_use",
              id: "bash-1",
              name: "Bash",
              input: { command: "printf ready", description: "Check environment" },
            },
          ]),
        ),
      ),
      event(
        "bash-output",
        encoded(
          claude("user", 2, [
            { type: "tool_result", tool_use_id: "bash-1", content: "ready", is_error: false },
          ]),
        ),
      ),
    ],
  });
  const root = await mount(page, companion, daemon, "paired");
  await expect(root.locator(".ht-tool-combined")).toHaveCount(2);
  await expect(root.locator(".ht-event-focused")).toHaveCount(0);
  const js = root.locator(".ht-tool-combined").first();
  await js.scrollIntoViewIfNeeded();
  await expect(js).toContainText("JavaScript");
  await expect(js.locator(".ht-tool-input")).toContainText("tools.exec_command");
  await js.locator(".ht-paired-result summary").first().click();
  await expect(js).toContainText("/synthetic/repo");
  await expect(js).toContainText("Exit code 0");
  await js.getByRole("button", { name: "Show JSON for result event 2", exact: true }).click();
  await js.locator(".ht-event-source").scrollIntoViewIfNeeded();
  await expect(js.locator(".ht-event-source")).toContainText("custom_tool_call_output");
  await js.getByRole("button", { name: "Show JSON for result event 2", exact: true }).click();
  const shell = root.locator(".ht-tool-combined").last();
  await shell.scrollIntoViewIfNeeded();
  await expect(shell).toContainText("printf ready");
  await shell.locator(".ht-paired-result summary").click();
  await expect(shell.locator(".ht-paired-result")).toContainText("ready");
  await expect(root.locator("#history-event-2")).toHaveCount(0);
  await expect(root.locator("#history-event-4")).toHaveCount(0);
  expect(browserFailures).toEqual([]);
});

test("large Codex and Claude tool outputs load completely and pair without manual expansion", async ({
  page,
  daemon,
  companion,
  browserFailures,
}) => {
  const write = writer(daemon);
  await write("session.create", { session_id: "large-tools", title: "Large tool results" });
  const output = "Complete log line with Unicode 雪.\n".repeat(18_000) + "LAST-RESULT-MARKER";
  const rollout = (payload: unknown) =>
    encoded({ type: "response_item", timestamp: "2026-11-09T01:00:00Z", payload });
  const claude = (type: string, n: number, content: unknown) =>
    encoded({
      type,
      uuid: `large-${n}`,
      parentUuid: n === 1 ? null : `large-${n - 1}`,
      sessionId: "large-claude",
      timestamp: "2026-11-09T01:00:00Z",
      message: { role: type, content },
    });
  await write("session.append", {
    session_id: "large-tools",
    events: [
      event(
        "codex-call",
        rollout({
          type: "custom_tool_call",
          call_id: "large-js",
          name: "exec",
          input: 'text(await tools.exec_command({cmd: "cat log"}));',
        }),
      ),
      event(
        "codex-result",
        rollout({
          type: "custom_tool_call_output",
          call_id: "large-js",
          output: [{ type: "input_text", text: output }],
        }),
      ),
      event(
        "claude-call",
        claude("assistant", 1, [
          { type: "tool_use", id: "large-bash", name: "Bash", input: { command: "cat log" } },
        ]),
      ),
      event(
        "claude-result",
        claude("user", 2, [
          { type: "tool_result", tool_use_id: "large-bash", content: output, is_error: false },
        ]),
      ),
    ],
  });
  const root = await mount(page, companion, daemon, "large-tools");
  await expect(root.locator(".ht-tool-combined")).toHaveCount(2);
  await expect(root.locator(".ht-paired-result")).toHaveCount(2);
  for (const result of await root.locator(".ht-paired-result").all()) {
    await result.scrollIntoViewIfNeeded();
    await result.locator("summary").first().click();
    await result.locator(".wg-content-viewer").first().scrollIntoViewIfNeeded();
    await expect(result).toContainText("LAST-RESULT-MARKER");
  }
  await expect(root.locator("#history-event-2, #history-event-4")).toHaveCount(0);
  await expect(root).not.toContainText("This is loaded content only");
  await expect(root).not.toContainText("partial prefix");
  expect(browserFailures).toEqual([]);
});
