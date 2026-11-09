import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProgressObserver,
  type ProgressStatus,
} from "../../src/core/state/progress-observer";
import {
  createOperationController,
  type OperationController,
} from "../../src/core/state/operations";
import { parseJsonText } from "../../src/core/json";
import * as d from "../../src/core/protocol/decoders";
import type { Companion } from "../../src/core/protocol/client";
import type { HttpResult } from "../../src/core/protocol/http";
import type { Operation } from "../../src/core/protocol/types";
import { createTestProcessor } from "./processing-harness";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const ok = <T>(data: T): HttpResult<T> => ({ ok: true, data, httpStatus: 200 });
function operation(
  state: Operation["state"] = { kind: "prepared_unsent" },
  revision = "1",
): Operation {
  const profile = {
    id: "local",
    generation: "1",
    label: "Original endpoint",
    socket: "/tmp/original.sock",
  };
  const context = {
    workspace_id: "work",
    project_id: "project",
    writer: { actor_id: "rowan", run_id: "run-1" },
  };
  const parsed = parseJsonText(
    JSON.stringify({
      format: "workgraph-ui-operation-1",
      operation_id: "op-1",
      preparation: {
        intention_id: "intent-1",
        context,
        connection: profile,
        method: "ticket.create",
        params: { title: "original" },
      },
      preparation_input_hash: "b".repeat(64),
      connection: profile,
      request: {
        jsonrpc: "2.0",
        workgraph_api: "0.7",
        id: "1",
        method: "ticket.create",
        params: { title: "original", mutation_id: "m-1" },
      },
      journal_path: "/tmp/op-1.json",
      revision,
      state,
      diagnostic: null,
      receipt_lookup_supported: true,
    }),
  );
  if (!parsed.ok) throw new Error(parsed.error.message);
  const decoded = d.operation.decode(parsed.value.value);
  if (!decoded.ok) throw new Error(decoded.issue.expected);
  return decoded.value;
}
function controller(overrides: Partial<Companion>): OperationController {
  const unexpected = (): never => {
    throw new Error("Unexpected client call");
  };
  const processing = createTestProcessor();
  const value = createOperationController(
    {
      connections: unexpected,
      read: unexpected,
      prepare: unexpected,
      inspect: unexpected,
      act: unexpected,
      ...overrides,
    },
    processing,
  );
  cleanups.push(() => {
    value.dispose();
    processing.dispose();
  });
  return value;
}
const committed = () =>
  operation(
    { kind: "committed", response: { data: d.jsonObject([]), meta: d.jsonObject([]) } },
    "3",
  );
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Condition did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("finite read-only progress", () => {
  it("coalesces one identity without extending time, stops at the exact attempt cap", async () => {
    vi.useFakeTimers();
    const observer = createProgressObserver();
    cleanups.push(observer.dispose);
    const statuses: ProgressStatus[] = [];
    const inspect = vi.fn(() => Promise.resolve("pending" as const));
    const unexpected = vi.fn();
    observer.start("one", { inspect, changed: (s) => statuses.push(s), unexpected });
    observer.start("one", { inspect: vi.fn(), changed: vi.fn(), unexpected });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(inspect).toHaveBeenCalledTimes(12);
    expect(statuses.at(-1)).toEqual({ kind: "stopped", reason: "attempt_limit", attempts: 12 });
    await vi.advanceTimersByTimeAsync(100_000);
    expect(inspect).toHaveBeenCalledTimes(12);
    expect(unexpected).not.toHaveBeenCalled();
  });
  it("bounds active identities, deadline-aborts a stuck read, and ignores its late result", async () => {
    vi.useFakeTimers();
    const observer = createProgressObserver();
    cleanups.push(observer.dispose);
    const read = deferred<"complete">();
    const signals: AbortSignal[] = [];
    const statuses: ProgressStatus[] = [];
    for (let i = 0; i < 8; i++)
      observer.start(String(i), {
        inspect: (signal) => {
          signals.push(signal);
          return read.promise;
        },
        changed: (s) => statuses.push(s),
        unexpected: vi.fn(),
      });
    const ninth: ProgressStatus[] = [];
    observer.start("ninth", {
      inspect: vi.fn(),
      changed: (s) => ninth.push(s),
      unexpected: vi.fn(),
    });
    expect(ninth).toEqual([{ kind: "stopped", reason: "busy", attempts: 0 }]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(signals).toHaveLength(8);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(statuses.filter((s) => s.kind === "stopped")).toHaveLength(8);
    expect(statuses.at(-1)).toEqual({ kind: "stopped", reason: "deadline", attempts: 1 });
    const count = statuses.length;
    read.resolve("complete");
    await Promise.resolve();
    await Promise.resolve();
    expect(statuses).toHaveLength(count);
  });
  it.each(["complete", "unknown", "error"] as const)(
    "stops after a %s observation without another read",
    async (decision) => {
      vi.useFakeTimers();
      const observer = createProgressObserver();
      cleanups.push(observer.dispose);
      const statuses: ProgressStatus[] = [];
      const inspect = vi.fn(() => Promise.resolve(decision));
      observer.start("one", { inspect, changed: (s) => statuses.push(s), unexpected: vi.fn() });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(statuses.at(-1)).toEqual({ kind: "stopped", reason: decision, attempts: 1 });
    },
  );
  it("retains unexpected exceptions and distinguishes cancellation from disposal", async () => {
    vi.useFakeTimers();
    const observer = createProgressObserver();
    const bug = new Error("programmer defect"),
      unexpected = vi.fn(),
      statuses: ProgressStatus[] = [];
    observer.start("bug", {
      inspect: () => Promise.reject(bug),
      changed: (s) => statuses.push(s),
      unexpected,
    });
    await vi.advanceTimersByTimeAsync(150);
    expect(unexpected).toHaveBeenCalledExactlyOnceWith(bug);
    observer.start("cancel", { inspect: vi.fn(), changed: (s) => statuses.push(s), unexpected });
    observer.stop("cancel");
    expect(statuses.at(-1)).toEqual({ kind: "stopped", reason: "cancelled", attempts: 0 });
    observer.start("dispose", { inspect: vi.fn(), changed: (s) => statuses.push(s), unexpected });
    observer.dispose();
    expect(statuses.at(-1)).toEqual({ kind: "stopped", reason: "disposed", attempts: 0 });
    observer.start("after", { inspect: vi.fn(), changed: (s) => statuses.push(s), unexpected });
    expect(statuses.at(-1)?.kind).toBe("stopped");
  });
});

describe("operation-owned observation", () => {
  it("observes an already-sending intention recovered by one explicit preparation", async () => {
    let preparations = 0,
      reads = 0;
    const value = controller({
      prepare: () => {
        preparations++;
        return Promise.resolve(ok(operation({ kind: "sending" }, "2")));
      },
      inspect: () => {
        reads++;
        return Promise.resolve(ok(committed()));
      },
    });
    await value.adopt(operation());
    expect((await value.act(operation().preparation.intention_id, "prepare")).ok).toBe(true);
    await until(
      () => value.get(operation().preparation.intention_id)?.operation?.state.kind === "committed",
    );
    expect(preparations).toBe(1);
    expect(reads).toBe(1);
  });
  it("does not observe list/adopt alone; one explicit execution reaches committed with only original-ID reads", async () => {
    const ids: string[] = [];
    let writes = 0,
      reads = 0;
    const value = controller({
      act: (id, action) => {
        expect(id).toBe("op-1");
        expect(action).toBe("execute");
        writes++;
        return Promise.resolve(ok(operation({ kind: "sending" }, "2")));
      },
      inspect: (id) => {
        ids.push(id);
        reads++;
        return Promise.resolve(ok(reads === 1 ? operation({ kind: "sending" }, "2") : committed()));
      },
    });
    await value.adopt(operation({ kind: "sending" }, "2"));
    value.list();
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(reads).toBe(0);
    // Explicit action starts the finite reader; view/actor selection never replaces its owner.
    const inspecting = value.act(operation().preparation.intention_id, "execute");
    expect(value.act(operation().preparation.intention_id, "execute")).toBe(inspecting);
    expect((await inspecting).ok).toBe(true);
    await until(
      () => value.get(operation().preparation.intention_id)?.operation?.state.kind === "committed",
    );
    const entry = value.get(operation().preparation.intention_id)!;
    expect(writes).toBe(1);
    expect(ids).toEqual(["op-1", "op-1"]);
    expect(entry.preparation.context.writer.actor_id).toBe("rowan");
    expect(entry.preparation.connection_id).toBe("local");
    expect(entry.preparation.context.workspace_id).toBe("work");
    await until(
      () => value.get(operation().preparation.intention_id)?.observation?.kind === "stopped",
    );
    expect(value.get(operation().preparation.intention_id)?.observation).toEqual({
      kind: "stopped",
      reason: "complete",
      attempts: 2,
    });
  });
  it("explicit Inspect cancels only a background GET and ignores its older late response", async () => {
    const slow = deferred<HttpResult<Operation>>();
    let automaticSignal: AbortSignal | undefined;
    let reads = 0,
      writes = 0;
    const value = controller({
      act: () => {
        writes++;
        return Promise.resolve(ok(operation({ kind: "sending" }, "2")));
      },
      inspect: (_id, signal) => {
        reads++;
        if (reads === 1) {
          automaticSignal = signal;
          return slow.promise;
        }
        return Promise.resolve(ok(committed()));
      },
    });
    await value.adopt(operation());
    await value.act(operation().preparation.intention_id, "execute");
    await until(() => reads === 1);
    expect((await value.act(operation().preparation.intention_id, "inspect")).ok).toBe(true);
    expect(automaticSignal?.aborted).toBe(true);
    slow.resolve(ok(operation({ kind: "sending" }, "2")));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(value.get(operation().preparation.intention_id)?.operation?.revision).toBe("3");
    expect(value.get(operation().preparation.intention_id)?.operation?.state.kind).toBe(
      "committed",
    );
    expect(writes).toBe(1);
    expect(reads).toBe(2);
  });
  it.each(["network", "missing", "protocol", "unknown"] as const)(
    "stops on %s with truthful last outcome and no automatic retry",
    async (kind) => {
      let writes = 0,
        reads = 0;
      const value = controller({
        act: () => {
          writes++;
          return Promise.resolve(ok(operation({ kind: "sending" }, "2")));
        },
        inspect: () => {
          reads++;
          if (kind === "unknown")
            return Promise.resolve(
              ok(
                operation(
                  {
                    kind: "outcome_unknown",
                    problem: { kind: "Io", message: "uncertain", details: undefined },
                  },
                  "3",
                ),
              ),
            );
          return Promise.resolve({
            ok: false,
            failure:
              kind === "network"
                ? { kind: "network", message: "disconnected" }
                : kind === "protocol"
                  ? { kind: "protocol", message: "invalid observation", issue: undefined }
                  : {
                      kind: "remote",
                      httpStatus: 404,
                      problem: { kind: "Not_found", message: "missing", details: undefined },
                    },
          } as const);
        },
      });
      await value.adopt(operation());
      await value.act(operation().preparation.intention_id, "execute");
      await until(
        () => value.get(operation().preparation.intention_id)?.observation?.kind === "stopped",
      );
      expect(value.get(operation().preparation.intention_id)?.operation?.state.kind).toBe(
        kind === "unknown" ? "outcome_unknown" : "sending",
      );
      expect(writes).toBe(1);
      expect(reads).toBe(1);
    },
  );
  it("ignores an older background read after another observer publishes a terminal revision", async () => {
    const slow = deferred<HttpResult<Operation>>();
    let reads = 0;
    const value = controller({
      act: () => Promise.resolve(ok(operation({ kind: "sending" }, "2"))),
      inspect: () => {
        reads++;
        return slow.promise;
      },
    });
    await value.adopt(operation());
    await value.act(operation().preparation.intention_id, "execute");
    await until(() => reads === 1);
    await value.adopt(committed());
    slow.resolve(ok(operation({ kind: "sending" }, "2")));
    await until(
      () => value.get(operation().preparation.intention_id)?.observation?.kind === "stopped",
    );
    expect(value.get(operation().preparation.intention_id)?.phase.kind).toBe("observed");
    expect(value.get(operation().preparation.intention_id)?.operation?.revision).toBe("3");
    expect(value.get(operation().preparation.intention_id)?.observation).toEqual({
      kind: "stopped",
      reason: "complete",
      attempts: 1,
    });
  });
  it("retains an unexpected inspect exception for the owning boundary without retry", async () => {
    const bug = new Error("unexpected transport defect");
    let reads = 0;
    const value = controller({
      act: () => Promise.resolve(ok(operation({ kind: "sending" }, "2"))),
      inspect: () => {
        reads++;
        return Promise.reject(bug);
      },
    });
    await value.adopt(operation());
    await value.act(operation().preparation.intention_id, "execute");
    await until(
      () => value.get(operation().preparation.intention_id)?.phase.kind === "unexpected_error",
    );
    const phase = value.get(operation().preparation.intention_id)?.phase;
    expect(phase?.kind === "unexpected_error" && phase.error).toBe(bug);
    expect(reads).toBe(1);
  });
  it("disposal aborts the observation signal and cannot undo or repeat an admitted write", async () => {
    let signal: AbortSignal | undefined,
      writes = 0;
    const slow = deferred<HttpResult<Operation>>();
    const value = controller({
      act: () => {
        writes++;
        return Promise.resolve(ok(operation({ kind: "sending" }, "2")));
      },
      inspect: (_id, captured) => {
        signal = captured;
        return slow.promise;
      },
    });
    await value.adopt(operation());
    await value.act(operation().preparation.intention_id, "execute");
    await until(() => signal !== undefined);
    value.dispose();
    expect(signal?.aborted).toBe(true);
    expect(writes).toBe(1);
    slow.resolve(ok(committed()));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(value.get(operation().preparation.intention_id)?.operation?.state.kind).toBe("sending");
    expect(value.get(operation().preparation.intention_id)?.observation).toEqual({
      kind: "stopped",
      reason: "disposed",
      attempts: 1,
    });
  });
  it("rechecks ownership after asynchronous worker validation of a background result", async () => {
    const processing = createTestProcessor();
    const gate = deferred<void>();
    let validating = false;
    const unused = (): never => {
      throw new Error("Unexpected call");
    };
    const value = createOperationController(
      {
        connections: unused,
        read: unused,
        prepare: unused,
        act: () => Promise.resolve(ok(operation({ kind: "sending" }, "2"))),
        inspect: () => Promise.resolve(ok(committed())),
      },
      {
        ...processing,
        observeOperation: async (input, options) => {
          if (input.state.kind === "committed") {
            validating = true;
            await gate.promise;
          }
          return processing.observeOperation(input, options);
        },
      },
    );
    cleanups.push(() => {
      value.dispose();
      processing.dispose();
    });
    await value.adopt(operation());
    await value.act(operation().preparation.intention_id, "execute");
    await until(() => validating);
    value.dispose();
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(value.get(operation().preparation.intention_id)?.operation?.state.kind).toBe("sending");
    expect(value.get(operation().preparation.intention_id)?.observation).toEqual({
      kind: "stopped",
      reason: "disposed",
      attempts: 1,
    });
  });
});
