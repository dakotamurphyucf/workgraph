import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { parseJsonText, jsonField, type JsonValue } from "../../../src/core/json";
import type { FeatureContext } from "../../../src/app/types";
import * as d from "../../../src/core/protocol/decoders";
import type { HttpClient, HttpRequest } from "../../../src/core/protocol/http";
import type { Preparation } from "../../../src/core/protocol/types";
import type { VerifiedTransfer } from "../../../src/features/history/transcript/transfer";
import type { ManagedOperation, OperationController } from "../../../src/core/state/operations";
import {
  createHistoryController,
  current,
  decimal,
  id,
  partKey,
} from "../../../src/features/history/transcript/controller";
import * as codecs from "../../../src/features/history/transcript/codecs";
import { createTestProcessor } from "../../core/processing-harness";
function json(value: unknown) {
  const parsed = parseJsonText(JSON.stringify(value));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value.value;
}
const head = "a".repeat(64),
  other = "b".repeat(64),
  digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const text = new TextEncoder().encode("# Generic snow 雪\n\n```ocaml\nlet exact = 42\n```\n");
const source = { digest: digest(text), size_bytes: String(text.length) };
const capture = {
  workspace_id: "demo",
  head,
  sequence: "2",
  sessions: [{ session_id: "sensor", through: "2" }],
};
const metadata = {
  workspace_id: "demo",
  session_id: "sensor",
  title: "General sensor stream",
  actor_id: "original",
  run_id: null,
  parent_event: null,
  scopes: [],
  archived: false,
  created_at_unix_ms: "9007199254740993",
  last_event_at_unix_ms: null,
};
function event(sequence = "1") {
  return {
    event_ref: { session_id: "sensor", sequence },
    identity_hash: "c".repeat(64),
    actor_id: "original",
    run_id: null,
    event: {
      client_id: `sensor-${sequence}`,
      role: "sensor",
      kind: "measurement",
      phase: "recorded",
      correlation: null,
      provenance: { exact: "9007199254740993" },
      payload: { kind: "blob", blob: source },
      searchable_text: { kind: "blob", blob: source },
      resource_versions: [],
      attachments: [],
    },
  };
}
function prefix(empty = false) {
  return {
    blob: source,
    offset: "0",
    bytes_base64: empty ? "" : Buffer.from(text).toString("base64"),
    next_offset: empty ? "0" : String(text.length),
    total_bytes: String(text.length),
    has_more: empty,
  };
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
function harness(
  override?: (method: string, request: HttpRequest<unknown>) => unknown,
  verifiedTransfer?: VerifiedTransfer,
) {
  const processing = createTestProcessor(),
    calls: { method: string; params: JsonValue | undefined }[] = [],
    registered: Preparation[] = [];
  const http: HttpClient = {
    processing,
    request: async <T>(request: HttpRequest<T>) => {
      const methodNode = request.body ? jsonField(request.body, "method") : undefined,
        method = methodNode?.kind === "string" ? methodNode.value : request.path;
      const params = request.body ? jsonField(request.body, "params") : undefined;
      calls.push({ method, params });
      const replaced = await override?.(method, request);
      let value: unknown = replaced;
      if (value === undefined) {
        const data =
          method === "session.list"
            ? { items: [metadata], next_offset: "1", has_more: false }
            : method === "session.get"
              ? { session: metadata, through: "2" }
              : method === "history.read"
                ? {
                    session_id: "sensor",
                    through: "2",
                    items: [event(), event("2")],
                    has_more: false,
                    next_anchor: "2",
                    omitted_for_budget: "0",
                  }
                : method === "history.payloads"
                  ? {
                      items: [
                        { event_ref: { session_id: "sensor", sequence: "1" }, payload: prefix() },
                        {
                          event_ref: { session_id: "sensor", sequence: "2" },
                          payload: prefix(true),
                        },
                      ],
                    }
                  : method === "history.payload"
                    ? prefix()
                    : null;
        value = { response: { data, meta: { history_capture: capture } }, pagination: null };
      }
      const decoded = request.codec.decode(json(value));
      if (!decoded.ok)
        return {
          ok: false,
          failure: { kind: "protocol", message: decoded.issue.expected, issue: decoded.issue },
        };
      return { ok: true, data: decoded.value, httpStatus: 200 };
    },
  };
  let entry: ManagedOperation | undefined;
  const operations: OperationController = {
    get: () => entry,
    list: () => (entry ? [entry] : []),
    subscribe: () => () => {},
    register: (preparation) => {
      registered.push(preparation);
      entry = { preparation, operation: null, phase: { kind: "draft" } };
      return Promise.resolve({ ok: true, entry });
    },
    adopt: () => Promise.reject(new Error("unused")),
    act: () =>
      entry ? Promise.resolve({ ok: true, entry }) : Promise.reject(new Error("not registered")),
    dispose: () => {},
  };
  const profile = d.connectionProfile.decode(
    json({ id: "local", generation: "1", label: "Local", socket: "/tmp/model.sock" }),
  );
  if (!profile.ok) throw new Error("fixture");
  const context: FeatureContext = {
    client: http,
    connection: profile.value,
    profileState: "current",
    route: {
      view: "history",
      connectionId: "local",
      workspaceId: "demo",
      projectId: null,
      entityId: "sensor",
    },
    writer: { actorId: "original", runId: null },
    navigate: () => {},
  };
  const controller = createHistoryController({
    http,
    operations,
    ...(verifiedTransfer === undefined ? {} : { verifiedTransfer }),
  });
  cleanups.push(() => {
    controller.dispose();
    processing.dispose();
  });
  return { controller, context, calls, registered, processing };
}
describe("captured history controller", () => {
  it.each(["valid", "capture", "blob", "digest", "stalled"] as const)(
    "completes large tool output before publication and rejects %s continuation corruption",
    async (mode) => {
      const bytes = new TextEncoder().encode(
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-11-09T01:00:00Z",
          payload: {
            type: "custom_tool_call_output",
            call_id: "large-call",
            output: "large result ".repeat(60_000) + "FINAL-MARKER",
          },
        }),
      );
      const blob = { digest: digest(bytes), size_bytes: String(bytes.length) };
      const chunk = (offset: number, length: number) => {
        const end = Math.min(offset + length, bytes.length);
        const selected = bytes.slice(offset, end);
        if (mode === "digest" && offset > 0) selected[0] = 0;
        return {
          blob,
          offset: String(offset),
          total_bytes: blob.size_bytes,
          bytes_base64: Buffer.from(selected).toString("base64"),
          next_offset: String(end),
          has_more: end < bytes.length,
        };
      };
      const h = harness((method, request) => {
        let data: unknown;
        if (method === "history.read")
          data = {
            session_id: "sensor",
            through: "2",
            items: [
              event(),
              { ...event("2"), event: { ...event("2").event, payload: { kind: "blob", blob } } },
            ],
            has_more: false,
            next_anchor: "2",
            omitted_for_budget: "0",
          };
        else if (method === "history.payloads")
          data = {
            items: [
              { event_ref: event().event_ref, payload: prefix() },
              { event_ref: event("2").event_ref, payload: chunk(0, 32768) },
            ],
          };
        else if (method === "history.payload") {
          const params = request.body && jsonField(request.body, "params");
          const field = params && jsonField(params, "offset");
          const offset = field?.kind === "string" ? Number(field.value) : -1;
          const value = chunk(offset, mode === "stalled" ? 0 : 262144);
          data = mode === "blob" ? { ...value, blob: { ...blob, digest: other } } : value;
        } else return undefined;
        return {
          response: {
            data,
            meta: {
              history_capture:
                mode === "capture" && method === "history.payload"
                  ? { ...capture, head: other }
                  : capture,
            },
          },
          pagination: null,
        };
      });
      const publishedLengths: number[] = [];
      const unsubscribe = h.controller.subscribe(() => {
        const payload = h.controller.get().payloads.get("sensor/2/payload");
        if (payload) publishedLengths.push(payload.bytes.length);
      });
      h.controller.select(h.context);
      if (mode === "valid") {
        await vi.waitFor(() => expect(h.controller.get().projections.size).toBe(2));
        const loaded = h.controller.get().payloads.get("sensor/2/payload");
        expect(loaded?.bytes).toEqual(bytes);
        expect(loaded?.complete).toBe(true);
        expect(loaded?.verified).toBe(true);
        expect(h.controller.get().projections.get("sensor/2/payload")?.status).toBe("recognized");
        expect([...new Set(publishedLengths)]).toEqual([bytes.length]);
        expect(h.calls.filter((call) => call.method === "history.payload")).toHaveLength(3);
        const first = current(h.controller.get().window)?.data.items[0];
        if (!first) throw new Error("fixture");
        // Inspecting an unrelated attachment/source must keep large messages paired.
        h.controller.expand(first, { kind: "searchable_text" });
        await vi.waitFor(() => expect(h.controller.get().expanding).toBe(false));
        expect(h.controller.get().payloads.get("sensor/2/payload")).toBe(loaded);
      } else {
        await vi.waitFor(() => expect(h.controller.get().payloadBatch.kind).toBe("failed"));
        expect(publishedLengths).toEqual([]);
        expect(h.controller.get().projections.size).toBe(0);
      }
      unsubscribe();
    },
  );

  it("cancels automatic continuations when leaving the session and ignores late bytes", async () => {
    let release: ((value: unknown) => void) | undefined;
    let signal: AbortSignal | undefined;
    const pending = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const h = harness((method, request) => {
      if (method !== "history.payload") return undefined;
      signal = request.signal;
      return pending;
    });
    h.controller.select(h.context);
    await vi.waitFor(() => expect(signal).toBeDefined());
    expect(h.controller.get().payloads.size).toBe(0);
    h.controller.select({ ...h.context, route: { ...h.context.route, entityId: null } });
    expect(signal?.aborted).toBe(true);
    release?.({
      response: { data: prefix(), meta: { history_capture: capture } },
      pagination: null,
    });
    await vi.waitFor(() => expect(h.controller.get().directory.kind).toBe("ready"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.controller.get().payloads.size).toBe(0);
    expect(h.controller.get().projections.size).toBe(0);
    expect(h.controller.get().unexpected).toBeNull();
  });

  it("retains an honest prefix above the automatic preview ceiling without allocating the blob", async () => {
    const blob = { digest: other, size_bytes: String(17 * 1024 * 1024) };
    const h = harness((method) => {
      let data: unknown;
      if (method === "history.read")
        data = {
          session_id: "sensor",
          through: "2",
          items: [
            event(),
            { ...event("2"), event: { ...event("2").event, payload: { kind: "blob", blob } } },
          ],
          has_more: false,
          next_anchor: "2",
          omitted_for_budget: "0",
        };
      else if (method === "history.payloads")
        data = {
          items: [
            { event_ref: event().event_ref, payload: prefix() },
            {
              event_ref: event("2").event_ref,
              payload: {
                blob,
                offset: "0",
                bytes_base64: "",
                next_offset: "0",
                total_bytes: blob.size_bytes,
                has_more: true,
              },
            },
          ],
        };
      else return undefined;
      return { response: { data, meta: { history_capture: capture } }, pagination: null };
    });
    h.controller.select(h.context);
    await vi.waitFor(() => expect(h.controller.get().projections.size).toBe(2));
    expect(h.controller.get().payloads.get("sensor/2/payload")).toMatchObject({
      complete: false,
      verified: false,
    });
    expect(h.calls.filter((call) => call.method === "history.payload")).toHaveLength(0);
  });

  it("follows current session events but keeps explicit history pins fixed", async () => {
    let newer = false;
    const h = harness((method, request) => {
      if (!newer) return undefined;
      const updated = {
        ...capture,
        head: other,
        sequence: "3",
        sessions: [{ session_id: "sensor", through: "3" }],
      };
      const params = request.body ? jsonField(request.body, "params") : undefined;
      const anchor = params && jsonField(params, "anchor");
      const refs = params && jsonField(params, "event_refs");
      const sequences =
        refs?.kind === "array"
          ? refs.items.map((r) => {
              const n = jsonField(r, "sequence");
              return n?.kind === "string" ? n.value : "";
            })
          : ["1", "2", "3"];
      const data =
        method === "session.list"
          ? { items: [metadata], next_offset: "1", has_more: false }
          : method === "session.get"
            ? { session: metadata, through: "3" }
            : method === "history.read"
              ? {
                  session_id: "sensor",
                  through: "3",
                  items:
                    anchor?.kind === "string" && anchor.value === "2"
                      ? [event("3")]
                      : [event(), event("2"), event("3")],
                  has_more: false,
                  next_anchor: "3",
                  omitted_for_budget: "0",
                }
              : method === "history.payloads"
                ? {
                    items: sequences.map((sequence) => ({
                      event_ref: { session_id: "sensor", sequence },
                      payload: prefix(),
                    })),
                  }
                : null;
      return { response: { data, meta: { history_capture: updated } }, pagination: null };
    });
    h.controller.select(h.context);
    await vi.waitFor(() => expect(h.controller.get().payloads.size).toBe(2));
    await vi.waitFor(() => expect(h.controller.get().projecting).toBe(false));
    h.controller.setFollowing(true);
    newer = true;
    await h.controller.refreshLive(new AbortController().signal);
    expect(current(h.controller.get().window)?.data.items.map((e) => e.event_ref.sequence)).toEqual(
      ["1", "2", "3"],
    );
    expect(h.controller.get().payloads.size).toBe(3);
    h.controller.select({
      ...h.context,
      route: { ...h.context.route, history: { generation: "1", head: other } },
    });
    await vi.waitFor(() => expect(h.controller.get().payloads.size).toBe(3));
    const old = h.controller.get().window,
      count = h.calls.filter((c) => c.method === "session.get").length;
    await h.controller.refreshLive(new AbortController().signal);
    expect(h.controller.get().window).toBe(old);
    expect(h.calls.filter((c) => c.method === "session.get")).toHaveLength(count);
  });
  it("keeps the reader's displayed window while current session metadata advances", async () => {
    let newer = false;
    const h = harness((method) => {
      if (!newer || method !== "session.get") return undefined;
      return {
        response: {
          data: { session: metadata, through: "3" },
          meta: {
            history_capture: {
              ...capture,
              head: other,
              sequence: "3",
              sessions: [{ session_id: "sensor", through: "3" }],
            },
          },
        },
        pagination: null,
      };
    });
    h.controller.select(h.context);
    await vi.waitFor(() => expect(h.controller.get().payloads.size).toBe(2));
    const previous = h.controller.get().window;
    const reads = h.calls.filter((c) => c.method === "history.read").length;
    h.controller.pauseFollowing();
    newer = true;
    const result = await h.controller.refreshLive(new AbortController().signal);
    expect(result.retainedCapture).toBe(true);
    expect(h.controller.get().followLatest).toBe(false);
    expect(h.controller.get().window).toBe(previous);
    expect(current(h.controller.get().session)?.data.through).toBe("3");
    expect(h.calls.filter((c) => c.method === "history.read")).toHaveLength(reads);
  });
  it("updates current-profile warning without replacing a retained session capture", async () => {
    const { controller, context, calls } = harness();
    const original = {
      ...context,
      route: { ...context.route, history: { generation: "1", head } },
    };
    controller.select(original);
    await vi.waitFor(() => expect(controller.get().payloads.size).toBe(2));
    const captured = controller.get();
    const count = calls.length;
    controller.select({
      ...original,
      connection: {
        ...context.connection,
        generation: decimal("2"),
        socket: "/tmp/replacement.sock",
      },
    });
    expect(controller.get().historicalGeneration).toBe(true);
    expect(controller.get().scope).toBe(captured.scope);
    expect(controller.get().session).toBe(captured.session);
    expect(controller.get().window).toBe(captured.window);
    expect(calls).toHaveLength(count);
    controller.select(original);
    expect(controller.get().historicalGeneration).toBe(false);
    expect(controller.get().session).toBe(captured.session);
  });

  it.each(["session.list", "session.get", "history.read", "history.payloads"])(
    "obsolete %s rejection does not replace the new selection",
    async (method) => {
      let reject: (reason: unknown) => void = () => {
        throw new Error("not pending");
      };
      let started = false;
      const pending = new Promise<never>((_, fail) => {
        reject = fail;
      });
      const { controller, context } = harness((name) => {
        if (name === method && !started) {
          started = true;
          return pending;
        }
        return undefined;
      });
      controller.select(context);
      await vi.waitFor(() => expect(started).toBe(true));
      controller.select({ ...context, route: { ...context.route, entityId: null } });
      await vi.waitFor(() => expect(controller.get().directory.kind).toBe("ready"));
      reject(new TypeError("obsolete transport defect"));
      await new Promise((done) => setTimeout(done, 20));
      expect(controller.get().unexpected).toBeNull();
      expect(controller.get().directory.kind).toBe("ready");
      expect(controller.get().session.kind).toBe("idle");
    },
  );
  it("same-query directory refresh owns its error independently of the selection epoch", async () => {
    let reject: (reason: unknown) => void = () => {
      throw new Error("not pending");
    };
    let count = 0;
    const pending = new Promise<never>((_, fail) => {
      reject = fail;
    });
    const { controller, context } = harness((method) => {
      if (method === "session.list" && ++count === 2) return pending;
      return undefined;
    });
    controller.select({ ...context, route: { ...context.route, entityId: null } });
    await vi.waitFor(() => expect(controller.get().directory.kind).toBe("ready"));
    controller.directory(controller.get().query);
    await vi.waitFor(() => expect(count).toBe(2));
    controller.directory(controller.get().query);
    await vi.waitFor(() => expect(controller.get().directory.kind).toBe("ready"));
    reject(new TypeError("obsolete same-query defect"));
    await new Promise((done) => setTimeout(done, 20));
    expect(controller.get().unexpected).toBeNull();
    expect(controller.get().directory.kind).toBe("ready");
  });
  it.each(["projection", "attach"] as const)(
    "obsolete %s rejection cannot poison a new route",
    async (kind) => {
      let reject!: (error: unknown) => void;
      const pending = new Promise<never>((_, fail) => {
        reject = fail;
      });
      let attached = false;
      const { controller, context, processing } = harness((method) => {
        if (method === "/connections/local/attach") {
          attached = true;
          return pending;
        }
        return undefined;
      });
      const project =
        kind === "projection"
          ? vi.spyOn(processing, "project").mockImplementationOnce(() => pending)
          : null;
      controller.select(
        kind === "attach"
          ? { ...context, route: { ...context.route, history: { generation: "2", head } } }
          : context,
      );
      await vi.waitFor(() =>
        expect(kind === "attach" ? attached : project?.mock.calls.length).toBeTruthy(),
      );
      controller.select({ ...context, route: { ...context.route, entityId: null } });
      await vi.waitFor(() => expect(controller.get().directory.kind).toBe("ready"));
      reject(new TypeError("obsolete asynchronous defect"));
      await new Promise((done) => setTimeout(done, 20));
      expect(controller.get().unexpected).toBeNull();
      expect(controller.get().payloads.size).toBe(0);
    },
  );
  it("current unexpected read errors remain visible in the owning slot", async () => {
    const defect = new TypeError("current directory defect");
    const { controller, context } = harness((method) => {
      if (method === "session.list") throw defect;
      return undefined;
    });
    controller.select({ ...context, route: { ...context.route, entityId: null } });
    await vi.waitFor(() => expect(controller.get().directory.kind).toBe("unexpected_error"));
    expect(controller.get().directory).toMatchObject({ error: defect });
  });

  it("does not transplant an old-generation session ID onto a retargeted current daemon", () => {
    const { controller, context, registered } = harness();
    const second = {
      ...context,
      connection: { ...context.connection, generation: decimal("2") },
      route: { ...context.route, history: { generation: "1", head } },
    };
    controller.newDraft(second, "archive", "sensor");
    expect(controller.get().draft).toBeNull();
    expect(controller.get().payloadFailure?.kind).toBe("input");
    controller.newDraft(second, "import", "sensor");
    expect(controller.get().draft).toBeNull();
    expect(registered).toHaveLength(0);
    controller.newDraft(second, "create");
    expect(controller.get().draft?.context.connection.generation).toBe("2");
  });
  it.each([
    ["batch", false],
    ["batch", true],
    ["expansion", false],
    ["expansion", true],
  ] as const)(
    "late %s digest failure (rejection=%s) cannot overwrite a new session selection",
    async (kind, rejects) => {
      const { controller, context } = harness();
      if (kind === "expansion") {
        controller.select(context);
        await vi.waitFor(() => expect(controller.get().payloads.size).toBe(2));
      }
      let release: ((digest: ArrayBuffer) => void) | undefined;
      let reject: ((reason: unknown) => void) | undefined;
      const pending = new Promise<ArrayBuffer>((resolve, fail) => {
        release = resolve;
        reject = fail;
      });
      const digest = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(() => pending);
      if (kind === "batch") controller.select(context);
      else {
        const event = current(controller.get().window)?.data.items[1];
        if (!event) throw new Error("fixture");
        controller.expand(event, { kind: "searchable_text" }, true);
      }
      await vi.waitFor(() => expect(digest).toHaveBeenCalled());
      controller.select({ ...context, route: { ...context.route, entityId: null } });
      if (rejects) reject?.(new TypeError("obsolete digest defect"));
      else release?.(new Uint8Array(32).buffer);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(controller.get().payloadFailure).toBeNull();
      expect(controller.get().unexpected).toBeNull();
      expect(controller.get().payloads.size).toBe(0);
    },
  );
  it("unexpected download rejection releases only its owned handle for a subsequent attempt", async () => {
    let calls = 0;
    const defect = new TypeError("unexpected transfer defect");
    const transfer: VerifiedTransfer = {
      download: () => {
        calls++;
        return calls === 1
          ? Promise.reject(defect)
          : Promise.resolve({ ok: false, kind: "input", message: "second attempt reached" });
      },
      dispose: () => {},
    };
    const { controller, context } = harness(undefined, transfer);
    controller.select(context);
    await vi.waitFor(() => expect(controller.get().payloads.size).toBe(2));
    const event = current(controller.get().window)?.data.items[0];
    if (!event) throw new Error("fixture");
    controller.download(event, { kind: "payload" });
    await vi.waitFor(() => expect(controller.get().unexpected?.error).toBe(defect));
    controller.download(event, { kind: "payload" });
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(controller.get().transfer).toEqual({
      kind: "failed",
      message: "second attempt reached",
    });
  });

  it("pins metadata, window and ordered payload batches; automatically completes an empty later prefix", async () => {
    const { controller, context, calls } = harness();
    controller.select(context);
    await vi.waitFor(() => expect(controller.get().payloads.size).toBe(2));
    const value = controller.get(),
      first = value.payloads.get("sensor/1/payload"),
      later = value.payloads.get("sensor/2/payload");
    expect(first?.verified).toBe(true);
    expect(first?.bytes).toEqual(text);
    expect(later?.complete).toBe(true);
    expect(later?.nextOffset).toBe(String(text.length));
    expect(later?.bytes).toEqual(text);
    for (const call of calls.filter(
      (call) =>
        call.method === "history.read" ||
        call.method === "history.payloads" ||
        call.method === "history.payload",
    )) {
      expect(call.params).toBeDefined();
      const params = call.params;
      expect(
        params && typeof params === "object" && "kind" in params
          ? jsonField(params, "head")
          : undefined,
      ).toEqual(d.jsonString(head));
    }
    expect(current(value.session)?.data.session.created_at_unix_ms).toBe("9007199254740993");
  });
  it("automatically continues an empty prefix at byte0 and verifies final bytes", async () => {
    const { controller, context, calls } = harness();
    controller.select(context);
    await vi.waitFor(() => expect(controller.get().payloads.size).toBe(2));
    const event = current(controller.get().window)?.data.items[1];
    if (!event) throw new Error("fixture");
    controller.expand(event, { kind: "searchable_text" }, true);
    await vi.waitFor(() =>
      expect(controller.get().payloads.get("sensor/2/payload")?.verified).toBe(true),
    );
    const read = calls.find((call) => call.method === "history.payload");
    expect(read?.params ? jsonField(read.params, "offset") : undefined).toEqual(d.jsonString("0"));
  });
  it("rejects missing/out-of-order batch items instead of treating them as empty payloads", async () => {
    const { controller, context } = harness((method) =>
      method === "history.payloads"
        ? {
            response: { data: { items: [] }, meta: { history_capture: capture } },
            pagination: null,
          }
        : undefined,
    );
    controller.select(context);
    await vi.waitFor(() => expect(controller.get().payloadBatch.kind).toBe("failed"));
    expect(controller.get().payloads.size).toBe(0);
  });
  it("does not silently retarget an unavailable exact event to current history", async () => {
    const { controller, context, calls } = harness();
    controller.select({
      ...context,
      route: { ...context.route, history: { generation: "1", head, sequence: "3" } },
    });
    await vi.waitFor(() => expect(controller.get().session.kind).toBe("failed"));
    expect(calls.filter((call) => call.method === "history.read")).toHaveLength(0);
  });
  it("rejects a mismatched capture and keeps the last captured bytes", async () => {
    let corrupt = false;
    const { controller, context } = harness((method) =>
      corrupt && method === "history.payload"
        ? {
            response: { data: prefix(), meta: { history_capture: { ...capture, head: other } } },
            pagination: null,
          }
        : undefined,
    );
    controller.select(context);
    await vi.waitFor(() => expect(controller.get().payloads.size).toBe(2));
    corrupt = true;
    const event = current(controller.get().window)?.data.items[1];
    if (!event) throw new Error("fixture");
    controller.expand(event, { kind: "searchable_text" });
    await vi.waitFor(() => expect(controller.get().payloadFailure?.kind).toBe("protocol"));
    expect(controller.get().payloads.get("sensor/1/payload")?.bytes).toEqual(text);
  });
  it("captures draft writer and scope across selection changes, and requires explicit new editor to retarget", async () => {
    const { controller, context, registered } = harness();
    controller.newDraft(context, "create");
    controller.editDraft({ sessionId: "created", title: "Created from original writer" });
    controller.select({
      ...context,
      writer: { actorId: "different", runId: "new-run" },
      route: { ...context.route, workspaceId: "another", entityId: null },
    });
    controller.newDraft(
      { ...context, writer: { actorId: "different", runId: null } },
      "archive",
      "sensor",
    );
    expect(controller.get().draft?.kind).toBe("create");
    await controller.reviewDraft();
    expect(registered).toHaveLength(1);
    expect(registered[0]?.context.writer.actor_id).toBe("original");
    expect(registered[0]?.context.workspace_id).toBe("demo");
    expect(jsonField(registered[0]!.params, "actor_id")).toEqual(d.jsonString("original"));
  });
  it("invalid local import remains editable, uses no fake daemon import method and sends no operation", async () => {
    const { controller, context, registered } = harness();
    controller.newDraft(context, "import", "sensor");
    controller.editDraft({ source: '{"not":"an event array"}' });
    await controller.reviewDraft();
    expect(controller.get().draft?.issue).toContain("current event-input");
    expect(controller.get().draft?.preparation).toBeNull();
    expect(registered).toEqual([]);
  });
  it("batches explicit current-format input objects at128 and retains exact values", async () => {
    const { controller, context, registered } = harness();
    controller.newDraft(context, "import", "sensor");
    controller.editDraft({
      source: JSON.stringify(
        Array.from({ length: 129 }, (_, index) => ({
          client_id: `e${index}`,
          role: "sensor",
          kind: "measurement",
          phase: "recorded",
          payload: { kind: "inline", bytes_base64: "AA==" },
        })),
      ),
    });
    await controller.reviewDraft();
    expect(controller.get().draft?.batches.map((batch) => batch.length)).toEqual([128, 1]);
    expect(registered[0]?.method).toBe("session.append");
    const events = jsonField(registered[0]!.params, "events");
    expect(events?.kind === "array" ? events.items.length : 0).toBe(128);
    controller.nextImportBatch();
    expect(controller.get().draft?.batchIndex).toBe(0);
  });
});
describe("strict current method codecs", () => {
  it("accepts nullable native timestamps up toInt64 without Number conversion", () =>
    expect(
      codecs.sessionRecord.decode(json({ ...metadata, created_at_unix_ms: "9223372036854775807" }))
        .ok,
    ).toBe(true));
  it.each([
    { ...capture, head: null },
    { ...capture, sessions: [...capture.sessions, ...capture.sessions] },
    { ...capture, sequence: "01" },
  ])("rejects malformed capture %j", (value) =>
    expect(codecs.historyCapture.decode(json(value)).ok).toBe(false),
  );
  it("payload continuation requires exact EOF semantics and total/blob agreement", () => {
    expect(codecs.payloadChunk.decode(json({ ...prefix(), has_more: true })).ok).toBe(false);
    expect(codecs.payloadChunk.decode(json({ ...prefix(), total_bytes: "0" })).ok).toBe(false);
  });
  it("sequence/counters stay validated and metadata roles are arbitrary strings", () => {
    expect(codecs.eventRecord.decode(json(event())).ok).toBe(true);
    expect(
      codecs.eventRecord.decode(
        json({ ...event(), event_ref: { session_id: "sensor", sequence: "0" } }),
      ).ok,
    ).toBe(false);
    expect(decimal("9007199254740993")).toBe("9007199254740993");
    expect(id("sensor")).toBe("sensor");
    expect(
      partKey(
        { session_id: id("sensor"), sequence: decimal("1") },
        { kind: "attachment", index: decimal("2") },
      ),
    ).toBe("sensor/1/attachment/2");
  });
});

