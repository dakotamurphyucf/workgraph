import { describe, expect, it } from "vitest";
import { mergeObservedChanges } from "../../src/features/overview/notification-model";
import type { AttentionRow } from "../../src/features/overview/types";
import { decimal as decimalCodec, jsonString, jsonObject } from "../../src/core/protocol/decoders";
function decimal(value: string) {
  const result = decimalCodec.decode(jsonString(value));
  if (!result.ok) throw new Error("Invalid decimal fixture");
  return result.value;
}
function row(revision: string, ids: readonly string[] = []): AttentionRow {
  return {
    kind: ids.length ? "communication_group" : "ticket_changed",
    revision: decimal(revision),
    changeIndex: decimal("0"),
    title: revision,
    notificationIds: ids.map((id) => decimal(id)),
    raw: jsonObject([]),
  };
}
describe("modal observed changes", () => {
  it("retains readable rows through an empty wait and deduplicates repeated captures", () => {
    const original = [row("8"), row("9")];
    expect(mergeObservedChanges(original, []).map((v) => v.revision)).toEqual(["9", "8"]);
    expect(mergeObservedChanges(original, [row("9"), row("10")]).map((v) => v.revision)).toEqual([
      "10",
      "9",
      "8",
    ]);
    expect(original.map((v) => v.revision)).toEqual(["8", "9"]);
  });
  it("preserves distinct notification fragments at the same change index", () => {
    expect(mergeObservedChanges([row("9", ["1", "2"])], [row("9", ["3"])])).toHaveLength(2);
  });
  it("orders exact counters beyond the safe integer range and bounds retention to newest 100", () => {
    const rows = Array.from({ length: 120 }, (_, i) =>
      row((9007199254740992n + BigInt(i)).toString()),
    );
    const merged = mergeObservedChanges(rows, []);
    expect(merged).toHaveLength(100);
    expect(merged[0]?.revision).toBe("9007199254741111");
    expect(merged[99]?.revision).toBe("9007199254741012");
  });
});
