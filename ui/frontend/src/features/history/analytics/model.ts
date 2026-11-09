import type { Route } from "../../../app/types";
import * as d from "../../../core/protocol/decoders";
import type { Identifier, Preparation } from "../../../core/protocol/types";
import type { HistoryState } from "../transcript/types";
import { current, partKey } from "../transcript/controller";
import { sameCapture } from "../transcript/client";
import { ActionInputError } from "../../work/actions/model";
import { int64, metric, text } from "./codecs";
import type { SearchCapture, SearchHit, SessionSummary, UsageDraft } from "./types";

export class AnalyticsInputError extends ActionInputError {}
export function identifier(value: string, label: string): Identifier {
  const r = d.identifier.decode(d.jsonString(value));
  if (!r.ok)
    throw new AnalyticsInputError(`${label} must be an ASCII identifier of 1–96 characters.`);
  return r.value;
}
export function bounded(value: string, label: string, max: number, nonblank = false): string {
  if (!text(max, nonblank).decode(d.jsonString(value)).ok)
    throw new AnalyticsInputError(
      `${label} must fit ${max} UTF-8 bytes${nonblank ? " and be nonblank" : ""}.`,
    );
  return value;
}
export function counter(value: string, label: string, min: bigint, max: bigint) {
  const r = d.decimal.decode(d.jsonString(value));
  if (!r.ok || BigInt(r.value) < min || BigInt(r.value) > max)
    throw new AnalyticsInputError(
      `${label} must be a canonical integer between ${min} and ${max}.`,
    );
  return r.value;
}
export function quantity(value: string, label: string): string {
  if (!int64.decode(d.jsonString(value)).ok)
    throw new AnalyticsInputError(
      `${label} must be a nonnegative exact integer ≤9223372036854775807.`,
    );
  return value;
}
export function searchRoute(route: Route, capture: SearchCapture, hit: SearchHit): Route {
  if (
    !capture.data.items.some(
      (v) =>
        v.event_ref.session_id === hit.event_ref.session_id &&
        v.event_ref.sequence === hit.event_ref.sequence,
    )
  )
    throw new AnalyticsInputError("This hit is not part of the retained search page.");
  return {
    view: "history",
    connectionId: capture.scope.connectionId,
    workspaceId: capture.scope.workspaceId,
    projectId: route.projectId,
    entityId: hit.event_ref.session_id,
    history: {
      generation: capture.scope.generation,
      head: capture.capture.head,
      sequence: hit.event_ref.sequence,
    },
  };
}
/** Only already validated, loaded report projections from this exact window.
 * There is deliberately no addition, latest-time choice or inferred session total. */
export function sessionSummary(state: HistoryState): SessionSummary | null {
  const session = current(state.session),
    window = current(state.window);
  if (session === undefined || state.scope === null) return null;
  const matchingWindow =
    window !== undefined &&
    sameCapture(window.capture, session.capture) &&
    session.capture.workspace_id === state.scope.workspaceId &&
    window.data.through === session.data.through &&
    window.data.session_id === session.data.session.session_id;
  const events = matchingWindow ? window.data.items : [];
  let bytes = 0n;
  const reports = [];
  for (const event of events) {
    const key = partKey(event.event_ref, { kind: "payload" });
    const result = state.projections.get(key);
    if (result?.status === "recognized") {
      const scope = result.capture.scopeId;
      const exactId = `${JSON.stringify([state.scope.connectionId, state.scope.generation, state.scope.workspaceId])}/${session.capture.head}/${key}`;
      if (
        scope[0] === state.scope.connectionId &&
        scope[1] === state.scope.generation &&
        scope[2] === state.scope.workspaceId &&
        scope[3] === session.data.session.session_id &&
        result.capture.captureId === exactId
      )
        reports.push({ event: event.event_ref, metrics: result.projection.metrics });
    }
    bytes += BigInt(event.event.payload.blob.size_bytes);
  }
  return {
    title: session.data.session.title,
    through: session.data.through,
    archived: session.data.session.archived,
    originatingRunId: session.data.session.run_id,
    loadedEvents: events.length,
    declaredPayloadBytes: bytes,
    reports,
  };
}
export function reportPreparation(draft: UsageDraft): Preparation {
  const ctx = draft.context,
    input = draft.input,
    actor = identifier(ctx.writer.actorId ?? "", "Original reporting author"),
    run = ctx.writer.runId === null ? null : identifier(ctx.writer.runId, "Original acting run"),
    workspace = identifier(ctx.route.workspaceId ?? "", "Workspace");
  if (input.metrics.length > 16)
    throw new AnalyticsInputError("At most 16 additive metric samples may be reported.");
  const names = new Set<string>();
  const samples = input.metrics
    .map((v) => {
      const r = metric.decode(
        d.jsonObject([
          ["name", d.jsonString(v.name)],
          ["unit", d.jsonString(v.unit)],
          ["value", d.jsonString(v.value)],
        ]),
      );
      if (!r.ok)
        throw new AnalyticsInputError(
          `Invalid sample ${v.name || "(unnamed)"}: ${r.issue.expected}.`,
        );
      if (names.has(v.name))
        throw new AnalyticsInputError("Metric sample names must be distinct within a report.");
      names.add(v.name);
      return r.value;
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const fields = [
    ["workspace_id", d.jsonString(workspace)],
    ["actor_id", d.jsonString(actor)],
    ["mutation_id", d.jsonString(draft.id)],
    ["usage_id", d.jsonString(identifier(input.usageId, "Usage report ID"))],
    [
      "scope",
      d.jsonObject([
        ["kind", d.jsonString(input.scopeKind)],
        [
          input.scopeKind === "run" ? "run_id" : "attempt_id",
          d.jsonString(identifier(input.scopeId, "Reported scope")),
        ],
      ]),
    ],
    ["reported_actor_id", d.jsonString(actor)],
    ["tokens", d.jsonString(quantity(input.tokens, "Tokens"))],
    ["elapsed_ms", d.jsonString(quantity(input.elapsedMs, "Elapsed milliseconds"))],
    [
      "metrics",
      d.jsonArray(
        samples.map((v) =>
          d.jsonObject([
            ["name", d.jsonString(v.name)],
            ["unit", d.jsonString(v.unit)],
            ["value", d.jsonString(v.value)],
          ]),
        ),
      ),
    ],
    ["provenance", d.jsonString(bounded(input.provenance, "Provenance", 4096, true))],
    ["timestamp", d.jsonString(bounded(input.timestamp, "Reported timestamp", 128, true))],
    ...(run === null ? [] : [["run_id", d.jsonString(run)] as const]),
  ] as const;
  return {
    intention_id: draft.id,
    connection_id: ctx.connection.id,
    generation: ctx.connection.generation,
    context: {
      workspace_id: workspace,
      project_id:
        ctx.route.projectId === null ? null : identifier(ctx.route.projectId, "Selected project"),
      writer: { actor_id: actor, run_id: run },
    },
    method: "usage.report",
    params: d.jsonObject(fields),
  };
}
