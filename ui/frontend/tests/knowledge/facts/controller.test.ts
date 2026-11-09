import { afterEach, describe, expect, it } from "vitest";
import type { FeatureContext } from "../../../src/app/types";
import { jsonField } from "../../../src/core/json";
import * as d from "../../../src/core/protocol/decoders";
import type { HttpClient, HttpRequest, HttpResult } from "../../../src/core/protocol/http";
import type { Preparation, ReadResponse } from "../../../src/core/protocol/types";
import type { OperationController, ManagedOperation } from "../../../src/core/state/operations";
import { createFactsController } from "../../../src/features/knowledge/facts/controller";
import { decimal } from "../../../src/features/knowledge/facts/model";
import { createTestProcessor } from "../../core/processing-harness";
import { decode, deferred, page, record, response, target } from "./fixtures";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const done of cleanup.splice(0)) done();
});
async function until(test: () => boolean) {
  for (let n = 0; n < 200; n++) {
    if (test()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error("Condition did not settle");
}
function setup() {
  const processing = createTestProcessor(),
    requests: { method: string; params: import("../../../src/core/protocol/types").JsonObject }[] =
      [],
    preparations: Preparation[] = [],
    entries = new Map<string, ManagedOperation>();
  let handle: (
    method: string,
    params: import("../../../src/core/protocol/types").JsonObject,
  ) => Promise<ReadResponse> = (method) =>
    Promise.resolve(
      response(
        page(
          method === "fact.keys"
            ? [Object.fromEntries(Object.entries(record).filter(([name]) => name !== "value"))]
            : [record],
        ),
      ),
    );
  const http: HttpClient = {
    processing,
    request: async <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
      if (request.body === undefined) throw new Error("body");
      const method = jsonField(request.body, "method"),
        params = jsonField(request.body, "params");
      if (method?.kind !== "string" || params?.kind !== "object") throw new Error("selector");
      requests.push({ method: method.value, params });
      const answer = await handle(method.value, params);
      const decoded = request.codec.decode(
        d.jsonObject([
          [
            "response",
            d.jsonObject([
              ["data", answer.response.data],
              ["meta", answer.response.meta],
            ]),
          ],
          ["pagination", d.jsonNull()],
        ]),
      );
      if (!decoded.ok) throw new Error(decoded.issue.expected);
      return { ok: true, data: decoded.value, httpStatus: 200 };
    },
  };
  const operations: OperationController = {
    get: (id) => entries.get(id),
    list: () => [...entries.values()],
    subscribe: () => () => undefined,
    register: (preparation) => {
      preparations.push(preparation);
      const entry: ManagedOperation = { preparation, operation: null, phase: { kind: "draft" } };
      entries.set(preparation.intention_id, entry);
      return Promise.resolve({ ok: true, entry });
    },
    act: (id) => {
      const entry = entries.get(id);
      if (entry === undefined) throw new Error("missing entry");
      return Promise.resolve({ ok: true, entry });
    },
    adopt: () => Promise.resolve({ ok: false, failure: { kind: "input", message: "not used" } }),
    dispose: () => undefined,
  };
  const controller = createFactsController({ http, operations }),
    context: FeatureContext = {
      client: http,
      connection: target.connection,
      profileState: "current",
      route: {
        view: "facts",
        connectionId: "local",
        workspaceId: "workspace",
        projectId: null,
        entityId: null,
      },
      writer: { actorId: "author", runId: null },
      navigate: () => undefined,
    };
  cleanup.push(() => {
    controller.dispose();
    processing.dispose();
  });
  return {
    controller,
    context,
    requests,
    preparations,
    handle: (next: typeof handle) => {
      handle = next;
    },
  };
}
describe("Facts captured read and mutation owners", () => {
  it("keeps a later key page when selecting a fact and returns through captured offsets", async () => {
    const h = setup();
    h.handle((method, params) => {
      if (method === "fact.keys") {
        const offset = jsonField(params, "offset");
        if (offset?.kind !== "string") throw new Error("offset");
        const last = offset.value === "2";
        return Promise.resolve(
          response(
            page(
              (last ? ["c"] : ["a", "b"]).map((key) =>
                Object.fromEntries(
                  Object.entries({ ...record, key }).filter(([name]) => name !== "value"),
                ),
              ),
              offset.value,
              last ? "0" : "1",
              last ? null : "2",
            ),
          ),
        );
      }
      const requested = jsonField(params, "keys");
      if (requested?.kind !== "array") throw new Error("keys");
      return Promise.resolve(
        response(
          page(
            requested.items.map((key) => {
              if (key.kind !== "string") throw new Error("key");
              return { ...record, key: key.value };
            }),
          ),
        ),
      );
    });
    h.controller.select(h.context);
    await until(() => h.controller.get().values.kind === "ready");
    h.controller.nextKeys();
    await until(() => h.controller.get().keyPreviousOffsets.length === 1);
    const before = h.requests.filter((r) => r.method === "fact.keys").length;
    h.controller.select(h.context, { ...target, key: "c" });
    await until(() => h.controller.get().detail.kind === "ready");
    expect(h.requests.filter((r) => r.method === "fact.keys")).toHaveLength(before);
    const keys = h.controller.get().keys;
    expect(keys.kind === "ready" && keys.value.value.offset).toBe("2");
    h.controller.previousKeys();
    await until(() => h.controller.get().keyPreviousOffsets.length === 0);
    expect(h.controller.get().selectedKey).toBe("c");
    expect(
      h.requests
        .filter((r) => r.method === "fact.keys")
        .map((r) => [jsonField(r.params, "offset"), jsonField(r.params, "at_revision")]),
    ).toEqual([
      [d.jsonString("0"), undefined],
      [d.jsonString("2"), d.jsonString("7")],
      [d.jsonString("0"), d.jsonString("7")],
    ]);
    h.controller.select(h.context, {
      ...target,
      key: null,
      connection: { ...target.connection, generation: decimal("3"), socket: "/tmp/new.sock" },
    });
    expect(h.controller.get().keyPreviousOffsets).toEqual([]);
    expect(h.controller.get().selectedKey).toBeNull();
  });
  it("uses observed history offsets in both directions and retains the page after a failed continuation", async () => {
    const h = setup();
    let failNext = false;
    h.handle((method, params) => {
      if (method !== "fact.history")
        return Promise.resolve(
          response(
            page([
              method === "fact.keys"
                ? Object.fromEntries(Object.entries(record).filter(([name]) => name !== "value"))
                : record,
            ]),
          ),
        );
      const offset = jsonField(params, "offset");
      if (offset?.kind !== "string") throw new Error("missing offset");
      if (failNext) {
        failNext = false;
        return Promise.resolve(response(page([{ ...record, revision: "10" }], "9")));
      }
      const start = Number(offset.value);
      const count = start === 0 ? 2 : 1;
      return Promise.resolve(
        response(
          page(
            Array.from({ length: count }, (_, index) => ({
              ...record,
              revision: String(start + index + 1),
            })),
            offset.value,
            start === 0 ? "1" : "0",
            start === 0 ? "2" : null,
          ),
        ),
      );
    });
    h.controller.select(h.context);
    await until(() => h.controller.get().values.kind === "ready");
    h.controller.inspect("settings");
    await until(() => h.controller.get().detail.kind === "ready");
    h.controller.history();
    await until(() => h.controller.get().history.kind === "ready");
    failNext = true;
    h.controller.nextHistory();
    await until(() => h.controller.get().history.kind === "failed");
    const failed = h.controller.get().history;
    expect(failed.kind === "failed" && failed.previous?.value.offset).toBe("0");
    expect(h.controller.get().historyPreviousOffsets).toEqual([]);
    h.controller.nextHistory();
    await until(() => h.controller.get().historyPreviousOffsets.length === 1);
    const next = h.controller.get().history;
    expect(next.kind === "ready" && next.value.value.offset).toBe("2");
    h.controller.previousHistory();
    await until(() => h.controller.get().historyPreviousOffsets.length === 0);
    expect(
      h.requests
        .filter((r) => r.method === "fact.history")
        .map((r) => [jsonField(r.params, "offset"), jsonField(r.params, "at_revision")]),
    ).toEqual(["0", "2", "2", "0"].map((offset) => [d.jsonString(offset), d.jsonString("7")]));
    h.controller.changeScope({ kind: "project", id: decode(d.identifier, "other") });
    expect(h.controller.get().history.kind).toBe("idle");
    expect(h.controller.get().historyPreviousOffsets).toEqual([]);
  });
  it("batches keys at one planning capture and resets ordinary scope filters", async () => {
    const h = setup();
    h.controller.select(h.context);
    await until(() => h.controller.get().values.kind === "ready");
    expect(h.requests.map((r) => r.method)).toEqual(["fact.keys", "fact.multi_get"]);
    expect(jsonField(h.requests[1]!.params, "at_revision")).toEqual(d.jsonString("7"));
    h.controller.query({ prefix: "Case.", includeDeleted: true, predicates: [] });
    await until(() => h.requests.length >= 4);
    h.controller.changeScope({ kind: "ticket", id: decode(d.identifier, "ticket") });
    expect(h.controller.get().query.prefix).toBe("");
    expect(h.controller.get().selectedKey).toBeNull();
  });
  it("freezes original writer/target/source through async admission and retains new explicit rebase", async () => {
    const h = setup();
    h.controller.select(h.context);
    await until(() => h.controller.get().values.kind === "ready");
    await h.controller.open(h.context, "settings", "fact.put");
    const first = h.controller.get().drafts[0];
    if (first === undefined) throw new Error("draft");
    h.controller.edit(first.id, {
      source: '{"big":900719925474099312345}',
      references: { kind: "replace", items: [] },
    });
    const work = h.controller.review(first.id);
    h.controller.select({ ...h.context, writer: { actorId: "other", runId: null } });
    h.controller.changeScope({ kind: "project", id: decode(d.identifier, "other-project") });
    await work;
    expect(h.preparations).toHaveLength(1);
    expect(h.preparations[0]?.context.writer.actor_id).toBe("author");
    expect(jsonField(h.preparations[0]!.params, "scope")).toEqual(
      d.jsonObject([["kind", d.jsonString("workspace")]]),
    );
    h.handle(() =>
      Promise.resolve(
        response(page([{ ...record, revision: "2", value_type: "boolean", value: true }]), "9"),
      ),
    );
    await h.controller.compareCurrent(first.id);
    h.controller.rebase(first.id);
    const second = h.controller.get().drafts[1];
    expect(second?.id).not.toBe(first.id);
    expect(second?.input.source).toBe('{"big":900719925474099312345}');
    expect(second?.base.value.kind === "value" ? second.base.value.revision : null).toBe("2");
    expect(h.preparations).toHaveLength(1);
    if (second === undefined) throw new Error("rebased draft");
    await h.controller.review(second.id);
    expect(h.preparations).toHaveLength(2);
    expect(jsonField(h.preparations[0]!.params, "mutation_id")).toEqual(d.jsonString(first.id));
    expect(jsonField(h.preparations[1]!.params, "mutation_id")).toEqual(d.jsonString(second.id));
    expect(jsonField(h.preparations[1]!.params, "expected_revision")).toEqual(d.jsonString("2"));
  });
  it("rejects authoring onto a retargeted daemon and preserves local invalid source for repair", async () => {
    const h = setup();
    h.controller.select(h.context);
    await until(() => h.controller.get().values.kind === "ready");
    await h.controller.open(
      {
        ...h.context,
        connection: { ...target.connection, generation: decimal("3"), socket: "/tmp/other" },
      },
      "settings",
      "fact.put",
    );
    expect(h.controller.get().drafts).toHaveLength(0);
    expect(h.controller.get().issue).toContain("transplanted");
    await h.controller.open(h.context, "settings", "fact.put");
    const id = h.controller.get().drafts[0]?.id;
    if (id === undefined) throw new Error("draft");
    h.controller.edit(id, { source: '{"a":1,"\\u0061":2}', references: { kind: "preserve" } });
    await h.controller.review(id);
    expect(h.preparations).toHaveLength(0);
    expect(h.controller.get().drafts[0]?.phase.kind).toBe("editing");
    expect(h.controller.get().drafts[0]?.input.source).toContain("\\u0061");
  });
  it("retains invalid structured candidates and empty reference inputs across navigation until explicit repair", async () => {
    const h = setup();
    h.controller.select(h.context);
    await until(() => h.controller.get().values.kind === "ready");
    await h.controller.open(h.context, "settings", "fact.put");
    const draft = h.controller.get().drafts[0];
    if (draft === undefined) throw new Error("draft");
    const candidate = { kind: "number" as const, lexeme: "1e" };
    h.controller.edit(draft.id, {
      source: "null",
      structured: candidate,
      references: { kind: "replace", items: [{ kind: "ticket", id: "" }] },
    });
    candidate.lexeme = "2";
    await h.controller.review(draft.id);
    expect(h.controller.get().drafts[0]?.input.structured).toEqual({
      kind: "number",
      lexeme: "1e",
    });
    expect(h.controller.get().drafts[0]?.phase.kind).toBe("editing");
    expect(h.preparations).toHaveLength(0);
    h.controller.changeScope({ kind: "project", id: decode(d.identifier, "elsewhere") });
    expect(h.controller.get().drafts[0]?.input.references).toEqual({
      kind: "replace",
      items: [{ kind: "ticket", id: "" }],
    });
    h.controller.edit(draft.id, { source: "true", references: { kind: "replace", items: [] } });
    await h.controller.review(draft.id);
    expect(h.preparations).toHaveLength(1);
    expect(jsonField(h.preparations[0]!.params, "value")).toEqual(d.jsonBoolean(true));
  });
  it("resolves exact version2 with and without an explicit planning capture, never current fallback", async () => {
    for (const pinned of [false, true]) {
      const h = setup();
      h.handle((method) =>
        Promise.resolve(
          response(
            method === "fact.history"
              ? page([{ ...record, revision: "2", value_type: "boolean", value: false }], "1")
              : page(method === "fact.keys" ? [] : [record]),
          ),
        ),
      );
      h.controller.select(h.context, {
        ...target,
        key: "settings",
        factRevision: decimal("2"),
        ...(pinned ? { atRevision: decimal("7") } : {}),
      });
      await until(() => h.controller.get().detail.kind === "ready");
      const selected = h.controller.get().detail;
      expect(
        selected.kind === "ready" && selected.value.value.kind !== "missing"
          ? selected.value.value.revision
          : null,
      ).toBe("2");
      h.controller.refresh();
      await until(() => h.controller.get().detail.kind === "ready");
      const refreshed = h.controller.get().detail;
      expect(
        refreshed.kind === "ready" && refreshed.value.value.kind !== "missing"
          ? refreshed.value.value.revision
          : null,
      ).toBe("2");
      h.controller.query({ prefix: "settings", includeDeleted: true, predicates: [] });
      await until(() => h.controller.get().detail.kind === "ready");
      const filtered = h.controller.get().detail;
      expect(
        filtered.kind === "ready" && filtered.value.value.kind !== "missing"
          ? filtered.value.value.revision
          : null,
      ).toBe("2");
      expect(h.requests.filter((r) => r.method === "fact.history")).toHaveLength(3);
      const req = h.requests.find((r) => r.method === "fact.history");
      expect(req === undefined ? undefined : jsonField(req.params, "at_revision")).toEqual(
        d.jsonString("7"),
      );
    }
  });

  it("retains scope filters across selected-key and directory navigation", async () => {
    const h = setup();
    h.controller.select(h.context, { ...target, key: null });
    await until(() => h.controller.get().values.kind === "ready");
    h.controller.query({ prefix: "settings", includeDeleted: true, predicates: [] });
    h.handle((method) => Promise.resolve(response(page(method === "fact.keys" ? [] : [record]))));
    h.controller.select(h.context, { ...target, key: "settings" });
    await until(() => h.controller.get().detail.kind === "ready");
    expect(h.controller.get().query.prefix).toBe("settings");
    h.controller.select(h.context, { ...target, key: null });
    expect(h.controller.get().selectedKey).toBeNull();
    expect(h.controller.get().query).toEqual({
      prefix: "settings",
      includeDeleted: true,
      predicates: [],
    });
  });

  it("never republishes an obsolete same-target read rejection globally", async () => {
    const h = setup(),
      old = deferred<ReadResponse>();
    let count = 0;
    h.handle((method) =>
      method === "fact.keys" && count++ === 0 ? old.promise : Promise.resolve(response(page([]))),
    );
    h.controller.select(h.context);
    h.controller.refresh();
    await until(() => h.controller.get().keys.kind === "ready");
    old.reject(new TypeError("old programming defect"));
    await new Promise((r) => setTimeout(r, 5));
    expect(h.controller.get().unexpected).toBeNull();
    expect(h.controller.get().keys.kind).toBe("ready");
  });
  it("returns through reverse reference pages with the original capture and resets a changed reference", async () => {
    const h = setup();
    h.controller.select(h.context);
    await until(() => h.controller.get().values.kind === "ready");
    h.handle((_method, params) => {
      const offset = jsonField(params, "offset");
      if (offset?.kind !== "string") throw new Error("offset");
      const last = offset.value === "2";
      const ref = jsonField(params, "reference");
      if (ref?.kind !== "object") throw new Error("reference");
      const id = jsonField(ref, "id");
      if (id?.kind !== "string") throw new Error("id");
      return Promise.resolve(
        response(
          page(
            (last ? ["c"] : ["a", "b"]).map((key) => ({
              ...record,
              key,
              references: [{ kind: "ticket", id: id.value }],
            })),
            offset.value,
            last ? "0" : "1",
            last ? null : "2",
          ),
        ),
      );
    });
    const ref = { kind: "ticket" as const, id: decode(d.identifier, "design") };
    h.controller.references(ref);
    await until(() => h.controller.get().references.kind === "ready");
    h.controller.nextReferences();
    await until(() => h.controller.get().referencePreviousOffsets.length === 1);
    h.controller.previousReferences();
    await until(() => h.controller.get().referencePreviousOffsets.length === 0);
    expect(
      h.requests
        .filter((r) => r.method === "fact.references")
        .map((r) => [jsonField(r.params, "offset"), jsonField(r.params, "at_revision")]),
    ).toEqual([
      [d.jsonString("0"), undefined],
      [d.jsonString("2"), d.jsonString("7")],
      [d.jsonString("0"), d.jsonString("7")],
    ]);
    h.controller.nextReferences();
    await until(() => h.controller.get().referencePreviousOffsets.length === 1);
    h.controller.references({ kind: "ticket", id: decode(d.identifier, "other") });
    expect(h.controller.get().referencePreviousOffsets).toEqual([]);
    expect(h.controller.get().references.kind).toBe("loading");
  });
  it("binds reference continuation to exact ref/target and clears results when inspecting another key", async () => {
    const h = setup();
    h.controller.select(h.context);
    await until(() => h.controller.get().values.kind === "ready");
    h.handle(() =>
      Promise.resolve(
        response(page([{ ...record, references: [{ kind: "ticket", id: "a" }] }], "0", "1", "1")),
      ),
    );
    const a = { kind: "ticket" as const, id: decode(d.identifier, "a") },
      b = { kind: "ticket" as const, id: decode(d.identifier, "b") };
    h.controller.references(a);
    await until(() => h.controller.get().references.kind === "ready");
    const before = h.requests.length;
    h.controller.references(b, decimal("1"));
    expect(h.requests).toHaveLength(before);
    expect(h.controller.get().issue).toContain("no longer matches");
    h.controller.inspect("another");
    expect(h.controller.get().references.kind).toBe("idle");
    expect(h.controller.get().referenceQuery).toBeNull();
    h.controller.changeScope({ kind: "project", id: decode(d.identifier, "elsewhere") });
    const afterScope = h.requests.length;
    h.controller.references(a, decimal("1"));
    expect(h.requests).toHaveLength(afterScope);
    expect(h.controller.get().issue).toContain("no longer matches");
  });
});
