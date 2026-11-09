import { canonicalJson, jsonField, type JsonValue } from "../../../core/json";
import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type {
  FactKey,
  FactObservation,
  FactPage,
  FactReference,
  FactScope,
  FactValueType,
  FactVersion,
} from "./types";

const utf8 = new TextEncoder();
export const VALUE_LIMITS = Object.freeze({
  maxBytes: 4096,
  maxDepth: 16,
  maxNodes: 8192,
  maxStringBytes: 4096,
});
/** Source whitespace is bounded independently of the native canonical-value limit. */
export const SOURCE_LIMITS = Object.freeze({ ...VALUE_LIMITS, maxBytes: 65536 });
export const keyCodec = c.refine(
  c.text,
  (key) =>
    key !== "" &&
    !/^ +$/u.test(key) &&
    utf8.encode(key).byteLength <= 128 &&
    Array.from(key).every((char) => {
      const scalar = char.codePointAt(0);
      return scalar !== undefined && scalar >= 32 && (scalar < 127 || scalar > 159);
    }) &&
    canonicalJson(d.jsonString(key), {
      maxBytes: 1024,
      maxDepth: 1,
      maxNodes: 1,
      maxStringBytes: 128,
    }).ok,
  "nonblank fact key of at most 128 UTF-8 bytes without control characters",
);
export const scopeCodec: c.Codec<FactScope> = c.tagged<FactScope>("kind", {
  workspace: c.record({ kind: c.literal("workspace") }),
  project: c.record({ kind: c.literal("project"), id: d.identifier }),
  milestone: c.record({ kind: c.literal("milestone"), id: d.identifier }),
  ticket: c.record({ kind: c.literal("ticket"), id: d.identifier }),
});
export const referenceCodec: c.Codec<FactReference> = c.tagged<FactReference>("kind", {
  ticket: c.record({ kind: c.literal("ticket"), id: d.identifier }),
  resource: c.record({ kind: c.literal("resource"), id: d.identifier }),
});
export const referencesCodec = c.refine(
  c.array(referenceCodec, 32),
  (refs) => new Set(refs.map((r) => `${r.kind}:${r.id}`)).size === refs.length,
  "at most 32 distinct fact references",
);
const valueType: c.Codec<FactValueType> = {
  decode(value, path = []) {
    if (value?.kind !== "string") return c.mismatch(path, "fact value type");
    switch (value.value) {
      case "null":
      case "boolean":
      case "number":
      case "string":
      case "array":
      case "object":
        return { ok: true, value: value.value };
      default:
        return c.mismatch(path, "fact value type");
    }
  },
};
const common = {
  scope: scopeCodec,
  key: keyCodec,
  revision: d.positiveDecimal,
  deleted: c.boolean,
  actor_id: d.identifier,
  run_id: c.optional(d.identifier),
  timestamp: c.refine(
    c.text,
    (s) => s !== "" && utf8.encode(s).byteLength <= 128,
    "nonempty timestamp up to 128 UTF-8 bytes",
  ),
  changed_at_revision: d.positiveDecimal,
  references: referencesCodec,
};
const head = c.record({ ...common, value_type: c.optional(valueType) });
const full = c.record({ ...common, value_type: c.optional(valueType), value: c.optional(c.raw) });
// Keep exact native keys closed here: fact values remain arbitrary lossless trees.
function record(
  value: JsonValue | undefined,
  path: readonly string[],
  withValue: boolean,
): c.DecodeResult<FactKey | FactVersion> {
  if (value?.kind !== "object") return c.mismatch(path, "fact record");
  const decoded = withValue ? full.decode(value, path) : head.decode(value, path);
  if (!decoded.ok) return decoded;
  const v = decoded.value;
  if (
    v.deleted &&
    (v.revision === "1" || v.value_type !== undefined || jsonField(value, "value") !== undefined)
  )
    return c.mismatch(path, "tombstone revision above1 without value/value_type");
  const base = {
    scope: v.scope,
    key: v.key,
    revision: v.revision,
    actorId: v.actor_id,
    runId: v.run_id ?? null,
    timestamp: v.timestamp,
    changedAtRevision: v.changed_at_revision,
    references: v.references,
  };
  if (v.deleted) return { ok: true, value: Object.freeze({ ...base, kind: "deleted" }) };
  if (v.value_type === undefined)
    return c.mismatch([...path, "value_type"], "active fact value type");
  if (!withValue)
    return { ok: true, value: Object.freeze({ ...base, kind: "value", valueType: v.value_type }) };
  const raw = jsonField(value, "value");
  if (raw === undefined || raw.kind !== v.value_type)
    return c.mismatch([...path, "value"], "present value matching value_type, including null");
  const encoded = canonicalJson(raw, VALUE_LIMITS);
  if (!encoded.ok)
    return c.mismatch([...path, "value"], `native bounded fact value: ${encoded.error.message}`);
  return {
    ok: true,
    value: Object.freeze({
      ...base,
      kind: "value",
      valueType: v.value_type,
      value: raw,
      canonicalBytes: utf8.encode(encoded.value).byteLength,
    }),
  };
}
export const factKeyCodec: c.Codec<FactKey> = {
  decode(value, path = []) {
    const r = record(value, path, false);
    return r;
  },
};
export const factVersionCodec: c.Codec<FactVersion> = {
  decode(value, path = []) {
    const r = record(value, path, true);
    if (!r.ok) return r;
    return r.value.kind === "value" && !("value" in r.value)
      ? c.mismatch(path, "whole fact value")
      : { ok: true, value: r.value };
  },
};
export const factObservationCodec: c.Codec<FactObservation> = {
  decode(value, path = []) {
    if (value === undefined) return c.mismatch(path, "fact observation");
    if (jsonField(value, "missing") !== undefined) return missing(value, path);
    return factVersionCodec.decode(value, path);
  },
};
function missing(
  value: JsonValue | undefined,
  path: readonly string[],
): c.DecodeResult<FactObservation> {
  const r = c
    .record({ scope: scopeCodec, key: keyCodec, missing: c.literal(true) })
    .decode(value, path);
  return r.ok
    ? {
        ok: true,
        value: Object.freeze({ kind: "missing", scope: r.value.scope, key: r.value.key }),
      }
    : r;
}
export function factPageCodec<T>(item: c.Codec<T>): c.Codec<FactPage<T>> {
  return {
    decode(value, path = []) {
      const r = c
        .record({
          items: c.array(item, 100),
          offset: d.decimal,
          remaining: d.decimal,
          next_offset: c.nullable(d.decimal),
        })
        .decode(value, path);
      if (!r.ok) return r;
      const v = r.value;
      if (
        v.next_offset === null
          ? v.remaining !== "0"
          : v.items.length === 0 ||
            BigInt(v.next_offset) !== BigInt(v.offset) + BigInt(v.items.length) ||
            v.remaining === "0"
      )
        return c.mismatch(path, "advancing fact page with coherent remaining count");
      return {
        ok: true,
        value: Object.freeze({
          items: v.items,
          offset: v.offset,
          nextOffset: v.next_offset,
          remaining: v.remaining,
        }),
      };
    },
  };
}
export const sameScope = (a: FactScope, b: FactScope) =>
  a.kind === b.kind && (a.kind === "workspace" || (b.kind !== "workspace" && a.id === b.id));
export function scopeJson(scope: FactScope) {
  return d.jsonObject([
    ["kind", d.jsonString(scope.kind)],
    ...(scope.kind === "workspace" ? [] : [["id", d.jsonString(scope.id)] as const]),
  ]);
}
