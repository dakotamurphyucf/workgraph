import { describe, expect, it } from "vitest";
import { decodePins, decodeWriter, selectionKey } from "../../src/app/local-selections";
import type { ConnectionProfile } from "../../src/core/protocol/types";

describe("local sidebar preferences", () => {
  it("rejects malformed or unsafe stored identities and accepts independent actor/run values", () => {
    for (const value of [
      null,
      "{",
      "[]",
      "{}",
      '{"actorId":"bad actor","runId":null}',
      '{"actorId":12,"runId":null}',
    ]) {
      expect(decodeWriter(value)).toEqual({ actorId: null, runId: null });
    }
    expect(decodeWriter('{"actorId":"alice","runId":"run-1"}')).toEqual({
      actorId: "alice",
      runId: "run-1",
    });
    expect(decodeWriter('{"actorId":null,"runId":"run-1"}')).toEqual({
      actorId: null,
      runId: "run-1",
    });
  });
  it("validates and deduplicates pins without accepting a partial corrupt set", () => {
    expect(decodePins('["one","two","one"]')).toEqual(["one", "two"]);
    expect(decodePins('["one",123]')).toEqual([]);
    expect(decodePins('["invalid id"]')).toEqual([]);
    expect(decodePins("null")).toEqual([]);
  });
  it("separates preferences by exact endpoint, generation and workspace", () => {
    const connection = {
      id: "local",
      socket: "/tmp/a.sock",
      generation: "1",
      label: "Local",
    } as ConnectionProfile;
    const key = selectionKey(connection, "demo");
    expect(selectionKey({ ...connection, label: "Renamed" }, "demo")).toBe(key);
    expect(selectionKey(connection, "other")).not.toBe(key);
    expect(selectionKey({ ...connection, socket: "/tmp/b.sock" }, "demo")).not.toBe(key);
    expect(
      selectionKey({ ...connection, generation: "2" as ConnectionProfile["generation"] }, "demo"),
    ).not.toBe(key);
    expect(selectionKey(undefined, "demo")).not.toBe(key);
  });
});
