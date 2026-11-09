import { decimal } from "../../src/features/history/transcript/controller";
import { describe, it, expect } from "vitest";
import {
  consumption,
  estimateTokenCost,
  formatUsd,
} from "../../src/features/history/usage-dashboard/model";
import type { UsageTotals, MetricTotal } from "../../src/features/history/analytics/types";
const totals: UsageTotals = {
  observations: decimal("2"),
  tokens: "1000",
  elapsed_ms: "10",
  overflow: false,
  metric_series: decimal("2"),
  metric_overflow: false,
};
const metric = (
  name: string,
  unit: string,
  value: string,
  samples = "2",
  overflow = false,
): MetricTotal => ({ name, unit, value, samples: decimal(samples), overflow });
describe("run token accounting", () => {
  it("does not infer token splits or dollars from names with unknown units", () => {
    const r = consumption(totals, [
      metric("input_tokens", "bytes", "10"),
      metric("cost_usd_micros", "USD", "40"),
    ]);
    expect(r.input.value).toBeNull();
    expect(r.costMicros.value).toBeNull();
  });
  it("reports missing observations as partial, including genuine measured zero", () => {
    const r = consumption(totals, [metric("input_tokens", "tokens", "0", "1")]);
    expect(r.input).toEqual({ value: 0n, complete: false });
    expect(r.output.value).toBeNull();
  });
  it("does not combine reported and estimated families when their identities may overlap", () => {
    expect(
      consumption(totals, [
        metric("cost_usd_micros", "microUSD", "10", "1"),
        metric("estimated_cost_usd_micros", "microUSD", "20", "1"),
      ]).costMicros,
    ).toEqual({ value: null, complete: false });
    expect(
      consumption(totals, [
        metric("cost_usd_micros", "microUSD", "10"),
        metric("estimated_cost_usd_micros", "microUSD", "20"),
      ]).costMicros.value,
    ).toBeNull();
  });
  it("does not present saturated numbers as exact", () =>
    expect(
      consumption(totals, [metric("input_tokens", "tokens", "9223372036854775807", "2", true)])
        .input.value,
    ).toBeNull());
  it("prices cached input at its own rate without counting it twice", () => {
    expect(
      estimateTokenCost({
        input: "1000000",
        cached: "500000",
        output: "100000",
        inputRate: "2",
        cachedRate: "0.2",
        outputRate: "10",
      }),
    ).toEqual({ ok: true, microUsd: "2100000", totalTokens: "1100000" });
  });
  it("never adds reasoning to output a second time and preserves tiny costs", () => {
    const r = consumption(totals, [
      metric("output_tokens", "tokens", "100"),
      metric("reasoning_output_tokens", "tokens", "60"),
    ]);
    expect(r.output.value).toBe(100n);
    expect(formatUsd(1n)).toBe("<$0.01");
    expect(formatUsd(0n)).toBe("$0.00");
  });
  it("uses exact arithmetic beyond JS safe integers", () =>
    expect(
      estimateTokenCost({
        input: "9007199254740993",
        cached: "0",
        output: "0",
        inputRate: "1",
        cachedRate: "0",
        outputRate: "0",
      }),
    ).toEqual({ ok: true, microUsd: "9007199254740993", totalTokens: "9007199254740993" }));
  it.each([
    { input: "10", cached: "11", output: "1", inputRate: "2", cachedRate: ".2", outputRate: "10" },
    { input: "1.5", cached: "0", output: "1", inputRate: "2", cachedRate: "0.2", outputRate: "10" },
  ])("rejects invalid counts/rates", (value) => expect(estimateTokenCost(value).ok).toBe(false));
});
