/** Read-only integrity verifier for explicit captured files. No Workgraph writes or discovery. */
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { audit } from "./audit.mjs";
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (
    ![
      "--manifest",
      "--descriptors",
      "--catalogue",
      "--additional",
      "--baseline",
      "--source-root",
      "--artifact-root",
      "--out",
    ].includes(process.argv[i]) ||
    !process.argv[i + 1]
  )
    throw new Error(
      "Expected explicit manifest, metadata, baseline, source/artifact roots and new output path",
    );
  options.set(process.argv[i], process.argv[i + 1]);
}
for (const key of [
  "--manifest",
  "--descriptors",
  "--catalogue",
  "--additional",
  "--baseline",
  "--source-root",
  "--artifact-root",
  "--out",
])
  if (!options.has(key)) throw new Error(`Missing ${key}`);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const input = {};
for (const key of ["--manifest", "--descriptors", "--catalogue", "--additional", "--baseline"]) {
  const bytes = await readFile(options.get(key));
  input[key] = {
    path: options.get(key),
    sha256: digest(bytes),
    bytes: bytes.length,
    value: JSON.parse(bytes),
  };
}
const manifest = input["--manifest"].value,
  issues = [];
if (input["--baseline"].sha256 !== manifest.baseline.digest)
  issues.push({
    entry: "baseline",
    kind: "evidence",
    message: "Actual baseline bytes differ from manifest pin",
  });
const actual = new Map();
for (const [key, inventory] of [
  ["--source-root", manifest.source],
  ["--artifact-root", manifest.candidate],
]) {
  const root = await realpath(options.get(key));
  for (const item of inventory) {
    try {
      if (
        typeof item.path !== "string" ||
        item.path.startsWith("/") ||
        item.path.split("/").some((part) => part === ".." || part === ".") ||
        item.path.includes("\0")
      )
        throw new Error("Invalid relative member path");
      const path = await realpath(resolve(root, item.path));
      if (!path.startsWith(root + sep))
        throw new Error("Member resolves outside the explicit captured root");
      const bytes = await readFile(path),
        hash = digest(bytes);
      if (key === "--source-root") actual.set(item.path, hash);
      if (hash !== item.sha256 || bytes.length !== item.bytes)
        throw new Error("Actual member bytes differ from declared hash/size");
    } catch (error) {
      issues.push({
        entry: item.path,
        kind: key === "--source-root" ? "source" : "evidence",
        message: String(error),
      });
    }
  }
}
issues.push(
  ...audit(
    manifest,
    input["--descriptors"].value.methods,
    input["--catalogue"].value.entries
      .filter((item) => item.kind === "helper")
      .map((item) => item.name),
    input["--catalogue"].value.entries
      .filter((item) => item.kind === "workflow")
      .map((item) => item.name),
    input["--additional"].value,
    actual,
  ),
);
const report = {
  format: "workgraph-ui-api-integrity-result-1",
  inputs: Object.fromEntries(
    Object.entries(input).map(([key, { value: _value, ...pin }]) => [key, pin]),
  ),
  entries: manifest.entries.length,
  issues,
  passed: issues.length === 0,
  scope:
    "Integrity only. Referenced behavioral evidence must be independently verified; this tool does not manufacture passed checks.",
};
await writeFile(options.get("--out"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(
  `${report.entries} dispositions: ${issues.length} integrity issues; ${options.get("--out")}`,
);
if (issues.length) process.exitCode = 1;
