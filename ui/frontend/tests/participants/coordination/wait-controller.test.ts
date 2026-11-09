import { afterEach, describe, expect, it } from "vitest";
import { jsonField, stringifyJson, type JsonValue } from "../../../src/core/json";
import * as d from "../../../src/core/protocol/decoders";
import type { HttpClient, HttpRequest, HttpResult } from "../../../src/core/protocol/http";
import { createCoordinationController } from "../../../src/features/participants/coordination/controller";
import { reservationCodec } from "../../../src/features/participants/coordination/codecs";
import type {
  CoordinationInput,
  HolderFence,
} from "../../../src/features/participants/coordination/types";
import { harness, ok } from "../runs/harness";
import { decode, json, response, target } from "../runs/fixtures";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const done of cleanup.splice(0).reverse()) done();
});
const required = (value: JsonValue | undefined, name: string): JsonValue => {
  const field = value === undefined ? undefined : jsonField(value, name);
  if (field === undefined) throw new Error(`Missing ${name}`);
  return field;
};
describe("Coordination alternate wait admission and retained budgets", () => {
  it("coalesces saved-wait refresh and aborts only owned read observers on disposal", async () => {
    const h = harness(),
      signals: (AbortSignal | undefined)[] = [],
      release: (() => void)[] = [];
    const http: HttpClient = {
      processing: h.http.processing,
      request: <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
        if (request.method !== "GET") throw new Error("A read lifetime must not send writes");
        signals.push(request.signal);
        return new Promise((resolve) =>
          release.push(() =>
            resolve({ ok: false, failure: { kind: "network", message: "Late disposed read" } }),
          ),
        );
      },
    };
    const controller = createCoordinationController({ http, operations: h.operations });
    cleanup.push(controller.dispose);
    controller.select({ ...h.context, client: http });
    const inspect = controller.actWait(decode(d.identifier, "saved-wait"), "inspect");
    controller.refresh();
    expect(signals).toHaveLength(2);
    controller.dispose();
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
    for (const done of release) done();
    await inspect;
    await Promise.resolve();
    expect(controller.get().unexpected).toBeNull();
    expect(h.sent).toHaveLength(0);
  });
  it("reads one saved job per explicit page, retains both IDs and never auto-starts restored jobs", async () => {
    const h = harness(),
      calls: string[] = [];
    const saved = (id: string) => ({
      id,
      input_hash: "a".repeat(64),
      preparation: {
        intention_id: id,
        connection: target.connection,
        context: {
          workspace_id: "workspace",
          project_id: null,
          writer: { actor_id: "author", run_id: "run" },
        },
        method: "reservation.acquire",
        params: {
          workspace_id: "workspace",
          actor_id: "author",
          run_id: "run",
          target_run_id: "run",
          requests: [{ reservation_id: "compiler", mode: "exclusive" }],
        },
      },
      limits: { timeout_ms: "1000", max_attempts: "2", wait_slice_ms: "5" },
      revision: "1",
      cancel_requested: false,
      state: { kind: "prepared_unsent" },
      diagnostic: null,
    });
    const http: HttpClient = {
      processing: h.http.processing,
      request: <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
        calls.push(request.path);
        const second = request.path === "/reservation-waits?offset=1&limit=1";
        if (
          request.method !== "GET" ||
          (!second && request.path !== "/reservation-waits?offset=0&limit=1")
        )
          throw new Error(`Unexpected ${request.path}`);
        const parsed = request.codec.decode(
          json({
            items: [saved(second ? "second" : "first")],
            offset: second ? "1" : "0",
            remaining: second ? "0" : "1",
            next_offset: second ? null : "1",
          }),
        );
        if (!parsed.ok) throw new Error(parsed.issue.expected);
        return Promise.resolve(ok(parsed.value));
      },
    };
    const controller = createCoordinationController({ http, operations: h.operations });
    cleanup.push(controller.dispose);
    controller.select({ ...h.context, client: http });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["/reservation-waits?offset=0&limit=1"]);
    expect(controller.get().waitPage?.remaining).toBe("1");
    expect(controller.get().waits.map((job) => job.id)).toEqual(["first"]);
    controller.nextWaits();
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.get().waits.map((job) => job.id)).toEqual(["first", "second"]);
    expect(controller.get().waitPage?.nextOffset).toBeNull();
    controller.nextWaits();
    expect(calls).toHaveLength(2);
    controller.refreshWaits();
    await Promise.resolve();
    await Promise.resolve();
    expect(new Set(controller.get().waits.map((job) => job.id))).toEqual(
      new Set(["first", "second"]),
    );
    expect(calls).toEqual([
      "/reservation-waits?offset=0&limit=1",
      "/reservation-waits?offset=1&limit=1",
      "/reservation-waits?offset=0&limit=1",
    ]);
    expect(h.sent).toHaveLength(0);
  });
  it("lost preparation reply keeps original helper-only path and exact plan for explicit recheck", async () => {
    const h = harness();
    const bodies: JsonValue[] = [];
    let lost = true;
    const http: HttpClient = {
      processing: h.http.processing,
      request: <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
        if (request.path !== "/reservation-waits/prepare")
          throw new Error(`Unexpected ${request.path}`);
        if (request.body === undefined) throw new Error("Missing plan");
        bodies.push(request.body);
        if (lost) {
          lost = false;
          return Promise.resolve({
            ok: false,
            failure: { kind: "network", message: "Preparation reply lost" },
          });
        }
        const original = required(request.body, "preparation");
        const snapshot = d.jsonObject([
          ["intention_id", required(original, "intention_id")],
          ["connection", json(target.connection)],
          ["context", required(original, "context")],
          ["method", required(original, "method")],
          ["params", required(original, "params")],
        ]);
        const raw = d.jsonObject([
          ["id", required(original, "intention_id")],
          ["input_hash", d.jsonString("a".repeat(64))],
          ["preparation", snapshot],
          [
            "limits",
            d.jsonObject([
              ["timeout_ms", required(request.body, "timeout_ms")],
              ["max_attempts", required(request.body, "max_attempts")],
              ["wait_slice_ms", required(request.body, "wait_slice_ms")],
            ]),
          ],
          ["revision", d.jsonString("1")],
          ["cancel_requested", d.jsonBoolean(false)],
          ["state", d.jsonObject([["kind", d.jsonString("prepared_unsent")]])],
          ["diagnostic", d.jsonNull()],
        ]);
        const result = request.codec.decode(raw);
        if (!result.ok) throw new Error(result.issue.expected);
        return Promise.resolve(ok(result.value));
      },
    };
    const controller = createCoordinationController({ http, operations: h.operations });
    cleanup.push(controller.dispose);
    const source: CoordinationInput = {
      kind: "acquire",
      targetRunId: "run",
      acquisition: {
        kind: "named",
        requests: [{ reservationId: "compiler", mode: "exclusive", durationMs: "" }],
      },
    };
    controller.open({ ...h.context, client: http }, source);
    const id = controller.get().selectedDraftId!;
    const limits = {
      timeoutMs: decode(d.positiveDecimal, "1000"),
      maxAttempts: decode(d.positiveDecimal, "2"),
      waitSliceMs: decode(d.positiveDecimal, "5"),
    };
    await controller.prepareWait(id, limits);
    expect(controller.get().drafts[0]?.phase.kind).toBe("wait_prepared");
    expect(controller.get().drafts[0]?.issue).toMatch(/reply lost/);
    controller.edit(id, {
      kind: "acquire",
      targetRunId: "run",
      acquisition: {
        kind: "named",
        requests: [{ reservationId: "other", mode: "exclusive", durationMs: "" }],
      },
    });
    await controller.review(id);
    await controller.prepareWait(id, { ...limits, timeoutMs: decode(d.positiveDecimal, "1001") });
    expect(bodies).toHaveLength(1);
    expect(h.sent).toHaveLength(0);
    await controller.prepareWait(id, limits);
    expect(bodies).toHaveLength(2);
    expect(stringifyJson(bodies[0]!)).toEqual(stringifyJson(bodies[1]!));
    expect(controller.get().waits[0]?.state.kind).toBe("prepared_unsent");
    expect(h.sent).toHaveLength(0);
    expect(controller.get().drafts[0]?.input).toEqual(source);
  });
  it("bounds aggregate certified source retention before opening additional drafts and allows explicit discard", () => {
    const h = harness();
    const controller = createCoordinationController({ http: h.http, operations: h.operations });
    cleanup.push(controller.dispose);
    const value = decode(reservationCodec("named"), {
      reservation_id: "compiler",
      epoch: "1",
      holders: [
        {
          actor_id: "author",
          run_id: "run",
          token: "1",
          mode: "exclusive",
          origin: { kind: "manual" },
          lease: {
            epoch: "1",
            revision: "1",
            duration_ms: null,
            last_unix_ms: "0",
            deadline_unix_ms: null,
          },
        },
      ],
    });
    const fence: HolderFence = {
      reservation: {
        scope: target,
        value,
        response: response({ large: "x".repeat(300000) }),
        namespace: "runs",
        revision: decode(d.decimal, "1"),
      },
      holder: value.holders[0]!,
    };
    let accepted = 0;
    for (let i = 0; i < 24; i++) {
      const before = controller.get().drafts.length;
      controller.open(h.context, { kind: "release", fence });
      if (controller.get().drafts.length === before) break;
      accepted++;
    }
    expect(accepted).toBeGreaterThan(1);
    expect(accepted).toBeLessThan(24);
    expect(controller.get().issue).toMatch(/16 MiB/);
    expect(h.sent).toHaveLength(0);
    controller.discard(controller.get().drafts[0]!.id);
    controller.open(h.context, { kind: "release", fence });
    expect(controller.get().drafts).toHaveLength(accepted);
  });
});
