import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";

// Test-only dependency, resolved from the pinned frontend package rather than a
// root/global node_modules. Fixed readiness metadata is not daemon payload JSON.
const { parseTree } = createRequire(new URL("../frontend/package.json", import.meta.url))(
  "jsonc-parser",
);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha256 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const readyKeys = new Set([
  "format",
  "event",
  "url",
  "state_root",
  "asset_manifest_sha256",
  "api_prefix",
  "host",
  "port",
]);

export function companionBinary() {
  return (
    process.env.WORKGRAPH_UI_TEST_BINARY ??
    path.join(repository, "_build/default/ui/companion/bin/main.exe")
  );
}

export function decodeReady(bytes, expectedRoot) {
  if (bytes.byteLength === 0 || bytes.byteLength > 65536)
    throw new Error("Companion readiness exceeds its 64KiB metadata bound.");
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (source.startsWith("\uFEFF")) throw new Error("Companion readiness must not contain a BOM.");
  const errors = [];
  const tree = parseTree(source, errors, {
    disallowComments: true,
    allowTrailingComma: false,
    allowEmptyContent: false,
  });
  if (errors.length || tree?.type !== "object")
    throw new Error("Companion readiness must be one strict JSON object.");
  const fields = new Map();
  for (const property of tree.children ?? []) {
    const [name, value] = property.children ?? [];
    if (
      name?.type !== "string" ||
      value?.type !== "string" ||
      !readyKeys.has(name.value) ||
      fields.has(name.value) ||
      Buffer.from(value.value, "utf8").toString("utf8") !== value.value
    )
      throw new Error("Companion readiness has duplicate, unknown or invalid fields.");
    fields.set(name.value, value.value);
  }
  if (fields.size !== readyKeys.size)
    throw new Error("Companion readiness is missing required fields.");
  const ready = Object.fromEntries(fields);
  if (
    ready.format !== "workgraph-ui-ready-1" ||
    ready.event !== "ready" ||
    ready.api_prefix !== "/ui-api/v1" ||
    ready.state_root !== expectedRoot ||
    !sha256(ready.asset_manifest_sha256) ||
    !["127.0.0.1", "::1"].includes(ready.host) ||
    !/^[1-9][0-9]{0,4}$/u.test(ready.port) ||
    Number(ready.port) > 65535
  )
    throw new Error("Companion readiness does not describe the owned loopback service.");
  const authority = ready.host === "::1" ? "[::1]" : ready.host;
  if (ready.url !== `http://${authority}:${ready.port}/`)
    throw new Error("Companion readiness URL does not match its exact host and port.");
  return Object.freeze(ready);
}

export async function startCompanionFixture(options) {
  const { binary, host = "127.0.0.1", startupTimeoutMs = 10000 } = options;
  if (!path.isAbsolute(binary)) throw new Error("Companion binary must be absolute.");
  if (!["127.0.0.1", "::1"].includes(host)) throw new Error("Fixture host must be loopback.");
  if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1 || startupTimeoutMs > 60000)
    throw new Error("Invalid companion startup timeout.");
  for (const pin of [options.expectedBinarySha256, options.expectedManifestSha256])
    if (pin !== undefined && !sha256(pin)) throw new Error("Invalid fixture SHA256 pin.");
  await access(binary, constants.X_OK);
  const binarySha256 = digest(await readFile(binary));
  if (options.expectedBinarySha256 !== undefined && options.expectedBinarySha256 !== binarySha256)
    throw new Error("Companion executable does not match its qualification pin.");
  const root = await realpath(await mkdtemp("/tmp/wgui-ui-"));
  const startedAt = new Date().toISOString();
  let disposeStartedAt = null;
  let exit = null;
  let stdoutTail = Buffer.alloc(0);
  let stderrTail = Buffer.alloc(0);
  const child = spawn(binary, ["--state-root", root, "--host", host, "--no-open"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let exited = false;
  let diagnostics = Buffer.alloc(0);
  child.stdout.on("data", (bytes) => {
    stdoutTail = Buffer.concat([stdoutTail, bytes]).subarray(-65536);
  });
  child.stderr.on("data", (bytes) => {
    stderrTail = Buffer.concat([stderrTail, bytes]).subarray(-65536);
  });
  const append = (bytes) => {
    diagnostics = Buffer.concat([diagnostics, bytes]).subarray(-65536);
  };
  child.stderr.on("data", append);
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      exited = true;
      exit = Object.freeze({ at: new Date().toISOString(), code, signal });
      resolve({ code, signal });
    });
  });
  let cleanup;
  const dispose = () => {
    if (cleanup) return cleanup;
    disposeStartedAt = new Date().toISOString();
    cleanup = (async () => {
      if (!exited) {
        child.kill("SIGTERM");
        if (!(await Promise.race([closed.then(() => true), delay(3000, false, { ref: false })]))) {
          child.kill("SIGKILL");
          if (!(await Promise.race([closed.then(() => true), delay(5000, false, { ref: false })])))
            throw new Error(`Companion did not stop; retained private fixture root ${root}`);
        }
      }
      await rm(root, { recursive: true, force: true });
    })();
    return cleanup;
  };
  let timer;
  try {
    const ready = await new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      timer = setTimeout(
        () => fail(new Error("Companion readiness deadline exceeded.")),
        startupTimeoutMs,
      );
      child.once("error", fail);
      closed.then(() =>
        fail(new Error(`Companion exited before readiness: ${diagnostics.toString("utf8")}`)),
      );
      child.stdout.once("end", () => fail(new Error("Companion closed stdout before readiness.")));
      child.stdout.on("data", (bytes) => {
        if (settled) {
          append(bytes);
          return;
        }
        const newline = bytes.indexOf(10);
        const prefix = newline < 0 ? bytes : bytes.subarray(0, newline);
        if (buffer.length + prefix.length > 65536) {
          fail(new Error("Companion readiness exceeds its 64KiB metadata bound."));
          return;
        }
        buffer = Buffer.concat([buffer, prefix]);
        if (newline < 0) return;
        try {
          const ready = decodeReady(buffer, root);
          if (ready.host !== host)
            throw new Error("Companion readiness changed the requested host.");
          if (
            options.expectedManifestSha256 !== undefined &&
            ready.asset_manifest_sha256 !== options.expectedManifestSha256
          )
            throw new Error("Companion asset manifest does not match its qualification pin.");
          settled = true;
          resolve(ready);
        } catch (error) {
          fail(error);
        }
      });
    });
    if (child.pid === undefined || exited) throw new Error("Companion has no live owned child.");
    if (digest(await readFile(binary)) !== binarySha256)
      throw new Error(
        "Companion executable changed during fixture startup; rebuild in a quiet window.",
      );
    return Object.freeze({
      binary,
      binarySha256,
      root,
      pid: child.pid,
      ready,
      url: ready.url,
      diagnostics: () =>
        Object.freeze({
          capturedAt: new Date().toISOString(),
          startedAt,
          disposeStartedAt,
          exit,
          stdoutTail: stdoutTail.toString("utf8"),
          stderrTail: stderrTail.toString("utf8"),
        }),
      dispose,
    });
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Companion startup and cleanup failed.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
