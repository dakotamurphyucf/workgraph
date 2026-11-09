import { parseJsonText, type JsonValue } from "../../../src/core/json";
import type { Codec } from "../../../src/core/protocol/codec";
import * as d from "../../../src/core/protocol/decoders";
import type { CustomTarget } from "../../../src/features/custom/editor/types";
export function json(value: unknown): JsonValue {
  const result = parseJsonText(JSON.stringify(value));
  if (!result.ok) throw new Error(result.error.message);
  return result.value.value;
}
export function decode<T>(codec: Codec<T>, value: unknown): T {
  const result = codec.decode(json(value));
  if (!result.ok) throw new Error(result.issue.expected);
  return result.value;
}
export const target: CustomTarget = {
  connection: decode(d.connectionProfile, {
    id: "local",
    generation: "1",
    label: "Original endpoint",
    socket: "/tmp/original.sock",
  }),
  workspaceId: decode(d.identifier, "demo"),
};
export function settings(revision = "1") {
  return {
    target: { connection: target.connection, workspace_id: target.workspaceId },
    revision,
    documents: [{ id: "view", source: "future opaque source" }],
    selected_id: "view",
  };
}
