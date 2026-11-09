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
    pollMs: 100,
    safetyMs: 100,
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
      poll: true,
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
  it("pauses while hidden, catches up on return and cancels the previous endpoint", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const o = owner({
      key: "work",
      sources: [],
      poll: true,
      refresh: (signal) => {
        signals.push(signal);
        return Promise.resolve({ ok: true });
      },
    });
    await Promise.resolve();
    o.setVisible(false);
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(signals).toHaveLength(1);
    o.setVisible(true);
    await Promise.resolve();
    expect(signals).toHaveLength(2);
    o.open(
      { ...scope, connection: { ...scope.connection, generation: decimal("2") } },
      { key: "other", sources: [], poll: true, refresh: () => Promise.resolve({ ok: true }) },
    );
    expect(signals[1]?.aborted).toBe(true);
  });
  it("backs off failed reads instead of spinning", async () => {
    vi.useFakeTimers();
    let calls = 0;
    owner({
      key: "work",
      sources: [],
      poll: true,
      refresh: () => {
        calls++;
        return Promise.resolve({ ok: false });
      },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(3);
  });
});
