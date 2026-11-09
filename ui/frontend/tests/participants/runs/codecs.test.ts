import { describe, expect, it } from "vitest";
import * as c from "../../../src/core/protocol/codec";
import * as d from "../../../src/core/protocol/decoders";
import {
  actorCodec,
  attemptCodec,
  decimal64,
  participantCodec,
  runCodec,
  sessionPageCodec,
  signalSummary,
} from "../../../src/features/participants/runs/codecs";
import {
  decodeDetail,
  decodePage,
  decodeSessions,
  invocation,
} from "../../../src/features/participants/runs/client";
import { actor, attempt, decode, json, next, response, run, target } from "./fixtures";

describe("Participants native record invariants", () => {
  it("summarizes coordinator source/metadata and actor records without substituting identities", () => {
    expect(
      signalSummary(
        json({
          kind: "unobserved_run",
          source: { run_id: "child-run" },
          metadata: { run_id: "child-run", status: "running" },
        }),
      ),
    ).toBe("child-run · running");
    expect(
      signalSummary(
        json({
          kind: "claim",
          ticket_id: "design",
          ownership: { run_id: "not-a-top-level-owner" },
        }),
      ),
    ).toBe("design");
  });
  it("preserves full int64 observations and counters without numeric conversion", () => {
    expect(decode(runCodec, run).last_observed_unix_ms).toBe("9223372036854775807");
    expect(decode(attemptCodec, attempt).revision).toBe("9007199254740993");
    for (const n of ["9223372036854775808", "-1", "01", "1e3", "1\n"])
      expect(decimal64.decode(d.jsonString(n)).ok).toBe(false);
  });
  it("distinguishes retained authorship from catalog registration", () => {
    expect(
      decode(participantCodec, {
        actor_id: "author",
        registration: null,
        observed: { first_revision: "1", last_revision: "7" },
        sources: ["activity", "run"],
      }).registration,
    ).toBeNull();
    for (const sources of [
      [],
      ["run"],
      ["activity", "activity"],
      ["run", "activity"],
      ["catalog", "activity"],
    ])
      expect(
        participantCodec.decode(
          json({
            actor_id: "author",
            registration: null,
            observed: { first_revision: "1", last_revision: "7" },
            sources,
          }),
        ).ok,
      ).toBe(false);
    expect(
      participantCodec.decode(
        json({
          actor_id: "author",
          registration: { ...actor, actor_id: "another" },
          observed: null,
          sources: ["catalog"],
        }),
      ).ok,
    ).toBe(false);
  });
  it("rejects invalid durable run/attempt replay fields", () => {
    for (const patch of [
      { capabilities: ["build", "build"] },
      { status: "completed", evidence: " " },
      { session_ids: ["z", "a"] },
      { objective: "" },
      { session_associations: { ...run.session_associations, total: "2" } },
    ])
      expect(runCodec.decode(json({ ...run, ...patch })).ok).toBe(false);
    expect(attemptCodec.decode(json({ ...attempt, state: "failed", evidence: "" })).ok).toBe(false);
    expect(
      attemptCodec.decode(
        json({
          ...attempt,
          checkpoints: [{ kind: "resource", resource_id: "proof", revision: "0" }],
        }),
      ).ok,
    ).toBe(false);
    expect(actorCodec.decode(json({ ...actor, name: " " })).ok).toBe(false);
  });
  it("retains exact omitted session continuation and rejects changed identity/head/revision", () => {
    const value = {
      ...run,
      session_associations: {
        ...run.session_associations,
        total: "101",
        omitted: "100",
        next_request: next,
      },
    };
    expect(runCodec.decode(json(value)).ok).toBe(true);
    for (const params of [
      { target_run_id: "other" },
      { expected_run_revision: "1" },
      { head: "a".repeat(64) },
      { after_session_id: "old" },
      { limit: "101" },
    ])
      expect(
        runCodec.decode(
          json({
            ...value,
            session_associations: {
              ...value.session_associations,
              next_request: { ...next, params: { ...next.params, ...params } },
            },
          }),
        ).ok,
      ).toBe(false);
  });
});
describe("captured participant pages", () => {
  it("derives run continuation with both coordination revision and exact empty head", () => {
    const request = invocation(target, "run.list", [["offset", d.jsonString("0")]]),
      result = decodePage(
        target,
        request,
        response(
          { items: [run], next_offset: "1", omitted: "1" },
          {
            query_scope: "runs",
            query_revision: "9007199254740993",
            history_capture: { head: null },
          },
        ),
      );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected page");
    expect(result.data.historyHead).toBeNull();
    expect(result.data.continuation?.method).toBe("run.list");
    expect(result.data.continuation?.params).toEqual(
      json({
        workspace_id: "workspace",
        offset: "1",
        expected_revision: "9007199254740993",
        head: null,
      }),
    );
    expect(result.data.response.response.data).toEqual(
      json({ items: [run], next_offset: "1", omitted: "1" }),
    );
  });
  it("does not trust daemon pagination method/target injection", () => {
    const request = invocation(target, "actor.list"),
      r = {
        ...response(
          { items: [actor], next_offset: "1", offset: "0", remaining: "1" },
          { workspace_revision: "7" },
        ),
        pagination: decode(c.object, {
          next_request: { method: "daemon.shutdown", params: { workspace_id: "other" } },
        }),
      };
    const result = decodePage(target, request, r);
    expect(result.ok && result.data.continuation?.method).toBe("actor.list");
  });
  it("rejects stale namespace guards, wrong offset progress and cross-run filters", () => {
    expect(
      decodePage(
        target,
        invocation(target, "actor.list", [["at_revision", d.jsonString("6")]]),
        response({ items: [actor], next_offset: null }, { workspace_revision: "7" }),
      ).ok,
    ).toBe(false);
    expect(
      decodePage(
        target,
        invocation(target, "run.list"),
        response(
          { items: [run], next_offset: "99" },
          { query_scope: "runs", query_revision: "7", history_capture: { head: null } },
        ),
      ).ok,
    ).toBe(false);
    expect(
      decodePage(
        target,
        invocation(target, "attempt.list", [["target_run_id", d.jsonString("other")]]),
        response({ items: [attempt], next_offset: null }),
      ).ok,
    ).toBe(false);
    expect(
      decodeDetail(
        target,
        "run.get",
        "other",
        response(run, { query_scope: "runs", history_capture: { head: null } }),
      ).ok,
    ).toBe(false);
  });
  it("accepts policy-only budgets with full int64 reported limits", () => {
    const request = invocation(target, "run.budget_get", [["target_run_id", d.jsonString("run")]]),
      data = {
        target_run_id: "run",
        revision: "1",
        max_attempts: null,
        max_active_attempts: null,
        reported_token_limit: "9223372036854775807",
        reported_elapsed_ms_limit: null,
      };
    expect(
      decodePage(target, request, response(data, { query_scope: "policy", query_revision: "5" }))
        .ok,
    ).toBe(true);
    expect(decodePage(target, request, response(data)).ok).toBe(false);
  });
  it("validates advisory heartbeat durability rather than implying process liveness", () => {
    const request = invocation(target, "run.heartbeat_get", [
        ["target_run_id", d.jsonString("run")],
      ]),
      data = {
        target_run_id: "run",
        observation: { actor_id: "author", observed_unix_ms: "20" },
        persisted: { actor_id: "author", observed_unix_ms: "10" },
        durable: false,
        advisory: true,
      };
    expect(decodePage(target, request, response(data, {})).ok).toBe(true);
    for (const patch of [
      { durable: true },
      { advisory: false },
      { persisted: { actor_id: "other", observed_unix_ms: "10" } },
      { persisted: { actor_id: "author", observed_unix_ms: "30" } },
    ])
      expect(decodePage(target, request, response({ ...data, ...patch }, {})).ok).toBe(false);
  });
  it("preserves opaque overview cursor and rejects cursor replay", () => {
    const request = invocation(target, "actor.overview"),
      result = decodePage(
        target,
        request,
        response(
          {
            items: [],
            cursor: "opaque-capture",
            has_more: true,
            needs_larger_budget: false,
            required_bytes: null,
          },
          { workspace_revision: "7" },
        ),
      );
    expect(result.ok && result.data.continuation?.params).toEqual(
      json({ workspace_id: "workspace", cursor: "opaque-capture" }),
    );
    expect(
      decodePage(
        target,
        invocation(target, "actor.overview", [["cursor", d.jsonString("opaque-capture")]]),
        response(
          {
            items: [],
            cursor: "opaque-capture",
            has_more: true,
            needs_larger_budget: false,
            required_bytes: null,
          },
          { workspace_revision: "7" },
        ),
      ).ok,
    ).toBe(false);
  });
  it("validates every paged session association against the original run/head/revision", () => {
    const page = {
        run_id: "run",
        run_revision: run.revision,
        history_head: null,
        session_ids: ["session-02"],
        total: "101",
        remaining: "99",
        next_after_session_id: "session-02",
        next_request: { ...next, params: { ...next.params, after_session_id: "session-02" } },
        has_more: true,
      },
      request = invocation(
        target,
        "run.sessions",
        Object.entries(next.params)
          .filter(([key]) => key !== "workspace_id")
          .map(([key, value]) => [key, value === null ? d.jsonNull() : d.jsonString(value)]),
      );
    expect(sessionPageCodec.decode(json(page)).ok).toBe(true);
    expect(
      decodeSessions(
        target,
        request,
        response(page, { workspace_revision: "1", history_capture: { head: null } }),
      ).ok,
    ).toBe(true);
    for (const patch of [
      { run_id: "other" },
      { run_revision: "1" },
      { session_ids: ["session-01"] },
      { history_head: "a".repeat(64) },
    ])
      expect(
        decodeSessions(
          target,
          request,
          response(
            { ...page, ...patch },
            { workspace_revision: "1", history_capture: { head: null } },
          ),
        ).ok,
      ).toBe(false);
  });
  it("keeps no-progress and incomplete catalog pages explicit, with bounded exact retries", () => {
    const request = invocation(target, "actor.list", [
        ["offset", d.jsonString("0")],
        ["max_bytes", d.jsonString("4096")],
      ]),
      result = decodePage(
        target,
        request,
        response(
          { items: [], offset: "0", remaining: "2", next_offset: "0" },
          { workspace_revision: "7" },
        ),
      );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected partial capture");
    expect(result.data.completeness).toBe("partial");
    expect(result.data.continuation).toBeNull();
    expect(result.data.stopReason).toContain("no progress");
    expect(result.data.retry?.params).toEqual(
      json({ workspace_id: "workspace", offset: "0", max_bytes: "8192", at_revision: "7" }),
    );
    const missing = decodePage(
      target,
      request,
      response(
        { items: [], offset: "0", remaining: "2", next_offset: null },
        { workspace_revision: "7" },
      ),
    );
    expect(missing.ok && missing.data.completeness).toBe("partial");
    const omitted = decodePage(
      target,
      request,
      response(
        { items: [], offset: "0", remaining: "0", next_offset: null },
        {
          workspace_revision: "7",
          budget: {
            omitted_items: "1",
            omitted_fields: "0",
            truncated: true,
            details_complete: true,
          },
        },
      ),
    );
    expect(omitted.ok && omitted.data.completeness).toBe("partial");
  });
  it("rejects a run record carrying a different association head from its collection", () => {
    expect(
      decodePage(
        target,
        invocation(target, "run.list"),
        response(
          { items: [run], next_offset: null, omitted: "0" },
          { query_scope: "runs", query_revision: "7", history_capture: { head: "a".repeat(64) } },
        ),
      ).ok,
    ).toBe(false);
  });
  it("retries an oversized overview row only through its exact captured cursor", () => {
    const result = decodePage(
      target,
      invocation(target, "actor.overview", [
        ["actor_id", d.jsonString("author")],
        ["max_bytes", d.jsonString("4096")],
      ]),
      response(
        {
          items: [],
          cursor: "captured-before-row",
          has_more: true,
          needs_larger_budget: true,
          required_bytes: "5000",
        },
        { workspace_revision: "7" },
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected overview capture");
    expect(result.data.completeness).toBe("partial");
    expect(result.data.continuation).toBeNull();
    expect(result.data.retry?.params).toEqual(
      json({
        workspace_id: "workspace",
        actor_id: "author",
        max_bytes: "8192",
        cursor: "captured-before-row",
      }),
    );
  });
  it("keeps valid advancing traversal callable even when content fields are partial", () => {
    const request = invocation(target, "actor.list", [
        ["offset", d.jsonString("0")],
        ["max_bytes", d.jsonString("1048576")],
      ]),
      result = decodePage(
        target,
        request,
        response(
          { items: [actor], offset: "0", remaining: "1", next_offset: "1" },
          {
            workspace_revision: "7",
            budget: {
              omitted_items: "0",
              omitted_fields: "1",
              truncated: true,
              details_complete: true,
            },
          },
        ),
      );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected partial page");
    expect(result.data.completeness).toBe("partial");
    expect(result.data.continuation).not.toBeNull();
    expect(result.data.retry).toBeNull();
  });
});
