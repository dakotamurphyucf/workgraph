import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import { stringifyJson } from "../../../src/core/json";
import * as d from "../../../src/core/protocol/decoders";
import { stageParams } from "../../../src/features/workflow/plans/model";
import { decode } from "../../work/actions-fixtures";
import { createHash } from "node:crypto";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import type { CompanionFixture } from "../../../../test-support/companion-fixture.mjs";
import type { DaemonFixture } from "../../../../test-support/daemon-fixture.mjs";
import { test, expect } from "../../e2e/support/fixtures";

test.use({ colorScheme: "dark", viewport: { width: 1600, height: 1050 }, actionTimeout: 10000 });
const op = (method: string, params: unknown, alias: string | null = null) => ({
  method,
  params,
  alias,
});
const exposure = (operation: number, disposition = "held") => ({
  operation,
  disposition,
  deferred: disposition === "held" ? "Later configuration" : "",
  templateDigest: null,
});
const stage = (
  id: string,
  operations: unknown[],
  bindings: unknown[] = [],
  exposures: unknown[] = [],
) => ({
  id,
  title: id,
  operations,
  bindings,
  exposures,
  exposure: "Explicit independent commit; later batches may remain incomplete.",
});
const plan = (stages: unknown[]) => ({
  format: "workgraph-ui-plan-1",
  title: "Synthetic explicit workflow",
  stages,
});
async function call(daemon: DaemonFixture, method: string, params: Record<string, unknown>) {
  // Only a closed synthetic fixture envelope is decoded here. Application content remains lossless.
  const value = JSON.parse(
    await daemon.call(method, JSON.stringify({ workspace_id: "demo", ...params })),
  ) as { result?: { data: Record<string, unknown> }; error?: unknown };
  if (!value.result) throw new Error(`${method}: ${JSON.stringify(value.error)}`);
  return value.result.data;
}
async function actor(page: Page, id: string) {
  await page.waitForLoadState("networkidle");
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill(id);
  await page.getByLabel("Run ID (optional)", { exact: true }).fill("");
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  await page.waitForLoadState("networkidle");
}
async function mount(page: Page, companion: CompanionFixture, socket: string) {
  const root = await page.request.get(companion.url),
    matches = [
      ...(await root.text()).matchAll(
        /<meta name="workgraph-capability" content="([a-f0-9]{64})"/gu,
      ),
    ],
    capability = matches[0]?.[1];
  expect(root.status()).toBe(200);
  if (matches.length !== 1 || !capability) throw new Error("Missing actual native capability");
  for (const [path, data] of [
    ["/connections", { id: "local", label: "Synthetic Plans", socket }],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const response = await page.request.post(new URL(`/ui-api/v1${path}`, companion.url).href, {
      headers: { "X-Workgraph-UI-Capability": capability, Origin: new URL(companion.url).origin },
      data,
    });
    expect(response.status()).toBe(200);
    await response.text();
  }
  await page.goto(
    new URL("/#/workflow?connection=local&workspace=demo&project=release", companion.url).href,
  );
  await expect(
    page.getByRole("region", { name: "Workflow graph canvas", exact: true }),
  ).toBeVisible();
  await actor(page, "fixture-author");
  await page.getByRole("button", { name: "Drafts", exact: true }).click();
}
const editor = (page: Page) =>
  page.getByRole("article", { name: "Workflow draft editor", exact: true });
async function settled(page: Page) {
  await expect(
    editor(page)
      .getByRole("status")
      .filter({
        hasText:
          /^(Saving structured source|Building native canonical preview|Checking this exact batch|Saving exact native operation|Inspecting retained native journals)/u,
      }),
  ).toHaveCount(0);
  await expect(editor(page).getByText("Saved on this origin", { exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
}
async function source(page: Page, document: unknown) {
  await page.getByRole("button", { name: "New workflow draft", exact: true }).click();
  await editor(page).locator("details.plan-raw > summary").click();
  await editor(page)
    .getByLabel("Exact plan source", { exact: true })
    .fill(typeof document === "string" ? document : JSON.stringify(document));
  await editor(page).getByRole("button", { name: "Parse current source", exact: true }).click();
  await settled(page);
}
async function review(page: Page, number = 1) {
  await editor(page)
    .getByRole("button", { name: `Review batch ${number}`, exact: true })
    .click();
  const result = editor(page).locator(".plan-review");
  await expect(
    result.getByRole("heading", { name: "Frozen batch review", exact: true }),
  ).toBeVisible();
  await settled(page);
  return result;
}
async function save(review: Locator) {
  await review
    .getByRole("button", { name: "Save native operation (do not execute)", exact: true })
    .click();
  await expect(review.getByRole("status").filter({ hasText: /^prepared_unsent$/u })).toBeVisible();
}
async function execute(review: Locator, outcome = "committed") {
  await review.getByRole("button", { name: "Execute saved request", exact: true }).click();
  await expect(
    review.getByRole("status").filter({ hasText: new RegExp(`^${outcome}$`, "u") }),
  ).toBeVisible();
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  await page.waitForLoadState("networkidle");
  const path = info.outputPath(name);
  await page.screenshot({ path, fullPage: false });
  await info.attach(name, { path, contentType: "image/png" });
}

test("W08-W09 structured template source publishes canonical native version and configures pinned instance", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  test.setTimeout(90000);
  await mount(page, companion, daemon.socket);
  await page.getByRole("button", { name: "Author template", exact: true }).click();
  await settled(page);
  await screenshot(page, info, "plans-initial-template-dark.png");
  await editor(page).getByLabel("Template ID", { exact: true }).fill("qualified-template");
  await settled(page);
  await editor(page)
    .getByLabel("Published template title", { exact: true })
    .fill("Synthetic canonical workflow");
  await settled(page);
  const specification = editor(page).getByRole("group", {
    name: "Template specification",
    exact: true,
  });
  await specification
    .locator("summary")
    .filter({ hasText: /^Nodes 1$/u })
    .click();
  await specification.getByLabel("Alias", { exact: true }).fill("implementation");
  await settled(page);
  await specification.getByLabel("Title", { exact: true }).fill("Implement {{feature}}");
  await settled(page);
  await specification.getByRole("button", { name: "Add nodes row", exact: true }).click();
  await settled(page);
  const row = specification
    .locator(".plan-array-row")
    .filter({ has: page.locator("summary").filter({ hasText: /^Nodes 2$/u }) });
  await row
    .locator("summary")
    .filter({ hasText: /^Nodes 2$/u })
    .click();
  await row.getByLabel("Alias", { exact: true }).fill("verification");
  await settled(page);
  await row.getByLabel("Title", { exact: true }).fill("Verify exact feature");
  await settled(page);
  await row.getByRole("button", { name: "Add depends on row", exact: true }).click();
  await settled(page);
  await row
    .locator("summary")
    .filter({ hasText: /^Depends on 1$/u })
    .click();
  await row.getByLabel("Depends on 1", { exact: true }).fill("implementation");
  await settled(page);
  await row.getByRole("button", { name: "Add reviewers row", exact: true }).click();
  await settled(page);
  await row
    .locator("summary")
    .filter({ hasText: /^Reviewers 1$/u })
    .click();
  await row.getByLabel("Actor id", { exact: true }).fill("fixture-author");
  await settled(page);
  await row.getByLabel("Separate actor", { exact: true }).check();
  await settled(page);
  await specification.getByRole("button", { name: "Add parameters row", exact: true }).click();
  await settled(page);
  await specification
    .locator("summary")
    .filter({ hasText: /^Parameters 1$/u })
    .click();
  await specification.getByLabel("Parameters 1", { exact: true }).fill("feature");
  await settled(page);
  await screenshot(page, info, "plans-template-source-dark.png");
  await editor(page)
    .getByRole("button", { name: "Build canonical publication draft", exact: true })
    .click();
  await expect(editor(page).getByRole("heading", { name: /Publish/u })).toBeVisible();
  await settled(page);
  const publication = await review(page);
  await save(publication);
  await execute(publication);
  const native = await call(daemon, "template.get", {
    template_id: "qualified-template",
    template_revision: "1",
    max_bytes: "1048576",
  });
  expect(native.template_revision).toBe("1");
  expect(native.digest).toMatch(/^[a-f0-9]{64}$/u);
  const nodes = (
    native.spec as {
      nodes: {
        alias: string;
        depends_on: string[];
        reviewers: unknown[];
        separate_actor: boolean;
      }[];
    }
  ).nodes;
  expect(nodes.map((node) => node.alias)).toEqual(["implementation", "verification"]);
  expect(nodes[1]?.depends_on).toEqual(["implementation"]);
  expect(nodes[1]?.reviewers).toEqual([{ kind: "actor", actor_id: "fixture-author" }]);
  expect(nodes[1]?.separate_actor).toBe(true);
  await page.getByRole("button", { name: "Templates", exact: true }).click();
  await page.getByRole("button", { name: "Refresh templates", exact: true }).click();
  const registered = page
    .locator(".plan-template")
    .filter({ has: page.getByRole("heading", { name: "qualified-template", exact: true }) });
  await expect(registered).toContainText(String(native.digest));
  await registered.getByRole("button", { name: "Configure instance", exact: true }).click();
  await settled(page);
  await editor(page).locator("details.plan-op > summary").click();
  await editor(page).getByLabel("Instance id", { exact: true }).fill("qualified-instance");
  await settled(page);
  const parameters = editor(page).getByRole("group", { name: "Parameters", exact: true });
  await parameters.getByLabel("New field name", { exact: true }).fill("feature");
  await parameters.getByRole("button", { name: "Add field", exact: true }).click();
  await settled(page);
  await parameters.getByLabel("Feature", { exact: true }).fill("synthetic feature");
  await settled(page);
  const instance = await review(page);
  await expect(instance).toContainText("5 native expanded operations");
  await expect(instance).toContainText("Local source operations: 1");
  await save(instance);
  await execute(instance);
  await expect(instance.getByText(/Original writer fixture-author · Saved/u)).toBeVisible();
  await expect(instance.locator(".plan-hashes")).toHaveCount(0);
  await instance.getByText("Batch audit and native guards", { exact: true }).click();
  await expect(instance.getByText("Canonical captured plan hash", { exact: true })).toBeVisible();
  await expect(instance.locator(".plan-hashes dd")).toHaveCount(4);
  await instance.getByText("Batch audit and native guards", { exact: true }).click();
  expect(
    JSON.stringify(
      await call(daemon, "template.instance_get", {
        instance_id: "qualified-instance",
        max_bytes: "1048576",
      }),
    ),
  ).toContain("qualified-template");
  expect(
    JSON.stringify(
      await call(daemon, "template.instance_get", {
        instance_id: "qualified-instance",
        max_bytes: "1048576",
      }),
    ),
  ).toContain("Implement synthetic feature");
  await instance
    .getByRole("heading", { name: "Frozen batch review", exact: true })
    .scrollIntoViewIfNeeded();
  await screenshot(page, info, "plans-native-instance-dark.png");
  await page.setViewportSize({ width: 900, height: 760 });
  await screenshot(page, info, "plans-native-instance-narrow.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "light" });
  await instance
    .getByRole("heading", { name: "Frozen batch review", exact: true })
    .scrollIntoViewIfNeeded();
  await screenshot(page, info, "plans-native-instance-light-390.png");
  expect(browserFailures).toEqual([]);
});

test("W10-W18 explicit 128-operation batch leaves held work; next batch binds actual durable receipt", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  test.setTimeout(90000);
  await mount(page, companion, daemon.socket);
  const operations = Array.from({ length: 64 }, (_, i) => [
    op(
      "ticket.create",
      { ticket_id: `staged-${i}`, title: `Staged work ${i}`, project_id: "release" },
      `item-${i}`,
    ),
    op("ticket.hold", {
      ticket_id: `$item-${i}`,
      expected_revision: "1",
      reason: "Later configuration",
    }),
  ]).flat();
  const first = stage(
    "create-held",
    operations,
    [],
    Array.from({ length: 64 }, (_, i) => exposure(i * 2)),
  );
  const second = stage(
    "release-one",
    [op("ticket.hold", { ticket_id: "receipt-required", expected_revision: "0", reason: null })],
    [
      {
        operation: 0,
        path: ["ticket_id"],
        stage: "create-held",
        receiptPath: ["results", "0", "data", "ticket_id"],
      },
      {
        operation: 0,
        path: ["expected_revision"],
        stage: "create-held",
        receiptPath: ["results", "1", "data", "revision"],
      },
    ],
  );
  await source(page, plan([first, second]));
  const initial = await review(page);
  await expect(initial).toContainText("128 native expanded operations");
  await save(initial);
  await execute(initial);
  const before = (
    await call(daemon, "ticket.read", { ticket_id: "staged-0", max_bytes: "1048576" })
  ).ticket as { hold: unknown; revision: string };
  expect(before.hold).not.toBeNull();
  await editor(page).getByRole("button", { name: "2. release-one", exact: true }).click();
  const next = await review(page, 2);
  await save(next);
  await execute(next);
  const after = (await call(daemon, "ticket.read", { ticket_id: "staged-0", max_bytes: "1048576" }))
    .ticket as { hold: unknown; revision: string };
  expect(after.hold).toBeNull();
  expect(BigInt(after.revision)).toBe(BigInt(before.revision) + 1n);
  expect(
    (
      (await call(daemon, "ticket.read", { ticket_id: "staged-1", max_bytes: "1048576" }))
        .ticket as { hold: unknown }
    ).hold,
  ).not.toBeNull();
  await screenshot(page, info, "plans-explicit-staged-receipt-dark.png");
  expect(browserFailures).toEqual([]);
});

test("unsafe final hold effect and oversized batch stay editable without preparation or automatic split", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  await mount(page, companion, daemon.socket);
  await source(
    page,
    plan([
      stage(
        "bad",
        [
          op("ticket.create", { title: "Protected work" }, "work"),
          op("ticket.hold", {
            ticket_id: "$work",
            expected_revision: "1",
            reason: "Later obligations",
          }),
          op("ticket.hold", { ticket_id: "$work", expected_revision: "2", reason: null }),
        ],
        [],
        [exposure(0)],
      ),
      stage("later", [
        op("fact.put", {
          scope: { kind: "project", id: "release" },
          key: "later",
          expected_revision: "0",
          value: null,
        }),
      ]),
    ]),
  );
  await editor(page).getByRole("button", { name: "Review batch 1", exact: true }).click();
  await expect(editor(page).getByRole("alert")).toContainText(/hold/u);
  await expect(
    editor(page).getByRole("button", {
      name: "Save native operation (do not execute)",
      exact: true,
    }),
  ).toHaveCount(0);
  await editor(page)
    .getByLabel("Exact plan source", { exact: true })
    .fill(
      JSON.stringify(
        plan([
          stage(
            "oversized",
            Array.from({ length: 129 }, (_, i) =>
              op("fact.put", {
                scope: { kind: "project", id: "release" },
                key: `large-${i}`,
                expected_revision: "0",
                value: i,
              }),
            ),
          ),
        ]),
      ),
    );
  await editor(page).getByRole("button", { name: "Parse current source", exact: true }).click();
  await expect(editor(page).getByRole("alert")).toContainText(/128|operations/u);
  await expect(
    editor(page).getByRole("button", {
      name: "Save native operation (do not execute)",
      exact: true,
    }),
  ).toHaveCount(0);
  await screenshot(page, info, "plans-batch-bound-error-dark.png");
  expect(browserFailures).toEqual([]);
});

test("numeric form accepts incomplete typing and preserves exact large integer with original captured writer", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  await mount(page, companion, daemon.socket);
  await source(
    page,
    plan([
      stage("numeric", [
        op("fact.put", {
          scope: { kind: "project", id: "release" },
          key: "plan.number",
          expected_revision: "0",
          value: { count: 1 },
        }),
      ]),
    ]),
  );
  await editor(page).locator("details.plan-op > summary").click();
  const count = editor(page).getByLabel("Count", { exact: true });
  await count.fill("-");
  await expect(count).toHaveValue("-");
  await expect(
    editor(page).getByRole("button", { name: "Review batch 1", exact: true }),
  ).toBeDisabled();
  await count.fill("");
  await expect(count).toHaveValue("");
  await count.fill("9007199254740993");
  await editor(page).getByRole("button", { name: "Apply numeric value", exact: true }).click();
  await settled(page);
  await expect(editor(page).getByLabel("Exact plan source", { exact: true })).toHaveValue(
    /9007199254740993/u,
  );
  const checked = await review(page);
  await actor(page, "different-shell-actor");
  await expect(editor(page)).toContainText("This editor keeps its original connection and writer");
  await save(checked);
  await execute(checked);
  expect(
    await daemon.call(
      "fact.get",
      JSON.stringify({
        workspace_id: "demo",
        scope: { kind: "project", id: "release" },
        key: "plan.number",
      }),
    ),
  ).toContain('"count":9007199254740993');
  await screenshot(page, info, "plans-lossless-number-original-writer.png");
  expect(browserFailures).toEqual([]);
});

/** Exact test transport loses one apply reply only after observing its complete daemon response. */
async function lostReplyProxy(daemon: DaemonFixture) {
  const socket = join(daemon.root, "plans-lost-reply"),
    sockets = new Set<Socket>(),
    failures: string[] = [],
    applies: string[] = [],
    evidence: { request_sha256: string; response_sha256: string }[] = [];
  let armed = false;
  const server = createServer((client) => {
    const upstream = createConnection(daemon.socket);
    sockets.add(client);
    sockets.add(upstream);
    let request = Buffer.alloc(0),
      response = Buffer.alloc(0),
      drop = false,
      requestHash = "";
    for (const connection of [client, upstream]) {
      connection.on("close", () => sockets.delete(connection));
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
          failures.push("Oversized request");
          client.destroy();
          upstream.destroy();
          return;
        }
        const closed = JSON.parse(request.subarray(4, 4 + length).toString("utf8")) as {
          method: string;
        };
        if (closed.method === "transaction.apply") {
          requestHash = createHash("sha256")
            .update(request.subarray(0, 4 + length))
            .digest("hex");
          applies.push(requestHash);
          if (armed) {
            armed = false;
            drop = true;
          }
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
    applies,
    evidence,
    arm: () => {
      armed = true;
    },
    dispose: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
test("W11 lost apply reply restores same journal after reload and explicit receipt recovery observes one commit", async ({
  page,
  daemon,
  companion,
  browserFailures,
  browserDiagnostics,
}, info) => {
  test.setTimeout(90000);
  const proxy = await lostReplyProxy(daemon);
  try {
    await mount(page, companion, proxy.socket);
    await source(
      page,
      plan([
        stage(
          "uncertain",
          [
            op(
              "ticket.create",
              {
                ticket_id: "uncertain-plan-work",
                title: "Durable exact plan effect",
                project_id: "release",
              },
              "work",
            ),
          ],
          [],
          [exposure(0, "runnable")],
        ),
      ]),
    );
    const checked = await review(page);
    await save(checked);
    await settled(page);
    const downloadPending = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export selected draft", exact: true }).click();
    const exported = await downloadPending,
      recoveryPath = info.outputPath("captured-plan.wg-plan.ndjson");
    await exported.saveAs(recoveryPath);
    await info.attach("captured-plan-recovery", {
      path: recoveryPath,
      contentType: "application/x-ndjson",
    });
    proxy.arm();
    await execute(checked, "outcome_unknown");
    const before = (
      await call(daemon, "ticket.read", { ticket_id: "uncertain-plan-work", max_bytes: "1048576" })
    ).ticket as { revision: string };
    expect(before.revision).toBe("1");
    expect(proxy.evidence).toHaveLength(1);
    expect(proxy.applies).toEqual([proxy.evidence[0]?.request_sha256]);
    await settled(page);
    browserDiagnostics.markPendingReads();
    browserDiagnostics.markPendingDirectoryReads();
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Drafts", exact: true }).click();
    await expect(editor(page)).toBeVisible();
    await editor(page).getByRole("button", { name: "Close editor", exact: true }).click();
    await expect(editor(page)).toHaveCount(0);
    await page
      .getByLabel("Import workflow recovery file", { exact: true })
      .setInputFiles(recoveryPath);
    await expect(editor(page)).toBeVisible();
    await settled(page);
    await editor(page)
      .getByRole("button", { name: "Restore saved native operations", exact: true })
      .click();
    await expect(
      editor(page)
        .getByRole("status")
        .filter({ hasText: /^outcome_unknown$/u }),
    ).toBeVisible();
    await editor(page).getByRole("button", { name: "Recover receipt", exact: true }).click();
    await expect(
      editor(page)
        .getByRole("status")
        .filter({ hasText: /^committed$/u }),
    ).toBeVisible();
    expect(
      (
        (
          await call(daemon, "ticket.read", {
            ticket_id: "uncertain-plan-work",
            max_bytes: "1048576",
          })
        ).ticket as { revision: string }
      ).revision,
    ).toBe(before.revision);
    expect(proxy.applies).toHaveLength(1);
    expect(proxy.failures).toEqual([]);
    await info.attach("lost-reply-frames", {
      body: JSON.stringify(proxy.evidence, null, 2),
      contentType: "application/json",
    });
    await screenshot(page, info, "plans-restored-exact-receipt-dark.png");
    expect(browserFailures).toEqual([]);
  } finally {
    await page.close();
    await proxy.dispose();
  }
});

// Fresh executable parity complements the checked-in exact schema and actual mutation journeys.
test("generated aliased transaction matches fresh executable schemas and rejects internal alias wire", async ({
  daemon,
}, info) => {
  const params = stageParams(
    {
      connection: decode(d.connectionProfile, {
        id: "local",
        generation: "1",
        socket: daemon.socket,
        label: "Synthetic",
      }),
      context: {
        workspace_id: decode(d.identifier, "demo"),
        project_id: decode(d.identifier, "release"),
        writer: { actor_id: decode(d.identifier, "fixture-author"), run_id: null },
      },
    },
    [
      {
        method: "ticket.create",
        alias: "work",
        params: d.jsonObject([
          ["title", d.jsonString("Generated wire")],
          ["project_id", d.jsonString("release")],
        ]),
      },
      {
        method: "ticket.hold",
        alias: null,
        params: d.jsonObject([
          ["ticket_id", d.jsonString("$work")],
          ["expected_revision", d.jsonString("1")],
          ["reason", d.jsonString("Later configuration")],
        ]),
      },
    ],
  );
  const encoded = stringifyJson(params);
  if (!encoded.ok) throw new Error("Synthetic encode failed");
  const closed = JSON.parse(encoded.value) as {
    mutation_id?: string;
    operations: Record<string, unknown>[];
  };
  closed.mutation_id = "schema-parity";
  const { stdout } = await promisify(execFile)(daemon.binary, ["schema", "transaction.apply"], {
    maxBuffer: 8 * 1024 * 1024,
  });
  const schema = (JSON.parse(stdout) as { methods: { params: object }[] }).methods[0]?.params;
  if (!schema) throw new Error("Native schema missing");
  const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
  expect(validate(closed), JSON.stringify(validate.errors)).toBe(true);
  const incorrect = structuredClone(closed);
  incorrect.operations[0]!.alias = "work";
  delete incorrect.operations[0]!.as;
  expect(validate(incorrect)).toBe(false);
  await info.attach("fresh-native-transaction-schema", {
    body: stdout,
    contentType: "application/json",
  });
});
