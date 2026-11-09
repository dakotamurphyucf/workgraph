import { afterEach, describe, expect, it, vi } from "vitest";
import { parseJsonText } from "../../src/core/json";
import { createConnectionDraftStore } from "../../src/features/connections/store";
import { launchCodec } from "../../src/features/connections/client";
import type { Launch, LaunchPlan } from "../../src/features/connections/types";
import type { HttpResult } from "../../src/core/protocol/http";
const stores: ReturnType<typeof createConnectionDraftStore>[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
});
function fixture(status = "starting", revision = "2"): Launch {
  const states: Record<string, unknown> = {
    prepared_unsent: { status: "prepared_unsent" },
    starting: { status: "starting" },
    ready: {
      status: "ready",
      observation: "existing_endpoint",
      ownership: "unknown",
      listing: { data: { items: [] }, meta: {} },
    },
    outcome_unknown: { status: "outcome_unknown", problem: { kind: "Io", message: "uncertain" } },
  };
  const parsed = parseJsonText(
    JSON.stringify({
      plan: {
        intention_id: "launch-1",
        connection: {
          id: "original",
          generation: "1",
          label: "Original endpoint",
          socket: "/tmp/original.sock",
        },
        context: {
          workspace_id: "work",
          project_id: "project",
          writer: { actor_id: "rowan", run_id: "run-1" },
        },
        registry: "/tmp/registry",
        log: "/tmp/startup.log",
        timeout_seconds: "300",
      },
      executable: "/tmp/workgraph",
      input_hash: "b".repeat(64),
      revision,
      state: states[status],
      diagnostic: null,
    }),
  );
  if (!parsed.ok) throw new Error(parsed.error.message);
  const decoded = launchCodec.decode(parsed.value.value);
  if (!decoded.ok) throw new Error(decoded.issue.expected);
  return decoded.value;
}
function store(initial = fixture()) {
  const value = createConnectionDraftStore();
  stores.push(value);
  value.manager.set((previous) => ({ ...previous, frozen: initial.plan, launch: initial }));
  return value;
}
const ok = (data: Launch): HttpResult<Launch> => ({ ok: true, data, httpStatus: 200 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe("retained startup observation", () => {
  it("observes a newer Starting result only after the caller explicitly retries an uncertain plan", async () => {
    vi.useFakeTimers();
    const uncertain = fixture("outcome_unknown", "3"),
      value = store(uncertain);
    value.observeLaunch(fixture("starting", "4"), () => Promise.resolve(ok(fixture("ready", "5"))));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(value.manager.get().launch?.state.status).toBe("ready");
    expect(value.manager.get().launch?.revision).toBe("5");
  });
  it("does not overwrite the prepared identity before admitting the explicit Starting result", async () => {
    vi.useFakeTimers();
    const prepared = fixture("prepared_unsent", "1"),
      value = store(prepared),
      inspect = vi.fn();
    value.observeLaunch({ ...fixture(), executable: "/tmp/changed-workgraph" }, inspect);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(inspect).not.toHaveBeenCalled();
    expect(value.manager.get().launch?.state.status).toBe("prepared_unsent");
    expect(value.manager.get().notice).toContain("retained");
  });
  it("does not publish across an A to B to A plan-selection change", async () => {
    vi.useFakeTimers();
    const initial = fixture(),
      value = store(initial),
      read = deferred<HttpResult<Launch>>();
    value.observeLaunch(initial, () => read.promise);
    const captured = value.manager.get().frozen;
    await vi.advanceTimersByTimeAsync(150);
    value.manager.set((previous) => ({
      ...previous,
      frozen: { ...initial.plan, registry: "/tmp/new" },
    }));
    value.manager.set((previous) => ({ ...previous, frozen: captured }));
    read.resolve(ok(fixture("ready", "3")));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(value.manager.get().launch?.state.status).toBe("starting");
    expect(value.manager.get().launchObservation).toEqual({
      kind: "stopped",
      reason: "unknown",
      attempts: 1,
    });
  });
  it("does not poll saved/prepared plans, and coalesces one explicitly started identity", async () => {
    vi.useFakeTimers();
    const prepared = fixture("prepared_unsent", "1"),
      value = store(prepared);
    const unused = vi.fn();
    value.observeLaunch(prepared, unused);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(unused).not.toHaveBeenCalled();
    const started = fixture();
    value.manager.set((previous) => ({ ...previous, launch: started }));
    const inspect = vi.fn((plan: LaunchPlan) => {
      expect(plan.connection.socket).toBe("/tmp/original.sock");
      expect(plan.context.writer?.actor_id).toBe("rowan");
      return Promise.resolve(ok(fixture("ready", "3")));
    });
    value.observeLaunch(started, inspect);
    value.observeLaunch(started, unused);
    value.manager.set((previous) => ({ ...previous, profileId: "different-current-profile" }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(unused).not.toHaveBeenCalled();
    expect(value.manager.get().launch?.state.status).toBe("ready");
    expect(value.manager.get().launchObservation).toEqual({
      kind: "stopped",
      reason: "complete",
      attempts: 1,
    });
    expect(value.manager.get().frozen?.context.writer?.actor_id).toBe("rowan");
  });
  it("snapshots finite plan metadata before a caller can mutate its input", async () => {
    vi.useFakeTimers();
    const initial = fixture();
    const originalWriter = initial.plan.context.writer;
    if (originalWriter === null) throw new Error("Expected fixture writer");
    const mutable = {
      ...initial,
      plan: {
        ...initial.plan,
        connection: { ...initial.plan.connection },
        context: { ...initial.plan.context, writer: { ...originalWriter } },
      },
    };
    const value = store(mutable);
    const inspect = vi.fn((plan: LaunchPlan) => {
      expect(plan.registry).toBe("/tmp/registry");
      expect(plan.connection.socket).toBe("/tmp/original.sock");
      expect(plan.context.writer?.actor_id).toBe("rowan");
      return Promise.resolve(ok(fixture("ready", "3")));
    });
    value.observeLaunch(mutable, inspect);
    mutable.plan.registry = "/tmp/changed";
    mutable.plan.connection.socket = "/tmp/changed.sock";
    mutable.plan.context.writer.actor_id = "changed" as typeof mutable.plan.context.writer.actor_id;
    await vi.advanceTimersByTimeAsync(150);
    expect(value.manager.get().frozen?.registry).toBe("/tmp/registry");
    expect(value.manager.get().launch?.state.status).toBe("ready");
  });
  it.each(["hash", "executable", "plan", "same_revision"] as const)(
    "rejects a changed %s without rewriting known startup state",
    async (kind) => {
      vi.useFakeTimers();
      const initial = fixture(),
        value = store(initial),
        ready = fixture("ready", "3");
      const changed =
        kind === "hash"
          ? {
              ...ready,
              input_hash: fixture().input_hash.replaceAll("b", "c") as Launch["input_hash"],
            }
          : kind === "executable"
            ? { ...ready, executable: "/tmp/another-workgraph" }
            : kind === "plan"
              ? { ...ready, plan: { ...ready.plan, registry: "/tmp/other" } }
              : { ...ready, revision: initial.revision };
      value.observeLaunch(initial, () => Promise.resolve(ok(changed)));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(value.manager.get().launch?.state.status).toBe("starting");
      expect(value.manager.get().launchObservation).toEqual({
        kind: "stopped",
        reason: "error",
        attempts: 1,
      });
      expect(value.manager.get().notice).toContain("retained");
    },
  );
  it("ignores an older observation and then admits the newer ready revision", async () => {
    vi.useFakeTimers();
    const initial = fixture(),
      value = store(initial);
    let reads = 0;
    value.observeLaunch(initial, () =>
      Promise.resolve(ok(++reads === 1 ? fixture("starting", "1") : fixture("ready", "3"))),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads).toBe(2);
    expect(value.manager.get().launch?.revision).toBe("3");
  });
  it("stops on missing/error or uncertainty without retrying startup", async () => {
    vi.useFakeTimers();
    const initial = fixture(),
      value = store(initial),
      inspect = vi.fn(() =>
        Promise.resolve<HttpResult<Launch>>({
          ok: false,
          failure: {
            kind: "remote",
            httpStatus: 404,
            problem: { kind: "Not_found", message: "saved record missing", details: undefined },
          },
        }),
      );
    value.observeLaunch(initial, inspect);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(value.manager.get().launch?.state.status).toBe("starting");
    expect(value.manager.get().notice).toContain("saved record missing");
    value.observeLaunch(initial, () => Promise.resolve(ok(fixture("outcome_unknown", "3"))));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(value.manager.get().launch?.state.status).toBe("outcome_unknown");
    expect(value.manager.get().launchObservation).toEqual({
      kind: "stopped",
      reason: "unknown",
      attempts: 1,
    });
  });
  it("manual Inspect/disposal cancel only reads and late results cannot cross a replaced plan", async () => {
    vi.useFakeTimers();
    const initial = fixture(),
      value = store(initial),
      read = deferred<HttpResult<Launch>>();
    let signal: AbortSignal | undefined;
    value.observeLaunch(initial, (_plan, s) => {
      signal = s;
      return read.promise;
    });
    await vi.advanceTimersByTimeAsync(150);
    value.stopObservingLaunch(initial.plan.intention_id);
    expect(signal?.aborted).toBe(true);
    value.manager.set((previous) => ({
      ...previous,
      frozen: { ...initial.plan, registry: "/tmp/new-plan" },
    }));
    read.resolve(ok(fixture("ready", "3")));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(value.manager.get().launch?.state.status).toBe("starting");
    expect(value.manager.get().frozen?.registry).toBe("/tmp/new-plan");
    const next = fixture(),
      nextStore = store(next),
      nextRead = deferred<HttpResult<Launch>>();
    let disposedSignal: AbortSignal | undefined;
    nextStore.observeLaunch(next, (_plan, s) => {
      disposedSignal = s;
      return nextRead.promise;
    });
    await vi.advanceTimersByTimeAsync(150);
    nextStore.dispose();
    expect(disposedSignal?.aborted).toBe(true);
    nextRead.resolve(ok(fixture("ready", "3")));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(nextStore.manager.get().launch?.state.status).toBe("starting");
    expect(nextStore.manager.get().launchObservation?.kind).toBe("stopped");
  });
});
