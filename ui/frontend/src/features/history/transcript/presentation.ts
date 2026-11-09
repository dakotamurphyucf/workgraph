import { jsonField } from "../../../core/json";
import type { ProjectionResult, ProjectedItem } from "../formats";
import type { EventRecord } from "./types";
import { partKey } from "./controller";
export interface ToolPair {
  readonly callEvent: EventRecord;
  readonly call: Extract<ProjectedItem, { kind: "tool-call" }>;
  readonly resultEvent: EventRecord;
  readonly result: Extract<ProjectedItem, { kind: "tool-result" }>;
}
/** Only exact unique source call IDs AND explicit equal Workgraph correlation pair across events. */
export function toolPairs(
  events: readonly EventRecord[],
  projections: ReadonlyMap<string, ProjectionResult>,
): readonly ToolPair[] {
  const calls = new Map<
      string,
      { event: EventRecord; item: Extract<ProjectedItem, { kind: "tool-call" }> }[]
    >(),
    results = new Map<
      string,
      { event: EventRecord; item: Extract<ProjectedItem, { kind: "tool-result" }> }[]
    >();
  for (const event of events) {
    const projection = projections.get(partKey(event.event_ref, { kind: "payload" }));
    if (projection?.status !== "recognized" || event.event.correlation === null) continue;
    const sdkSession =
      projection.adapter.id === "claude.agent-sdk.message.v1" && projection.document?.ok === true
        ? jsonField(projection.document.value.value, "session_id")
        : null;
    if (projection.adapter.id === "claude.agent-sdk.message.v1" && sdkSession?.kind !== "string")
      continue;
    for (const item of projection.projection.items) {
      if (item.kind !== "tool-call" && item.kind !== "tool-result") continue;
      if (item.callId === null) continue;
      const key = JSON.stringify([
        event.event_ref.session_id,
        projection.adapter.id,
        sdkSession?.kind === "string" ? sdkSession.value : null,
        event.event.correlation,
        item.callId,
      ]);
      if (item.kind === "tool-call") calls.set(key, [...(calls.get(key) ?? []), { event, item }]);
      else results.set(key, [...(results.get(key) ?? []), { event, item }]);
    }
  }
  const pairs: ToolPair[] = [];
  for (const [key, call] of calls) {
    const result = results.get(key);
    if (call.length === 1 && result?.length === 1)
      pairs.push({
        callEvent: call[0]!.event,
        call: call[0]!.item,
        resultEvent: result[0]!.event,
        result: result[0]!.item,
      });
  }
  return pairs;
}
/** Exact text equality within the same validated adapter/capture only; no fuzzy/adjacency dedup. */
export function duplicateReportedText(
  items: readonly ProjectedItem[],
): ReadonlyMap<number, number> {
  const result = new Map<number, number>();
  for (const [index, item] of items.entries()) {
    if (item.kind !== "text" || item.interpretation !== "reported-result") continue;
    const original = items.findIndex(
      (candidate, prior) =>
        prior < index &&
        candidate.kind === "text" &&
        candidate.text === item.text &&
        candidate.interpretation === "message",
    );
    if (original >= 0) result.set(index, original);
  }
  return result;
}

/** Exact SDK final-text duplicates within one documented source session, never mere adjacency. */
export function reportedDuplicates(
  events: readonly EventRecord[],
  projections: ReadonlyMap<string, ProjectionResult>,
): ReadonlyMap<string, ReadonlyMap<number, string>> {
  const originals = new Map<string, string>(),
    duplicates = new Map<string, ReadonlyMap<number, string>>();
  for (const event of events) {
    const projected = projections.get(partKey(event.event_ref, { kind: "payload" }));
    if (
      projected?.status !== "recognized" ||
      projected.adapter.id !== "claude.agent-sdk.message.v1" ||
      projected.document?.ok !== true
    )
      continue;
    const sourceSession = jsonField(projected.document.value.value, "session_id");
    if (sourceSession?.kind !== "string") continue;
    const repeated = new Map<number, string>();
    for (const [index, item] of projected.projection.items.entries()) {
      if (item.kind !== "text") continue;
      const key = JSON.stringify([
        event.event_ref.session_id,
        projected.adapter.id,
        sourceSession.value,
        item.text,
      ]);
      if (item.interpretation === "message") originals.set(key, event.event_ref.sequence);
      if (item.interpretation === "reported-result") {
        const original = originals.get(key);
        if (original !== undefined) repeated.set(index, original);
      }
    }
    if (repeated.size > 0) duplicates.set(event.event_ref.sequence, repeated);
  }
  return duplicates;
}

