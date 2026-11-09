import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { FeatureContext } from "../../app/types";
import { createReadSlot } from "../../core/state/read-slot";
import * as d from "../../core/protocol/decoders";
import type { ConnectionProfile } from "../../core/protocol/types";

import { failureText } from "../connections/failure";
import type { FactSelection } from "../knowledge/facts";
import { factSelection } from "./destinations";
/** The host resolves the retained generation before handing a selection to Facts.
 * Current FeatureContext is preserved so an old endpoint never gains current mutation authority. */
export function FactDestination({
  context,
  render,
}: {
  readonly context: FeatureContext;
  readonly render: (selection: FactSelection) => ReactNode;
}) {
  const slot = useMemo(() => createReadSlot<ConnectionProfile>(), []);
  const { route } = context,
    target = route.fact;
  const key = target === undefined ? null : JSON.stringify([route.connectionId, target.generation]);
  const generation = target?.generation;
  const state = useSyncExternalStore(slot.subscribe, slot.get, slot.get);
  useEffect(() => {
    if (key === null || generation === undefined || route.connectionId === null) {
      slot.clear();
      return;
    }
    const connectionId = route.connectionId;
    void slot
      .load(key, async (signal) => {
        const result = await context.client.request({
          path: `/connections/${encodeURIComponent(connectionId)}/generations/${generation}`,
          method: "GET",
          codec: d.connectionProfile,
          signal,
        });
        if (!result.ok) return result;
        if (result.data.id !== connectionId || result.data.generation !== generation)
          return {
            ok: false,
            failure: {
              kind: "protocol",
              message: "The fact endpoint changed identity; no fact read was sent.",
              issue: undefined,
            },
          };
        return result;
      })
      .catch(() => {
        /* Owned unexpected failures remain in ReadSlot. */
      });
    return () => slot.clear();
  }, [slot, key, context.client, route.connectionId, generation]);
  useEffect(() => () => slot.dispose(), [slot]);
  if (key === null) return <p role="alert">This route has no explicit fact selection.</p>;
  if (state.kind === "idle" || state.key !== key || state.kind === "loading")
    return <p role="status">Resolving the exact fact endpoint…</p>;
  if (state.kind === "unexpected_error") throw state.error;
  if (state.kind === "failed") return <p role="alert">{failureText(state.failure)}</p>;
  const selection = factSelection(route, state.value);
  return selection === null ? (
    <p role="alert">
      The exact fact scope or revision is invalid. No current value was substituted.
    </p>
  ) : (
    render(selection)
  );
}
