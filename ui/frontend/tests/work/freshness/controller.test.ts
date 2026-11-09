import type { OperationController, ManagedOperation } from "../../../src/core/state/operations";
import type { Operation } from "../../../src/core/protocol/types";
import { workCapturePredatesWrite } from "../../../src/features/work/freshness";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkController } from "../../../src/features/work/read-model";
import type { WorkController, WorkScope } from "../../../src/features/work/read-model.types";
import { jsonField, parseJsonText, type JsonValue } from "../../../src/core/json";
import * as d from "../../../src/core/protocol/decoders";
import type { Codec } from "../../../src/core/protocol/codec";
import type { HttpClient, HttpRequest, HttpResult } from "../../../src/core/protocol/http";
import type { JsonObject, ReadResponse } from "../../../src/core/protocol/types";
import { createTestProcessor } from "../../core/processing-harness";

function json(value: unknown): JsonValue {
  const r = parseJsonText(JSON.stringify(value));
  if (!r.ok) throw new Error(r.error.message);
  return r.value.value;
}
function decode<T>(codec: Codec<T>, value: unknown): T {
  const r = codec.decode(json(value));
  if (!r.ok) throw new Error(`${r.issue.path.join(".")}: ${r.issue.expected}`);
  return r.value;
}
const scope: WorkScope = {
  connection: decode(d.connectionProfile, {
    id: "local",
    generation: "1",
    label: "Synthetic",
    socket: "/tmp/synthetic.sock",
  }),
  workspaceId: decode(d.identifier, "demo"),
  projectId: decode(d.identifier, "release"),
};
function page(
  items: readonly unknown[],
  offset = "0",
  next: string | null = null,
  remaining = "0",
) {
  return { items, offset, next_offset: next, remaining };
}
function pagination(revision = "7", extra: Record<string, unknown> = {}) {
  return {
    capture: { workspace_revision: revision },
    consistency: "current_revision_guard",
    complete: true,
    stop: "complete",
    next_request: null,
    retry_request: null,
    ...extra,
  };
}
function response(data: unknown, paging: unknown = pagination(), revision = "7"): ReadResponse {
  return decode(d.readResponse, {
    response: {
      data,
      meta: {
        workspace_revision: revision,
        budget: { truncated: false, omitted_fields: "0", omitted_items: "0" },
      },
    },
    pagination: paging,
  });
}
const owners: {
  readonly controller: WorkController;
  readonly processor: ReturnType<typeof createTestProcessor>;
}[] = [];
afterEach(() => {
  for (const { controller, processor } of owners) {
    controller.dispose();
    processor.dispose();
  }
  owners.length = 0;
});
function fixture(
  handler: (
    method: string,
    params: JsonObject,
    signal: AbortSignal | undefined,
  ) => Promise<ReadResponse> | ReadResponse,
  operations: OperationController,
) {
  let fail = false;
  const processor = createTestProcessor(),
    calls: { method: string; params: JsonObject; signal: AbortSignal | undefined }[] = [];
  const client: HttpClient = {
    processing: processor,
    async request<T>(request: HttpRequest<T>): Promise<HttpResult<T>> {
      if (fail)
        return { ok: false, failure: { kind: "network", message: "controlled transport failure" } };
      const name = request.body?.kind === "object" ? jsonField(request.body, "method") : undefined,
        params = request.body?.kind === "object" ? jsonField(request.body, "params") : undefined;
      if (name?.kind !== "string" || params?.kind !== "object")
        throw new Error("Expected read invocation");
      calls.push({ method: name.value, params, signal: request.signal });
      const result = await handler(name.value, params, request.signal);
      const decoded = request.codec.decode(
        d.jsonObject([
          [
            "response",
            d.jsonObject([
              ["data", result.response.data],
              ["meta", result.response.meta],
            ]),
          ],
          ["pagination", result.pagination ?? d.jsonNull()],
        ]),
      );
      return decoded.ok
        ? { ok: true, data: decoded.value, httpStatus: 200 }
        : {
            ok: false,
            failure: {
              kind: "protocol",
              message: "Invalid fixture response",
              issue: decoded.issue,
            },
          };
    },
  };
  const controller = createWorkController({ client, operations });
  owners.push({ controller, processor });
  return {
    controller,
    calls,
    fail: (value: boolean) => {
      fail = value;
    },
  };
}

