import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpClient, HttpRequest, HttpResult } from "../../../src/core/protocol/http";
import type { Companion } from "../../../src/core/protocol/client";
import type { Operation, Preparation, ConnectionProfile } from "../../../src/core/protocol/types";
import { createOperationController } from "../../../src/core/state/operations";
import * as d from "../../../src/core/protocol/decoders";
import { jsonField, parseJsonText, type JsonValue } from "../../../src/core/json";
import { createPlansController } from "../../../src/features/workflow/plans/controller";
import { planJson } from "../../../src/features/workflow/plans/model";
import { encodeValue, hashValue } from "../../../src/features/workflow/plans/processing";
import type { DraftStorage, PlansController } from "../../../src/features/workflow/plans/types";
import { context, decode, json } from "../../work/actions-fixtures";
import { createTestProcessor } from "../../core/processing-harness";

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});
const ok = <T>(data: T): HttpResult<T> => ({ ok: true, httpStatus: 200, data });
function frameKind(frame: JsonValue) {
  const kind = jsonField(frame, "kind");
  return kind?.kind === "string" ? kind.value : null;
}
function exportFrames(source: string): JsonValue[] {
  return source
    .trimEnd()
    .split("\n")
    .map((line) => {
      const result = parseJsonText(line);
      if (!result.ok) throw new Error(result.error.message);
      return result.value.value;
    });
}
function field(value: JsonValue, name: string): JsonValue {
  const result = jsonField(value, name);
  if (result === undefined) throw new Error(`Missing${name}`);
  return result;
}
function replace(value: JsonValue, path: readonly string[], replacement: JsonValue): JsonValue {
  const head = path[0];
  if (head === undefined) return replacement;
  if (value.kind === "object")
    return d.jsonObject(
      value.fields.map((f) => [
        f.name,
        f.name === head ? replace(f.value, path.slice(1), replacement) : f.value,
      ]),
    );
  if (value.kind === "array")
    return d.jsonArray(
      value.items.map((v, i) => (String(i) === head ? replace(v, path.slice(1), replacement) : v)),
    );
  throw new Error("Invalid fixture replacement");
}
async function framesText(processing: HttpClient["processing"], frames: readonly JsonValue[]) {
  const lines: string[] = [];
  for (const frame of frames) lines.push(await encodeValue(processing, frame));
  return lines.join("\n") + "\n";
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Uninitialized");
  };
  let reject: (error: unknown) => void = () => {
    throw new Error("Uninitialized");
  };
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function source(title = "Original", staged = false) {
  const one = {
    id: "one",
    title: "Create held work",
    operations: [
      { method: "ticket.create", params: { title }, alias: "work" },
      {
        method: "ticket.hold",
        params: { ticket_id: "$work", expected_revision: "1", reason: "Deferred gate" },
        alias: null,
      },
    ],
    bindings: [],
    exposure: staged ? "Held until second independent commit." : "",
    exposures: staged
      ? [
          {
            operation: 0,
            disposition: "held",
            deferred: "Gate in second batch",
            templateDigest: null,
          },
        ]
      : [],
  };
  const two = {
    id: "two",
    title: "Finish configuration",
    operations: [
      {
        method: "ticket.hold",
        params: { ticket_id: "placeholder", expected_revision: "0", reason: null },
        alias: null,
      },
    ],
    bindings: [
      {
        operation: 0,
        path: ["ticket_id"],
        stage: "one",
        receiptPath: ["results", "0", "data", "ticket_id"],
      },
      {
        operation: 0,
        path: ["expected_revision"],
        stage: "one",
        receiptPath: ["results", "1", "data", "revision"],
      },
    ],
    exposure: "Explicitly release held work after complete configuration.",
    exposures: [],
  };
  return JSON.stringify({
    format: "workgraph-ui-plan-1",
    title: "Synthetic workflow",
    stages: staged ? [one, two] : [one],
  });
}
function current(controller: PlansController) {
  const draft = controller.get().drafts.find((d) => d.id === controller.get().selectedId);
  if (draft === undefined) throw new Error("Missing editor");
  return draft;
}
function memoryStorage(initial: readonly string[] = []) {
  const values = new Map(initial.map((v, i) => [String(i), v]));
  let failed = false;
  const storage: DraftStorage = {
    load: () => Promise.resolve([...values.values()]),
    put: (id, value) => {
      if (failed)
        return Promise.reject(new DOMException("Storage unavailable", "QuotaExceededError"));
      values.set(id, value);
      return Promise.resolve();
    },
    remove: (id) => {
      values.delete(id);
      return Promise.resolve();
    },
    dispose: () => undefined,
  };
  return {
    values,
    storage,
    fail: () => {
      failed = true;
    },
  };
}
function harness(
  options: {
    storage?: DraftStorage;
    preflight?: (request: HttpRequest<unknown>) => Promise<unknown>;
    confirm?: (profile: ConnectionProfile) => Promise<ConnectionProfile>;
    prepare?: Companion["prepare"];
    lost?: boolean;
    publication?: (request: HttpRequest<unknown>) => Promise<JsonValue>;
  } = {},
) {
  const processing = createTestProcessor();
  let sequence = 0,
    profile: ConnectionProfile = decode(d.connectionProfile, {
      id: "local",
      generation: "1",
      label: "Synthetic",
      socket: "/tmp/synthetic.sock",
    });
  const reads: HttpRequest<unknown>[] = [],
    preparations: Preparation[] = [],
    native = new Map<string, Operation>(),
    committed = new Map<string, Operation>();
  const observed = (
    input: Preparation,
    state: Operation["state"] = { kind: "prepared_unsent" },
  ): Operation => ({
    format: "workgraph-ui-operation-1",
    operation_id: decode(d.identifier, `native-${input.intention_id}`),
    preparation: {
      intention_id: input.intention_id,
      connection: profile,
      context: input.context,
      method: input.method,
      params: input.params,
    },
    preparation_input_hash: decode(d.digest, "a".repeat(64)),
    connection: profile,
    request: d.jsonObject([
      ["jsonrpc", d.jsonString("2.0")],
      ["workgraph_api", d.jsonString("0.7")],
      ["id", d.jsonString("exact")],
      ["method", d.jsonString(input.method)],
      [
        "params",
        d.jsonObject([
          ...input.params.fields.map((f) => [f.name, f.value] as const),
          ["mutation_id", d.jsonString(`mutation-${input.intention_id}`)],
        ]),
      ],
    ]),
    journal_path: "/tmp/synthetic-plan-journal.json",
    revision: decode(d.decimal, "1"),
    state,
    diagnostic: null,
    receipt_lookup_supported: true,
  });
  const client: HttpClient = {
    processing,
    request: async <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
      reads.push(request);
      let value;
      if (request.path.startsWith("/connections/"))
        value = json(options.confirm === undefined ? profile : await options.confirm(profile));
      else if (request.path.startsWith("/operations/")) {
        const op = native.get(request.path.slice("/operations/".length));
        if (op === undefined)
          return {
            ok: false,
            failure: {
              kind: "remote",
              httpStatus: 404,
              problem: { kind: "Not_found", message: "Missing journal", details: undefined },
            },
          };
        return ok(op as T);
      } else if (
        request.path === "/template-publications/prepare" &&
        options.publication !== undefined
      ) {
        value = await options.publication(request);
      } else if (request.path === "/read") {
        const data =
          options.preflight === undefined
            ? {
                validation: "domain_preparation",
                workspace_revision: "10",
                proposed_revision: "11",
                operation_count: "2",
                generated_ids: [{ kind: "ticket", id: "provisional-never-reserved" }],
                staged_blob_count: "0",
                staged_blob_bytes: "0",
              }
            : await options.preflight(request);
        value = json({ response: { data, meta: { query_revision: "10" } }, pagination: null });
      } else throw new Error(`Unexpected request ${request.path}`);
      const decoded = request.codec.decode(value);
      if (!decoded.ok)
        throw new Error(`${decoded.issue.path.join(".")}: ${decoded.issue.expected}`);
      return ok(decoded.value);
    },
  };
  const unexpected = () => Promise.reject(new Error("Unexpected companion call"));
  const operations = createOperationController(
    {
      connections: unexpected,
      read: unexpected,
      inspect: unexpected,
      prepare:
        options.prepare ??
        ((input) => {
          preparations.push(input);
          const op = observed(input);
          native.set(op.operation_id, op);
          return Promise.resolve(ok(op));
        }),
      act: (id, action) => {
        const old = native.get(id);
        if (old === undefined) throw new Error("Missing operation");
        const success: Operation = {
          ...old,
          revision: decode(d.decimal, "3"),
          state: {
            kind: "committed",
            response: {
              data: json({
                results: [
                  {
                    method: "ticket.create",
                    data: { ticket_id: "actual-native-ticket", revision: "1" },
                  },
                  { method: "ticket.hold", data: { revision: "9007199254740993" } },
                ],
              }),
              meta: decode(
                {
                  decode: (v) =>
                    v?.kind === "object"
                      ? { ok: true, value: v }
                      : { ok: false, issue: { path: [], expected: "object" } },
                },
                { durable: true, workspace_revision: "12" },
              ),
            },
          },
        };
        committed.set(id, success);
        const result =
          options.lost && action === "execute"
            ? {
                ...old,
                revision: decode(d.decimal, "2"),
                state: {
                  kind: "outcome_unknown" as const,
                  problem: {
                    kind: "Outcome_unknown",
                    message: "Synthetic lost reply",
                    details: undefined,
                  },
                },
              }
            : success;
        native.set(id, result);
        return Promise.resolve(ok(result));
      },
    },
    processing,
  );
  const memory = memoryStorage(),
    controller = createPlansController({
      http: client,
      operations,
      storage: options.storage ?? memory.storage,
      newId: () => `draft-${++sequence}`,
    });
  disposals.push(
    () => controller.dispose(),
    () => operations.dispose(),
    () => processing.dispose(),
  );
  const selection = context(client);
  async function open(text = source()) {
    const id = controller.create(selection, text);
    if (id === null) throw new Error("Create failed");
    await controller.parse(id);
    return id;
  }
  return {
    processing,
    client,
    operations,
    controller,
    selection,
    reads,
    preparations,
    native,
    committed,
    memory,
    open,
    setProfile: (value: ConnectionProfile) => {
      profile = value;
    },
  };
}
describe("captured plans and recoverable explicit staging", () => {
  it("freezes original writer/scope and distinguishes plan/review/request fingerprints", async () => {
    const h = harness(),
      id = await h.open();
    await h.controller.preview(id, "one");
    const frozen = current(h.controller).frozen[0]!;
    h.selection = { ...h.selection, writer: { actorId: "later", runId: null } };
    await h.controller.prepare(id, "one");
    expect(h.preparations).toHaveLength(1);
    expect(jsonField(h.preparations[0]!.params, "actor_id")).toEqual(d.jsonString("author"));
    expect(jsonField(h.preparations[0]!.params, "at_revision")).toBeUndefined();
    const stage = current(h.controller).frozen[0]!;
    expect(stage.hash).toBe(frozen.hash);
    expect(stage.reviewHash).not.toBe(stage.hash);
    expect(stage.requestHash).not.toBe(stage.reviewHash);
    expect(stage.preparationHash).toBe("a".repeat(64));
  });
  it("ignores a late preflight after source revision changes", async () => {
    const delayed = deferred<unknown>(),
      h = harness({ preflight: () => delayed.promise }),
      id = await h.open();
    const pending = h.controller.preview(id, "one");
    await vi.waitFor(() => expect(h.reads.some((r) => r.path === "/read")).toBe(true));
    h.controller.edit(id, source("New source"));
    delayed.resolve({
      validation: "domain_preparation",
      workspace_revision: "10",
      proposed_revision: "11",
      operation_count: "2",
      generated_ids: [],
      staged_blob_count: "0",
      staged_blob_bytes: "0",
    });
    await pending;
    expect(current(h.controller).frozen).toHaveLength(0);
    expect(current(h.controller).source).toContain("New source");
  });
  it("keeps template source/spec edits in the original captured editor before native publication", async () => {
    const h = harness(),
      id = await h.controller.createTemplateSource(h.selection);
    if (id === null) throw new Error("Template source editor failed");
    const initial = current(h.controller),
      spec = initial.templateSpec!;
    expect(initial.document?.stages[0]?.operations[0]?.method).toBe("resource.put_text");
    h.selection = { ...h.selection, writer: { actorId: "later", runId: null } };
    const changed = d.jsonObject(
      spec.fields.map((field) => [
        field.name,
        field.name === "parameters" ? d.jsonArray([d.jsonString("topic")]) : field.value,
      ]),
    );
    const pending = h.controller.replaceTemplateSpec(id, changed);
    const pendingDocument = current(h.controller).document!;
    await h.controller.replaceDocument(id, {
      ...pendingDocument,
      title: "Retained named template",
    });
    await pending;
    const edited = current(h.controller);
    expect(edited.capture.context.writer.actor_id).toBe("author");
    expect(edited.capture.context.writer.run_id).toBe("run-one");
    expect(edited.document?.title).toBe("Retained named template");
    expect(jsonField(edited.templateSpec!, "parameters")).toEqual(
      d.jsonArray([d.jsonString("topic")]),
    );
    const exported = await h.controller.exportDraft(id);
    if (exported === null) throw new Error("Missing source recovery");
    const restored = harness();
    await restored.controller.importDraft(exported);
    expect(jsonField(current(restored.controller).templateSpec!, "parameters")).toEqual(
      d.jsonArray([d.jsonString("topic")]),
    );
    expect(restored.reads).toHaveLength(0);
    expect(restored.preparations).toHaveLength(0);
  });
  it("builds a separate canonical native publication without rebasing scope or rerunning helper on execution", async () => {
    let calls = 0,
      captured: JsonValue | undefined;
    const h = harness({
      publication: (request) => {
        calls++;
        captured = jsonField(request.body!, "params");
        const params = field(captured!, "spec");
        return Promise.resolve(
          replace(
            json({
              jsonrpc: "2.0",
              workgraph_api: "0.7",
              id: "native-helper",
              method: "transaction.apply",
              params: {
                workspace_id: "demo",
                actor_id: "author",
                run_id: "run-one",
                operations: [
                  {
                    method: "resource.put_text",
                    params: {
                      resource_id: "canonical-template",
                      expected_revision: "0",
                      title: "Native canonical fixture",
                      text: "canonical fixture source",
                      filename: "template.json",
                      mime_type: "application/json",
                    },
                  },
                  {
                    method: "template.register",
                    params: {
                      template_id: "canonical-template",
                      template_revision: "1",
                      digest: "b".repeat(64),
                      spec: {},
                    },
                  },
                ],
              },
            }),
            ["params", "operations", "1", "params", "spec"],
            params,
          ),
        );
      },
    });
    const sourceId = await h.controller.createTemplateSource(h.selection);
    if (sourceId === null) throw new Error("Missing source");
    h.selection = { ...h.selection, writer: { actorId: "later", runId: null } };
    const publishedId = await h.controller.canonicalizeTemplate(sourceId);
    expect(publishedId).not.toBe(sourceId);
    expect(publishedId).not.toBeNull();
    expect(field(captured!, "actor_id")).toEqual(d.jsonString("author"));
    expect(field(captured!, "run_id")).toEqual(d.jsonString("run-one"));
    const publication = current(h.controller);
    expect(publication.capture.context.writer.actor_id).toBe("author");
    expect(
      publication.document?.stages[0]?.operations.map((operation) => operation.method),
    ).toEqual(["resource.put_text", "template.register"]);
    expect(h.operations.list()).toHaveLength(0);
    expect(
      h.controller.get().drafts.find((draft) => draft.id === sourceId)?.templateSpec,
    ).not.toBeNull();
    await h.controller.preview(publishedId!, "publication");
    await h.controller.prepare(publishedId!, "publication");
    await h.operations.act(current(h.controller).frozen[0]!.intentionId, "execute");
    expect(calls).toBe(1);
  });
  it("keeps structurally valid stage authoring available while exposure needs correction", async () => {
    const h = harness(),
      id = await h.open(source("Staged", true));
    const document = current(h.controller).document!;
    await h.controller.replaceDocument(id, {
      ...document,
      stages: document.stages.map((stage, index) =>
        index === 0 ? { ...stage, exposures: [] } : stage,
      ),
    });
    const invalid = current(h.controller);
    expect(invalid.structuredRevision).toBe(invalid.revision);
    expect(invalid.parsedRevision).toBeNull();
    expect(invalid.document?.stages[0]?.exposures).toHaveLength(0);
    expect(invalid.issue).toMatch(/Declare held or runnable/);
    await h.controller.replaceDocument(id, document);
    expect(current(h.controller).parsedRevision).toBe(current(h.controller).revision);
    expect(current(h.controller).issue).toBeNull();
  });
  it("does not overwrite newer raw source after delayed structured encoding", async () => {
    const h = harness(),
      id = await h.open(),
      document = current(h.controller).document!;
    const delayed = deferred<Awaited<ReturnType<typeof h.processing.encode>>>(),
      original = h.processing.encode;
    vi.spyOn(h.processing, "encode").mockImplementationOnce(() => delayed.promise);
    const pending = h.controller.replaceDocument(id, { ...document, title: "Obsolete form" });
    h.controller.edit(id, source("Newer literal source"));
    delayed.resolve(await original(planJson({ ...document, title: "Obsolete form" })));
    await pending;
    expect(current(h.controller).source).toContain("Newer literal source");
    expect(current(h.controller).source).not.toContain("Obsolete form");
  });
  it("cannot reset a newer template capture after obsolete profile confirmation settles despite cancellation", async () => {
    const late = deferred<ConnectionProfile>();
    let confirmations = 0;
    const h = harness({
      confirm: (profile) => (++confirmations === 1 ? late.promise : Promise.resolve(profile)),
      preflight: () => Promise.resolve({ items: [], next_offset: null, omitted: "0" }),
    });
    const old = h.controller.loadTemplates(h.selection);
    await vi.waitFor(() => expect(confirmations).toBe(1));
    const newer = {
      ...h.selection,
      route: { ...h.selection.route, workspaceId: "other-workspace" },
    };
    await h.controller.loadTemplates(newer);
    const before = h.controller.get();
    expect(before.templateScope).toBe(JSON.stringify(["local", "1", "other-workspace"]));
    expect(before.templateRevision).toBe("10");
    late.resolve(h.selection.connection);
    await old;
    expect(h.controller.get().templateScope).toBe(before.templateScope);
    expect(h.controller.get().templateRevision).toBe(before.templateRevision);
    expect(h.controller.get().templateIssue).toBeNull();
    const reads = h.reads.filter((request) => request.path === "/read");
    expect(reads).toHaveLength(1);
    expect(jsonField(jsonField(reads[0]!.body!, "params")!, "workspace_id")).toEqual(
      d.jsonString("other-workspace"),
    );
  });
  it("keeps preparation pending locked against repeated edit/close attempts", async () => {
    const delayed = deferred<HttpResult<Operation>>(),
      h = harness({ prepare: () => delayed.promise }),
      id = await h.open();
    await h.controller.preview(id, "one");
    const pending = h.controller.prepare(id, "one");
    await vi.waitFor(() => expect(current(h.controller).frozen[0]?.captured).toBe(true));
    h.controller.edit(id, source("Forbidden"));
    h.controller.remove(id);
    h.controller.edit(id, source("Still forbidden"));
    expect(current(h.controller).source).not.toContain("Forbidden");
    expect(current(h.controller).active).toBe("preparing");
    delayed.resolve({
      ok: false,
      failure: { kind: "network", message: "Lost preparation response" },
    });
    await pending;
    expect(current(h.controller).frozen[0]?.captured).toBe(true);
    expect(current(h.controller).source).toContain("Original");
  });
  it("keeps native preparation fenced when its delayed storage write rejects", async () => {
    const put = deferred<void>(),
      prepare = deferred<HttpResult<Operation>>();
    let armed = false,
      writing = false;
    const h = harness({
        prepare: () => prepare.promise,
        storage: {
          load: () => Promise.resolve([]),
          put: () => {
            if (!armed) return Promise.resolve();
            writing = true;
            return put.promise;
          },
          remove: () => Promise.resolve(),
          dispose: () => undefined,
        },
      }),
      id = await h.open();
    await h.controller.preview(id, "one");
    await vi.waitFor(() => expect(current(h.controller).persisted).toBe("saved"));
    armed = true;
    const pending = h.controller.prepare(id, "one");
    await vi.waitFor(() => {
      expect(writing).toBe(true);
      expect(current(h.controller).frozen[0]?.captured).toBe(true);
    });
    put.reject(new DOMException("Delayed quota rejection", "QuotaExceededError"));
    await vi.waitFor(() =>
      expect(current(h.controller).persistenceFailure?.error).toBeInstanceOf(DOMException),
    );
    expect(current(h.controller).active).toBe("preparing");
    h.controller.edit(id, source("Forbidden after storage failure"));
    h.controller.remove(id);
    expect(current(h.controller).active).toBe("preparing");
    expect(current(h.controller).source).toContain("Original");
    prepare.resolve({
      ok: false,
      failure: { kind: "network", message: "Lost preparation response" },
    });
    await pending;
    expect(current(h.controller).active).toBeNull();
    expect(current(h.controller).frozen[0]?.captured).toBe(true);
  });
  it("ignores an obsolete storage rejection without replacing a newer preflight task", async () => {
    const put = deferred<void>(),
      read = deferred<unknown>();
    let armed = false,
      writing = false;
    const h = harness({
        preflight: () => read.promise,
        storage: {
          load: () => Promise.resolve([]),
          put: () => {
            if (!armed) return Promise.resolve();
            armed = false;
            writing = true;
            return put.promise;
          },
          remove: () => Promise.resolve(),
          dispose: () => undefined,
        },
      }),
      id = await h.open();
    await vi.waitFor(() => expect(current(h.controller).persisted).toBe("saved"));
    armed = true;
    h.controller.edit(id, source("Old persistence"));
    await vi.waitFor(() => expect(writing).toBe(true));
    h.controller.edit(id, source("New active capture"));
    await h.controller.parse(id);
    const pending = h.controller.preview(id, "one");
    await vi.waitFor(() => expect(h.reads.some((r) => r.path === "/read")).toBe(true));
    put.reject(new DOMException("Obsolete quota rejection", "QuotaExceededError"));
    await vi.waitFor(() => expect(current(h.controller).persisted).toBe("saved"));
    expect(current(h.controller).active).toBe("preflight");
    expect(current(h.controller).issue).toBeNull();
    expect(current(h.controller).persistenceFailure).toBeNull();
    read.resolve({
      validation: "domain_preparation",
      workspace_revision: "10",
      proposed_revision: "11",
      operation_count: "2",
      generated_ids: [],
      staged_blob_count: "0",
      staged_blob_bytes: "0",
    });
    await pending;
    expect(current(h.controller).frozen).toHaveLength(1);
  });
  it("never starts batch two while batch one is uncertain and uses actual receipt guards", async () => {
    const h = harness({ lost: true }),
      id = await h.open(source("First", true));
    await h.controller.preview(id, "one");
    await h.controller.prepare(id, "one");
    const one = current(h.controller).frozen[0]!;
    await h.operations.act(one.intentionId, "execute");
    const before = h.reads.filter((r) => r.path === "/read").length;
    await h.controller.preview(id, "two");
    expect(current(h.controller).issue).toMatch(/durable committed/);
    expect(h.reads.filter((r) => r.path === "/read")).toHaveLength(before);
    await h.operations.act(one.intentionId, "recover");
    await h.controller.preview(id, "two");
    const two = current(h.controller).frozen.find((f) => f.stageId === "two")!;
    expect(two).toBeDefined();
    expect(jsonField(jsonField(two.params, "operations")!, "unused")).toBeUndefined();
    const ops = jsonField(two.params, "operations");
    if (ops?.kind !== "array") throw new Error("Missing ops");
    const params = jsonField(ops.items[0]!, "params");
    expect(jsonField(params!, "ticket_id")).toEqual(d.jsonString("actual-native-ticket"));
    expect(jsonField(params!, "expected_revision")).toEqual(d.jsonString("9007199254740993"));
    expect(two.intentionId).not.toBe(one.intentionId);
    expect(two.reviewHash).not.toBe(one.reviewHash);
  });
  it("prunes unregistered preview snapshots so repeated edits still export/import", async () => {
    const h = harness(),
      id = await h.open();
    for (let i = 0; i < 35; i++) {
      h.controller.edit(id, source(`Revision${i}`));
      await h.controller.parse(id);
      await h.controller.preview(id, "one");
    }
    expect(current(h.controller).snapshots).toHaveLength(1);
    const exported = await h.controller.exportDraft(id);
    if (exported === null) throw new Error("Missing export");
    const restored = harness();
    const imported = await restored.controller.importDraft(exported);
    expect(imported).toBe(id);
    expect(current(restored.controller).source).toContain("Revision34");
    await restored.controller.prepare(id, "one");
    expect(current(restored.controller).frozen).toHaveLength(0);
    expect(current(restored.controller).issue).toMatch(/native preflight first/);
    expect(restored.preparations).toHaveLength(0);
  });
  it("rejects imported same-ID/generation but different-socket before daemon I/O", async () => {
    const h = harness(),
      id = await h.open();
    const exported = await h.controller.exportDraft(id);
    if (exported === null) throw new Error("Missing export");
    const restored = harness();
    restored.setProfile({ ...restored.selection.connection, socket: "/tmp/different-root.sock" });
    await restored.controller.importDraft(exported);
    await restored.controller.preview(id, "one");
    expect(current(restored.controller).issue).toMatch(/different socket/);
    expect(restored.reads.filter((r) => r.path === "/read")).toHaveLength(0);
    expect(restored.preparations).toHaveLength(0);
  });
  it("restores only the exact source-derived journal and rejects forged consistent hashes", async () => {
    const h = harness(),
      id = await h.open();
    await h.controller.preview(id, "one");
    await h.controller.prepare(id, "one");
    const exported = await h.controller.exportDraft(id);
    if (exported === null) throw new Error("Missing export");
    const restored = harness();
    for (const [id, op] of h.native) restored.native.set(id, op);
    await restored.controller.importDraft(exported);
    await restored.controller.restoreOperations(id);
    expect(restored.operations.list()).toHaveLength(1);
    const frames = exportFrames(exported),
      tampered = frames.map((frame) =>
        frameKind(frame) === "stage-params"
          ? replace(
              frame,
              ["value", "operations", "0", "params", "title"],
              d.jsonString("Forged different request"),
            )
          : frame,
      ),
      stage = tampered.find((frame) => frameKind(frame) === "stage"),
      params = tampered.find((frame) => frameKind(frame) === "stage-params"),
      preview = tampered.find((frame) => frameKind(frame) === "stage-preview");
    if (stage === undefined || params === undefined || preview === undefined)
      throw new Error("Missing stage frames");
    const hash = await hashValue(
      h.processing,
      "review",
      d.jsonObject([
        ["plan_hash", field(field(stage, "value"), "hash")],
        ["stage_id", field(field(stage, "value"), "stageId")],
        ["params", field(params, "value")],
        ["preflight", field(preview, "value")],
      ]),
    );
    const attack = harness();
    for (const [id, op] of h.native) attack.native.set(id, op);
    expect(
      await attack.controller.importDraft(
        await framesText(
          h.processing,
          tampered.map((frame) =>
            frame === stage ? replace(frame, ["value", "reviewHash"], d.jsonString(hash)) : frame,
          ),
        ),
      ),
    ).toBe(id);
    await attack.controller.restoreOperations(id);
    expect(current(attack.controller).issue).toMatch(/do not derive/);
    expect(attack.operations.list()).toHaveLength(0);
  });
  it("restores verified stage A before deriving and restoring receipt-bound stage B", async () => {
    const h = harness(),
      id = await h.open(source("First", true));
    await h.controller.preview(id, "one");
    await h.controller.prepare(id, "one");
    const one = current(h.controller).frozen[0]!;
    await h.operations.act(one.intentionId, "execute");
    await h.controller.preview(id, "two");
    await h.controller.prepare(id, "two");
    const exported = await h.controller.exportDraft(id);
    if (exported === null) throw new Error("Missing export");
    const restored = harness();
    for (const [id, op] of h.native) restored.native.set(id, op);
    await restored.controller.importDraft(exported);
    expect(restored.operations.list()).toHaveLength(0);
    await restored.controller.restoreOperations(id);
    expect(restored.operations.list()).toHaveLength(2);
    const second = current(restored.controller).frozen.find((f) => f.stageId === "two")!;
    const ops = jsonField(second.params, "operations");
    if (ops?.kind !== "array") throw new Error("Missing receipt-derived operations");
    expect(jsonField(jsonField(ops.items[0]!, "params")!, "ticket_id")).toEqual(
      d.jsonString("actual-native-ticket"),
    );
    expect(jsonField(jsonField(ops.items[0]!, "params")!, "expected_revision")).toEqual(
      d.jsonString("9007199254740993"),
    );
    expect(restored.preparations).toHaveLength(0);
    expect(restored.reads.filter((r) => r.path === "/read")).toHaveLength(0);

    const frames = exportFrames(exported);
    const first = frames.find((f) => frameKind(f) === "stage");
    if (first === undefined) throw new Error("Missing stage");
    const intention = field(field(first, "value"), "intentionId");
    const attacks = [
      frames.map((f, i) => (i === 0 ? replace(f, ["revision"], d.jsonNumber("0")) : f)),
      frames.map((f) =>
        frameKind(f) === "snapshot" ? replace(f, ["revision"], d.jsonNumber("0")) : f,
      ),
      frames.map((f) =>
        frameKind(f) === "stage" ? replace(f, ["value", "sourceRevision"], d.jsonNumber("0")) : f,
      ),
      frames.map((f) =>
        frameKind(f) === "stage" ? replace(f, ["value", "stageIndex"], d.jsonNumber("32")) : f,
      ),
      frames.map((f) =>
        frameKind(f) === "stage" ? replace(f, ["value", "intentionId"], intention) : f,
      ),
      frames.map((f) =>
        frameKind(f) === "stage" ? replace(f, ["value", "stageIndex"], d.jsonNumber("0")) : f,
      ),
    ];
    for (const attack of attacks) {
      const rejected = harness();
      expect(
        await rejected.controller.importDraft(await framesText(h.processing, attack)),
      ).toBeNull();
      expect(rejected.controller.get().drafts).toHaveLength(0);
    }
  });
  it("retains unsent source and reports quota failure truthfully", async () => {
    const memory = memoryStorage();
    memory.fail();
    const h = harness({ storage: memory.storage }),
      id = await h.open();
    await vi.waitFor(() => expect(current(h.controller).persisted).toBe("unavailable"));
    expect(current(h.controller).source).toContain("Original");
    expect(h.controller.get().drafts.some((d) => d.id === id)).toBe(true);
  });
  it("never imports a source snapshot with altered canonical hash", async () => {
    const h = harness(),
      id = await h.open();
    await h.controller.preview(id, "one");
    const exported = await h.controller.exportDraft(id);
    if (exported === null) throw new Error("Missing export");
    const value = exportFrames(exported).map((frame) =>
      frameKind(frame) === "snapshot"
        ? replace(frame, ["hash"], d.jsonString("0".repeat(64)))
        : frameKind(frame) === "stage"
          ? replace(frame, ["value", "hash"], d.jsonString("0".repeat(64)))
          : frame,
    );
    const restored = harness();
    expect(await restored.controller.importDraft(await framesText(h.processing, value))).toBeNull();
    expect(restored.controller.get().issue).toMatch(/hash/);
  });
  it("returns to the library without deleting a draft, then removes its saved copy explicitly", async () => {
    const memory = memoryStorage(),
      h = harness({ storage: memory.storage }),
      id = await h.open();
    await vi.waitFor(() => expect(current(h.controller).persisted).toBe("saved"));
    h.controller.select(null);
    expect(h.controller.get().selectedId).toBeNull();
    expect(h.controller.get().drafts).toHaveLength(1);
    expect(memory.values.has(id)).toBe(true);
    h.controller.select(id);
    expect(h.controller.get().selectedId).toBe(id);
    h.controller.remove(id);
    expect(h.controller.get().drafts).toHaveLength(0);
    await vi.waitFor(() => expect(memory.values.has(id)).toBe(false));
  });
  it("reports a failed local deletion instead of silently resurrecting a closed draft", async () => {
    const memory = memoryStorage(),
      h = harness({
        storage: {
          ...memory.storage,
          remove: () =>
            Promise.reject(new DOMException("Delete transaction rejected", "InvalidStateError")),
        },
      }),
      id = await h.open();
    await vi.waitFor(() => expect(current(h.controller).persisted).toBe("saved"));
    h.controller.remove(id);
    await vi.waitFor(() => expect(h.controller.get().issue).toContain(`Local draft ${id}`));
    expect(h.controller.get().issue).toMatch(/may return after reload/);
    expect(h.controller.get().drafts).toHaveLength(0);
    expect(memory.values.has(id)).toBe(true);
  });
  it("keeps unexpected storage failure in owned error state", async () => {
    const h = harness({
      storage: {
        load: () => Promise.resolve([]),
        put: () => Promise.reject(new Error("Unexpected provider failure")),
        remove: () => Promise.resolve(),
        dispose: () => undefined,
      },
    });
    await h.open();
    await vi.waitFor(() =>
      expect(current(h.controller).persistenceFailure?.error).toBeInstanceOf(Error),
    );
    expect(current(h.controller).source).toContain("Original");
  });
  it("encodes source exports through the real worker transfer loopback", async () => {
    const h = harness(),
      id = await h.open();
    await h.controller.preview(id, "one");
    const exported = await h.controller.exportDraft(id);
    expect(exported).toContain("workgraph-ui-plan-draft-lines-1");
    expect(
      await encodeValue(h.processing, d.jsonObject([["n", d.jsonNumber("9007199254740993")]])),
    ).toBe('{"n":9007199254740993}');
  });
});
