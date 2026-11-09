/** @import { AuditManifest, Descriptor, AuditIssue } from './types.mjs' */
const digest = /^[a-f0-9]{64}$/u;
const path = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]+$/u;
const useful = (value) => typeof value === "string" && value.trim().length > 0;
const allowed = new Set(["tailored", "advanced", "native_helper", "host", "external"]);
/** @type {import('./audit.mjs').audit} */
export function audit(
  manifest,
  descriptors,
  helperNames,
  workflowNames,
  additionalNames,
  availablePaths,
) {
  /** @type {AuditIssue[]} */
  const issues = [];
  const add = (entry, kind, message) => issues.push({ entry, kind, message });
  if (manifest.format !== "workgraph-ui-api-qualification-1")
    add("manifest", "contract", "Unsupported qualification format");
  const expected = new Map();
  for (const [kind, names] of [
    ["method", descriptors.map((item) => item.name)],
    ["helper", helperNames],
    ["workflow", workflowNames],
    ["additional_local_surface", additionalNames],
  ])
    for (const name of names) {
      if (expected.has(name)) add(name, "duplicate", "Duplicate executable inventory name");
      expected.set(name, kind);
    }
  const found = new Set();
  const modes = new Map(descriptors.map((item) => [item.name, item.mode]));
  const pin = (entry, value) => {
    if (
      ![value.workspace, value.resource, value.version].every(useful) ||
      !/^[1-9][0-9]*$/u.test(value.version) ||
      !digest.test(value.digest)
    )
      add(
        entry,
        "evidence",
        "Evidence requires exact workspace, resource, positive content version and SHA256",
      );
  };
  pin("baseline", manifest.baseline);
  if (!manifest.candidate.length) add("candidate", "evidence", "No captured candidate artifacts");
  const artifacts = new Set();
  for (const item of manifest.candidate) {
    if (artifacts.has(item.path)) add(item.path, "duplicate", "Duplicate candidate artifact");
    artifacts.add(item.path);
    if (
      !path.test(item.path) ||
      !digest.test(item.sha256) ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes <= 0
    )
      add(item.path, "evidence", "Invalid candidate path/hash/size");
  }
  const source = new Map();
  for (const item of manifest.source) {
    if (source.has(item.path)) add(item.path, "duplicate", "Duplicate source inventory member");
    source.set(item.path, item);
    if (
      !path.test(item.path) ||
      !digest.test(item.sha256) ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes <= 0 ||
      availablePaths.get(item.path) !== item.sha256
    )
      add(item.path, "source", "Source inventory does not match captured bytes");
  }
  for (const entry of manifest.entries) {
    if (found.has(entry.name)) add(entry.name, "duplicate", "Duplicate disposition");
    found.add(entry.name);
    if (!expected.has(entry.name))
      add(entry.name, "unexpected", "Not in exact executable inventory");
    else if (expected.get(entry.name) !== entry.kind)
      add(entry.name, "contract", "Wrong surface kind");
    if (
      (entry.kind === "method" && entry.mode !== modes.get(entry.name)) ||
      (entry.kind !== "method" && entry.mode !== undefined)
    )
      add(entry.name, "contract", "Disposition mode differs from exact descriptor domain");
    if (
      !entry.disposition.length ||
      entry.disposition.some((item) => !allowed.has(item)) ||
      new Set(entry.disposition).size !== entry.disposition.length
    )
      add(entry.name, "contract", "Missing, repeated or unsupported disposition");
    if (
      entry.primaryWorkflow &&
      !entry.disposition.includes("tailored") &&
      !entry.disposition.includes("native_helper")
    )
      add(entry.name, "contract", "Primary workflow cannot be raw-console-only or external-only");
    if (!useful(entry.userSurface)) add(entry.name, "source", "Missing actual user access");
    if (
      entry.disposition.some((item) => item === "external" || item === "host") &&
      !entry.limitations.some(useful)
    )
      add(
        entry.name,
        "contract",
        "Host/external disposition requires explicit rationale and boundary",
      );
    if (!entry.source.length) add(entry.name, "source", "No reviewed implementation source");
    for (const witness of entry.source)
      if (!path.test(witness.path) || !source.has(witness.path) || !useful(witness.reason))
        add(entry.name, "source", `Missing or unexplained source: ${witness.path}`);
    const covered = new Set();
    for (const polarity of ["positive", "negative"])
      if (!entry[polarity].length) add(entry.name, "evidence", `No ${polarity} behavioral check`);
      else
        for (const witness of entry[polarity]) {
          if (
            ![witness.name, witness.behavior, witness.applicability].every(useful) ||
            !witness.paths.length ||
            !witness.evidence.length
          )
            add(entry.name, "evidence", `Incomplete ${polarity} behavioral witness`);
          for (const source of witness.paths)
            if (!path.test(source) || !manifest.source.some((item) => item.path === source))
              add(entry.name, "source", `Missing test: ${source}`);
          for (const evidence of witness.evidence) pin(entry.name, evidence);
          const verified = new Map(witness.verifiedSources.map((item) => [item.path, item]));
          for (const dependency of witness.coveredSources) {
            if (!entry.source.some((item) => item.path === dependency))
              add(entry.name, "source", `Proof covers an undeclared implementation: ${dependency}`);
            covered.add(dependency);
          }
          for (const required of [...witness.coveredSources, ...witness.paths]) {
            const actual = source.get(required),
              previous = verified.get(required);
            if (
              !actual ||
              !previous ||
              actual.sha256 !== previous.sha256 ||
              actual.bytes !== previous.bytes
            )
              add(
                entry.name,
                "evidence",
                `Behavioral proof source differs or is absent: ${required}`,
              );
          }
        }
    for (const dependency of entry.source)
      if (!covered.has(dependency.path))
        add(
          entry.name,
          "evidence",
          `Implementation has no behavioral source witness: ${dependency.path}`,
        );
  }
  for (const name of expected.keys())
    if (!found.has(name)) add(name, "missing", "Executable entry lacks a disposition");
  return issues;
}
