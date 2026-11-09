import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, parseJsonText, type JsonValue } from "../../src/core/json";
import * as d from "../../src/core/protocol/decoders";
import type { Codec } from "../../src/core/protocol/codec";
import type { Companion } from "../../src/core/protocol/client";
import type { HttpResult } from "../../src/core/protocol/http";
import type { Operation, Preparation } from "../../src/core/protocol/types";
import { createOperationController as operationController } from "../../src/core/state/operations";
import {
  createReadSlot,
  readKey,
  readKeyAsync,
  type ReadScope,
} from "../../src/core/state/read-slot";

import { createTestProcessor } from "./processing-harness";
const processors: ReturnType<typeof createTestProcessor>[] = [];
afterEach(() => {
  for (const processor of processors.splice(0)) processor.dispose();
});
function createOperationController(client: Companion) {
  const processor = createTestProcessor();
  processors.push(processor);
  return operationController(client, processor);
}
function json(source: string): JsonValue {
  const result = parseJsonText(source);
  if (!result.ok) throw new Error(result.error.message);
  return result.value.value;
}
function decode<T>(codec: Codec<T>, source: string): T {
  const result = codec.decode(json(source));
  if (!result.ok) throw new Error(result.issue.expected);
  return result.value;
}
const profile = '{"id":"local","generation":"1","label":"Local","socket":"/tmp/daemon.sock"}';
const context =
  '{"workspace_id":"work","project_id":"project","writer":{"actor_id":"rowan","run_id":"run-1"}}';
