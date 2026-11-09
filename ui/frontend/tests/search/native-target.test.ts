import { describe, it, expect } from "vitest";
import native from "./native-search.fixture.json";
import { searchPageCodec, targetCodec } from "../../src/features/search/codecs";
import { json } from "./fixtures";
describe("Captured actual nine-source native Search response", () => {
  it("decodes every variant-specific Entity_ref target into the typed UI identity", () => {
    const result = searchPageCodec.decode(json(native.result.data));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`${result.issue.path.join("/")}: ${result.issue.expected}`);
    expect(result.value.items.map((row) => row.target)).toEqual([
      { kind: "workspace" },
      { kind: "project", id: "release" },
      { kind: "milestone", id: "search-milestone" },
      { kind: "ticket", id: "search-ticket" },
      { kind: "project", id: "release" },
      { kind: "ticket", id: "search-ticket" },
      { kind: "resource", id: "search-resource" },
      { kind: "resource", id: "search-resource" },
      { kind: "project", id: "release" },
    ]);
  });
  it("rejects guessed generic IDs and unknown keys instead of weakening closed validation", () => {
    expect(targetCodec.decode(json({ kind: "project", id: "release" })).ok).toBe(false);
    expect(targetCodec.decode(json({ kind: "ticket", ticket_id: "ticket", id: "other" })).ok).toBe(
      false,
    );
  });
});
