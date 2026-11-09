import { waitForPageReads } from "../../e2e/support/readiness";
import { createHash } from "node:crypto";
import type { Locator, Page, TestInfo } from "@playwright/test";
import type { DaemonFixture } from "../../../../test-support/daemon-fixture.mjs";
import type { CompanionFixture } from "../../../../test-support/companion-fixture.mjs";
import { test, expect } from "../../e2e/support/fixtures";
import { definition } from "../../../src/features/workflow/evidence/commands";
import type { EvidenceMethod } from "../../../src/features/workflow/evidence/types";

test.use({ colorScheme: "dark", viewport: { width: 1600, height: 1100 }, actionTimeout: 10000 });
// This fixture's fixed native records are decoded in Node only. Production content stays lossless.
interface Result {
  [key: string]: unknown;
}
function native(daemon: DaemonFixture) {
  let serial = 0;
  const read = async (method: string, params: Result = {}): Promise<Result> =>
    (
      JSON.parse(
        await daemon.call(method, JSON.stringify({ workspace_id: "demo", ...params })),
      ) as { result: { data: Result } }
    ).result.data;
  const write = (
    method: string,
    params: Result = {},
    actor = "worker",
    run: string | null = "worker-run",
  ) =>
    read(method, {
      actor_id: actor,
      mutation_id: `evidence-browser-${++serial}`,
      ...(run === null ? {} : { run_id: run }),
      ...params,
    });
  return { read, write };
}
function record(value: unknown): Result {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected fixed native fixture record");
  return value as Result;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected native fixture string");
  return value;
}
function list(value: unknown): readonly Result[] {
  if (!Array.isArray(value)) throw new Error("Expected fixture collection");
  return value.map(record);
}
async function setup(daemon: DaemonFixture) {
  const api = native(daemon);
  await api.write(
    "run.register",
    { target_run_id: "worker-run", objective: "Produce actual synthetic candidate" },
    "worker",
    null,
  );
  await api.write(
    "run.register",
    { target_run_id: "reviewer-run", objective: "Independently inspect exact synthetic candidate" },
    "reviewer",
    null,
  );
  await api.write("ticket.create", {
    ticket_id: "proof",
    project_id: "release",
    title: "Review the exact candidate",
  });
  const started = await api.write("ticket.start", {
    ticket_id: "proof",
    attempt_id: "proof-attempt",
  });
  return { ...api, token: string(started.token) };
}
async function acting(page: Page, id = "worker", run = "worker-run") {
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill(id);
  await page.getByLabel("Run ID (optional)", { exact: true }).fill(run);
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  await waitForPageReads(page);
}
async function mount(page: Page, companion: CompanionFixture, daemon: DaemonFixture) {
  const response = await page.request.get(companion.url),
    matches = [
      ...(await response.text()).matchAll(
        /<meta name="workgraph-capability" content="([a-f0-9]{64})"/gu,
      ),
    ],
    cap = matches[0]?.[1];
  expect(response.status()).toBe(200);
  if (matches.length !== 1 || !cap) throw new Error("Missing native capability");
  for (const [path, body] of [
    ["/connections", { id: "local", label: "Synthetic evidence fixture", socket: daemon.socket }],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const result = await page.request.post(new URL(`/ui-api/v1${path}`, companion.url).href, {
      headers: { "X-Workgraph-UI-Capability": cap, Origin: new URL(companion.url).origin },
      data: body,
    });
    expect(result.status()).toBe(200);
    await result.text();
  }
  await page.goto(
    new URL(
      "/#/workflow?connection=local&workspace=demo&project=release&entity=proof",
      companion.url,
    ).href,
  );
  await expect(page.getByRole("heading", { name: "Graph", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Review & evidence", exact: true })).toBeVisible();
  await waitForPageReads(page);
  await acting(page);
}
function evidence(page: Page) {
  return page.getByRole("region", { name: "Review and evidence", exact: true });
}
async function refresh(page: Page) {
  await evidence(page)
    .getByRole("button", { name: "Refresh current evidence", exact: true })
    .click();
  await expect(
    evidence(page)
      .getByRole("status")
      .filter({ hasText: /^Reading /u }),
  ).toHaveCount(0);
  await waitForPageReads(page);
}
async function open(page: Page, method: EvidenceMethod) {
  const area = evidence(page);
  await area.getByLabel("Review workflow step", { exact: true }).selectOption(method);
  await area.getByRole("button", { name: "Open captured editor", exact: true }).click();
  const panel = area
    .locator("section.wg-panel")
    .filter({ has: page.getByRole("heading", { name: definition(method).title, exact: true }) });
  await expect(
    panel.getByRole("button", { name: "Review this action", exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("Capturing the actual ticket owner and initial fields…", { exact: true }),
  ).toHaveCount(0);
  return panel;
}
function structured(panel: Locator, label: string) {
  return panel.locator("fieldset.ev-structured").filter({
    has: panel.page().locator("legend", {
      hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u"),
    }),
  });
}
async function fill(panel: Locator, label: string, value: string) {
  await panel.getByLabel(label, { exact: true }).fill(value);
}
async function source(panel: Locator, label: string, value: unknown) {
  const box = structured(panel, label);
  await box.locator("summary").click();
  await box.getByLabel(`${label} source`, { exact: true }).fill(JSON.stringify(value));
  await expect(box.getByRole("status")).toHaveCount(0);
}
async function commit(panel: Locator) {
  await expect(
    panel.getByRole("button", { name: "Review this action", exact: true }),
  ).toBeEnabled();
  await panel.getByRole("button", { name: "Review this action", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Execute saved request", exact: true }),
  ).toBeEnabled();
  await panel.getByRole("button", { name: "Execute saved request", exact: true }).click();
  await expect(panel.getByRole("status").filter({ hasText: /^committed$/u })).toBeVisible();
}
async function rejected(panel: Locator, message: RegExp) {
  await panel.getByRole("button", { name: "Review this action", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Execute saved request", exact: true }),
  ).toBeEnabled();
  await panel.getByRole("button", { name: "Execute saved request", exact: true }).click();
  await expect(panel.getByRole("status").filter({ hasText: /^rejected$/u })).toBeVisible();
  await expect(panel.getByRole("alert").filter({ hasText: message })).toBeVisible();
}
async function close(page: Page, panel: Locator) {
  await panel
    .getByRole("button", { name: "Close editor (keep saved operation)", exact: true })
    .click();
  await refresh(page);
}
async function shot(page: Page, info: TestInfo, name: string) {
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /Preparing content|Reading |Saving structured field/u }),
  ).toHaveCount(0);
  await evidence(page).scrollIntoViewIfNeeded();
  const path = info.outputPath(name);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: "image/png" });
}
async function artifact(panel: Locator, label: string, pin: Result) {
  const box = structured(panel, label);
  await box.getByRole("button", { name: "Add artifact", exact: true }).click();
  await fill(box, "Artifact name", "result");
  await fill(box, "resource id", string(pin.resource_id));
  await fill(box, "Content version (not metadata revision)", string(pin.revision));
  await fill(box, "digest", string(pin.digest));
  await expect(box.getByRole("status")).toHaveCount(0);
}
async function publish(api: ReturnType<typeof native>, id: string, text: string, expected = "0") {
  const resource = await api.write("resource.put_text", {
    resource_id: id,
    expected_revision: expected,
    title: id,
    text,
  });
  const version = record(resource.version);
  return { resource_id: id, revision: string(version.revision), digest: string(version.digest) };
}
async function verify(
  api: ReturnType<typeof native>,
  pin: { resource_id: string; revision: string; digest: string },
  expected: string,
) {
  const captured = await api.read("resource.read", {
    resource_id: pin.resource_id,
    version: pin.revision,
  });
  const bytes = string(captured.text);
  expect(bytes).toBe(expected);
  expect(createHash("sha256").update(bytes, "utf8").digest("hex")).toBe(pin.digest);
  return captured;
}
async function baseline(api: ReturnType<typeof native>, review = false) {
  const schema = await publish(api, "schema", '{"type":"object","required":["answer"]}'),
    output = await publish(api, "candidate", '{"answer":"verified"}'),
    design = await publish(api, "design-input", '{"design":"version one"}');
  await api.write("review.policy.put", {
    ticket_id: "proof",
    expected_revision: "0",
    enabled: true,
    reviewers: review ? [{ kind: "actor", actor_id: "reviewer" }] : [],
    separate_actor: review,
    validators: [],
  });
  await api.write("contract.put", {
    contract_id: "result-contract",
    expected_revision: "0",
    schema_version: "1",
    schema,
    required_inputs: ["design"],
    required_outputs: ["result"],
  });
  await api.write("manifest.publish", {
    manifest_id: "result-manifest",
    expected_revision: "0",
    schema_version: "1",
    attempt_id: "proof-attempt",
    ticket_id: "proof",
    contract: { contract_id: "result-contract", revision: "1" },
    inputs: [{ name: "design", pin: { kind: "resource", ...design } }],
    outputs: [{ name: "result", pin: { kind: "resource", ...output } }],
  });
  return { schema, output, design };
}

test("W12: structured authoring, two actual review rounds, exact proof preview and separate acceptance/finish", async ({
  page,
  companion,
  daemon,
  browserDiagnostics,
}, info) => {
  void browserDiagnostics;
  test.setTimeout(120000);
  const api = await setup(daemon),
    schema = await publish(api, "schema", '{"type":"object","required":["answer"]}'),
    first = await publish(api, "candidate", '{"answer":"needs correction"}');
  await mount(page, companion, daemon);
  let panel = await open(page, "review.policy.put");
  const reviewers = structured(panel, "Named reviewers and reviewer roles");
  await reviewers.getByRole("button", { name: "Add reviewer", exact: true }).click();
  await fill(reviewers, "Reviewer actor ID", "reviewer");
  await commit(panel);
  await close(page, panel);
  panel = await open(page, "contract.put");
  await fill(panel, "Contract ID", "result-contract");
  const pin = structured(panel, "Schema resource content pin");
  await fill(pin, "resource ID", schema.resource_id);
  await fill(pin, "Content version", schema.revision);
  await fill(pin, "SHA-256 of exact content", schema.digest);
  const outputs = structured(panel, "Required output names");
  await outputs.getByRole("button", { name: "Add name", exact: true }).click();
  await fill(outputs, "Name", "result");
  await commit(panel);
  await close(page, panel);
  panel = await open(page, "manifest.publish");
  await fill(panel, "Manifest ID", "result-manifest");
  await fill(panel, "Actual attempt ID", "proof-attempt");
  const contract = structured(panel, "Exact contract reference");
  await fill(contract, "contract ID", "result-contract");
  await fill(contract, "Object revision", "1");
  await artifact(panel, "Named output pins", first);
  await commit(panel);
  await close(page, panel);
  panel = await open(page, "review.submit");
  await commit(panel);
  await close(page, panel);
  const firstSubmission = await api.read("review.submission.get", { ticket_id: "proof" });
  expect(firstSubmission.generation).toBe("1");
  expect((await api.read("review.gate", { ticket_id: "proof" })).allowed).toBe(false);
  await acting(page, "reviewer", "reviewer-run");
  await evidence(page)
    .getByRole("button", { name: "Read this exact small text", exact: true })
    .click();
  await expect(evidence(page)).toContainText("needs correction");
  panel = await open(page, "review.record");
  await fill(panel, "Review ID", "round-one-changes");
  await fill(
    panel,
    "Evidence and observations",
    "Read candidate content version 1; correct the answer and publish a new exact pin.",
  );
  await commit(panel);
  await close(page, panel);
  const rejected = await api.read("review.submission.get", { ticket_id: "proof" });
  expect(record(rejected.state).kind).toBe("changes_requested");
  const requests = list(
      (
        await api.read("request.list", {
          kind: "blocker_resolution",
          recipient: { kind: "actor", id: "worker" },
          open_only: true,
        })
      ).items,
    ),
    changes = requests.find(
      (item) => item.reply_to_request_id === firstSubmission.review_request_id,
    );
  expect(changes).toBeDefined();
  const second = await publish(api, "candidate", '{"answer":"verified correction"}', "1");
  expect(
    (await api.read("resource.read", { resource_id: "candidate", version: second.revision })).text,
  ).toBe('{"answer":"verified correction"}');
  await acting(page);
  await refresh(page);
  panel = await open(page, "manifest.publish");
  await fill(panel, "Expected object revision", "1");
  await source(panel, "Named output pins", [
    { name: "result", pin: { kind: "resource", ...second } },
  ]);
  await commit(panel);
  await close(page, panel);
  panel = await open(page, "review.submit");
  await commit(panel);
  await close(page, panel);
  const secondSubmission = await api.read("review.submission.get", { ticket_id: "proof" });
  expect(secondSubmission.generation).toBe("2");
  await acting(page, "reviewer", "reviewer-run");
  await evidence(page)
    .getByRole("button", { name: "Read this exact small text", exact: true })
    .click();
  await expect(evidence(page)).toContainText("verified correction");
  panel = await open(page, "review.record");
  await fill(panel, "Review ID", "round-two-approve");
  await panel.getByLabel("Verdict", { exact: true }).selectOption("approve");
  await fill(
    panel,
    "Evidence and observations",
    `Actually read candidate version ${second.revision} digest ${second.digest}; verified correction.`,
  );
  await commit(panel);
  await close(page, panel);
  const afterApproval = await api.read("review.submission.get", { ticket_id: "proof" });
  expect(afterApproval.revision).toBe(secondSubmission.revision);
  expect(record(afterApproval.state).kind).toBe("pending");
  expect(record((await api.read("ticket.read", { ticket_id: "proof" })).ticket).status).toBe(
    "in_progress",
  );
  if (!changes) throw new Error("Missing correlated changes request");
  await api.write(
    "request.resolve",
    { request_id: changes.request_id, expected_revision: changes.revision },
    "reviewer",
    "reviewer-run",
  );
  const superseded = await api.read("request.get", {
    request_id: firstSubmission.review_request_id,
  });
  await api.write("request.resolve", {
    request_id: firstSubmission.review_request_id,
    expected_revision: superseded.revision,
  });
  await acting(page);
  await refresh(page);
  panel = await open(page, "review.accept");
  await commit(panel);
  await close(page, panel);
  expect(record((await api.read("review.submission.get", { ticket_id: "proof" })).state).kind).toBe(
    "accepted",
  );
  expect(record((await api.read("ticket.read", { ticket_id: "proof" })).ticket).status).toBe(
    "in_progress",
  );
  await shot(page, info, "review-accepted-separate-from-finish.png");
  await api.write("ticket.finish", {
    ticket_id: "proof",
    token: api.token,
    evidence:
      "Both actual reviews and exact corrected pins accepted; distinct explicit completion.",
  });
  expect(record((await api.read("ticket.read", { ticket_id: "proof" })).ticket).status).toBe(
    "done",
  );
  await info.attach("two-round-native-proof", {
    body: JSON.stringify(
      { schema, first, second, firstSubmission, secondSubmission, afterApproval, changes },
      null,
      2,
    ),
    contentType: "application/json",
  });
});

test("W13: criteria, validator and captured policy fences reject stale evidence without rewriting it", async ({
  page,
  companion,
  daemon,
  browserDiagnostics,
}, info) => {
  void browserDiagnostics;
  const api = await setup(daemon);
  const { output } = await baseline(api);
  await verify(api, output, '{"answer":"verified"}');
  await mount(page, companion, daemon);
  let panel = await open(page, "acceptance.policy.put");
  const criteria = structured(panel, "Acceptance criteria");
  await criteria.getByRole("button", { name: "Add criterion", exact: true }).click();
  await fill(criteria, "Criterion key", "checks");
  await fill(criteria, "What must be demonstrated", "The actual checked candidate passes");
  await criteria.getByLabel("Required for acceptance", { exact: true }).check();
  const validators = structured(panel, "Required validator names");
  await validators.getByRole("button", { name: "Add name", exact: true }).click();
  await fill(validators, "Name", "checks");
  await commit(panel);
  await close(page, panel);
  panel = await open(page, "acceptance.assert");
  const oldDigest = await panel
    .getByLabel("Captured effective policy SHA-256", { exact: true })
    .inputValue();
  await source(panel, "Exact supporting evidence pins", [{ kind: "resource", ...output }]);
  await source(panel, "Criterion source reference", {
    scope: { kind: "ticket", ticket_id: "proof" },
    policy_revision: "2",
    key: "checks",
  });
  await fill(
    panel,
    "Evidence and observations",
    "Actual candidate independently checked before this policy changed.",
  );
  await api.write("acceptance.policy.put", {
    scope: { kind: "ticket", ticket_id: "proof" },
    expected_revision: "2",
    enabled: true,
    reviewers: [],
    separate_actor: false,
    validators: ["checks"],
    criteria: [{ key: "checks", description: "Revised current requirement", required: true }],
    weakening_reason:
      "Audited synthetic policy description replacement; old captures must be invalidated.",
  });
  await rejected(panel, /Conflict: observed effective policy changed/u);
  expect(oldDigest).toMatch(/^[a-f0-9]{64}$/u);
  await close(page, panel);
  expect((await api.read("review.gate", { ticket_id: "proof" })).allowed).toBe(false);
  panel = await open(page, "acceptance.assert");
  await source(panel, "Exact supporting evidence pins", [{ kind: "resource", ...output }]);
  await source(panel, "Criterion source reference", {
    scope: { kind: "ticket", ticket_id: "proof" },
    policy_revision: "3",
    key: "checks",
  });
  await fill(
    panel,
    "Evidence and observations",
    "Actually checked the exact candidate against the revised current requirement.",
  );
  await commit(panel);
  await close(page, panel);
  panel = await open(page, "validation.add");
  await fill(panel, "Validation ID", "actual-check");
  await fill(panel, "Validator name", "checks");
  await fill(
    panel,
    "Evidence and observations",
    "Actual synthetic check of pinned candidate completed in this test, no command executed by the UI.",
  );
  await commit(panel);
  await close(page, panel);
  await shot(page, info, "criteria-and-current-validation.png");
  const context = await api.read("evidence.context", { ticket_id: "proof" });
  await info.attach("current-evidence-and-stale-policy", {
    body: JSON.stringify({ oldDigest, context }, null, 2),
    contentType: "application/json",
  });
});

test("W14: exact candidate conditions, pinned decisions and explicit changed-input reconciliation", async ({
  page,
  companion,
  daemon,
  browserDiagnostics,
}, info) => {
  void browserDiagnostics;
  const api = await setup(daemon),
    { output, design } = await baseline(api);
  await mount(page, companion, daemon);
  const candidate = { kind: "resource", ...output };
  let panel = await open(page, "condition.put");
  await fill(panel, "Condition ID", "candidate-check");
  await fill(panel, "Condition label", "Observed synthetic candidate verification");
  await fill(panel, "Exact external operation ID", "candidate-check-operation");
  await source(panel, "Exact candidate artifact pin", candidate);
  await commit(panel);
  await close(page, panel);
  panel = await open(page, "condition.signal");
  await fill(panel, "Signal ID", "wrong-candidate");
  await fill(panel, "Condition ID", "candidate-check");
  await fill(panel, "Expected object revision", "1");
  await fill(panel, "Exact external operation ID", "candidate-check-operation");
  const next = await publish(api, "candidate", '{"answer":"changed input"}', "1");
  await source(panel, "Exact candidate artifact pin", { kind: "resource", ...next });
  await source(panel, "Supporting evidence pins", [{ kind: "resource", ...next }]);
  await fill(
    panel,
    "Observed outcome",
    "Deliberately wrong candidate must be rejected, never approval.",
  );
  await rejected(panel, /Conflict: Signal declaration binding differs/u);
  await close(page, panel);
  expect(
    list((await api.read("condition.signals", { condition_id: "candidate-check" })).items),
  ).toHaveLength(0);
  await verify(api, output, '{"answer":"verified"}');
  panel = await open(page, "condition.signal");
  await fill(panel, "Signal ID", "observed-candidate");
  await fill(panel, "Condition ID", "candidate-check");
  await fill(panel, "Expected object revision", "1");
  await fill(panel, "Exact external operation ID", "candidate-check-operation");
  await source(panel, "Exact candidate artifact pin", candidate);
  await source(panel, "Supporting evidence pins", [candidate]);
  await fill(
    panel,
    "Observed outcome",
    "Read exact candidate bytes and verified their pinned SHA-256 in this synthetic test.",
  );
  await commit(panel);
  await close(page, panel);
  expect(
    list((await api.read("condition.signals", { condition_id: "candidate-check" })).items),
  ).toHaveLength(1);
  panel = await open(page, "decision.put");
  await fill(panel, "Decision ID", "candidate-decision");
  await fill(panel, "Decision title", "Use the actually checked candidate");
  await source(panel, "Exact rationale pin", candidate);
  await source(panel, "Supporting pins", [candidate]);
  await commit(panel);
  await close(page, panel);
  const nextDesign = await publish(api, "design-input", '{"design":"version two"}', "1");
  panel = await open(page, "input.changed");
  await source(panel, "Previous exact input pin", { kind: "resource", ...design });
  await source(panel, "Current exact input pin", { kind: "resource", ...nextDesign });
  await commit(panel);
  await close(page, panel);
  const pending = list(
    (await api.read("reconciliation.list", { ticket_id: "proof", pending_only: true })).items,
  );
  expect(pending.length).toBeGreaterThan(0);
  const item = pending[0];
  if (!item) throw new Error("Missing exact reconciliation");
  panel = await open(page, "reconciliation.record");
  await fill(panel, "Reconciliation serial", string(item.serial));
  await fill(panel, "Expected object revision", string(item.revision));
  await source(panel, "Disposition", {
    kind: "continue",
    reason:
      "Inspected changed version; this historical synthetic output intentionally retains the prior exact candidate.",
  });
  await commit(panel);
  await close(page, panel);
  const old = await api.read("resource.read", { resource_id: "candidate", version: "1" });
  expect(old.digest).toBe(output.digest);
  await shot(page, info, "exact-condition-and-reconciled-input.png");
  await info.attach("candidate-bound-condition-proof", {
    body: JSON.stringify({ candidate, next, pending, old }, null, 2),
    contentType: "application/json",
  });
});
