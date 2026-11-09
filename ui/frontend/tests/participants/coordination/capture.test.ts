import { describe, expect, it } from "vitest";
import * as d from "../../../src/core/protocol/decoders";
import {
  captureInput,
  inputWeight,
  MAX_INPUT_BYTES,
} from "../../../src/features/participants/coordination/capture";
import { counter } from "../../../src/features/participants/coordination/model";
import type {
  CoordinationInput,
  HolderFence,
} from "../../../src/features/participants/coordination/types";
import { decode, response, target } from "../runs/fixtures";
import { reservationCodec } from "../../../src/features/participants/coordination/codecs";
const fence = (): HolderFence => {
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
  return {
    reservation: {
      scope: { ...target },
      value,
      response: response({}),
      namespace: "runs",
      revision: counter("9"),
    },
    holder: value.holders[0]!,
  };
};
describe("Coordination synchronous owned captures", () => {
  it("freezes mutable descendants and preserves deliberate selected-holder membership", () => {
    const f = fence(),
      source: CoordinationInput = { kind: "release", fence: f },
      captured = captureInput(source);
    expect(captured.kind).toBe("release");
    if (captured.kind !== "release") throw new Error("kind");
    expect(captured.fence).not.toBe(f);
    expect(captured.fence.reservation.value.holders).toContain(captured.fence.holder);
    expect(captured.fence.reservation.response.response.data).toBe(
      f.reservation.response.response.data,
    );
    Reflect.set(f.reservation.scope, "workspaceId", "changed");
    expect(captured.fence.reservation.scope.workspaceId).toBe("workspace");
    expect(Object.isFrozen(captured.fence.holder.lease)).toBe(true);
  });
  it("rejects accessors, cycles and non-data prototypes instead of invoking them", () => {
    let invoked = 0;
    const input = { kind: "pool" as const, name: "compiler", limit: "1" };
    Object.defineProperty(input, "limit", {
      get: () => {
        invoked++;
        return "2";
      },
    });
    expect(() => captureInput(input)).toThrow(/accessors/);
    expect(invoked).toBe(0);
    const circular = { kind: "pool" as const, name: "compiler", limit: "1" };
    Reflect.set(circular, "self", circular);
    expect(() => captureInput(circular)).toThrow(/cycle/);
    const prototype = { kind: "pool" as const, name: "compiler", limit: "1" };
    Object.setPrototypeOf(prototype, { custom: true });
    expect(() => captureInput(prototype)).toThrow(/plain/);
  });
  it("charges certified trees without recopying them and rejects oversized retained captures", () => {
    const f = fence(),
      data = d.jsonObject([["large", d.jsonString("x".repeat(720000))]]);
    const input: CoordinationInput = {
      kind: "release",
      fence: {
        ...f,
        reservation: {
          ...f.reservation,
          response: { response: { data, meta: d.jsonObject([]) }, pagination: null },
        },
      },
    };
    expect(() => captureInput(input)).toThrow(/4 MiB/);
    const small = captureInput({ kind: "pool" as const, name: "compiler", limit: "2" });
    expect(inputWeight(small)).toBeLessThan(MAX_INPUT_BYTES);
  });
});
