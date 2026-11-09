import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

const digest = /^[0-9a-f]{64}$/u;
const layers = new Set(["native_fault", "native_socket", "native_process", "browser", "pure"]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string[]} */
function strings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

/** Exit zero alone permits skipped or empty Playwright selections.
 * @param {string} path @param {number} expected
 */
export async function verifyPlaywrightReport(path, expected) {
  const reportPin = await filePin(path);
  const value = JSON.parse(await readFile(path, "utf8"));
  if (
    !record(value) ||
    !record(value.stats) ||
    value.stats.expected !== expected ||
    value.stats.skipped !== 0 ||
    value.stats.unexpected !== 0 ||
    value.stats.flaky !== 0 ||
    !Array.isArray(value.errors) ||
    value.errors.length !== 0
  )
    throw new Error("Playwright report did not contain exactly the required passing cases");
  let count = 0;
  /** @param {unknown} suite */
  function visit(suite) {
    if (
      !record(suite) ||
      (suite.suites !== undefined && !Array.isArray(suite.suites)) ||
      (suite.specs !== undefined && !Array.isArray(suite.specs))
    )
      throw new Error("Malformed Playwright suite report");
    for (const child of suite.suites ?? []) visit(child);
    for (const spec of suite.specs ?? []) {
      if (!record(spec) || !Array.isArray(spec.tests))
        throw new Error("Malformed Playwright case report");
      for (const test of spec.tests) {
        if (
          !record(test) ||
          test.expectedStatus !== "passed" ||
          !Array.isArray(test.results) ||
          test.results.length !== 1 ||
          !record(test.results[0]) ||
          test.results[0].status !== "passed"
        )
          throw new Error("Playwright case was skipped, retried or failed");
        count += 1;
      }
    }
  }
  visit(value);
  if (count !== expected) throw new Error("Playwright report case count differs from selection");
  await verifyPins([reportPin], "/");
  return reportPin;
}

/** @param {unknown} value @returns {value is import('./types.d.mts').SourcePin} */
function pin(value) {
  return (
    record(value) &&
    typeof value.path === "string" &&
    value.path.length > 0 &&
    typeof value.sha256 === "string" &&
    digest.test(value.sha256) &&
    typeof value.bytes === "number" &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0
  );
}

/** No scenario is silently dropped merely because its primary gate is elsewhere.
 * @param {unknown} value @returns {asserts value is import('./types.d.mts').RecoveryMatrix}
 */
export function validateMatrix(value) {
  if (
    !record(value) ||
    value.format !== "workgraph-ui-recovery-matrix-1" ||
    !Array.isArray(value.controls) ||
    !Array.isArray(value.scenarios) ||
    !Array.isArray(value.requirements) ||
    value.requirements.length < 2
  ) {
    throw new Error("Invalid recovery matrix contract");
  }
  for (const requirement of value.requirements) {
    if (
      !record(requirement) ||
      typeof requirement.resource !== "string" ||
      typeof requirement.version !== "string" ||
      !/^[1-9][0-9]*$/u.test(requirement.version) ||
      typeof requirement.sha256 !== "string" ||
      !digest.test(requirement.sha256)
    ) {
      throw new Error("Every requirement needs its exact immutable resource pin");
    }
  }
  const controls = new Set();
  for (const control of value.controls) {
    if (
      !record(control) ||
      typeof control.id !== "string" ||
      controls.has(control.id) ||
      typeof control.layer !== "string" ||
      !layers.has(control.layer) ||
      !strings(control.paths) ||
      control.paths.length === 0 ||
      typeof control.behavior !== "string" ||
      control.behavior.length === 0 ||
      !(control.selection === null || typeof control.selection === "string")
    ) {
      throw new Error("Malformed or duplicate recovery control");
    }
    controls.add(control.id);
  }
  const expected = new Set([
    ...Array.from({ length: 56 }, (_, i) => `S${String(i + 1).padStart(2, "0")}`),
    ...Array.from({ length: 6 }, (_, i) => `F${String(i + 1).padStart(2, "0")}`),
  ]);
  for (const scenario of value.scenarios) {
    if (
      !record(scenario) ||
      typeof scenario.id !== "string" ||
      !expected.delete(scenario.id) ||
      typeof scenario.requirement !== "string" ||
      scenario.requirement.length === 0 ||
      !strings(scenario.controls) ||
      scenario.controls.length === 0 ||
      scenario.controls.some((id) => !controls.has(id)) ||
      new Set(scenario.controls).size !== scenario.controls.length ||
      typeof scenario.scope !== "string" ||
      !["recovery_replay", "other_final_gate"].includes(scenario.scope) ||
      !(scenario.limitation === null || typeof scenario.limitation === "string")
    ) {
      throw new Error("Missing, duplicate or unbound recovery scenario");
    }
    if (scenario.scope === "other_final_gate") {
      if (
        typeof scenario.otherGate !== "string" ||
        !scenario.otherGate.startsWith("ui-") ||
        typeof scenario.limitation !== "string" ||
        scenario.limitation.length === 0
      ) {
        throw new Error(
          "External final-gate coverage needs an explicit limitation, never a waiver",
        );
      }
    } else if (scenario.otherGate !== null) {
      throw new Error("Recovery replay cannot silently delegate its required check");
    }
  }
  if (expected.size !== 0)
    throw new Error(`Unmapped recovery scenarios: ${[...expected].join(", ")}`);
}

