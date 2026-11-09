import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { companionBinary, decodeReady, startCompanionFixture } from "./companion-fixture.mjs";

const record = (overrides = {}) => ({
  format: "workgraph-ui-ready-1",
  event: "ready",
  url: "http://127.0.0.1:1234/",
  state_root: "/owned",
  asset_manifest_sha256: "a".repeat(64),
  api_prefix: "/ui-api/v1",
  host: "127.0.0.1",
  port: "1234",
  ...overrides,
});
const bytes = (value) => Buffer.from(JSON.stringify(value));
const absent = async (file) => assert.rejects(access(file), { code: "ENOENT" });

test("readiness is strict bounded metadata with exact loopback authority", () => {
  assert.equal(decodeReady(bytes(record()), "/owned").port, "1234");
  assert.equal(
    decodeReady(bytes(record({ host: "::1", url: "http://[::1]:1234/" })), "/owned").host,
    "::1",
  );
  for (const invalid of [
    record({ port: "0" }),
    record({ port: "01234" }),
    record({ port: "65536" }),
    record({ host: "localhost" }),
    record({ url: "http://foreign:1234/" }),
    record({ state_root: "/someone-else" }),
    record({ port: 1234 }),
    record({ extra: "field" }),
    record({ format: "other" }),
    record({ event: "later" }),
    record({ asset_manifest_sha256: "no" }),
    record({ state_root: "\ud800" }),
  ])
    assert.throws(() => decodeReady(bytes(invalid), "/owned"));
  for (const invalid of [
    '{"format":"workgraph-ui-ready-1","format":"workgraph-ui-ready-1"}',
    JSON.stringify(record()).replace('"event":', '"\\u0065vent":"ready","event":'),
    JSON.stringify(record()) + "{}",
    "[]",
    "{}",
    "//comment\n" + JSON.stringify(record()),
    JSON.stringify(record()).replace(/}$/, ",}"),
  ])
    assert.throws(() => decodeReady(Buffer.from(invalid), "/owned"));
  assert.throws(() => decodeReady(Buffer.from([0xff]), "/owned"));
  assert.throws(() =>
    decodeReady(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(record())]), "/owned"),
  );
  assert.throws(() => decodeReady(Buffer.alloc(65537), "/owned"));
});

test("real companion owns separate empty state, verifies pins, and disposes idempotently", async () => {
  const a = await startCompanionFixture({ binary: companionBinary() });
  let b;
  try {
    b = await startCompanionFixture({
      binary: companionBinary(),
      expectedBinarySha256: a.binarySha256,
      expectedManifestSha256: a.ready.asset_manifest_sha256,
    });
    assert.notEqual(a.root, b.root);
    assert.notEqual(a.pid, b.pid);
    assert.notEqual(a.url, b.url);
    const index = await fetch(a.url).then((r) => r.text());
    const capability = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(index)?.[1];
    assert.ok(capability);
    const response = await fetch(new URL("ui-api/v1/connections", a.url), {
      headers: { "X-Workgraph-UI-Capability": capability },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, data: { items: [] } });
  } finally {
    await Promise.all([a.dispose(), a.dispose(), b?.dispose()]);
  }
  await absent(a.root);
  if (b) await absent(b.root);
  assert.throws(() => process.kill(a.pid, 0), { code: "ESRCH" });
});

test("rejects a changed binary before launching a service", async () => {
  await assert.rejects(startCompanionFixture({ binary: "relative" }), /absolute/);
  await assert.rejects(
    startCompanionFixture({ binary: companionBinary(), expectedBinarySha256: "0".repeat(64) }),
    /qualification pin/,
  );
});

test("startup faults stop only the owned child and remove private state", async () => {
  const helpers = await mkdtemp("/tmp/wgui-helper-");
  try {
    for (const [name, body] of [
      ["early", "process.exit(7)"],
      ["missing-newline", 'process.stdout.write("{}"); setInterval(()=>{},1000)'],
      ["oversized", 'process.stdout.write("x".repeat(65537)); setInterval(()=>{},1000)'],
      ["malformed", 'console.log("{}"); setInterval(()=>{},1000)'],
      ["ignores-term", 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'],
      [
        "changed-binary",
        `fs.appendFileSync(process.argv[1], "\\n// changed"); console.log(JSON.stringify({format:"workgraph-ui-ready-1",event:"ready",url:"http://127.0.0.1:1234/",state_root:process.argv[3],asset_manifest_sha256:"a".repeat(64),api_prefix:"/ui-api/v1",host:"127.0.0.1",port:"1234"})); setInterval(()=>{},1000)`,
      ],
    ]) {
      const helper = path.join(helpers, name);
      const marker = path.join(helpers, `${name}.root`);
      await writeFile(
        helper,
        `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, process.argv[3]);\n${body}\n`,
        { mode: 0o700 },
      );
      await assert.rejects(
        startCompanionFixture({ binary: helper, startupTimeoutMs: 300 }),
        name === "changed-binary"
          ? /changed during fixture startup/
          : name === "ignores-term" || name === "missing-newline"
            ? /deadline/
            : undefined,
      );
      const ownedRoot = await readFile(marker, "utf8");
      await absent(ownedRoot);
    }
    await assert.rejects(
      startCompanionFixture({ binary: companionBinary(), expectedManifestSha256: "0".repeat(64) }),
      /manifest/,
    );
  } finally {
    await rm(helpers, { recursive: true, force: true });
  }
});
