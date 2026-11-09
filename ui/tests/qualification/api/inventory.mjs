/** Offline descriptor drift report. It compares contracts; it does not claim UI behavior. */
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
const execute = promisify(execFile),
  options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (
    !["--baseline", "--baseline-sha256", "--daemon", "--out"].includes(process.argv[i]) ||
    !process.argv[i + 1]
  )
    throw new Error("Use --baseline FILE --baseline-sha256 HEX --daemon ABS --out NEW_JSON");
  options.set(process.argv[i], process.argv[i + 1]);
}
for (const key of ["--baseline", "--baseline-sha256", "--daemon", "--out"])
  if (!options.has(key)) throw new Error(`Missing ${key}`);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const baselineBytes = await readFile(options.get("--baseline"));
assert.equal(
  sha(baselineBytes),
  options.get("--baseline-sha256"),
  "Baseline bytes differ from the explicit reviewed pin",
);
const baseline = JSON.parse(baselineBytes);
const binary = await readFile(options.get("--daemon"));
const version = (await execute(options.get("--daemon"), ["--version"])).stdout.trim();
const methodsBytes = (
  await execute(options.get("--daemon"), ["methods", "--output", "json"], {
    maxBuffer: 64 * 1024 * 1024,
  })
).stdout;
const catalogueBytes = (
  await execute(options.get("--daemon"), ["discover", "--catalog", "--output", "json"], {
    maxBuffer: 4 * 1024 * 1024,
  })
).stdout;
const current = JSON.parse(methodsBytes),
  catalogue = JSON.parse(catalogueBytes);
const unique = (rows) => {
  const names = rows.map((item) => item.name);
  assert.equal(new Set(names).size, names.length);
  return names.sort();
};
assert.deepEqual(unique(current.methods), unique(baseline.methods));
assert.equal(current.methods.length, 269);
for (const kind of ["helper", "workflow"])
  assert.deepEqual(
    unique(catalogue.entries.filter((item) => item.kind === kind)),
    unique(baseline.local_surfaces.filter((item) => item.kind === kind)),
  );
assert.equal(baseline.local_surfaces.length, 44);
const previous = new Map(baseline.methods.map((item) => [item.name, item]));
const methods = current.methods.map((item) => {
  const old = previous.get(item.name);
  return {
    name: item.name,
    mode: item.mode,
    modeChanged: old.mode !== item.mode,
    requestChanged: !isEqual(old.request_schema, item.params),
    responseChanged: !isEqual(old.result_schema, item.result),
    requestSha256: sha(JSON.stringify(item.params)),
    responseSha256: sha(JSON.stringify(item.result)),
  };
});
assert(
  methods.every((item) => !item.modeChanged),
  "Mode changes require explicit review",
);
const surfaces = [];
for (const item of baseline.local_surfaces.filter(
  (entry) => entry.kind === "helper" || entry.kind === "workflow",
)) {
  const help = (
    await execute(options.get("--daemon"), ["help", item.name], { maxBuffer: 2 * 1024 * 1024 })
  ).stdout;
  assert(
    help.trim().length > 0 && Buffer.byteLength(help) <= 65536,
    `Missing or oversized executable helper guidance ${item.name}`,
  );
  surfaces.push({
    name: item.name,
    kind: item.kind,
    helpChanged: help !== item.contract_help,
    helpSha256: sha(help),
    help,
    bytes: Buffer.byteLength(help),
  });
}
const report = {
  format: "workgraph-ui-api-inventory-drift-1",
  version,
  binary: { path: options.get("--daemon"), sha256: sha(binary), bytes: binary.length },
  baseline: { path: options.get("--baseline"), digest: sha(baselineBytes) },
  currentMetadata: { methodsSha256: sha(methodsBytes), catalogueSha256: sha(catalogueBytes) },
  methods,
  surfaces,
  additional: baseline.local_surfaces
    .filter((item) => item.kind === "additional_local_surface")
    .map((item) => item.name),
};
await writeFile(options.get("--out"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(
  JSON.stringify({
    methods: methods.length,
    changed: methods
      .filter((item) => item.requestChanged || item.responseChanged)
      .map((item) => item.name),
    helperOrRecipeHelpChanged: surfaces.filter((item) => item.helpChanged).map((item) => item.name),
    additional: report.additional.length,
  }),
);
function isEqual(left, right) {
  try {
    assert.deepEqual(left, right);
    return true;
  } catch (error) {
    if (error?.code === "ERR_ASSERTION") return false;
    throw error;
  }
}
