import { describe, expect, it } from "vitest";
import { decodeAudit, proofLabel } from "../../../src/features/participants/coordination/records";
import { json } from "../runs/fixtures";
const common = {
  actor_id: "operator",
  run_id: "operator-run",
  timestamp: "2026-11-07 14:00:00Z",
  sequence: "9",
};
const pin = { kind: "checksum", source: "outside-isolation-log", digest: "a".repeat(64) };
const request = {
  recovery_id: "recovery",
  old_actor_id: "old-actor",
  old_run_id: "old-run",
  token: "2",
  expected_lease_revision: "3",
  confirmation: "isolated",
  reason: "Harness observed and isolated the original owner",
  evidence: [pin],
};
describe("typed coordination audit summaries", () => {
  it("keeps actual operator distinct from previous owner and exact reservation fences", () => {
    const raw = {
      ...common,
      request: {
        ...request,
        target: { kind: "named", reservation_id: "compiler" },
        expected_epoch: "2",
      },
      borrowers: [],
    };
    const result = decodeAudit("recovery.list", json(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("fixture");
    expect(result.value).toMatchObject({
      id: "recovery",
      actorId: "operator",
      runId: "operator-run",
      previousOwner: "old-actor / old-run",
      binding: "compiler · outside confirmation: isolated",
    });
    expect(result.value.guards).toContain("epoch 2 · token 2 · lease revision 3");
    expect(result.value.evidence).toHaveLength(1);
    expect(
      decodeAudit("recovery.list", json({ ...raw, request: { ...raw.request, token: "3" } })).ok,
    ).toBe(false);
    expect(
      decodeAudit(
        "recovery.list",
        json({
          ...raw,
          borrowers: [{ ticket_id: "task", actor_id: "other", run_id: "old-run", token: "1" }],
        }),
      ).ok,
    ).toBe(false);
  });
  it("keeps optional old run and explicit ticket disposition without conflating claim token and ticket revision", () => {
    const result = decodeAudit(
      "ticket.recovery.list",
      json({
        ...common,
        request: {
          ...request,
          old_run_id: null,
          ticket_id: "task",
          expected_revision: "12",
          disposition: "requeue",
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("fixture");
    expect(result.value.previousOwner).toBe("old-actor / no run");
    expect(result.value.guards).toBe("Ticket revision 12 · claim token 2 · lease revision 3");
    expect(result.value.binding).toContain("requeue");
  });
  it("signals retain exact declaration/operation/artifact and reject missing actual proof", () => {
    const raw = {
      ...common,
      signal_id: "signal",
      condition_id: "condition",
      condition_revision: "4",
      operation_id: "operation",
      artifact: pin,
      evidence: [pin],
      summary: "Harness verified the fixture artifact",
    };
    const result = decodeAudit("condition.signals", json(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("fixture");
    expect(result.value.binding).toBe("Condition condition · declaration 4 · operation operation");
    expect(proofLabel(result.value.evidence[0]!)).toContain(pin.digest);
    expect(decodeAudit("condition.signals", json({ ...raw, evidence: [] })).ok).toBe(false);
    expect(decodeAudit("guessed.audit", json(raw)).ok).toBe(false);
  });
});
