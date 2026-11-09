import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createViewerWorker,
  type ViewerPort,
} from "../../../src/features/knowledge/viewers/worker-client";
import type { ViewerRequest } from "../../../src/features/knowledge/viewers/wire";
import type { ContentSource } from "../../../src/content/types";
const source: ContentSource = {
  key: "captured",
  label: "synthetic",
  bytes: new TextEncoder().encode('{"x":1}'),
  completeness: "complete",
  hints: { mime: "application/json" },
};
function fixture() {
  let receive: (v: unknown) => void = () => {
      throw new Error("not listening");
    },
    failed = () => {};
  const sent: ViewerRequest[] = [];
  const terminate = vi.fn();
  const port: ViewerPort = {
    listen: (r, f) => {
      receive = r;
      failed = f;
      return () => {};
    },
    send: (r) => {
      sent.push(
        structuredClone(r, {
          transfer:
            r.job.kind === "compare"
              ? [r.job.left.bytes.buffer, r.job.right.bytes.buffer]
              : [r.job.source.bytes.buffer],
        }),
      );
    },
    terminate,
  };
  const worker = createViewerWorker(() => port);
  return { worker, sent, terminate, send: (v: unknown) => receive(v), failed: () => failed() };
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((f) => f());
  vi.useRealTimers();
});
describe("viewer worker ownership", () => {
  it("copies caller bytes and terminates actual work on cancel; late replies cannot publish", async () => {
    const f = fixture(),
      abort = new AbortController();
    cleanups.push(f.worker.dispose);
    const pending = f.worker.json(source, [], 0, abort.signal);
    expect(source.bytes.byteLength).toBe(7);
    expect(f.sent[0]?.job.kind).toBe("json");
    abort.abort();
    expect(await pending).toMatchObject({ ok: false, kind: "cancelled" });
    expect(f.terminate).toHaveBeenCalledTimes(1);
    f.send({
      protocol: 1,
      id: f.sent[0]?.id,
      key: "captured",
      kind: "failed",
      failure: "malformed",
      message: "late",
    });
    expect(f.terminate).toHaveBeenCalledTimes(1);
  });
  it("drops stale identities, rejects wrong result type and closed-wire extras", async () => {
    const f = fixture();
    cleanups.push(f.worker.dispose);
    const pending = f.worker.json(source, [], 0);
    const request = f.sent[0]!;
    f.send({ protocol: 1, id: "old", key: "captured", kind: "unexpected", message: "stale" });
    expect(f.terminate).not.toHaveBeenCalled();
    f.send({
      protocol: 1,
      id: request.id,
      key: request.key,
      kind: "complete",
      value: { kind: "binary", equal: true },
    });
    expect(await pending).toMatchObject({ ok: false, kind: "protocol" });
    const other = f.worker.json(source, [], 0),
      next = f.sent[1]!;
    f.send({
      protocol: 1,
      id: next.id,
      key: next.key,
      kind: "failed",
      failure: "malformed",
      message: "bad",
      extra: 1,
    });
    expect(await other).toMatchObject({ ok: false, kind: "protocol" });
  });
  it("has a real 2-second termination bound without calling a healthy image malformed", async () => {
    vi.useFakeTimers();
    const f = fixture();
    cleanups.push(f.worker.dispose);
    const pending = f.worker.raster(source);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toMatchObject({ ok: false, kind: "timeout" });
    expect(f.terminate).toHaveBeenCalledTimes(1);
  });
  it("terminates an overrun CPU stage but allows asynchronous decode within total deadline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    cleanups.push(f.worker.dispose);
    const a = f.worker.json(source, [], 0),
      request = f.sent[0]!;
    f.send({ protocol: 1, id: request.id, key: request.key, kind: "stage", stage: "parse" });
    await vi.advanceTimersByTimeAsync(100);
    expect(await a).toMatchObject({ ok: false, kind: "timeout" });
    const b = f.worker.raster(source),
      next = f.sent[1]!;
    f.send({ protocol: 1, id: next.id, key: next.key, kind: "stage", stage: "headers" });
    await vi.advanceTimersByTimeAsync(50);
    f.send({ protocol: 1, id: next.id, key: next.key, kind: "stage", stage: "decode" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.terminate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await b).toMatchObject({ ok: false, kind: "timeout" });
  });
  it("bounds concurrent admission and handles worker failure explicitly without retry", async () => {
    const f = fixture();
    cleanups.push(f.worker.dispose);
    const a = f.worker.json(source, [], 0),
      b = f.worker.json(source, [], 0);
    expect(await f.worker.json(source, [], 0)).toMatchObject({ ok: false, kind: "busy" });
    f.failed();
    expect(await b).toMatchObject({ ok: false, kind: "worker" });
    f.worker.dispose();
    expect(await a).toMatchObject({ ok: false, kind: "cancelled" });
    expect(f.sent).toHaveLength(2);
  });
  it("preserves unexpected exceptions as rejected work, not malformed content", async () => {
    const f = fixture();
    cleanups.push(f.worker.dispose);
    const pending = f.worker.json(source, [], 0);
    const rejected = expect(pending).rejects.toThrow("unexpected parser");
    const request = f.sent[0]!;
    f.send({
      protocol: 1,
      id: request.id,
      key: request.key,
      kind: "unexpected",
      message: "unexpected parser",
    });
    await rejected;
    expect(f.terminate).toHaveBeenCalledTimes(1);
  });
});
