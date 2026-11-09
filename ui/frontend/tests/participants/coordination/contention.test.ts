import { describe, expect, it } from "vitest";
import {
  decodeContention,
  overlaps,
} from "../../../src/features/participants/coordination/contention";
import { invocation } from "../../../src/features/participants/coordination/client";
import * as d from "../../../src/core/protocol/decoders";
import { response, target } from "../runs/fixtures";
import type { ReservationTarget } from "../../../src/features/participants/coordination/types";
const key = (name: string) => ({ kind: "named" as const, reservation_id: parseId(name) });
function parseId(value: string) {
  const result = d.identifier.decode(d.jsonString(value));
  if (!result.ok) throw new Error("fixture");
  return result.value;
}
const path = (worktree: string, kind: "file" | "subtree", p: string): ReservationTarget => ({
  kind: "path",
  target: { worktree_id: parseId(worktree), kind, path: p },
});
const holder = {
  actor_id: "author",
  run_id: "run",
  token: "1",
  mode: "exclusive",
  origin: { kind: "manual" },
  lease: {
    epoch: "1",
    revision: "1",
    duration_ms: null,
    last_unix_ms: "0",
    deadline_unix_ms: null,
  },
};
const row = {
  kind: "holder",
  target: { kind: "named", reservation_id: "compiler" },
  holder,
  note: null,
  note_clock_regressed: false,
  advisory: true,
};
const request = () =>
  invocation(target, "reservation.contention", [
    [
      "target",
      d.jsonObject([
        ["kind", d.jsonString("named")],
        ["reservation_id", d.jsonString("compiler")],
      ]),
    ],
  ]);
const page = (items: readonly unknown[], extra: Record<string, unknown> = {}) =>
  response(
    {
      workspace_revision: "9",
      observed_unix_ms: "100",
      items,
      cursor: null,
      has_more: false,
      needs_larger_budget: false,
      required_bytes: null,
      ...extra,
    },
    { workspace_revision: "9" },
  );
describe("contention actual ownership and bounded capture", () => {
  it("uses component/worktree overlap rather than string prefix or fabricated queue position", () => {
    expect(overlaps(path("tree", "subtree", "src"), path("tree", "file", "src/test.ml"))).toBe(
      true,
    );
    expect(
      overlaps(path("tree", "subtree", "src"), path("tree", "file", "src-other/test.ml")),
    ).toBe(false);
    expect(overlaps(path("other", "subtree", "."), path("tree", "file", "a"))).toBe(false);
    expect(overlaps(key("compiler"), key("compiler"))).toBe(true);
    expect(overlaps(key("compiler"), key("other"))).toBe(false);
  });
  it("rejects unrelated rows or holder notes for another actual owner/token", () => {
    expect(decodeContention(target, request(), page([row])).ok).toBe(true);
    expect(
      decodeContention(
        target,
        request(),
        page([{ ...row, target: { kind: "named", reservation_id: "other" } }]),
      ).ok,
    ).toBe(false);
    const note = {
      target: row.target,
      actor_id: "author",
      run_id: "run",
      token: "2",
      revision: "1",
      updated_unix_ms: "100",
      contents: null,
    };
    expect(decodeContention(target, request(), page([{ ...row, note }])).ok).toBe(false);
  });
  it("retains advancing capture but exposes a too-large position as incomplete without a no-progress Next loop", () => {
    const next = decodeContention(
      target,
      request(),
      page([row], { cursor: "next", has_more: true }),
    );
    expect(next.ok).toBe(true);
    if (next.ok) expect(next.data.continuation).not.toBeNull();
    const large = decodeContention(
      target,
      request(),
      page([], {
        cursor: "same-position",
        has_more: true,
        needs_larger_budget: true,
        required_bytes: "1048577",
      }),
    );
    expect(large.ok).toBe(true);
    if (large.ok) {
      expect(large.data.incomplete).toBe(true);
      expect(large.data.continuation).toBeNull();
      expect(large.data.warning).toMatch(/not skipped/);
    }
  });
});
