import { useMemo, useState } from "react";
import { jsonField, parseJsonText } from "../core/json";
import type { ConnectionProfile } from "../core/protocol/types";
import type { WriterSelection } from "./types";
import { validIdentifier } from "./navigation";

export function selectionKey(
  connection: ConnectionProfile | undefined,
  workspaceId: string | null,
): string {
  return JSON.stringify([
    connection?.id ?? null,
    connection?.socket ?? null,
    connection?.generation ?? null,
    workspaceId,
  ]);
}
function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    if (error instanceof DOMException) return null;
    throw error;
  }
}
export function decodeWriter(source: string | null): WriterSelection {
  const empty = { actorId: null, runId: null };
  if (!source || source.length > 1024) return empty;
  const decoded = parseJsonText(source);
  if (!decoded.ok) return empty;
  const actor = jsonField(decoded.value.value, "actorId"),
    run = jsonField(decoded.value.value, "runId");
  if (!actor || !run) return empty;
  if (actor.kind !== "null" && (actor.kind !== "string" || !validIdentifier(actor.value)))
    return empty;
  if (run.kind !== "null" && (run.kind !== "string" || !validIdentifier(run.value))) return empty;
  return {
    actorId: actor.kind === "string" ? actor.value : null,
    runId: run.kind === "string" ? run.value : null,
  };
}
export function decodePins(source: string | null): readonly string[] {
  if (!source || source.length > 1048576) return [];
  const decoded = parseJsonText(source);
  if (!decoded.ok || decoded.value.value.kind !== "array") return [];
  const ids: string[] = [];
  for (const item of decoded.value.value.items) {
    if (item.kind !== "string" || !validIdentifier(item.value)) return [];
    if (!ids.includes(item.value)) ids.push(item.value);
  }
  return ids;
}
/** Browser preferences only. Scope changes never carry one workspace's identity into another. */
function useLocalSelection<T>(key: string, decode: (source: string | null) => T) {
  const initial = useMemo(() => decode(stored(key)), [key, decode]);
  const [session, setSession] = useState<ReadonlyMap<string, T>>(() => new Map());
  const [unavailable, setUnavailable] = useState(false);
  const value = session.get(key) ?? initial;
  const set = (next: T) => {
    setSession((previous) => new Map(previous).set(key, next));
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setUnavailable(false);
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      setUnavailable(true);
    }
  };
  return { value, set, unavailable };
}
export function useRememberedWriter(scope: string) {
  return useLocalSelection(`workgraph.ui.writer.1:${scope}`, decodeWriter);
}
export function useProjectPins(scope: string) {
  return useLocalSelection(`workgraph.ui.pins.1:${scope}`, decodePins);
}