/** @param {unknown} value @returns {asserts value is import('./types.d.mts').RunPlan} */
export function validatePlan(value) {
  if (!record(value) || value.format !== "workgraph-ui-recovery-run-1") {
    throw new Error("Invalid recovery run contract");
  }
  validateMatrix(value.matrix);
  if (
    typeof value.sourceRoot !== "string" ||
    !isAbsolute(value.sourceRoot) ||
    !Array.isArray(value.sources) ||
    value.sources.length === 0 ||
    !Array.isArray(value.candidate) ||
    value.candidate.length < 4 ||
    !value.sources.every(pin) ||
    !value.candidate.every(pin) ||
    new Set(value.sources.map((item) => item.path)).size !== value.sources.length ||
    new Set(value.candidate.map((item) => item.path)).size !== value.candidate.length ||
    !record(value.editor) ||
    typeof value.editor.state !== "string" ||
    !["unqualified", "accepted"].includes(value.editor.state) ||
    !Array.isArray(value.checks) ||
    value.checks.length === 0
  ) {
    throw new Error("Run needs exact source/artifact closure and explicit editor applicability");
  }
  if (value.editor.state === "accepted") {
    const editor = value.editor;
    const resource = (/** @type {unknown} */ item) =>
      record(item) &&
      typeof item.workspace === "string" &&
      item.workspace.length > 0 &&
      typeof item.resource === "string" &&
      item.resource.length > 0 &&
      typeof item.version === "string" &&
      /^[1-9][0-9]*$/u.test(item.version) &&
      typeof item.sha256 === "string" &&
      digest.test(item.sha256);
    const observation = (/** @type {unknown} */ item) =>
      record(item) && pin(item.request) && pin(item.response);
    if (
      editor.ticket !== "ui-v-editor" ||
      typeof editor.generation !== "string" ||
      !/^[1-9][0-9]*$/u.test(editor.generation) ||
      !record(editor.manifest) ||
      typeof editor.manifest.id !== "string" ||
      typeof editor.manifest.revision !== "string" ||
      !/^[1-9][0-9]*$/u.test(editor.manifest.revision) ||
      !resource(editor.source) ||
      !resource(editor.evidence) ||
      !observation(editor.submission) ||
      !observation(editor.gate) ||
      !observation(editor.manifestObservation) ||
      !pin(editor.runtimeInventory)
    ) {
      throw new Error(
        "Accepted editor requires exact output pins, observed submission/manifest/gate and runtime inventory",
      );
    }
  } else if (typeof value.editor.reason !== "string" || value.editor.reason.length === 0) {
    throw new Error("Unqualified editor needs an honest pending reason");
  }
  const ids = new Set();
  const known = new Set(value.matrix.controls.map((control) => control.id));
  for (const check of value.checks) {
    if (
      !record(check) ||
      typeof check.id !== "string" ||
      !/^[a-z][a-z0-9-]*$/u.test(check.id) ||
      ids.has(check.id) ||
      !strings(check.controlIds) ||
      check.controlIds.length === 0 ||
      check.controlIds.some((id) => !known.has(id)) ||
      !strings(check.argv) ||
      typeof check.argv[0] !== "string" ||
      !isAbsolute(check.argv[0]) ||
      typeof check.cwd !== "string" ||
      !isAbsolute(check.cwd) ||
      !record(check.environment) ||
      Object.values(check.environment).some((item) => typeof item !== "string") ||
      typeof check.timeoutMs !== "number" ||
      !Number.isSafeInteger(check.timeoutMs) ||
      check.timeoutMs < 1 ||
      check.timeoutMs > 1_800_000
    ) {
      throw new Error("Malformed, duplicate or unbound execution check");
    }
    // A successful custom diff command can turn failed expect output into a false pass.
    // Use the runner's default comparison, preserving strict native exit status.
    if (check.argv.some((arg) => arg === "-diff-cmd" || arg.startsWith("-diff-cmd="))) {
      throw new Error("Expect-test diff overrides are forbidden in recovery qualification");
    }
    if (
      check.playwright !== undefined &&
      (!record(check.playwright) ||
        typeof check.playwright.path !== "string" ||
        !isAbsolute(check.playwright.path) ||
        !Number.isSafeInteger(check.playwright.cases) ||
        typeof check.playwright.cases !== "number" ||
        check.playwright.cases < 1)
    )
      throw new Error("Malformed Playwright verification requirement");
    const controlIds = check.controlIds;
    if (
      value.matrix.controls.some(
        (control) =>
          controlIds.includes(control.id) &&
          control.paths.some((path) => path.endsWith(".browser.ts")),
      ) &&
      check.playwright === undefined
    )
      throw new Error("Playwright recovery controls require actual report verification");
    ids.add(check.id);
  }
}