function draft(params = '{"b":2,"a":9007199254740993}', method = "ticket.create"): Preparation {
  return decode(
    d.preparation,
    `{"intention_id":"intent-1","context":${context},"connection_id":"local","generation":"1","method":"${method}","params":${params}}`,
  );
}
function observation(
  state = '{"kind":"prepared_unsent"}',
  revision = "1",
  method = "ticket.create",
): Operation {
  return decode(
    d.operation,
    `{"format":"workgraph-ui-operation-1","operation_id":"op-1","preparation":{"intention_id":"intent-1","context":${context},"connection":${profile},"method":"${method}","params":{"a":9007199254740993,"b":2}},"preparation_input_hash":"${"b".repeat(64)}","connection":${profile},"request":{"jsonrpc":"2.0","workgraph_api":"0.7","id":"1","method":"${method}","params":{"a":9007199254740993,"b":2,"mutation_id":"m-1"}},"journal_path":"/tmp/op-1.json","revision":"${revision}","state":${state},"diagnostic":null,"receipt_lookup_supported":true}`,
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function client(overrides: Partial<Companion> = {}): Companion {
  const unexpected = (): never => {
    throw new Error("Unexpected client call");
  };
  return {
    connections: unexpected,
    read: unexpected,
    prepare: unexpected,
    inspect: unexpected,
    act: unexpected,
    ...overrides,
  };
}
const ok = <T>(data: T): HttpResult<T> => ({ ok: true, data, httpStatus: 200 });

describe("canonical identity", () => {
  it("sorts decoded names in native UTF-8 order, preserving arrays and number spelling", () => {
    expect(canonicalJson(json('{"𐀀":1,"\ue000":2,"x":[1.0,1e0,-0],"a":{"z":1,"b":2}}'))).toEqual({
      ok: true,
      value: '{"a":{"b":2,"z":1},"x":[1.0,1e0,-0],"\ue000":2,"𐀀":1}',
    });
  });
  it("validates duplicate keys and cycles before ordering", () => {
    const fields: { name: string; value: JsonValue }[] = [];
    const cyclic: JsonValue = { kind: "object", fields };
    fields.push({ name: "self", value: cyclic });
    expect(canonicalJson(cyclic).ok).toBe(false);
    expect(
      canonicalJson({
        kind: "object",
        fields: [
          { name: "a", value: json("0") },
          { name: "a", value: json("1") },
        ],
      }).ok,
    ).toBe(false);
  });
});

describe("operation controller", () => {
  it("captures mutable caller data before admission yields", async () => {
    const controller = createOperationController(client());
    const params = {
      kind: "object" as const,
      fields: [{ name: "a", value: { kind: "string" as const, value: "original" } }],
    };
    const preparation = { ...draft(), params };
    const registering = controller.register(preparation);
    params.fields[0]!.value.value = "changed";
    expect((await registering).ok).toBe(true);
    expect(controller.get(preparation.intention_id)?.preparation.params).toEqual({
      kind: "object",
      fields: [{ name: "a", value: { kind: "string", value: "original" } }],
    });
    expect((await controller.register(preparation)).ok).toBe(false);
  });
  it("rechecks conflicting admissions and newer observations after worker awaits", async () => {
    const processing = createTestProcessor();
    processors.push(processing);
    const gate = deferred<void>();
    let first = true;
    const controller = operationController(client(), {
      ...processing,
      admitPreparation: (preparation: Preparation) => {
        const captured = processing.admitPreparation(preparation);
        if (!first) return captured;
        first = false;
        return captured.then(async (result) => {
          await gate.promise;
          return result;
        });
      },
    });
    const delayed = controller.register(draft('{"a":1}'));
    expect((await controller.register(draft('{"a":2}'))).ok).toBe(true);
    gate.resolve();
    expect((await delayed).ok).toBe(false);
    const observationGate = deferred<void>();
    const observing = operationController(client(), {
      ...processing,
      observeOperation: (operation: Operation) => {
        const captured = processing.observeOperation(operation);
        return operation.revision === "2"
          ? captured.then(async (result) => {
              await observationGate.promise;
              return result;
            })
          : captured;
      },
    });
    expect((await observing.adopt(observation())).ok).toBe(true);
    const old = observing.adopt(observation('{"kind":"sending"}', "2"));
    expect((await observing.adopt(observation('{"kind":"sending"}', "3"))).ok).toBe(true);
    observationGate.resolve();
    expect((await old).ok).toBe(false);
    expect(observing.get(draft().intention_id)?.operation?.revision).toBe("3");
  });

  it("freezes the generated request identity and committed receipt across later observations", async () => {
    const controller = createOperationController(client());
    const initial = observation();
    expect((await controller.adopt(initial)).ok).toBe(true);
    const later = observation('{"kind":"sending"}', "2");
    const changedRequest = d.jsonObject([
      ["jsonrpc", d.jsonString("2.0")],
      ["workgraph_api", d.jsonString("0.7")],
      ["id", d.jsonString("1")],
      ["method", d.jsonString("ticket.create")],
      ["params", json('{"a":9007199254740993,"b":2,"mutation_id":"m-2"}')],
    ]);
    expect((await controller.adopt({ ...later, request: changedRequest })).ok).toBe(false);
    expect((await controller.adopt({ ...later, journal_path: "/tmp/other.json" })).ok).toBe(false);
    const committed = observation(
      '{"kind":"committed","response":{"data":{"answer":1},"meta":{}}}',
      "3",
    );
    expect((await controller.adopt(committed)).ok).toBe(true);
    expect(
      (
        await controller.adopt(
          observation('{"kind":"committed","response":{"data":{"answer":2},"meta":{}}}', "4"),
        )
      ).ok,
    ).toBe(false);
  });
  it("retains newer observations across action admission and a mismatched response", async () => {
    const response = deferred<HttpResult<Operation>>();
    const controller = createOperationController(client({ inspect: () => response.promise }));
    await controller.adopt(observation());
    const id = draft().intention_id;
    const pending = controller.act(id, "inspect");
    await controller.adopt(observation('{"kind":"sending"}', "2"));
    await Promise.resolve();
    expect(controller.get(id)?.operation?.revision).toBe("2");
    const wrong = observation();
    response.resolve(
      ok({
        ...wrong,
        preparation: { ...wrong.preparation, intention_id: decode(d.identifier, '"different"') },
      }),
    );
    expect((await pending).ok).toBe(false);
    expect(controller.get(id)?.operation?.revision).toBe("2");
    expect(controller.get(id)?.phase.kind).toBe("unconfirmed");
  });
  it("matches server-reordered params while preserving the complete captured identity", async () => {
    const controller = createOperationController(client());
    const original = draft();
    expect((await controller.register(original)).ok).toBe(true);
    expect((await controller.adopt(observation())).ok).toBe(true);
    expect((await controller.register(draft('{"a":9007199254740993,"b":2}'))).ok).toBe(true);
    expect((await controller.register(draft('{"a":9007199254740993.0,"b":2}'))).ok).toBe(false);
    for (const context of [
      { ...original.context, workspace_id: null },
      { ...original.context, project_id: null },
      { ...original.context, writer: { ...original.context.writer, run_id: null } },
      {
        ...original.context,
        writer: { ...original.context.writer, actor_id: decode(d.identifier, '"other"') },
      },
    ])
      expect((await controller.register({ ...original, context })).ok).toBe(false);
  });
  it("coalesces double-clicks and preserves uncertain writes without automatic retries", async () => {
    const response = deferred<HttpResult<Operation>>();
    let calls = 0;
    const controller = createOperationController(
      client({
        act: () => {
          calls++;
          return response.promise;
        },
      }),
    );
    await controller.adopt(observation());
    const id = draft().intention_id;
    const first = controller.act(id, "execute");
    expect(controller.act(id, "execute")).toBe(first);
    expect((await controller.act(id, "inspect")).ok).toBe(false);
    expect(controller.get(id)?.phase.kind).toBe("pending");
    response.resolve({ ok: false, failure: { kind: "network", message: "lost reply" } });
    expect((await first).ok).toBe(false);
    expect(calls).toBe(1);
    expect(controller.get(id)?.phase.kind).toBe("unconfirmed");
    // This old observation is retained for recovery, not rendered as definitely unsent.
    expect(controller.get(id)?.operation?.state.kind).toBe("prepared_unsent");
    expect(controller.get(id)?.preparation.context.writer.actor_id).toBe("rowan");
  });
  it("does not execute before durable preparation or recover without a supported receipt", async () => {
    const controller = createOperationController(client());
    const preparation = draft();
    await controller.register(preparation);
    expect((await controller.act(preparation.intention_id, "execute")).ok).toBe(false);
    await controller.adopt({ ...observation(), receipt_lookup_supported: false });
    expect((await controller.act(preparation.intention_id, "recover")).ok).toBe(false);
  });
  it("allows an explicit empty claim-next retry to later commit", async () => {
    const controller = createOperationController(client());
    const response = '{"response":{"data":{},"meta":{}}}';
    const observed = observation(
      `{"kind":"observed",${response.slice(1)}`,
      "2",
      "ticket.claim_next",
    );
    expect((await controller.adopt(observed)).ok).toBe(true);
    expect(
      (await controller.adopt(observation('{"kind":"sending"}', "3", "ticket.claim_next"))).ok,
    ).toBe(true);
    expect(
      (
        await controller.adopt(
          observation(
            '{"kind":"committed","response":{"data":{},"meta":{}}}',
            "4",
            "ticket.claim_next",
          ),
        )
      ).ok,
    ).toBe(true);
    expect(
      (await controller.adopt(observation('{"kind":"sending"}', "5", "ticket.claim_next"))).ok,
    ).toBe(false);
  });
  it("keeps a newer observation when a pending response is stale and surfaces the mismatch", async () => {
    const response = deferred<HttpResult<Operation>>();
    const controller = createOperationController(client({ inspect: () => response.promise }));
    await controller.adopt(observation());
    const pending = controller.act(draft().intention_id, "inspect");
    await Promise.resolve();
    await controller.adopt(observation('{"kind":"sending"}', "3"));
    response.resolve(ok(observation('{"kind":"sending"}', "2")));
    expect((await pending).ok).toBe(false);
    expect(controller.get(draft().intention_id)?.operation?.revision).toBe("3");
    expect(controller.get(draft().intention_id)?.phase.kind).toBe("unconfirmed");
  });
  it("propagates unexpected implementation failures and clears action ownership", async () => {
    const bug = new Error("client bug");
    const controller = createOperationController(client({ prepare: () => Promise.reject(bug) }));
    await controller.register(draft());
    await expect(controller.act(draft().intention_id, "prepare")).rejects.toBe(bug);
    expect(controller.get(draft().intention_id)?.phase.kind).toBe("unexpected_error");
    await expect(controller.act(draft().intention_id, "prepare")).rejects.toBe(bug);
  });
});

describe("read scope and cancellation", () => {
  it("worker query keys snapshot scope and retain exact numeric lexemes", async () => {
    const processing = createTestProcessor();
    processors.push(processing);
    const scope: ReadScope = {
      connectionId: decode(d.identifier, '"local"'),
      generation: decode(d.positiveDecimal, '"1"'),
      workspaceId: undefined,
      projectId: undefined,
      actorId: undefined,
      runId: undefined,
      history: { kind: "current" },
    };
    const first = await readKeyAsync(
      processing,
      scope,
      "method",
      json('{"a":9007199254740993,"b":1}'),
    );
    expect(
      await readKeyAsync(processing, scope, "method", json('{"b":1,"a":9007199254740993}')),
    ).toEqual(first);
    expect(
      await readKeyAsync(processing, scope, "method", json('{"a":9007199254740993.0,"b":1}')),
    ).not.toEqual(first);
    expect(
      await readKeyAsync(
        processing,
        { ...scope, history: { kind: "empty" } },
        "method",
        json('{"a":9007199254740993,"b":1}'),
      ),
    ).not.toEqual(first);
  });

  it("keys every writer, selection, endpoint generation and capture independently", () => {
    const scope: ReadScope = {
      connectionId: decode(d.identifier, '"local"'),
      generation: decode(d.positiveDecimal, '"1"'),
      workspaceId: undefined,
      projectId: undefined,
      actorId: undefined,
      runId: undefined,
      history: { kind: "current" },
    };
    const keys = new Set([readKey(scope, "history.sessions", json("{}"))]);
    const changed = decode(d.identifier, '"changed"');
    for (const field of ["connectionId", "workspaceId", "projectId", "actorId", "runId"] as const)
      keys.add(readKey({ ...scope, [field]: changed }, "history.sessions", json("{}")));
    keys.add(
      readKey(
        { ...scope, generation: decode(d.positiveDecimal, '"2"') },
        "history.sessions",
        json("{}"),
      ),
    );
    keys.add(readKey({ ...scope, history: { kind: "empty" } }, "history.sessions", json("{}")));
    keys.add(
      readKey(
        { ...scope, history: { kind: "pinned", head: decode(d.digest, `"${"a".repeat(64)}"`) } },
        "history.sessions",
        json("{}"),
      ),
    );
    keys.add(readKey(scope, "history.events", json("{}")));
    keys.add(readKey(scope, "history.sessions", json('{"offset":"1"}')));
    expect(keys.size).toBe(11);
  });
  it("ignores late reads even if transport ignores abort and retains refresh data only within scope", async () => {
    const slot = createReadSlot<string>();
    const first = deferred<HttpResult<string>>();
    let signal: AbortSignal | undefined;
    const pending = slot.load("one", (value) => {
      signal = value;
      return first.promise;
    });
    await slot.load("two", () => Promise.resolve(ok("second")));
    expect(signal?.aborted).toBe(true);
    first.resolve(ok("stale first"));
    expect(await pending).toEqual({ ok: false, superseded: true });
    expect(slot.get()).toEqual({ kind: "ready", key: "two", value: "second" });
    await slot.load("two", () =>
      Promise.resolve({ ok: false, failure: { kind: "network", message: "offline" } }),
    );
    expect(slot.get()).toMatchObject({ kind: "failed", previous: "second" });
    await slot.load("three", () =>
      Promise.resolve({ ok: false, failure: { kind: "network", message: "offline" } }),
    );
    expect(slot.get()).toMatchObject({ kind: "failed", previous: undefined });
  });
  it("cleans up pending readers on disposal and preserves unexpected failures", async () => {
    const slot = createReadSlot<string>();
    const bug = new Error("adapter bug");
    await expect(slot.load("one", () => Promise.reject(bug))).rejects.toBe(bug);
    expect(slot.get()).toMatchObject({ kind: "unexpected_error", error: bug });
    const response = deferred<HttpResult<string>>();
    const pending = slot.load("two", () => response.promise);
    slot.dispose();
    response.resolve(ok("late"));
    expect(await pending).toEqual({ ok: false, superseded: true });
    expect(slot.get()).toEqual({ kind: "idle" });
    await expect(slot.load("three", () => Promise.resolve(ok("invalid")))).rejects.toThrow(
      "disposed",
    );
  });
});
