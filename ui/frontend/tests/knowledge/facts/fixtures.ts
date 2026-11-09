import { parseJsonText, type JsonValue } from "../../../src/core/json";
import * as c from "../../../src/core/protocol/codec";
import * as d from "../../../src/core/protocol/decoders";
import type { ReadResponse } from "../../../src/core/protocol/types";
import type { FactTarget } from "../../../src/features/knowledge/facts/types";
export function json(value: unknown): JsonValue {
  const parsed = parseJsonText(JSON.stringify(value));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value.value;
}
export function decode<T>(codec: c.Codec<T>, value: unknown): T {
  const r = codec.decode(json(value));
  if (!r.ok) throw new Error(r.issue.expected);
  return r.value;
}
export function source(text: string): JsonValue {
  const r = parseJsonText(text);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.value;
}
export const target: FactTarget = {
  connection: decode(d.connectionProfile, {
    id: "local",
    generation: "2",
    label: "Actual endpoint",
    socket: "/tmp/facts.sock",
  }),
  workspaceId: decode(d.identifier, "workspace"),
  scope: { kind: "workspace" },
};
export const record = {
  scope: { kind: "workspace" },
  key: "settings",
  revision: "1",
  deleted: false,
  actor_id: "author",
  timestamp: "2026-11-07T00:00:00Z",
  changed_at_revision: "7",
  references: [],
  value_type: "null",
  value: null,
};
export function response(data: unknown, revision = "7", partial = false): ReadResponse {
  return {
    response: {
      data: json(data),
      meta: decode(c.object, {
        workspace_revision: revision,
        budget: {
          max_bytes: "1048576",
          returned_bytes: "100",
          truncated: partial,
          omitted_fields: "0",
          omitted_items: partial ? "1" : "0",
          details: [],
          details_complete: !partial,
        },
      }),
    },
    pagination: null,
  };
}
export const page = (
  items: readonly unknown[],
  offset = "0",
  remaining = "0",
  next_offset: string | null = null,
) => ({ items, offset, remaining, next_offset });
export function deferred<T>() {
  let resolve: (v: T) => void = () => {
    throw new Error("uninitialized");
  };
  let reject: (e: unknown) => void = () => {
    throw new Error("uninitialized");
  };
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
