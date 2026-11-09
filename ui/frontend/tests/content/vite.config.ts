import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = process.env.WORKGRAPH_CONTENT_BUILD_DIR;
if (!output || !path.isAbsolute(output))
  throw new Error("Set an absolute WORKGRAPH_CONTENT_BUILD_DIR for the isolated fixture");
export default defineConfig({
  root: frontend,
  plugins: [react()],
  base: "/",
  build: {
    target: ["chrome120", "edge120", "firefox120", "safari17"],
    outDir: output,
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
    assetsInlineLimit: 0,
    rollupOptions: { input: path.join(frontend, "tests/content/fixture.html") },
  },
});
