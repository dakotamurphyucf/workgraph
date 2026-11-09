import { waitForPageReads } from "./support/readiness";
import { createHash } from "node:crypto";
import type { Page, TestInfo } from "@playwright/test";
import type { CompanionFixture } from "../../../test-support/companion-fixture.mjs";
import {
  fixtureBinary,
  startDaemonFixture,
  type DaemonFixture,
} from "../../../test-support/daemon-fixture.mjs";
import { test, expect } from "./support/fixtures";

test.use({ colorScheme: "dark", viewport: { width: 1480, height: 1000 }, actionTimeout: 12000 });
test.setTimeout(60000);
type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed closed native fixture record");
  return Object.fromEntries(Object.entries(value));
}
async function native(daemon: DaemonFixture, method: string, params: RecordValue) {
  const reply = object(
    JSON.parse(await daemon.call(method, JSON.stringify({ workspace_id: "demo", ...params }))),
  );
  if (reply.error !== undefined) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
  return object(object(reply.result).data);
}
function writer(daemon: DaemonFixture) {
  let serial = 0;
  return (method: string, params: RecordValue) =>
    native(daemon, method, {
      actor_id: "history-fixture-author",
      mutation_id: `knowledge-gate-${++serial}`,
      ...params,
    });
}
async function metadata(page: Page, companion: CompanionFixture, path: string, data: RecordValue) {
  const capability = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(
    await (await page.request.get(companion.url)).text(),
  )?.[1];
  if (capability === undefined) throw new Error("Missing actual bootstrap capability");
  const response = await page.request.fetch(new URL(`/ui-api/v1${path}`, companion.url).href, {
    method: path === "/connections/local" ? "PUT" : "POST",
    headers: { Origin: new URL(companion.url).origin, "X-Workgraph-UI-Capability": capability },
    data,
  });
  expect(response.status()).toBe(200);
  await response.text();
}
async function seed(daemon: DaemonFixture, label: string) {
  const write = writer(daemon),
    body = `# ${label} recorded resource\n\nImmutable first publication 雪.\n`,
    digest = createHash("sha256").update(body).digest("hex");
  await write("run.register", {
    target_run_id: "history-origin-run",
    objective: `${label} recorded invocation`,
  });
  await write("ticket.create", {
    project_id: "release",
    ticket_id: "history-origin-ticket",
    title: `${label} recorded ticket`,
  });
  await write("resource.put_text", {
    resource_id: "history-origin-resource",
    expected_revision: "0",
    title: `${label} recorded resource`,
    filename: "recorded.md",
    mime_type: "text/markdown",
    text: body,
  });
  await write("session.create", {
    session_id: "history-origin-session",
    title: `${label} captured session`,
    run_id: "history-origin-run",
    scopes: [{ kind: "ticket", id: "history-origin-ticket" }],
  });
  await write("session.append", {
    session_id: "history-origin-session",
    run_id: "history-origin-run",
    events: [
      {
        client_id: "recorded-artifact",
        role: "sensor",
        kind: "artifact",
        phase: "recorded",
        payload: {
          kind: "inline",
          bytes_base64: Buffer.from(`${label} recorded event`).toString("base64"),
        },
        resource_versions: [{ resource_id: "history-origin-resource", revision: "1" }],
      },
    ],
  });
  return { write, body, digest };
}
async function refreshProfiles(page: Page) {
  await page.locator(".wg-workspace-switch").click();
  const dialog = page.getByRole("dialog", { name: "Daemon connections", exact: true });
  await dialog.getByRole("button", { name: "Refresh profiles", exact: true }).click();
  await expect(dialog.getByText(/local · generation 2/u)).toBeVisible();
  await dialog.getByRole("button", { name: "Close Daemon connections", exact: true }).click();
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

for (const destination of ["run", "resource"] as const) {
  test(`History originating ${destination} callback retains actual endpoint and immutable association through repeated-ID retarget and original unavailability`, async ({
    page,
    daemon,
    companion,
    browserFailures,
    browserDiagnostics,
  }, info) => {
    const other = await startDaemonFixture({ binary: fixtureBinary() });
    try {
      const original = await seed(daemon, "Original"),
        replacement = await seed(other, "Replacement");
      await original.write("resource.put_text", {
        resource_id: "history-origin-resource",
        expected_revision: "1",
        title: "New current resource",
        filename: "current.md",
        mime_type: "text/markdown",
        text: "# Current v2 must not replace recorded v1\n",
      });
      await metadata(page, companion, "/connections", {
        id: "local",
        label: "Original History endpoint",
        socket: daemon.socket,
      });
      await metadata(page, companion, "/connections/local/attach", { generation: "1" });
      await page.goto(
        new URL(
          "/#/history?connection=local&workspace=demo&entity=history-origin-session",
          companion.url,
        ).href,
      );
      await expect(
        page.getByRole("heading", { name: "Original captured session", exact: true }),
      ).toBeVisible();
      const event = page.locator("#history-event-1");
      await event.getByRole("link", { name: "Exact event link", exact: true }).click();
      await expect(page).toHaveURL(/generation=1/u);
      await expect(page).toHaveURL(/head=[a-f0-9]{64}/u);
      await expect(page).toHaveURL(/event=1/u);
      const details = page.locator("summary").filter({ hasText: /^Session details ·/u });
      if (!(await details.evaluate((node) => node.parentElement?.hasAttribute("open"))))
        await details.click();
      await expect(
        page.getByRole("button", { name: "history-origin-run", exact: true }),
      ).toBeVisible();
      await expect(
        event.getByRole("button", {
          name: "Resource history-origin-resource · immutable content version 1",
          exact: true,
        }),
      ).toBeVisible();
      await waitForPageReads(page);
      // The actual rendered callback owns its observed generation1 before retarget.
      await metadata(page, companion, "/connections/local", {
        expected_generation: "1",
        label: "Repeated History IDs elsewhere",
        socket: other.socket,
      });
      await metadata(page, companion, "/connections/local/attach", { generation: "2" });
      const reads: RecordValue[] = [],
        writes: string[] = [];
      const readURL = new URL("/ui-api/v1/read", companion.url).href;
      page.on("request", (request) => {
        if (request.url() === readURL && request.method() === "POST")
          reads.push(object(JSON.parse(request.postData() ?? "null")));
        if (
          request.method() !== "GET" &&
          /\/ui-api\/v1\/(operations|daemon-launches|administration)/u.test(request.url())
        )
          writes.push(request.url());
      });
      if (destination === "run") {
        await page.getByRole("button", { name: "history-origin-run", exact: true }).click();
        await expect(page).toHaveURL(/[?&]generation=1(?:&|$)/u);
        await expect(
          page.getByRole("heading", { name: "Run history-origin-run", exact: true }),
        ).toBeVisible();
        await expect(
          page
            .locator(".wg-panel")
            .filter({
              has: page.getByRole("heading", { name: "Run history-origin-run", exact: true }),
            })
            .last()
            .getByText("Original recorded invocation", { exact: true }),
        ).toBeVisible();
        await expect(
          page.getByText("Replacement recorded invocation", { exact: true }),
        ).toHaveCount(0);
      } else {
        await event
          .getByRole("button", {
            name: "Resource history-origin-resource · immutable content version 1",
            exact: true,
          })
          .click();
        await expect(page).toHaveURL(/resource_generation=1/u);
        await expect(page).toHaveURL(/content_version=1/u);
        await expect(
          page.getByRole("heading", { name: "Original recorded resource", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("heading", {
            name: "Current v2 must not replace recorded v1",
            exact: true,
          }),
        ).toHaveCount(0);
        await expect(
          page.getByRole("heading", { name: "Replacement recorded resource", exact: true }),
        ).toHaveCount(0);
      }
      await waitForPageReads(page);
      await refreshProfiles(page);
      await page.reload();
      await expect(
        destination === "run"
          ? page
              .locator(".wg-panel")
              .filter({
                has: page.getByRole("heading", { name: "Run history-origin-run", exact: true }),
              })
              .last()
              .getByText("Original recorded invocation", { exact: true })
          : page.getByText("Immutable first publication 雪.", { exact: true }),
      ).toBeVisible();
      await waitForPageReads(page);
      const relevant = () =>
        reads.filter((request) =>
          destination === "run"
            ? request.method === "run.get"
            : typeof request.method === "string" && request.method.startsWith("resource."),
        );
      expect(relevant().length).toBeGreaterThan(0);
      expect(
        relevant().every(
          (request) => request.connection_id === "local" && request.generation === "1",
        ),
      ).toBe(true);
      await screenshot(page, info, `history-${destination}-original-association-after-retarget`);
      reads.length = 0;
      await daemon.dispose();
      const unavailableURL =
        destination === "run"
          ? new URL("/ui-api/v1/connections/local/attach", companion.url).href
          : readURL;
      browserDiagnostics.expectedHTTP.set(unavailableURL, 503);
      const deniedResponse = page.waitForResponse(
        (response) => response.url() === unavailableURL && response.status() === 503,
      );
      await page.reload();
      const denied = await deniedResponse;
      expect(denied.request().postDataJSON()).toMatchObject(
        destination === "run"
          ? { generation: "1" }
          : { connection_id: "local", generation: "1", params: { workspace_id: "demo" } },
      );
      const deniedBody = object(JSON.parse(await denied.text()));
      expect(deniedBody.ok).toBe(false);
      expect(object(deniedBody.error).kind).toBe("Storage_unavailable");
      expect(object(deniedBody.error).message).toContain(daemon.socket);
      if (destination === "resource")
        await expect(
          page.getByRole("heading", { name: "Publication unavailable", exact: true }),
        ).toBeVisible();
      else
        await expect(
          page
            .getByRole("alert")
            .filter({ hasText: /unavailable|connect|socket|connection/iu })
            .first(),
        ).toBeVisible();
      await expect(page.getByText("Original recorded invocation", { exact: true })).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: "Original recorded resource", exact: true }),
      ).toHaveCount(0);
      await expect(page.getByText("Replacement recorded invocation", { exact: true })).toHaveCount(
        0,
      );
      await expect(
        page.getByRole("heading", { name: "Replacement recorded resource", exact: true }),
      ).toHaveCount(0);
      await waitForPageReads(page);
      if (destination === "run") expect(relevant()).toEqual([]);
      else {
        expect(relevant().length).toBeGreaterThan(0);
        expect(
          relevant().every(
            (request) => request.connection_id === "local" && request.generation === "1",
          ),
        ).toBe(true);
      }
      const otherRun = await native(other, "run.get", { target_run_id: "history-origin-run" }),
        otherResource = await native(other, "resource.get", {
          resource_id: "history-origin-resource",
        });
      expect(otherRun.objective).toBe("Replacement recorded invocation");
      expect(object(otherResource.current_version).revision).toBe("1");
      expect(object(otherResource.current_version).digest).toBe(replacement.digest);
      expect(writes).toEqual([]);
      await info.attach("unavailable-retained-history-target-reads-and-native-readbacks", {
        body: JSON.stringify(
          {
            destination,
            unavailable: {
              url: unavailableURL,
              request: object(denied.request().postDataJSON()),
              response: deniedBody,
            },
            requests: relevant(),
            otherRun,
            otherResource,
            originalDigest: original.digest,
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
      await screenshot(
        page,
        info,
        `history-${destination}-original-unavailable-no-current-fallback`,
      );
      expect(browserFailures).toEqual([]);
    } finally {
      await page.close();
      await other.dispose();
      await info.attach("other-daemon-after-dispose", {
        body: JSON.stringify(other.diagnostics()),
        contentType: "application/json",
      });
    }
  });
}
