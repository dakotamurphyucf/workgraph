import { afterEach, describe, expect, it, vi } from "vitest";
import * as d from "../../../src/core/protocol/decoders";
import type { HttpClient, HttpResult } from "../../../src/core/protocol/http";
import { createTestProcessor } from "../../core/processing-harness";
import { decode, response } from "../../work/actions-fixtures";
import { resourceRecordCodec } from "../../../src/features/knowledge/resources/codecs";
import type { ResourcesClient } from "../../../src/features/knowledge/resources/client";
import type { ResourceCapture, ResourcePin } from "../../../src/features/knowledge/resources/types";
import {
  completeContent,
  createRichViewerController,
  pinKey,
} from "../../../src/features/knowledge/viewers/controller";
import { createViewerWorker } from "../../../src/features/knowledge/viewers/worker-client";
const sha = "a".repeat(64),
  otherSha = "b".repeat(64),
  id = (s: string) => decode(d.identifier, s),
  decimal = (s: string) => decode(d.decimal, s);
const connection = decode(d.connectionProfile, {
  id: "local",
  generation: "9007199254740993",
  label: "Synthetic",
  socket: "/tmp/synthetic-viewer.sock",
});
const pin: ResourcePin = {
  connection,
  workspaceId: id("workspace"),
  resourceId: id("artifact"),
  version: decimal("1"),
  digest: decode(d.digest, sha),
  sizeBytes: decimal("7"),
  filename: "value.json",
  mimeType: "application/json",
};
const record = decode(resourceRecordCodec, {
  resource_id: "artifact",
  revision: "10",
  version_count: "2",
  current_version: {
    revision: "2",
    digest: otherSha,
    size_bytes: "7",
    actor_id: "author",
    timestamp: "2026-01-01",
    filename: "value.json",
    mime_type: "application/json",
  },
  metadata: {
    title: "Current",
    description: "",
    filename: "value.json",
    mime_type: "application/json",
    targets: [],
    archived: false,
  },
});
function captured<T>(value: T, revision = "100"): ResourceCapture<T> {
  return {
    scope: pin,
    value,
    queryRevision: decimal(revision),
    partial: false,
    response: response({}),
  };
}
const ok = <T>(data: T): HttpResult<T> => ({ ok: true, data, httpStatus: 200 });
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));
function fixture(
  options: {
    readonly socket?: string;
    readonly get?: ResourcesClient["get"];
    readonly version?: ResourcesClient["version"];
  } = {},
) {
  const processing = createTestProcessor();
  cleanups.push(processing.dispose);
  const http: HttpClient = {
    processing,
    request: (request) => {
      const parsed = request.codec.decode(
        d.jsonObject([
          ["id", d.jsonString(connection.id)],
          ["generation", d.jsonString(connection.generation)],
          ["label", d.jsonString(connection.label)],
          ["socket", d.jsonString(options.socket ?? connection.socket)],
        ]),
      );
      return Promise.resolve(
        parsed.ok
          ? ok(parsed.value)
          : {
              ok: false,
              failure: { kind: "protocol", message: "invalid test response", issue: parsed.issue },
            },
      );
    },
  };
  const get = vi.fn(options.get ?? (() => Promise.resolve(ok(captured(record))))),
    version = vi.fn(
      options.version ??
        ((_scope, _id, selected, revision) =>
          Promise.resolve(
            ok(captured({ ...record.current_version, revision: selected }, revision)),
          )),
    );
  const client: ResourcesClient = {
    get,
    version,
    list: () => Promise.reject(new Error("unexpected list")),
    history: () => Promise.reject(new Error("unexpected history")),
    chunk: () => Promise.reject(new Error("unexpected chunk")),
  };
  const download = vi.fn(() =>
    Promise.resolve({ ok: true as const, blob: new Blob(['{"n":2}']), digest: otherSha }),
  );
  const controller = createRichViewerController(
    { http },
    {
      client,
      transfer: { download, dispose: () => {} },
      worker: createViewerWorker(() => {
        throw new Error("unexpected render");
      }),
    },
  );
  cleanups.push(controller.dispose);
  return { controller, get, version, download };
}
describe("exact independent comparison captures", () => {
  it("uses captured planning revision for exact right version and retains independent pin", async () => {
    const f = fixture();
    await f.controller.compareVersion(pin, decimal("2"));
    expect(f.version).toHaveBeenCalledWith(
      expect.objectContaining({ connection }),
      pin.resourceId,
      decimal("2"),
      decimal("100"),
      expect.any(AbortSignal),
    );
    const state = f.controller.get().comparison;
    expect(state.kind).toBe("ready");
    if (state.kind === "ready") {
      expect(state.content.pin.version).toBe("2");
      expect(state.content.pin.digest).toBe(otherSha);
      expect(state.owner).toBe(pinKey(pin));
      expect(state.content.source.completeness).toBe("complete");
    }
    expect(pin.version).toBe("1");
  });
  it("rejects retained same-ID/generation different socket before any daemon read", async () => {
    const f = fixture({ socket: "/tmp/other-target.sock" });
    await f.controller.compareVersion(pin, decimal("2"));
    expect(f.get).not.toHaveBeenCalled();
    expect(f.download).not.toHaveBeenCalled();
    const state = f.controller.get().comparison;
    expect(state.kind).toBe("failed");
    if (state.kind === "failed") expect(state.message).toContain("differs");
  });
  it("never substitutes current for unavailable or partial exact descriptor", async () => {
    const f = fixture({
      version: () =>
        Promise.resolve({
          ok: false,
          failure: {
            kind: "remote",
            httpStatus: 404,
            problem: { kind: "Not_found", message: "missing", details: undefined },
          },
        }),
    });
    await f.controller.compareVersion(pin, decimal("9"));
    expect(f.download).not.toHaveBeenCalled();
    expect(f.controller.get().comparison.kind).toBe("failed");
    const p = fixture({
      version: () => Promise.resolve(ok({ ...captured(record.current_version), partial: true })),
    });
    await p.controller.compareVersion(pin, decimal("2"));
    expect(p.download).not.toHaveBeenCalled();
    const state = p.controller.get().comparison;
    expect(state.kind).toBe("failed");
    if (state.kind === "failed") expect(state.message).toContain("incomplete");
  });
  it("ignores a stale failed read after a newer comparison completed", async () => {
    let reject: (error: unknown) => void = () => {
      throw new Error("no waiter");
    };
    let calls = 0;
    const get: ResourcesClient["get"] = () => {
      calls++;
      return calls === 1
        ? new Promise((_resolve, no) => {
            reject = no;
          })
        : Promise.resolve(ok(captured(record)));
    };
    const f = fixture({ get });
    const old = f.controller.compareVersion(pin, decimal("1"));
    await vi.waitFor(() => expect(f.get).toHaveBeenCalledTimes(1));
    await f.controller.compareVersion(pin, decimal("2"));
    reject(new Error("obsolete failure"));
    await old;
    expect(f.controller.get().comparison).toMatchObject({
      kind: "ready",
      content: { pin: { version: "2" } },
    });
    expect(f.controller.get().unexpected).toBeNull();
  });
  it("lifts a >1MiB verified complete JSON Blob instead of parsing its preview prefix", async () => {
    const text = '{"padding":"' + "a".repeat(1200000) + '","tail":9007199254740993}',
      bytes = new TextEncoder().encode(text),
      source = {
        key: "large-pin",
        label: "large.json",
        bytes: bytes.slice(0, 1048576),
        completeness: "partial" as const,
        hints: { mime: "application/json" },
      };
    const content = await completeContent({
      pin: { ...pin, sizeBytes: decimal(String(bytes.length)) },
      blob: new Blob([bytes]),
      source,
    });
    expect(content.source.completeness).toBe("complete");
    expect(content.source.bytes.length).toBe(bytes.length);
    expect(new TextDecoder().decode(content.source.bytes).endsWith("9007199254740993}")).toBe(true);
    expect(source.bytes.length).toBe(1048576);
  });
});
