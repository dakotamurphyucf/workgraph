import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createEmbeddedAssets, checkOrWrite, frontendInputHash } from "./embed-assets.mjs";

function fixture(t) {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "workgraph-assets-"));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  function put(name, bytes) {
    const file = path.join(projectRoot, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    return file;
  }
  for (const name of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vite.config.ts",
    "index.html",
  ])
    put(
      "ui/frontend/" + name,
      name.endsWith("json") ? '{"version":"0.7.0","dependencies":{"sample":"1.0.0"}}' : "fixture",
    );
  put("ui/tools/toolchain.json", '{"node":"22.14.0","npm":"10.9.2"}');
  put("ui/frontend/src/main.tsx", "export {};\n");
  put(
    "ui/frontend/dist/index.html",
    '<meta name="workgraph-capability" content="__WORKGRAPH_UI_CAPABILITY__"><script type="module" src="/assets/main.js"></script>',
  );
  put("ui/frontend/dist/assets/main.js", 'console.log("fixture");\n');
  for (const name of ["sample", "vite"]) {
    put(
      `ui/frontend/node_modules/${name}/package.json`,
      JSON.stringify({ name, version: "1.0.0", license: "MIT" }),
    );
    put(`ui/frontend/node_modules/${name}/LICENSE`, `MIT license fixture ${name}\n`);
  }
  function stamp() {
    put(
      "ui/frontend/dist/.vite/workgraph-build.json",
      JSON.stringify({
        schema_version: 1,
        input_sha256: frontendInputHash(projectRoot),
      }),
    );
  }
  stamp();
  return {
    projectRoot,
    stamp,
    put,
    build: () => createEmbeddedAssets({ projectRoot }),
  };
}

test("deterministic manifest pins binary bytes, runtime notices and changed source", (t) => {
  const f = fixture(t);
  const binary = Buffer.from([0, 34, 92, 127, 128, 255]);
  f.put("ui/frontend/dist/assets/pixels.png", binary);
  const a = f.build();
  assert.deepEqual(a, f.build());
  const entry = a.manifest.assets.find((asset) => asset.path === "/assets/pixels.png");
  assert.equal(entry.size_bytes, "6");
  assert.equal(entry.sha256, createHash("sha256").update(binary).digest("hex"));
  assert.equal(entry.content_type, "image/png");
  assert.ok(a.ml.includes('\\000\\"\\\\\\127\\128\\255'));
  assert.deepEqual(
    a.manifest.runtime_dependencies.map((p) => p.name),
    ["sample", "vite"],
  );
  f.put("ui/frontend/src/main.tsx", "export const changed = true;\n");
  assert.throws(f.build, /Stale Vite build inputs/);
  f.stamp();
  assert.notEqual(f.build().manifest.input_sha256, a.manifest.input_sha256);
});

test("generated output checker rejects stale manifests and restores exact identity", (t) => {
  const f = fixture(t);
  checkOrWrite(false, f);
  checkOrWrite(true, f);
  f.put("ui/tools/embedded/manifest.json", "{}\n");
  assert.throws(() => checkOrWrite(true, f), /Stale embedded assets/);
  checkOrWrite(false, f);
  assert.equal(
    readFileSync(path.join(f.projectRoot, "ui/tools/embedded/manifest.json"), "utf8"),
    f.build().manifestJson,
  );
});

for (const [label, html, expected] of [
  ["absent capability", '<script src="/assets/main.js"></script>', /exactly one capability/],
  [
    "duplicate capability",
    "__WORKGRAPH_UI_CAPABILITY____WORKGRAPH_UI_CAPABILITY__",
    /exactly one capability/,
  ],
  [
    "inline executable script",
    "__WORKGRAPH_UI_CAPABILITY__<script>alert(1)</script>",
    /Inline executable/,
  ],
  [
    "inline event handler",
    '__WORKGRAPH_UI_CAPABILITY__<div onclick="alert(1)"></div>',
    /Inline executable/,
  ],
  [
    "data-src masquerading as executable src",
    '__WORKGRAPH_UI_CAPABILITY__<script data-src="/assets/main.js">alert(1)</script>',
    /Inline executable/,
  ],
  [
    "inline body on external script",
    '__WORKGRAPH_UI_CAPABILITY__<script src="/assets/main.js">alert(1)</script>',
    /Inline executable/,
  ],
  [
    "external bootstrap dependency",
    '__WORKGRAPH_UI_CAPABILITY__<script src="https://invalid.example/script.js"></script>',
    /not an embedded asset/,
  ],
  [
    "missing local dependency",
    '__WORKGRAPH_UI_CAPABILITY__<script src="/assets/missing.js"></script>',
    /not an embedded asset/,
  ],
])
  test(`rejects ${label}`, (t) => {
    const f = fixture(t);
    f.put("ui/frontend/dist/index.html", html);
    assert.throws(f.build, expected);
  });

test("rejects symlink assets and unreviewed file types", (t) => {
  const f = fixture(t);
  const target = f.put("outside.txt", "outside");
  const link = path.join(f.projectRoot, "ui/frontend/dist/assets/alias.txt");
  symlinkSync(target, link);
  assert.throws(f.build, /Symlink/);
  rmSync(link);
  f.put("ui/frontend/dist/assets/source.map", "{}");
  assert.throws(f.build, /Unreviewed asset extension/);
});

test("fails closed on absent reviewed license text", (t) => {
  const f = fixture(t);
  rmSync(path.join(f.projectRoot, "ui/frontend/node_modules/sample/LICENSE"));
  assert.throws(f.build, /Missing license text/);
});

test("rejects oversized asset before embedding", (t) => {
  const f = fixture(t);
  f.put("ui/frontend/dist/assets/huge.js", Buffer.alloc(8 * 1024 * 1024 + 1));
  assert.throws(f.build, /exceeds8MiB/);
});

for (const html of [
  '__WORKGRAPH_UI_CAPABILITY__<meta name="workgraph-capability" content="wrong">',
  '<!-- <meta name="workgraph-capability" content="__WORKGRAPH_UI_CAPABILITY__"> -->',
  '<template><meta name="workgraph-capability" content="__WORKGRAPH_UI_CAPABILITY__"></template>',
  '<body><meta name="workgraph-capability" content="__WORKGRAPH_UI_CAPABILITY__"></body>',
  '<meta name="other" content="__WORKGRAPH_UI_CAPABILITY__">',
  '<meta name="workgraph-capability" content="__WORKGRAPH_UI_CAPABILITY__" content="wrong">',
])
  test(`rejects misplaced marker ${html.slice(0, 35)}`, (t) => {
    const f = fixture(t);
    f.put("ui/frontend/dist/index.html", html);
    assert.throws(f.build, /Capability marker/);
  });
test("missing Vite input stamp cannot be invented by embedding", (t) => {
  const f = fixture(t);
  rmSync(path.join(f.projectRoot, "ui/frontend/dist/.vite/workgraph-build.json"));
  assert.throws(f.build, /stamp missing/);
});
test("changed input rejects both embed and check without blessing old bundle", (t) => {
  const f = fixture(t);
  checkOrWrite(false, f);
  f.put("ui/frontend/src/main.tsx", "export const stale = true;\n");
  assert.throws(() => checkOrWrite(false, f), /Stale Vite build inputs/);
  assert.throws(() => checkOrWrite(true, f), /Stale Vite build inputs/);
});