/** @param {string} path @returns {Promise<import('./types.d.mts').SourcePin>} */
export async function filePin(path) {
  const bytes = await readFile(path);
  return { path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

/** @param {readonly import('./types.d.mts').SourcePin[]} pins @param {string} root */
export async function verifyPins(pins, root) {
  for (const expected of pins) {
    const path = resolve(root, expected.path);
    if (!isAbsolute(expected.path) && !path.startsWith(resolve(root) + sep)) {
      throw new Error(`Source escapes captured root: ${expected.path}`);
    }
    const actual = await filePin(path);
    if (
      !(await stat(path)).isFile() ||
      actual.bytes !== expected.bytes ||
      actual.sha256 !== expected.sha256
    ) {
      throw new Error(`Changed qualification input: ${expected.path}`);
    }
  }
}

/** Reports a subset truthfully; a registered witness is never a passing test.
 * @param {import('./types.d.mts').RecoveryMatrix} matrix
 * @param {readonly import('./types.d.mts').CheckResult[]} results
 */
export function scenarioResults(matrix, results) {
  const passed = new Set(
    results.filter((item) => item.outcome === "passed").flatMap((item) => item.controls),
  );
  return matrix.scenarios.map((scenario) => ({
    id: scenario.id,
    scope: scenario.scope,
    passedControls: scenario.controls.filter((id) => passed.has(id)),
    missingControls: scenario.controls.filter((id) => !passed.has(id)),
    replayComplete: scenario.controls.every((id) => passed.has(id)),
    otherGate: scenario.otherGate,
    limitation: scenario.limitation,
  }));
}

/** Offline comparison of actual captured Workgraph observations. This is evidence
 * binding, not authentication: independent review checks their original read provenance.
 * @param {import('./types.d.mts').RunPlan} plan
 */
export async function verifyEditor(plan) {
  if (plan.editor.state !== "accepted") return false;
  const editor = plan.editor;
  const pins = [
    editor.submission.request,
    editor.submission.response,
    editor.gate.request,
    editor.gate.response,
    editor.manifestObservation.request,
    editor.manifestObservation.response,
    editor.runtimeInventory,
  ];
  await verifyPins(pins, plan.sourceRoot);
  /** @param {import('./types.d.mts').SourcePin} pin @returns {Promise<unknown>} */
  const load = async (pin) =>
    JSON.parse(await readFile(resolve(plan.sourceRoot, pin.path), "utf8"));
  /** @param {unknown} response */
  const data = (response) => {
    if (
      !record(response) ||
      !record(response.result) ||
      !record(response.result.data) ||
      "error" in response
    ) {
      throw new Error("Editor observation is not a successful full Workgraph response");
    }
    return response.result.data;
  };
  const submissionParams = await load(editor.submission.request),
    gateParams = await load(editor.gate.request);
  const manifestParams = await load(editor.manifestObservation.request);
  if (
    !record(submissionParams) ||
    submissionParams.ticket_id !== editor.ticket ||
    !record(gateParams) ||
    gateParams.ticket_id !== editor.ticket ||
    !record(manifestParams) ||
    manifestParams.manifest_id !== editor.manifest.id ||
    manifestParams.version !== editor.manifest.revision
  ) {
    throw new Error("Editor observation request targets another ticket or manifest");
  }
  const submission = data(await load(editor.submission.response));
  const gate = data(await load(editor.gate.response));
  const manifest = data(await load(editor.manifestObservation.response));
  if (
    submission.ticket_id !== editor.ticket ||
    submission.generation !== editor.generation ||
    !record(submission.state) ||
    submission.state.kind !== "accepted" ||
    !record(submission.manifest) ||
    submission.manifest.manifest_id !== editor.manifest.id ||
    submission.manifest.revision !== editor.manifest.revision ||
    gate.allowed !== true ||
    gate.problem !== null ||
    manifest.ticket_id !== editor.ticket ||
    manifest.manifest_id !== editor.manifest.id ||
    manifest.revision !== editor.manifest.revision ||
    !Array.isArray(manifest.outputs)
  ) {
    throw new Error("Editor is not accepted at the exact observed generation and manifest");
  }
  for (const [name, expected] of [
    ["source", editor.source],
    ["evidence", editor.evidence],
  ]) {
    const outputs = manifest.outputs.filter((output) => record(output) && output.name === name);
    const output = outputs[0];
    if (
      expected === undefined ||
      typeof expected === "string" ||
      outputs.length !== 1 ||
      !record(output) ||
      !record(output.pin) ||
      output.pin.kind !== "resource" ||
      output.pin.resource_id !== expected.resource ||
      output.pin.revision !== expected.version ||
      output.pin.digest !== expected.sha256 ||
      expected.workspace !== editor.source.workspace ||
      submissionParams.workspace_id !== expected.workspace ||
      gateParams.workspace_id !== expected.workspace ||
      manifestParams.workspace_id !== expected.workspace
    ) {
      throw new Error("Editor output resource pins differ from the accepted manifest/workspace");
    }
  }
  const inventory = await load(editor.runtimeInventory);
  if (
    !record(inventory) ||
    inventory.format !== "workgraph-ui-editor-runtime-inventory-1" ||
    !record(inventory.source) ||
    inventory.source.workspace !== editor.source.workspace ||
    inventory.source.resource !== editor.source.resource ||
    inventory.source.version !== editor.source.version ||
    inventory.source.sha256 !== editor.source.sha256 ||
    !Array.isArray(inventory.files) ||
    inventory.files.length === 0 ||
    !inventory.files.every(pin)
  ) {
    throw new Error("Missing complete accepted editor runtime source mapping");
  }
  const sourceMap = new Map(plan.sources.map((entry) => [entry.path, entry]));
  for (const entry of inventory.files) {
    const candidate = sourceMap.get(entry.path);
    if (candidate?.sha256 !== entry.sha256 || candidate.bytes !== entry.bytes) {
      throw new Error(`Accepted editor input differs from candidate: ${entry.path}`);
    }
  }
  await verifyPins(inventory.files, plan.sourceRoot);
  return true;
}
