import { describe, expect, it } from "vitest";
import {
  createGraphReader,
  writeGraph,
  WireError,
  type GraphPart,
} from "../../src/core/protocol/worker/wire";
function roundtrip(value: unknown) {
  const reader = createGraphReader();
  for (const part of writeGraph(value))
    reader.accept(structuredClone(part, { transfer: part.kind === "end" ? [] : [part.bytes] }));
  return reader.finish();
}
const records = (value: unknown): GraphPart => ({
  kind: "records",
  bytes: new TextEncoder().encode(JSON.stringify(value)).buffer,
});
describe("bounded private data transport", () => {
  it("preserves code units for worker semantic validation, numeric lexemes and own prototype names", () => {
    const value = Object.create(null) as Record<string, unknown>;
    value.__proto__ = "own";
    value.invalid = "\ud800";
    value.lexeme = "9007199254740993";
    expect(roundtrip(value)).toEqual(value);
    expect(Object.getPrototypeOf(roundtrip(value))).toBe(null);
  });
  it("rejects accessors, cycles, duplicate identities and references to unfinished containers", () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => [...writeGraph(cyclic)]).toThrow(WireError);
    expect(() => [
      ...writeGraph({
        get value() {
          throw new Error("must not invoke");
        },
      }),
    ]).toThrow(WireError);
    for (const frames of [
      [
        ["null", 1],
        ["null", 1],
      ],
      [
        ["array", 1],
        ["push", 1, [1]],
      ],
      [["object", 1, [["x", 2]]]],
    ]) {
      const reader = createGraphReader();
      expect(() => reader.accept(records(frames))).toThrow(WireError);
    }
  });
  it("never detaches caller bytes and rejects reused buffer IDs even after consumption", () => {
    const source = new Uint8Array([0, 255, 1]);
    expect(roundtrip(source)).toEqual(source);
    expect(source.byteLength).toBe(3);
    const reader = createGraphReader();
    reader.accept({ kind: "buffer", index: 0, bytes: new ArrayBuffer(1) });
    reader.accept(records([["bytes", 1, 0]]));
    expect(() => reader.accept({ kind: "buffer", index: 0, bytes: new ArrayBuffer(1) })).toThrow(
      WireError,
    );
  });
});
