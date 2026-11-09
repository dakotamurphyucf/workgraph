import { afterEach, describe, expect, it } from "vitest";
import * as d from "../../../src/core/protocol/decoders";
import type { HttpClient, HttpRequest, HttpResult } from "../../../src/core/protocol/http";
import { createRequestWaitController } from "../../../src/features/discussions/requests/wait/controller";
import {
  requestWaitObservation,
  requestWaitPlan,
} from "../../../src/features/discussions/requests/wait/client";
import type { RequestWaitPlan } from "../../../src/features/discussions/requests/wait/types";
import { createTestProcessor } from "../../core/processing-harness";
import { decode, json } from "../../work/actions-fixtures";
import { nativeResponses } from "../requests-native-fixtures";
const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});
const plan: RequestWaitPlan = decode(requestWaitPlan, {
  connectionId: "local",
  generation: "1",
  workspaceId: "demo",
  requestId: "probe-question",
  timeoutMs: "1000",
  pollIntervalMs: "250",
});
function value(stop = "resolved", data: unknown = nativeResponses["get-resolved"]) {
  return {
    capture: {
      profile: { id: "local", generation: "1", label: "Local", socket: "/tmp/original.sock" },
      workspace_id: "demo",
      request_id: "probe-question",
      timeout_ms: "1000",
      poll_interval_ms: "250",
    },
    observation: {
      data,
      meta: {
        query_scope: "communication",
        query_revision: "42",
        budget: {
          max_bytes: "1048576",
          returned_bytes: "2048",
          truncated: false,
          omitted_fields: "0",
          omitted_items: "0",
          details: [] as { path: string; kind: string; omitted: string }[],
          details_complete: true,
        },
        wait: { stop, resolved: stop === "resolved", poll_count: "1" },
      },
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness(handler: (request: HttpRequest<unknown>) => Promise<unknown>) {
  const processing = createTestProcessor(),
    calls: HttpRequest<unknown>[] = [];
  const http: HttpClient = {
    processing,
    request: async <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
      calls.push(request);
      const raw = await handler(request);
      const result = request.codec.decode(json(raw));
      if (!result.ok)
        return {
          ok: false,
          failure: { kind: "protocol", message: result.issue.expected, issue: result.issue },
        };
      return { ok: true, httpStatus: 200, data: result.value };
    },
  };
  const controller = createRequestWaitController({ http });
  disposals.push(
    () => controller.dispose(),
    () => processing.dispose(),
  );
  return { controller, calls };
}
describe("bounded foreground request wait", () => {
  it("validates exact public budgets without I/O", async () => {
    const h = harness(() => Promise.resolve(value()));
    for (const bounds of [
      { timeoutMs: "999" },
      { timeoutMs: "300001" },
      { pollIntervalMs: "249" },
      { pollIntervalMs: "25001" },
    ]) {
      await h.controller.start({
        ...plan,
        ...("timeoutMs" in bounds
          ? { timeoutMs: decode(d.decimal, bounds.timeoutMs) }
          : { pollIntervalMs: decode(d.decimal, bounds.pollIntervalMs) }),
      });
      expect(h.controller.get().kind).toBe("failed");
    }
    expect(h.calls).toHaveLength(0);
    expect(
      requestWaitPlan.decode(json({ ...plan, timeoutMs: "300000", pollIntervalMs: "25000" })).ok,
    ).toBe(true);
  });
  it("preserves the native pinned answer, nullable answer and local wait metadata", () => {
    const result = decode(requestWaitObservation, value());
    expect(result.request.answerBody?.body).toBe(nativeResponses["get-resolved"].answer?.body);
    expect(result.profile.socket).toBe("/tmp/original.sock");
    expect(result.pollCount).toBe("1");
    const source = nativeResponses["get-resolved"],
      nullable = {
        ...source,
        status: { kind: "resolved", attribution: source.created, answer: null },
        answer: null,
      };
    expect(
      decode(requestWaitObservation, value("resolved", nullable)).request.answerBody,
    ).toBeNull();
    expect(requestWaitObservation.decode(json({ ...value(), extra: true })).ok).toBe(false);
    const invalid = value();
    invalid.observation.meta.wait.poll_count = "0";
    expect(requestWaitObservation.decode(json(invalid)).ok).toBe(false);
  });
  it("rejects contradictory terminal identity, stop and clipping rather than claiming resolution", () => {
    const source = nativeResponses["get-resolved"];
    expect(requestWaitObservation.decode(json(value("deadline"))).ok).toBe(false);
    expect(
      requestWaitObservation.decode(json(value("resolved", { ...source, request_id: "other" }))).ok,
    ).toBe(false);
    const partial = value("incomplete");
    partial.observation.meta.budget = {
      ...partial.observation.meta.budget,
      truncated: true,
      omitted_fields: "1",
      details: [{ path: "/answer/body", kind: "text_bytes", omitted: "4" }],
    };
    expect(decode(requestWaitObservation, partial).resolved).toBe(false);
    partial.observation.meta.wait.resolved = true;
    expect(requestWaitObservation.decode(json(partial)).ok).toBe(false);
  });
  it("coalesces only the same active captured invocation and never auto-starts", async () => {
    const pending = deferred<unknown>(),
      h = harness(() => pending.promise);
    expect(h.calls).toHaveLength(0);
    const a = h.controller.start(plan),
      b = h.controller.start({ ...plan });
    expect(a).toBe(b);
    await Promise.resolve();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.path).toBe("/request-waits");
    expect(h.calls[0]?.method).toBe("POST");
    expect(decode(d.identifier, "probe-question")).toBe(plan.requestId);
    pending.resolve(value());
    await a;
    expect(h.controller.get().kind).toBe("stopped");
    await Promise.resolve();
    expect(h.calls).toHaveLength(1);
  });
  it("Stop aborts foreground I/O, retains the last completed observation and ignores a late result", async () => {
    const late = deferred<unknown>();
    let count = 0;
    const h = harness(() => (++count === 1 ? Promise.resolve(value()) : late.promise));
    await h.controller.start(plan);
    const wait = h.controller.start(plan);
    await Promise.resolve();
    h.controller.stop();
    expect(h.calls[1]?.signal?.aborted).toBe(true);
    const stopped = h.controller.get();
    expect(stopped.kind).toBe("cancelled_locally");
    if (stopped.kind === "cancelled_locally")
      expect(stopped.last?.request.answerBody).not.toBeNull();
    late.resolve(value());
    await wait;
    expect(h.controller.get()).toBe(stopped);
  });
  it("navigation fences obsolete results without retargeting a pinned endpoint", async () => {
    const late = deferred<unknown>(),
      h = harness(() => late.promise),
      waiting = h.controller.start(plan);
    await Promise.resolve();
    h.controller.select({ ...plan });
    expect(h.calls[0]?.signal?.aborted).toBe(false);
    h.controller.select({ ...plan, generation: decode(d.positiveDecimal, "2") });
    expect(h.calls[0]?.signal?.aborted).toBe(true);
    late.resolve(value());
    await waiting;
    expect(h.controller.get().kind).toBe("cancelled_locally");
    expect(h.calls).toHaveLength(1);
  });
  it("retains unexpected rejection for its owning view boundary and never retries", async () => {
    const error = new Error("unexpected worker failure"),
      h = harness(() => Promise.reject(error));
    await h.controller.start(plan);
    const state = h.controller.get();
    expect(state.kind).toBe("unexpected_error");
    if (state.kind === "unexpected_error") expect(state.error).toBe(error);
    expect(h.calls).toHaveLength(1);
  });
});
