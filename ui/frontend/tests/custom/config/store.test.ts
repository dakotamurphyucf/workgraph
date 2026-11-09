import { afterEach, expect, it, vi } from "vitest";
import { readCatalogEntry } from "../../../src/features/custom/config/catalog";
import { configJson } from "../../../src/features/custom/config/encode";
import { view } from "./fixtures";
import { decodeConfigValue } from "../../../src/features/custom/config/decode";
import { createConfigStore } from "../../../src/features/custom/config/store";
import type { ResourcesClient } from "../../../src/features/knowledge/resources/client";
import type { ResourceTransfer } from "../../../src/features/knowledge/resources/transfer";
import { resourceRecordCodec } from "../../../src/features/knowledge/resources/codecs";
import type {
  ResourceCapture,
  ResourceRecord,
  ResourceVersion,
} from "../../../src/features/knowledge/resources/types";
import type { TransferResult } from "../../../src/features/history/transcript/transfer.types";
import * as d from "../../../src/core/protocol/decoders";
import type { HttpClient } from "../../../src/core/protocol/http";
import { decode } from "../../work/actions-fixtures";
import { createTestProcessor } from "../../core/processing-harness";
const scope = {
  connection: decode(d.connectionProfile, {
    id: "local",
    generation: "2",
    label: "Local",
    socket: "/tmp/owned.sock",
  }),
  workspaceId: decode(d.identifier, "workspace"),
};
const pin = {
  resource_id: decode(d.identifier, "config"),
  version: decode(d.decimal, "1"),
  digest: decode(d.digest, "a".repeat(64)),
  size_bytes: decode(d.decimal, "0"),
};
const record = decode(resourceRecordCodec, {
  resource_id: "config",
  revision: "3",
  metadata: {
    title: "Config",
    description: "",
    filename: "config.json",
    mime_type: "application/json",
    archived: false,
    targets: [],
  },
  current_version: {
    revision: "1",
    digest: "a".repeat(64),
    size_bytes: "0",
    actor_id: "writer",
    timestamp: "2026-11-07T00:00:00Z",
    filename: "config.json",
    mime_type: "application/json",
  },
  version_count: "1",
});
const response = decode(d.readResponse, {
  response: { data: {}, meta: { workspace_revision: "4" } },
  pagination: null,
});
const captured = <T>(value: T): ResourceCapture<T> => ({
  scope,
  value,
  response,
  queryRevision: decode(d.decimal, "4"),
  partial: false,
});
const processors: ReturnType<typeof createTestProcessor>[] = [];
afterEach(() => {
  processors.splice(0).forEach((p) => p.dispose());
});
function fixture(result: TransferResult) {
  const get = vi.fn<ResourcesClient["get"]>(() =>
    Promise.resolve({ ok: true, data: captured<ResourceRecord>(record), httpStatus: 200 }),
  );
  const version = vi.fn<ResourcesClient["version"]>(() =>
    Promise.resolve({
      ok: true,
      data: captured<ResourceVersion>(record.current_version),
      httpStatus: 200,
    }),
  );
  const unexpected = () => {
    throw new Error("Unexpected unrelated Resource read");
  };
  const client: ResourcesClient = {
    get,
    version,
    list: unexpected,
    history: unexpected,
    chunk: unexpected,
  };
  const transfer: ResourceTransfer = {
    download: vi.fn(() => Promise.resolve(result)),
    dispose: vi.fn(),
  };
  const processing = createTestProcessor();
  processors.push(processing);
  const http: HttpClient = { processing, request: unexpected };
  return { get, version, transfer, http, store: createConfigStore({ http }, client, transfer) };
}
it.each([
  ["cancelled", "cancelled"],
  ["timeout", "timeout"],
  ["busy", "busy"],
  ["input", "input"],
  ["protocol", "protocol"],
  ["read", "unavailable"],
] as const)(
  "retains %s transfer diagnostics as %s without calling it corrupt content",
  async (kind, expected) => {
    const f = fixture({ ok: false, kind, message: `Exact ${kind} diagnostic` });
    expect(await f.store.read(scope, pin)).toMatchObject({
      ok: false,
      kind: expected,
      message: `Exact ${kind} diagnostic`,
    });
    f.store.dispose();
  },
);
it("rejects oversized pins before network/transfer and preserves verified invalid source", async () => {
  const f = fixture({ ok: true, blob: new Blob([]), digest: pin.digest });
  expect(
    await f.store.read(scope, { ...pin, size_bytes: decode(d.decimal, "65537") }),
  ).toMatchObject({ ok: false, kind: "input" });
  expect(f.get).not.toHaveBeenCalled();
  expect(f.transfer.download).not.toHaveBeenCalled();
  const result = await f.store.read(scope, pin);
  expect(result).toMatchObject({ ok: true, capture: { decoded: { kind: "invalid_json" }, pin } });
  expect(f.version).toHaveBeenCalledWith(
    scope,
    pin.resource_id,
    pin.version,
    "4",
    expect.any(AbortSignal),
  );
  f.store.dispose();
});
it("checks disposal after a late decoder result and releases owner after unexpected failure", async () => {
  const f = fixture({ ok: true, blob: new Blob([]), digest: pin.digest });
  const processing = f.http.processing;
  let release: (() => void) | undefined;
  const original = processing.parse;
  vi.spyOn(processing, "parse").mockImplementation(async (source) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return original(source);
  });
  const pending = f.store.read(scope, pin);
  await vi.waitFor(() => expect(release).toBeDefined());
  f.store.dispose();
  release?.();
  expect(await pending).toMatchObject({ ok: false, kind: "cancelled" });
  const g = fixture({ ok: false, kind: "read", message: "unavailable" });
  vi.mocked(g.transfer.download).mockRejectedValueOnce(new TypeError("programming defect"));
  await expect(g.store.read(scope, pin)).rejects.toThrow("programming defect");
  expect(await g.store.read(scope, pin)).toMatchObject({ ok: false, kind: "unavailable" });
  g.store.dispose();
});

it("checks catalog row identity against pinned source without discarding verified bytes", async () => {
  const raw = configJson(view()),
    blob = new Blob(["exact source bytes"]);
  const capture = { scope, pin, blob, decoded: decodeConfigValue(raw) };
  const read = vi.fn<import("../../../src/features/custom/config/types").ConfigStore["read"]>(() =>
    Promise.resolve({ ok: true, capture }),
  );
  const store = { read, dispose: () => undefined };
  const result = await readCatalogEntry(store, scope, {
    kind: "view",
    id: decode(d.identifier, "wrong-id"),
    pin,
  });
  expect(result).toMatchObject({ ok: true, capture: { decoded: { kind: "invalid" }, pin } });
  if (!result.ok) throw new Error("capture");
  expect(result.capture.blob).toBe(blob);
  expect(read).toHaveBeenCalledTimes(1);
});
