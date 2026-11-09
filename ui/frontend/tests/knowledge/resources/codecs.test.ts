import { describe, expect, it } from "vitest";
import {
  resourceChunkCodec,
  resourceHistoryCodec,
  resourceRecordCodec,
  resourceVersionCodec,
} from "../../../src/features/knowledge/resources/codecs";
import { decode, json } from "../../work/actions-fixtures";
const version = {
  revision: "2",
  digest: "a".repeat(64),
  size_bytes: "3",
  actor_id: "author",
  timestamp: "2026-01-01T00:00:00Z",
  filename: "source.ml",
  mime_type: "text/plain",
};
const resource = {
  resource_id: "artifact",
  revision: "9007199254740993",
  current_version: version,
  version_count: "2",
  metadata: {
    title: "Current title",
    description: "",
    filename: "current.json",
    mime_type: "application/json",
    targets: [{ kind: "project", id: "actual-project" }],
    archived: false,
  },
};
describe("resource immutable publication and separately captured metadata", () => {
  it("preserves native version identity independently of metadata and unknown lossless fields", () => {
    const v = decode(resourceRecordCodec, { ...resource, extension: { counter: 1 } });
    expect(v.revision).toBe("9007199254740993");
    expect(v.current_version.revision).toBe("2");
    expect(v.current_version.filename).toBe("source.ml");
    expect(v.metadata.filename).toBe("current.json");
    expect(v.raw.fields.some((f) => f.name === "extension")).toBe(true);
  });
  it("rejects missing required metadata while preserving known empty text", () => {
    expect(
      resourceRecordCodec.decode(json({ ...resource, metadata: { archived: false } })).ok,
    ).toBe(false);
    expect(decode(resourceRecordCodec, resource).metadata.description).toBe("");
    expect(resourceVersionCodec.decode(json({ ...version, filename: undefined })).ok).toBe(false);
  });
  it("accepts unknown legacy size but rejects invalid version, digest, huge size and file metadata", () => {
    expect(decode(resourceVersionCodec, { ...version, size_bytes: null }).size_bytes).toBeNull();
    for (const change of [
      { revision: "0" },
      { revision: "02" },
      { digest: "A".repeat(64) },
      { size_bytes: "67108865" },
      { filename: "../source.ml" },
      { filename: "bad\nfile" },
      { mime_type: "text/plain; charset=utf-8" },
    ])
      expect(resourceVersionCodec.decode(json({ ...version, ...change })).ok).toBe(false);
  });
  it("publication history retains its exact page cursor rather than inferring complete history", () => {
    const v = decode(resourceHistoryCodec, {
      items: [version],
      offset: "0",
      next_offset: "1",
      remaining: "9",
    });
    expect(v.remaining).toBe("9");
    expect(v.next_offset).toBe("1");
    expect(
      resourceHistoryCodec.decode(
        json({ items: [version], offset: "0", next_offset: null, remaining: "9" }),
      ).ok,
    ).toBe(false);
  });
  it("validates range continuation without treating shape validation as content integrity", () => {
    const c = {
      resource_id: "artifact",
      version: "2",
      digest: version.digest,
      size_bytes: "3",
      offset: "0",
      data_base64: "YWJj",
      chunk_digest: "b".repeat(64),
      next_offset: null,
      eof: true,
    };
    expect(decode(resourceChunkCodec, c).chunk_digest).toBe("b".repeat(64));
    for (const change of [
      { offset: "4" },
      { next_offset: "3", eof: true },
      { next_offset: null, eof: false },
      { next_offset: "0", eof: false },
    ])
      expect(resourceChunkCodec.decode(json({ ...c, ...change })).ok).toBe(false);
  });
});
