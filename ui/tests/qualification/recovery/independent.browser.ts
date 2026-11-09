import type { Page } from "../../../frontend/node_modules/@playwright/test";
import { jsonField, parseJsonText, type JsonValue } from "../../../frontend/src/core/json";
import { test, expect } from "../../../frontend/tests/e2e/support/fixtures";

test.use({ colorScheme: "dark", viewport: { width: 1500, height: 1000 } });

function parsed(text: string): JsonValue {
  const result = parseJsonText(text);
  if (!result.ok) throw new Error(`Invalid synthetic fixture JSON: ${result.error.message}`);
  return result.value.value;
}
function field(value: JsonValue, key: string): JsonValue {
  const found = jsonField(value, key);
  if (found === undefined) throw new Error(`Missing native fixture field ${key}`);
  return found;
}
function text(value: JsonValue): string {
  if (value.kind !== "string") throw new Error("Expected native identity string");
  return value.value;
}
async function open(page: Page, url: string) {
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Tickets", exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill("fixture-author");
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Progress and handoff", exact: true }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Participation action", { exact: true }).selectOption("comment.add");
  await page.getByRole("button", { name: "Open participation composer", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Post ticket comment", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("independent actual tabs preserve two identical comment intentions without repeated Post duplicates", async ({
  page,
  context,
  companion,
  daemon,
  browserFailures,
}, info) => {
  test.setTimeout(60_000);
  const origin = new URL(companion.url).origin;
  const html = await page.request.get(companion.url);
  const capabilities = [
    ...(await html.text()).matchAll(/<meta name="workgraph-capability" content="([a-f0-9]{64})"/gu),
  ];
  const capability = capabilities[0]?.[1];
  if (capabilities.length !== 1 || capability === undefined)
    throw new Error("Missing exact bootstrap capability");
  for (const [path, data] of [
    ["/connections", { id: "local", label: "Recovery independent tabs", socket: daemon.socket }],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const response = await page.request.post(new URL(`/ui-api/v1${path}`, origin).href, {
      headers: { "X-Workgraph-UI-Capability": capability, Origin: origin },
      data,
    });
    expect(response.status()).toBe(200);
    await response.text();
  }
  const url = new URL(
    "/#/work?connection=local&workspace=demo&project=release&entity=design",
    origin,
  ).href;
  const other = await context.newPage();
  const otherFailures: string[] = [],
    intentions: string[] = [];
  other.on("pageerror", (error) => otherFailures.push(`pageerror: ${error.message}`));
  other.on("console", (message) => {
    if (message.type() === "error") otherFailures.push(`console: ${message.text()}`);
  });
  other.on("requestfailed", (request) =>
    otherFailures.push(
      `requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText}`,
    ),
  );
  for (const owned of [page, other])
    owned.on("request", (request) => {
      const target = new URL(request.url());
      if (target.origin !== origin) otherFailures.push(`external request: ${target.href}`);
      if (request.method() === "POST" && target.pathname === "/ui-api/v1/operations/prepare") {
        const body = request.postData();
        if (body === null) otherFailures.push("Missing preparation body");
        else intentions.push(text(field(parsed(body), "intention_id")));
      }
    });
  try {
    const first = await open(page, url),
      second = await open(other, url);
    const body = "Independent identical recovery comment 雪";
    await first.getByLabel("Message", { exact: true }).fill(body);
    await second.getByLabel("Message", { exact: true }).fill(body);
    for (const dialog of [first, second]) {
      // Two dispatches in one browser turn exercise the same controller flight;
      // the other tab remains an independent editor with its own intention.
      await dialog.getByRole("button", { name: "Post", exact: true }).evaluate((button) => {
        (button as HTMLButtonElement).click();
        (button as HTMLButtonElement).click();
      });
      await expect(dialog.getByText("Committed", { exact: true })).toBeVisible();
    }
    const raw = await daemon.call(
      "comment.list",
      JSON.stringify({
        workspace_id: "demo",
        target: { kind: "ticket", id: "design" },
        max_bytes: "1048576",
      }),
    );
    const items = field(field(field(parsed(raw), "result"), "data"), "items");
    if (items.kind !== "array") throw new Error("Expected actual native comment list");
    const matching = items.items.filter((row) => text(field(row, "body")) === body);
    expect(matching).toHaveLength(2);
    expect(new Set(matching.map((row) => text(field(row, "comment_id")))).size).toBe(2);
    expect(matching.map((row) => text(field(row, "author_id")))).toEqual([
      "fixture-author",
      "fixture-author",
    ]);
    expect(intentions).toHaveLength(2);
    expect(new Set(intentions).size).toBe(2);
    for (const [label, owned] of [
      ["one", page],
      ["two", other],
    ] as const) {
      const path = info.outputPath(`recovery-independent-tab-${label}.png`);
      await owned.screenshot({ path, fullPage: false });
      await info.attach(`recovery-independent-tab-${label}`, { path, contentType: "image/png" });
    }
    await info.attach("independent-native-comments.json", {
      body: raw,
      contentType: "application/json",
    });
    await info.attach("independent-intentions.json", {
      body: JSON.stringify(intentions),
      contentType: "application/json",
    });
    await page.waitForLoadState("networkidle");
    await other.waitForLoadState("networkidle");
    expect(browserFailures).toEqual([]);
    expect(otherFailures).toEqual([]);
  } finally {
    await other.close();
    await info.attach("second-tab-diagnostics.json", {
      body: JSON.stringify(otherFailures),
      contentType: "application/json",
    });
  }
  expect(otherFailures).toEqual([]);
});
