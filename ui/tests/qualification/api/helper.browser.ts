import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, expect } from "../../../frontend/tests/e2e/support/fixtures";
const execute = promisify(execFile);
const extras = [
  "--version",
  "--help",
  "capabilities",
  "discover",
  "methods",
  "help",
  "schema",
  "migrate.cleanup",
  "CLI aliases and option forms",
  "wgx",
  "history-adapter.py",
  "transcript-converter.py",
] as const;
test("all 44 native helper, recipe and host dispositions are actually accessible passive guidance", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const bootstrap = await page.request.get(companion.url);
  expect(bootstrap.ok()).toBe(true);
  const capability = /<meta\s+name="workgraph-capability"\s+content="([a-f0-9]{64})"\s*\/?>/u.exec(
    await bootstrap.text(),
  )?.[1];
  if (!capability) throw new Error("Missing native capability");
  const headers = {
    "X-Workgraph-UI-Capability": capability,
    Origin: new URL(companion.url).origin,
  };
  for (const [path, data] of [
    ["/connections", { id: "local", label: "API qualification daemon", socket: daemon.socket }],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const result = await page.request.post(new URL(`/ui-api/v1${path}`, companion.url).href, {
      headers,
      data,
    });
    expect(result.ok()).toBe(true);
  }
  const metadata = await execute(daemon.binary, ["discover", "--catalog", "--output", "json"], {
    maxBuffer: 4 * 1024 * 1024,
  });
  const entries = (
    JSON.parse(metadata.stdout) as {
      entries: { name: string; kind: string; steps: readonly string[]; reference: string }[];
    }
  ).entries.filter((item) => item.kind !== "method");
  expect(entries).toHaveLength(32);
  await page.goto(
    new URL("/#/advanced?connection=local&workspace=demo&project=release", companion.url).href,
  );
  const root = page.locator("#root");
  await expect(
    root.getByText("269 methods · 44 helper / host surfaces", { exact: true }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  const requests: string[] = [];
  const record = (
    request: import("../../../frontend/node_modules/@playwright/test/index.js").Request,
  ) => {
    if (request.method() !== "GET")
      requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
  };
  page.on("request", record);
  const checked: { name: string; kind: string; steps: number }[] = [];
  try {
    await root.getByRole("button", { name: "Helpers", exact: true }).click();
    for (const entry of entries) {
      await root.getByLabel("Search catalogue").fill(entry.name);
      await root
        .locator(".adv-item")
        .filter({
          has: page.locator("code", {
            hasText: new RegExp(`^${entry.name.replaceAll(".", "\\.")}$`, "u"),
          }),
        })
        .click();
      const heading = root.getByRole("heading", { name: entry.name, exact: true });
      await expect(heading).toBeVisible();
      const panel = heading.locator("..");
      await expect(
        root.getByText("Commands are copyable instructions. The browser does not execute them.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(root.getByRole("button", { name: "Copy command", exact: true })).toBeVisible();
      await expect(root.getByText(`Reference: ${entry.reference}`, { exact: true })).toBeVisible();
      expect(await panel.count()).toBe(1);
      expect(await root.locator(".adv-steps li").allTextContents()).toEqual(entry.steps);
      checked.push({ name: entry.name, kind: entry.kind, steps: entry.steps.length });
    }
    await root.getByRole("button", { name: "Host tools", exact: true }).click();
    for (const name of extras) {
      await root.getByLabel("Search catalogue").fill(name);
      await root
        .locator(".adv-item")
        .filter({
          has: page.locator("code", {
            hasText: new RegExp(`^${name.replaceAll(".", "\\.")}$`, "u"),
          }),
        })
        .click();
      await expect(root.getByRole("heading", { name, exact: true })).toBeVisible();
      await expect(
        root.getByText("Commands are copyable instructions. The browser does not execute them.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(root.getByRole("button", { name: "Copy command", exact: true })).toBeVisible();
      checked.push({ name, kind: "host", steps: 0 });
    }
    await root.getByLabel("Search catalogue").fill("qualification-absent-host");
    await expect(root.locator(".adv-item")).toHaveCount(0);
    expect(checked).toHaveLength(44);
    expect(new Set(checked.map((item) => item.name)).size).toBe(44);
    expect(requests, "Reading passive guidance must not execute a command or send writes").toEqual(
      [],
    );
    expect(browserFailures).toEqual([]);
    await info.attach("helper-dispositions", {
      contentType: "application/json",
      body: JSON.stringify(
        {
          ui: companion.binarySha256,
          daemon: createHash("sha256")
            .update(await readFile(daemon.binary))
            .digest("hex"),
          checked,
          requests,
        },
        null,
        2,
      ),
    });
  } finally {
    page.off("request", record);
  }
});
