import { parseJsonText, type JsonValue } from "../../src/core/json";
import type { Codec } from "../../src/core/protocol/codec";
import * as d from "../../src/core/protocol/decoders";
import * as c from "../../src/core/protocol/codec";
import type { ReadResponse } from "../../src/core/protocol/types";
import { planningCapture } from "../../src/features/search/client";
import type { SearchScope, SearchHit, PlanningQuery } from "../../src/features/search/types";
export function json(value: unknown): JsonValue {
  const result = parseJsonText(JSON.stringify(value));
  if (!result.ok) throw new Error(result.error.message);
  return result.value.value;
}
export function decode<T>(codec: Codec<T>, value: unknown): T {
  const r = codec.decode(json(value));
  if (!r.ok) throw new Error(r.issue.expected);
  return r.value;
}
export const decimal = (value: string) => decode(d.decimal, value);
export const scope: SearchScope = {
  connection: decode(d.connectionProfile, {
    id: "local",
    generation: "2",
    label: "Local",
    socket: "/tmp/synthetic-search.sock",
  }),
  workspaceId: decode(d.identifier, "workspace"),
  projectId: null,
};
export const query: PlanningQuery = {
  text: "needle",
  kinds: ["ticket", "comment", "resource_text", "fact"],
  includeArchived: false,
};
export const match = {
  field: "title",
  match_offset: "0",
  match_bytes: "6",
  snippet_offset: "0",
  snippet: "needle text",
};
export const hit: SearchHit = {
  source: { kind: "ticket", ticket_id: decode(d.identifier, "ticket"), revision: decimal("2") },
  target: { kind: "ticket", id: decode(d.identifier, "ticket") },
  matches: [
    {
      ...match,
      match_offset: decimal("0"),
      match_bytes: decimal("6"),
      snippet_offset: decimal("0"),
    },
  ],
};
export const wireHit = { ...hit, target: { kind: "ticket", ticket_id: "ticket" } };
export function page(items: readonly unknown[] = [wireHit], offset = "0", remaining = "0") {
  return {
    items,
    offset,
    remaining,
    next_offset: remaining === "0" ? null : String(BigInt(offset) + BigInt(items.length)),
    unindexed_resources: { items: [], offset: "0", remaining: "0", next_offset: null },
    index_revision: "7",
    sources_scanned: "9",
    coverage: {
      current_revisions_only: true,
      eligible_text_resources: "2",
      indexed_text_resources: "1",
      unindexed_text_resources: "1",
      truncated_text_resources: "1",
      resource_prefix_bytes: "65536",
      request_text_bytes: "1048576",
    },
  };
}
export function response(data: unknown, revision = "7"): ReadResponse {
  return {
    response: { data: json(data), meta: decode(c.object, { workspace_revision: revision }) },
    pagination: null,
  };
}
export function capture(offset = "0", remaining = "0") {
  const result = planningCapture(
    scope,
    query,
    response(page([wireHit], offset, remaining)),
    decimal(offset),
  );
  if (!result.ok) throw new Error("Bad test capture");
  return result.data;
}
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
