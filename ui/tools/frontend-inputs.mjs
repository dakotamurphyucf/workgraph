import { readFileSync, readdirSync, lstatSync, existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export function regularFilesUnder(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  function walk(current) {
    for (const name of readdirSync(current).sort()) {
      const file = path.join(current, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`Symlink is not a build input: ${file}`);
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) files.push(file);
      else throw new Error(`Nonregular build input: ${file}`);
    }
  }
  walk(dir);
  return files;
}

export function frontendInputHash(projectRoot) {
  const frontend = path.join(projectRoot, "ui/frontend");
  const tools = path.join(projectRoot, "ui/tools");
  const output = path.join(tools, "embedded");
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const fixed = [
    "package.json",
    "package-lock.json",
    "index.html",
    "tsconfig.json",
    "vite.config.ts",
  ].map((name) => path.join(frontend, name));
  const source = [
    ...fixed,
    ...regularFilesUnder(path.join(frontend, "src")),
    ...regularFilesUnder(path.join(frontend, "public")),
    ...regularFilesUnder(tools).filter((file) => !file.startsWith(output + path.sep)),
  ];
  const identities = source.sort().map((file) => ({
    path: path.relative(projectRoot, file).split(path.sep).join("/"),
    sha256: sha256(readFileSync(file)),
  }));
  return sha256(JSON.stringify(identities));
}

export function readBuildStamp(projectRoot) {
  const file = path.join(projectRoot, "ui/frontend/dist/.vite/workgraph-build.json");
  if (!existsSync(file)) throw new Error("Vite build input stamp missing; run ./dev-ui frontend");
  const stamp = JSON.parse(readFileSync(file, "utf8"));
  if (
    !stamp ||
    typeof stamp !== "object" ||
    Array.isArray(stamp) ||
    Object.keys(stamp).sort().join(",") !== "input_sha256,schema_version" ||
    stamp.schema_version !== 1 ||
    typeof stamp.input_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(stamp.input_sha256)
  )
    throw new Error("Invalid Vite build input stamp; run ./dev-ui frontend");
  if (stamp.input_sha256 !== frontendInputHash(projectRoot))
    throw new Error(
      "Stale Vite build inputs: source changed after build; rebuild with ./dev-ui frontend before embedding",
    );
  return stamp;
}
