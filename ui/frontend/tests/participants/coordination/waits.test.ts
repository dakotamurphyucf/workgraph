import { describe, expect, it } from "vitest";
import {
  waitJob,
  waitPage,
  createWaitClient,
} from "../../../src/features/participants/coordination/waits";
import { createTestProcessor } from "../../core/processing-harness";
import type { HttpClient, HttpRequest, HttpResult } from "../../../src/core/protocol/http";
import { decode, json, target } from "../runs/fixtures";
import * as d from "../../../src/core/protocol/decoders";
const preparation = {
  intention_id: "wait",
  connection: target.connection,
  context: {
    workspace_id: "workspace",
    project_id: null,
    writer: { actor_id: "author", run_id: "run" },
  },
  method: "reservation.acquire",
  params: {
    workspace_id: "workspace",
    actor_id: "author",
    run_id: "run",
    target_run_id: "run",
    requests: [{ reservation_id: "compiler", mode: "exclusive" }],
  },
};
const base = {
  id: "wait",
  input_hash: "a".repeat(64),
  preparation,
  limits: { timeout_ms: "1000", max_attempts: "2", wait_slice_ms: "5" },
  revision: "1",
  cancel_requested: false,
  state: { kind: "prepared_unsent" },
  diagnostic: null,
};
const stopped = {
  data: {
    daemon_response: null,
    wait: {
      completed: false,
      stop: "canceled",
      attempt_count: "0",
      journals: [],
      last_conflict: null,
      problem: null,
      feed_response: null,
      saved_request: "/tmp/journal",
      retry_request: null,
    },
  },
  meta: {},
};
describe("saved wait protocol and path identity", () => {
  it("admits only bounded acquisition jobs with matching original identity", () => {
    expect(waitJob.decode(json(base)).ok).toBe(true);
    for (const changed of [
      { id: "other" },
      { preparation: { ...preparation, method: "ticket.finish" } },
      { limits: { ...base.limits, timeout_ms: "999" } },
      { limits: { ...base.limits, max_attempts: "101" } },
      { limits: { ...base.limits, wait_slice_ms: "25001" } },
      { state: { kind: "guessed_complete" } },
    ])
      expect(waitJob.decode(json({ ...base, ...changed })).ok).toBe(false);
  });
  it("keeps stop separate from acquired and rejects invented stop/journal outcomes", () => {
    expect(waitJob.decode(json({ ...base, state: { kind: "stopped", outcome: stopped } })).ok).toBe(
      true,
    );
    expect(
      waitJob.decode(json({ ...base, state: { kind: "completed", outcome: stopped } })).ok,
    ).toBe(false);
    for (const stop of ["unrecognized", "uncertain", "acquired"])
      expect(
        waitJob.decode(
          json({
            ...base,
            state: {
              kind: "stopped",
              outcome: {
                ...stopped,
                data: { ...stopped.data, wait: { ...stopped.data.wait, stop } },
              },
            },
          }),
        ).ok,
      ).toBe(false);
    const journal = { mutation_id: "one", saved_request: "/tmp/one", started: true };
    expect(
      waitJob.decode(
        json({
          ...base,
          state: {
            kind: "stopped",
            outcome: {
              ...stopped,
              data: {
                ...stopped.data,
                wait: { ...stopped.data.wait, attempt_count: "2", journals: [journal, journal] },
              },
            },
          },
        }),
      ).ok,
    ).toBe(false);
  });
  it("accepts a native deadline after saved-but-unstarted journal and rejects invented exchange counts", () => {
    const journals = [{ mutation_id: "saved", saved_request: "/tmp/saved", started: false }];
    const raw = {
      ...base,
      state: {
        kind: "stopped",
        outcome: {
          ...stopped,
          data: {
            ...stopped.data,
            wait: { ...stopped.data.wait, stop: "deadline", journals, attempt_count: "0" },
          },
        },
      },
    };
    expect(waitJob.decode(json(raw)).ok).toBe(true);
    expect(
      waitJob.decode(
        json({
          ...raw,
          state: {
            ...raw.state,
            outcome: {
              ...raw.state.outcome,
              data: {
                ...raw.state.outcome.data,
                wait: { ...raw.state.outcome.data.wait, attempt_count: "1" },
              },
            },
          },
        }),
      ).ok,
    ).toBe(false);
    expect(
      waitJob.decode(
        json({
          ...raw,
          state: {
            ...raw.state,
            outcome: {
              ...raw.state.outcome,
              data: {
                ...raw.state.outcome.data,
                wait: { ...raw.state.outcome.data.wait, stop: "canceled" },
              },
            },
          },
        }),
      ).ok,
    ).toBe(true);
  });
  it("requires a single complete job and an exact advancing page, never silently clips", () => {
    const offset = decode(d.decimal, "0"),
      codec = waitPage(offset);
    const page = { items: [base], offset: "0", remaining: "1", next_offset: "1" };
    expect(codec.decode(json(page)).ok).toBe(true);
    for (const change of [
      { items: [base, base] },
      { offset: "1" },
      { next_offset: "0" },
      { next_offset: "2" },
      { items: [] },
      { remaining: "0" },
      { next_offset: null },
      { remaining: "101" },
    ])
      expect(codec.decode(json({ ...page, ...change })).ok).toBe(false);
    expect(
      waitPage(decode(d.decimal, "1")).decode(
        json({ items: [base], offset: "1", remaining: "0", next_offset: null }),
      ).ok,
    ).toBe(true);
    expect(
      codec.decode(json({ items: [], offset: "0", remaining: "0", next_offset: null })).ok,
    ).toBe(true);
  });
  it("never accepts changed saved helper limits or endpoint returned by prepare", async () => {
    const processing = createTestProcessor();
    let changed: "none" | "limits" | "endpoint" = "none";
    const http: HttpClient = {
      processing,
      request: <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
        const raw = {
            ...base,
            preparation:
              changed === "endpoint"
                ? {
                    ...preparation,
                    connection: { ...target.connection, socket: "/tmp/wrong.sock" },
                  }
                : preparation,
            limits: { ...base.limits, timeout_ms: changed === "limits" ? "1001" : "1000" },
          },
          parsed = request.codec.decode(json(raw));
        if (!parsed.ok) throw new Error(parsed.issue.expected);
        return Promise.resolve({ ok: true, data: parsed.value, httpStatus: 200 });
      },
    };
    const source = decode(d.preparation, {
      intention_id: "wait",
      connection_id: target.connection.id,
      generation: target.connection.generation,
      context: preparation.context,
      method: preparation.method,
      params: preparation.params,
    });
    const limits = {
      timeoutMs: decode(d.positiveDecimal, "1000"),
      maxAttempts: decode(d.positiveDecimal, "2"),
      waitSliceMs: decode(d.positiveDecimal, "5"),
    };
    try {
      expect((await createWaitClient(http).prepare(source, limits, target.connection)).ok).toBe(
        true,
      );
      changed = "limits";
      const result = await createWaitClient(http).prepare(source, limits, target.connection);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.kind).toBe("protocol");
      changed = "endpoint";
      expect((await createWaitClient(http).prepare(source, limits, target.connection)).ok).toBe(
        false,
      );
    } finally {
      processing.dispose();
    }
  });
});
