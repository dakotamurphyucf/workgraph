import { afterEach, describe, expect, it, vi } from "vitest";
import * as d from "../../../src/core/protocol/decoders";
import { createCompanion } from "../../../src/core/protocol/client";
import { createOperationController } from "../../../src/core/state/operations";
import type { HttpClient, HttpResult } from "../../../src/core/protocol/http";
import { createResourcesController } from "../../../src/features/knowledge/resources/controller";
import type { ResourcesClient } from "../../../src/features/knowledge/resources/client";
import type { ResourceTransfer } from "../../../src/features/knowledge/resources/transfer";
import type {
  ResourceCapture,
  ResourceRecord,
  ResourceScope,
  ResourceSelection,
} from "../../../src/features/knowledge/resources/types";
import { resourceRecordCodec } from "../../../src/features/knowledge/resources/codecs";
import { createTestProcessor } from "../../core/processing-harness";
import { decode, response } from "../../work/actions-fixtures";
const sha = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const id = (s: string) => decode(d.identifier, s),
  decimal = (s: string) => decode(d.decimal, s);
const scope: ResourceScope = {
  connection: decode(d.connectionProfile, {
    id: "local",
    generation: "9007199254740993",
    label: "Synthetic",
    socket: "/tmp/synthetic-resource.sock",
  }),
  workspaceId: id("workspace"),
};
const record = (resourceId = "artifact", version = "1"): ResourceRecord =>
  decode(resourceRecordCodec, {
    resource_id: resourceId,
    revision: "10",
    version_count: version,
    current_version: {
      revision: version,
      digest: sha,
      size_bytes: "3",
      actor_id: "author",
      timestamp: "2026-01-01",
      filename: "captured.txt",
      mime_type: "text/plain",
    },
    metadata: {
      title: "Current title",
      description: "",
      filename: "current.txt",
      mime_type: "text/plain",
      targets: [],
      archived: false,
    },
  });
