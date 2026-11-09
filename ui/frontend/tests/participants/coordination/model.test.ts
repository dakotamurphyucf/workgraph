import { describe, expect, it } from "vitest";
import { jsonField } from "../../../src/core/json";
import {
  holderCodec,
  leaseCodec,
  normalizePath,
  pinCodec,
  reservationCodec,
} from "../../../src/features/participants/coordination/codecs";
import {
  command,
  counter,
  identifier,
  path,
} from "../../../src/features/participants/coordination/model";
import type {
  CoordinationDraft,
  CoordinationInput,
  HolderFence,
} from "../../../src/features/participants/coordination/types";
import { decode, json, response, target } from "../runs/fixtures";

const lease = {
  epoch: "7",
  revision: "9007199254740993",
  duration_ms: "1000",
  last_unix_ms: "9223372036854774807",
  deadline_unix_ms: "9223372036854775807",
};
const holder = {
  actor_id: "author",
  run_id: "run",
  token: "7",
  mode: "exclusive",
  lease,
  origin: { kind: "manual" },
};
const reservation = () =>
  decode(reservationCodec("named"), { reservation_id: "compiler", epoch: "7", holders: [holder] });
const fence = (): HolderFence => {
  const value = reservation();
  return {
    reservation: {
      scope: target,
      value,
      response: response({}),
      namespace: "runs",
      revision: counter("9"),
    },
    holder: value.holders[0]!,
  };
};
const draft = (input: CoordinationInput): CoordinationDraft => ({
  id: identifier("intention"),
  scope: target,
  writer: { actor_id: identifier("author"), run_id: identifier("run") },
  input,
  phase: { kind: "editing" },
  issue: null,
  unexpected: null,
});
describe("Coordination native ownership and exact input fences", () => {
  it("retains full int64 lease clocks and rejects inconsistent/overflowed deadlines", () => {
    const value = decode(leaseCodec, lease);
    expect(value.kind).toBe("timed");
    if (value.kind === "timed") expect(value.deadlineUnixMs).toBe("9223372036854775807");
    for (const changed of [
      { duration_ms: "0" },
      { duration_ms: "86400001" },
      { deadline_unix_ms: "9223372036854775808" },
      { deadline_unix_ms: null },
      { duration_ms: null },
      { deadline_unix_ms: "9223372036854775806" },
    ])
      expect(leaseCodec.decode(json({ ...lease, ...changed })).ok).toBe(false);
    expect(
      leaseCodec.decode(json({ ...lease, duration_ms: null, deadline_unix_ms: null })).ok,
    ).toBe(true);
  });
  it("does not admit duplicated/exclusive shared holders or borrowed-owner mismatches", () => {
    expect(
      reservationCodec("named").decode(
        json({ reservation_id: "compiler", epoch: "6", holders: [holder] }),
      ).ok,
    ).toBe(false);
    expect(
      reservationCodec("named").decode(
        json({ reservation_id: "compiler", epoch: "7", holders: [holder, holder] }),
      ).ok,
    ).toBe(false);
    const automatic = {
      ...holder,
      lease: { ...lease, duration_ms: null, deadline_unix_ms: null },
      origin: {
        kind: "automatic",
        borrowers: [{ ticket_id: "task", token: "1", actor_id: "other", run_id: "run" }],
      },
    };
    expect(holderCodec.decode(json(automatic)).ok).toBe(false);
    expect(
      holderCodec.decode(json({ ...automatic, origin: { kind: "automatic", borrowers: [] } })).ok,
    ).toBe(false);
  });
  it("normalizes only logical path components and preserves component/worktree meaning", () => {
    expect(normalizePath("src//./lib/", "subtree")).toBe("src/lib");
    expect(normalizePath("./", "subtree")).toBe(".");
    for (const source of ["/tmp/a", "../a", "a/../b", "a\\b", "a/*", "a?b", "a\n"])
      expect(normalizePath(source, "subtree")).toBeNull();
    expect(normalizePath(".", "file")).toBeNull();
    expect(
      jsonField(path({ worktreeId: "real-worktree", kind: "file", path: "a//b" }), "path"),
    ).toEqual({ kind: "string", value: "a/b" });
  });
  it("captures original owner for release and rejects using visible token as another writer", () => {
    const f = fence(),
      original = draft({ kind: "release", fence: f }),
      request = command(original, counter("0"));
    expect(request.method).toBe("reservation.release");
    expect(jsonField(request.params, "token")).toEqual({ kind: "string", value: "7" });
    expect(() =>
      command(
        { ...original, writer: { actor_id: identifier("other"), run_id: identifier("run") } },
        counter("0"),
      ),
    ).toThrow(/original holder/);
    expect(() =>
      command(
        {
          ...original,
          scope: { ...target, connection: { ...target.connection, generation: counter("3") } },
        },
        counter("0"),
      ),
    ).toThrow(/another captured/);
  });
  it("requires an explicit outside recovery observation and freezes old lease/epoch even for a different acting operator", () => {
    const f = fence(),
      input: CoordinationInput = {
        kind: "recover",
        recovery: {
          kind: "reservation",
          fence: f,
          recoveryId: "recovery",
          confirmation: "",
          reason: "Owner exited",
          evidence: [],
        },
      };
    expect(() => command(draft(input), counter("0"))).toThrow(/outside observation/);
    const request = command(
      {
        ...draft(input),
        writer: { actor_id: identifier("operator"), run_id: null },
        input: { kind: "recover", recovery: { ...input.recovery, confirmation: "stopped" } },
      },
      counter("999"),
    );
    expect(request.method).toBe("reservation.recover");
    expect(jsonField(request.params, "old_actor_id")).toEqual({ kind: "string", value: "author" });
    expect(jsonField(request.params, "expected_lease_revision")).toEqual({
      kind: "string",
      value: "9007199254740993",
    });
    expect(jsonField(request.params, "expected_epoch")).toEqual({ kind: "string", value: "7" });
  });
  it("keeps atomic batches and the distinct native named/path limits", () => {
    const row = { reservationId: "compiler", mode: "exclusive" as const, durationMs: "" };
    expect(() =>
      command(
        draft({
          kind: "acquire",
          targetRunId: "run",
          acquisition: { kind: "named", requests: [] },
        }),
        counter("0"),
      ),
    ).toThrow(/1..32/);
    expect(() =>
      command(
        draft({
          kind: "acquire",
          targetRunId: "run",
          acquisition: { kind: "named", requests: [row, row] },
        }),
        counter("0"),
      ),
    ).toThrow(/repeat/);
    const requests = Array.from({ length: 33 }, (_, index) => ({
      ...row,
      reservationId: `resource-${index}`,
    }));
    expect(() =>
      command(
        draft({ kind: "acquire", targetRunId: "run", acquisition: { kind: "named", requests } }),
        counter("0"),
      ),
    ).toThrow(/1..32/);
    const request = command(
      draft({
        kind: "acquire",
        targetRunId: "run",
        acquisition: { kind: "named", requests: [row] },
      }),
      counter("0"),
    );
    expect(request.method).toBe("reservation.acquire");
    expect(jsonField(request.params, "requests")?.kind).toBe("array");
  });
  it("uses explicit null to clear a policy allowlist and never silently clears an empty positive list", () => {
    const input: CoordinationInput = {
      kind: "policy",
      ticketId: "task",
      capabilities: ["build"],
      pools: ["compiler"],
      actors: { kind: "unrestricted" },
    };
    expect(jsonField(command(draft(input), counter("4")).params, "allowed_actor_ids")).toEqual({
      kind: "null",
    });
    expect(() =>
      command(draft({ ...input, actors: { kind: "allow", ids: [] } }), counter("4")),
    ).toThrow(/at least one/);
  });
  it("accepts all supported exact proof kinds and rejects loose hashes/metadata versions", () => {
    expect(
      pinCodec.decode(json({ kind: "amendment", amendment_id: "amend", revision: "1" })).ok,
    ).toBe(true);
    expect(
      pinCodec.decode(json({ kind: "commit", repository: "repo", object_id: "a".repeat(40) })).ok,
    ).toBe(true);
    for (const object_id of ["main", "a".repeat(39), "A".repeat(40)])
      expect(pinCodec.decode(json({ kind: "commit", repository: "repo", object_id })).ok).toBe(
        false,
      );
    expect(
      pinCodec.decode(
        json({ kind: "resource", resource_id: "proof", revision: "0", digest: "a".repeat(64) }),
      ).ok,
    ).toBe(false);
  });
});
