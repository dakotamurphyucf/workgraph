import * as c from "../../core/protocol/codec";
import * as d from "../../core/protocol/decoders";
import { keyCodec, scopeCodec } from "../knowledge/facts/codecs";
import type {
  EntityTarget,
  Page,
  ResourceCoverage,
  SearchCoverage,
  SearchHit,
  SearchMatch,
  SearchPage,
  SearchSource,
} from "./types";
const utf8 = new TextEncoder();
export const text = (maximum: number, nonblank = false) =>
  c.refine(
    c.text,
    (value) =>
      utf8.encode(value).length <= maximum &&
      (!nonblank || /[^\t\n\v\f\r ]/u.test(value)) &&
      new TextDecoder().decode(utf8.encode(value)) === value,
    `valid UTF-8 text ≤${maximum} bytes${nonblank ? ", nonblank" : ""}`,
  );
type NativeTarget =
  | { readonly kind: "workspace" }
  | {
      readonly kind: "project";
      readonly project_id: import("../../core/protocol/types").Identifier;
    }
  | {
      readonly kind: "milestone";
      readonly milestone_id: import("../../core/protocol/types").Identifier;
    }
  | { readonly kind: "ticket"; readonly ticket_id: import("../../core/protocol/types").Identifier }
  | {
      readonly kind: "resource";
      readonly resource_id: import("../../core/protocol/types").Identifier;
    };
const nativeTarget: c.Codec<NativeTarget> = c.tagged<NativeTarget>("kind", {
  workspace: c.record({ kind: c.literal("workspace") }),
  project: c.record({ kind: c.literal("project"), project_id: d.identifier }),
  milestone: c.record({ kind: c.literal("milestone"), milestone_id: d.identifier }),
  ticket: c.record({ kind: c.literal("ticket"), ticket_id: d.identifier }),
  resource: c.record({ kind: c.literal("resource"), resource_id: d.identifier }),
});
/** Native Entity_ref uses variant-specific fields, unlike the separate Fact.Scope wire. */
export const targetCodec: c.Codec<EntityTarget> = {
  decode(value, path = []) {
    const result = nativeTarget.decode(value, path);
    if (!result.ok) return result;
    const target = result.value;
    switch (target.kind) {
      case "workspace":
        return { ok: true, value: target };
      case "project":
        return { ok: true, value: { kind: target.kind, id: target.project_id } };
      case "milestone":
        return { ok: true, value: { kind: target.kind, id: target.milestone_id } };
      case "ticket":
        return { ok: true, value: { kind: target.kind, id: target.ticket_id } };
      case "resource":
        return { ok: true, value: { kind: target.kind, id: target.resource_id } };
    }
  },
};
const sourceBase: c.Codec<SearchSource> = c.tagged<SearchSource>("kind", {
  workspace: c.record({
    kind: c.literal("workspace"),
    workspace_id: d.identifier,
    revision: d.decimal,
  }),
  project: c.record({
    kind: c.literal("project"),
    project_id: d.identifier,
    revision: d.positiveDecimal,
  }),
  milestone: c.record({
    kind: c.literal("milestone"),
    milestone_id: d.identifier,
    revision: d.positiveDecimal,
  }),
  ticket: c.record({
    kind: c.literal("ticket"),
    ticket_id: d.identifier,
    revision: d.positiveDecimal,
  }),
  handoff: c.record({
    kind: c.literal("handoff"),
    ticket_id: d.identifier,
    revision: d.positiveDecimal,
  }),
  comment: c.record({
    kind: c.literal("comment"),
    comment_id: d.identifier,
    revision: d.positiveDecimal,
  }),
  resource: c.record({
    kind: c.literal("resource"),
    resource_id: d.identifier,
    revision: d.positiveDecimal,
  }),
  resource_text: c.record({
    kind: c.literal("resource_text"),
    resource_id: d.identifier,
    revision: d.positiveDecimal,
  }),
  fact: c.record({
    kind: c.literal("fact"),
    scope: scopeCodec,
    key: keyCodec,
    revision: d.positiveDecimal,
  }),
});
export const sourceCodec = sourceBase;
/** Byte offsets are converted only after their relative slice fits the bounded snippet. */
export function matchParts(
  match: SearchMatch,
): { before: string; match: string; after: string } | null {
  const bytes = utf8.encode(match.snippet),
    start = BigInt(match.match_offset) - BigInt(match.snippet_offset),
    count = BigInt(match.match_bytes);
  if (start < 0n || count < 1n || count > 256n || start + count > BigInt(bytes.length)) return null;
  const from = Number(start),
    to = Number(start + count),
    decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    return {
      before: decoder.decode(bytes.subarray(0, from)),
      match: decoder.decode(bytes.subarray(from, to)),
      after: decoder.decode(bytes.subarray(to)),
    };
  } catch (error: unknown) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}
