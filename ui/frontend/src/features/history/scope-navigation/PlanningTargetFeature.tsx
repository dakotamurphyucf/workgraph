import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { FeatureContext } from "../../../app/types";
import { Badge, Button, Panel, StatePanel } from "../../../components/Primitives";
import { ContentViewer, type ContentSource } from "../../../content";
import { jsonField } from "../../../core/json";
import { createReadSlot } from "../../../core/state/read-slot";
import { failureText } from "../../connections/failure";
import { JsonView, LazyDetails } from "../../connections/shared";
import { planningResponseJson, readPlanningTarget } from "./client";
import { planningKey } from "./model";
import type { PlanningCapture, PlanningTarget } from "./types";

function complete(capture: PlanningCapture): boolean {
  const budget = jsonField(capture.response.response.meta, "budget");
  if (budget?.kind !== "object") return false;
  const truncated = jsonField(budget, "truncated"),
    omittedFields = jsonField(budget, "omitted_fields"),
    omittedItems = jsonField(budget, "omitted_items"),
    details = jsonField(budget, "details_complete");
  return (
    truncated?.kind === "boolean" &&
    !truncated.value &&
    omittedFields?.kind === "string" &&
    omittedFields.value === "0" &&
    omittedItems?.kind === "string" &&
    omittedItems.value === "0" &&
    details?.kind === "boolean" &&
    details.value
  );
}
function Record({
  capture,
  context,
}: {
  readonly capture: PlanningCapture;
  readonly context: FeatureContext;
}) {
  const { record, target } = capture,
    partial = !complete(capture);
  const source = useMemo<ContentSource>(
    () => ({
      key: `${planningKey(target)}:${record.revision}`,
      label: `${record.kind} details`,
      bytes: new TextEncoder().encode(
        [
          record.summary,
          record.description,
          record.instructions ? `## Instructions\n\n${record.instructions}` : "",
          record.acceptance ? `## Acceptance criteria\n\n${record.acceptance}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      ),
      completeness: partial ? "partial" : "complete",
      hints: { mime: "text/markdown", intent: "prose" },
    }),
    [target, record, partial],
  );
  return (
    <article aria-label={`Recorded ${record.kind} target`}>
      <Panel title={record.title || `${record.kind} ${record.id}`}>
        <p>
          {record.kind} <code>{record.id}</code> {record.status && <Badge>{record.status}</Badge>}{" "}
          {record.archived && <Badge tone="warning">Archived</Badge>}
        </p>
        <p>Current record at the recorded endpoint. This is not a historical planning snapshot.</p>
        {target.generation !== context.connection.generation && (
          <p role="status">
            Recorded endpoint generation {target.generation}; the profile now selects generation{" "}
            {context.connection.generation}. No replacement endpoint was used.
          </p>
        )}
        {partial && (
          <p role="status">
            Some details may be omitted or incomplete. The exact response and coverage metadata
            remain available below.
          </p>
        )}
        {source.bytes.byteLength > 0 ? (
          <ContentViewer source={source} />
        ) : (
          <p>No descriptive content was returned.</p>
        )}
        {record.projectId !== null && (
          <p>
            Current project association: <code>{record.projectId}</code>
          </p>
        )}
        {record.targetDate !== null && <p>Target date: {record.targetDate}</p>}
        <LazyDetails summary="Endpoint, revision and source">
          <p>
            Connection {target.connectionId} · generation {target.generation} · workspace{" "}
            {target.workspaceId} · record revision {record.revision}
          </p>
          <p>
            This linked detail is read-only. Opening it does not choose an actor or acquire
            ownership.
          </p>
          <JsonView
            value={planningResponseJson(capture.response)}
            identity={`${planningKey(target)}:${record.revision}`}
            label="Exact planning response"
            processing={context.client.processing}
          />
        </LazyDetails>
      </Panel>
    </article>
  );
}
/** A route-scoped passive target view. Profile and target reads are canceled
 * together on navigation, with slot identity fencing even if a transport ignores abort. */
export function PlanningTargetFeature({
  context,
  target,
}: {
  readonly context: FeatureContext;
  readonly target: PlanningTarget;
}) {
  const [slot] = useState(() => createReadSlot<PlanningCapture>()),
    [refresh, setRefresh] = useState(0);
  const key = planningKey(target),
    state = useSyncExternalStore(slot.subscribe, slot.get);
  useEffect(() => {
    void slot
      .load(key, (signal) => readPlanningTarget(context.client, target, signal))
      .catch(() => {
        // ReadSlot owns and publishes the unexpected error; render reaches the boundary.
      });
    return () => slot.clear();
    // The immutable route key includes every target field; refresh is explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.client, key, slot, refresh]);
  const active = state.kind !== "idle" && state.key === key ? state : null;
  if (active?.kind === "unexpected_error") throw active.error;
  const capture = active?.kind === "ready" ? active.value : active?.previous;
  return (
    <section aria-label="Recorded planning association">
      <Button onClick={() => setRefresh((value) => value + 1)}>Refresh target</Button>
      {active === null || active.kind === "loading" ? (
        <p role="status">Loading the recorded planning target…</p>
      ) : null}
      {active?.kind === "failed" && (
        <StatePanel kind="error" title="Recorded target unavailable">
          <p>{failureText(active.failure)}</p>
          <p>
            The requested endpoint and target were preserved. No current-profile fallback was
            attempted.
          </p>
        </StatePanel>
      )}
      {capture && active?.kind !== "ready" && (
        <p role="status">Previously received target retained; it is not a fresh result.</p>
      )}
      {capture && <Record capture={capture} context={context} />}
    </section>
  );
}
