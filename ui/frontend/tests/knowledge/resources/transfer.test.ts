import { describe, expect, it } from "vitest";
import * as d from "../../../src/core/protocol/decoders";
import { adaptResourceChunk } from "../../../src/features/knowledge/resources/transfer";
import type { ResourceChunk, ResourcePin } from "../../../src/features/knowledge/resources/types";
import { decode } from "../../work/actions-fixtures";
const id = (v: string) => decode(d.identifier, v),
  dec = (v: string) => decode(d.decimal, v),
  sha = decode(d.digest, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
const pin: ResourcePin = {
  connection: decode(d.connectionProfile, {
    id: "local",
    generation: "9007199254740993",
    label: "Synthetic",
    socket: "/tmp/synthetic.sock",
  }),
  workspaceId: id("demo"),
  resourceId: id("artifact"),
  version: dec("4"),
  digest: sha,
  sizeBytes: dec("3"),
  filename: "a.txt",
  mimeType: "text/plain",
};
const chunk: ResourceChunk = {
  resource_id: pin.resourceId,
  version: pin.version,
  digest: pin.digest,
  size_bytes: pin.sizeBytes,
  offset: dec("0"),
  data_base64: "YWJj",
  chunk_digest: sha,
  next_offset: null,
  eof: true,
};
describe("Resource immutable byte-range adapter", () => {
  it("adapts exact EOF to the existing worker protocol only after per-range SHA verification", async () => {
    const result = await adaptResourceChunk(pin, chunk, dec("0"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.bytes_base64).toBe("YWJj");
      expect(result.data.has_more).toBe(false);
      expect(result.data.next_offset).toBe("3");
      expect(result.data.blob).toEqual({ digest: sha, size_bytes: "3" });
    }
  });
  it.each([
    { resource_id: id("other") },
    { version: dec("5") },
    { digest: decode(d.digest, "0".repeat(64)) },
    { size_bytes: dec("4") },
    { offset: dec("1") },
  ])("rejects a range transplanted from another captured identity %j", async (change) => {
    const result = await adaptResourceChunk(pin, { ...chunk, ...change }, dec("0"));
    expect(result.ok).toBe(false);
  });
  it("rejects bytes that match range shape but not the separately declared chunk digest", async () => {
    const result = await adaptResourceChunk(pin, { ...chunk, data_base64: "YWJk" }, dec("0"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("protocol");
  });
  it.each([
    { data_base64: "YWJ=" },
    { data_base64: "YWJj\n" },
    { data_base64: "YQ==" },
    { eof: false, next_offset: dec("3") },
    { eof: true, data_base64: "" },
  ])("rejects malformed encoding or incomplete terminal data %j", async (change) => {
    expect((await adaptResourceChunk(pin, { ...chunk, ...change }, dec("0"))).ok).toBe(false);
  });
});
