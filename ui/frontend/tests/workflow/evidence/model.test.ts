import { describe, expect, it } from "vitest";
import { jsonField } from "../../../src/core/json";
import * as d from "../../../src/core/protocol/decoders";
import { decodeCapture, decodeGate } from "../../../src/features/workflow/evidence/client";
import { continuation } from "../../../src/features/workflow/evidence/continuation";
import { COMMANDS } from "../../../src/features/workflow/evidence/commands";
import { preparation, target } from "../../../src/features/workflow/evidence/model";
import {
  deferred,
  evidenceData,
  harness,
  json,
  ok,
  policy,
  read,
  response,
  ticketData,
} from "./fixtures";

describe("authoritative evidence captures", () => {
  it("retains exact counters, policy sources and unprojected lossless source", () => {
    const h = harness(),
      scope = target(h.context, "target"),
      result = decodeCapture(scope, response({ ...evidenceData, extra: "retained" }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected capture");
    expect(result.data.revision).toBe("9007199254740993");
    expect(result.data.policy.membership_revision).toBe("9007199254740993");
    expect(read(result.data.raw, "extra")).toBe("retained");
  });
  it("rejects another ticket, malformed criterion source and namespace capture", () => {
    const h = harness(),
      scope = target(h.context, "target");
    expect(decodeCapture(scope, response({ ...evidenceData, ticket_id: "other" })).ok).toBe(false);
    expect(
      decodeCapture(
        scope,
        response({
          ...evidenceData,
          effective_policy: { ...policy, criteria: [{ reference: {}, criterion: {} }] },
        }),
      ).ok,
    ).toBe(false);
    expect(decodeCapture(scope, response(evidenceData, "1", "runs")).ok).toBe(false);
  });
  it("never turns blocked evidence into graph readiness or acceptance", () => {
    const h = harness(),
      scope = target(h.context, "target"),
      blocked = decodeGate(
        scope,
        response({ allowed: false, problem: { kind: "blocked", message: "Needs review" } }),
      );
    expect(blocked.ok && blocked.data.allowed).toBe(false);
    expect(
      decodeGate(
        scope,
        response({ allowed: true, problem: { kind: "blocked", message: "Contradiction" } }),
      ).ok,
    ).toBe(false);
  });
});

describe("captured evidence editor ownership", () => {
  it("uses actual ticket project/claim rather than route filter and retains writer across selection", async () => {
    const h = harness();
    await h.controller.select(h.context, "target");
    const id = await h.controller.open(h.context, "target", "review.submit");
    expect(id).not.toBeNull();
    if (id === null) throw new Error("No draft");
    const original = h.controller.get().drafts[0];
    expect(original?.projectId).toBe("actual-project");
    expect(original?.claim?.token).toBe("7");
    const changed = { ...h.context, writer: { actorId: "changed", runId: null } };
    await h.controller.select(changed, "target");
    expect(h.controller.get().drafts[0]?.writer.actorId).toBe("author");
  });
  it("does not adopt another claimant's observed token", async () => {
    const h = harness();
    await h.controller.select(h.context, "target");
    await h.controller.open(
      { ...h.context, writer: { actorId: "reviewer", runId: null } },
      "target",
      "acceptance.assert",
    );
    const draft = h.controller.get().drafts[0];
    expect(draft?.phase.kind).toBe("unavailable");
    expect(draft?.issue).toContain("actual current claimant");
    expect(h.operations.list()).toHaveLength(0);
  });
  it("allows actual independent reviewer attribution without claiming worker ownership", async () => {
    const h = harness();
    await h.controller.select(h.context, "target");
    await h.controller.open(
      { ...h.context, writer: { actorId: "reviewer", runId: null } },
      "target",
      "review.record",
    );
    expect(h.controller.get().drafts[0]?.phase.kind).toBe("editing");
    expect(h.controller.get().drafts[0]?.writer.actorId).toBe("reviewer");
  });
  it("rejects a mismatched ownership ticket instead of borrowing its claim", async () => {
    const h = harness({
      read: (method) =>
        Promise.resolve(
          ok(
            response(
              method === "ticket.read"
                ? { ticket: { ...ticketData, ticket_id: "other" } }
                : method === "evidence.context"
                  ? evidenceData
                  : { allowed: false, problem: null },
            ),
          ),
        ),
    });
    await h.controller.open(h.context, "target", "review.submit");
    expect(h.controller.get().drafts[0]?.issue).toContain("changed the requested ticket");
  });
  it("freezes writer and endpoint before a deferred owner read", async () => {
    const pending = deferred<ReturnType<typeof ok<ReturnType<typeof response>>>>(),
      h = harness({ read: async () => pending.promise });
    const selection = {
      ...h.context,
      writer: { ...h.context.writer },
      connection: { ...h.context.connection },
    };
    const opening = h.controller.open(selection, "target", "review.record");
    selection.writer.actorId = "new-author";
    const generation = d.positiveDecimal.decode(d.jsonString("2"));
    if (!generation.ok) throw new Error("No generation");
    selection.connection.generation = generation.value;
    pending.resolve(ok(response({ ticket: ticketData })));
    await opening;
    expect(h.controller.get().drafts[0]?.writer.actorId).toBe("author");
    expect(h.controller.get().drafts[0]?.target.connection.generation).toBe("1");
  });
  it("fences late target reads even when the transport ignores abort", async () => {
    const first = deferred<ReturnType<typeof ok<ReturnType<typeof response>>>>(),
      h = harness({
        read: async (method, params) =>
          read(params, "ticket_id") === "target"
            ? first.promise
            : ok(
                response(
                  method === "evidence.context"
                    ? {
                        ...evidenceData,
                        ticket_id: "other",
                        effective_policy: { ...policy, ticket_id: "other" },
                      }
                    : { allowed: true, problem: null },
                ),
              ),
      });
    const old = h.controller.select(h.context, "target");
    await h.controller.select(h.context, "other");
    first.resolve(ok(response(evidenceData)));
    await old;
    const current = h.controller.get().evidence;
    expect(current.kind).toBe("ready");
    if (current.kind === "ready") expect(current.value.target.ticketId).toBe("other");
  });
  it("locks a draft before async preparation and coalesces repeated Review clicks", async () => {
    const h = harness();
    await h.controller.open(h.context, "target", "review.record");
    const draft = h.controller.get().drafts[0];
    if (draft === undefined) throw new Error("No draft");
    for (const [name, text] of Object.entries({
      review_id: "review-one",
      generation: "2",
      evidence: "Actually reviewed",
    }))
      h.controller.edit(draft.id, name, { presence: "value", text });
    const first = h.controller.prepare(draft.id),
      second = h.controller.prepare(draft.id);
    h.controller.edit(draft.id, "evidence", { presence: "value", text: "Changed later" });
    await Promise.all([first, second]);
    expect(h.sent).toHaveLength(1);
    expect(read(h.sent[0]?.params, "evidence")).toBe("Actually reviewed");
    expect(h.controller.get().drafts[0]?.phase.kind).toBe("registered");
  });
  it("keeps malformed input editable and never sends or silently retargets", async () => {
    const h = harness();
    await h.controller.open(h.context, "target", "review.record");
    const draft = h.controller.get().drafts[0];
    if (draft === undefined) throw new Error("No draft");
    h.controller.edit(draft.id, "review_id", { presence: "value", text: "review-one" });
    h.controller.edit(draft.id, "ticket_id", { presence: "value", text: "other" });
    await h.controller.prepare(draft.id);
    expect(h.sent).toHaveLength(0);
    expect(h.controller.get().drafts[0]?.phase.kind).toBe("editing");
    expect(h.controller.get().drafts[0]?.issue).toContain("captured ticket");
  });
  it("does not swallow unexpected owner lookup defects", async () => {
    const defect = new TypeError("unexpected implementation defect"),
      h = harness({ read: () => Promise.reject(defect) });
    await h.controller.open(h.context, "target", "review.record");
    expect(h.controller.get().drafts[0]?.unexpected?.error).toBe(defect);
  });
  it("disposal cancels owned reads and late owner publication", async () => {
    let signal: AbortSignal | undefined;
    const pending = deferred<ReturnType<typeof ok<ReturnType<typeof response>>>>(),
      h = harness({
        read: async (_method, _params, abort) => {
          signal = abort;
          return pending.promise;
        },
      });
    const opening = h.controller.open(h.context, "target", "review.record");
    h.controller.dispose();
    expect(signal?.aborted).toBe(true);
    pending.resolve(ok(response({ ticket: ticketData })));
    await opening;
    expect(h.operations.list()).toHaveLength(0);
  });
});

describe("exact continuation boundaries", () => {
  const original = json({
    workspace_id: "demo",
    ticket_id: "target",
    limit: "1",
    max_bytes: "65536",
  });
  const page = (params: unknown, method = "review.list") =>
    response({ items: [], next_offset: "1", offset: "0", remaining: "1" }, "10", "evidence", {
      consistency: "current_revision_guard",
      capture: { query_revision: "10", query_scope: "evidence" },
      next_request: { jsonrpc: "2.0", workgraph_api: "0.7", id: "page", method, params },
    });
  it("preserves the exact target and namespace while advancing a returned cursor", async () => {
    const h = harness();
    if (original.kind !== "object") throw new Error("No original");
    const result = await continuation(
      h.processing,
      target(h.context, "target"),
      "review.list",
      original,
      page({
        workspace_id: "demo",
        ticket_id: "target",
        limit: "1",
        max_bytes: "65536",
        offset: "1",
        revision: "10",
      }),
      "next_request",
      new AbortController().signal,
    );
    expect(read(result, "revision")).toBe("10");
  });
  it.each([
    { ticket_id: "other" },
    { workspace_id: "other" },
    { offset: "2" },
    { revision: "11" },
    { limit: "2" },
    { max_bytes: "1048577" },
  ])("rejects changed selector/cursor/budget %j", async (change) => {
    const h = harness();
    if (original.kind !== "object") throw new Error("No original");
    await expect(
      continuation(
        h.processing,
        target(h.context, "target"),
        "review.list",
        original,
        page({
          workspace_id: "demo",
          ticket_id: "target",
          limit: "1",
          max_bytes: "65536",
          offset: "1",
          revision: "10",
          ...change,
        }),
        "next_request",
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
  it("rejects an alternate allowed method rather than following arbitrary reads", async () => {
    const h = harness();
    if (original.kind !== "object") throw new Error("No original");
    await expect(
      continuation(
        h.processing,
        target(h.context, "target"),
        "review.list",
        original,
        page({}, "contract.list"),
        "next_request",
        new AbortController().signal,
      ),
    ).rejects.toThrow("method");
  });
});

describe("bounded preparation source", () => {
  it("has no finish or implicit external-execution command", () => {
    expect(COMMANDS).toHaveLength(14);
    expect(COMMANDS.map((command) => command.method)).not.toContain("ticket.finish");
  });
  it("preserves exact captured run attribution and new-object revision while parsing pin source", async () => {
    const h = harness();
    await h.controller.open(h.context, "target", "decision.put");
    const draft = h.controller.get().drafts[0];
    if (draft === undefined) throw new Error("No draft");
    const inputs = {
      ...draft.inputs,
      decision_id: { presence: "value" as const, text: "decision-one" },
      title: { presence: "value" as const, text: "Exact evidence" },
      rationale: {
        presence: "value" as const,
        text: '{"kind":"checksum","source":"build","digest":"' + "b".repeat(64) + '"}',
      },
    };
    const result = await preparation(
      h.processing,
      { ...draft, inputs },
      new AbortController().signal,
    );
    expect(jsonField(result.params, "run_id")).toEqual(d.jsonString("run-one"));
    expect(read(result.params, "expected_revision")).toBe("0");
  });
});
