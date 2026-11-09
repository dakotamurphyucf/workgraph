import { build } from "vite";
import { fileURLToPath } from "node:url";
export interface BridgeAsset {
  readonly body: string | Uint8Array;
  readonly contentType: string;
}
/** Memory-only module/worker assets. Never modifies production dist or its provenance stamp. */
export async function buildClientBridge(): Promise<ReadonlyMap<string, BridgeAsset>> {
  const output = await build({
    configFile: false,
    base: "/__workgraph-test__/",
    define: { "process.env.NODE_ENV": '"production"' },
    root: fileURLToPath(new URL("../../../", import.meta.url)),
    logLevel: "error",
    build: {
      write: false,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL("./client-bridge.ts", import.meta.url)),
        formats: ["es"],
        fileName: () => "client-bridge.js",
      },
    },
  });
  const results = Array.isArray(output) ? output : [output];
  const assets = new Map<string, BridgeAsset>();
  for (const result of results)
    if ("output" in result)
      for (const member of result.output) {
        const path = `/__workgraph-test__/${member.fileName}`;
        if (assets.has(path)) throw new Error("Duplicate integration bundle asset.");
        assets.set(path, {
          body: member.type === "chunk" ? member.code : member.source,
          contentType: member.fileName.endsWith(".css") ? "text/css" : "text/javascript",
        });
      }
  if (!assets.has("/__workgraph-test__/client-bridge.js"))
    throw new Error("Integration entry module is missing.");
  return assets;
}
