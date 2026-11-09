import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { FeatureContext } from "../../../app/types";
import { Button } from "../../../components/Primitives";
import { Icon } from "../../../components/Icon";
import { ActorAvatar } from "../../../components/ActorAvatar";
import { createReadSlot } from "../../../core/state/read-slot";
import { useLiveSlot } from "../../../core/state/live-registry";
import { failureText } from "../../connections/failure";
import type { ParticipantsTarget } from "../../participants/runs/types";
import { consumption, formatTokens, formatUsd } from "../usage-dashboard/model";
import { readSessionContext, type SessionContextData } from "./session-context";
import { current } from "./controller";
import { historyNavigationTarget } from "./navigation-target";
import type { Captured, SessionDetail, HistoryScope, HistoryNavigationTarget } from "./types";
export function SessionContext({
  context,
  detail,
  scope,
  onNavigateTarget,
  canNavigateTarget,
}: {
  readonly context: FeatureContext;
  readonly detail: Captured<SessionDetail>;
  readonly scope: HistoryScope;
  readonly onNavigateTarget: ((target: HistoryNavigationTarget) => void) | undefined;
  readonly canNavigateTarget: ((target: HistoryNavigationTarget) => boolean) | undefined;
}) {
  const slot = useMemo(() => createReadSlot<SessionContextData>(), []);
  const state = useSyncExternalStore(slot.subscribe, slot.get);
  useLiveSlot(slot);
  const target = useMemo<ParticipantsTarget>(
    () => ({
      connection: { ...context.connection, generation: scope.generation },
      workspaceId: scope.workspaceId,
      projectId: null,
      selection: { kind: "none" },
    }),
    [context.connection, scope],
  );
  const requestKey = JSON.stringify([scope, detail.data.session.session_id]);
  const latest = useRef({ target, detail });
  useEffect(() => {
    latest.current = { target, detail };
  }, [target, detail]);
  useEffect(() => {
    void slot
      .load(
        requestKey,
        (signal) => {
          const saved = latest.current;
          return readSessionContext(context.client, saved.target, saved.detail, signal);
        },
        { live: true },
      )
      .catch(() => {
        /* Published by read slot. */
      });
  }, [slot, context.client, requestKey]);
  useEffect(() => () => slot.clear(), [slot]);
  if (state.kind === "unexpected_error") throw state.error;
  const data = state.kind !== "idle" && state.key === requestKey ? current(state) : undefined,
    id = detail.data.session.session_id;
  const rows = data?.usage.runs.filter((r) => r.sessions.session_ids.includes(id)) ?? [];
  const measures = rows.map((r) => consumption(r.usage.totals, r.usage.metrics ?? []));
  const sum = (field: "input" | "output" | "costMicros") => {
    const found = measures.filter((m) => m[field].value !== null);
    return {
      value: found.length ? found.reduce((n, m) => n + (m[field].value ?? 0n), 0n) : null,
      partial: found.length !== (data?.runs.length ?? 0) || found.some((m) => !m[field].complete),
    };
  };
  const input = sum("input"),
    output = sum("output"),
    cost = sum("costMicros"),
    shared = data?.runs.filter((r) => r.sessionCount !== "1").length ?? 0;
  const link = (label: string, value: HistoryNavigationTarget) =>
    onNavigateTarget && (canNavigateTarget?.(value) ?? true) ? (
      <Button tone="quiet" onClick={() => onNavigateTarget(value)}>
        {label}
      </Button>
    ) : (
      <span>{label}</span>
    );
  return (
    <section className="ht-session-context" aria-label="Session usage and related work">
      <div className="ht-session-metrics">
        <div>
          <span>
            <Icon name="activity" />
            {shared ? "Associated run cost" : "Session cost"}
          </span>
          <strong>{formatUsd(cost.value)}</strong>
          <small>
            {cost.value === null
              ? "Not reported"
              : `${measures.some((m) => m.estimated) ? "Includes estimate" : "Reported"}${cost.partial ? " · partial" : ""}`}
          </small>
        </div>
        <div>
          <span>Input tokens</span>
          <strong>{formatTokens(input.value)}</strong>
          <small>{input.partial ? "Partial / missing reports" : "Includes cached input"}</small>
        </div>
        <div>
          <span>Output tokens</span>
          <strong>{formatTokens(output.value)}</strong>
          <small>
            {output.partial ? "Partial / missing reports" : "Includes reported reasoning"}
          </small>
        </div>
        <div>
          <span>Associated runs</span>
          <strong>{data?.runs.length ?? "—"}</strong>
          <small>{shared ? `${shared} shared with other sessions` : "Each run counted once"}</small>
        </div>
      </div>
      {shared > 0 && (
        <p className="ht-usage-caption">
          Includes full totals from shared runs; those costs cannot be split exactly between their
          sessions. Workspace totals count each run once.
        </p>
      )}
      {state.kind === "failed" && (
        <p role="alert">
          Related work: {failureText(state.failure)}
          {data ? " · previous values retained" : ""}
        </p>
      )}
      <div className="ht-related-work">
        {detail.data.session.scopes.map((value, i) => (
          <span className="ht-work-chip" key={`scope-${i}`}>
            <Icon name={value.kind === "ticket" ? "work" : "workflow"} />
            {link(
              value.kind === "workspace" ? "Workspace" : `${value.kind} · ${value.id}`,
              historyNavigationTarget(scope, { kind: "scope", scope: value }),
            )}
          </span>
        ))}
        {data?.runs.map(({ run }) => (
          <span className="ht-work-chip is-run" key={run.run_id}>
            <ActorAvatar actor={run.actor_id} />
            {link(run.run_id, historyNavigationTarget(scope, { kind: "run", runId: run.run_id }))}
            <small>{run.status}</small>
          </span>
        ))}
        {data?.attempts.map((a) => (
          <span className="ht-work-chip is-attempt" key={a.attempt_id}>
            <Icon name="work" />
            {link(
              a.ticket_id,
              historyNavigationTarget(scope, {
                kind: "scope",
                scope: { kind: "ticket", id: a.ticket_id },
              }),
            )}
            <small>
              {a.state} · {a.attempt_id}
              {!a.session_ids.includes(id) ? " · via run" : ""}
            </small>
          </span>
        ))}
        {data &&
          !data.runs.length &&
          !data.attempts.length &&
          !detail.data.session.scopes.length && (
            <span className="wg-hint">No linked work recorded for this session.</span>
          )}
      </div>
    </section>
  );
}