function notifications() {
  const listeners = new Set<() => void>();
  let entries: readonly ManagedOperation[] = [];
  const operations: OperationController = {
    get: () => undefined,
    list: () => entries,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    register: () => {
      throw new Error("No automatic mutation");
    },
    adopt: () => {
      throw new Error("No automatic adoption");
    },
    act: () => {
      throw new Error("No automatic mutation");
    },
    dispose: () => undefined,
  };
  function commit(
    revision: string,
    connection = scope.connection,
    actualWorkspace = scope.workspaceId,
    selectedWorkspace = scope.workspaceId,
  ) {
    const params = d.jsonObject([["workspace_id", d.jsonString(actualWorkspace)]]);
    const preparation = {
      intention_id: decode(d.identifier, "intent"),
      context: {
        workspace_id: selectedWorkspace,
        project_id: scope.projectId,
        writer: { actor_id: decode(d.identifier, "author"), run_id: null },
      },
      method: "dependency.add",
      params,
    };
    const operation: Operation = {
      format: "workgraph-ui-operation-1",
      operation_id: decode(d.identifier, "op"),
      connection,
      preparation: { ...preparation, connection },
      preparation_input_hash: decode(d.digest, "a".repeat(64)),
      request: params,
      journal_path: "/tmp/synthetic.json",
      revision: decode(d.decimal, "2"),
      state: {
        kind: "committed",
        response: {
          data: params,
          meta: d.jsonObject([
            ["durable", d.jsonBoolean(true)],
            ["workspace_revision", d.jsonString(revision)],
          ]),
        },
      },
      diagnostic: null,
      receipt_lookup_supported: true,
    };
    entries = [
      {
        preparation: {
          ...preparation,
          connection_id: connection.id,
          generation: connection.generation,
        },
        operation,
        phase: { kind: "observed" },
      },
    ];
    for (const listener of listeners) listener();
  }
  return { operations, commit, listeners };
}
describe("Work owns only matching committed-write freshness", () => {
  it("invalidates only an Advanced write's actual workspace without automatic reads or mutations", async () => {
    const n = notifications(),
      f = fixture(() => response(page([])), n.operations);
    const other = { ...scope, workspaceId: decode(d.identifier, "actual-workspace") };
    for (const [navigation, destination] of [
      [scope, other],
      [other, scope],
    ] as const) {
      await f.controller.open(navigation, null);
      const count = f.calls.length;
      n.commit("8", scope.connection, destination.workspaceId, navigation.workspaceId);
      expect.soft(f.controller.get().ownWrite).toBeNull();
      expect.soft(workCapturePredatesWrite(f.controller.get())).toBe(false);
      expect(f.calls).toHaveLength(count);
      await f.controller.open(destination, null);
      expect.soft(f.controller.get().ownWrite?.workspaceRevision).toBe("8");
      expect.soft(workCapturePredatesWrite(f.controller.get())).toBe(true);
      expect(f.calls).toHaveLength(count + 1);
      await f.controller.open(navigation, null);
      expect.soft(f.controller.get().ownWrite).toBeNull();
      expect(f.calls).toHaveLength(count + 2);
    }
    expect(f.calls.every((call) => call.method === "ticket.list")).toBe(true);
  });
  it("marks an empty retained list without requery, survives failed/older refresh and clears on actual new capture", async () => {
    const n = notifications();
    let revision = "7";
    const f = fixture(() => response(page([]), pagination(revision), revision), n.operations);
    await f.controller.open(scope, null);
    expect(f.calls).toHaveLength(1);
    n.commit("8");
    expect(f.calls).toHaveLength(1);
    expect(workCapturePredatesWrite(f.controller.get())).toBe(true);
    f.fail(true);
    await f.controller.refresh();
    expect(f.controller.get().list.kind).toBe("failed");
    expect(workCapturePredatesWrite(f.controller.get())).toBe(true);
    f.fail(false);
    await f.controller.refresh();
    expect(workCapturePredatesWrite(f.controller.get())).toBe(true);
    revision = "8";
    await f.controller.refresh();
    expect(workCapturePredatesWrite(f.controller.get())).toBe(false);
    expect(f.calls.every((call) => call.method === "ticket.list")).toBe(true);
    f.controller.dispose();
    expect(n.listeners.size).toBe(0);
  });
  it("does not mark a new generation/socket with repeated IDs, and restores the original endpoint's warning", async () => {
    const n = notifications(),
      f = fixture(() => response(page([])), n.operations);
    await f.controller.open(scope, null);
    n.commit("8");
    expect(workCapturePredatesWrite(f.controller.get())).toBe(true);
    await f.controller.open(
      {
        ...scope,
        connection: {
          ...scope.connection,
          generation: decode(d.positiveDecimal, "2"),
          socket: "/tmp/replacement.sock",
        },
      },
      null,
    );
    expect(f.controller.get().ownWrite).toBeNull();
    n.commit("9");
    expect(f.controller.get().ownWrite).toBeNull();
    await f.controller.open(
      {
        ...scope,
        connection: { ...scope.connection, socket: "/tmp/same-generation-other-root.sock" },
      },
      null,
    );
    expect(f.controller.get().ownWrite).toBeNull();
    await f.controller.open(scope, null);
    expect(workCapturePredatesWrite(f.controller.get())).toBe(true);
  });
});
