import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { frontendInputHash } from "../tools/frontend-inputs.mjs";

function buildInputStamp(): Plugin {
  let projectRoot = "";
  let inputHash: string | undefined;
  return {
    name: "workgraph-build-input-stamp",
    apply: "build",
    configResolved(config) {
      projectRoot = path.resolve(config.root, "../..");
    },
    buildStart() {
      inputHash = frontendInputHash(projectRoot);
    },
    generateBundle() {
      if (inputHash === undefined || frontendInputHash(projectRoot) !== inputHash) {
        this.error("Frontend inputs changed during Vite build; rebuild before embedding");
      }
      this.emitFile({
        type: "asset",
        fileName: ".vite/workgraph-build.json",
        source: `${JSON.stringify({ schema_version: 1, input_sha256: inputHash })}\n`,
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), buildInputStamp()],
  base: "/",
  build: {
    target: ["chrome120", "edge120", "firefox120", "safari17"],
    outDir: "dist",
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  server: { host: "127.0.0.1", strictPort: true },
});
