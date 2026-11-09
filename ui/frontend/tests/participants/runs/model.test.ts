import { describe, expect, it } from "vitest";
import * as d from "../../../src/core/protocol/decoders";
import {
  capture,
  initialInput,
  prepareDraft,
  target as contextTarget,
} from "../../../src/features/participants/runs/model";
import type {
  ParticipantsDraft,
  ParticipantsInput,
} from "../../../src/features/participants/runs/types";
import { attempt, decode, deferred, json, response, run, target } from "./fixtures";
import { harness, ok, text } from "./harness";
const draft = (h: ReturnType<typeof harness>, input: ParticipantsInput): ParticipantsDraft => ({
  id: decode(d.identifier, "intention"),
  capture: capture(h.context, null),
  input,
  phase: { kind: "editing" },
  issue: null,
  unexpected: null,
});
const prepare = (h: ReturnType<typeof harness>, input: ParticipantsInput) =>
  prepareDraft(draft(h, input), h.api, new AbortController().signal);
describe("Participants immutable preparation and native ownership", () => {
  it("updates current-profile metadata without transplanting a retained participant socket", async () => {
    const h = harness();
    const original = {
      ...h.context,
      route: {
        ...h.context.route,
        entityId: "run",
        participant: { kind: "run" as const, generation: h.context.connection.generation },
      },
    };
    h.controller.select(original);
    await new Promise((done) => setTimeout(done, 0));
    const captured = h.controller.get();
    const count = h.calls.length;
    h.controller.select({
      ...original,
      connection: {
        ...original.connection,
        generation: decode(d.positiveDecimal, "3"),
        socket: "/tmp/replacement.sock",
      },
    });
    expect(h.controller.get().historicalGeneration).toBe(true);
    expect(h.controller.get().target).toBe(captured.target);
    expect(h.controller.get().target?.connection.socket).toBe(original.connection.socket);
    expect(h.controller.get().page).toBe(captured.page);
    expect(h.calls).toHaveLength(count);
    h.controller.select(original);
    expect(h.controller.get().historicalGeneration).toBe(false);
    expect(h.controller.get().target).toBe(captured.target);
  });

  it("registers an invocation without process launch or extra authorization checkbox", async () => {
    const h = harness(),
      input = initialInput("run.register", capture(h.context, null));
    if (input.method !== "run.register") throw new Error("Wrong input");
    const result = await prepare(h, {
      ...input,
      runId: "actual-invocation",
      objective: "Real external work",
      capabilities: "build\nverify",
      processRef: "harness:42",
    });
    expect(result.method).toBe("run.register");
    expect(result.params).toEqual(
      json({
        workspace_id: "workspace",
        actor_id: "author",
        mutation_id: "intention",
        run_id: "run",
        target_run_id: "actual-invocation",
        objective: "Real external work",
        capabilities: ["build", "verify"],
        parent_stop_policy: "continue",
        process_ref: "harness:42",
      }),
    );
    expect(h.calls).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });
  it("captures actual run revision and original writer before deferred guards", async () => {
    const waiting = deferred<ReturnType<typeof response>>(),
      h = harness({
        read: async (method) =>
          method === "run.get" ? ok(await waiting.promise) : ok(response({})),
      }),
      pending = prepare(h, {
        method: "run.transition",
        runId: "run",
        status: "waiting",
        evidence: "Awaiting review",
      });
    Reflect.set(h.context, "writer", { actorId: "another", runId: null });
    waiting.resolve(response(run, { query_scope: "runs", history_capture: { head: null } }));
    const result = await pending;
    expect(result.context.writer).toEqual({ actor_id: "author", run_id: "run" });
    expect(text(result.params, "expected_revision")).toBe(run.revision);
    expect(text(result.params, "actor_id")).toBe("author");
  });
  it("rejects same token with another claimant and uses actual ticket membership", async () => {
    const h = harness();
    const input = {
        method: "attempt.start" as const,
        runId: "run",
        ticketId: "ticket",
        attemptId: "attempt-new",
        sessionIds: "session",
      },
      good = await prepare(h, input);
    expect(text(good.params, "token")).toBe("7");
    expect(good.context.project_id).toBe("actual-project");
    const other = harness({
      read: (method, params) =>
        Promise.resolve(
          ok(
            method === "run.get"
              ? response(run, { query_scope: "runs", history_capture: { head: null } })
              : response({
                  ticket: {
                    ticket_id: text(params, "ticket_id"),
                    project_id: "actual-project",
                    claim: { actor_id: "other", run_id: "run", token: "7" },
                  },
                }),
          ),
        ),
    });
    await expect(prepare(other, input)).rejects.toThrow("actual claim");
  });
  it("rejects a different run actor or supplied run attribution", async () => {
    const h = harness({
      read: () =>
        Promise.resolve(
          ok(
            response(
              { ...run, actor_id: "other" },
              { query_scope: "runs", history_capture: { head: null } },
            ),
          ),
        ),
    });
    await expect(
      prepare(h, { method: "run.link_session", runId: "run", sessionId: "session" }),
    ).rejects.toThrow("recorded run's actor");
  });
  it("does not transplant retained-generation read IDs into current writes", () => {
    const h = harness(),
      viewed = {
        ...target,
        connection: { ...target.connection, generation: decode(d.positiveDecimal, "1") },
      };
    expect(() => capture(h.context, viewed)).toThrow("not be transplanted");
    expect(() =>
      capture(
        {
          ...h.context,
          route: {
            ...h.context.route,
            entityId: "run",
            participant: { kind: "run", generation: "1" },
          },
        },
        null,
      ),
    ).toThrow("retained endpoint");
  });
  it("never infers actor absence from an incomplete catalog", async () => {
    const h = harness({
      read: () =>
        Promise.resolve(
          ok(
            response(
              { items: [], offset: "0", remaining: "1", next_offset: null },
              { workspace_revision: "7" },
            ),
          ),
        ),
    });
    await expect(
      prepare(h, {
        method: "actor.put",
        actorId: "new",
        name: "New actor",
        actorKind: "agent",
        archived: false,
      }),
    ).rejects.toThrow("incomplete");
  });

  it("retains earlier partial-content warnings across catalog pages before proving absence", async () => {
    const h = harness({
      read: (_method, params) =>
        Promise.resolve(
          ok(
            text(params, "offset") === "1"
              ? response(
                  { items: [], offset: "1", remaining: "0", next_offset: null },
                  { workspace_revision: "7" },
                )
              : response(
                  {
                    items: [
                      {
                        actor_id: "existing",
                        name: "Existing",
                        kind: "agent",
                        revision: "1",
                        archived: false,
                      },
                    ],
                    offset: "0",
                    remaining: "1",
                    next_offset: "1",
                  },
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
          ),
        ),
    });
    await expect(
      prepare(h, {
        method: "actor.put",
        actorId: "new",
        name: "New actor",
        actorKind: "agent",
        archived: false,
      }),
    ).rejects.toThrow("incomplete");
    expect(h.calls).toHaveLength(2);
  });
  it("captures complete absence as revision zero and existing catalog revision exactly", async () => {
    const h = harness(),
      existing = await prepare(h, {
        method: "actor.put",
        actorId: "author",
        name: "Changed author",
        actorKind: "person",
        archived: true,
      });
    expect(text(existing.params, "expected_revision")).toBe("3");
    const fresh = await prepare(h, {
      method: "actor.put",
      actorId: "new",
      name: "New actor",
      actorKind: "agent",
      archived: false,
    });
    expect(text(fresh.params, "expected_revision")).toBe("0");
  });
  it("attempt checkpoints retain exact content versions and terminal evidence", async () => {
    const h = harness(),
      result = await prepare(h, {
        method: "attempt.checkpoint",
        attemptId: "attempt",
        checkpointKind: "resource",
        targetId: "proof",
        revision: "9007199254740993",
      });
    expect(result.params).toEqual(
      json({
        workspace_id: "workspace",
        actor_id: "author",
        mutation_id: "intention",
        run_id: "run",
        attempt_id: "attempt",
        expected_revision: attempt.revision,
        checkpoint: { kind: "resource", resource_id: "proof", revision: "9007199254740993" },
      }),
    );
    await expect(
      prepare(h, {
        method: "attempt.finish",
        attemptId: "attempt",
        state: "completed",
        evidence: " ",
      }),
    ).rejects.toThrow("nonblank");
  });
  it("one heartbeat carries no fabricated durable mutation identity or run parameter", async () => {
    const h = harness(),
      result = await prepare(h, { method: "run.heartbeat", runId: "run" });
    expect(result.params).toEqual(
      json({ workspace_id: "workspace", actor_id: "author", target_run_id: "run" }),
    );
    expect(result.context.writer.run_id).toBe("run");
  });
  it("captures a guarded new budget only after proving the target run exists", async () => {
    const h = harness({
        read: (method) =>
          Promise.resolve(
            method === "run.get"
              ? ok(response(run, { query_scope: "runs", history_capture: { head: null } }))
              : {
                  ok: false,
                  failure: {
                    kind: "remote",
                    httpStatus: 404,
                    problem: { kind: "Not_found", message: "Budget missing", details: undefined },
                  },
                },
          ),
      }),
      result = await prepare(h, {
        method: "run.budget_put",
        runId: "run",
        maxAttempts: "",
        maxActiveAttempts: "2",
        reportedTokenLimit: "9223372036854775807",
        reportedElapsedMsLimit: "",
      });
    expect(text(result.params, "expected_revision")).toBe("0");
    expect(result.params).toEqual(
      json({
        workspace_id: "workspace",
        actor_id: "author",
        mutation_id: "intention",
        run_id: "run",
        target_run_id: "run",
        expected_revision: "0",
        max_attempts: null,
        max_active_attempts: "2",
        reported_token_limit: "9223372036854775807",
        reported_elapsed_ms_limit: null,
      }),
    );
  });
});
describe("Participants retained read/draft ownership", () => {
  it("resets ordinary filters across scope changes and keeps exact routed selection", async () => {
    const h = harness();
    h.controller.select(h.context);
    h.controller.filter({ actorId: "old-actor", runId: "old-run", ticketId: "old-ticket" });
    const next = {
      ...h.context,
      route: {
        ...h.context.route,
        workspaceId: "other",
        entityId: "actual-run",
        participant: { kind: "run" as const, generation: "2" },
      },
    };
    h.controller.select(next);
    expect(h.controller.get().filter).toEqual({ actorId: "", runId: "", ticketId: "" });
    expect(h.controller.get().target?.selection).toEqual({ kind: "run", runId: "actual-run" });
    await Promise.resolve();
    expect(
      h.calls
        .filter((call) => text(call.params, "workspace_id") === "other")
        .every((call) => text(call.params, "target_run_id") !== "old-run"),
    ).toBe(true);
  });
  it("coalesces Review and freezes input through guard reads and navigation", async () => {
    const waiting = deferred<ReturnType<typeof response>>(),
      h = harness({
        read: async (method) =>
          method === "run.get"
            ? ok(await waiting.promise)
            : ok(
                response(
                  { items: [], offset: "0", remaining: "0", next_offset: null },
                  { workspace_revision: "7" },
                ),
              ),
      });
    h.controller.open(h.context, "run.transition");
    const saved = h.controller.get().drafts[0];
    if (saved === undefined || saved.input.method !== "run.transition")
      throw new Error("Expected draft");
    const pending = h.controller.review(saved.id),
      second = h.controller.review(saved.id);
    h.controller.edit(saved.id, { ...saved.input, runId: "other" });
    h.controller.select({
      ...h.context,
      route: { ...h.context.route, workspaceId: "other" },
      writer: { actorId: "other", runId: null },
    });
    waiting.resolve(response(run, { query_scope: "runs", history_capture: { head: null } }));
    await Promise.all([pending, second]);
    expect(h.sent).toHaveLength(1);
    expect(text(h.sent[0]?.params, "workspace_id")).toBe("workspace");
    expect(text(h.sent[0]?.params, "target_run_id")).toBe("run");
    expect(h.sent[0]?.context.writer.actor_id).toBe("author");
    expect(h.controller.get().drafts[0]?.phase.kind).toBe("registered");
  });
  it("retains an actionable editable draft after local validation rejection", async () => {
    const h = harness();
    h.controller.open(h.context, "run.register");
    const saved = h.controller.get().drafts[0];
    if (saved === undefined) throw new Error("Expected draft");
    await h.controller.review(saved.id);
    expect(h.controller.get().drafts[0]?.phase.kind).toBe("editing");
    expect(h.controller.get().drafts[0]?.issue).toBeTruthy();
    expect(h.sent).toHaveLength(0);
  });
  it("disposal cancels owned guards and never admits their late results", async () => {
    const waiting = deferred<ReturnType<typeof response>>(),
      h = harness({ read: async () => ok(await waiting.promise) });
    h.controller.open(h.context, "run.transition");
    const saved = h.controller.get().drafts[0];
    if (saved === undefined) throw new Error("Expected draft");
    const pending = h.controller.review(saved.id);
    h.controller.dispose();
    expect(h.calls[0]?.signal?.aborted).toBe(true);
    waiting.resolve(response(run, { query_scope: "runs", history_capture: { head: null } }));
    await pending;
    expect(h.sent).toHaveLength(0);
  });
  it("resolved target retains external endpoint and never changes current selection", async () => {
    const h = harness();
    h.controller.select({
      ...h.context,
      route: { ...h.context.route, entityId: "run", participant: { kind: "run", generation: "1" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.controller.get().historicalGeneration).toBe(true);
    expect(h.controller.get().target?.connection.generation).toBe("1");
    expect(h.calls.every((call) => call.generation === "1")).toBe(true);
    expect(h.context.connection.generation).toBe("2");
    expect(contextTarget(h.context).connection.generation).toBe("2");
  });
  it("a superseded refresh rejection cannot overwrite the new scope's state", async () => {
    let reject: (reason: unknown) => void = () => {
      throw new Error("Missing reject owner");
    };
    const pending = new Promise<ReturnType<typeof response>>((_resolve, fail) => {
      reject = fail;
    });
    let count = 0;
    const h = harness({
      read: async (method) => {
        if (method === "run.get" && ++count === 2) return ok(await pending);
        return ok(
          method === "run.get"
            ? response(run, { query_scope: "runs", history_capture: { head: null } })
            : method === "run.list"
              ? response(
                  { items: [run], next_offset: null, omitted: "0" },
                  { query_scope: "runs", query_revision: "7", history_capture: { head: null } },
                )
              : response(
                  { items: [], offset: "0", remaining: "0", next_offset: null },
                  { workspace_revision: "7" },
                ),
        );
      },
    });
    const selected = {
      ...h.context,
      route: {
        ...h.context.route,
        entityId: "run",
        participant: { kind: "run" as const, generation: "2" },
      },
    };
    h.controller.select(selected);
    await new Promise((done) => setTimeout(done, 0));
    h.controller.refresh();
    h.controller.select({ ...h.context, route: { ...h.context.route, workspaceId: "other" } });
    reject(new TypeError("Deferred old detail failed"));
    await new Promise((done) => setTimeout(done, 0));
    expect(h.controller.get().target?.workspaceId).toBe("other");
    expect(h.controller.get().unexpected).toBeNull();
  });
  it.each(["page", "detail"] as const)(
    "obsolete same-target %s rejection stays owned by its superseded read slot",
    async (kind) => {
      let reject: (reason: unknown) => void = () => {
        throw new Error("Missing rejection owner");
      };
      const waiting = new Promise<ReturnType<typeof response>>((_resolve, fail) => {
        reject = fail;
      });
      let count = 0;
      const h = harness({
        read: async (method) => {
          if (method === (kind === "page" ? "run.list" : "run.get") && ++count === 2)
            return ok(await waiting);
          return ok(
            method === "run.get"
              ? response(run, { query_scope: "runs", history_capture: { head: null } })
              : method === "run.list"
                ? response(
                    { items: [run], next_offset: null, omitted: "0" },
                    { query_scope: "runs", query_revision: "7", history_capture: { head: null } },
                  )
                : response(
                    { items: [], offset: "0", remaining: "0", next_offset: null },
                    { workspace_revision: "7" },
                  ),
          );
        },
      });
      h.controller.select({
        ...h.context,
        route: {
          ...h.context.route,
          entityId: "run",
          participant: { kind: "run", generation: "2" },
        },
      });
      await new Promise((done) => setTimeout(done, 0));
      h.controller.refresh();
      if (kind === "page") h.controller.panel("actors");
      else h.controller.refresh();
      await new Promise((done) => setTimeout(done, 0));
      reject(new TypeError("Obsolete same-target read"));
      await new Promise((done) => setTimeout(done, 0));
      expect(h.controller.get().unexpected).toBeNull();
      expect(h.controller.get()[kind].kind).toBe("ready");
    },
  );
  it("preserves a current unexpected read in its slot without duplicate global publication", async () => {
    const error = new TypeError("Current read defect"),
      h = harness({ read: () => Promise.reject(error) });
    h.controller.select(h.context);
    await new Promise((done) => setTimeout(done, 0));
    expect(h.controller.get().page).toMatchObject({ kind: "unexpected_error", error });
    expect(h.controller.get().unexpected).toBeNull();
  });
});

it("clears a previous page when a focused view needs an actor or run", async () => {
  const h = harness();
  h.controller.select(h.context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(h.controller.get().page.kind).toBe("ready");
  h.controller.panel("budget");
  expect(h.controller.get().page.kind).toBe("idle");
  expect(h.controller.get().issue).toContain("Choose a run");
  h.controller.panel("actor-overview");
  expect(h.controller.get().issue).toContain("Choose an actor");
});