export const matchCodec: c.Codec<SearchMatch> = c.refine(
  c.record({
    field: text(512, true),
    match_offset: d.decimal,
    match_bytes: d.positiveDecimal,
    snippet_offset: d.decimal,
    snippet: text(512),
  }),
  (value) => matchParts(value) !== null,
  "valid bounded UTF-8 snippet byte match",
);
export const hitCodec: c.Codec<SearchHit> = c.record({
  source: sourceCodec,
  target: targetCodec,
  matches: c.refine(c.array(matchCodec, 100), (a) => a.length > 0, "nonempty matches"),
});
export function pageFields<T>(item: c.Codec<T>) {
  return {
    items: c.array(item, 100),
    offset: d.decimal,
    remaining: d.decimal,
    next_offset: c.nullable(d.decimal),
  };
}
export function validPage<T>(value: Page<T>) {
  const count = BigInt(value.items.length),
    offset = BigInt(value.offset),
    remaining = BigInt(value.remaining),
    max = 4611686018427387903n;
  return (
    offset + count <= max &&
    remaining + count <= max &&
    (remaining === 0n
      ? value.next_offset === null
      : count > 0n && value.next_offset !== null && BigInt(value.next_offset) === offset + count)
  );
}
export function pageCodec<T>(item: c.Codec<T>): c.Codec<Page<T>> {
  return c.refine(
    c.record(pageFields(item)),
    validPage,
    "ordered nonempty advancing planning page",
  );
}
const reason: c.Codec<ResourceCoverage["reason"]> = {
  decode(value, path = []) {
    if (
      value?.kind === "string" &&
      [
        "prefix_only",
        "invalid_utf8",
        "not_requested",
        "query_text_budget",
        "unsupported_mime",
      ].includes(value.value)
    )
      return { ok: true, value: value.value as ResourceCoverage["reason"] };
    return c.mismatch(path, "native resource coverage reason");
  },
};
const resourceSource = c.refine(
  sourceCodec,
  (value) => value.kind === "resource_text",
  "resource_text source",
);
export const resourceCoverageCodec: c.Codec<ResourceCoverage> = {
  decode(value, path = []) {
    const row = c
      .record({
        source: resourceSource,
        reason,
        indexed_bytes: d.decimal,
        omitted_bytes: d.decimal,
        size_known: c.boolean,
      })
      .decode(value, path);
    if (!row.ok) return row;
    const v = row.value;
    if (
      v.source.kind !== "resource_text" ||
      (v.reason === "prefix_only"
        ? BigInt(v.indexed_bytes) === 0n || BigInt(v.omitted_bytes) === 0n
        : BigInt(v.indexed_bytes) !== 0n)
    )
      return c.mismatch(path, "consistent current resource coverage");
    return { ok: true, value: { ...v, source: v.source } };
  },
};
export const coverageCodec: c.Codec<SearchCoverage> = c.refine(
  c.record({
    current_revisions_only: c.literal(true),
    eligible_text_resources: d.decimal,
    indexed_text_resources: d.decimal,
    unindexed_text_resources: d.decimal,
    truncated_text_resources: d.decimal,
    resource_prefix_bytes: d.decimal,
    request_text_bytes: d.decimal,
  }),
  (v) =>
    BigInt(v.indexed_text_resources) <= BigInt(v.eligible_text_resources) &&
    BigInt(v.unindexed_text_resources) ===
      BigInt(v.eligible_text_resources) - BigInt(v.indexed_text_resources) &&
    BigInt(v.truncated_text_resources) <= BigInt(v.indexed_text_resources) &&
    v.resource_prefix_bytes === "65536" &&
    v.request_text_bytes === "1048576",
  "exact current-only search coverage counts/budgets",
);
export const searchPageCodec: c.Codec<SearchPage> = c.refine(
  c.record({
    ...pageFields(hitCodec),
    unindexed_resources: pageCodec(resourceCoverageCodec),
    index_revision: d.decimal,
    sources_scanned: d.decimal,
    coverage: coverageCodec,
  }),
  validPage,
  "ordered nonempty advancing search page",
);
