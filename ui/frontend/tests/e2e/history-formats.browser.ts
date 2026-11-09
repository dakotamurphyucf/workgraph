import { createHash } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./support/fixtures";
import { chat } from "../history/formats/fixtures";

async function reveal(root: Locator, name: string) {
  const summary = root.locator("summary").filter({ hasText: new RegExp(`^${name}$`, "u") });
  if (!(await summary.locator("..").evaluate((element) => element.hasAttribute("open"))))
    await summary.click();
}
async function open(root: Locator, sequence: number) {
  const row = root.locator(`#history-event-${sequence}`);
  const control = row.locator(":scope > header button[aria-expanded]");
  if ((await control.getAttribute("aria-expanded")) !== "true") await control.click();
  await expect(row.locator(".ht-payload")).toBeVisible();
  return row;
}
async function bytes(page: Page, viewer: Locator) {
  await reveal(viewer, "Content options");
  const pending = page.waitForEvent("download");
  await viewer.getByRole("button", { name: "Download source", exact: true }).click();
  const stream = await (await pending).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    const value: unknown = chunk;
    if (!(value instanceof Uint8Array)) throw new Error("Non-byte source download chunk");
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

test("arbitrary history metadata and future format envelopes retain exact bytes, order and pinned event deep links without vendor inference", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  let serial = 0;
  const write = async (method: string, params: Readonly<Record<string, unknown>>) => {
    const raw = await daemon.call(
      method,
      JSON.stringify({
        workspace_id: "demo",
        actor_id: "arbitrary-source-author",
        mutation_id: `history-format-gate-${++serial}`,
        ...params,
      }),
    );
    const reply: unknown = JSON.parse(raw);
    if (reply === null || typeof reply !== "object" || "error" in reply)
      throw new Error(`Native synthetic ${method} failed: ${raw}`);
    return raw;
  };
  const sensor =
    '{"model":"OpenAI","role":"assistant","reading":9007199254740993,"decimal":1.2300,"negative_zero":-0,"missing_metric":null,"text":"<img src=https://format-probe.invalid/leak onerror=globalThis.historyFormatProbe=true>"}\n';
  const future = JSON.stringify({
    ...chat,
    object: "chat.completion.future.v999",
    schema_version: "999",
  });
  const source = [sensor, future, JSON.stringify(chat)];
  await write("session.create", {
    session_id: "arbitrary-format",
    title: "Arbitrary caller records",
  });
  const event = (text: string, index: number) => ({
    client_id: `sensor-${index}`,
    role: "sensor-operator",
    kind: "telemetry-reading",
    phase: "recorded",
    correlation: "weather-sample-17",
    provenance: { producer: "synthetic-sensor-v1", format_hint: "OpenAI" },
    payload: { kind: "inline", bytes_base64: Buffer.from(text).toString("base64") },
  });
  await write("session.append", { session_id: "arbitrary-format", events: source.map(event) });
  const html = await (await page.request.get(companion.url)).text();
  const capability = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(html)?.[1];
  if (!capability) throw new Error("Missing actual native bootstrap capability");
  for (const [path, data] of [
    ["/connections", { id: "local", label: "Format qualification", socket: daemon.socket }],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const response = await page.request.post(new URL(`/ui-api/v1${path}`, companion.url).href, {
      headers: { Origin: new URL(companion.url).origin, "X-Workgraph-UI-Capability": capability },
      data,
    });
    expect(response.status()).toBe(200);
    await response.text();
  }
  const external: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== new URL(companion.url).origin)
      external.push(request.url());
  });
  await page.goto(
    new URL("/#/history?connection=local&workspace=demo&entity=arbitrary-format", companion.url)
      .href,
  );
  const root = page.locator(".ht-root");
  const coverage = root.getByLabel("Current window format coverage").getByRole("status");
  await expect(coverage).toHaveText("1 validated · 2 Generic");
  await expect(root.locator(".ht-event > header button[aria-expanded]")).toHaveText([
    "#1 sensor-operator · telemetry-reading",
    "#2 sensor-operator · telemetry-reading",
    "#3 sensor-operator · telemetry-reading",
  ]);
  const first = await open(root, 1);
  await expect(first.locator(".ht-payload-summary")).toContainText("Generic");
  await reveal(first, "Recorded attribution and correlation");
  await expect(first.getByText(/Recorded actor arbitrary-source-author/u)).toContainText(
    "client ID sensor-0 · correlation weather-sample-17",
  );
  await reveal(first, "Raw event metadata and provenance");
  const metadata = first.getByRole("region", { name: "Content: Raw event metadata", exact: true });
  await expect(metadata).toContainText("synthetic-sensor-v1");
  await expect(metadata).toContainText("format_hint");
  await root.getByLabel("Payload format").selectOption("openai.chat-completions.object.v1");
  await expect(coverage).toHaveText("1 validated · 2 Generic");
  await expect(first.getByText(/schema-mismatch/u)).toBeVisible();
  const second = await open(root, 2);
  await expect(second.getByText(/schema-mismatch/u)).toBeVisible();
  await root.getByLabel("Payload format").selectOption("generic");
  await expect(coverage).toHaveText("3 loaded payloads in Generic view");
  for (const [index, text] of source.entries()) {
    const row = await open(root, index + 1);
    const viewer = row.getByRole("region", {
      name: `Content: Event ${index + 1} payload`,
      exact: true,
    });
    expect(await bytes(page, viewer)).toEqual(Buffer.from(text));
  }
  expect(await page.evaluate(() => Object.hasOwn(globalThis, "historyFormatProbe"))).toBe(false);
  expect(external).toEqual([]);
  const exact = await first
    .getByRole("link", { name: "Exact event link", exact: true })
    .getAttribute("href");
  if (!exact) throw new Error("Missing actual captured event link");
  const query = new URLSearchParams(exact.slice(exact.indexOf("?") + 1));
  expect(query.get("generation")).toBe("1");
  expect(query.get("event")).toBe("1");
  expect(query.get("head")).toMatch(/^[a-f0-9]{64}$/u);
  await write("session.append", {
    session_id: "arbitrary-format",
    events: [event("later source outside capture", 3)],
  });
  const afterAppend = await daemon.call(
    "session.get",
    '{"workspace_id":"demo","session_id":"arbitrary-format"}',
  );
  await page.goto(new URL(exact, companion.url).href);
  await expect(root.locator("#history-event-1 .ht-payload")).toBeVisible();
  await expect(root.locator("#history-event-4")).toHaveCount(0);
  await page.reload();
  await expect(root.locator("#history-event-1 .ht-payload")).toBeVisible();
  await expect(root.locator("#history-event-4")).toHaveCount(0);
  await expect(root.getByLabel("Payload format")).toHaveValue("auto");
  await expect(root.locator(".ht-event")).toHaveCount(1);
  await expect(coverage).toHaveText("0 validated · 1 Generic");
  expect(
    await bytes(page, first.getByRole("region", { name: "Content: Event 1 payload", exact: true })),
  ).toEqual(Buffer.from(sensor));
  expect(
    await daemon.call("session.get", '{"workspace_id":"demo","session_id":"arbitrary-format"}'),
  ).toBe(afterAppend);
  await info.attach("arbitrary-original-source-pins", {
    body: JSON.stringify({
      exact,
      sources: source.map((text) => ({
        bytes: Buffer.byteLength(text),
        sha256: createHash("sha256").update(text).digest("hex"),
      })),
      external,
    }),
    contentType: "application/json",
  });
  const picture = info.outputPath("arbitrary-format-pinned-capture.png");
  await page.screenshot({ path: picture });
  await info.attach("arbitrary-format-pinned-capture", { path: picture, contentType: "image/png" });
  expect(browserFailures).toEqual([]);
});
