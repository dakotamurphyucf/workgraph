import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { CustomValuePresentation } from "../../../src/features/custom/editor/CustomValuePresentation";
import { createCustomController } from "../../../src/features/custom/editor/controller";
import { createProtocolProcessor } from "../../../src/core/protocol/worker";
import type { ProtocolProcessor } from "../../../src/core/protocol/worker/types";
import type { OperationController } from "../../../src/core/state/operations";
import type { CustomController, SharedCatalog } from "../../../src/features/custom/editor/types";
import type { RendererConfig, ContentPin } from "../../../src/features/custom/config";
import { json, decode, target } from "./fixtures";
import * as d from "../../../src/core/protocol/decoders";
import "../../../src/styles/tokens.css";
import "../../../src/styles/components.css";
const actual = createProtocolProcessor();
let completeOld: (() => void) | null = null;
let deferNext = false;
const processing: ProtocolProcessor = {
  ...actual,
  parse(source, options) {
    if (!deferNext) return actual.parse(source, options);
    deferNext = false;
    return new Promise((resolve, reject) => {
      completeOld = () => {
        void actual.parse(source).then(resolve, reject);
      };
    });
  },
};
let owners = 0;
export function Original() {
  useEffect(() => {
    owners++;
    return () => {
      owners--;
    };
  }, []);
  return (
    <div id="original-viewer" data-testid="original-viewer">
      Original source / Raw
    </div>
  );
}
export function Fixture() {
  const [workspace, setWorkspace] = useState("demo"),
    [socket, setSocket] = useState(target.connection.socket),
    [kind, setKind] = useState<"fields" | "table">("table"),
    [bytes, setBytes] = useState(false),
    [ownerCount, setOwnerCount] = useState(0);
  const controller = useMemo(() => {
    const scope = {
      connection: { ...target.connection, socket },
      workspaceId: decode(d.identifier, workspace),
    };
    const renderer: RendererConfig = {
      config_version: 1,
      kind: "renderer",
      id: decode(d.identifier, "host-renderer"),
      title: "Host renderer",
      match: { entity: "fact", root_type: "object" },
      fallback: "generic",
      presentation:
        kind === "table"
          ? {
              type: "table",
              rows: "/rows",
              columns: [{ pointer: "/marker", label: "Marker", format: { type: "text" } }],
            }
          : {
              type: "fields",
              fields: [
                { pointer: "/missing", label: "Unavailable field", format: { type: "text" } },
              ],
            },
    };
    const pin: ContentPin = {
      resource_id: decode(d.identifier, "host-config"),
      version: decode(d.decimal, "1"),
      digest: decode(d.digest, "a".repeat(64)),
      size_bytes: decode(d.decimal, "1"),
    };
    const shared: SharedCatalog = {
      scope: { kind: "workspace" },
      indexRevision: decode(d.decimal, "1"),
      capture: {
        scope,
        pin,
        blob: new Blob(),
        decoded: {
          kind: "valid",
          document: { config_version: 1, kind: "catalog", entries: [] },
          raw: json({ config_version: 1, kind: "catalog", entries: [] }),
        },
      },
      renderers: [{ renderer, pin }],
      unavailable: [],
    };
    const base = createCustomController({
      http: {
        processing,
        request: () =>
          Promise.resolve({
            ok: false as const,
            failure: { kind: "input" as const, message: "No I/O in component control" },
          }),
      },
      operations: {} as OperationController,
    });
    const state = {
      ...base.get(),
      shared: { kind: "ready" as const, key: "fixture", value: shared },
    };
    const controller: CustomController = {
      ...base,
      get: () => state,
      subscribe: () => () => undefined,
    };
    return controller;
  }, [workspace, socket, kind]);
  useEffect(() => () => controller.dispose(), [controller]);
  const source = useMemo(
    () =>
      new TextEncoder().encode(
        JSON.stringify({ rows: [{ marker: workspace }], marker: workspace }),
      ),
    [workspace],
  );
  return (
    <>
      <h1>Renderer host controls</h1>
      <button onClick={() => setKind(kind === "table" ? "fields" : "table")}>
        Change presentation
      </button>
      <button onClick={() => setWorkspace(workspace === "demo" ? "other" : "demo")}>
        Change workspace
      </button>
      <button
        onClick={() =>
          setSocket(
            socket === target.connection.socket ? "/tmp/other.sock" : target.connection.socket,
          )
        }
      >
        Change endpoint
      </button>
      <button
        onClick={() => {
          deferNext = true;
          setBytes(true);
        }}
      >
        Delay byte parse
      </button>
      <button onClick={() => completeOld?.()}>Complete obsolete parse</button>
      <button onClick={() => setOwnerCount(owners)}>Count original owners</button>
      <output aria-label="Original owners">{ownerCount}</output>
      <CustomValuePresentation
        identity="same-content-key"
        association={{
          connectionId: target.connection.id,
          generation: target.connection.generation,
          socket,
          workspaceId: decode(d.identifier, workspace),
        }}
        subject={{ entity: "fact" }}
        content={
          bytes
            ? { kind: "bytes", bytes: source, complete: true, verified: true }
            : { kind: "value", value: json({ rows: [{ marker: workspace }], marker: workspace }) }
        }
        controller={controller}
        generic={<Original />}
        processing={processing}
      />
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