const capture = (value: ResourceRecord): ResourceCapture<ResourceRecord> => ({
  scope,
  value,
  response: response({}),
  queryRevision: decimal("100"),
  partial: false,
});
const ok = <T>(data: T): HttpResult<T> => ({ ok: true, data, httpStatus: 200 });
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("No waiter");
  };
  let reject: (error: unknown) => void = () => {
    throw new Error("No waiter");
  };
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((close) => close());
});
function fixture(
  overrides: Partial<ResourcesClient> = {},
  download?: ResourceTransfer["download"],
) {
  const processing = createTestProcessor();
  const http: HttpClient = {
    processing,
    request: () => {
      return Promise.reject(new Error("Unexpected HTTP"));
    },
  };
  const operations = createOperationController(createCompanion(http), processing);
  const client: ResourcesClient = {
    list: () => {
      return Promise.reject(new Error("Unexpected directory read"));
    },
    get: (_scope, id) => Promise.resolve(ok(capture(record(id)))),
    history: () => {
      return Promise.reject(new Error("Unexpected history read"));
    },
    version: () => {
      return Promise.reject(new Error("Unexpected version read"));
    },
    chunk: () => {
      return Promise.reject(new Error("Unexpected range read"));
    },
    ...overrides,
  };
  const transfer = {
    download: vi.fn<ResourceTransfer["download"]>(
      download ??
        ((pin) => Promise.resolve({ ok: true, blob: new Blob(["abc"]), digest: pin.digest })),
    ),
    dispose: vi.fn(),
  };
  const controller = createResourcesController({ http, operations }, { client, transfer });
  cleanups.push(() => {
    controller.dispose();
    operations.dispose();
    processing.dispose();
  });
  const select = (resourceId = "artifact", version = "1"): ResourceSelection => ({
    ...scope,
    resourceId: id(resourceId),
    content: { version: decimal(version), expectedDigest: decode(d.digest, sha) },
  });
  return { controller, client, transfer, select };
}
describe("Resource selection and exact verification owner", () => {
  it("applies metadata type corrections without changing byte pins or fetching content again", async () => {
    let value = record();
    value = {
      ...value,
      current_version: { ...value.current_version, mime_type: "application/octet-stream" },
      metadata: { ...value.metadata, mime_type: "application/octet-stream" },
    };
    const f = fixture({ get: () => Promise.resolve(ok(capture(value))) });
    await f.controller.select({ ...f.select(), content: null });
    const before = f.controller.get().content;
    if (before.kind !== "verified") throw new Error("Expected verified content");
    value = {
      ...value,
      metadata: { ...value.metadata, filename: "notes.md", mime_type: "text/markdown" },
    };
    await f.controller.refreshMetadata();
    const after = f.controller.get().content;
    if (after.kind !== "verified") throw new Error("Expected verified content");
    expect(after.source.hints).toMatchObject({ filename: "notes.md", mime: "text/markdown" });
    expect(after.pin).toBe(before.pin);
    expect(after.blob).toBe(before.blob);
    expect(after.source.bytes).toBe(before.source.bytes);
    expect(after.source.key).toBe(before.source.key);
    expect(f.transfer.download).toHaveBeenCalledTimes(1);
    await f.controller.refreshLive(new AbortController().signal);
    expect(f.controller.get().content).toBe(after);
    await f.controller.select(f.select());
    value = {
      ...value,
      current_version: { ...value.current_version, revision: decimal("2") },
      metadata: { ...value.metadata, filename: "new.json", mime_type: "application/json" },
    };
    await f.controller.refreshLive(new AbortController().signal);
    expect(f.controller.get().content).toMatchObject({
      pin: { version: "1" },
      source: {
        hints: { filename: "notes.md", mime: "text/markdown" },
      },
    });
    expect(f.transfer.download).toHaveBeenCalledTimes(1);
  });
  it("updates unpinned content quietly and leaves an explicit version fixed", async () => {
    let version = "1";
    const next = deferred<Awaited<ReturnType<ResourceTransfer["download"]>>>();
    const f = fixture(
      { get: (_scope, id) => Promise.resolve(ok(capture(record(id, version)))) },
      (pin) =>
        pin.version === "2"
          ? next.promise
          : Promise.resolve({ ok: true, blob: new Blob(["abc"]), digest: pin.digest }),
    );
    await f.controller.select({ ...f.select(), content: null });
    const old = f.controller.get().content;
    version = "2";
    const refresh = f.controller.refreshLive(new AbortController().signal);
    await vi.waitFor(() => expect(f.transfer.download).toHaveBeenCalledTimes(2));
    expect(f.controller.get().content).toBe(old);
    next.resolve({ ok: true, blob: new Blob(["abc"]), digest: decode(d.digest, sha) });
    await refresh;
    expect(f.controller.get().content).toMatchObject({ kind: "verified", pin: { version: "2" } });
    await f.controller.select(f.select("artifact", "2"));
    version = "3";
    await f.controller.refreshLive(new AbortController().signal);
    expect(f.controller.get().content).toMatchObject({ kind: "verified", pin: { version: "2" } });
    expect(f.transfer.download).toHaveBeenCalledTimes(2);
    expect(f.controller.get().metadata).toMatchObject({
      kind: "ready",
      value: { value: { current_version: { revision: "3" } } },
    });
  });
  it("retains the verified viewer when latest resolves to the same explicit immutable pin", async () => {
    const get = vi.fn<ResourcesClient["get"]>((_scope, id) =>
      Promise.resolve(ok(capture(record(id)))),
    );
    const f = fixture({ get });
    await f.controller.select({ ...f.select(), content: null });
    const verified = f.controller.get().content;
    const observations: unknown[] = [];
    const unsubscribe = f.controller.subscribe(() => observations.push(f.controller.get().content));
    await f.controller.select(f.select());
    unsubscribe();
    expect(verified.kind).toBe("verified");
    expect(f.controller.get().content).toBe(verified);
    expect(observations.every((value) => value === verified)).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
    expect(f.transfer.download).toHaveBeenCalledTimes(1);
  });

  it.each(["resource", "version", "digest", "workspace", "generation", "socket"] as const)(
    "hides verified content immediately when the explicit %s identity changes",
    async (changed) => {
      const pending = deferred<HttpResult<ResourceCapture<ResourceRecord>>>();
      let reads = 0;
      const f = fixture({
        get: () => (++reads === 1 ? Promise.resolve(ok(capture(record()))) : pending.promise),
      });
      await f.controller.select({ ...f.select(), content: null });
      const base = f.select();
      const selected: ResourceSelection = {
        ...base,
        resourceId: changed === "resource" ? id("other") : base.resourceId,
        workspaceId: changed === "workspace" ? id("other") : base.workspaceId,
        connection: {
          ...base.connection,
          generation: changed === "generation" ? decimal("2") : base.connection.generation,
          socket: changed === "socket" ? "/tmp/other.sock" : base.connection.socket,
        },
        content: {
          version: decimal(changed === "version" ? "2" : "1"),
          expectedDigest: decode(d.digest, changed === "digest" ? "b".repeat(64) : sha),
        },
      };
      const task = f.controller.select(selected);
      expect(f.controller.get().content.kind).toBe("loading");
      expect(f.transfer.download).toHaveBeenCalledTimes(1);
      f.controller.cancelDownload();
      pending.resolve(ok(capture(record())));
      await task;
      expect(f.controller.get().content.kind).toBe("failed");
    },
  );
  it("cancels an old version-history page on same-pin route change without unmounting content", async () => {
    const pending = deferred<Awaited<ReturnType<ResourcesClient["history"]>>>();
    let historySignal: AbortSignal | undefined;
    const history = vi.fn<ResourcesClient["history"]>((_scope, _id, _opts, signal) => {
      historySignal = signal;
      return pending.promise;
    });
    const f = fixture({ history });
    await f.controller.select({ ...f.select(), content: null });
    const verified = f.controller.get().content;
    const page = f.controller.versions();
    await f.controller.select(f.select());
    expect(historySignal?.aborted).toBe(true);
    expect(f.controller.get().versions.kind).toBe("idle");
    expect(f.controller.get().content).toBe(verified);
    pending.resolve(
      ok({
        ...capture(record()),
        value: {
          items: [record().current_version],
          offset: decimal("0"),
          next_offset: decimal("1"),
          remaining: decimal("1"),
        },
      }),
    );
    await page;
    expect(f.controller.get().versions.kind).toBe("idle");
    await f.controller.versions(decimal("1"));
    expect(f.controller.get().versions.kind).toBe("failed");
    expect(history).toHaveBeenCalledTimes(1);
    expect(f.controller.get().content).toBe(verified);
  });
  it("verifies selected publication while metadata refresh retains original bytes and version", async () => {
    let latest = record();
    const f = fixture({ get: () => Promise.resolve(ok(capture(latest))) });
    await f.controller.select(f.select());
    const before = f.controller.get().content;
    expect(before.kind).toBe("verified");
    latest = record("artifact", "2");
    await f.controller.refreshMetadata();
    expect(f.controller.get().content).toBe(before);
    expect(f.controller.get().metadata.kind).toBe("ready");
    expect(f.transfer.download).toHaveBeenCalledTimes(1);
  });
  it("exact evidence digest mismatch rejects without downloading current content", async () => {
    const f = fixture();
    const selected = {
      ...f.select(),
      content: { version: decimal("1"), expectedDigest: decode(d.digest, "b".repeat(64)) },
    };
    await f.controller.select(selected);
    expect(f.controller.get().content.kind).toBe("failed");
    expect(f.transfer.download).not.toHaveBeenCalled();
  });
  it("late superseded metadata exception cannot poison the newer selected resource", async () => {
    const old = deferred<HttpResult<ResourceCapture<ResourceRecord>>>();
    const f = fixture({
      get: (_scope, id) => Promise.resolve(id === "old" ? old.promise : ok(capture(record(id)))),
    });
    const first = f.controller.select(f.select("old"));
    await f.controller.select(f.select("new"));
    old.reject(new Error("late old read"));
    await first;
    const state = f.controller.get();
    expect(state.unexpected).toBeNull();
    expect(state.content.kind).toBe("verified");
    if (state.content.kind === "verified") expect(state.content.pin.resourceId).toBe("new");
  });
  it("late old download completion cannot replace a newer selection", async () => {
    const old = deferred<Awaited<ReturnType<ResourceTransfer["download"]>>>();
    const entered = deferred<void>();
    const f = fixture({}, (pin) => {
      if (pin.resourceId === "old") {
        entered.resolve();
        return Promise.resolve(old.promise);
      }
      return Promise.resolve({ ok: true, blob: new Blob(["abc"]), digest: pin.digest });
    });
    const first = f.controller.select(f.select("old"));
    await entered.promise;
    await f.controller.select(f.select("new"));
    old.resolve({ ok: true, blob: new Blob(["old"]), digest: sha });
    await first;
    const value = f.controller.get().content;
    expect(value.kind).toBe("verified");
    if (value.kind === "verified") expect(value.pin.resourceId).toBe("new");
  });
  it("known read failure is visible and the same exact selection can be explicitly retried", async () => {
    let failed = true;
    const f = fixture({
      get: () =>
        Promise.resolve(
          failed
            ? { ok: false, failure: { kind: "network", message: "offline" } }
            : ok(capture(record())),
        ),
    });
    await f.controller.select(f.select());
    expect(f.controller.get().content.kind).toBe("failed");
    failed = false;
    await f.controller.select(f.select());
    expect(f.controller.get().content.kind).toBe("verified");
  });
  it("canceling verification never exposes a partial Blob as complete", async () => {
    const pending = deferred<Awaited<ReturnType<ResourceTransfer["download"]>>>(),
      entered = deferred<void>();
    const f = fixture({}, () => {
      entered.resolve();
      return Promise.resolve(pending.promise);
    });
    const task = f.controller.select(f.select());
    await entered.promise;
    f.controller.cancelDownload();
    pending.resolve({ ok: true, blob: new Blob(["abc"]), digest: sha });
    await task;
    expect(f.controller.get().content.kind).toBe("failed");
  });
  it("Published versions continuation retains its original query revision across metadata refresh", async () => {
    let revision = decimal("100");
    const history = vi.fn<ResourcesClient["history"]>((_scope, _id, opts = {}) =>
      Promise.resolve(
        ok({
          ...capture(record()),
          queryRevision: opts.atRevision ?? revision,
          value: {
            items: [record().current_version],
            offset: opts.offset ?? decimal("0"),
            next_offset: (opts.offset ?? "0") === "0" ? decimal("1") : null,
            remaining: (opts.offset ?? "0") === "0" ? decimal("1") : decimal("0"),
          },
        }),
      ),
    );
    const f = fixture({
      get: () => Promise.resolve(ok({ ...capture(record()), queryRevision: revision })),
      history,
    });
    await f.controller.select(f.select());
    await f.controller.versions();
    revision = decimal("101");
    await f.controller.refreshMetadata();
    await f.controller.nextVersions();
    expect(history.mock.calls[1]?.[2]?.atRevision).toBe("100");
    expect(f.controller.get().versionPreviousOffsets).toEqual(["0"]);
    await f.controller.previousVersions();
    expect(history.mock.calls[2]?.[2]).toEqual({ offset: "0", atRevision: "100" });
    expect(f.controller.get().versionPreviousOffsets).toEqual([]);
    await f.controller.versions();
    expect(history.mock.calls[3]?.[2]?.atRevision).toBe("101");
    await f.controller.nextVersions();
    await f.controller.select(f.select("another-resource"));
    expect(f.controller.get().versionPreviousOffsets).toEqual([]);
  });
  it("returns through observed directory offsets and preserves the page after a rejected read", async () => {
    let failNext = false;
    const list = vi.fn<ResourcesClient["list"]>((requestedScope, options) => {
      if (failNext) {
        failNext = false;
        return Promise.resolve({
          ok: false,
          failure: { kind: "input", message: "Capture no longer current" },
        });
      }
      const offset = options?.offset ?? decimal("0"),
        last = offset === "2";
      return Promise.resolve(
        ok({
          ...capture(record()),
          scope: requestedScope,
          value: {
            items: last ? [record("c")] : [record("a"), record("b")],
            offset,
            next_offset: last ? null : decimal("2"),
            remaining: decimal(last ? "0" : "1"),
          },
        }),
      );
    });
    const f = fixture({ list });
    await f.controller.directory(scope, {
      target: { kind: "project", id: id("release") },
      includeArchived: true,
    });
    failNext = true;
    await f.controller.nextDirectory();
    const failed = f.controller.get().directory;
    expect(failed.kind === "failed" && failed.previous?.value.offset).toBe("0");
    expect(f.controller.get().directoryPreviousOffsets).toEqual([]);
    await f.controller.nextDirectory();
    expect(f.controller.get().directoryPreviousOffsets).toEqual(["0"]);
    await f.controller.select(f.select("c"));
    expect(f.controller.get().directoryPreviousOffsets).toEqual(["0"]);
    await f.controller.previousDirectory();
    const first = f.controller.get().directory;
    expect(first.kind === "ready" && first.value.value.offset).toBe("0");
    expect(f.controller.get().directoryPreviousOffsets).toEqual([]);
    expect(
      list.mock.calls.map(([, options]) => [options?.offset ?? "0", options?.atRevision]),
    ).toEqual([
      ["0", undefined],
      ["2", "100"],
      ["2", "100"],
      ["0", "100"],
    ]);
    for (const [, options] of list.mock.calls) {
      expect(options?.target).toEqual({ kind: "project", id: "release" });
      expect(options?.includeArchived).toBe(true);
    }
    await f.controller.nextDirectory();
    await f.controller.directory(scope, { target: { kind: "project", id: id("other") } });
    expect(f.controller.get().directoryPreviousOffsets).toEqual([]);
  });
  it("project association changes the directory request and cache identity explicitly", async () => {
    const list = vi.fn<ResourcesClient["list"]>(() =>
      Promise.resolve(
        ok({
          ...capture(record()),
          value: { items: [], offset: decimal("0"), next_offset: null, remaining: decimal("0") },
        }),
      ),
    );
    const f = fixture({ list });
    await f.controller.directory(scope, { target: { kind: "project", id: id("first") } });
    const first = f.controller.get().directory;
    await f.controller.directory(scope, { target: { kind: "project", id: id("second") } });
    const second = f.controller.get().directory;
    expect(first.kind).toBe("ready");
    expect(second.kind).toBe("ready");
    if (first.kind === "ready" && second.kind === "ready") expect(first.key).not.toBe(second.key);
    expect(list.mock.calls[1]?.[1]?.target).toEqual({ kind: "project", id: "second" });
    expect(f.controller.get().directoryTarget).toEqual({ kind: "project", id: "second" });
  });
});
