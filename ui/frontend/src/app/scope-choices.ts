import { useEffect, useState, useSyncExternalStore } from "react";
import { createCompanion } from "../core/protocol/client";
import { identifier, jsonObject, jsonString } from "../core/protocol/decoders";
import type { HttpClient, HttpResult } from "../core/protocol/http";
import type { ConnectionProfile } from "../core/protocol/types";
import { createReadSlot } from "../core/state/read-slot";
import { entityPage, ProjectionError } from "../features/connections/model";
import { readReferenceChoices } from "../features/discussions/reference-choices";

export interface ScopeChoice {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
}
export interface ScopeChoices {
  readonly items: readonly ScopeChoice[];
  readonly partial: boolean;
}
/** Browse only. The selected IDs are verified by their destination, not by membership here. */
export async function readScopeChoices(
  client: HttpClient,
  connection: ConnectionProfile,
  workspace: string | null,
  signal: AbortSignal,
): Promise<HttpResult<ScopeChoices>> {
  if (workspace !== null) {
    const id = identifier.decode(jsonString(workspace));
    if (!id.ok)
      return {
        ok: false,
        failure: {
          kind: "protocol",
          issue: undefined,
          message: "Enter a valid workspace ID to browse its projects.",
        },
      };
    const result = await readReferenceChoices(
      client,
      { connection, workspaceId: id.value, projectId: null },
      "project",
      signal,
    );
    return result.ok ? { ...result, data: { items: result.data, partial: false } } : result;
  }
  const result = await createCompanion(client).read(
    {
      connection_id: connection.id,
      generation: connection.generation,
      method: "workspace.list",
      params: jsonObject([]),
      lane: "visible",
    },
    signal,
  );
  if (!result.ok) return result;
  try {
    const page = entityPage("workspace", result.data);
    return {
      ...result,
      data: {
        partial: page.partial,
        items: page.rows.map((row) => ({
          id: row.id,
          title: row.title,
          detail: [
            row.open === true ? "Open" : row.open === false ? "Closed" : "Registered",
            ...(row.archived === true ? ["Archived"] : []),
          ].join(" · "),
        })),
      },
    };
  } catch (error) {
    if (!(error instanceof ProjectionError)) throw error;
    return {
      ok: false,
      failure: {
        kind: "protocol",
        issue: undefined,
        message: "Workspace choices could not be read. Retry or enter an exact ID.",
      },
    };
  }
}

/** Each selection owns its read; old workspace results cannot populate new choices. */
export function useScopeChoices(
  client: HttpClient,
  connection: ConnectionProfile | undefined,
  workspace: string | null,
  enabled = true,
) {
  const [slot] = useState(() => createReadSlot<ScopeChoices>());
  const state = useSyncExternalStore(slot.subscribe, slot.get);
  const key = JSON.stringify([
    connection?.id,
    connection?.generation,
    connection?.socket,
    workspace,
  ]);
  const load = () => {
    if (!connection || !enabled) return;
    void slot
      .load(key, (signal) => readScopeChoices(client, connection, workspace, signal))
      .catch(() => {
        // Unexpected exceptions are retained by the slot and thrown to the owning boundary.
      });
  };
  useEffect(() => {
    load();
    return () => slot.clear();
    // The key includes endpoint generation/socket and workspace; the slot owns cancellation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot, key, client, enabled]);
  if (state.kind === "unexpected_error") throw state.error;
  const current =
    enabled && connection && state.kind !== "idle" && state.key === key ? state : undefined;
  return {
    state: current,
    data: current?.kind === "ready" ? current.value : current?.previous,
    refresh: load,
  };
}
