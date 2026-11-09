import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  filePin,
  scenarioResults,
  validateMatrix,
  validatePlan,
  verifyEditor,
  verifyPins,
} from "./audit.mjs";
import { execute, run } from "./run.mjs";

const matrix = JSON.parse(await readFile(new URL("./matrix.json", import.meta.url), "utf8"));

/** @template T @param {(root: string) => Promise<T>} body */
async function isolated(body) {
  const root = await mkdtemp(join(tmpdir(), "workgraph-recovery-check-"));
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** @param {string} root */
async function planFor(root) {
  const pins = [];
  for (const name of ["controlled-input", "core", "ui", "runner", "process"]) {
    const path = join(root, name);
    await writeFile(path, name);
    pins.push(await filePin(path));
  }
  return {
    format: "workgraph-ui-recovery-run-1",
    sourceRoot: root,
    matrix,
    sources: pins.slice(0, 1),
    candidate: pins.slice(1),
    editor: {
      state: "unqualified",
      reason: "Controlled harness test, never product qualification",
    },
    checks: [
      {
        id: "controlled",
        controlIds: ["native-state"],
        argv: [process.execPath, "-e", "process.exit(0)"],
        cwd: root,
        environment: {},
        timeoutMs: 5_000,
      },
    ],
  };
}

test("the matrix keeps every scenario and does not turn an unexecuted witness into proof", () => {
  validateMatrix(matrix);
  const untouched = scenarioResults(matrix, []);
  assert.equal(untouched.length, 62);
  assert(untouched.every((row) => !row.replayComplete && row.passedControls.length === 0));
  const incomplete = structuredClone(matrix);
  incomplete.scenarios = incomplete.scenarios.filter((row) => row.id !== "S11");
  assert.throws(() => validateMatrix(incomplete), /Unmapped recovery scenarios/u);
  const delegated = structuredClone(matrix);
  const content = delegated.scenarios.find((row) => row.id === "S49");
  content.limitation = null;
  assert.throws(() => validateMatrix(delegated), /explicit limitation/u);
});

test("false-pass native diff overrides and bare caller acceptance are rejected", async () =>
  isolated(async (root) => {
    const plan = await planFor(root);
    validatePlan(plan);
    plan.checks[0].argv.push("-diff-cmd", "-");
    assert.throws(() => validatePlan(plan), /diff overrides are forbidden/u);
    plan.checks[0].argv.splice(-2);
    plan.editor = { state: "accepted", source: "unbound", evidence: "unbound" };
    assert.throws(() => validatePlan(plan), /exact output pins/u);
  }));

test("input tampering after a successful child prevents review readiness and stops later checks", async () =>
  isolated(async (root) => {
    const plan = await planFor(root);
    const input = plan.sources[0].path;
    plan.checks[0].argv = [
      process.execPath,
      "-e",
      "require('node:fs').writeFileSync(process.argv[1], 'changed')",
      input,
    ];
    plan.checks.push({
      ...plan.checks[0],
      id: "must-not-start",
      argv: [process.execPath, "-e", "throw Error('must not run')"],
    });
    const path = join(root, "plan.json");
    await writeFile(path, JSON.stringify(plan));
    const result = await run(path, join(root, "output"));
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].outcome, "passed");
    assert.equal(result.unchanged, false);
    assert.equal(result.readyForReview, false);
    assert.match(result.failure, /Changed qualification input/u);
    await assert.rejects(() => verifyPins(plan.sources, root), /Changed qualification input/u);
  }));

test("a failed child retains diagnostics, permits other checks and cannot claim all controls passed", async () =>
  isolated(async (root) => {
    const plan = await planFor(root);
    plan.checks[0].argv = [
      process.execPath,
      "-e",
      "console.error('controlled native-style failure'); process.exit(7)",
    ];
    plan.checks.push({
      ...plan.checks[0],
      id: "later-control",
      controlIds: ["native-rpc"],
      argv: [process.execPath, "-e", "console.log('later control executed')"],
    });
    const path = join(root, "plan.json");
    await writeFile(path, JSON.stringify(plan));
    const result = await run(path, join(root, "output"));
    assert.deepEqual(
      result.results.map((row) => [row.outcome, row.exitCode]),
      [
        ["failed", 7],
        ["passed", 0],
      ],
    );
    assert.match(
      await readFile(result.results[0].log.path, "utf8"),
      /controlled native-style failure/u,
    );
    assert.equal(result.unchanged, true);
    assert.equal(result.editorAccepted, false);
    assert.equal(result.readyForReview, false);
    assert(
      result.scenarios.find((row) => row.id === "F01").missingControls.includes("native-state"),
    );
  }));

