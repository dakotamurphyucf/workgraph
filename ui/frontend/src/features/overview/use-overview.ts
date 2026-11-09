import { useEffect, useState, useSyncExternalStore } from "react";
import type { FeatureContext } from "../../app/types";
import { captureScope, scopeKey } from "./model";
import type { OverviewController } from "./types";
export function useOverview(context: FeatureContext, controller: OverviewController) {
  const state = useSyncExternalStore(controller.subscribe, controller.get, controller.get);
  const [error, setError] = useState<{ readonly value: unknown } | null>(null);
  const run = (task: Promise<void>) => {
    void task.catch((value: unknown) => setError({ value }));
  };
  useEffect(() => {
    void controller.open(context).catch((value: unknown) => setError({ value }));
  }, [context, controller]);
  useEffect(() => () => controller.pause(), [controller]);
  if (error !== null) throw error.value;
  return {
    state,
    run,
    matches:
      state.scope !== null &&
      context.route.workspaceId !== null &&
      scopeKey(state.scope) === scopeKey(captureScope(context)),
  };
}
