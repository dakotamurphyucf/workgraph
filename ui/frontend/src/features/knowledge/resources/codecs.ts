import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type { Decimal } from "../../../core/protocol/types";
import type {
  ResourceChunk,
  ResourceMetadata,
  ResourcePage,
  ResourceRecord,
  ResourceTarget,
  ResourceTextRange,
  ResourceVersion,
} from "./types";

/** Native responses retain unknown fields; trusted companion DTOs use c.record. */
function projected<T>(codec: c.Codec<T>, names: readonly string[]): c.Codec<T> {
  const allowed = new Set(names);
  return {
    decode(value, path = []) {
      return value?.kind === "object"
        ? codec.decode(
            { kind: "object", fields: value.fields.filter((f) => allowed.has(f.name)) },
            path,
          )
        : c.mismatch(path, "object");
    },
  };
}
function fields<S extends Readonly<Record<string, c.Codec<unknown>>>>(shape: S) {
  return projected(c.record(shape), Object.keys(shape));
}
const bounded = (maximum: number) =>
  c.refine(
    c.text,
    (s) => new TextEncoder().encode(s).byteLength <= maximum,
    `UTF-8 text at most ${maximum} bytes`,
  );
const size = c.refine(
  d.decimal,
  (s) => s.length < 8 || (s.length === 8 && s <= "67108864"),
  "resource byte count at most 64 MiB",
);
const filename = c.refine(
  bounded(255),
  (s) =>
    s !== "" &&
    s !== "." &&
    s !== ".." &&
    !s.includes("/") &&
    !s.includes("\\") &&
    Array.from(s).every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127),
  "nonempty basename",
);
const mime = c.refine(
  bounded(128),
  (s) => /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(s),
  "nonempty MIME type",
);
export const resourceVersionCodec: c.Codec<ResourceVersion> = fields({
  revision: d.positiveDecimal,
  digest: d.digest,
  size_bytes: c.nullable(size),
  actor_id: d.identifier,
  timestamp: bounded(128),
  filename,
  mime_type: mime,
});
export const resourceTargetCodec: c.Codec<ResourceTarget> = c.tagged<ResourceTarget>("kind", {
  workspace: c.record({ kind: c.literal("workspace") }),
  project: c.record({ kind: c.literal("project"), id: d.identifier }),
  milestone: c.record({ kind: c.literal("milestone"), id: d.identifier }),
  ticket: c.record({ kind: c.literal("ticket"), id: d.identifier }),
  resource: c.record({ kind: c.literal("resource"), id: d.identifier }),
});
export const resourceMetadataCodec: c.Codec<ResourceMetadata> = fields({
  title: bounded(512),
  description: bounded(65536),
  // Byte fitting may clip prose/targets; native file descriptors stay complete.
  filename,
  mime_type: mime,
  archived: c.boolean,
  targets: c.array(resourceTargetCodec, 100),
});
const record = fields({
  resource_id: d.identifier,
  revision: d.positiveDecimal,
  metadata: resourceMetadataCodec,
  current_version: resourceVersionCodec,
  version_count: d.positiveDecimal,
});
export const resourceRecordCodec: c.Codec<ResourceRecord> = {
  decode(value, path = []) {
    if (value?.kind !== "object") return c.mismatch(path, "resource record");
    const result = record.decode(value, path);
    return result.ok ? { ok: true, value: Object.freeze({ ...result.value, raw: value }) } : result;
  },
};
export function resourcePageCodec<T>(item: c.Codec<T>): c.Codec<ResourcePage<T>> {
  return c.refine(
    fields({
      items: c.array(item, 100),
      offset: d.decimal,
      next_offset: c.nullable(d.decimal),
      remaining: d.decimal,
    }),
    (page) =>
      page.next_offset === null
        ? page.remaining === "0"
        : BigInt(page.next_offset) === BigInt(page.offset) + BigInt(page.items.length) &&
          page.remaining !== "0",
    "coherent native page offsets and remaining count",
  );
}
export const resourceListCodec = resourcePageCodec(resourceRecordCodec);
export const resourceHistoryCodec = resourcePageCodec(resourceVersionCodec);
const chunkFields = {
  resource_id: d.identifier,
  version: d.positiveDecimal,
  digest: d.digest,
  size_bytes: size,
  offset: size,
  chunk_digest: d.digest,
  next_offset: c.nullable(size),
  eof: c.boolean,
};
function range<
  T extends {
    readonly offset: Decimal;
    readonly next_offset: Decimal | null;
    readonly size_bytes: Decimal;
    readonly eof: boolean;
  },
>(codec: c.Codec<T>): c.Codec<T> {
  return c.refine(
    codec,
    (v) =>
      BigInt(v.offset) <= BigInt(v.size_bytes) &&
      v.eof === (v.next_offset === null) &&
      (v.next_offset === null ||
        (BigInt(v.next_offset) > BigInt(v.offset) &&
          BigInt(v.next_offset) <= BigInt(v.size_bytes))),
    "coherent immutable byte-range continuation",
  );
}
export const resourceChunkCodec: c.Codec<ResourceChunk> = range(
  fields({ ...chunkFields, data_base64: bounded(349528) }),
);
export const resourceTextRangeCodec: c.Codec<ResourceTextRange> = range(
  fields({ ...chunkFields, text: bounded(262144) }),
);
