/** Actual companion metadata through production HTTP/codec and transfer-loopback processing.
 * This is not a browser Worker claim and does not execute semantic daemon mutations. */
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expandedSchema } from "./schema.mjs";
import { startCompanionFixture } from "../../../test-support/companion-fixture.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const require = createRequire(resolve(root, "ui/frontend/package.json"));
const { createServer } = require("vite");
const { Ajv2020 } = require("ajv/dist/2020.js");
const execute = promisify(execFile);
const args = process.argv.slice(2),
  options = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (!["--ui", "--daemon", "--out"].includes(args[i]) || !args[i + 1])
    throw new Error("Use --ui ABS --daemon ABS --out NEW_JSON");
  options.set(args[i], resolve(args[i + 1]));
}
for (const key of ["--ui", "--daemon", "--out"])
  if (!options.has(key)) throw new Error(`Missing ${key}`);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = {
  format: "workgraph-ui-catalog-check-1",
  processing: "production worker client/session through explicit structuredClone transfer loopback",
  started: new Date().toISOString(),
  artifacts: [],
  methods: [],
  diagnostics: null,
  failures: [],
};
let companion, vite, processing;
const sourcePaths = [];
try {
  for (const key of ["--ui", "--daemon"]) {
    const bytes = await readFile(options.get(key));
    report.artifacts.push({ path: options.get(key), sha256: hash(bytes), bytes: bytes.length });
  }
  const version = await execute(options.get("--daemon"), ["--version"]);
  report.version = version.stdout.trim();
  const metadata = await execute(options.get("--daemon"), ["methods", "--output", "json"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const descriptors = JSON.parse(metadata.stdout);
  assert.equal(descriptors.methods.length, 269);
  report.descriptorSha256 = hash(Buffer.from(metadata.stdout));
  const discovery = JSON.parse(
    (
      await execute(options.get("--daemon"), ["discover", "--catalog", "--output", "json"], {
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout,
  );
  companion = await startCompanionFixture({ binary: options.get("--ui") });
  const origin = new URL(companion.url).origin;
  const bootstrap = await fetch(companion.url),
    html = await bootstrap.text();
  assert.equal(bootstrap.status, 200);
  const capability = /<meta\s+name="workgraph-capability"\s+content="([a-f0-9]{64})"\s*\/?>/u.exec(
    html,
  )?.[1];
  assert(capability, "Native launch capability absent");
  vite = await createServer({
    root: resolve(root, "ui/frontend"),
    configFile: false,
    logLevel: "error",
    server: { middlewareMode: true, watch: { ignored: ["**/*"] } },
    appType: "custom",
  });
  const [{ createHttpClient }, { catalogCodec, methodCodec }, { createTestProcessor }, d] =
    await Promise.all([
      vite.ssrLoadModule("/src/core/protocol/http.ts"),
      vite.ssrLoadModule("/src/features/advanced/catalog.ts"),
      vite.ssrLoadModule("/tests/core/processing-harness.ts"),
      vite.ssrLoadModule("/src/core/protocol/decoders.ts"),
    ]);
  for (const module of vite.environments.ssr.moduleGraph.idToModuleMap.values())
    if (module.file?.startsWith(root + "/") && !module.file.includes("/node_modules/"))
      sourcePaths.push(module.file);
  sourcePaths.push(
    fileURLToPath(import.meta.url),
    resolve(root, "ui/tests/qualification/api/schema.mjs"),
    resolve(root, "ui/test-support/companion-fixture.mjs"),
    resolve(root, "ui/test-support/daemon-fixture.mjs"),
    resolve(root, "ui/frontend/package-lock.json"),
  );
  report.sources = [];
  for (const file of [...new Set(sourcePaths)].sort()) {
    const bytes = await readFile(file);
    report.sources.push({
      path: file.slice(root.length + 1),
      sha256: hash(bytes),
      bytes: bytes.length,
    });
  }
  processing = createTestProcessor();
  const client = createHttpClient({
    origin,
    capability,
    processing,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Origin", origin);
      return fetch(input, { ...init, headers });
    },
  });
  const catalogue = await client.request({ method: "GET", path: "/catalog", codec: catalogCodec });
  assert(catalogue.ok, JSON.stringify(catalogue));
  const native = discovery.entries
    .filter((entry) => entry.kind === "method")
    .map(({ name, effect, tier, summary }) => ({ name, mode: effect, tier, summary }));
  const sort = (values) => [...values].sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(sort(catalogue.data.methods), sort(native));
  assert.deepEqual(
    sort([...catalogue.data.helpers, ...catalogue.data.workflows]),
    sort(discovery.entries.filter((entry) => entry.kind !== "method")),
  );
  assert.deepEqual(catalogue.data.capabilities, discovery.capabilities);
  report.catalog = {
    methods: catalogue.data.methods.length,
    helpers: catalogue.data.helpers.length,
    workflows: catalogue.data.workflows.length,
  };
  for (const descriptor of descriptors.methods) {
    const capture = await client.request({
      method: "GET",
      path: `/methods/${descriptor.name}`,
      codec: methodCodec(descriptor.name),
    });
    assert(capture.ok, `${descriptor.name}: ${JSON.stringify(capture)}`);
    const value = capture.data;
    const encoded = await processing.encode(
      d.jsonObject([
        ["params", value.method.params],
        ["result", value.method.result],
        ["fields", value.fields.validation_schema],
      ]),
    );
    assert(encoded.ok && encoded.value.ok, `${descriptor.name} re-encode`);
    const result = JSON.parse(encoded.value.value);
    assert.deepEqual(
      result.params,
      descriptor.params,
      `${descriptor.name} request schema differs from paired executable`,
    );
    assert.deepEqual(
      result.result,
      descriptor.result,
      `${descriptor.name} result schema differs from paired executable`,
    );
    assert.deepEqual(
      expandedSchema(result.fields),
      expandedSchema(descriptor.params),
      `${descriptor.name} fields contract differs from request`,
    );
    assert.equal(value.method.mode, descriptor.mode);
    assert.equal(value.method.tier, descriptor.tier);
    assert(value.help.includes(descriptor.name), `${descriptor.name} missing executable help`);
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    ajv.addKeyword({
      keyword: "x-maxUtf8Bytes",
      type: "string",
      validate: (max, text) => Buffer.byteLength(text) <= max,
    });
    ajv.addKeyword({
      keyword: "x-maximumDecimal",
      type: "string",
      validate: (max, text) => /^(0|[1-9][0-9]*)$/u.test(text) && BigInt(text) <= BigInt(max),
    });
    const validate = ajv.compile(descriptor.params);
    ajv.compile(descriptor.result);
    assert.equal(
      validate({ __qualification_unknown: true }),
      false,
      `${descriptor.name} unknown request field accepted`,
    );
    const owned = await processing.parse(JSON.stringify({ ...descriptor, help: "not a contract" }));
    assert(owned.ok && owned.value.ok);
    assert.equal(
      methodCodec(descriptor.name).decode(owned.value.value.value).ok,
      false,
      "Malformed method DTO accepted",
    );
    report.methods.push({
      name: descriptor.name,
      mode: descriptor.mode,
      schema: hash(Buffer.from(JSON.stringify(result))),
      fieldCount: value.fields.fields.length,
      requestAndResponseCompiled: true,
      unknownRequestRejected: true,
      malformedContractRejected: true,
    });
  }
  const unsupported = await client.request({
    method: "GET",
    path: "/methods/qualification.not_a_method",
    codec: methodCodec("qualification.not_a_method"),
  });
  assert(
    !unsupported.ok &&
      unsupported.failure.kind === "remote" &&
      unsupported.failure.problem.kind === "Not_found",
  );
  const unauthorized = await fetch(new URL("/ui-api/v1/catalog", origin));
  assert.equal(unauthorized.status, 403);
  await unauthorized.arrayBuffer();
  const query = await fetch(new URL("/ui-api/v1/catalog?unexpected=1", origin), {
    headers: { "X-Workgraph-UI-Capability": capability, Origin: origin },
  });
  assert.equal(query.status, 400);
  await query.arrayBuffer();
  report.boundaries = { unsupportedMethod: "Not_found", missingCapability: 403, unknownQuery: 400 };
} catch (error) {
  report.failures.push(error instanceof Error ? error.stack : String(error));
} finally {
  processing?.dispose();
  for (const source of report.sources ?? []) {
    const bytes = await readFile(resolve(root, source.path));
    if (hash(bytes) !== source.sha256 || bytes.length !== source.bytes)
      report.failures.push(`Source changed during proof: ${source.path}`);
  }
  report.diagnostics = companion?.diagnostics() ?? null;
  const cleanup = await Promise.allSettled([vite?.close(), companion?.dispose()]);
  for (const result of cleanup)
    if (result.status === "rejected") report.failures.push(String(result.reason));
  report.afterCleanup = companion?.diagnostics() ?? null;
  report.finished = new Date().toISOString();
  await writeFile(options.get("--out"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
}
if (report.failures.length) {
  console.error(report.failures.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `269 native contracts, 32 catalog surfaces and explicit authorization/unknown boundaries passed; report ${options.get("--out")}`,
  );
