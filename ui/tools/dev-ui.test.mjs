import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const command = fileURLToPath(new URL("../../dev-ui", import.meta.url));
for (const args of [
  ["native", "--build-dir", "alternate"],
  ["build", "--build-dir=alternate"],
  ["native", "--build-d=alternate"],
]) {
  test(`rejects custom build directory before running ${args[0]}`, () => {
    const result = spawnSync(command, args, { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /default _build directory/);
    assert.equal(result.stdout, "");
  });
}
test("rejects environment custom build directory before executing package", () => {
  const result = spawnSync(command, ["package"], {
    encoding: "utf8",
    env: { ...process.env, DUNE_BUILD_DIR: "alternate" },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /custom DUNE_BUILD_DIR/);
  assert.equal(result.stdout, "");
});
