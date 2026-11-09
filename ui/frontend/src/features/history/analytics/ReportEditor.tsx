import { CostCalculator } from "../usage-dashboard/CostCalculator";
import { HistoryReferences } from "../transcript/HistoryReferences";
import { ReferenceField } from "../../discussions/ReferenceFields";
import { FormSection } from "../../discussions/FormSection";
import { ActorAvatar } from "../../../components/ActorAvatar";
import { useState, useSyncExternalStore } from "react";
import type { FeatureContext } from "../../../app/types";
import { Dialog } from "../../../components/Dialog";
import { ObservationNotice } from "../../../components/ObservationNotice";
import { Badge, Button, Field, Select, Toolbar } from "../../../components/Primitives";
import type { ManagedAction, OperationController } from "../../../core/state/operations";
import { failureText } from "../../connections/failure";
import type { HistoryAnalyticsController, UsageDraft } from "./types";

export function ReportEditor({
  context,
  draft,
  controller,
  operations,
}: {
  readonly context: FeatureContext;
  readonly draft: UsageDraft;
  readonly controller: HistoryAnalyticsController;
  readonly operations: OperationController;
}) {
  const managed = useSyncExternalStore(operations.subscribe, () => operations.get(draft.id));
  const [issue, setIssue] = useState(""),
    [unexpected, setUnexpected] = useState<{ readonly error: unknown } | null>(null);
  if (draft.unexpected !== null) throw draft.unexpected.error;
  if (unexpected !== null) throw unexpected.error;
  if (managed?.phase.kind === "unexpected_error") throw managed.phase.error;
  const input = draft.input,
    locked = draft.pending || draft.frozen !== null || managed !== undefined,
    pending = draft.pending || managed?.phase.kind === "pending",
    operation = managed?.operation;
  const change = (patch: Partial<typeof input>) =>
    controller.editReport(draft.id, { ...input, ...patch });
  const act = (action: ManagedAction) => {
    setIssue("");
    void operations
      .act(draft.id, action)
      .then((r) => {
        if (!r.ok) setIssue(failureText(r.failure));
      })
      .catch((error: unknown) => setUnexpected({ error }));
  };
  const original = draft.context.writer,
    changed =
      original.actorId !== context.writer.actorId || original.runId !== context.writer.runId;
  return (
    <HistoryReferences context={context} target={draft.context}>
      <Dialog title="Report usage" wide onClose={() => controller.selectReport(null)}>
        <div className="ht-writer">
          <ActorAvatar actor={original.actorId ?? "Unknown"} />
          <p>
            Reporting author <strong>{original.actorId}</strong>
            {original.runId === null ? "" : ` · acting run ${original.runId}`}{" "}
            {changed && <Badge tone="warning">Original writer retained after switch</Badge>}
          </p>
        </div>
        <p className="wg-hint">
          Immutable caller-reported consumption. This does not measure activity, infer billing, or
          allocate a shared run to sessions.
        </p>
        {operation?.state.kind === "committed" && <p role="status">Usage report saved.</p>}
        <fieldset className="ha-report-fields" disabled={locked}>
          <FormSection
            title="What work does this report describe?"
            icon="participants"
            description="A run is one agent invocation; an attempt is one recorded try at a ticket. Choose the exact work whose consumption you measured. Saving adds a permanent report; it does not calculate usage for you."
          >
            <Select
              label="Reported scope"
              value={input.scopeKind}
              onChange={(e) =>
                change({ scopeKind: e.currentTarget.value === "attempt" ? "attempt" : "run" })
              }
            >
              <option value="run">Run</option>
              <option value="attempt">Attempt</option>
            </Select>
            <ReferenceField
              kind={input.scopeKind}
              label={input.scopeKind === "run" ? "Reported run" : "Reported attempt"}
              value={input.scopeId}
              disabled={locked}
              onChange={(value) => change({ scopeId: value })}
            />
          </FormSection>
          <FormSection
            title="Record the measured consumption"
            icon="activity"
            tone="green"
            description="Enter the numbers supplied by your runner. Describe where they came from so others can interpret them. Reports are additive: do not enter overlapping lifetime totals as new consumption."
          >
            <div className="ha-grid">
              <Field
                label="Reported tokens"
                value={input.tokens}
                inputMode="numeric"
                onChange={(e) => change({ tokens: e.currentTarget.value })}
                hint="Exact nonnegative integer; enter zero only if explicitly reported."
              />
              <Field
                label="Reported elapsed milliseconds"
                value={input.elapsedMs}
                inputMode="numeric"
                onChange={(e) => change({ elapsedMs: e.currentTarget.value })}
              />
            </div>
            <Field
              label="Usage source / provenance"
              value={input.provenance}
              onChange={(e) => change({ provenance: e.currentTarget.value })}
            />
            <Field
              label="Source-reported timestamp"
              value={input.timestamp}
              onChange={(e) => change({ timestamp: e.currentTarget.value })}
              hint="Caller text, not a server observation or liveness signal."
            />
          </FormSection>
          <CostCalculator
            key={draft.id}
            disabled={locked}
            onUse={(tokens, metrics, basis) => {
              const names = new Set([
                "input_tokens",
                "output_tokens",
                "cached_input_tokens",
                "cost_usd_micros",
                "estimated_cost_usd_micros",
              ]);
              const preserved = input.metrics.filter((metric) => !names.has(metric.name));
              if (preserved.length + metrics.length > 16) {
                setIssue(
                  "Remove some custom samples before adding the four standard token/cost samples.",
                );
                return;
              }
              setIssue("");
              change({
                tokens,
                metrics: [...preserved, ...metrics].sort((a, b) =>
                  a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
                ),
                provenance: [input.provenance, basis].filter(Boolean).join("\n"),
              });
            }}
          />
          <details>
            <summary>Additive named samples ({input.metrics.length}/16)</summary>
            {input.metrics.map((v, i) => (
              <div className="ha-grid" key={i}>
                <Field
                  label={`Sample ${i + 1} name`}
                  value={v.name}
                  onChange={(e) =>
                    change({
                      metrics: input.metrics.map((x, n) =>
                        n === i ? { ...x, name: e.currentTarget.value } : x,
                      ),
                    })
                  }
                />
                <Field
                  label={`Sample ${i + 1} unit`}
                  value={v.unit}
                  onChange={(e) =>
                    change({
                      metrics: input.metrics.map((x, n) =>
                        n === i ? { ...x, unit: e.currentTarget.value } : x,
                      ),
                    })
                  }
                />
                <Field
                  label={`Sample ${i + 1} value`}
                  value={v.value}
                  onChange={(e) =>
                    change({
                      metrics: input.metrics.map((x, n) =>
                        n === i ? { ...x, value: e.currentTarget.value } : x,
                      ),
                    })
                  }
                />
                <Button
                  onClick={() => change({ metrics: input.metrics.filter((_, n) => n !== i) })}
                >
                  Remove sample {i + 1}
                </Button>
              </div>
            ))}
            <Button
              disabled={input.metrics.length >= 16}
              onClick={() =>
                change({ metrics: [...input.metrics, { name: "", unit: "", value: "" }] })
              }
            >
              Add named sample
            </Button>
            <p className="wg-hint">
              Samples are additive integers, not gauges. Distinct units stay separate; no
              conversion.
            </p>
          </details>
          <details>
            <summary>Stable report identity</summary>
            <Field
              label="Usage report ID"
              value={input.usageId}
              onChange={(e) => change({ usageId: e.currentTarget.value })}
            />
            <p>
              Identical retries reuse the saved identity; changing an existing report conflicts.
            </p>
          </details>
        </fieldset>
        {draft.issue !== null && (
          <p role="alert" className="wg-error">
            {draft.issue}
          </p>
        )}
        {issue !== "" && (
          <p role="alert" className="wg-error">
            {issue}
          </p>
        )}
        {managed?.phase.kind === "unconfirmed" && (
          <p role="alert">
            Unconfirmed observation: {failureText(managed.phase.failure)}. Inspect before an
            explicit retry.
          </p>
        )}
        {operation && operation.state.kind !== "committed" && (
          <p role="status">
            <Badge tone={operation.state.kind === "outcome_unknown" ? "warning" : "neutral"}>
              {operation.state.kind}
            </Badge>
          </p>
        )}
        {operation?.state.kind === "sending" && <ObservationNotice status={managed?.observation} />}
        {(operation?.state.kind === "rejected" || operation?.state.kind === "outcome_unknown") && (
          <p role="alert">
            {operation.state.problem.kind}: {operation.state.problem.message}
          </p>
        )}
        {operation?.diagnostic && <p role="alert">{operation.diagnostic.message}</p>}
        <Toolbar label="Usage report controls">
          {operation === null || operation === undefined ? (
            <Button
              tone="primary"
              disabled={pending}
              onClick={() => {
                void controller
                  .reviewReport(draft.id)
                  .catch((error: unknown) => setUnexpected({ error }));
              }}
            >
              {draft.pending ? "Preparing report…" : "Review usage report"}
            </Button>
          ) : (
            <>
              {operation.state.kind === "prepared_unsent" && (
                <Button tone="primary" disabled={pending} onClick={() => act("execute")}>
                  Apply usage report
                </Button>
              )}
              <Button disabled={pending} onClick={() => act("inspect")}>
                Inspect saved report
              </Button>
              {operation.state.kind === "outcome_unknown" && (
                <>
                  <Button disabled={pending} onClick={() => act("retry")}>
                    Retry exact saved report
                  </Button>
                  <Button
                    disabled={pending || !operation.receipt_lookup_supported}
                    onClick={() => act("recover")}
                  >
                    Recover report receipt
                  </Button>
                </>
              )}
            </>
          )}
          <Button disabled={pending} onClick={() => controller.selectReport(null)}>
            Close editor
          </Button>
          <Button disabled={pending} onClick={() => controller.discardReport(draft.id)}>
            Discard local editor
          </Button>
        </Toolbar>
      </Dialog>
    </HistoryReferences>
  );
}
