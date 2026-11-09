import { spawn } from "node:child_process";
import { lstat, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { finished } from "node:stream/promises";
import {
  filePin,
  scenarioResults,
  validatePlan,
  verifyEditor,
  verifyPins,
  verifyPlaywrightReport,
} from "./audit.mjs";

/** Each command owns its process group. Cleanup never signals the invoking agent.
 * @param {number} pid @param {NodeJS.Signals} signal
 */
function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

/** @param {import('./types.d.mts').CheckPlan} check @param {string} output */
export async function execute(check, output) {
  if (check.playwright !== undefined) {
    try {
      await lstat(check.playwright.path);
      throw new Error("Playwright report must be a fresh output");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  const path = resolve(output, `${check.id}.log`);
  // Admission of the log must succeed before any test side effects begin.
  const handle = await open(path, "wx", 0o600);
  const log = handle.createWriteStream();
  const logFinished = finished(log).then(
    () => null,
    (error) => error,
  );
  const started = performance.now();
  /** @type {import('./types.d.mts').CheckResult['outcome']} */
  let outcome = "failed";
  /** @type {number | null} */
  let exitCode = null;
  /** @type {NodeJS.Signals | null} */
  let signal = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let force;
  /** @type {unknown[]} */
  const cleanupErrors = [];
  /** @type {ReturnType<typeof spawn> & { stdout: import('node:stream').Readable; stderr: import('node:stream').Readable }} */
  let child;
  try {
    child = spawn(check.argv[0], check.argv.slice(1), {
      cwd: check.cwd,
      env: { ...process.env, ...check.environment },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    log.end();
    const loggingFailure = await logFinished;
    if (loggingFailure !== null)
      throw new AggregateError([error, loggingFailure], "Spawn and log completion failed");
    throw error;
  }
  /** @param {NodeJS.Signals} termination */
  const stop = (termination) => {
    if (child.pid === undefined) return;
    try {
      signalGroup(child.pid, termination);
    } catch (error) {
      cleanupErrors.push(error);
      try {
        child.kill(termination);
      } catch (fallback) {
        cleanupErrors.push(fallback);
      }
    }
  };
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    stop("SIGTERM");
    force = setTimeout(() => {
      stop("SIGKILL");
    }, 2_000);
  }, check.timeoutMs);
  let bodyFailed = false;
  /** @type {unknown} */
  let bodyError;
  try {
    await new Promise((done) => {
      child.once("error", (error) => {
        outcome = "spawn_failed";
        log.write(`${error.stack ?? error.message}\n`);
      });
      child.once("close", (code, termination) => {
        exitCode = code;
        signal = termination;
        if (outcome !== "spawn_failed")
          outcome = timedOut ? "timed_out" : code === 0 ? "passed" : "failed";
        done(undefined);
      });
    });
  } catch (error) {
    bodyFailed = true;
    bodyError = error;
  } finally {
    clearTimeout(timeout);
    clearTimeout(force);
    // A test fixture must clean itself up; this bounds any surviving owned child
    // even when the test command crashes or exits before its finally handler.
    stop("SIGKILL");
    if (!log.destroyed) log.end();
    const loggingFailure = await logFinished;
    if (loggingFailure !== null) cleanupErrors.push(loggingFailure);
  }
  if (bodyFailed || cleanupErrors.length !== 0) {
    const errors = bodyFailed ? [bodyError, ...cleanupErrors] : cleanupErrors;
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, "Recovery check failed with cleanup diagnostics");
  }
  /** @type {import('./types.d.mts').SourcePin | null} */
  let report = null;
  let verificationFailure = null;
  // The close handler above owns this value; TypeScript does not track callback assignments.
  const completedOutcome = /** @type {import('./types.d.mts').CheckResult['outcome']} */ (outcome);
  if (completedOutcome === "passed" && check.playwright !== undefined) {
    try {
      report = await verifyPlaywrightReport(check.playwright.path, check.playwright.cases);
    } catch (error) {
      outcome = "failed";
      verificationFailure = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    id: check.id,
    controls: check.controlIds,
    argv: check.argv,
    cwd: check.cwd,
    environment: check.environment,
    elapsedMs: Math.round(performance.now() - started),
    outcome,
    exitCode,
    signal,
    log: await filePin(path),
    report,
    verificationFailure,
  };
}

/** The plan is authored qualification JSON, not an arbitrary Workgraph value.
 * Source/native responses still use their production lossless codecs in tests.
 * @param {string} planPath @param {string} output
 */
export async function run(planPath, output) {
  const originalPlan = await filePin(planPath);
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  validatePlan(plan);
  await mkdir(output, { recursive: false, mode: 0o700 });
  /** @type {import('./types.d.mts').CheckResult[]} */
  const results = [];
  let editorAccepted = false;
  let unchanged = true;
  /** @type {string | null} */
  let failure = null;
  try {
    editorAccepted = await verifyEditor(plan);
    for (const check of plan.checks) {
      await verifyPins([originalPlan], "/");
      await verifyPins(plan.sources, plan.sourceRoot);
      await verifyPins(plan.candidate, plan.sourceRoot);
      results.push(await execute(check, output));
      await verifyPins([originalPlan], "/");
      await verifyPins(plan.sources, plan.sourceRoot);
      await verifyPins(plan.candidate, plan.sourceRoot);
      editorAccepted = await verifyEditor(plan);
    }
  } catch (error) {
    unchanged = false;
    failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }
  const scenarios = scenarioResults(plan.matrix, results);
  const readyForReview =
    unchanged &&
    editorAccepted &&
    results.length === plan.checks.length &&
    results.every((check) => check.outcome === "passed") &&
    scenarios
      .filter((scenario) => scenario.scope === "recovery_replay")
      .every((scenario) => scenario.replayComplete);
  const report = {
    format: "workgraph-ui-recovery-result-1",
    plan: originalPlan,
    candidate: plan.candidate,
    sources: plan.sources,
    results,
    unchanged,
    editorAccepted,
    editor: plan.editor,
    readyForReview,
    scenarios,
    failure,
  };
  await writeFile(resolve(output, "result.json"), JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
  });
  return report;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , plan, output] = process.argv;
  if (plan === undefined || output === undefined)
    throw new Error("Usage: node run.mjs ABSOLUTE_PLAN ABSOLUTE_NEW_OUTPUT");
  const result = await run(resolve(plan), resolve(output));
  process.stdout.write(
    JSON.stringify({
      results: result.results.map(({ id, outcome }) => ({ id, outcome })),
      unchanged: result.unchanged,
      editorAccepted: result.editorAccepted,
      readyForReview: result.readyForReview,
    }) + "\n",
  );
  if (!result.readyForReview) process.exitCode = 1;
}
