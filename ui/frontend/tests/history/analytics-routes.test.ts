import { describe, expect, it } from "vitest";
import { parseJsonText, type JsonValue } from "../../src/core/json";
import * as c from "../../src/core/protocol/codec";
import * as d from "../../src/core/protocol/decoders";
import { parseRoute, routeHref } from "../../src/app/navigation";
import { searchPage } from "../../src/features/history/analytics/codecs";
import { searchRoute, sessionSummary } from "../../src/features/history/analytics/model";
import {
  historyCapture,
  sessionRecord,
  eventRecord,
} from "../../src/features/history/transcript/codecs";
import type { HistoryState } from "../../src/features/history/transcript/types";
import { projectCapturedPayload } from "../../src/features/history/formats/registry";
import type { ProjectionResult } from "../../src/features/history/formats/types";
import { result } from "./formats/fixtures";
import { nativeResponses } from "./analytics-native-fixtures";
function json(x: unknown): JsonValue {
  const v = parseJsonText(JSON.stringify(x));
  if (!v.ok) throw new Error(v.error.message);
  return v.value.value;
}
function decode<T>(codec: c.Codec<T>, x: unknown): T {
  const v = codec.decode(json(x));
  if (!v.ok) throw new Error(v.issue.expected);
  return v.value;
}
const first = nativeResponses.find((v) => v.label === "search-first");
if (first === undefined) throw new Error("fixture");
const capture = decode(historyCapture, first.response.meta.history_capture),
  page = decode(searchPage, first.response.data),
  scope = {
    connectionId: decode(d.identifier, "local"),
    generation: decode(d.decimal, "1"),
    workspaceId: decode(d.identifier, "demo"),
  };
