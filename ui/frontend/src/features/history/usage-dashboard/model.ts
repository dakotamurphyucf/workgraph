import type { MetricTotal, UsageTotals } from "../analytics/types";
export interface Measured {
  readonly value: bigint | null;
  readonly complete: boolean;
}
export interface Consumption {
  readonly input: Measured;
  readonly output: Measured;
  readonly cached: Measured;
  readonly costMicros: Measured;
  readonly estimated: boolean;
}
/** Only documented exact name/unit pairs have token/currency semantics. Unknown
 * samples remain available in Usage reports. Saturated sums are not exact totals. */
export function consumption(totals: UsageTotals, metrics: readonly MetricTotal[]): Consumption {
  const measure = (name: string, unit: string): Measured => {
    const m = metrics.find((v) => v.name === name && v.unit === unit);
    return {
      value: !m || m.overflow ? null : BigInt(m.value),
      complete: m !== undefined && !m.overflow && m.samples === totals.observations,
    };
  };
  const reported = metrics.find((m) => m.name === "cost_usd_micros" && m.unit === "microUSD"),
    estimated = metrics.find(
      (m) => m.name === "estimated_cost_usd_micros" && m.unit === "microUSD",
    );
  const samples = BigInt(reported?.samples ?? "0") + BigInt(estimated?.samples ?? "0");
  const validCost =
    !(reported && estimated) && // Aggregate sample counts cannot prove disjoint report identities.
    samples > 0n &&
    samples <= BigInt(totals.observations) &&
    !reported?.overflow &&
    !estimated?.overflow;
  return {
    input: measure("input_tokens", "tokens"),
    output: measure("output_tokens", "tokens"),
    cached: measure("cached_input_tokens", "tokens"),
    costMicros: {
      value: validCost ? BigInt(reported?.value ?? "0") + BigInt(estimated?.value ?? "0") : null,
      complete: validCost && samples === BigInt(totals.observations),
    },
    estimated: estimated !== undefined,
  };
}
export function formatTokens(value: bigint | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}
export function formatUsd(micros: bigint | null): string {
  if (micros === null) return "—";
  const cents = (micros + 5000n) / 10000n;
  if (micros > 0n && cents === 0n) return "<$0.01";
  return `$${(cents / 100n).toLocaleString("en-US")}.${String(cents % 100n).padStart(2, "0")}`;
}
export interface TokenPricingInput {
  readonly input: string;
  readonly cached: string;
  readonly output: string;
  readonly inputRate: string;
  readonly cachedRate: string;
  readonly outputRate: string;
}
export type PriceResult =
  | { readonly ok: true; readonly microUsd: string; readonly totalTokens: string }
  | { readonly ok: false; readonly message: string };
/** Explicit caller rates in USD/million tokens; cache counts are included in
 * input. Rounded once to microUSD with exact integer arithmetic. */
export function estimateTokenCost(v: TokenPricingInput): PriceResult {
  const count = /^(0|[1-9][0-9]{0,18})$/u,
    rate = /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,6})?$/u;
  if (![v.input, v.cached, v.output].every((x) => count.test(x)))
    return { ok: false, message: "Enter exact nonnegative integer token counts." };
  if (![v.inputRate, v.cachedRate, v.outputRate].every((x) => rate.test(x)))
    return {
      ok: false,
      message: "Enter USD prices per million tokens, with up to six decimal places.",
    };
  const input = BigInt(v.input),
    cached = BigInt(v.cached),
    output = BigInt(v.output),
    max = 9223372036854775807n;
  if (cached > input) return { ok: false, message: "Cached input cannot exceed total input." };
  const microRate = (s: string) => {
    const [whole, fraction = ""] = s.split(".");
    return BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, "0"));
  };
  const pico =
      (input - cached) * microRate(v.inputRate) +
      cached * microRate(v.cachedRate) +
      output * microRate(v.outputRate),
    micro = (pico + 500000n) / 1000000n;
  if (input + output > max || micro > max)
    return { ok: false, message: "The total exceeds Workgraph’s exact integer report range." };
  return { ok: true, microUsd: micro.toString(), totalTokens: (input + output).toString() };
}
