import { afterEach, describe, expect, it, vi } from "vitest";
import { createReadSlot } from "../../src/core/state/read-slot";
import { createLiveReadOwner } from "../../src/core/state/live-owner";
import type { LiveAdapter, LiveReadOwner, LiveScope } from "../../src/core/state/live-types";
import * as d from "../../src/core/protocol/decoders";
const id = (s: string) => {
  const v = d.identifier.decode(d.jsonString(s));
  if (!v.ok) throw new Error(s);
  return v.value;
};
const decimal = (s: string) => {
  const v = d.decimal.decode(d.jsonString(s));
  if (!v.ok) throw new Error(s);
  return v.value;
};
const scope: LiveScope = {
  connection: {
    id: id("local"),
    generation: decimal("1"),
    label: "Synthetic",
    socket: "/tmp/synthetic.sock",
  },
  workspaceId: null,
  projectId: null,
};
const owners: LiveReadOwner[] = [];
afterEach(() => {
  for (const o of owners.splice(0)) o.dispose();
  vi.useRealTimers();
});
function owner(adapter: LiveAdapter) {
  const o = createLiveReadOwner({
    reader: {
      read: () => {
        throw new Error("Host-only test must not wait on a workspace");
      },
    },
  });
  owners.push(o);
  o.open(scope, adapter);
  return o;
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const ok = <T>(data: T) => ({ ok: true as const, httpStatus: 200, data });
describe("passive read ownership", () => {
  it("refreshes only opted-in reads, keeps rendered data during I/O, and fences obsolete responses", async () => {
    const slot = createReadSlot<number>();
    let next = Promise.resolve(ok(1));
    await slot.load("current", () => next, { live: true });
    const pending = deferred<ReturnType<typeof ok<number>>>();
    next = pending.promise;
    const refresh = slot.refresh(new AbortController().signal);
    expect(slot.get()).toMatchObject({ kind: "ready", value: 1 });
    await slot.load("historical", () => Promise.resolve(ok(7)));
    pending.resolve(ok(2));
    await refresh;
    expect(slot.get()).toMatchObject({ key: "historical", value: 7 });
    expect(await slot.refresh(new AbortController().signal)).toEqual({
      ok: true,
      retainedCapture: true,
    });
    slot.dispose();
  });
  it("cancels dependent passive reads when their owner disappears", async () => {
    const slot = createReadSlot<number>(),
      dependent = deferred<void>();
    let child: AbortSignal | undefined;
    const abort = new AbortController();
    const job = slot.load("facts", () => Promise.resolve(ok(1)), {
      signal: abort.signal,
      live: true,
      after: async (_v, signal) => {
        child = signal;
        await dependent.promise;
      },
    });
    await Promise.resolve();
    expect(child?.aborted).toBe(false);
    abort.abort();
    expect(child?.aborted).toBe(true);
    dependent.resolve();
    expect(await job).toMatchObject({ ok: false, superseded: true });
    slot.dispose();
  });
  it("coalesces bursts into one serial refresh and one follow-up", async () => {
    vi.useFakeTimers();
    const first = deferred<{ ok: boolean }>();
    let calls = 0,
      active = 0,
      maximum = 0;
    const o = owner({
      key: "work",
      sources: [],
      refresh: async () => {
        calls++;
        active++;
        maximum = Math.max(maximum, active);
        if (calls === 1) await first.promise;
        active--;
        return { ok: true };
      },
    });
    const jobs = [o.refresh(), o.refresh(), o.refresh()];
    expect(calls).toBe(1);
    first.resolve({ ok: true });
    await Promise.all(jobs);
    expect(calls).toBe(2);
    expect(maximum).toBe(1);
    expect(o.get().kind).toBe("live");
  });
  it("cancels obsolete projection reads when the endpoint changes", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const o = owner({
      key: "work",
      sources: [],
      refresh: (signal) => {
        signals.push(signal);
        return Promise.resolve({ ok: true });
      },
    });
    await Promise.resolve();
    o.open(
      { ...scope, connection: { ...scope.connection, generation: decimal("2") } },
      { key: "other", sources: [], refresh: () => Promise.resolve({ ok: true }) },
    );
    expect(signals[0]?.aborted).toBe(true);
  });
  it("retries failed projections once per second without exponential delay", async () => {
    vi.useFakeTimers();
    let calls = 0;
    owner({
      key: "work",
      sources: [],
      refresh: () => {
        calls++;
        return Promise.resolve({ ok: false });
      },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(10000);
    expect(calls).toBe(12);
  });
});

describe("change-driven observation", () => {
  const workspace = { ...scope, workspaceId: id("workspace") };
  const page = (changed = false, planning = "p1", history: string | null = null) =>
    ok({
      cursor: { planning, history, runtime: null },
      changed,
      hasMore: false,
      needsLargerBudget: false,
    });
  function setup(read: import("../../src/core/state/live-types").LiveChangeReader["read"]) {
    const refresh = vi.fn(() => Promise.resolve({ ok: true }));
    const o = createLiveReadOwner({ reader: { read } });
    owners.push(o);
    o.open(workspace, { key: "history", sources: ["planning", "history"], refresh });
    return { o, refresh };
  }
  it("keeps one combined wait and makes no projected reads during idle time", async () => {
    vi.useFakeTimers();
    const read = vi.fn<import("../../src/core/state/live-types").LiveChangeReader["read"]>(
      async (_scope, _sources, cursor, _wait, signal) => {
        if (cursor === null) return page(false, "p1", "h1");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 25000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        return page(false, "p1", "h1");
      },
    );
    const { refresh, o } = setup(read);
    await vi.advanceTimersByTimeAsync(125000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(6);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(o.get().kind).toBe("live");
  });
  it("retains cursors across transport errors and refreshes once for a burst", async () => {
    vi.useFakeTimers();
    const read = vi
      .fn<import("../../src/core/state/live-types").LiveChangeReader["read"]>()
      .mockResolvedValueOnce(page(false, "p1", "h1"))
      .mockResolvedValueOnce({ ok: false, failure: { kind: "network", message: "dropped" } })
      .mockResolvedValueOnce(page(true, "p2", "h1"))
      .mockResolvedValueOnce(page(true, "p2", "h2"))
      .mockImplementation(() => new Promise(() => {}));
    const { refresh } = setup(read);
    await vi.advanceTimersByTimeAsync(1250);
    expect(read.mock.calls[2]?.[2]).toEqual({ planning: "p1", history: "h1", runtime: null });
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
  it("polls projections only on explicit capacity rejection and stops once observation recovers", async () => {
    vi.useFakeTimers();
    let available = false;
    const read = vi.fn<import("../../src/core/state/live-types").LiveChangeReader["read"]>(
      async (_scope, _sources, cursor) => {
        if (!available)
          return {
            ok: false,
            failure: {
              kind: "remote",
              httpStatus: 409,
              problem: {
                kind: "Blocked",
                message: "full",
                details: d.jsonObject([["meter", d.jsonString("ui-live-observations")]]),
              },
            },
          };
        if (cursor === null) return page();
        return new Promise(() => {});
      },
    );
    const { refresh } = setup(read);
    await vi.advanceTimersByTimeAsync(14999);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    available = true;
    await vi.advanceTimersByTimeAsync(16000);
    expect(refresh).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(120000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });
  it("reestablishes invalid cursors and refreshes current projections", async () => {
    vi.useFakeTimers();
    const read = vi
      .fn<import("../../src/core/state/live-types").LiveChangeReader["read"]>()
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce({
        ok: false,
        failure: {
          kind: "remote",
          httpStatus: 409,
          problem: {
            kind: "Conflict",
            message: "feed cursor history changed; start a new scan",
            details: undefined,
          },
        },
      })
      .mockResolvedValueOnce(page(false, "new-root"))
      .mockImplementation(() => new Promise(() => {}));
    const { refresh } = setup(read);
    await vi.advanceTimersByTimeAsync(1500);
    expect(read.mock.calls[2]?.[2]).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

it("replaces page attachments without restarting a compatible live request or losing its cursor", async () => {
  vi.useFakeTimers();
  const scopeWithWorkspace = { ...scope, workspaceId: id("workspace") };
  const pending =
    deferred<ReturnType<typeof ok<import("../../src/core/state/live-types").LiveChangePage>>>();
  const page = {
    cursor: { planning: "p1", history: null, runtime: null },
    hasMore: false,
    needsLargerBudget: false,
    changed: false,
  };
  const read = vi
    .fn<import("../../src/core/state/live-types").LiveChangeReader["read"]>()
    .mockResolvedValueOnce(ok(page))
    .mockImplementationOnce(() => pending.promise)
    .mockImplementation(() => new Promise(() => {}));
  const o = createLiveReadOwner({ reader: { read } });
  owners.push(o);
  const first = vi.fn(() => Promise.resolve({ ok: true }));
  const second = vi.fn(() => Promise.resolve({ ok: true }));
  const close = o.open(scopeWithWorkspace, { key: "work", sources: ["planning"], refresh: first });
  await vi.advanceTimersByTimeAsync(250);
  expect(read).toHaveBeenCalledTimes(2);
  const signal = read.mock.calls[1]![4];
  close();
  o.open(
    { ...scopeWithWorkspace, projectId: id("other-project") },
    { key: "activity", sources: ["planning"], refresh: second },
  );
  await vi.advanceTimersByTimeAsync(1);
  expect(signal.aborted).toBe(false);
  expect(read).toHaveBeenCalledTimes(2);
  expect(o.get().kind).toBe("live");
  pending.resolve(ok({ ...page, cursor: { ...page.cursor, planning: "p2" }, changed: true }));
  await vi.advanceTimersByTimeAsync(250);
  expect(read.mock.calls[2]![2]?.planning).toBe("p2");
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(2);
  o.open(scopeWithWorkspace, { key: "history", sources: ["planning", "history"], refresh: second });
  expect(signal.aborted).toBe(true);
});

it("observation failures remain one second apart after many consecutive failures", async () => {
  vi.useFakeTimers();
  const read = vi
    .fn<import("../../src/core/state/live-types").LiveChangeReader["read"]>()
    .mockResolvedValue({ ok: false, failure: { kind: "network", message: "reset" } });
  const o = createLiveReadOwner({ reader: { read } });
  owners.push(o);
  o.open(
    { ...scope, workspaceId: id("workspace") },
    { key: "work", sources: ["planning"], refresh: () => Promise.resolve({ ok: true }) },
  );
  await vi.advanceTimersByTimeAsync(11000);
  expect(read).toHaveBeenCalledTimes(12);
});
