import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createContentWorkerClient, type ContentWorkerPort } from "../../src/content/client";
import { CONTENT_LIMITS } from "../../src/content/limits";
import { processContentJob } from "../../src/content/processor";
import type { ContentWorkerClient, RenderRequest, WorkerRequest } from "../../src/content/types";
class FakeWorker implements ContentWorkerPort {
  message: ((data: unknown) => void) | null = null;
  failure: (() => void) | null = null;
  request: WorkerRequest | null = null;
  terminated = false;
  listen(message: (data: unknown) => void, failed: () => void) {
    this.message = message;
    this.failure = failed;
    return () => {
      this.message = null;
      this.failure = null;
    };
  }
  send(request: WorkerRequest) {
    this.request = request;
  }
  terminate() {
    this.terminated = true;
  }
  finish() {
    const request = this.request;
    if (!request) throw new Error("Not started");
    this.message?.({
      protocol: 1,
      jobId: request.jobId,
      key: request.key,
      kind: "complete",
      result: processContentJob(request.job),
    });
  }
  stage() {
    const request = this.request;
    if (!request) throw new Error("Not started");
    this.message?.({
      protocol: 1,
      jobId: request.jobId,
      key: request.key,
      kind: "stage",
      stage: "markdown",
    });
  }
}
const clients: ContentWorkerClient[] = [];
function setup() {
  const ports: FakeWorker[] = [];
  const client = createContentWorkerClient(() => {
    const port = new FakeWorker();
    ports.push(port);
    return port;
  });
  clients.push(client);
  return { client, ports };
}
function request(key: string): RenderRequest {
  return {
    key,
    bytes: new TextEncoder().encode(`# ${key}`),
    hints: {},
    override: "auto",
    mode: "rendered",
    startLine: 0,
    rawOffset: 0,
  };
}
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  vi.useRealTimers();
});
describe("bounded cancellable content worker ownership", () => {
  it("copies input, admits two active jobs, removes queued cancellation and never starts it", async () => {
    const { client, ports } = setup();
    const source = request("one");
    const original = source.bytes;
    const one = client.render(source);
    const two = client.render(request("two"));
    const abort = new AbortController();
    const three = client.render(request("three"), abort.signal);
    expect(ports).toHaveLength(2);
    expect(ports[0]?.request?.job.request.bytes).not.toBe(original);
    expect(original.byteLength).toBeGreaterThan(0);
    abort.abort();
    expect(await three).toMatchObject({ ok: false, kind: "cancelled" });
    ports[0]?.finish();
    ports[1]?.finish();
    expect((await one).ok).toBe(true);
    expect((await two).ok).toBe(true);
    expect(ports).toHaveLength(2);
  });
  it("terminates active cancellation and ignores late or mismatched identities", async () => {
    const { client, ports } = setup();
    const abort = new AbortController();
    const canceled = client.render(request("old"), abort.signal);
    const port = ports[0];
    const late = port?.message;
    const envelope = port?.request;
    abort.abort();
    expect(await canceled).toMatchObject({ ok: false, kind: "cancelled" });
    expect(port?.terminated).toBe(true);
    if (envelope)
      late?.({
        protocol: 1,
        jobId: envelope.jobId,
        key: envelope.key,
        kind: "complete",
        result: processContentJob(envelope.job),
      });
    const current = client.render(request("new"));
    const fresh = ports[1];
    fresh?.message?.({ protocol: 1, jobId: "stale-id", key: "old", kind: "complete", result: {} });
    expect(fresh?.terminated).toBe(false);
    fresh?.finish();
    const outcome = await current;
    expect(outcome.ok && outcome.value.key).toBe("new");
  });
  it("enforces stage and worker deadlines as queued jobs start", async () => {
    const { client, ports } = setup();
    const one = client.render(request("one"));
    const two = client.render(request("two"));
    const three = client.render(request("three"));
    ports[0]?.stage();
    vi.advanceTimersByTime(CONTENT_LIMITS.sliceMs);
    expect(await one).toMatchObject({ ok: false, kind: "timeout" });
    expect(ports[0]?.terminated).toBe(true);
    vi.advanceTimersByTime(CONTENT_LIMITS.deadlineMs);
    expect(await two).toMatchObject({ ok: false, kind: "timeout" });
    expect(await three).toMatchObject({ ok: false, kind: "timeout" });
    expect(ports.every((port) => port.terminated)).toBe(true);
  });
  it("waits through a visible-content burst without increasing worker concurrency", async () => {
    const { client, ports } = setup();
    const jobs = Array.from({ length: CONTENT_LIMITS.pending + 16 }, (_, index) =>
      client.render(request(`visible-${index}`), undefined, { waitForCapacity: true }),
    );
    expect(ports).toHaveLength(2);
    for (let i = 0; i < jobs.length; i++) {
      expect(ports.filter((port) => !port.terminated).length).toBeLessThanOrEqual(2);
      expect(ports[i]?.request?.key).toBe(`visible-${i}`);
      ports[i]?.finish();
    }
    const results = await Promise.all(jobs);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(ports.every((port) => port.terminated)).toBe(true);
  });
  it("cancels waiting viewers before copying or starting them and settles waiters on disposal", async () => {
    const { client, ports } = setup();
    const jobs = Array.from({ length: CONTENT_LIMITS.pending }, (_, i) =>
      client.render(request(String(i))),
    );
    const abort = new AbortController();
    const waiting = client.render(request("offscreen"), abort.signal, { waitForCapacity: true });
    abort.abort();
    expect(await waiting).toMatchObject({ ok: false, kind: "cancelled" });
    const disposed = client.render(request("leaving-page"), undefined, { waitForCapacity: true });
    client.dispose();
    expect(await disposed).toMatchObject({ ok: false, kind: "cancelled" });
    expect((await Promise.all(jobs)).every((r) => !r.ok && r.kind === "cancelled")).toBe(true);
    expect(ports).toHaveLength(2);
  });
  it("does not spend a queued viewer's execution deadline while another job runs", async () => {
    const { client, ports } = setup();
    const first = client.render(request("first"));
    const second = client.render(request("second"));
    const third = client.render(request("queued"));
    vi.advanceTimersByTime(CONTENT_LIMITS.deadlineMs);
    expect(await first).toMatchObject({ ok: false, kind: "timeout" });
    expect(await second).toMatchObject({ ok: false, kind: "timeout" });
    expect(ports[2]?.terminated).toBe(false);
    ports[2]?.finish();
    expect((await third).ok).toBe(true);
  });
  it("rejects queue overflow, invalid input/response, and reports worker failure separately", async () => {
    const { client, ports } = setup();
    const pending = Array.from({ length: CONTENT_LIMITS.pending }, (_, index) =>
      client.render(request(String(index))),
    );
    expect(await client.render(request("overflow"))).toMatchObject({ ok: false, kind: "busy" });
    ports[0]?.message?.({ malicious: true });
    expect(await pending[0]).toMatchObject({ ok: false, kind: "protocol" });
    ports[1]?.failure?.();
    expect(await pending[1]).toMatchObject({ ok: false, kind: "worker" });
    client.dispose();
    for (const result of await Promise.all(pending.slice(2)))
      expect(result).toMatchObject({ ok: false, kind: "cancelled" });
    expect(await client.render({ ...request("invalid"), startLine: -1 })).toMatchObject({
      ok: false,
      kind: "cancelled",
    });
    const fresh = setup();
    expect(await fresh.client.render({ ...request("invalid"), startLine: -1 })).toMatchObject({
      ok: false,
      kind: "input",
    });
  });
  it("returns lossless JSON decoder errors as data, not transport failures", async () => {
    const { client, ports } = setup();
    const result = client.decodeJson({ key: "json", bytes: new TextEncoder().encode("{broken") });
    ports[0]?.finish();
    const outcome = await result;
    expect(outcome.ok && !outcome.value.ok && outcome.value.error.code).toBe("invalid_json");
  });
});
