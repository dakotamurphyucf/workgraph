import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { FeatureContext } from "../../app/types";
import { routeHref } from "../../app/navigation";
import { StatePanel } from "../../components/Primitives";
import * as d from "../../core/protocol/decoders";
import type { ConnectionProfile } from "../../core/protocol/types";
import { createReadSlot } from "../../core/state/read-slot";
import { failureText } from "../connections/failure";
import { planningRoute } from "../history/scope-navigation";
import { matchesWorkbench } from "./destinations";

/** No editable children mount until the URL's retained generation is independently resolved. */
export function WorkbenchDestination({
  context,
  render,
}: {
  readonly context: FeatureContext;
  readonly render: () => ReactNode;
}) {
  const slot = useMemo(() => createReadSlot<ConnectionProfile>(), []),
    state = useSyncExternalStore(slot.subscribe, slot.get, slot.get),
    { route } = context,
    generation = route.workbench?.generation;
  const key = JSON.stringify([
    route.connectionId,
    generation,
    route.workspaceId,
    route.workbench?.socket,
    context.connection.id,
    context.connection.generation,
    context.connection.socket,
  ]);
  useEffect(() => {
    if (generation === undefined || route.connectionId === null) return;
    const connectionId = route.connectionId;
    void slot
      .load(key, async (signal) => {
        const result = await context.client.request({
          method: "GET",
          path: `/connections/${encodeURIComponent(connectionId)}/generations/${generation}`,
          codec: d.connectionProfile,
          signal,
        });
        if (result.ok && (result.data.id !== connectionId || result.data.generation !== generation))
          return {
            ok: false,
            failure: {
              kind: "protocol",
              message: "Retained workbench profile changed identity.",
              issue: undefined,
            },
          };
        return result;
      })
      .catch(() => {
        /* Slot owns unexpected errors; only this exact owner may render them. */
      });
    return () => slot.clear();
  }, [slot, key, context.client, route.connectionId, generation]);
  // The load effect clears pending ownership on unmount and StrictMode replay.
  if (state.kind === "unexpected_error" && state.key === key) throw state.error;
  if (
    state.kind === "idle" ||
    state.key !== key ||
    state.kind === "loading" ||
    context.profileState === "refreshing"
  )
    return <p role="status">Verifying the original workbench endpoint…</p>;
  if (state.kind === "ready" && matchesWorkbench(context, state.value)) return render();
  const connectionId = d.identifier.decode(d.jsonString(route.connectionId ?? "")),
    workspaceId = d.identifier.decode(d.jsonString(route.workspaceId ?? "")),
    ticketId = d.identifier.decode(d.jsonString(route.entityId ?? "")),
    exactGeneration = d.positiveDecimal.decode(d.jsonString(generation ?? ""));
  const readOnly =
    state.kind === "ready" &&
    state.value.id === route.connectionId &&
    state.value.generation === generation &&
    state.value.socket === route.workbench?.socket &&
    connectionId.ok &&
    workspaceId.ok &&
    ticketId.ok &&
    exactGeneration.ok
      ? planningRoute({
          connectionId: connectionId.value,
          workspaceId: workspaceId.value,
          generation: exactGeneration.value,
          kind: "ticket",
          id: ticketId.value,
        })
      : null;
  return (
    <StatePanel kind="unavailable" title="Original workbench endpoint is not current">
      <p>
        This destination keeps generation {generation}. The current connection has not been
        substituted. Choose the matching original profile before editing.
      </p>
      <p>
        Captured endpoint: <code>{route.workbench?.socket}</code>
      </p>
      {state.kind === "failed" && <p role="alert">{failureText(state.failure)}</p>}
      {readOnly && <a href={routeHref(readOnly)}>View original ticket read-only</a>}
    </StatePanel>
  );
}
