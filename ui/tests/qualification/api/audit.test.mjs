import { strict as assert } from "node:assert";
import { test } from "node:test";
import { audit } from "./audit.mjs";
const pin = { workspace: "proof", resource: "verified", version: "1", digest: "a".repeat(64) };
const source = [
  { path: "source.ts", sha256: "c".repeat(64), bytes: 12 },
  { path: "test.mjs", sha256: "d".repeat(64), bytes: 15 },
];
const check = {
  name: "exact read",
  behavior: "Captured identity and native response validated",
  paths: ["test.mjs"],
  coveredSources: ["source.ts"],
  evidence: [pin],
  applicability: "Same captured implementation and schema",
  verifiedSources: source.map((item) => ({ ...item })),
};
const entry = {
  name: "fact.get",
  kind: "method",
  mode: "read",
  disposition: ["tailored", "advanced"],
  userSurface: "Facts → exact key",
  source: [{ path: "source.ts", reason: "Exact captured key reader" }],
  positive: [check],
  negative: [
    {
      ...check,
      name: "wrong revision",
      behavior: "Reject foreign capture without current fallback",
    },
  ],
  primaryWorkflow: true,
  limitations: [],
};
const manifest = () =>
  structuredClone({
    format: "workgraph-ui-api-qualification-1",
    sourceVersion: "0.8.2",
    apiVersion: "0.7",
    baseline: pin,
    candidate: [{ path: "candidate/workgraph-ui", sha256: "b".repeat(64), bytes: 10 }],
    source,
    entries: [entry],
  });
const run = (value, descriptors = [{ name: "fact.get", mode: "read", params: {}, result: {} }]) =>
  audit(value, descriptors, [], [], [], new Map(source.map((item) => [item.path, item.sha256])));
test("exact complete mapping admits source and both behavioral witnesses", () =>
  assert.deepEqual(run(manifest()), []));
test("inventory omission, duplicate and unexpected entry stay distinct", () => {
  const value = manifest();
  value.entries.push({ ...entry, name: "made.up" }, entry);
  value.entries = value.entries.filter((item) => item.name !== "fact.get");
  const issues = run(value);
  assert(issues.some((item) => item.kind === "missing"));
  assert(issues.some((item) => item.kind === "unexpected"));
  value.entries.push(entry, entry);
  assert(run(value).some((item) => item.kind === "duplicate"));
});
test("primary raw/external access and vacuous behavioral declarations cannot pass", () => {
  const value = manifest();
  value.entries[0].disposition = ["advanced"];
  value.entries[0].negative = [];
  const issues = run(value);
  assert(issues.some((item) => item.kind === "contract"));
  assert(issues.some((item) => item.message.includes("negative")));
});
test("references need actual paths, exact content pins and reuse applicability", () => {
  const value = manifest();
  value.entries[0].source[0].path = "missing.ts";
  value.entries[0].positive[0].applicability = "";
  value.entries[0].positive[0].evidence[0].digest = "latest";
  const issues = run(value);
  assert(issues.some((item) => item.kind === "source"));
  assert(issues.some((item) => item.kind === "evidence"));
});
test("host boundary needs reason, matching kind and candidate identity", () => {
  const value = manifest();
  value.candidate = [];
  value.entries[0].kind = "helper";
  value.entries[0].disposition = ["host"];
  value.entries[0].primaryWorkflow = false;
  const issues = run(value);
  assert(issues.some((item) => item.entry === "candidate"));
  assert(issues.some((item) => item.message.includes("surface kind")));
  assert(issues.some((item) => item.message.includes("rationale")));
});

test("unchanged file names cannot authenticate stale behavioral evidence", () => {
  const value = manifest();
  value.entries[0].positive[0].verifiedSources[0].sha256 = "e".repeat(64);
  assert(run(value).some((item) => item.message.includes("proof source differs")));
  const current = manifest();
  current.source[0].sha256 = "e".repeat(64);
  assert(run(current).some((item) => item.message.includes("captured bytes")));
});

test("read versus mutation modes cannot be silently relabeled", () => {
  const value = manifest();
  value.entries[0].mode = "mutation";
  assert(run(value).some((item) => item.message.includes("mode differs")));
});
test("distinct proofs cover exact subsets without attributing unrelated execution", () => {
  const value = manifest();
  value.entries[0].positive[0].coveredSources = [];
  assert.deepEqual(run(value), []); // The negative boundary still exercised source.ts.
  value.entries[0].negative[0].coveredSources = [];
  assert(run(value).some((item) => item.message.includes("no behavioral source witness")));
  value.entries[0].positive[0].coveredSources = ["undeclared.ts"];
  assert(run(value).some((item) => item.message.includes("undeclared implementation")));
});