/** Conversation grouping for recognized source formats. Exact unique call IDs
 * are scoped to the Workgraph session, source adapter/session/branch and run.
 * Arbitrary imported formats still require explicit correlation. Ambiguous IDs
 * or reversed results stay separate, never paired by proximity. */
export function conversationToolPairs(
  events: readonly EventRecord[],
  projections: ReadonlyMap<string, ProjectionResult>,
): readonly ToolPair[] {
  const entries = new Map<
    string,
    {
      calls: { event: EventRecord; item: ToolPair["call"] }[];
      results: { event: EventRecord; item: ToolPair["result"] }[];
    }
  >();
  for (const event of events) {
    const projection = projections.get(partKey(event.event_ref, { kind: "payload" }));
    if (projection?.status !== "recognized") continue;
    const format = projection.adapter.id;
    const sourceKnown = [
      "codex.rollout-jsonl.7cdb219.v1",
      "claude.code.transcript.v1",
      "claude.agent-sdk.message.v1",
      "conversation.item.v1",
    ].includes(format);
    if (!sourceKnown && event.event.correlation === null) continue;
    const root = projection.document?.ok ? projection.document.value.value : null;
    const sourceSession = root
      ? (jsonField(root, "sessionId") ?? jsonField(root, "session_id"))
      : null;
    const branch = root ? jsonField(root, "isSidechain") : null;
    const agent = root ? jsonField(root, "agentId") : null;
    // Sidechains without a recorded agent identity cannot be safely merged.
    if (branch?.kind === "boolean" && branch.value && agent?.kind !== "string") continue;
    for (const item of projection.projection.items) {
      if ((item.kind !== "tool-call" && item.kind !== "tool-result") || item.callId === null)
        continue;
      const sourceType = jsonField(item.raw, "type");
      const type = sourceType?.kind === "string" ? sourceType.value : "unknown";
      const family = ["tool_use", "tool_result"].includes(type)
        ? "anthropic"
        : ["custom_tool_call", "custom_tool_call_output"].includes(type)
          ? "custom"
          : ["function_call", "function_call_output"].includes(type)
            ? "function"
            : "unknown";
      const key = JSON.stringify([
        event.event_ref.session_id,
        format,
        family,
        sourceSession?.kind === "string" ? sourceSession.value : null,
        agent?.kind === "string" ? agent.value : null,
        event.run_id,
        sourceKnown ? null : event.event.correlation,
        item.callId,
      ]);
      let entry = entries.get(key);
      if (!entry) {
        entry = { calls: [], results: [] };
        entries.set(key, entry);
      }
      if (item.kind === "tool-call") entry.calls.push({ event, item });
      else entry.results.push({ event, item });
    }
  }
  const pairs: ToolPair[] = [];
  for (const { calls, results } of entries.values()) {
    const call = calls[0],
      result = results[0];
    if (calls.length !== 1 || results.length !== 1 || !call || !result) continue;
    if (BigInt(result.event.event_ref.sequence) < BigInt(call.event.event_ref.sequence)) continue;
    if (call.event === result.event) {
      const projection = projections.get(partKey(call.event.event_ref, { kind: "payload" }));
      if (
        projection?.status !== "recognized" ||
        projection.projection.items.indexOf(call.item) >=
          projection.projection.items.indexOf(result.item)
      )
        continue;
    }
    if (
      call.event.event.correlation !== null &&
      result.event.event.correlation !== null &&
      call.event.event.correlation !== result.event.event.correlation
    )
      continue;
    pairs.push({
      callEvent: call.event,
      call: call.item,
      resultEvent: result.event,
      result: result.item,
    });
  }
  return pairs;
}
