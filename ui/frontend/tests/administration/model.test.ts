import { afterEach, describe, expect, it, vi } from "vitest";
import { parseJsonText, jsonField, stringifyJson, type JsonValue } from "../../src/core/json";
import * as d from "../../src/core/protocol/decoders";
import * as c from "../../src/core/protocol/codec";
import { createHttpClient } from "../../src/core/protocol/http";
import type { HttpClient, HttpRequest, HttpResult } from "../../src/core/protocol/http";
import type { Identifier, Preparation } from "../../src/core/protocol/types";
import type { ManagedOperation, OperationController } from "../../src/core/state/operations";
import { createTestProcessor } from "../core/processing-harness";
import { DraftInputError } from "../../src/features/connections/model";
import { createAdministrationController } from "../../src/features/administration/controller";
import {
  createAdministrationClient,
  localJobCodec,
  planJson,
} from "../../src/features/administration/client";
import { freezeDaemon, freezeLocal, retryCommand } from "../../src/features/administration/model";
import type {
  AdminAction,
  AdminSelection,
  LocalPlan,
} from "../../src/features/administration/types";

function json(source: string) {
  const result = parseJsonText(source);
  if (!result.ok) throw new Error(result.error.message);
  return result.value.value;
}
function decode<T>(codec: c.Codec<T>, value: JsonValue): T {
  const result = codec.decode(value);
  if (!result.ok) throw new Error(result.issue.expected);
  return result.value;
}
function id(value: string): Identifier {
  return decode(d.identifier, d.jsonString(value));
}
function encoded(value: JsonValue): string {
  const result = stringifyJson(value);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
const processors: ReturnType<typeof createTestProcessor>[] = [];
afterEach(() => {
  for (const processor of processors.splice(0)) processor.dispose();
  vi.useRealTimers();
});
function http(fetch?: typeof globalThis.fetch): HttpClient {
  const processing = createTestProcessor();
  processors.push(processing);
  return createHttpClient({
    origin: "http://127.0.0.1:1234",
    capability: "a".repeat(64),
    processing,
    ...(fetch === undefined
      ? {
          fetch: () => Promise.reject(new Error("Unexpected HTTP")),
        }
      : { fetch }),
  });
}
function selection(client = http()): AdminSelection {
  return {
    client,
    connection: decode(
      d.connectionProfile,
      json('{"id":"local","generation":"7","label":"Local","socket":"/tmp/original.sock"}'),
    ),
    current: true,
    route: {
      view: "overview",
      connectionId: "local",
      workspaceId: "selected",
      projectId: "project",
      entityId: null,
    },
    writer: { actorId: "original", runId: "original-run" },
  };
}
function object(value: JsonValue) {
  return decode(c.object, value);
}
function managed() {
  const entries = new Map<Identifier, ManagedOperation>(),
    sent: Preparation[] = [],
    actions: string[] = [];
  const controller: OperationController = {
    get: (id) => entries.get(id),
    list: () => [...entries.values()],
    subscribe: () => () => {},
    dispose: () => {},
    register: (preparation) => {
      sent.push(preparation);
      const entry: ManagedOperation = { preparation, operation: null, phase: { kind: "draft" } };
      entries.set(preparation.intention_id, entry);
      return Promise.resolve({ ok: true, entry });
    },
    adopt: () => Promise.reject(new Error("Unexpected adoption")),
    act: (id, action) => {
      actions.push(action);
      const entry = entries.get(id);
      if (!entry) throw new Error("Missing captured entry");
      return Promise.resolve({ ok: true, entry });
    },
  };
  return { controller, sent, actions };
}
function nativeJob(plan: LocalPlan, revision = "1", status = "prepared_unsent"): JsonValue {
  return d.jsonObject([
    ["plan", planJson(plan)],
    ["execution_action", jsonField(planJson(plan), "action") ?? d.jsonNull()],
    ["input_hash", d.jsonString("a".repeat(64))],
    ["revision", d.jsonString(revision)],
    ["cancel_requested", d.jsonBoolean(false)],
    ["state", d.jsonObject([["status", d.jsonString(status)]])],
    ["diagnostic", d.jsonNull()],
  ]);
}
function response(value: JsonValue) {
  const body = encoded(
    d.jsonObject([
      ["ok", d.jsonBoolean(true)],
      ["data", value],
    ]),
  );
  return new Response(body, {
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(body).length),
    },
  });
}
function replace(value: JsonValue, key: string, next: JsonValue) {
  const record = object(value);
  return d.jsonObject(
    record.fields.map((field) => [field.name, field.name === key ? next : field.value]),
  );
}

