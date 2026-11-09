/** Test-only helper surface; product custom editor remains a separate required feature. */
import { createProtocolProcessor } from "../../../src/core/protocol/worker";
import { createCompanion } from "../../../src/core/protocol/client";
import { createHttpClient } from "../../../src/core/protocol/http";
import { createConfigStore } from "../../../src/features/custom/config/store";
import type { ContentPin } from "../../../src/features/custom/config/types";
import * as d from "../../../src/core/protocol/decoders";
const capability = document
  .querySelector('meta[name="workgraph-capability"]')
  ?.getAttribute("content");
if (!capability) throw new Error("Missing actual native capability");
const processing = createProtocolProcessor(),
  http = createHttpClient({ origin: location.origin, capability, processing }),
  store = createConfigStore({ http });
const panel = document.createElement("section"),
  title = document.createElement("h2"),
  output = document.createElement("pre");
title.textContent = "Configuration foundation helper proof";
panel.append(title, output);
document.body.prepend(panel);
const directory = createCompanion(http).connections();
const workspace = d.identifier.decode(d.jsonString("demo"));
if (!workspace.ok) throw new Error("Invalid fixture workspace");
window.configProbe = {
  read: async (pin: ContentPin) => {
    const profiles = await directory;
    if (!profiles.ok) throw new Error("Native fixture directory unavailable");
    const connection = profiles.data.items.find(
      (item) => item.id === "config-fixture" && item.generation === "1",
    );
    if (connection === undefined) throw new Error("Exact fixture generation unavailable");
    const scope = Object.freeze({ connection, workspaceId: workspace.value });
    const result = await store.read(scope, pin);
    if (!result.ok) {
      output.textContent = `${result.kind}: ${result.message}`;
      return result;
    }
    const raw = await result.capture.blob.text();
    output.textContent = raw;
    const decoded = result.capture.decoded;
    return {
      ok: true,
      version: result.capture.pin.version,
      digest: result.capture.pin.digest,
      raw,
      kind: decoded.kind,
      title:
        decoded.kind === "valid" && "title" in decoded.document ? decoded.document.title : null,
    };
  },
  dispose: () => {
    store.dispose();
    processing.dispose();
  },
};
export interface ConfigProbe {
  readonly read: (pin: ContentPin) => Promise<unknown>;
  readonly dispose: () => void;
}
declare global {
  interface Window {
    configProbe: ConfigProbe;
  }
}