describe("session directory continuity", () => {
  it("keeps the directory capture when opening and closing a session in the same workspace", async () => {
    const { controller, context, calls } = harness();
    controller.select(context);
    await vi.waitFor(() => expect(controller.get().directory.kind).toBe("ready"));
    const prior = current(controller.get().directory),
      reads = calls.filter((c) => c.method === "session.list").length;
    controller.select({ ...context, route: { ...context.route, entityId: null } });
    expect(current(controller.get().directory)).toBe(prior);
    expect(calls.filter((c) => c.method === "session.list")).toHaveLength(reads);
  });
  it("appends an exact directory continuation without losing the first page", async () => {
    let lists = 0;
    const { controller, context } = harness((method) => {
      if (method !== "session.list") return undefined;
      lists++;
      return {
        pagination: null,
        response: {
          data: {
            items: [{ ...metadata, session_id: lists === 1 ? "sensor" : "other" }],
            next_offset: String(lists),
            has_more: lists === 1,
          },
          meta: {
            history_capture: {
              ...capture,
              sessions: [...capture.sessions, { session_id: "other", through: "0" }],
            },
          },
        },
      };
    });
    controller.select({ ...context, route: { ...context.route, entityId: null } });
    await vi.waitFor(() => expect(controller.get().directory.kind).toBe("ready"));
    controller.directory(controller.get().query, true);
    await vi.waitFor(() => expect(current(controller.get().directory)?.data.items).toHaveLength(2));
    expect(current(controller.get().directory)?.data.items.map((i) => i.session_id)).toEqual([
      "sensor",
      "other",
    ]);
    expect(current(controller.get().directory)?.data.next_offset).toBe("2");
  });
});