describe("search exact navigation", () => {
  it("jumps to the hit's generation/head/session/sequence rather than current actor or profile", () => {
    const hit = page.items[0];
    if (hit === undefined) throw new Error("hit");
    const target = {
      scope,
      capture,
      data: page,
      query: {
        text: "needle",
        sessionId: "",
        kinds: [],
        capture: { kind: "current" as const },
        limit: "25",
        maxBytes: "1048576",
      },
    };
    const route = searchRoute(
      {
        view: "history",
        connectionId: "other",
        workspaceId: "other",
        projectId: null,
        entityId: null,
      },
      target,
      hit,
    );
    expect(route.connectionId).toBe("local");
    expect(route.history).toEqual({
      generation: "1",
      head: capture.head,
      sequence: hit.event_ref.sequence,
    });
    const parsed = parseRoute(routeHref(route));
    expect(parsed.ok && parsed.route).toEqual(route);
    expect(() =>
      searchRoute(route, target, {
        ...hit,
        event_ref: { ...hit.event_ref, sequence: decode(d.decimal, "999") },
      }),
    ).toThrow(/not part/u);
  });
  it("an explicit empty capture has no fabricated hit/event one", () => {
    const parsed = parseRoute(
      "#/history?connection=local&workspace=demo&entity=empty&generation=1&head=empty",
    );
    expect(parsed.ok && parsed.route.history).toEqual({ generation: "1", head: null });
    expect(
      parseRoute(
        "#/history?connection=local&workspace=demo&entity=empty&generation=1&head=empty&event=1",
      ).ok,
    ).toBe(false);
  });
});
function history(): HistoryState {
  const session = decode(sessionRecord, {
    workspace_id: "demo",
    session_id: "a-history",
    title: "Supplied summary",
    actor_id: "original",
    run_id: "shared-run",
    parent_event: null,
    scopes: [],
    archived: false,
    created_at_unix_ms: null,
    last_event_at_unix_ms: null,
  });
  const event = (sequence: string) =>
    decode(eventRecord, {
      event_ref: { session_id: "a-history", sequence },
      identity_hash: "a".repeat(64),
      actor_id: "original",
      run_id: "shared-run",
      event: {
        client_id: `source-${sequence}`,
        role: "assistant",
        kind: "result",
        phase: "recorded",
        correlation: null,
        provenance: null,
        payload: { kind: "blob", blob: { digest: "b".repeat(64), size_bytes: "1048576" } },
        searchable_text: null,
        resource_versions: [],
        attachments: [],
      },
    });
  const one = event("1"),
    two = event("2"),
    projections = new Map<string, ProjectionResult>();
  for (const e of [one, two]) {
    const key = `a-history/${e.event_ref.sequence}/payload`,
      bytes = new TextEncoder().encode(
        JSON.stringify({
          ...result,
          uuid: `00000000-0000-4000-8000-00000000000${e.event_ref.sequence}`,
        }),
      );
    projections.set(
      key,
      projectCapturedPayload(
        {
          captureId: `${JSON.stringify([scope.connectionId, scope.generation, scope.workspaceId])}/${capture.head}/${key}`,
          scopeId: [scope.connectionId, scope.generation, scope.workspaceId, "a-history"],
          metadata: d.jsonNull(),
          bytes,
          completeness: "complete",
          producer: null,
        },
        "auto",
      ),
    );
  }
  return {
    scope,
    historicalGeneration: false,
    query: { order: "session_id", includeArchived: false, runId: "" },
    directory: { kind: "idle" },
    session: {
      kind: "ready",
      key: "session",
      value: { capture, data: { session, through: decode(d.decimal, "35") } },
    },
    window: {
      kind: "ready",
      key: "window",
      value: {
        capture,
        data: {
          session_id: session.session_id,
          through: decode(d.decimal, "35"),
          items: [one, two],
          has_more: true,
          next_anchor: decode(d.decimal, "2"),
          omitted_for_budget: decode(d.decimal, "0"),
        },
      },
    },
    payloadBatch: { kind: "idle" },
    payloads: new Map([
      [
        "a-history/1/payload",
        {
          event: one.event_ref,
          part: { kind: "payload" },
          blob: one.event.payload.blob,
          bytes: new Uint8Array(32768),
          nextOffset: decode(d.decimal, "32768"),
          complete: false,
          verified: false,
        },
      ],
    ]),
    projections,
    projecting: false,
    payloadFailure: null,
    expanding: false,
    selectedPart: null,
    followLatest: true,
    loadingMore: false,
    readingEvents: false,
    format: "auto",
    draft: null,
    transfer: { kind: "idle" },
    unexpected: null,
  };
}
describe("supplied session summary", () => {
  it("labels declared referenced bytes independently of loaded partial prefixes and full-session extent", () => {
    const value = sessionSummary(history());
    expect(value?.declaredPayloadBytes).toBe(2097152n);
    expect(value?.loadedEvents).toBe(2);
    expect(value?.through).toBe("35");
    expect(value?.originatingRunId).toBe("shared-run");
  });
  it("retains independent SDK result metrics and overlapping cumulative reports without summing", () => {
    const summary = sessionSummary(history());
    expect(summary?.reports).toHaveLength(2);
    const inputs = summary?.reports.flatMap((v) =>
      v.metrics.filter((m) => m.name === "input_tokens"),
    );
    expect(inputs?.map((v) => v.lexeme)).toEqual(["12", "12"]);
    expect(
      inputs?.every(
        (v) =>
          v.scope.kind === "sdk-result" &&
          v.coverage === "reported-main-agent-only-usage-per-turn-in-streaming",
      ),
    ).toBe(true);
    const costs = summary?.reports.flatMap((v) =>
      v.metrics.filter((m) => m.name === "estimated_cost_usd"),
    );
    expect(
      costs?.every(
        (v) =>
          v.scope.kind === "sdk-query-pipeline" &&
          v.scope.queryId === null &&
          v.snapshotKey === null,
      ),
    ).toBe(true);
  });
  it("never admits stale-head, partial, unrecognized or wrong-endpoint report projections", () => {
    const state = history(),
      projections = new Map(state.projections);
    for (const [key, value] of projections)
      projections.set(key, {
        ...value,
        capture: {
          ...value.capture,
          captureId: value.capture.captureId.replace(capture.head ?? "", "f".repeat(64)),
        },
      });
    expect(sessionSummary({ ...state, projections })?.reports).toHaveLength(0);
    expect(
      sessionSummary({ ...state, scope: { ...scope, generation: decode(d.decimal, "2") } })
        ?.reports,
    ).toHaveLength(0);
    expect(sessionSummary({ ...state, window: { kind: "idle" } })?.reports).toHaveLength(0);
  });
});
