import { parseJsonText, type JsonValue } from "../../../src/core/json";
import * as c from "../../../src/core/protocol/codec";
import * as d from "../../../src/core/protocol/decoders";
import type { ReadResponse } from "../../../src/core/protocol/types";
import type { ParticipantsTarget } from "../../../src/features/participants/runs/types";
export function json(value: unknown): JsonValue {
  const parsed = parseJsonText(JSON.stringify(value));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value.value;
}
export function decode<T>(codec: c.Codec<T>, value: unknown): T {
  const result = codec.decode(json(value));
  if (!result.ok) throw new Error(`${result.issue.path.join(".")}: ${result.issue.expected}`);
  return result.value;
}
export const target: ParticipantsTarget = {
  connection: decode(d.connectionProfile, {
    id: "local",
    generation: "2",
    label: "Actual retained profile",
    socket: "/tmp/profile.sock",
  }),
  workspaceId: decode(d.identifier, "workspace"),
  projectId: null,
  selection: { kind: "none" },
};
export const run = {
  run_id: "run",
  revision: "9007199254740993",
  actor_id: "author",
  parent_run_id: null,
  parent_stop_policy: "continue",
  objective: "An actual external invocation",
  capabilities: ["build"],
  process_ref: null,
  worktree_ref: null,
  status: "running",
  last_observed_unix_ms: "9223372036854775807",
  evidence: "",
  session_ids: ["session-01"],
  session_associations: {
    basis: "explicit_and_history_run",
    history_head: null,
    explicit_session_ids: ["session-01"],
    total: "1",
    omitted: "0",
    next_request: null,
  },
};
export const attempt = {
  attempt_id: "attempt",
  revision: "9007199254740993",
  run_id: "run",
  ticket_id: "ticket",
  token: "7",
  state: "running",
  session_ids: [],
  checkpoints: [],
  evidence: "",
};
export const actor = {
  actor_id: "author",
  name: "An author",
  kind: "person",
  revision: "3",
  archived: false,
};
export const next = {
  method: "run.sessions",
  params: {
    workspace_id: "workspace",
    target_run_id: "run",
    head: null,
    expected_run_revision: run.revision,
    after_session_id: "session-01",
    limit: "100",
    max_bytes: "1048576",
  },
};
export function response(
  data: unknown,
  meta: unknown = { query_scope: "runs", query_revision: "9007199254740993" },
): ReadResponse {
  return { response: { data: json(data), meta: decode(c.object, meta) }, pagination: null };
}

export function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Deferred unresolved");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
