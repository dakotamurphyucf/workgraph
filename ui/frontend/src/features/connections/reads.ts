import { useLiveSlot } from "../../core/state/live-registry";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { FeatureContext } from "../../app/types";
import { createCompanion } from "../../core/protocol/client";
import * as d from "../../core/protocol/decoders";
import * as c from "../../core/protocol/codec";
import { jsonField, stringifyJson } from "../../core/json";
import type { JsonObject, ReadResponse } from "../../core/protocol/types";
import { createReadSlot, readKey } from "../../core/state/read-slot";
import { readScope } from "./model";

export function useDaemonRead(
  context: FeatureContext,
  method: string,
  params: JsonObject,
  enabled = true,
) {
  const companion = useMemo(() => createCompanion(context.client), [context.client]);
  const [slot] = useState(() => createReadSlot<ReadResponse>());
  useLiveSlot(slot);
  const [unexpected, setUnexpected] = useState<{ readonly error: unknown } | null>(null);
  const scope = readScope(context);
  const key = readKey(scope, method, params);
  const load = useCallback(
    async (request: { readonly method: string; readonly params: JsonObject }, live = true) => {
      const encoded = stringifyJson(request.params);
      if (!encoded.ok) throw new Error(encoded.error.message);
      const result = await slot.load(
        `${key}:${request.method}:${encoded.value}`,
        (signal) =>
          companion.read(
            {
              connection_id: context.connection.id,
              generation: context.connection.generation,
              method: request.method,
              params: request.params,
              lane: "visible",
            },
            signal,
          ),
        { live },
      );
      if (!result.ok && "superseded" in result) return;
    },
    [slot, companion, key, context.connection.id, context.connection.generation],
  );
  useEffect(() => {
    if (enabled && context.profileState === "current")
      void load({ method, params }).catch((error: unknown) => {
        setUnexpected({ error });
      });
    return () => {
      slot.clear();
    };
    // The bounded read key already contains the exact parameters and all scope fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, enabled, context.profileState, method, key]);
  const state = useSyncExternalStore(slot.subscribe, slot.get);
  const refresh = () => {
    void load({ method, params }).catch((error: unknown) => {
      setUnexpected({ error });
    });
  };
  const next = () => {
    if (state.kind !== "ready" || state.value.pagination === null) return;
    const source = jsonField(state.value.pagination, "next_request");
    const codec = c.record({
      jsonrpc: c.literal("2.0"),
      workgraph_api: c.literal("0.7"),
      id: c.raw,
      method: c.literal(method),
      params: c.object,
    });
    const decoded = codec.decode(source);
    if (!decoded.ok) return;
    void load(decoded.value, false).catch((error: unknown) => {
      setUnexpected({ error });
    });
  };
  const value =
    state.kind === "ready"
      ? state.value
      : state.kind === "loading" || state.kind === "failed" || state.kind === "unexpected_error"
        ? state.previous
        : undefined;
  const hasNext =
    value?.pagination !== null &&
    value?.pagination !== undefined &&
    c.object.decode(jsonField(value.pagination, "next_request")).ok;
  if (unexpected !== null) throw unexpected.error;
  if (state.kind === "unexpected_error") throw state.error;
  return { state, value, refresh, next, hasNext };
}
export const scopeParams = (workspace: string | null) =>
  workspace === null ? d.jsonObject([]) : d.jsonObject([["workspace_id", d.jsonString(workspace)]]);
