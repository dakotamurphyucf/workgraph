import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { Identifier } from "../../../core/protocol/types";
import type { FeatureContext } from "../../../app/types";
import { createReadSlot } from "../../../core/state/read-slot";
import { useLiveSlot } from "../../../core/state/live-registry";
import { Button } from "../../../components/Primitives";
import { Icon } from "../../../components/Icon";
import { failureText } from "../../connections/failure";
import type { ParticipantsTarget } from "../../participants/runs/types";
import { readUsageDashboard, type UsageDashboard } from "../usage-dashboard/client";
import { consumption, formatTokens, formatUsd } from "../usage-dashboard/model";
import type { Captured, DirectoryPage } from "./types";
import { current } from "./controller";

/** Existing run/attempt reports counted once per run. A sole associated session
 * may display that run's usage; multiple sessions share one undivided row. */
export function SessionUsageOverview({
  context,
  directory,
  onOpenUsage,
  onOpenSession,
}: {
  readonly context: FeatureContext;
  readonly directory: Captured<DirectoryPage>;
  readonly onOpenUsage: () => void;
  readonly onOpenSession: (id: Identifier) => void;
}) {
  const slot = useMemo(() => createReadSlot<UsageDashboard>(), []),
    state = useSyncExternalStore(slot.subscribe, slot.get);
  useLiveSlot(slot);
  const target = useMemo<ParticipantsTarget>(
    () => ({
      connection: context.connection,
      workspaceId: directory.capture.workspace_id,
      projectId: null,
      selection: { kind: "none" },
    }),
    [context.connection, directory.capture.workspace_id],
  );
  const requestKey = JSON.stringify([
    target.connection.id,
    target.connection.generation,
    target.workspaceId,
  ]);
  const latest = useRef({ target, capture: directory.capture });
  useEffect(() => {
    latest.current = { target, capture: directory.capture };
  }, [target, directory.capture]);
  useEffect(() => {
    void slot
      .load(
        requestKey,
        (signal) => {
          const saved = latest.current;
          return readUsageDashboard(context.client, saved.target, saved.capture, signal);
        },
        { live: true },
      )
      .catch(() => {
        /* Published by read slot. */
      });
  }, [slot, context.client, requestKey]);
  useEffect(() => () => slot.clear(), [slot]);
  if (state.kind === "unexpected_error") throw state.error;
  const result = state.kind !== "idle" && state.key === requestKey ? current(state) : undefined,
    rows =
      result?.runs.map((r) => ({
        ...r,
        consumption: consumption(r.usage.totals, r.usage.metrics ?? []),
      })) ?? [];
  const total = (name: "input" | "output" | "costMicros") => {
    const known = rows.filter((r) => r.consumption[name].value !== null);
    return {
      value: known.length
        ? known.reduce((sum, r) => sum + (r.consumption[name].value ?? 0n), 0n)
        : null,
      known: known.length,
      complete: known.filter((r) => r.consumption[name].complete).length,
    };
  };
  const input = total("input"),
    output = total("output"),
    cost = total("costMicros");
  return (
    <section className="ht-project-usage ht-run-usage" aria-label="Session and shared run usage">
      <header>
        <div>
          <h3>
            <Icon name="activity" /> Token usage &amp; cost
          </h3>
          <p>
            Workspace run reports, counted once. A run with one session is shown under that session;
            otherwise its usage is shared.
          </p>
        </div>
        <Button tone="quiet" onClick={onOpenUsage}>
          Explore usage →
        </Button>
      </header>
      <div className="ht-consumption-cards">
        {(
          [
            ["Input tokens", formatTokens(input.value), input],
            ["Output tokens", formatTokens(output.value), output],
            ["Cost · USD", formatUsd(cost.value), cost],
          ] as const
        ).map(([label, value, total]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>
              {result
                ? `${total.known} of ${rows.length} runs reported${total.complete < total.known ? " · some reports partial" : ""}`
                : "Waiting for recorded usage"}
            </small>
          </div>
        ))}
      </div>
      {state.kind === "loading" && !result && <p role="status">Loading recorded consumption…</p>}
      {state.kind === "failed" && (
        <p role="alert">
          {failureText(state.failure)}
          {result
            ? " Last confirmed figures retained; they may be out of date."
            : " Usage unavailable."}
        </p>
      )}
      {result && (
        <>
          <div className="ht-usage-table">
            <table>
              <thead>
                <tr>
                  <th>Session / shared run</th>
                  <th>Input tokens</th>
                  <th>Output tokens</th>
                  <th>Cost · USD</th>
                  <th>Reports</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ usage, sessions, consumption: measure }) => {
                  const single = sessions.total === "1" ? sessions.session_ids[0] : undefined;
                  const session = directory.data.items.find((s) => s.session_id === single);
                  return (
                    <tr key={sessions.run_id}>
                      <td>
                        {single ? (
                          <Button tone="quiet" onClick={() => onOpenSession(single)}>
                            {session?.title ?? single}
                          </Button>
                        ) : (
                          <strong>{sessions.run_id}</strong>
                        )}
                        <small className="ht-usage-attribution">
                          {sessions.total === "0"
                            ? "No linked session"
                            : single
                              ? "Sole session · run-reported usage"
                              : `Shared by ${sessions.total} sessions · counted once`}
                          {single ? ` · ${sessions.run_id}` : ""}
                        </small>
                      </td>
                      <td>
                        {formatTokens(measure.input.value)}
                        {measure.input.value !== null && !measure.input.complete && (
                          <small>Partial reports</small>
                        )}
                      </td>
                      <td>
                        {formatTokens(measure.output.value)}
                        {measure.output.value !== null && !measure.output.complete && (
                          <small>Partial reports</small>
                        )}
                      </td>
                      <td>
                        {formatUsd(measure.costMicros.value)}
                        <small>
                          {measure.costMicros.value === null
                            ? "Not reported"
                            : `${measure.estimated ? "Includes estimate" : "Reported"}${measure.costMicros.complete ? "" : " · partial"}`}
                        </small>
                      </td>
                      <td>
                        {usage.totals.observations}
                        {usage.totals.overflow && <small>Counter overflow</small>}
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={5}>
                      No usage reports yet. Your importer or harness can record measured token
                      counts and cost for a run or attempt.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="ht-usage-caption">
            Missing figures are unknown, not zero. Input includes cached input; output includes
            reasoning when supplied. Cost is reported or calculated by the reporter using its
            recorded price basis, not verified billing. Run and attempt reports must describe
            non-overlapping usage. Captured at planning revision {result.revision}.
          </p>
        </>
      )}
    </section>
  );
}
