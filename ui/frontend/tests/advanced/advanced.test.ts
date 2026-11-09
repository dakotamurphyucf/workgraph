import { createTestProcessor } from "../core/processing-harness";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import catalogue from "./catalogue.fixture.json";
import { catalogCodec, methodCodec } from "../../src/features/advanced/catalog";
import { fieldType } from "../../src/features/advanced/fields";
import { editedParams, parseObject, encode } from "../../src/features/advanced/parameters";
import { createAdvancedController, continuation } from "../../src/features/advanced/controller";
import { fieldChoiceKind, matchesChoiceScope } from "../../src/features/advanced/design-model";
import { HOST_SURFACES } from "../../src/features/advanced/extras";
import type { FieldDescriptor, MethodContract } from "../../src/features/advanced/types";
import type { FeatureContext } from "../../src/app/types";
import { parseJsonText, stringifyJson, type JsonValue } from "../../src/core/json";
import * as d from "../../src/core/protocol/decoders";
import type { Codec } from "../../src/core/protocol/codec";
import type { HttpClient, HttpRequest, HttpResult } from "../../src/core/protocol/http";
import type { Companion } from "../../src/core/protocol/client";
import type { Identifier, Operation, ReadResponse } from "../../src/core/protocol/types";
import { createOperationController } from "../../src/core/state/operations";
const controllers = new Set<import("../../src/features/advanced").AdvancedController>();
afterEach(() => {
  for (const controller of controllers) controller.dispose();
  controllers.clear();
});
function json(source: string): JsonValue {
  const r = parseJsonText(source);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.value;
}
function formatJson(value: JsonValue): string {
  const result = stringifyJson(value);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function decode<T>(codec: Codec<T>, value: JsonValue): T {
  const r = codec.decode(value);
  if (!r.ok) throw new Error(r.issue.path.join(".") + ": " + r.issue.expected);
  return r.value;
}
const encoded = (value: unknown) => json(JSON.stringify(value));
const ok = <T>(data: T): HttpResult<T> => ({ ok: true, data, httpStatus: 200 });
const cat = decode(catalogCodec, encoded(catalogue));
function field(name: string, type = "string"): FieldDescriptor {
  return {
    name,
    requirement: "optional",
    schema: json(`{"allOf":[{"type":"${type}"}]}`),
    summary: type,
    descriptions: [],
    json_argument: [],
  };
}
function contract(
  name = "daemon.health",
  mode: "read" | "write" | "mutation" = "read",
): MethodContract {
  return {
    method: {
      name,
      mode,
      tier: "core",
      summary: "Synthetic test method",
      params: json("{}"),
      result: json("{}"),
    },
    help: "Synthetic help",
    fields: {
      method: name,
      summary: "Test",
      schema_dialect: "https://json-schema.org/draft/2020-12/schema",
      guidance: "Native validation is authoritative.",
      fields: [
        field("actor_id"),
        field("workspace_id"),
        field("run_id"),
        field("value", "integer"),
      ],
      validation_schema: json("{}"),
    },
  };
}
function contractJson(value: MethodContract): JsonValue {
  return d.jsonObject([
    [
      "method",
      d.jsonObject([
        ["name", d.jsonString(value.method.name)],
        ["mode", d.jsonString(value.method.mode)],
        ["tier", d.jsonString(value.method.tier)],
        ["summary", d.jsonString(value.method.summary)],
        ["params", value.method.params],
        ["result", value.method.result],
      ]),
    ],
    ["help", d.jsonString(value.help)],
    [
      "fields",
      d.jsonObject([
        ["method", d.jsonString(value.fields.method)],
        ["summary", d.jsonString(value.fields.summary)],
        ["schema_dialect", d.jsonString(value.fields.schema_dialect)],
        ["guidance", d.jsonString(value.fields.guidance)],
        ["validation_schema", value.fields.validation_schema],
        [
          "fields",
          d.jsonArray(
            value.fields.fields.map((f) =>
              d.jsonObject([
                ["name", d.jsonString(f.name)],
                ["requirement", d.jsonString(f.requirement)],
                ["summary", d.jsonString(f.summary)],
                ["descriptions", d.jsonArray(f.descriptions.map(d.jsonString))],
                ["json_argument", d.jsonArray(f.json_argument.map(d.jsonString))],
                ["schema", f.schema],
              ]),
            ),
          ),
        ],
      ]),
    ],
  ]);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let processing: import("../../src/core/protocol/worker").ProtocolProcessor;
beforeEach(() => {
  processing = createTestProcessor();
});
afterEach(() => {
  processing.dispose();
});
function fakeHttp(
  route: (request: HttpRequest<unknown>) => JsonValue | Promise<JsonValue>,
  processor = processing,
): HttpClient {
  return {
    processing: processor,
    async request<T>(request: HttpRequest<T>): Promise<HttpResult<T>> {
      return ok(decode(request.codec, await route(request)));
    },
  };
}
function setup(
  options: {
    route?: (request: HttpRequest<unknown>) => JsonValue | Promise<JsonValue>;
    companion?: Partial<Companion>;
    processing?: import("../../src/core/protocol/worker").ProtocolProcessor;
  } = {},
) {
  const calls: HttpRequest<unknown>[] = [],
    stored = new Map<Identifier, Operation>();
  let serial = 0;
  const unexpected = (): never => {
    throw new Error("Unexpected companion call");
  };
  const companion: Companion = {
    connections: unexpected,
    read: unexpected,
    inspect: (id) => {
      const op = stored.get(id);
      if (!op) throw new Error("Missing test operation");
      return Promise.resolve(ok(op));
    },
    prepare: (p) => {
      const op: Operation = {
        format: "workgraph-ui-operation-1",
        operation_id: p.intention_id,
        preparation: { ...p, connection: profile },
        preparation_input_hash: decode(d.digest, d.jsonString("a".repeat(64))),
        connection: profile,
        request: d.jsonObject([
          ["jsonrpc", d.jsonString("2.0")],
          ["workgraph_api", d.jsonString("0.7")],
          ["id", d.jsonString("synthetic")],
          ["method", d.jsonString(p.method)],
          ["params", p.params],
        ]),
        journal_path: `/tmp/synthetic-${p.intention_id}.json`,
        revision: decode(d.positiveDecimal, d.jsonString("1")),
        state: { kind: "prepared_unsent" },
        diagnostic: null,
        receipt_lookup_supported: true,
      };
      stored.set(p.intention_id, op);
      return Promise.resolve(ok(op));
    },
    act: (id) => {
      const op = stored.get(id);
      if (!op) throw new Error("Missing test operation");
      const done: Operation = {
        ...op,
        revision: decode(d.positiveDecimal, d.jsonString("2")),
        state: { kind: "committed", response: { data: json("{}"), meta: d.jsonObject([]) } },
      };
      stored.set(id, done);
      return Promise.resolve(ok(done));
    },
    ...options.companion,
  };
  const operations = createOperationController(companion, options.processing ?? processing);
  const client = fakeHttp((request) => {
    calls.push(request);
    if (options.route) return options.route(request);
    if (request.path === "/catalog") return encoded(catalogue);
    if (request.path.startsWith("/methods/")) {
      const name = decodeURIComponent(request.path.slice(9));
      return contractJson(contract(name, name === "ticket.create" ? "mutation" : "read"));
    }
    return encoded({
      response: { data: { answer: "real in browser; synthetic in unit" }, meta: {} },
      pagination: null,
    });
  }, options.processing ?? processing);
  const controller = createAdvancedController({
    client,
    operations,
    newId: () => `draft-${++serial}`,
  });
  controllers.add(controller);
  return { controller, operations, client, calls, stored, context: () => context(client) };
}
const profile = decode(
  d.connectionProfile,
  json(
    '{"id":"local","generation":"1","label":"Synthetic local","socket":"/tmp/synthetic-daemon.sock"}',
  ),
);
function context(client: HttpClient): FeatureContext {
  return {
    client,
    connection: profile,
    profileState: "current",
    route: {
      view: "advanced",
      connectionId: "local",
      workspaceId: "work",
      projectId: "project",
      entityId: null,
    },
    writer: { actorId: "rowan", runId: "run-1" },
    navigate: () => {},
  };
}
async function newDraft(s: ReturnType<typeof setup>, name = "daemon.health") {
  await s.controller.selectMethod(name);
  const id = s.controller.createDraft(s.context());
  if (id === null) throw new Error("No draft");
  await s.controller.validateParameters(id);
  return id;
}
function current(s: ReturnType<typeof setup>, id: Identifier) {
  const draft = s.controller.get().drafts.find((d) => d.id === id);
  if (!draft) throw new Error("No current draft");
  return draft;
}
describe("executable catalogue and dispositions", () => {
  it("covers all269 methods and all44 helper/workflow/host dispositions without embedding method schemas", () => {
    expect(cat.methods).toHaveLength(269);
    expect(cat.helpers).toHaveLength(23);
    expect(cat.workflows).toHaveLength(9);
    expect(HOST_SURFACES).toHaveLength(12);
    expect(
      new Set([...cat.helpers, ...cat.workflows, ...HOST_SURFACES].map((e) => e.name)).size,
    ).toBe(44);
    for (const method of cat.methods) {
      expect(["read", "write", "mutation"]).toContain(method.mode);
      expect(method.summary.length).toBeGreaterThan(0);
      expect(Object.keys(method).sort()).toEqual(["mode", "name", "summary", "tier"]);
    }
    for (const e of HOST_SURFACES) {
      expect(e.command.length).toBeGreaterThan(0);
      expect(e.guidance.length).toBeGreaterThan(0);
    }
    expect(cat.capabilities).toHaveLength(8);
  });
  it("rejects unknown DTO fields, duplicated entries, method drift and wrong discriminators", () => {
    expect(catalogCodec.decode(encoded({ ...catalogue, extra: true })).ok).toBe(false);
    expect(
      catalogCodec.decode(
        encoded({ ...catalogue, methods: [...catalogue.methods, catalogue.methods[0]] }),
      ).ok,
    ).toBe(false);
    expect(
      catalogCodec.decode(
        encoded({
          ...catalogue,
          methods: [{ name: "x", mode: "execute", tier: "core", summary: "x" }],
        }),
      ).ok,
    ).toBe(false);
    expect(methodCodec("ticket.create").decode(contractJson(contract())).ok).toBe(false);
    const original = contract();
    expect(
      methodCodec(original.method.name).decode(
        encoded({ ...original, fields: { ...original.fields, fields: [field("x"), field("x")] } }),
      ).ok,
    ).toBe(false);
  });
});
describe("lossless field editing", () => {
  it("preserves unknown raw fields, huge numeric lexemes, omitted/null/empty and nested values", async () => {
    const source = '{ "unknown": {"x":9007199254740993,"float":1e400}, "value":2 }',
      signal = new AbortController().signal;
    const decoded = await parseObject(processing, source, contract(), signal);
    if (!decoded.ok) throw new Error(decoded.message);
    const params = decoded.value.params;
    expect(
      await editedParams(
        processing,
        params,
        field("value", "integer"),
        { presence: "value", text: "90071992547409931234567890" },
        signal,
      ),
    ).toEqual({
      ok: true,
      value: '{"unknown":{"x":9007199254740993,"float":1e400},"value":90071992547409931234567890}',
    });
    const nullish = await editedParams(
      processing,
      params,
      field("value"),
      { presence: "null", text: "" },
      signal,
    );
    expect(nullish.ok && nullish.value).toContain('"value":null');
    const empty = await editedParams(
      processing,
      params,
      field("value"),
      { presence: "value", text: "" },
      signal,
    );
    expect(empty.ok && empty.value).toContain('"value":""');
    const omitted = await editedParams(
      processing,
      params,
      field("value"),
      { presence: "omit", text: "" },
      signal,
    );
    expect(omitted.ok && omitted.value).not.toContain('"value"');
    expect(fieldType(field("nested"))).toBe("string");
    const parsed = await parseObject(processing, '{"value":null}', contract(), signal);
    expect(parsed.ok && parsed.value.inputs.value?.presence).toBe("null");
  });
  it("rejects invalid integer/boolean source, duplicate names, arrays and malformed source without replacing the input", async () => {
    const signal = new AbortController().signal;
    expect(
      (
        await editedParams(
          processing,
          d.jsonObject([]),
          field("value", "integer"),
          { presence: "value", text: "1.5" },
          signal,
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await editedParams(
          processing,
          d.jsonObject([]),
          field("value", "boolean"),
          { presence: "value", text: '"true"' },
          signal,
        )
      ).ok,
    ).toBe(false);
    for (const source of ['{"x":1,"x":2}', "[]", "{"])
      expect((await parseObject(processing, source, contract(), signal)).ok).toBe(false);
  });
});
describe("application-owned advanced drafts", () => {
  it("captures endpoint generation, writer and scope, independently of later selection and directory refresh", async () => {
    const s = setup();
    await s.controller.selectMethod("ticket.create");
    const c = s.context();
    const id = s.controller.createDraft(c);
    if (!id) throw new Error("No draft");
    const next = {
      ...c,
      connection: { ...profile, generation: decode(d.positiveDecimal, d.jsonString("2")) },
      writer: { actorId: "mira", runId: null },
      profileState: "refreshing" as const,
    };
    expect(s.controller.createDraft(next)).toBeNull();
    expect(current(s, id).selection.actorId).toBe("rowan");
    expect(current(s, id).selection.connection.generation).toBe("1");
    expect(s.controller.editSource(id, '{ "value":9007199254740993 }')).toBe(true);
    await s.controller.prepare(id);
    expect(s.operations.get(id)?.preparation.context.writer.actor_id).toBe("rowan");
    expect(s.operations.get(id)?.preparation.generation).toBe("1");
    expect(formatJson(s.operations.get(id)!.preparation.params)).toContain("9007199254740993");
    expect(s.controller.editSource(id, "{}")).toBe(false);
    const clone = s.controller.cloneDraft(id);
    expect(clone && current(s, clone).selection.actorId).toBe("rowan");
  });
  it("retains invalid staged field text across subscriptions and blocks read/prepare until explicitly applied or discarded", async () => {
    const s = setup(),
      id = await newDraft(s);
    expect(s.controller.stageField(id, "value", { presence: "value", text: "1e" })).toBe(true);
    const stop = s.controller.subscribe(() => {});
    stop();
    expect(current(s, id).fieldEdits.value?.text).toBe("1e");
    expect(await s.controller.applyField(id, "value")).toBe(false);
    expect(current(s, id).fieldErrors.value).toBeTruthy();
    await s.controller.runRead(id);
    expect(s.calls.filter((c) => c.path === "/read")).toHaveLength(0);
    expect(s.controller.editSource(id, "{}")).toBe(false);
    s.controller.stageField(id, "value", { presence: "value", text: "9007199254740993" });
    expect(await s.controller.applyField(id, "value")).toBe(true);
    expect(current(s, id).source).toBe('{"value":9007199254740993}');
    await s.controller.runRead(id);
    expect(s.calls.filter((c) => c.path === "/read")).toHaveLength(1);
    const write = await newDraft(s, "ticket.create");
    s.controller.stageField(write, "value", { presence: "null", text: "" });
    expect(await s.controller.prepare(write)).toBeNull();
    expect(s.operations.get(write)).toBeUndefined();
    s.controller.discardFieldEdits(write);
    expect((await s.controller.prepare(write))?.ok).toBe(true);
  });
  it("enforces the same aggregate byte budget for clones and staged field allocations", async () => {
    const s = setup(),
      id = await newDraft(s);
    const source = '{"text":"' + "x".repeat(3 * 1024 * 1024) + '"}';
    expect(s.controller.editSource(id, source)).toBe(true);
    for (let i = 0; i < 4; i++) expect(s.controller.cloneDraft(id)).not.toBeNull();
    expect(s.controller.get().drafts).toHaveLength(5);
    expect(s.controller.cloneDraft(id)).toBeNull();
    expect(
      s.controller.stageField(id, "value", {
        presence: "value",
        text: "x".repeat(2 * 1024 * 1024),
      }),
    ).toBe(false);
    expect(s.controller.get().drafts).toHaveLength(5);
  });
  it("bounds active editor count", async () => {
    const s = setup();
    await s.controller.selectMethod("daemon.health");
    for (let i = 0; i < 32; i++) expect(s.controller.createDraft(s.context())).not.toBeNull();
    expect(s.controller.createDraft(s.context())).toBeNull();
  });
  it("can complete and close65 sequential write editors while preserving every saved identity and recovery entry", async () => {
    const s = setup();
    await s.controller.selectMethod("ticket.create");
    const ids: Identifier[] = [];
    for (let i = 0; i < 65; i++) {
      const id = s.controller.createDraft(s.context());
      if (!id) throw new Error("Editor capacity exhausted");
      ids.push(id);
      expect((await s.controller.prepare(id))?.ok).toBe(true);
      expect((await s.controller.act(id, "execute")).ok).toBe(true);
      expect(s.controller.discardDraft(id)).toBe(true);
    }
    expect(s.controller.get().drafts).toHaveLength(0);
    expect(s.operations.list()).toHaveLength(65);
    for (const id of ids) {
      expect(s.operations.get(id)?.operation?.state.kind).toBe("committed");
      expect(s.operations.get(id)?.operation?.journal_path).toContain(id);
    }
    expect((await s.controller.act(ids[0]!, "inspect")).ok).toBe(true);
  });
  it("publishes new snapshots for pending and observed shared operations and keeps uncertain intentions after editor close", async () => {
    const response = deferred<HttpResult<Operation>>();
    const s = setup({ companion: { act: () => response.promise } }),
      id = await newDraft(s, "ticket.create");
    await s.controller.prepare(id);
    const before = s.controller.get();
    const action = s.controller.act(id, "execute");
    await Promise.resolve();
    expect(s.controller.get()).not.toBe(before);
    expect(s.operations.get(id)?.phase.kind).toBe("pending");
    expect(s.controller.discardDraft(id)).toBe(true);
    response.resolve({ ok: false, failure: { kind: "network", message: "Lost reply" } });
    expect((await action).ok).toBe(false);
    expect(s.operations.get(id)?.phase.kind).toBe("unconfirmed");
    expect(s.operations.get(id)?.preparation.context.writer.actor_id).toBe("rowan");
  });
  it("aborts superseded method lookup, ignores a late transport, and owns unexpected read errors", async () => {
    const slow = deferred<JsonValue>();
    const s = setup({
      route: (request) =>
        request.path.endsWith("daemon.health")
          ? slow.promise
          : contractJson(contract("ticket.create", "mutation")),
    });
    const first = s.controller.selectMethod("daemon.health"),
      second = s.controller.selectMethod("ticket.create");
    await second;
    expect(s.calls[0]?.signal?.aborted).toBe(true);
    slow.resolve(contractJson(contract()));
    expect(await first).toEqual({ ok: false, superseded: true });
    expect(s.controller.get().contract.kind).toBe("ready");
    const boom = new Error("Unexpected programming failure");
    const r = setup({
        route: (request) => {
          if (request.path.startsWith("/methods/")) return contractJson(contract());
          throw boom;
        },
      }),
      id = await newDraft(r);
    await expect(r.controller.runRead(id)).rejects.toBe(boom);
    expect(current(r, id).read.kind).toBe("unexpected_error");
  });
  it.each(["catalog", "method"] as const)(
    "suppresses obsolete %s lookup rejection",
    async (kind) => {
      const slow = deferred<JsonValue>();
      let calls = 0;
      const s = setup({
        route: () =>
          ++calls === 1
            ? slow.promise
            : kind === "catalog"
              ? encoded(catalogue)
              : contractJson(contract()),
      });
      const start = () =>
        kind === "catalog"
          ? s.controller.loadCatalog()
          : s.controller.selectMethod("daemon.health");
      const first = start();
      const observed = first.then(
        (value) => value,
        () => "rejected",
      );
      await start();
      slow.reject(new TypeError("obsolete lookup defect"));
      expect(await observed).toEqual({ ok: false, superseded: true });
      expect(s.controller.get()[kind === "catalog" ? "catalog" : "contract"].kind).toBe("ready");
    },
  );
  it("does not rethrow an obsolete read rejection into the active component boundary", async () => {
    const reply = deferred<JsonValue>();
    const s = setup({
      route: (request) => (request.path === "/read" ? reply.promise : contractJson(contract())),
    });
    const id = await newDraft(s);
    const read = s.controller.runRead(id);
    const observed = read.then(
      () => "settled",
      () => "rejected",
    );
    await vi.waitFor(() => expect(s.calls.at(-1)?.path).toBe("/read"));
    s.controller.editSource(id, '{"different":1}');
    reply.reject(new TypeError("obsolete advanced defect"));
    expect(await observed).toBe("settled");
    expect(current(s, id).read.kind).toBe("idle");
  });
  it("cancels an in-flight read on edit and rejects a late stale observation", async () => {
    const reply = deferred<JsonValue>();
    const s = setup({
        route: (request) => (request.path === "/read" ? reply.promise : contractJson(contract())),
      }),
      id = await newDraft(s);
    const read = s.controller.runRead(id);
    await vi.waitFor(() => expect(s.calls.at(-1)?.path).toBe("/read"));
    expect(s.controller.editSource(id, '{"different":1}')).toBe(true);
    expect(s.calls.at(-1)?.signal?.aborted).toBe(true);
    reply.resolve(encoded({ response: { data: { stale: true }, meta: {} }, pagination: null }));
    await read;
    expect(current(s, id).read.kind).toBe("idle");
  });
  it("follows only validated Read continuation method/params on the original generation, preserving opaque captures and exact numbers", async () => {
    const next = json(
      '{"jsonrpc":"2.0","workgraph_api":"0.7","id":"next","method":"history.read","params":{"head":"capture","after_seq":"3","limit":9007199254740993}}',
    );
    const page: ReadResponse = {
      response: { data: json("[]"), meta: d.jsonObject([]) },
      pagination: d.jsonObject([["next_request", next]]),
    };
    expect(continuation(page, "next_request", cat)?.params).toEqual(
      decode(
        {
          decode: (v) =>
            v?.kind === "object"
              ? { ok: true, value: v }
              : { ok: false, issue: { path: [], expected: "object" } },
        },
        json('{"head":"capture","after_seq":"3","limit":9007199254740993}'),
      ),
    );
    const s = setup({
      route: (request) =>
        request.path === "/catalog"
          ? encoded(catalogue)
          : request.path.startsWith("/methods/")
            ? contractJson(contract())
            : d.jsonObject([
                [
                  "response",
                  d.jsonObject([
                    ["data", page.response.data],
                    ["meta", page.response.meta],
                  ]),
                ],
                ["pagination", page.pagination!],
              ]),
    });
    await s.controller.loadCatalog();
    const id = await newDraft(s);
    await s.controller.runRead(id);
    await s.controller.continueRead(id, "next_request");
    const request = s.calls.at(-1);
    expect(request?.body && formatJson(request.body)).toContain('"generation":"1"');
    expect(request?.body && formatJson(request.body)).toContain('"limit":9007199254740993');
    for (const method of ["ticket.create", "made.up"]) {
      const bad = {
        ...page,
        pagination: d.jsonObject([
          [
            "next_request",
            d.jsonObject([
              ["jsonrpc", d.jsonString("2.0")],
              ["workgraph_api", d.jsonString("0.7")],
              ["id", d.jsonString("next")],
              ["method", d.jsonString(method)],
              ["params", d.jsonObject([])],
            ]),
          ],
        ]),
      };
      expect(continuation(bad, "next_request", cat)).toBeNull();
    }
    expect(
      continuation(
        {
          ...page,
          pagination: d.jsonObject([
            [
              "next_request",
              json(
                '{"jsonrpc":"2.0","workgraph_api":"0.7","id":{},"method":"daemon.health","params":{}}',
              ),
            ],
          ]),
        },
        "next_request",
        cat,
      ),
    ).toBeNull();
  });
});

describe("worker ownership and awaited admission", () => {
  it("ignores an aborted late parse and retains the new exact source", async () => {
    const late = deferred<Awaited<ReturnType<typeof processing.parse>>>();
    let started = false;
    let signal: AbortSignal | undefined;
    const processor = {
      ...processing,
      parse: (
        source: string | Uint8Array,
        options?: import("../../src/core/protocol/worker").ProcessingOptions,
      ) => {
        if (source === '{"value":1}') {
          started = true;
          signal = options?.signal;
          return late.promise;
        }
        return processing.parse(source, options);
      },
    };
    const s = setup({ processing: processor }),
      id = await newDraft(s);
    s.controller.editSource(id, '{"value":1}');
    await vi.waitFor(() => expect(started).toBe(true));
    s.controller.editSource(id, '{ "value":9007199254740993 }');
    expect(await s.controller.validateParameters(id)).toBe(true);
    expect(signal?.aborted).toBe(true);
    late.resolve(await processing.parse('{"value":1}'));
    await Promise.resolve();
    expect(current(s, id).source).toBe('{ "value":9007199254740993 }');
    const state = current(s, id).parameters;
    expect(state.kind === "ready" && formatJson(state.value.params)).toContain("9007199254740993");
  });
  it("does not overwrite a newer staged field when old worker encoding completes", async () => {
    const late = deferred<Awaited<ReturnType<typeof processing.encode>>>();
    let started = false;
    let signal: AbortSignal | undefined;
    const processor = {
      ...processing,
      encode: (value: JsonValue, options?: Parameters<typeof processing.encode>[1]) => {
        if (
          value.kind === "object" &&
          value.fields.some(
            (f) => f.name === "value" && f.value.kind === "number" && f.value.lexeme === "1",
          )
        ) {
          started = true;
          signal = options?.signal;
          return late.promise;
        }
        return processing.encode(value, options);
      },
    };
    const s = setup({ processing: processor }),
      id = await newDraft(s);
    s.controller.stageField(id, "value", { presence: "value", text: "1" });
    const apply = s.controller.applyField(id, "value");
    await vi.waitFor(() => expect(started).toBe(true));
    s.controller.stageField(id, "value", { presence: "value", text: "2" });
    expect(signal?.aborted).toBe(true);
    late.resolve(await processing.encode(json('{"value":1}')));
    expect(await apply).toBe(false);
    expect(current(s, id).source).toBe("{}");
    expect(current(s, id).fieldEdits.value?.text).toBe("2");
    expect(await s.controller.applyField(id, "value")).toBe(true);
    expect(current(s, id).source).toBe('{"value":2}');
  });
  it("keeps outer worker capacity failures explicit and preserves source for retry", async () => {
    let fail = true;
    const processor = {
      ...processing,
      parse: (
        source: string | Uint8Array,
        options?: import("../../src/core/protocol/worker").ProcessingOptions,
      ) =>
        source === '{"value":3}' && fail
          ? Promise.resolve({
              ok: false as const,
              failure: { kind: "busy" as const, message: "Synthetic capacity limit" },
            })
          : processing.parse(source, options),
    };
    const s = setup({ processing: processor }),
      id = await newDraft(s);
    s.controller.editSource(id, '{"value":3}');
    expect(await s.controller.validateParameters(id)).toBe(false);
    expect(current(s, id).source).toBe('{"value":3}');
    const state = current(s, id).parameters;
    expect(state.kind === "failed" && state.message).toContain("busy");
    fail = false;
    expect(await s.controller.validateParameters(id)).toBe(true);
  });
  it("coalesces preparation, freezes edits before awaited registration, and preserves original writer", async () => {
    const s = setup(),
      gate = deferred<void>();
    let calls = 0;
    let captured: import("../../src/core/protocol/types").Preparation | undefined;
    const operations = {
      ...s.operations,
      register: async (p: import("../../src/core/protocol/types").Preparation) => {
        calls++;
        captured = p;
        await gate.promise;
        return s.operations.register(p);
      },
    };
    const controller = createAdvancedController({
      client: s.client,
      operations,
      newId: () => "awaited-draft",
    });
    controllers.add(controller);
    await controller.selectMethod("ticket.create");
    const selected = s.context(),
      id = controller.createDraft(selected);
    if (!id) throw new Error("No draft");
    await controller.validateParameters(id);
    const first = controller.prepare(id),
      second = controller.prepare(id);
    expect(second).toBe(first);
    expect(controller.editSource(id, '{"different":true}')).toBe(false);
    await vi.waitFor(() => expect(captured).toBeDefined());
    expect(controller.get().drafts[0]?.locked).toBe(true);
    expect(controller.discardDraft(id)).toBe(false);
    expect(captured?.context.writer.actor_id).toBe("rowan");
    gate.resolve();
    expect((await first)?.ok).toBe(true);
    expect(calls).toBe(1);
    expect(s.operations.get(id)?.preparation.context.writer.actor_id).toBe("rowan");
  });
  it("supports a large certified string field and wrapper through awaited preparation", async () => {
    const synthetic = contract("ticket.create", "mutation");
    const s = setup({
        route: (request) =>
          request.path.startsWith("/methods/")
            ? contractJson({
                ...synthetic,
                fields: { ...synthetic.fields, fields: [field("body")] },
              })
            : encoded(catalogue),
      }),
      id = await newDraft(s, "ticket.create");
    const text = "雪".repeat(400000);
    expect(s.controller.stageField(id, "body", { presence: "value", text })).toBe(true);
    expect(await s.controller.applyField(id, "body")).toBe(true);
    expect((await s.controller.prepare(id))?.ok).toBe(true);
    expect(formatJson(s.operations.get(id)!.preparation.params)).toContain(text);
  });
  it("retains exact near-limit raw source and rejects an over-budget preparation envelope before send", async () => {
    const s = setup(),
      id = await newDraft(s, "ticket.create");
    const source = '{"body":"' + "x".repeat(4 * 1024 * 1024 - 24) + '"}';
    expect(new TextEncoder().encode(source).byteLength).toBeLessThan(4 * 1024 * 1024);
    expect(s.controller.editSource(id, source)).toBe(true);
    expect(await s.controller.validateParameters(id)).toBe(true);
    const result = await s.controller.prepare(id);
    expect(result?.ok).toBe(false);
    if (result && !result.ok) expect(result.failure.kind).toBe("input");
    expect(s.stored.size).toBe(0);
    expect(s.operations.list()).toHaveLength(0);
    expect(current(s, id).source).toBe(source);
    expect(current(s, id).parameters.kind).toBe("ready");
    expect(current(s, id).locked).toBe(false);
    expect(s.controller.editSource(id, '{"body":"repaired"}')).toBe(true);
    expect((await s.controller.prepare(id))?.ok).toBe(true);
    expect(s.stored.size).toBe(1);
    expect(s.operations.get(id)?.preparation.params).toEqual(json('{"body":"repaired"}'));
  });
  it("retains the ordinary96-depth request contract through validation and preparation", async () => {
    const s = setup(),
      id = await newDraft(s, "ticket.create");
    const source = '{"nested":' + "[".repeat(80) + "9007199254740993" + "]".repeat(80) + "}";
    expect(s.controller.editSource(id, source)).toBe(true);
    expect(await s.controller.validateParameters(id)).toBe(true);
    expect((await s.controller.prepare(id))?.ok).toBe(true);
    expect(current(s, id).source).toBe(source);
  });
  it("formats larger immutable operation observations without widening parameter or editor admission", async () => {
    const value = d.jsonObject([["response", d.jsonString("x".repeat(5 * 1024 * 1024))]]);
    const view = await encode(processing, value, undefined, "observation");
    expect(view.ok).toBe(true);
    if (view.ok) expect(view.value.length).toBe(5 * 1024 * 1024 + 15);
    expect((await encode(processing, value)).ok).toBe(false);
  });
  it("cancels a pending scope fill before preparation and ignores its late result", async () => {
    const gate = deferred<Awaited<ReturnType<typeof processing.encode>>>();
    let hold = false;
    const processor = {
      ...processing,
      encode: (...args: Parameters<typeof processing.encode>) =>
        hold ? gate.promise : processing.encode(...args),
    };
    const s = setup({ processing: processor }),
      id = await newDraft(s, "ticket.create");
    const source = '{"value":9007199254740993}';
    s.controller.editSource(id, source);
    await s.controller.validateParameters(id);
    hold = true;
    const fill = s.controller.fillScopeFields(id);
    const prepare = s.controller.prepare(id);
    expect((await prepare)?.ok).toBe(true);
    gate.resolve(await processing.encode(json('{"actor_id":"rowan","workspace_id":"demo"}')));
    expect(await fill).toBe(false);
    expect(current(s, id).source).toBe(source);
    expect(s.operations.get(id)?.preparation.params).toEqual(json(source));
  });
  it("keeps busy local admission repairable and closing it retains no invented intention", async () => {
    const processor = {
      ...processing,
      admitPreparation: vi.fn(() =>
        Promise.resolve({
          ok: false as const,
          failure: { kind: "busy" as const, message: "Full processing queue" },
        }),
      ),
    };
    const s = setup({ processing: processor }),
      id = await newDraft(s, "ticket.create");
    expect((await s.controller.prepare(id))?.ok).toBe(false);
    expect(current(s, id).locked).toBe(false);
    expect(s.operations.get(id)).toBeUndefined();
    expect(s.controller.editSource(id, '{"repairable":true}')).toBe(true);
    expect(s.controller.discardDraft(id)).toBe(true);
    expect(s.controller.get().activeDraftId).toBeNull();
    expect(s.operations.list()).toHaveLength(0);
  });
});

it("offers existing-record choices without treating new IDs as existing targets", () => {
  expect(fieldChoiceKind("ticket.context", "read", "ticket_id")).toBe("ticket");
  expect(fieldChoiceKind("ticket.create", "mutation", "ticket_id")).toBeNull();
  expect(fieldChoiceKind("ticket.create", "mutation", "assignee_id")).toBe("actor");
  expect(fieldChoiceKind("actor.register", "mutation", "actor_id")).toBeNull();
  expect(fieldChoiceKind("ticket.context", "read", "at_revision")).toBeNull();
});
it("directory suggestions require the captured endpoint and exact parameter workspace", async () => {
  const s = setup();
  const id = await newDraft(s);
  const draft = current(s, id);
  const params = d.jsonObject([["workspace_id", d.jsonString("work")]]);
  expect(matchesChoiceScope(s.context(), draft, params)).toBe(true);
  expect(
    matchesChoiceScope(s.context(), draft, d.jsonObject([["workspace_id", d.jsonString("other")]])),
  ).toBe(false);
  expect(
    matchesChoiceScope(
      { ...s.context(), connection: { ...profile, socket: "/tmp/other.sock" } },
      draft,
      params,
    ),
  ).toBe(false);
  expect(matchesChoiceScope(s.context(), draft, d.jsonObject([]))).toBe(false);
});
