import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const pinned = JSON.parse(readFileSync(new URL("./toolchain.json", import.meta.url), "utf8"));
const actual = {
  node: process.versions.node,
  npm: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
};
for (const name of ["node", "npm"]) {
  if (actual[name] !== pinned[name]) {
    throw new Error(
      `UI builder ${name} must be ${pinned[name]}; found ${actual[name]}. Use a private matching builder; do not change global defaults.`,
    );
  }
}
console.log(`UI builder Node ${actual.node}; npm ${actual.npm}`);
