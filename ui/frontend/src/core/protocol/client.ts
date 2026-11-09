import * as c from "./codec";
import * as d from "./decoders";
import type { HttpClient, HttpResult } from "./http";
import type {
  ConnectionProfile,
  DraftContext,
  Identifier,
  Operation,
  Preparation,
  ReadInvocation,
  ReadResponse,
} from "./types";

export type OperationAction = "execute" | "retry" | "recover";
export interface Companion {
  readonly connections: (
    signal?: AbortSignal,
  ) => Promise<HttpResult<{ readonly items: readonly ConnectionProfile[] }>>;
  readonly read: (
    invocation: ReadInvocation,
    signal?: AbortSignal,
  ) => Promise<HttpResult<ReadResponse>>;
  readonly prepare: (preparation: Preparation) => Promise<HttpResult<Operation>>;
  readonly inspect: (id: Identifier, signal?: AbortSignal) => Promise<HttpResult<Operation>>;
  /** Explicit action only. A browser selection change never cancels admitted work. */
  readonly act: (id: Identifier, action: OperationAction) => Promise<HttpResult<Operation>>;
}
export function contextJson(context: DraftContext) {
  const nullableId = (id: Identifier | null) =>
    id === null ? { kind: "null" as const } : d.jsonString(id);
  return d.jsonObject([
    ["workspace_id", nullableId(context.workspace_id)],
    ["project_id", nullableId(context.project_id)],
    [
      "writer",
      d.jsonObject([
        ["actor_id", d.jsonString(context.writer.actor_id)],
        ["run_id", nullableId(context.writer.run_id)],
      ]),
    ],
  ]);
}
export function preparationJson(preparation: Preparation) {
  return d.jsonObject([
    ["intention_id", d.jsonString(preparation.intention_id)],
    ["context", contextJson(preparation.context)],
    ["connection_id", d.jsonString(preparation.connection_id)],
    ["generation", d.jsonString(preparation.generation)],
    ["method", d.jsonString(preparation.method)],
    ["params", preparation.params],
  ]);
}
export function createCompanion(http: HttpClient): Companion {
  return {
    connections: (signal) =>
      http.request({
        path: "/connections",
        method: "GET",
        codec: c.record({ items: c.array(d.connectionProfile, 100) }),
        ...(signal === undefined ? {} : { signal }),
      }),
    read: (invocation, signal) =>
      http.request({
        path: "/read",
        method: "POST",
        codec: d.readResponse,
        body: d.jsonObject([
          ["connection_id", d.jsonString(invocation.connection_id)],
          ["generation", d.jsonString(invocation.generation)],
          ["method", d.jsonString(invocation.method)],
          ["params", invocation.params],
          ["lane", d.jsonString(invocation.lane)],
        ]),
        ...(signal === undefined ? {} : { signal }),
      }),
    prepare: (preparation) =>
      http.request({
        path: "/operations/prepare",
        method: "POST",
        body: preparationJson(preparation),
        codec: d.operation,
        responseBudget: "operation",
      }),
    inspect: (id, signal) =>
      http.request({
        path: `/operations/${encodeURIComponent(id)}`,
        method: "GET",
        codec: d.operation,
        responseBudget: "operation",
        ...(signal === undefined ? {} : { signal }),
      }),
    act: (id, action) =>
      http.request({
        path: `/operations/${encodeURIComponent(id)}/${action}`,
        method: "POST",
        body: d.jsonObject([]),
        codec: d.operation,
        responseBudget: "operation",
      }),
  };
}
