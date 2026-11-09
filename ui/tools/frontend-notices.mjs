import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tools = path.dirname(fileURLToPath(import.meta.url));
const defaultFrontend = path.resolve(tools, "../frontend");
const permitted = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD"]);
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
function resolvePackage(name, from, frontend) {
  for (let dir = from; dir.startsWith(frontend); dir = path.dirname(dir)) {
    const file = path.join(dir, "node_modules", name, "package.json");
    if (existsSync(file)) return file;
    if (dir === frontend) break;
  }
  throw new Error(`Cannot resolve license for ${name} from ${from}`);
}
export function createNotices(frontend = defaultFrontend) {
  const main = readJson(path.join(frontend, "package.json"));
  const pending = Object.keys(main.dependencies).map((name) => [name, frontend]);
  // Vite contributes the generated modulepreload helper to production output.
  pending.push(["vite", frontend]);
  const packages = new Map();
  while (pending.length) {
    const [name, from] = pending.pop();
    const file = resolvePackage(name, from, frontend);
    const info = readJson(file);
    const identity = `${info.name}@${info.version}`;
    if (packages.has(identity)) continue;
    if (!permitted.has(info.license))
      throw new Error(`Review required for ${identity} license ${info.license}`);
    const dir = path.dirname(file);
    const files = readdirSync(dir)
      .filter((entry) => /^(licen[cs]e|copying|notice)([.-].*)?$/i.test(entry))
      .sort();
    if (!files.length) throw new Error(`Missing license text for ${identity}`);
    const text = files
      .map((entry) => `${entry}\n${readFileSync(path.join(dir, entry), "utf8").trim()}\n`)
      .join("\n");
    packages.set(identity, {
      name: info.name,
      version: info.version,
      license: info.license,
      text,
    });
    // Only runtime dependencies ship. Vite itself is included for its helper,
    // without recursively classifying its build-only dependencies as runtime.
    if (name !== "vite") {
      for (const dep of Object.keys(info.dependencies ?? {})) pending.push([dep, dir]);
    }
  }
  const inventory = [...packages.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : 1,
  );
  const text =
    "Workgraph UI browser asset notices\n\nWorkgraph first-party source: MIT (repository LICENSE).\n\n" +
    inventory
      .map((p) => `${p.name}@${p.version} — ${p.license}\n${"=".repeat(64)}\n${p.text}`)
      .join("\n");
  return {
    text,
    inventory: inventory.map(({ name, version, license }) => ({
      name,
      version,
      license,
    })),
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = path.join(tools, "embedded/frontend-notices.txt");
  mkdirSync(path.dirname(output), { recursive: true });
  const notices = createNotices();
  writeFileSync(output, notices.text);
  console.log(`${notices.inventory.length} runtime/helper license texts: ${output}`);
}
