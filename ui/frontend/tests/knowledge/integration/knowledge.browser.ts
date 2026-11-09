import { waitForPageReads } from "../../e2e/support/readiness";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import type { CompanionFixture } from "../../../../test-support/companion-fixture.mjs";
import type { DaemonFixture } from "../../../../test-support/daemon-fixture.mjs";
import { test, expect } from "../../e2e/support/fixtures";

test.use({ viewport: { width: 1400, height: 800 }, colorScheme: "dark", actionTimeout: 12000 });
const first = '{"version":"original","number":9007199254740993,"nullable":null}';
const second = '{"version":"current","number":9007199254740994,"nullable":null}';
const sha = (source: string | Buffer) => createHash("sha256").update(source).digest("hex");

async function configure(page: Page, companion: CompanionFixture, daemon: DaemonFixture) {
  const capability = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(
    await (await page.request.get(companion.url)).text(),
  )?.[1];
  if (!capability) throw new Error("Actual native bootstrap capability missing");
  for (const [path, data] of [
    ["/connections", { id: "local", label: "Knowledge integration", socket: daemon.socket }],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const response = await page.request.post(new URL(`/ui-api/v1${path}`, companion.url).href, {
      headers: {
        Origin: new URL(companion.url).origin,
        "X-Workgraph-UI-Capability": capability,
      },
      data,
    });
    expect(response.status(), await response.text()).toBe(200);
  }
}

async function seed(daemon: DaemonFixture) {
  let serial = 0;
  const write = async (method: string, params: object) => {
    const response: unknown = JSON.parse(
      await daemon.call(
        method,
        JSON.stringify({
          workspace_id: "demo",
          actor_id: "fixture-author",
          mutation_id: `knowledge-integration-${++serial}`,
          ...params,
        }),
      ),
    );
    if (typeof response !== "object" || response === null || !("result" in response))
      throw new Error(JSON.stringify(response));
  };
  await write("resource.put_text", {
    resource_id: "knowledge-proof",
    expected_revision: "0",
    title: "Original Knowledge proof",
    filename: "proof.json",
    mime_type: "application/json",
    text: first,
  });
  await write("session.create", { session_id: "knowledge-history", title: "Knowledge source" });
  await write("session.append", {
    session_id: "knowledge-history",
    events: [
      {
        client_id: "knowledge-source",
        role: "sensor",
        kind: "artifact",
        phase: "recorded",
        payload: {
          kind: "inline",
          bytes_base64: Buffer.from("Recorded original").toString("base64"),
        },
        resource_versions: [{ resource_id: "knowledge-proof", revision: "1" }],
      },
    ],
  });
  await write("resource.put_text", {
    resource_id: "knowledge-proof",
    expected_revision: "1",
    title: "Current Knowledge proof",
    filename: "proof.json",
    mime_type: "application/json",
    text: second,
  });
  await write("fact.put", {
    scope: { kind: "project", id: "release" },
    key: "knowledge.references",
    expected_revision: "0",
    value: { explanation: "Current references and immutable History are distinct", nullable: null },
    references: [
      { kind: "resource", id: "knowledge-proof" },
      { kind: "ticket", id: "build" },
    ],
  });
}

test("Knowledge combines current Fact references, verified rich comparisons and immutable History pins in one Application", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  await seed(daemon);
  await configure(page, companion, daemon);
  await page.goto(
    new URL("/#/facts?connection=local&workspace=demo&project=release", companion.url).href,
  );
  const document = await page.evaluateHandle(() => globalThis.document);
  let documents = 0;
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++;
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET" && path !== "/ui-api/v1/read") mutations.push(path);
  });
  await page.getByLabel("New or existing fact key", { exact: true }).fill("knowledge.references");
  await page.getByRole("button", { name: "Inspect exact key", exact: true }).click();
  const fact = page.locator(".wg-panel").filter({
    has: page.getByRole("heading", { name: "Fact knowledge.references", exact: true }),
  });
  await expect(fact).toContainText("Current references and immutable History are distinct");
  await waitForPageReads(page);
  await fact.getByRole("button", { name: "Open referenced resource", exact: true }).click();
  await expect(page).toHaveURL(/resource_generation=1/u);
  expect(new URL(page.url()).hash).not.toContain("content_version=");
  const viewer = page.getByRole("region", {
    name: "Resource rich content and comparison",
    exact: true,
  });
  await expect(
    viewer.getByRole("region", { name: "Lossless JSON tree", exact: true }),
  ).toContainText("9007199254740994");
  await viewer.getByText("Compare immutable content versions", { exact: true }).click();
  await viewer.getByLabel("Right content version", { exact: true }).fill("1");
  await viewer.getByRole("button", { name: "Load exact comparison", exact: true }).click();
  await expect(viewer.getByRole("region", { name: "JSON differences", exact: true })).toContainText(
    "9007199254740993",
  );
  await expect(viewer).toContainText("Left: proof.json · content v2");
  await expect(viewer).toContainText("Right: proof.json · content v1");
  const pending = page.waitForEvent("download");
  await viewer.getByRole("button", { name: "Download verified right", exact: true }).click();
  const downloaded = await pending;
  const file = info.outputPath("compared-original.json");
  await downloaded.saveAs(file);
  expect(sha(await readFile(file))).toBe(sha(first));
  await info.attach("verified-comparison-original", {
    path: file,
    contentType: "application/json",
  });
  await waitForPageReads(page);
  await page.goBack();
  await expect(fact).toBeVisible();
  await fact.getByRole("button", { name: "Open referenced ticket", exact: true }).click();
  await expect(page).toHaveURL(/entity=build/u);
  await expect(page.getByRole("heading", { name: "Tickets", exact: true })).toBeVisible();
  await waitForPageReads(page);
  await page.evaluate(() => {
    location.hash = "#/history?connection=local&workspace=demo&entity=knowledge-history";
  });
  const event = page.locator("#history-event-1");
  await event.getByRole("link", { name: "Exact event link", exact: true }).click();
  await waitForPageReads(page);
  await event
    .getByRole("button", {
      name: "Resource knowledge-proof · immutable content version 1",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/content_version=1/u);
  await expect(
    viewer.getByRole("region", { name: "Lossless JSON tree", exact: true }),
  ).toContainText("9007199254740993");
  await expect(viewer).not.toContainText("9007199254740994");
  expect(new URL(page.url()).hash).toContain("resource_generation=1");
  const finalDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download verified file", exact: true }).click();
  const finalFile = info.outputPath("history-original.json");
  await (await finalDownload).saveAs(finalFile);
  expect(await readFile(finalFile, "utf8")).toBe(first);
  expect(await document.evaluate((captured) => captured === globalThis.document)).toBe(true);
  await document.dispose();
  expect(documents).toBe(0);
  expect(mutations).toEqual([]);
  expect(browserFailures).toEqual([]);
  const screenshot = info.outputPath("integrated-knowledge-original.png");
  await page
    .getByRole("region", { name: "Lossless JSON tree", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: screenshot, fullPage: false });
  await info.attach("integrated-knowledge-original", {
    path: screenshot,
    contentType: "image/png",
  });
});