describe("administration capture and helper boundaries", () => {
  it("uses registry actor only while retaining selected run/project/workspace in audit context", () => {
    const context = selection();
    const actions: AdminAction[] = [
      { kind: "workspace_export", workspaceId: "target", destination: "/tmp/export" },
      { kind: "export_all", destination: "/tmp/all", allowPartial: true },
      { kind: "export_cancel", jobId: "job" },
      { kind: "export_retry", jobId: "job" },
      { kind: "workspace_restore", directory: "/tmp/export", root: "/tmp/restored" },
      { kind: "restore_cancel", targetActor: "first", targetMutation: "original" },
    ];
    for (const action of actions) {
      const frozen = freezeDaemon(context, action, id("test"));
      expect(frozen.kind).toBe("daemon");
      if (frozen.kind !== "daemon") throw new Error("capture");
      expect(frozen.preparation.context.writer.run_id).toBe("original-run");
      expect(jsonField(frozen.preparation.params, "actor_id")).toEqual(d.jsonString("original"));
      expect(jsonField(frozen.preparation.params, "run_id")).toBeUndefined();
      expect(jsonField(frozen.preparation.params, "mutation_id")).toBeUndefined();
      expect(new Set(frozen.preparation.params.fields.map((f) => f.name)).size).toBe(
        frozen.preparation.params.fields.length,
      );
    }
  });
  it("requires actor/current connection for daemon writes while offline observer needs neither", () => {
    const observer = { ...selection(), connection: null, writer: { actorId: null, runId: null } };
    expect(() =>
      freezeDaemon(
        observer,
        { kind: "export_all", destination: "/tmp/all", allowPartial: false },
        id("x"),
      ),
    ).toThrow(DraftInputError);
    expect(
      freezeLocal(
        observer,
        { kind: "migrate_0_6_2", source: "/old", destination: "/fresh" },
        id("x"),
      ).kind,
    ).toBe("local");
    expect(() =>
      freezeDaemon(
        { ...selection(), current: false },
        { kind: "export_cancel", jobId: "job" },
        id("x"),
      ),
    ).toThrow("current connection");
  });
  it("validates exact restore-all mapping without treating null, arrays, numbers or duplicate names as roots", async () => {
    const m = managed(),
      client = http(),
      controller = createAdministrationController({ http: client, operations: m.controller });
    for (const rootsSource of ['{"w":"/a","w":"/b"}', '{"w":9007199254740993}', "null", "[]"]) {
      const draft = controller.create(selection(client), "restore_all", {
        directory: "/export",
        rootsSource,
      });
      if (draft === null) throw new Error("fixture");
      await controller.review(draft);
      expect(controller.get().drafts.find((d) => d.id === draft)?.fields.rootsSource).toBe(
        rootsSource,
      );
      expect(controller.get().drafts.find((d) => d.id === draft)?.issue).not.toBeNull();
    }
    expect(m.sent).toHaveLength(0);
    controller.dispose();
  });
  it("preserves captured writer and endpoint when caller objects change before review; never executes", async () => {
    const m = managed(),
      client = http(),
      controller = createAdministrationController({ http: client, operations: m.controller });
    const writer = { actorId: "original", runId: "run-a" },
      route = { ...selection(client).route };
    const context = { ...selection(client), writer, route };
    const draft = controller.create(context, "workspace_export", {
      workspaceId: "target",
      destination: "/tmp/out",
    });
    if (draft === null) throw new Error("fixture");
    writer.actorId = "changed";
    writer.runId = "run-b";
    route.workspaceId = "different";
    await controller.review(draft);
    expect(m.sent[0]?.context).toEqual({
      workspace_id: "selected",
      project_id: "project",
      writer: { actor_id: "original", run_id: "run-a" },
    });
    expect(m.sent[0]?.generation).toBe("7");
    expect(m.actions).toEqual(["prepare"]);
    expect(controller.edit(draft, { destination: "/changed" })).toBe(false);
    controller.dispose();
  });
  it("coalesces concurrent Review and preserves frozen identity across exact preparation retries", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const m = managed(),
      base = m.controller;
    const operations: OperationController = {
      ...base,
      register: async (input) => {
        await gate;
        return base.register(input);
      },
    };
    const client = http(),
      controller = createAdministrationController({ http: client, operations });
    const draft = controller.create(selection(client), "export_cancel", { jobId: "job" });
    if (draft === null) throw new Error("fixture");
    const first = controller.review(draft),
      second = controller.review(draft);
    expect(first).toBe(second);
    expect(controller.edit(draft, { jobId: "changed" })).toBe(false);
    release?.();
    await first;
    await controller.review(draft);
    expect(m.sent).toHaveLength(2);
    expect(m.sent[0]).toEqual(m.sent[1]);
    expect(m.actions).toEqual(["prepare", "prepare"]);
    controller.dispose();
  });
  it("returns visible budget errors while retaining original text and bounded draft count", () => {
    const m = managed(),
      client = http(),
      controller = createAdministrationController({ http: client, operations: m.controller });
    const draft = controller.create(selection(client), "workspace_restore", { directory: "/kept" });
    if (draft === null) throw new Error("fixture");
    expect(controller.edit(draft, { directory: "x".repeat(2 * 1024 * 1024 + 1) })).toBe(false);
    expect(controller.get().drafts[0]?.fields.directory).toBe("/kept");
    expect(controller.get().drafts[0]?.issue).toContain("budget");
    expect(
      controller.create(selection(client), "restore_all", {
        rootsSource: "x".repeat(2 * 1024 * 1024 + 1),
      }),
    ).toBeNull();
    for (let i = 1; i < 16; i++)
      expect(controller.create(selection(client), "workspace_export")).not.toBeNull();
    expect(controller.create(selection(client), "workspace_export")).toBeNull();
    expect(controller.get().drafts).toHaveLength(16);
    controller.dispose();
  });
  it("shell-quotes exact socket/path; no envelope identity is reconstructed in external handoff", () => {
    expect(retryCommand("/tmp/socket ' one", "/tmp/request ' $x`cmd`.json")).toBe(
      "workgraph retry '/tmp/socket '\\'' one' '/tmp/request '\\'' $x`cmd`.json'",
    );
    expect(() => retryCommand("relative", "/valid")).toThrow(DraftInputError);
  });
  it("closed local DTOs reject unknown fields, invalid revisions and contradictory cancellation", () => {
    const frozen = freezeLocal(
      selection(),
      { kind: "migrate_0_6_2", source: "/old", destination: "/new" },
      id("local"),
    );
    if (frozen.kind !== "local") throw new Error("fixture");
    const valid = nativeJob(frozen.plan);
    expect(localJobCodec.decode(valid).ok).toBe(true);
    for (const value of [
      replace(valid, "revision", d.jsonString("0")),
      replace(valid, "revision", d.jsonString("01")),
      replace(valid, "cancel_requested", d.jsonBoolean(true)),
      d.jsonObject([
        ...object(valid).fields.map((f) => [f.name, f.value] as const),
        ["extra", d.jsonNull()],
      ]),
    ])
      expect(localJobCodec.decode(value).ok).toBe(false);
  });
  it("success DTO requires typed captured provenance and a report or explicit publication diagnostic", () => {
    const frozen = freezeLocal(
      selection(),
      { kind: "migrate_0_6_2", source: "/old", destination: "/new" },
      id("local"),
    );
    if (frozen.kind !== "local") throw new Error("fixture");
    const summary = json(
      '{"workspace_id":"w","source":"/old","destination":"/new","planning_revision":"0","planning_head":null,"source_history_head":null,"history_head":null,"from_release":"0.6.2","source_format":"5","source_history_format":"1","register_in_fresh_registry":true,"old_api_requests_supported":false,"history_head_count":"0"}',
    );
    const state = d.jsonObject([
      ["status", d.jsonString("succeeded")],
      ["summary", summary],
      [
        "report",
        d.jsonObject([
          ["path", d.jsonString("/private/admin-report-local.data")],
          ["sha256", d.jsonString("b".repeat(64))],
          ["byte_count", d.jsonString("12")],
        ]),
      ],
    ]);
    const valid = replace(nativeJob(frozen.plan), "state", state);
    expect(localJobCodec.decode(valid).ok).toBe(true);
    expect(
      localJobCodec.decode(
        replace(
          valid,
          "state",
          replace(state, "summary", replace(summary, "source", d.jsonString("/other"))),
        ),
      ).ok,
    ).toBe(false);
    expect(
      localJobCodec.decode(replace(valid, "state", replace(state, "report", d.jsonNull()))).ok,
    ).toBe(false);
  });
  it("binding rejects another plan before exposing native helper results", async () => {
    const frozen = freezeLocal(
      selection(),
      { kind: "migrate_0_6_2", source: "/old", destination: "/new" },
      id("local"),
    );
    if (frozen.kind !== "local") throw new Error("fixture");
    const changed = {
      ...frozen.plan,
      context: { ...frozen.plan.context, workspace_id: id("other") },
    };
    const client = http(() => Promise.resolve(response(nativeJob(changed))));
    const result = await createAdministrationClient(client).prepare(frozen.plan);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("binding");
    expect(result.failure.kind).toBe("protocol");
  });
  it("network failure after explicit local start retains original plan and never retries", async () => {
    const calls: string[] = [];
    let saved: LocalPlan | undefined;
    const client = http((input, init) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      calls.push(path);
      if (path.endsWith("/start")) return Promise.reject(new TypeError("connection lost"));
      if (typeof init?.body !== "string") throw new Error("Expected serialized request body");
      const request = json(init.body);
      saved = decode(
        c.record({
          intention_id: d.identifier,
          context: c.record({
            workspace_id: c.nullable(d.identifier),
            project_id: c.nullable(d.identifier),
            writer: c.nullable(
              c.record({ actor_id: d.identifier, run_id: c.nullable(d.identifier) }),
            ),
          }),
          action: c.record({
            kind: c.literal("migrate_0_6_2"),
            source: c.text,
            destination: c.text,
          }),
        }),
        request,
      );
      return Promise.resolve(response(nativeJob(saved)));
    });
    const m = managed(),
      controller = createAdministrationController({ http: client, operations: m.controller });
    const draft = controller.create({ ...selection(client), connection: null }, "migrate_0_6_2", {
      source: "/old",
      destination: "/new",
    });
    if (draft === null) throw new Error("fixture");
    await controller.review(draft);
    await controller.localAction(draft, "start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.filter((path) => path.endsWith("/start"))).toHaveLength(1);
    // The HTTP boundary intentionally uses its stable uncertainty message,
    // rather than exposing a browser-specific TypeError string.
    expect(controller.get().drafts[0]?.issue).toContain("Companion connection failed");
    expect(controller.get().drafts[0]?.frozen).toEqual({ kind: "local", plan: saved });
    expect(m.sent).toHaveLength(0);
    controller.dispose();
  });
  it("unexpected transport exceptions retain their identity rather than becoming ordinary validation failures", async () => {
    const error = new Error("unexpected implementation failure"),
      client = http(() => Promise.reject(error));
    const m = managed(),
      controller = createAdministrationController({ http: client, operations: m.controller });
    const draft = controller.create(selection(client), "migrate_0_6_2", {
      source: "/old",
      destination: "/new",
    });
    if (draft === null) throw new Error("fixture");
    await expect(controller.review(draft)).rejects.toBe(error);
    expect(controller.get().drafts[0]?.unexpected?.error).toBe(error);
    controller.dispose();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function localPlan() {
  const frozen = freezeLocal(
    selection(),
    { kind: "migrate_0_6_2", source: "/old", destination: "/new" },
    id("local"),
  );
  if (frozen.kind !== "local") throw new Error("fixture");
  return frozen.plan;
}
describe("administration observation ownership", () => {
  it("rejects same-revision state and diagnostic changes without losing the known observation", async () => {
    const m = managed(),
      client = http(),
      controller = createAdministrationController({ http: client, operations: m.controller });
    const plan = localPlan(),
      original = decode(localJobCodec, nativeJob(plan, "2", "running"));
    expect(await controller.adoptLocal(original)).toBe(true);
    const changedState = replace(
      nativeJob(plan, "2"),
      "state",
      json(
        '{"status":"outcome_unknown","problem":{"kind":"Outcome_unknown","message":"uncertain"}}',
      ),
    );
    expect(await controller.adoptLocal(decode(localJobCodec, changedState))).toBe(false);
    expect(controller.get().drafts[0]?.local).toBe(original);
    expect(controller.get().drafts[0]?.issue).toContain("without increasing its revision");
    const changedDiagnostic = replace(
      nativeJob(plan, "2", "running"),
      "diagnostic",
      json('{"kind":"Local_io","message":"new diagnostic","details":{"exact":9007199254740993}}'),
    );
    expect(await controller.adoptLocal(decode(localJobCodec, changedDiagnostic))).toBe(false);
    expect(controller.get().drafts[0]?.local).toBe(original);
    expect(
      await controller.adoptLocal(decode(localJobCodec, nativeJob(plan, "2", "running"))),
    ).toBe(true);
    controller.dispose();
  });
  it.each(["failure", "state"] as const)(
    "manual Inspect fences a superseded observer's late %s publication",
    async (kind) => {
      vi.useFakeTimers();
      const plan = localPlan(),
        late = deferred<HttpResult<JsonValue>>();
      const base = http();
      let reads = 0,
        oldSignal: AbortSignal | undefined;
      const client: HttpClient = {
        processing: base.processing,
        request: async <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
          if (request.method === "GET") {
            reads += 1;
            if (reads === 1) {
              oldSignal = request.signal;
              // Deliberately ignores cancellation, exercising the adapter's fence.
              const result = await late.promise;
              return result.ok ? { ...result, data: decode(request.codec, result.data) } : result;
            }
            return {
              ok: true,
              data: decode(request.codec, nativeJob(plan, "3", "running")),
              httpStatus: 200,
            };
          }
          return {
            ok: true,
            data: decode(request.codec, nativeJob(plan, "2", "running")),
            httpStatus: 202,
          };
        },
      };
      const m = managed(),
        controller = createAdministrationController({ http: client, operations: m.controller });
      await controller.adoptLocal(decode(localJobCodec, nativeJob(plan)));
      await controller.localAction(plan.intention_id, "start");
      await vi.advanceTimersByTimeAsync(150);
      expect(reads).toBe(1);
      await controller.localAction(plan.intention_id, "inspect");
      expect(oldSignal?.aborted).toBe(true);
      if (kind === "failure")
        late.resolve({
          ok: false,
          failure: { kind: "protocol", message: "superseded error", issue: undefined },
        });
      else
        late.resolve({
          ok: true,
          data: replace(
            nativeJob(plan, "4"),
            "state",
            json(
              '{"status":"failed","problem":{"kind":"Invalid_argument","message":"late state"}}',
            ),
          ),
          httpStatus: 200,
        });
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.get().drafts[0]?.local?.revision).toBe("3");
      expect(controller.get().drafts[0]?.local?.state.status).toBe("running");
      expect(controller.get().drafts[0]?.issue).toBeNull();
      controller.dispose();
    },
  );
  it("discard and reload give the same saved identity a new observation owner", async () => {
    vi.useFakeTimers();
    const plan = localPlan(),
      late = deferred<HttpResult<JsonValue>>(),
      base = http();
    const client: HttpClient = {
      processing: base.processing,
      request: async <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
        if (request.method === "GET") {
          const result = await late.promise;
          return result.ok ? { ...result, data: decode(request.codec, result.data) } : result;
        }
        return {
          ok: true,
          data: decode(request.codec, nativeJob(plan, "2", "running")),
          httpStatus: 202,
        };
      },
    };
    const m = managed(),
      controller = createAdministrationController({ http: client, operations: m.controller });
    await controller.adoptLocal(decode(localJobCodec, nativeJob(plan)));
    await controller.localAction(plan.intention_id, "start");
    await vi.advanceTimersByTimeAsync(150);
    expect(controller.discard(plan.intention_id)).toBe(true);
    await controller.adoptLocal(decode(localJobCodec, nativeJob(plan, "3", "running")));
    late.resolve({ ok: false, failure: { kind: "network", message: "old owner's failure" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.get().drafts[0]?.local?.revision).toBe("3");
    expect(controller.get().drafts[0]?.issue).toBeNull();
    controller.dispose();
  });
});
