import { useState } from "react";
import { Button, Field } from "../../../components/Primitives";
import { estimateTokenCost, formatUsd, type TokenPricingInput } from "./model";
import type { MetricSample } from "../analytics/types";
export function CostCalculator({
  onUse,
  disabled,
}: {
  readonly onUse: (tokens: string, metrics: readonly MetricSample[], basis: string) => void;
  readonly disabled: boolean;
}) {
  const [values, setValues] = useState<TokenPricingInput>({
      input: "",
      cached: "0",
      output: "",
      inputRate: "",
      cachedRate: "",
      outputRate: "",
    }),
    [basis, setBasis] = useState("");
  const result = estimateTokenCost(values);
  return (
    <details className="ht-cost-calculator">
      <summary>Calculate a token-cost estimate</summary>
      <p>
        Use measured input and output counts, plus the prices that applied to this model and service
        tier. Cached input is already part of input—not extra tokens. This calculator covers
        ordinary input, cache reads and output. If cache writes, different context tiers, media or
        other fees need separate rates, calculate those externally and report their cost instead.
      </p>
      <div className="ha-grid">
        {(
          [
            ["input", "Input tokens, including cached"],
            ["cached", "Cached input tokens"],
            ["output", "Output tokens"],
            ["inputRate", "Input · USD per million"],
            ["cachedRate", "Cached input · USD per million"],
            ["outputRate", "Output · USD per million"],
          ] as const
        ).map(([key, label]) => (
          <Field
            key={key}
            label={label}
            value={values[key]}
            inputMode={key.endsWith("Rate") ? "decimal" : "numeric"}
            onChange={(e) => setValues({ ...values, [key]: e.currentTarget.value })}
          />
        ))}
      </div>
      <Field
        label="Model and price basis"
        value={basis}
        onChange={(e) => setBasis(e.currentTarget.value)}
        hint="Record the exact model, service tier, effective date and pricing source. Workgraph does not fetch prices or equate subscription use with an API bill."
      />
      <p role="status">
        {result.ok ? `Estimated token cost: ${formatUsd(BigInt(result.microUsd))}` : result.message}
      </p>
      <Button
        disabled={disabled || !result.ok || !basis.trim()}
        onClick={() => {
          if (!result.ok) return;
          onUse(
            result.totalTokens,
            [
              { name: "input_tokens", unit: "tokens", value: values.input },
              { name: "output_tokens", unit: "tokens", value: values.output },
              { name: "cached_input_tokens", unit: "tokens", value: values.cached },
              { name: "estimated_cost_usd_micros", unit: "microUSD", value: result.microUsd },
            ],
            `Token estimate: ${basis.trim()}; USD per million input=${values.inputRate}, cached=${values.cachedRate}, output=${values.outputRate}.`,
          );
        }}
      >
        Use estimate in this draft
      </Button>
      <p className="wg-hint">
        Updates the draft’s token total and standard token/cost samples. Nothing is saved until you
        review and apply the report. Report each measured interval once.
      </p>
    </details>
  );
}