describe("chronological transcript traversal", () => {
  function conversation(total = 125) {
    return harness((method, request) => {
      const params = request.body ? jsonField(request.body, "params") : undefined;
      const get = (key: string) => {
        const value = params && jsonField(params, key);
        return value?.kind === "string" ? value.value : "0";
      };
      const captured = {
        ...capture,
        sequence: String(total),
        sessions: [{ session_id: "sensor", through: String(total) }],
      };
      let data: unknown;
      if (method === "session.list")
        data = { items: [metadata], next_offset: "1", has_more: false };
      else if (method === "session.get") data = { session: metadata, through: String(total) };
      else if (method === "history.read") {
        expect(get("direction")).toBe("after");
        expect(get("limit")).toBe("60");
        const anchor = Number(get("anchor")),
          end = Math.min(anchor + 60, total);
        data = {
          session_id: "sensor",
          through: String(total),
          items: Array.from({ length: end - anchor }, (_, i) => event(String(anchor + i + 1))),
          has_more: end < total,
          next_anchor: String(end),
          omitted_for_budget: "0",
        };
      } else if (method === "history.payloads") {
        const refs = params && jsonField(params, "event_refs");
        if (refs?.kind !== "array") throw new Error("missing refs");
        expect(refs.items.length).toBeLessThanOrEqual(60);
        data = {
          items: refs.items.map((ref) => {
            const sequence = jsonField(ref, "sequence");
            if (sequence?.kind !== "string") throw new Error("missing sequence");
            return {
              event_ref: { session_id: "sensor", sequence: sequence.value },
              payload: prefix(),
            };
          }),
        };
      } else return undefined;
      return { response: { data, meta: { history_capture: captured } }, pagination: null };
    });
  }
  it("starts with 60 events, appends another page, and drains the captured remainder without dropping earlier bodies", async () => {
    const h = conversation();
    h.controller.select(h.context);
    await vi.waitFor(() => expect(h.controller.get().payloads.size).toBe(60));
    await vi.waitFor(() => expect(h.controller.get().projecting).toBe(false));
    expect(current(h.controller.get().window)?.data.items[0]?.event_ref.sequence).toBe("1");
    expect(h.controller.get().followLatest).toBe(false);
    const first = h.controller.get().payloads.get("sensor/1/payload");
    h.controller.loadMore();
    await vi.waitFor(() => expect(h.controller.get().payloads.size).toBe(120));
    await vi.waitFor(() => expect(h.controller.get().loadingMore).toBe(false));
    expect(h.controller.get().payloads.get("sensor/1/payload")).toBe(first);
    h.controller.loadMore(true);
    await vi.waitFor(() => expect(h.controller.get().payloads.size).toBe(125));
    expect(current(h.controller.get().window)?.data.items).toHaveLength(125);
  });
  it("cancels load-all when selection changes, without importing old events into the next scope", async () => {
    const h = conversation(200);
    h.controller.select(h.context);
    await vi.waitFor(() => expect(h.controller.get().payloads.size).toBe(60));
    await vi.waitFor(() => expect(h.controller.get().projecting).toBe(false));
    h.controller.loadMore(true);
    h.controller.select({ ...h.context, route: { ...h.context.route, entityId: null } });
    await vi.waitFor(() => expect(h.controller.get().window.kind).toBe("idle"));
    expect(h.controller.get().payloads.size).toBe(0);
    expect(h.controller.get().loadingMore).toBe(false);
  });
});
