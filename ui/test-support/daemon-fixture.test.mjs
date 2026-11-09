import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { startDaemonFixture, fixtureBinary } from "./daemon-fixture.mjs";

test(
  "isolated real daemon seeds exact values and shuts down only its owned process",
  { timeout: 30_000 },
  async () => {
    const fixture = await startDaemonFixture({ binary: fixtureBinary() });
    try {
      const tickets = await fixture.call(
        "ticket.list",
        '{"workspace_id":"demo","project_id":"release","limit":"10"}',
      );
      for (const id of ["design", "build", "review"])
        assert.ok(tickets.includes(`"ticket_id":"${id}"`));
      const fact = await fixture.call(
        "fact.get",
        '{"workspace_id":"demo","scope":{"kind":"project","id":"release"},"key":"fixture.settings"}',
      );
      assert.match(fact, /"exact":9007199254740993/u);
      assert.match(fact, /"exponent":1e99/u);
      assert.match(fact, /"negative_zero":-0/u);
      const sessions = await fixture.call("session.list", '{"workspace_id":"demo"}');
      assert.match(sessions, /"session_id":"generic"/u);
      const resource = await fixture.call(
        "resource.get",
        '{"workspace_id":"demo","resource_id":"notes"}',
      );
      assert.match(resource, /"filename":"notes.md"/u);
    } finally {
      await fixture.dispose();
    }
    await fixture.dispose();
    await assert.rejects(access(fixture.root), { code: "ENOENT" });
    assert.throws(() => process.kill(fixture.pid, 0), { code: "ESRCH" });
    await assert.rejects(fixture.call("daemon.health", "{}"), /stopped/u);
  },
);

test(
  "independent empty daemon remains live after another fixture stops",
  { timeout: 30_000 },
  async () => {
    const first = await startDaemonFixture({ binary: fixtureBinary(), seed: false });
    let second;
    try {
      second = await startDaemonFixture({ binary: fixtureBinary(), seed: false });
      assert.notEqual(first.socket, second.socket);
      await first.dispose();
      assert.match(await second.call("daemon.health", "{}"), /"result"/u);
      assert.match(await second.call("workspace.list", "{}"), /"workspaces":\[\]/u);
    } finally {
      await first.dispose();
      await second?.dispose();
    }
  },
);

test(
  "invalid startup fails promptly without claiming a ready fixture",
  { timeout: 10_000 },
  async () => {
    await assert.rejects(startDaemonFixture({ binary: "relative" }), /absolute/u);
    await assert.rejects(
      startDaemonFixture({ binary: fixtureBinary(), startupTimeoutMs: Infinity }),
      /timeout/u,
    );
    await assert.rejects(
      startDaemonFixture({ binary: "/usr/bin/false", startupTimeoutMs: 1000 }),
      /readiness/u,
    );
  },
);

test("readiness bounds an owned CLI child that ignores SIGTERM", { timeout: 5000 }, async () => {
  const root = await mkdtemp("/tmp/wgui-cli-fault-");
  const binary = `${root}/fixture-binary`;
  const escaped = `${root}/timeout-escaped`;
  try {
    // The call branch records failure if it survives the fixture timeout. The
    // fallback exit bounds this regression itself even if production regresses.
    await writeFile(
      binary,
      `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] === "call") {
  process.on("SIGTERM", () => {});
  setTimeout(() => { fs.writeFileSync(${JSON.stringify(escaped)}, "timeout ignored"); process.exit(75); }, 1500);
} else setInterval(() => {}, 1000);
`,
    );
    await chmod(binary, 0o700);
    await assert.rejects(startDaemonFixture({ binary, startupTimeoutMs: 300 }), /readiness/u);
    await assert.rejects(access(escaped), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
