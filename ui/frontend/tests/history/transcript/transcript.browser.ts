import { waitForPageReads } from "../../e2e/support/readiness";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, expect } from "../../e2e/support/fixtures";
import type { Locator, Page, Response, TestInfo } from "@playwright/test";
import { jsonField, parseJsonText } from "../../../src/core/json";
import * as d from "../../../src/core/protocol/decoders";
import {
  startDaemonFixture,
  type DaemonFixture,
} from "../../../../test-support/daemon-fixture.mjs";
import type { CompanionFixture } from "../../../../test-support/companion-fixture.mjs";
import { assistant, result, user, responses } from "../formats/fixtures";
const execute = promisify(execFile);
function writer(daemon: DaemonFixture) {
  let serial = 0;
  return (method: string, params: Readonly<Record<string, unknown>>) =>
    daemon.call(
      method,
      JSON.stringify({
        workspace_id: "demo",
        actor_id: "fixture-author",
        mutation_id: `transcript-${++serial}`,
        ...params,
      }),
    );
}
function event(
  client_id: string,
  bytes: Uint8Array,
  extra: Readonly<Record<string, unknown>> = {},
) {
  return {
    client_id,
    role: "sensor",
    kind: "measurement",
    phase: "recorded",
    payload: { kind: "inline", bytes_base64: Buffer.from(bytes).toString("base64") },
    ...extra,
  };
}
const encoded = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
async function mount(
  page: Page,
  companion: CompanionFixture,
  daemon: DaemonFixture,
  session?: string,
) {
  const source = await page.request.get(companion.url),
    capability = /<meta\s+name="workgraph-capability"\s+content="([a-f0-9]{64})"\s*\/?>/u.exec(
      await source.text(),
    )?.[1];
  if (!capability) throw new Error("Missing native capability");
  for (const [endpoint, body] of [
    ["/connections", { id: "local", label: "History fixture", socket: daemon.socket }],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const response = await page.request.post(new URL(`/ui-api/v1${endpoint}`, companion.url).href, {
      headers: { Origin: new URL(companion.url).origin, "X-Workgraph-UI-Capability": capability },
      data: body,
    });
    expect(response.status()).toBe(200);
    await response.text();
  }
  await page.goto(
    new URL(
      `/#/history?connection=local&workspace=demo${session ? `&entity=${session}` : ""}`,
      companion.url,
    ).href,
  );
  await waitForPageReads(page);
  return page.locator(".ht-root");
}
async function actor(page: Page, value: string) {
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID").fill(value);
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
}
function card(root: Locator, sequence: number) {
  return root.locator(`#history-event-${sequence}`);
}
async function open(root: Locator, sequence: number) {
  const row = card(root, sequence);
  await row.locator("header button").click();
  await expect(row.locator(".ht-payload")).toBeVisible();
  return row;
}
async function capture(page: Page, info: TestInfo, name: string) {
  await expect(page.getByRole("heading", { name: "Preparing content", exact: true })).toHaveCount(
    0,
  );
  await waitForPageReads(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    for (const node of document.querySelectorAll<HTMLElement>(".wg-content")) node.scrollTop = 0;
  });
  const file = info.outputPath(`${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await info.attach(name, { path: file, contentType: "image/png" });
}
async function committed(root: Locator) {
  await expect(root.locator(".wg-badge").filter({ hasText: /^prepared_unsent$/u })).toBeVisible();
  await root.getByRole("button", { name: "Execute saved request", exact: true }).click();
  await expect(root.locator(".wg-badge").filter({ hasText: /^committed$/u })).toBeVisible();
}

test("Generic exact bytes, partial UTF-8, immutable event links and explicit capture refresh", async ({
  page,
  daemon,
  companion,
  browserFailures,
  browserDiagnostics,
}, info) => {
  const write = writer(daemon),
    large = new TextEncoder().encode("雪".repeat(12000));
  await write("session.create", { session_id: "arbitrary", title: "General purpose observations" });
  await write("session.append", {
    session_id: "arbitrary",
    events: [
      event(
        "prose",
        new TextEncoder().encode(
          "# Readable observation\n\n```ocaml\nlet measurement = 42\n```\n\n| key | value |\n| --- | --- |\n| exact | 9007199254740993 |",
        ),
      ),
      event("binary", new Uint8Array([0, 255, 254, 128, 13, 10])),
      event("partial", large),
    ],
  });
  const root = await mount(page, companion, daemon, "arbitrary");
  await expect(
    root.getByRole("heading", { name: "General purpose observations", exact: true }),
  ).toBeVisible();
  await expect(card(root, 3).getByText(/partial prefix/u)).toBeVisible();
  await card(root, 3)
    .getByRole("button", { name: "Load complete preview ≤16MiB", exact: true })
    .click();
  await expect(
    card(root, 3).getByText(/36000 bytes loaded · complete and verified/u),
  ).toBeVisible();
  const exact = await card(root, 3)
    .getByRole("link", { name: "Exact event link", exact: true })
    .getAttribute("href");
  expect(exact).toContain("&generation=1&head=");
  expect(exact).toContain("&event=3");
  const binary = await open(root, 2);
  await expect(binary.getByLabel("Raw byte window")).toContainText("ff fe 80");
  expect(
    await root
      .getByText("Reported metrics · exact source scopes, never session totals", { exact: true })
      .count(),
  ).toBe(0);
  const prose = await open(root, 1);
  await expect(
    prose.getByRole("heading", { name: "Readable observation", exact: true }),
  ).toBeVisible();
  await expect(prose.locator(".wg-syntax-keyword")).not.toHaveCount(0);
  await expect(prose.getByRole("table")).toBeVisible();
  await prose.getByLabel("Language override").selectOption("plain");
  await expect(prose.getByText("Source is unchanged", { exact: true })).toBeVisible();
  await write("session.append", {
    session_id: "arbitrary",
    events: [event("newer", new TextEncoder().encode("Newer than the captured event link"))],
  });
  if (!exact) throw new Error("No exact link");
  browserDiagnostics.markPendingReads();
  await page.goto(new URL(exact, companion.url).href);
  await expect(root.getByText(/event bound/u)).toContainText("3");
  await expect(card(root, 4)).toHaveCount(0);
  await expect(card(root, 3)).toBeVisible();
  await waitForPageReads(page);
  browserDiagnostics.markPendingReads();
  await root.getByRole("button", { name: "Refresh current capture", exact: true }).click();
  await expect(card(root, 4)).toBeVisible();
  await expect(root.getByText(/event bound/u)).toContainText("4");
  await capture(page, info, "generic-captured-timeline");
  expect(browserFailures).toEqual([]);
});

test("Validated source formats, exact tool grouping, reported-result provenance and raw fallback", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const write = writer(daemon),
    call = {
      ...assistant,
      message: {
        ...assistant.message,
        content: [
          { type: "tool_use", id: "call-1", name: "synthetic-tool", input: { path: "example.ml" } },
        ],
      },
    },
    output = {
      ...user,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: "```ocaml\nlet output = 42\n```\n\nretained tool output",
            is_error: false,
          },
        ],
      },
    },
    message = {
      ...assistant,
      message: {
        ...assistant.message,
        content: [{ type: "text", text: "Same exact final answer." }],
      },
    },
    final = { ...result, result: "Same exact final answer." };
  await write("session.create", {
    session_id: "recognized",
    title: "Validated recorded conversation",
  });
  await write("session.append", {
    session_id: "recognized",
    events: [
      event("call", encoded(call), { role: "assistant", kind: "tool_call", correlation: "turn-a" }),
      event("output", encoded(output), {
        role: "tool",
        kind: "tool_result",
        correlation: "turn-a",
      }),
      event("message", encoded(message), { role: "assistant", kind: "message" }),
      event("result", encoded(final), { role: "assistant", kind: "result" }),
      event(
        "signature",
        encoded({
          ...assistant,
          message: {
            ...assistant.message,
            content: [{ type: "thinking", thinking: "", signature: "opaque-signature-only" }],
          },
        }),
        { role: "assistant", kind: "thinking" },
      ),
      event("unknown", encoded({ arbitrary: "unknown schema", model: "not proof" })),
      event("response", encoded(responses), { role: "assistant", kind: "response" }),
    ],
  });
  const root = await mount(page, companion, daemon, "recognized");
  await expect(
    root.getByRole("heading", { name: "Explicit tool relationships", exact: true }),
  ).toBeVisible();
  await expect(root.getByText("synthetic-tool ·", { exact: false })).toBeVisible();
  await root.getByText("Exact tool relationship", { exact: true }).click();
  await expect(root.getByText(/Exact call ID/u)).toContainText("call-1");
  const outputCard = await open(root, 2);
  await expect(outputCard.getByRole("heading", { name: /Tool result/u })).toBeVisible();
  await expect(outputCard.locator(".wg-syntax-keyword")).not.toHaveCount(0);
  const finalCard = await open(root, 4);
  await expect(finalCard.getByText(/Same reported text as event 3/u)).toBeVisible();
  await expect(finalCard.getByText(/does not mark a ticket or project complete/u)).toBeVisible();
  await finalCard
    .getByText("Reported metrics · exact source scopes, never session totals", { exact: true })
    .click();
  await expect(finalCard.getByText("0.001 USD", { exact: true })).toBeVisible();
  await root.getByRole("button", { name: "All raw events", exact: true }).click();
  await expect(card(root, 4).getByText(/Same reported text as event 3/u)).toHaveCount(0);
  await expect(card(root, 4).getByText("Same exact final answer.", { exact: true })).toBeVisible();
  await root.getByRole("button", { name: "Timeline", exact: true }).click();
  await open(root, 6);
  await expect(card(root, 6).getByText(/Generic presentation/u)).toBeVisible();
  await root.getByLabel("Payload format").selectOption("openai.responses.object.v1");
  await expect(card(root, 6).getByText(/schema-mismatch/u)).toBeVisible();
  await root.getByLabel("Payload format").selectOption("generic");
  await expect(card(root, 6).getByText(/explicit-generic/u)).toBeVisible();
  await capture(page, info, "validated-and-generic-history");
  expect(browserFailures).toEqual([]);
});

test("Create, reviewed import, archive and saved writer survive navigation and actor switch", async ({
  page,
  daemon,
  companion,
  browserFailures,
  browserDiagnostics,
}, info) => {
  const root = await mount(page, companion, daemon);
  await actor(page, "human");
  await root
    .getByRole("button", { name: "New session at current connection", exact: true })
    .click();
  await root.getByLabel("Session ID", { exact: true }).fill("from-ui");
  await root.getByLabel("Session title", { exact: true }).fill("Created through real History UI");
  await page.getByRole("link", { name: "Work", exact: true }).click();
  await page.getByRole("link", { name: "History", exact: true }).click();
  await expect(root.getByLabel("Session title", { exact: true })).toHaveValue(
    "Created through real History UI",
  );
  await root
    .getByRole("button", { name: "Validate & prepare history action", exact: true })
    .click();
  await committed(root);
  expect(
    await daemon.call("session.get", '{"workspace_id":"demo","session_id":"from-ui"}'),
  ).toContain('"actor_id":"human"');
  await root.getByRole("button", { name: "Discard local editor", exact: true }).click();
  await root.getByRole("button", { name: "Refresh current capture", exact: true }).click();
  await root.getByRole("button", { name: "Created through real History UI", exact: true }).click();
  await expect(root.getByText(/event bound/u)).toContainText("0");
  await root.getByRole("button", { name: "Import current event inputs", exact: true }).click();
  await root
    .getByLabel("Exact event-input JSON")
    .fill(
      JSON.stringify([
        event("ui-1", new TextEncoder().encode("# Imported retained text")),
        event("ui-2", new Uint8Array([0, 255])),
      ]),
    );
  await root
    .getByRole("button", { name: "Validate & prepare history action", exact: true })
    .click();
  await committed(root);
  expect(
    await daemon.call("session.get", '{"workspace_id":"demo","session_id":"from-ui"}'),
  ).toContain('"through":"2"');
  await root.getByRole("button", { name: "Discard local editor", exact: true }).click();
  await waitForPageReads(page);
  browserDiagnostics.markPendingReads();
  await root.getByRole("button", { name: "Refresh current capture", exact: true }).click();
  await expect(card(root, 2)).toBeVisible();
  await root.getByRole("button", { name: "Archive session", exact: true }).click();
  await expect(root.getByText(/permanently prevents future appends/u)).toBeVisible();
  await root
    .getByRole("button", { name: "Validate & prepare history action", exact: true })
    .click();
  await waitForPageReads(page);
  browserDiagnostics.markPendingReads();
  await actor(page, "different-current-writer");
  const captured = root
    .locator("section.wg-panel")
    .filter({ has: page.getByRole("heading", { name: "Review captured action", exact: true }) });
  await expect(captured.getByText(/Actor human/u)).toBeVisible();
  await expect(captured.getByText(/Actor different-current-writer/u)).toHaveCount(0);
  await committed(root);
  expect(
    await daemon.call("session.get", '{"workspace_id":"demo","session_id":"from-ui"}'),
  ).toContain('"archived":true');
  await capture(page, info, "history-reviewed-archive");
  expect(browserFailures).toEqual([]);
});

test("Retained generation links keep the original same-ID session and never retarget existing-session writes", async ({
  page,
  daemon,
  companion,
  browserFailures,
  browserDiagnostics,
}, info) => {
  const second = await startDaemonFixture({ binary: daemon.binary });
  try {
    for (const [source, title] of [
      [daemon, "Original daemon session"],
      [second, "Retargeted daemon session"],
    ] as const) {
      const write = writer(source);
      await write("session.create", { session_id: "same-id", title });
      await write("session.append", {
        session_id: "same-id",
        events: [event("same-client", new TextEncoder().encode(title))],
      });
    }
    const root = await mount(page, companion, daemon, "same-id");
    await expect(
      root.getByRole("heading", { name: "Original daemon session", exact: true }),
    ).toBeVisible();
    const link = await card(root, 1)
      .getByRole("link", { name: "Exact event link", exact: true })
      .getAttribute("href");
    if (!link) throw new Error("Missing captured event link");
    const bootstrap = await page.request.get(companion.url);
    const capability =
      /<meta\s+name="workgraph-capability"\s+content="([a-f0-9]{64})"\s*\/?>/u.exec(
        await bootstrap.text(),
      )?.[1];
    if (!capability) throw new Error("Missing native capability");
    const headers = {
      Origin: new URL(companion.url).origin,
      "X-Workgraph-UI-Capability": capability,
    };
    const changed = await page.request.put(
      new URL("/ui-api/v1/connections/local", companion.url).href,
      {
        headers,
        data: { expected_generation: "1", label: "Retargeted connection", socket: second.socket },
      },
    );
    expect(changed.status()).toBe(200);
    expect(await changed.text()).toContain('"generation":"2"');
    const attached = await page.request.post(
      new URL("/ui-api/v1/connections/local/attach", companion.url).href,
      { headers, data: { generation: "2" } },
    );
    expect(attached.status()).toBe(200);
    expect(await attached.text()).toContain('"generation":"2"');
    await waitForPageReads(page);
    browserDiagnostics.markPendingReads();
    const capturedHead = new URLSearchParams(link.split("?")[1]).get("head");
    if (!capturedHead) throw new Error("Missing captured history head");
    // Hash navigation does not reset the document's networkidle state. Wait for
    // this navigation's actual reads before reloading the profile directory.
    const navigatedReads = ["session.list", "session.get", "history.payloads"].map((method) =>
      page.waitForResponse((response) => {
        if (response.request().method() !== "POST" || !response.url().endsWith("/ui-api/v1/read"))
          return false;
        const parsed = parseJsonText(response.request().postData() ?? "");
        if (!parsed.ok) return false;
        const value = parsed.value.value;
        const requestedMethod = jsonField(value, "method");
        const generation = jsonField(value, "generation");
        const params = jsonField(value, "params");
        const head = params === undefined ? undefined : jsonField(params, "head");
        return (
          requestedMethod?.kind === "string" &&
          requestedMethod.value === method &&
          generation?.kind === "string" &&
          generation.value === "1" &&
          (method === "session.list" || (head?.kind === "string" && head.value === capturedHead))
        );
      }),
    );
    await page.goto(new URL(link, companion.url).href);
    // APIRequestContext intentionally bypasses App callbacks. Reload its directory after retarget.
    for (const response of await Promise.all(navigatedReads)) {
      expect(response.status()).toBe(200);
      expect(await response.finished()).toBeNull();
    }
    // Rendering starts its content worker after payload transport finishes.
    // Exercise the selected event before destroying this document for reload.
    await expect(card(root, 1).getByText("Original daemon session", { exact: true })).toBeVisible();
    browserDiagnostics.markPendingReads();
    await page.reload();
    await expect(
      root.getByRole("heading", { name: "Original daemon session", exact: true }),
    ).toBeVisible();
    await expect(
      root.getByRole("heading", { name: "Retargeted daemon session", exact: true }),
    ).toHaveCount(0);
    await expect(root.getByText(/Viewing retained connection generation 1/u)).toBeVisible();
    await expect(
      root.getByRole("button", { name: "Import current event inputs", exact: true }),
    ).toBeDisabled();
    await expect(root.getByRole("button", { name: "Archive session", exact: true })).toBeDisabled();
    await actor(page, "human");
    await root
      .getByRole("button", { name: "New session at current connection", exact: true })
      .click();
    await expect(root.getByText(/connection local generation\s*2/u)).toBeVisible();
    await root.getByRole("button", { name: "Discard local editor", exact: true }).click();
    await waitForPageReads(page);
    browserDiagnostics.markPendingReads();
    const readURL = new URL("/ui-api/v1/read", companion.url).href;
    const rejected: Response[] = [];
    const recordRejected = (response: Response) => {
      if (response.url() === readURL && response.status() === 409) rejected.push(response);
    };
    // Only this deliberate unavailable-head READ may log its expected HTTP diagnostic.
    browserDiagnostics.expectedHTTP.set(readURL, 409);
    page.on("response", recordRejected);
    try {
      await page.goto(
        new URL(link.replace(/&head=[a-f0-9]{64}/u, "&head=" + "0".repeat(64)), companion.url).href,
      );
      await expect(root.getByRole("alert").first()).toContainText(/Conflict.*capture/u);
      await expect(
        root.getByRole("heading", { name: "Retargeted daemon session", exact: true }),
      ).toHaveCount(0);
      expect(
        await second.call("session.get", '{"workspace_id":"demo","session_id":"same-id"}'),
      ).toContain('"archived":false');
      await waitForPageReads(page);
      expect(rejected.length).toBeGreaterThan(0);
      // Inspect every matching409: /read is shared by methods, so URL-only matching is insufficient.
      for (const response of rejected) {
        expect(response.request().method()).toBe("POST");
        const request = parseJsonText(response.request().postData() ?? "");
        expect(request.ok).toBe(true);
        if (!request.ok) throw new Error("Invalid negative-proof request");
        expect(jsonField(request.value.value, "method")).toMatchObject({
          kind: "string",
          value: "session.get",
        });
        expect(jsonField(request.value.value, "connection_id")).toMatchObject({
          kind: "string",
          value: "local",
        });
        expect(jsonField(request.value.value, "generation")).toMatchObject({
          kind: "string",
          value: "1",
        });
        const params = jsonField(request.value.value, "params");
        if (params === undefined) throw new Error("Missing negative-proof parameters");
        expect(jsonField(params, "head")).toMatchObject({ kind: "string", value: "0".repeat(64) });
        expect(jsonField(params, "session_id")).toMatchObject({ kind: "string", value: "same-id" });
        expect(jsonField(params, "workspace_id")).toMatchObject({ kind: "string", value: "demo" });
        const body = parseJsonText(await response.text());
        expect(body.ok).toBe(true);
        if (!body.ok) throw new Error("Invalid negative-proof response");
        expect(jsonField(body.value.value, "ok")).toMatchObject({ kind: "boolean", value: false });
        const problem = d.problem.decode(jsonField(body.value.value, "error"));
        expect(problem.ok).toBe(true);
        if (!problem.ok) throw new Error("Invalid typed unavailable-capture problem");
        expect(problem.value.kind).toBe("Conflict");
        expect(problem.value.message).toBe("history capture head is not an ancestor");
      }
      await capture(page, info, "retained-generation-unavailable-does-not-retarget");
    } finally {
      page.off("response", recordRejected);
      browserDiagnostics.expectedHTTP.delete(readURL);
    }
    expect(browserFailures).toEqual([]);
  } finally {
    await second.dispose();
  }
});

test("Full 64 MiB native blob download uses the independent bounded worker and verifies saved bytes", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  test.setTimeout(380000);
  const write = writer(daemon),
    bytes = Buffer.alloc(67108864, 0x53),
    digest = createHash("sha256").update(bytes).digest("hex"),
    source = path.join(daemon.root, "synthetic-64MiB.bin");
  await writeFile(source, bytes);
  await execute(
    daemon.binary,
    [
      "resource",
      "upload",
      daemon.socket,
      "--workspace-id",
      "demo",
      "--actor-id",
      "fixture-author",
      "--resource-id",
      "large-blob",
      "--expected-revision",
      "0",
      "--title",
      "Synthetic 64 MiB qualification",
      "--file",
      source,
      "--save-request",
      path.join(daemon.root, "large-upload-plan.json"),
    ],
    { timeout: 120000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 },
  );
  await write("session.create", { session_id: "large", title: "Independent 64 MiB transfer" });
  await write("session.append", {
    session_id: "large",
    events: [
      {
        client_id: "large-1",
        role: "sensor",
        kind: "binary",
        phase: "recorded",
        payload: { kind: "blob", blob: { digest, size_bytes: "67108864" } },
      },
    ],
  });
  const root = await mount(page, companion, daemon, "large");
  await expect(card(root, 1).getByText(/32768 bytes loaded/u)).toBeVisible();
  await expect(
    card(root, 1).getByRole("button", { name: "Load complete preview ≤16MiB", exact: true }),
  ).toBeDisabled();
  await card(root, 1)
    .getByRole("button", { name: "Download verified exact bytes", exact: true })
    .click();
  await expect(root.getByText(/Verification pending/u)).toBeVisible();
  await actor(page, "responsive-during-transfer");
  await expect(root.getByText(/Complete file verified · 67108864 bytes/u)).toBeVisible({
    timeout: 310000,
  });
  const downloaded = page.waitForEvent("download");
  await root.getByRole("link", { name: "Save verified large-1-payload.bin", exact: true }).click();
  const file = await (await downloaded).path();
  if (!file) throw new Error("No saved download bytes");
  const hash = createHash("sha256");
  let size = 0;
  for await (const piece of createReadStream(file)) {
    if (!(piece instanceof Buffer)) throw new Error("Expected file bytes");
    hash.update(piece);
    size += piece.length;
  }
  expect(size).toBe(67108864);
  expect(hash.digest("hex")).toBe(digest);
  await info.attach("verified64MiB-download", {
    body: JSON.stringify({
      source_digest: digest,
      saved_size: size,
      chunk_limit: 262144,
      maximum_bytes: 67108864,
    }),
    contentType: "application/json",
  });
  await capture(page, info, "verified64MiB-download");
  expect(browserFailures).toEqual([]);
});
