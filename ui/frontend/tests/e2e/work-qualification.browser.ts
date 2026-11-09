import { createHash } from "node:crypto";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import type { CompanionFixture } from "../../../test-support/companion-fixture.mjs";
import {
  fixtureBinary,
  startDaemonFixture,
  type DaemonFixture,
} from "../../../test-support/daemon-fixture.mjs";
import { test, expect } from "./support/fixtures";
import { commandDefinition } from "../../src/features/work/actions/commands";
import type { WorkCommand } from "../../src/features/work/actions/types";

test.use({ colorScheme: "dark", viewport: { width: 1480, height: 1000 }, actionTimeout: 12000 });
test.setTimeout(90000);
type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed closed native fixture record");
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Missing native fixture string");
  return value;
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
      actor_id: "fixture-author",
      mutation_id: `work-gate-${++serial}`,
      ...params,
    });
}
async function metadata(page: Page, companion: CompanionFixture, path: string, data: RecordValue) {
  const response = await page.request.get(companion.url),
    capability = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(
      await response.text(),
    )?.[1];
  if (capability === undefined) throw new Error("Missing native bootstrap capability");
  const result = await page.request.fetch(new URL(`/ui-api/v1${path}`, companion.url).href, {
    method: path === "/connections/local" ? "PUT" : "POST",
    headers: { Origin: new URL(companion.url).origin, "X-Workgraph-UI-Capability": capability },
    data,
  });
  expect(result.status()).toBe(200);
  await result.text();
}
async function connect(page: Page, companion: CompanionFixture, socket: string) {
  await metadata(page, companion, "/connections", {
    id: "local",
    label: "Native Work qualification",
    socket,
  });
  await metadata(page, companion, "/connections/local/attach", { generation: "1" });
}
async function navigate(page: Page, companion: CompanionFixture, hash: string) {
  await page.goto(new URL("/" + hash, companion.url).href);
  await page.waitForLoadState("networkidle");
}
async function actor(page: Page, id: string, run = "") {
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill(id);
  await page.getByLabel("Run ID (optional)", { exact: true }).fill(run);
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  await page.waitForLoadState("networkidle");
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(name + ".png");
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}
interface CapturedRequest {
  readonly method: string;
  readonly params: RecordValue;
  readonly frameSha256: string;
}
/** Real daemon transport; discard one complete apply response after its durable commit. */
async function loseOneApply(daemon: DaemonFixture) {
  const socket = join(daemon.root, "work-gate-lost"),
    connections = new Set<Socket>(),
    requests: CapturedRequest[] = [],
    lost: { request: CapturedRequest; responseSha256: string }[] = [],
    failures: string[] = [];
  let armed = false;
  const server = createServer((client) => {
    const upstream = createConnection(daemon.socket);
    connections.add(client);
    connections.add(upstream);
    let request = Buffer.alloc(0),
      response = Buffer.alloc(0),
      parsed: CapturedRequest | null = null,
      drop = false;
    for (const stream of [client, upstream]) {
      stream.on("close", () => connections.delete(stream));
      stream.on("error", (error) => {
        failures.push(error.message);
        client.destroy();
        upstream.destroy();
      });
    }
    client.on("data", (bytes: Buffer) => {
      request = Buffer.concat([request, bytes]);
      if (parsed === null && request.length >= 4) {
        const size = request.readUInt32BE(0);
        if (size > 4194304) throw new Error("Fixture received oversized native request");
        if (request.length >= size + 4) {
          const frame = object(JSON.parse(request.subarray(4, size + 4).toString("utf8")));
          parsed = {
            method: text(frame.method),
            params: object(frame.params),
            frameSha256: createHash("sha256")
              .update(request.subarray(0, size + 4))
              .digest("hex"),
          };
          requests.push(parsed);
          if (parsed.method === "transaction.apply" && armed) {
            armed = false;
            drop = true;
          }
        }
      }
      upstream.write(bytes);
    });
    upstream.on("data", (bytes: Buffer) => {
      if (!drop) {
        client.write(bytes);
        return;
      }
      response = Buffer.concat([response, bytes]);
      if (response.length >= 4 && response.length >= response.readUInt32BE(0) + 4) {
        if (parsed === null) throw new Error("Response without captured request");
        lost.push({
          request: parsed,
          responseSha256: createHash("sha256").update(response).digest("hex"),
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
    requests,
    lost,
    failures,
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
const planEditor = (page: Page) =>
  page.getByRole("article", { name: "Workflow draft editor", exact: true });
async function settled(page: Page) {
  await expect(
    planEditor(page)
      .getByRole("status")
      .filter({
        hasText:
          /^(Saving structured source|Building native canonical preview|Checking this exact batch|Saving exact native operation|Inspecting retained native journals)/u,
      }),
  ).toHaveCount(0);
  await expect(planEditor(page).getByText("Saved on this origin", { exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
}
async function review(page: Page, number: number) {
  await planEditor(page)
    .getByRole("button", { name: `Review batch ${number}`, exact: true })
    .click();
  const region = planEditor(page).locator(".plan-review");
  await expect(
    region.getByRole("heading", { name: "Frozen batch review", exact: true }),
  ).toBeVisible();
  await settled(page);
  return region;
}
async function commit(region: Locator, outcome = "committed") {
  await region
    .getByRole("button", { name: "Save native operation (do not execute)", exact: true })
    .click();
  await expect(region.getByRole("status").filter({ hasText: /^prepared_unsent$/u })).toBeVisible();
  await region.getByRole("button", { name: "Execute saved request", exact: true }).click();
  await expect(
    region.getByRole("status").filter({ hasText: new RegExp(`^${outcome}$`, "u") }),
  ).toBeVisible();
}

test("W18 three batches retain prior commits, block after lost batch2, and deliberately review fresh later guards", async ({
  page,
  daemon,
  companion,
  browserFailures,
  browserDiagnostics,
}, info) => {
  const proxy = await loseOneApply(daemon),
    write = writer(daemon);
  const operation = (method: string, params: RecordValue, alias: string | null = null) => ({
    method,
    params,
    alias,
  });
  const binding = (stage: string, field: string, result: string) => ({
    operation: 0,
    path: [field],
    stage,
    receiptPath: ["results", result, "data", field === "ticket_id" ? "ticket_id" : "revision"],
  });
  const batch = (
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
    exposure: "Explicit independent commit; prior effects remain when later work is unresolved.",
  });
  const stages = [
    batch(
      "create-held",
      [
        operation(
          "ticket.create",
          { ticket_id: "work-gate-staged", project_id: "release", title: "First durable batch" },
          "item",
        ),
        operation("ticket.hold", {
          ticket_id: "$item",
          expected_revision: "1",
          reason: "Later configuration",
        }),
      ],
      [],
      [
        {
          operation: 0,
          disposition: "held",
          deferred: "Later configuration",
          templateDigest: null,
        },
      ],
    ),
    batch(
      "release-one",
      [
        operation("ticket.hold", {
          ticket_id: "receipt-required",
          expected_revision: "0",
          reason: null,
        }),
      ],
      [binding("create-held", "ticket_id", "0"), binding("create-held", "expected_revision", "1")],
    ),
    batch(
      "final-metadata",
      [
        operation("ticket.update", {
          ticket_id: "receipt-required",
          expected_revision: "0",
          title: "Deliberately reviewed final state",
        }),
      ],
      [binding("create-held", "ticket_id", "0"), binding("release-one", "expected_revision", "0")],
    ),
  ];
  const document = {
    format: "workgraph-ui-plan-1",
    title: "Three native commits with exact recovery",
    stages,
  };
  try {
    await connect(page, companion, proxy.socket);
    await navigate(page, companion, "#/workflow?connection=local&workspace=demo&project=release");
    await actor(page, "fixture-author");
    await page.getByRole("button", { name: "Drafts", exact: true }).click();
    await page.getByRole("button", { name: "New workflow draft", exact: true }).click();
    await planEditor(page).locator("details.plan-raw > summary").click();
    await planEditor(page)
      .getByLabel("Exact plan source", { exact: true })
      .fill(JSON.stringify(document));
    await planEditor(page)
      .getByRole("button", { name: "Parse current source", exact: true })
      .click();
    await settled(page);
    await expect(planEditor(page)).toContainText("The whole plan is not atomic");
    await commit(await review(page, 1));
    let ticket = object(
      (await native(daemon, "ticket.read", { ticket_id: "work-gate-staged" })).ticket,
    );
    expect(object(ticket.hold).reason).toBe("Later configuration");
    expect(ticket.revision).toBe("2");
    await planEditor(page)
      .getByRole("button", { name: /^2\. release-one(?: · (?:saved|captured))?$/u })
      .click();
    const second = await review(page, 2);
    proxy.arm();
    await commit(second, "outcome_unknown");
    ticket = object(
      (await native(daemon, "ticket.read", { ticket_id: "work-gate-staged" })).ticket,
    );
    expect(ticket.hold).toBeNull();
    expect(ticket.revision).toBe("3");
    expect(proxy.lost).toHaveLength(1);
    const lostRequest = proxy.lost[0]!.request;
    expect(lostRequest.params.actor_id).toBe("fixture-author");
    const applyCount = () =>
      proxy.requests.filter((item) => item.method === "transaction.apply").length;
    expect(applyCount()).toBe(2);
    await write("ticket.update", {
      ticket_id: "work-gate-staged",
      expected_revision: "3",
      title: "Intervening external metadata",
    });
    ticket = object(
      (await native(daemon, "ticket.read", { ticket_id: "work-gate-staged" })).ticket,
    );
    expect(ticket.revision).toBe("4");
    browserDiagnostics.markPendingReads();
    await actor(page, "different-current-actor");
    await expect(planEditor(page)).toContainText(
      "This editor keeps its original connection and writer",
    );
    await planEditor(page).getByRole("button", { name: "3. final-metadata", exact: true }).click();
    const preflightCount = proxy.requests.filter(
      (item) => item.method === "transaction.preflight",
    ).length;
    await planEditor(page).getByRole("button", { name: "Review batch 3", exact: true }).click();
    await expect(planEditor(page).getByRole("alert")).toContainText(
      "Resolve every preceding saved batch",
    );
    expect(proxy.requests.filter((item) => item.method === "transaction.preflight")).toHaveLength(
      preflightCount,
    );
    expect(applyCount()).toBe(2);
    expect(
      object((await native(daemon, "ticket.read", { ticket_id: "work-gate-staged" })).ticket).title,
    ).toBe("Intervening external metadata");
    await screenshot(page, info, "staged-unresolved-next-batch-blocked");
    await planEditor(page)
      .getByRole("button", { name: /^2\. release-one(?: · (?:saved|captured))?$/u })
      .click();
    await second.getByRole("button", { name: "Recover receipt", exact: true }).click();
    await expect(second.getByRole("status").filter({ hasText: /^committed$/u })).toBeVisible();
    expect(applyCount()).toBe(2);
    expect(proxy.lost[0]!.request).toEqual(lostRequest);
    await planEditor(page).getByRole("button", { name: "3. final-metadata", exact: true }).click();
    const readURL = new URL("/ui-api/v1/read", companion.url).href;
    const staleResponse = page.waitForResponse(
      (response) =>
        response.url() === readURL &&
        object(JSON.parse(response.request().postData() ?? "null")).method ===
          "transaction.preflight",
    );
    browserDiagnostics.expectedHTTP.set(readURL, 409);
    await planEditor(page).getByRole("button", { name: "Review batch 3", exact: true }).click();
    const rejected = await staleResponse;
    expect(rejected.status()).toBe(409);
    const rejectedRequest = object(JSON.parse(rejected.request().postData() ?? "null"));
    expect(rejectedRequest.connection_id).toBe("local");
    expect(rejectedRequest.generation).toBe("1");
    const rejectedParams = object(rejectedRequest.params);
    expect(rejectedParams.actor_id).toBe("fixture-author");
    const staleOperations = rejectedParams.operations;
    if (!Array.isArray(staleOperations))
      throw new Error("Missing exact stale preflight operations");
    expect(object(object(staleOperations[0]).params).expected_revision).toBe("3");
    const staleBody = object(JSON.parse(await rejected.text()));
    expect(staleBody.ok).toBe(false);
    expect(object(staleBody.error).kind).toBe("Conflict");
    expect(object(object(staleBody.error).details)).toEqual({
      type: "revision",
      expected: "3",
      actual: "4",
    });
    await rejected.finished();
    await expect(planEditor(page).getByRole("alert")).toContainText(/Conflict|revision/u);
    await page.waitForLoadState("networkidle");
    browserDiagnostics.expectedHTTP.delete(readURL);
    await info.attach("deliberate-stale-preflight-typed-conflict", {
      body: JSON.stringify({ request: rejectedRequest, response: staleBody }, null, 2),
      contentType: "application/json",
    });
    expect(applyCount()).toBe(2);
    const corrected = {
      ...document,
      stages: [
        ...stages.slice(0, 2),
        batch(
          "final-metadata",
          [
            operation("ticket.update", {
              ticket_id: "receipt-required",
              expected_revision: text(ticket.revision),
              title: "Deliberately reviewed final state",
            }),
          ],
          [binding("create-held", "ticket_id", "0")],
        ),
      ],
    };
    await planEditor(page)
      .getByLabel("Exact plan source", { exact: true })
      .fill(JSON.stringify(corrected));
    await planEditor(page)
      .getByRole("button", { name: "Parse current source", exact: true })
      .click();
    await settled(page);
    const third = await review(page, 3);
    await commit(third);
    expect(applyCount()).toBe(3);
    const finalApply = proxy.requests.filter((item) => item.method === "transaction.apply").at(-1)!;
    expect(finalApply.params.actor_id).toBe("fixture-author");
    expect(finalApply.params.mutation_id).not.toBe(lostRequest.params.mutation_id);
    const operations = finalApply.params.operations;
    if (!Array.isArray(operations)) throw new Error("Missing captured transaction operations");
    expect(object(object(operations[0]).params).ticket_id).toBe("work-gate-staged");
    expect(object(object(operations[0]).params).expected_revision).toBe("4");
    const final = object(
      (await native(daemon, "ticket.read", { ticket_id: "work-gate-staged" })).ticket,
    );
    expect(final.title).toBe("Deliberately reviewed final state");
    expect(final.revision).toBe("5");
    expect(final.hold).toBeNull();
    expect(proxy.failures).toEqual([]);
    await info.attach("staged-native-requests-and-lost-reply", {
      body: JSON.stringify({ requests: proxy.requests, lost: proxy.lost }, null, 2),
      contentType: "application/json",
    });
    await screenshot(page, info, "staged-fresh-guard-original-writer-complete");
    expect(browserFailures).toEqual([]);
  } finally {
    await page.close();
    await proxy.dispose();
  }
});
async function seedEvidence(daemon: DaemonFixture, body: string) {
  const write = writer(daemon),
    digest = createHash("sha256").update(body).digest("hex");
  await write("run.register", {
    target_run_id: "work-gate-proof-run",
    objective: "Disposable real-daemon Work evidence qualification",
  });
  await write("ticket.create", {
    ticket_id: "work-gate-proof",
    project_id: "release",
    title: "Exact reviewed output",
  });
  await write("ticket.start", {
    ticket_id: "work-gate-proof",
    attempt_id: "work-gate-proof-attempt",
    run_id: "work-gate-proof-run",
  });
  const schema = "{}";
  for (const [resource_id, source, filename] of [
    ["work-gate-evidence", body, "reviewed.md"],
    ["work-gate-schema", schema, "schema.json"],
  ])
    await write("resource.put_text", {
      resource_id,
      expected_revision: "0",
      title: resource_id,
      filename,
      mime_type: filename!.endsWith("md") ? "text/markdown" : "application/json",
      text: source,
    });
  await write("contract.put", {
    contract_id: "work-gate-contract",
    expected_revision: "0",
    schema_version: "1",
    schema: {
      resource_id: "work-gate-schema",
      revision: "1",
      digest: createHash("sha256").update(schema).digest("hex"),
    },
    required_inputs: [],
    required_outputs: ["report"],
  });
  await write("manifest.publish", {
    manifest_id: "work-gate-manifest",
    expected_revision: "0",
    schema_version: "1",
    attempt_id: "work-gate-proof-attempt",
    ticket_id: "work-gate-proof",
    run_id: "work-gate-proof-run",
    contract: { contract_id: "work-gate-contract", revision: "1" },
    inputs: [],
    outputs: [
      {
        name: "report",
        pin: { kind: "resource", resource_id: "work-gate-evidence", revision: "1", digest },
      },
    ],
  });
  return { write, digest };
}
async function refreshProfiles(page: Page) {
  await page.locator(".wg-workspace-switch").click();
  const dialog = page.getByRole("dialog", { name: "Daemon connections", exact: true });
  await dialog.getByRole("button", { name: "Refresh profiles", exact: true }).click();
  await expect(dialog.getByText(/local · generation 2/u)).toBeVisible();
  await dialog.getByRole("button", { name: "Close Daemon connections", exact: true }).click();
}
for (const view of ["work", "workflow"] as const) {
  test(`${view} reviewed evidence keeps exact old bytes across repeated-ID endpoint retarget and unavailable original`, async ({
    page,
    daemon,
    companion,
    browserFailures,
    browserDiagnostics,
  }, info) => {
    const other = await startDaemonFixture({ binary: fixtureBinary() });
    const readRequests: RecordValue[] = [];
    try {
      const original = "# Reviewed original endpoint\n\nExact first content version 雪.\n";
      const seeded = await seedEvidence(daemon, original);
      await seedEvidence(
        other,
        "# Repeated ID on other endpoint\n\nNever substitute these bytes.\n",
      );
      await seeded.write("resource.put_text", {
        resource_id: "work-gate-evidence",
        expected_revision: "1",
        title: "Current unreviewed bytes",
        filename: "current.md",
        mime_type: "text/markdown",
        text: "# Current publication is not the reviewed pin\n",
      });
      await connect(page, companion, daemon.socket);
      await navigate(
        page,
        companion,
        `#/${view}?connection=local&workspace=demo&project=release&entity=work-gate-proof`,
      );
      if (view === "work") {
        await page.getByRole("button", { name: "Activity", exact: true }).click();
        await page.getByRole("button", { name: "Load evidence context", exact: true }).click();
        await expect(
          page.getByRole("button", { name: "Open exact evidence version", exact: true }),
        ).toBeVisible();
      } else {
        await expect(
          page
            .getByRole("region", { name: "Review and evidence", exact: true })
            .getByRole("button", { name: "Open exact resource version", exact: true }),
        ).toBeVisible();
      }
      // The actual evidence callback still owns its already observed generation1.
      await metadata(page, companion, "/connections/local", {
        expected_generation: "1",
        label: "Repeated IDs in another daemon",
        socket: other.socket,
      });
      await metadata(page, companion, "/connections/local/attach", { generation: "2" });
      if (view === "work")
        await page
          .getByRole("button", { name: "Open exact evidence version", exact: true })
          .click();
      else
        await page
          .getByRole("region", { name: "Review and evidence", exact: true })
          .getByRole("button", { name: "Open exact resource version", exact: true })
          .click();
      await expect(page).toHaveURL(/resource_generation=1/u);
      await expect(page).toHaveURL(/content_version=1/u);
      await expect(page).toHaveURL(new RegExp(`content_digest=${seeded.digest}`, "u"));
      await expect(
        page.getByRole("heading", { name: "Reviewed original endpoint", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Repeated ID on other endpoint", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("heading", {
          name: "Current publication is not the reviewed pin",
          exact: true,
        }),
      ).toHaveCount(0);
      const pinnedURL = page.url();
      await refreshProfiles(page);
      await page.reload();
      await expect(
        page.getByRole("heading", { name: "Reviewed original endpoint", exact: true }),
      ).toBeVisible();
      await screenshot(page, info, `${view}-reviewed-pin-retained-after-retarget`);
      page.on("request", (request) => {
        if (
          request.url() === new URL("/ui-api/v1/read", companion.url).href &&
          request.method() === "POST"
        )
          readRequests.push(object(JSON.parse(request.postData() ?? "null")));
      });
      await daemon.dispose();
      browserDiagnostics.expectedHTTP.set(new URL("/ui-api/v1/read", companion.url).href, 503);
      await page.goto(pinnedURL);
      await page.reload();
      await expect(
        page.getByRole("heading", { name: "Publication unavailable", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Repeated ID on other endpoint", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: "Reviewed original endpoint", exact: true }),
      ).toHaveCount(0);
      const resourceReads = readRequests.filter(
        (request) => typeof request.method === "string" && request.method.startsWith("resource."),
      );
      expect(resourceReads.length).toBeGreaterThan(0);
      expect(
        resourceReads.every(
          (request) => request.connection_id === "local" && request.generation === "1",
        ),
      ).toBe(true);
      const otherReadback = object(
        await native(other, "resource.get", { resource_id: "work-gate-evidence" }),
      );
      expect(object(otherReadback.current_version).revision).toBe("1");
      await info.attach("unavailable-retained-resource-read-associations", {
        body: JSON.stringify(resourceReads, null, 2),
        contentType: "application/json",
      });
      await screenshot(page, info, `${view}-original-endpoint-unavailable-no-fallback`);
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

test("Work Activity comment callback retains actual revision and original endpoint despite repeated comment IDs", async ({
  page,
  daemon,
  companion,
  browserFailures,
  browserDiagnostics,
}, info) => {
  const other = await startDaemonFixture({ binary: fixtureBinary() });
  try {
    const write = writer(daemon),
      otherWrite = writer(other);
    await write("comment.add", {
      comment_id: "work-gate-comment",
      target: { kind: "ticket", id: "design" },
      body: "Original endpoint reviewed comment",
      kind: "comment",
    });
    await otherWrite("comment.add", {
      comment_id: "work-gate-comment",
      target: { kind: "ticket", id: "design" },
      body: "Repeated comment ID on another endpoint",
      kind: "comment",
    });
    await connect(page, companion, daemon.socket);
    await navigate(
      page,
      companion,
      "#/work?connection=local&workspace=demo&project=release&entity=design",
    );
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    await page.getByRole("button", { name: "Load ticket comments", exact: true }).click();
    const captured = page
      .locator("article")
      .filter({ has: page.getByText("Original endpoint reviewed comment", { exact: true }) });
    await expect(
      captured.getByRole("button", { name: "Open exact comment revision", exact: true }),
    ).toBeVisible();
    await write("comment.edit", {
      comment_id: "work-gate-comment",
      expected_revision: "1",
      body: "Later original-endpoint comment revision",
    });
    await metadata(page, companion, "/connections/local", {
      expected_generation: "1",
      label: "Another daemon with repeated IDs",
      socket: other.socket,
    });
    await metadata(page, companion, "/connections/local/attach", { generation: "2" });
    await captured
      .getByRole("button", { name: "Open exact comment revision", exact: true })
      .click();
    await expect(page).toHaveURL(/generation=1/u);
    await expect(page).toHaveURL(/comment=work-gate-comment/u);
    await expect(page).toHaveURL(/comment_revision=1/u);
    const history = page
      .locator(".wg-panel")
      .filter({ has: page.getByRole("heading", { name: "Comment history", exact: true }) });
    await expect(
      history.getByText("Original endpoint reviewed comment", { exact: true }),
    ).toBeVisible();
    await expect(
      history.getByText("Later original-endpoint comment revision", { exact: true }),
    ).toHaveCount(0);
    await expect(
      history.getByText("Repeated comment ID on another endpoint", { exact: true }),
    ).toHaveCount(0);
    const oldURL = page.url();
    await refreshProfiles(page);
    await page.reload();
    await expect(
      history.getByText("Original endpoint reviewed comment", { exact: true }),
    ).toBeVisible();
    await screenshot(page, info, "work-activity-comment-original-revision-endpoint");
    await daemon.dispose();
    browserDiagnostics.expectedHTTP.set(new URL("/ui-api/v1/read", companion.url).href, 503);
    await page.goto(oldURL);
    await page.reload();
    await expect(history.getByRole("alert")).toBeVisible();
    await expect(
      history.getByText("Repeated comment ID on another endpoint", { exact: true }),
    ).toHaveCount(0);
    const current = await native(other, "comment.get", { comment_id: "work-gate-comment" });
    expect(current.body).toBe("Repeated comment ID on another endpoint");
    expect(current.revision).toBe("1");
    await screenshot(page, info, "work-comment-unavailable-original-no-fallback");
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

async function action(page: Page, method: WorkCommand) {
  const definition = commandDefinition(method);
  await page.getByLabel("Action group", { exact: true }).selectOption(definition.group);
  await page.getByLabel("Ticket action", { exact: true }).selectOption(method);
  await page.getByRole("button", { name: "Open action form", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: definition.title, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function actionField(dialog: Locator, label: string, value: string) {
  const presence = dialog.getByLabel(`${label} update`, { exact: true });
  const field = dialog.getByLabel(label, { exact: true });
  for (const control of (await presence.count()) > 0 ? [presence, field] : [field]) {
    while (!(await control.isVisible())) {
      const closed = control.locator("xpath=ancestor::details[not(@open)]").first();
      if ((await closed.count()) === 0) throw new Error("Hidden field outside disclosure");
      await closed.locator(":scope > summary").click();
    }
    if (control === presence) await control.selectOption("value");
    else await control.fill(value);
  }
}
async function actionReview(dialog: Locator) {
  await dialog.getByRole("button", { name: "Review action", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply action", exact: true })).toBeEnabled();
}
async function actionApply(dialog: Locator) {
  await dialog.getByRole("button", { name: "Apply action", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: /^committed$/u })).toBeVisible();
}
async function refreshTicket(page: Page) {
  await page.getByRole("button", { name: "Refresh tickets", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Loading ticket/u })).toHaveCount(0);
  await page.waitForLoadState("networkidle");
}

test("W05/W06 claimed instructions refuse edits while metadata works; exact native admission distinguishes missing capability, full pool and changed policy", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  test.setTimeout(120000);
  const write = writer(daemon),
    evidence: unknown[] = [];
  await write("ticket.create", {
    ticket_id: "work-gate-admission",
    project_id: "release",
    title: "Guarded admission",
  });
  await write("ticket.create", {
    ticket_id: "work-gate-holder",
    project_id: "release",
    title: "Existing pool holder",
  });
  for (const [target_run_id, capabilities] of [
    ["work-gate-ready", ["build"]],
    ["work-gate-missing", []],
  ] as const)
    await write("run.register", {
      target_run_id,
      objective: "Actual disposable admission control",
      capabilities,
    });
  await write("allocation.pool_put", {
    name: "work-gate-pool",
    expected_revision: "0",
    limit: "1",
  });
  for (const ticket_id of ["work-gate-admission", "work-gate-holder"])
    await write("allocation.ticket_policy_put", {
      ticket_id,
      expected_revision: "0",
      required_capabilities: ["build"],
      pools: ["work-gate-pool"],
    });
  const candidate = await native(daemon, "ticket.readiness", {
    ticket_id: "work-gate-admission",
    candidate: { actor_id: "fixture-author", capabilities: [] },
  });
  expect(candidate.ready).toBe(false);
  expect(candidate.reasons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "missing_candidate_capability", capability: "build" }),
    ]),
  );
  evidence.push({ candidate });
  await connect(page, companion, daemon.socket);
  await navigate(
    page,
    companion,
    "#/work?connection=local&workspace=demo&project=release&entity=work-gate-admission",
  );
  await actor(page, "fixture-author", "work-gate-missing");
  await page.getByRole("button", { name: "Admission", exact: true }).click();
  await page.getByRole("button", { name: "Assess run work-gate-missing", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /Run assessment.*work-gate-missing/u }),
  ).toBeVisible();
  await expect(page.locator(".work-reasons")).toContainText("allocation");
  const missing = await native(daemon, "ticket.readiness", {
    ticket_id: "work-gate-admission",
    target_run_id: "work-gate-missing",
  });
  expect(missing.ready).toBe(false);
  expect(JSON.stringify(missing.reasons)).toContain("missing_capability");
  await write("ticket.claim", {
    ticket_id: "work-gate-holder",
    run_id: "work-gate-ready",
    expected_revision: "1",
  });
  await actor(page, "fixture-author", "work-gate-ready");
  await refreshTicket(page);
  await page.getByRole("button", { name: "Assess run work-gate-ready", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /Run assessment.*work-gate-ready/u }),
  ).toBeVisible();
  const full = await native(daemon, "ticket.readiness", {
    ticket_id: "work-gate-admission",
    target_run_id: "work-gate-ready",
  });
  expect(full.ready).toBe(false);
  expect(JSON.stringify(full.reasons)).toContain("pool_full");
  await expect(page.locator(".work-reasons")).toContainText("allocation");
  await screenshot(page, info, "registered-run-full-pool");
  const held = object(
    (await native(daemon, "ticket.read", { ticket_id: "work-gate-holder" })).ticket,
  );
  await write("ticket.release", {
    ticket_id: "work-gate-holder",
    run_id: "work-gate-ready",
    token: object(held.claim).token,
  });
  await refreshTicket(page);
  await page.getByRole("button", { name: "Assess run work-gate-ready", exact: true }).click();
  await expect(page.getByText("Known admission checks pass", { exact: true })).toBeVisible();
  let dialog = await action(page, "ticket.claim");
  await actionReview(dialog);
  // No ticket guard changed: only the independently revised allocation policy changes.
  await write("allocation.ticket_policy_put", {
    ticket_id: "work-gate-admission",
    expected_revision: "1",
    required_capabilities: ["new-required-capability"],
    pools: ["work-gate-pool"],
  });
  await dialog.getByRole("button", { name: "Apply action", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: /^rejected$/u })).toBeVisible();
  const refused = object(
    (await native(daemon, "ticket.read", { ticket_id: "work-gate-admission" })).ticket,
  );
  expect(refused.claim).toBe(null);
  expect(refused.revision).toBe("1");
  evidence.push({ missing, full, refused });
  await dialog
    .getByRole("button", { name: "Close editor; keep captured intention", exact: true })
    .click();
  await write("allocation.ticket_policy_put", {
    ticket_id: "work-gate-admission",
    expected_revision: "2",
    required_capabilities: ["build"],
    pools: ["work-gate-pool"],
  });
  const claimed = await write("ticket.claim", {
    ticket_id: "work-gate-admission",
    run_id: "work-gate-ready",
    expected_revision: "1",
  });
  await refreshTicket(page);
  dialog = await action(page, "ticket.update");
  await actionField(dialog, "Title", "Forbidden claimed title");
  await dialog.getByRole("button", { name: "Review action", exact: true }).click();
  await expect(
    dialog
      .getByRole("alert")
      .filter({ hasText: "Release the claim or publish an instruction amendment" }),
  ).toBeVisible();
  expect(
    object((await native(daemon, "ticket.read", { ticket_id: "work-gate-admission" })).ticket)
      .title,
  ).toBe("Guarded admission");
  await dialog.getByRole("button", { name: "Discard unsent draft", exact: true }).click();
  dialog = await action(page, "ticket.metadata");
  await actionField(dialog, "Priority (0 unspecified, 1 urgent, 2 high, 3 normal, 4 low)", "2");
  await actionReview(dialog);
  await actionApply(dialog);
  const after = object(
    (await native(daemon, "ticket.read", { ticket_id: "work-gate-admission" })).ticket,
  );
  expect(after.title).toBe("Guarded admission");
  expect(after.priority).toBe("2");
  expect(object(after.claim).run_id).toBe("work-gate-ready");
  await dialog
    .getByRole("button", { name: "Close editor; keep captured intention", exact: true })
    .click();
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByLabel("Participation action", { exact: true }).selectOption("ticket.progress");
  await page.getByRole("button", { name: "Open participation composer", exact: true }).click();
  const progress = page.getByRole("dialog", { name: "Post owner progress", exact: true });
  await progress
    .getByLabel("Message", { exact: true })
    .fill("Claimed owner progress remains permitted");
  await progress.getByRole("button", { name: "Post", exact: true }).click();
  await expect(progress.getByText("Committed", { exact: true })).toBeVisible();
  const comments = await native(daemon, "comment.list", {
    target: { kind: "ticket", id: "work-gate-admission" },
    max_bytes: "1048576",
  });
  expect(comments.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        body: "Claimed owner progress remains permitted",
        author_id: "fixture-author",
      }),
    ]),
  );
  const afterProgress = object(
    (await native(daemon, "ticket.read", { ticket_id: "work-gate-admission" })).ticket,
  );
  expect(afterProgress.revision).toBe(after.revision);
  expect(object(afterProgress.claim).token).toBe(object(after.claim).token);
  evidence.push({ claimed, after, comments, afterProgress });
  await info.attach("admission-and-claimed-edit-native-readbacks", {
    body: JSON.stringify(evidence, null, 2),
    contentType: "application/json",
  });
  await screenshot(page, info, "claimed-instructions-refused-metadata-committed");
  await page.waitForLoadState("networkidle");
  expect(browserFailures).toEqual([]);
});

test("W10 frozen dependency and metadata apply uses entity guards, not a global preflight CAS", async ({
  page,
  daemon,
  companion,
  browserFailures,
}, info) => {
  const proxy = await loseOneApply(daemon),
    write = writer(daemon);
  await write("ticket.create", {
    ticket_id: "work-gate-race",
    title: "Preflight race target",
    project_id: "release",
  });
  const document = (revision: string) => ({
    format: "workgraph-ui-plan-1",
    title: "Exact entity guards",
    stages: [
      {
        id: "coupled",
        title: "Coupled dependency and metadata",
        operations: [
          {
            method: "ticket.metadata",
            params: { ticket_id: "work-gate-race", expected_revision: revision, priority: "2" },
            alias: null,
          },
          {
            method: "dependency.add",
            params: { ticket_id: "work-gate-race", prerequisite_id: "design" },
            alias: null,
          },
        ],
        bindings: [],
        exposures: [],
        exposure: "One native atomic transaction; preflight does not reserve workspace state.",
      },
    ],
  });
  const newDraft = async (revision: string) => {
    await page.getByRole("button", { name: "New workflow draft", exact: true }).click();
    await planEditor(page).locator("details.plan-raw > summary").click();
    await planEditor(page)
      .getByLabel("Exact plan source", { exact: true })
      .fill(JSON.stringify(document(revision)));
    await planEditor(page)
      .getByRole("button", { name: "Parse current source", exact: true })
      .click();
    await settled(page);
    return review(page, 1);
  };
  const save = async (region: Locator) => {
    await region
      .getByRole("button", { name: "Save native operation (do not execute)", exact: true })
      .click();
    await expect(
      region.getByRole("status").filter({ hasText: /^prepared_unsent$/u }),
    ).toBeVisible();
  };
  try {
    await connect(page, companion, proxy.socket);
    await navigate(page, companion, "#/workflow?connection=local&workspace=demo&project=release");
    await actor(page, "fixture-author");
    await page.getByRole("button", { name: "Drafts", exact: true }).click();
    let region = await newDraft("1");
    await save(region);
    await write("ticket.create", {
      ticket_id: "unrelated-before-conflict",
      title: "Unrelated workspace change",
    });
    await write("ticket.metadata", {
      ticket_id: "work-gate-race",
      expected_revision: "1",
      priority: "1",
    });
    await region.getByRole("button", { name: "Execute saved request", exact: true }).click();
    await expect(region.getByRole("status").filter({ hasText: /^rejected$/u })).toBeVisible();
    const refused = object(
      (await native(daemon, "ticket.read", { ticket_id: "work-gate-race" })).ticket,
    );
    expect(refused.revision).toBe("2");
    expect(refused.priority).toBe("1");
    expect(refused.prerequisite_ticket_ids).toEqual([]);
    // A deliberately new draft uses the current entity guard. Unrelated planning writes alone must not invalidate it.
    region = await newDraft("2");
    await save(region);
    await write("ticket.create", {
      ticket_id: "unrelated-before-success",
      title: "Another unrelated workspace change",
    });
    await region.getByRole("button", { name: "Execute saved request", exact: true }).click();
    await expect(region.getByRole("status").filter({ hasText: /^committed$/u })).toBeVisible();
    const after = object(
      (await native(daemon, "ticket.read", { ticket_id: "work-gate-race" })).ticket,
    );
    expect(after.priority).toBe("2");
    expect(after.prerequisite_ticket_ids).toEqual(["design"]);
    const applied = proxy.requests.filter((request) => request.method === "transaction.apply");
    expect(applied).toHaveLength(2);
    for (const request of applied) {
      expect(request.params.expected_revision).toBeUndefined();
      expect(request.params.at_revision).toBeUndefined();
      expect(request.params.actor_id).toBe("fixture-author");
    }
    expect(applied[0]?.params.operations).toEqual(
      document("1").stages[0]?.operations.map(({ method, params }) => ({ method, params })),
    );
    expect(applied[1]?.params.operations).toEqual(
      document("2").stages[0]?.operations.map(({ method, params }) => ({ method, params })),
    );
    expect(applied[0]?.params.mutation_id).not.toBe(applied[1]?.params.mutation_id);
    await info.attach("preflight-race-exact-native-requests-and-readbacks", {
      body: JSON.stringify({ requests: proxy.requests, refused, after }, null, 2),
      contentType: "application/json",
    });
    await screenshot(page, info, "preflight-race-deliberate-fresh-draft");
    expect(proxy.failures).toEqual([]);
    expect(browserFailures).toEqual([]);
  } finally {
    await page.close();
    await proxy.dispose();
  }
});