test("timeout and spawn failure remain distinct from success with owned child reaped", async () =>
  isolated(async (root) => {
    const check = (await planFor(root)).checks[0];
    const timeout = await execute(
      { ...check, argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"], timeoutMs: 50 },
      root,
    );
    assert.equal(timeout.outcome, "timed_out");
    assert.equal(timeout.exitCode, null);
    assert.equal(timeout.signal, "SIGTERM");
    const absent = await execute(
      { ...check, id: "absent", argv: [join(root, "missing-executable")] },
      root,
    );
    assert.equal(absent.outcome, "spawn_failed");
    assert.notEqual(absent.exitCode, 0);
  }));

test("an unavailable log fails before starting the child and cannot hang log cleanup", async () =>
  isolated(async (root) => {
    const check = (await planFor(root)).checks[0];
    const marker = join(root, "must-not-exist");
    const log = join(root, `${check.id}.log`);
    await writeFile(log, "existing diagnostics must survive");
    const sideEffect = {
      ...check,
      argv: [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], 'started')",
        marker,
      ],
    };
    await assert.rejects(() => execute(sideEffect, root), { code: "EEXIST" });
    assert.equal(await readFile(log, "utf8"), "existing diagnostics must survive");
    await assert.rejects(() => readFile(marker), { code: "ENOENT" });
    await assert.rejects(() => execute(sideEffect, log), { code: "ENOTDIR" });
    await assert.rejects(() => readFile(marker), { code: "ENOENT" });
  }));

test("an accepted editor observation cannot bind another manifest or changed runtime source", async () =>
  isolated(async (root) => {
    const plan = await planFor(root);
    const resource = {
      workspace: "workgraph-ui",
      resource: "editor-source",
      version: "1",
      sha256: "a".repeat(64),
    };
    /** @param {string} name @param {unknown} value */
    const save = async (name, value) => {
      const path = join(root, name);
      await writeFile(path, JSON.stringify(value));
      return filePin(path);
    };
    const observe = async (name, request, data) => ({
      request: await save(`${name}-request.json`, request),
      response: await save(`${name}-response.json`, { result: { data } }),
    });
    const params = { workspace_id: "workgraph-ui", ticket_id: "ui-v-editor" };
    plan.editor = {
      state: "accepted",
      ticket: "ui-v-editor",
      generation: "1",
      manifest: { id: "editor-delivery", revision: "1" },
      source: resource,
      evidence: { ...resource, resource: "editor-evidence", sha256: "b".repeat(64) },
      submission: await observe("submission", params, {
        ticket_id: "ui-v-editor",
        generation: "1",
        state: { kind: "accepted" },
        manifest: { manifest_id: "other-delivery", revision: "1" },
      }),
      gate: await observe("gate", params, { allowed: true, problem: null }),
      manifestObservation: await observe(
        "manifest",
        { workspace_id: "workgraph-ui", manifest_id: "editor-delivery", version: "1" },
        {
          ticket_id: "ui-v-editor",
          manifest_id: "editor-delivery",
          revision: "1",
          outputs: [
            {
              name: "source",
              pin: {
                kind: "resource",
                resource_id: "editor-source",
                revision: "1",
                digest: "a".repeat(64),
              },
            },
            {
              name: "evidence",
              pin: {
                kind: "resource",
                resource_id: "editor-evidence",
                revision: "1",
                digest: "b".repeat(64),
              },
            },
          ],
        },
      ),
      runtimeInventory: await save("inventory.json", {
        format: "workgraph-ui-editor-runtime-inventory-1",
        source: resource,
        files: plan.sources,
      }),
    };
    validatePlan(plan);
    await assert.rejects(() => verifyEditor(plan), /exact observed generation/u);
    plan.editor.submission = await observe("correct-submission", params, {
      ticket_id: "ui-v-editor",
      generation: "1",
      state: { kind: "accepted" },
      manifest: { manifest_id: "editor-delivery", revision: "1" },
    });
    assert.equal(await verifyEditor(plan), true);
    const changed = { ...plan.sources[0], sha256: "c".repeat(64) };
    plan.editor.runtimeInventory = await save("wrong-inventory.json", {
      format: "workgraph-ui-editor-runtime-inventory-1",
      source: resource,
      files: [changed],
    });
    await assert.rejects(() => verifyEditor(plan), /differs from candidate/u);
  }));

test("exit-zero Playwright controls require fresh reports and actual non-skipped cases", async () =>
  isolated(async (root) => {
    const plan = await planFor(root);
    plan.checks[0].controlIds = ["ui-independent"];
    assert.throws(() => validatePlan(plan), /require actual report verification/u);
    const base = plan.checks[0];
    const document = (skipped) => ({
      stats: { expected: skipped ? 0 : 1, skipped: skipped ? 1 : 0, unexpected: 0, flaky: 0 },
      errors: [],
      suites: [
        {
          specs: [
            {
              tests: [
                { expectedStatus: "passed", results: [{ status: skipped ? "skipped" : "passed" }] },
              ],
            },
          ],
        },
      ],
    });
    const make = (id, value, cases = 1) => {
      const path = join(root, `${id}.json`);
      return {
        ...base,
        id,
        playwright: { path, cases },
        argv: [
          process.execPath,
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], process.argv[2])",
          path,
          JSON.stringify(value),
        ],
      };
    };
    const skipped = await execute(make("skipped", document(true)), root);
    assert.equal(skipped.exitCode, 0);
    assert.equal(skipped.outcome, "failed");
    assert.match(skipped.verificationFailure, /required passing cases/u);
    const empty = await execute(
      make("empty", {
        stats: { expected: 1, skipped: 0, unexpected: 0, flaky: 0 },
        errors: [],
        suites: [],
      }),
      root,
    );
    assert.equal(empty.outcome, "failed");
    const valid = make("valid", document(false));
    const passed = await execute(valid, root);
    assert.equal(passed.outcome, "passed");
    assert.deepEqual(passed.report, await filePin(valid.playwright.path));
    await assert.rejects(() => execute({ ...valid, id: "stale" }, root), /fresh output/u);
  }));
