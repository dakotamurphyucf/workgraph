import type { FeatureContext, Route } from "../../app/types";
import { canonicalJson, jsonField, type JsonValue } from "../../core/json";
import * as d from "../../core/protocol/decoders";
import * as c from "../../core/protocol/codec";
import type { Decimal, Identifier, JsonObject, ReadInvocation } from "../../core/protocol/types";
import { field } from "./codecs";
import type { AttentionFilter, DigestItem, DigestQuery, OverviewScope } from "./types";

export class OverviewInputError extends Error {}
export function identifier(value: string, label: string): Identifier {
  const result = d.identifier.decode(d.jsonString(value));
  if (!result.ok) throw new OverviewInputError(`${label} must be a valid identifier.`);
  return result.value;
}
export function counter(
  value: string,
  label: string,
  min = 0n,
  max = 4611686018427387903n,
): Decimal {
  const result = d.decimal.decode(d.jsonString(value));
  if (!result.ok || BigInt(value) < min || BigInt(value) > max)
    throw new OverviewInputError(`${label} must be a canonical integer from ${min} to ${max}.`);
  return result.value;
}
export function captureScope(context: FeatureContext): OverviewScope {
  if (context.route.workspaceId === null) throw new OverviewInputError("Select a workspace.");
  return Object.freeze({
    connection: Object.freeze({ ...context.connection }),
    workspaceId: identifier(context.route.workspaceId, "Workspace"),
    projectId:
      context.route.projectId === null ? null : identifier(context.route.projectId, "Project"),
    actorId: context.writer.actorId === null ? null : identifier(context.writer.actorId, "Actor"),
    runId: context.writer.runId === null ? null : identifier(context.writer.runId, "Run"),
  });
}
export function scopeKey(scope: OverviewScope): string {
  return JSON.stringify([
    scope.connection.id,
    scope.connection.generation,
    scope.connection.socket,
    scope.workspaceId,
    scope.projectId,
    scope.actorId,
    scope.runId,
  ]);
}
/** Small bounded selector objects only; large content never enters this path. */
export function queryKey(scope: OverviewScope, request: ReadInvocation): string {
  const encoded = canonicalJson(request.params, {
    maxBytes: 16384,
    maxDepth: 8,
    maxNodes: 256,
    maxStringBytes: 8192,
  });
  if (!encoded.ok) throw new OverviewInputError("Query selectors exceed their local bound.");
  return JSON.stringify([scopeKey(scope), request.method, encoded.value]);
}
export const defaultAttention: AttentionFilter = Object.freeze({
  kinds: Object.freeze(["ticket", "fact", "readiness"] as const),
  recipient: null,
  consumerId: "workgraph-ui-attention-observer",
  excludeSelf: false,
});
export const defaultDigest: DigestQuery = Object.freeze({
  ticketId: "",
  after: "0",
  limit: "25",
  maxBytes: "65536",
});
export function captureFilter(filter: AttentionFilter): AttentionFilter {
  if (
    filter.kinds.length === 0 ||
    filter.kinds.length > 4 ||
    new Set(filter.kinds).size !== filter.kinds.length ||
    filter.kinds.some((k) => !["ticket", "fact", "readiness", "communication"].includes(k))
  )
    throw new OverviewInputError("Select one to four distinct attention sources.");
  const communication = filter.kinds.includes("communication");
  if (filter.recipient !== null && !["actor", "run"].includes(filter.recipient.kind))
    throw new OverviewInputError("Choose an actor or run recipient.");
  if (communication && filter.recipient === null)
    throw new OverviewInputError(
      "Received notifications require an explicit actor or run recipient.",
    );
  if (!communication && filter.excludeSelf)
    throw new OverviewInputError(
      "Self filtering requires received notifications and their recipient.",
    );
  return Object.freeze({
    kinds: Object.freeze([...filter.kinds]),
    recipient:
      communication && filter.recipient !== null
        ? Object.freeze({
            kind: filter.recipient.kind,
            id: identifier(filter.recipient.id, "Recipient"),
          })
        : null,
    consumerId: identifier(filter.consumerId, "Observer consumer"),
    excludeSelf: filter.excludeSelf,
  });
}
export function captureDigest(query: DigestQuery): DigestQuery {
  return Object.freeze({
    ticketId: query.ticketId === "" ? "" : identifier(query.ticketId, "Ticket"),
    after: counter(query.after, "After revision"),
    limit: counter(query.limit, "Page size", 1n, 100n),
    maxBytes: counter(query.maxBytes, "Byte budget", 4096n, 1048576n),
  });
}
type Pair = readonly [string, JsonValue];
export function invocation(
  scope: OverviewScope,
  method: string,
  fields: readonly Pair[],
  lane: ReadInvocation["lane"] = "visible",
): ReadInvocation {
  if (fields.some(([key]) => key === "workspace_id"))
    throw new Error("Workspace may appear only once in a captured query.");
  const request = Object.freeze({
    connection_id: scope.connection.id,
    generation: scope.connection.generation,
    method,
    lane,
    params: d.jsonObject([["workspace_id", d.jsonString(scope.workspaceId)], ...fields]),
  });
  queryKey(scope, request);
  return request;
}
export function summaryInvocation(scope: OverviewScope): ReadInvocation {
  return invocation(scope, scope.projectId === null ? "workspace.overview" : "project.brief", [
    ...(scope.projectId === null
      ? [
          ...(scope.actorId === null ? [] : [["actor_id", d.jsonString(scope.actorId)] as const]),
          ...(scope.runId === null ? [] : [["run_id", d.jsonString(scope.runId)] as const]),
        ]
      : [["project_id", d.jsonString(scope.projectId)] as const]),
    ["limit", d.jsonString("8")],
    ["max_bytes", d.jsonString("65536")],
  ]);
}
export function coordinationInvocation(scope: OverviewScope, questions = false): ReadInvocation {
  return invocation(scope, "coordinator.overview", [
    ...(scope.projectId === null ? [] : [["project_id", d.jsonString(scope.projectId)] as const]),
    ...(scope.actorId === null ? [] : [["actor_id", d.jsonString(scope.actorId)] as const]),
    ...(scope.runId === null ? [] : [["run_id", d.jsonString(scope.runId)] as const]),
    ...(questions ? [["kinds", d.jsonArray([d.jsonString("unanswered_request")])] as const] : []),
    ["limit", d.jsonString(questions ? "1" : "25")],
    ["max_bytes", d.jsonString("65536")],
  ]);
}
export function attentionInvocation(
  scope: OverviewScope,
  filter: AttentionFilter,
  options: {
    readonly cursor?: string;
    readonly readinessCursor?: string;
    readonly wait?: boolean;
  } = {},
): ReadInvocation {
  const selected = captureFilter(filter);
  return invocation(
    scope,
    options.wait ? "attention.wait" : "attention.read",
    [
      [
        "filter",
        d.jsonObject([
          ...(scope.projectId === null
            ? []
            : [["project_id", d.jsonString(scope.projectId)] as const]),
          ...(scope.runId === null ? [] : [["run_id", d.jsonString(scope.runId)] as const]),
          ["kinds", d.jsonArray(selected.kinds.map(d.jsonString))],
          ...(selected.recipient === null
            ? []
            : [
                [
                  "recipient",
                  d.jsonObject([
                    ["kind", d.jsonString(selected.recipient.kind)],
                    ["id", d.jsonString(selected.recipient.id)],
                  ]),
                ] as const,
                ["consumer_id", d.jsonString(selected.consumerId)] as const,
                ["exclude_self", d.jsonBoolean(selected.excludeSelf)] as const,
              ]),
        ]),
      ],
      ["limit", d.jsonString("25")],
      ["max_bytes", d.jsonString("65536")],
      ...(options.cursor === undefined ? [] : [["cursor", d.jsonString(options.cursor)] as const]),
      ...(options.readinessCursor === undefined
        ? []
        : [["readiness_cursor", d.jsonString(options.readinessCursor)] as const]),
      ...(options.cursor !== undefined || options.readinessCursor !== undefined
        ? []
        : [["initial_readiness", d.jsonBoolean(true)] as const]),
      ...(options.wait ? [["timeout_ms", d.jsonString("25000")] as const] : []),
    ],
    options.wait ? "wait" : "visible",
  );
}
export function digestInvocation(scope: OverviewScope, query: DigestQuery): ReadInvocation {
  const captured = captureDigest(query);
  const selected =
    captured.ticketId !== ""
      ? d.jsonObject([
          ["kind", d.jsonString("ticket")],
          ["ticket_id", d.jsonString(captured.ticketId)],
        ])
      : scope.projectId === null
        ? d.jsonObject([["kind", d.jsonString("workspace")]])
        : d.jsonObject([
            ["kind", d.jsonString("project")],
            ["project_id", d.jsonString(scope.projectId)],
          ]);
  return invocation(
    scope,
    "activity.digest",
    [
      ["scope", selected],
      ["after", d.jsonString(captured.after)],
      ["limit", d.jsonString(captured.limit)],
      ["max_bytes", d.jsonString(captured.maxBytes)],
    ],
    "history",
  );
}
/** Preserve every captured selector, changing only the documented cursor fields. */
export function cursorInvocation(request: ReadInvocation, cursor: string): ReadInvocation {
  if (cursor.length === 0 || cursor.length > 4096)
    throw new OverviewInputError("Invalid captured continuation.");
  return Object.freeze({
    ...request,
    params: d.jsonObject([
      ...request.params.fields
        .filter((f) => !["cursor", "after"].includes(f.name))
        .map((f) => [f.name, f.value] as const),
      ["cursor", d.jsonString(cursor)],
    ]),
  });
}

function baseRoute(scope: OverviewScope): Omit<Route, "view"> {
  return {
    connectionId: scope.connection.id,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    entityId: null,
  };
}
/** Open the normal ticket inspector while verifying the captured endpoint before edits. */
export function ticketRoute(scope: OverviewScope, id: string): Route {
  return {
    ...baseRoute(scope),
    view: "work",
    entityId: identifier(id, "Ticket"),
    workbench: { generation: scope.connection.generation, socket: scope.connection.socket },
  };
}

export function sourceRoute(
  scope: OverviewScope,
  source: JsonObject,
  item?: DigestItem,
): Route | null {
  const kind = field(source, "kind");
  if (kind === "ticket" || kind === "submission" || kind === "handoff") {
    const id = field(source, "ticket_id");
    return id === null ? null : ticketRoute(scope, id);
  }
  if (kind === "request") {
    const id = field(source, "request_id"),
      revision = field(source, "revision");
    return id === null
      ? null
      : {
          ...baseRoute(scope),
          view: "discussions",
          requests: {
            kind: "request",
            generation: scope.connection.generation,
            requestId: identifier(id, "Request"),
            revision: revision === null ? null : counter(revision, "Request revision", 1n),
          },
        };
  }
  if (kind === "comment") {
    const id = field(source, "comment_id"),
      revision = field(source, "revision");
    return id === null || revision === null
      ? null
      : {
          ...baseRoute(scope),
          view: "discussions",
          entityId: identifier(id, "Comment"),
          discussion: {
            kind: "comment",
            generation: scope.connection.generation,
            revision: counter(revision, "Comment revision", 1n),
          },
        };
  }
  if (kind === "run" || kind === "attempt" || kind === "run_budget" || kind === "reconciliation") {
    const selected = kind === "attempt" || kind === "reconciliation" ? "attempt" : "run",
      id = field(source, `${selected}_id`);
    return id === null
      ? null
      : {
          ...baseRoute(scope),
          view: "participants",
          entityId: identifier(id, selected),
          participant: { kind: selected, generation: scope.connection.generation },
        };
  }
  if (kind === "resource_version") {
    const value = jsonField(source, "resource");
    if (value?.kind !== "object") return null;
    const pin = c
      .record({ resource_id: d.identifier, revision: d.positiveDecimal, digest: d.digest })
      .decode(value);
    if (!pin.ok) return null;
    return {
      ...baseRoute(scope),
      view: "resources",
      entityId: pin.value.resource_id,
      resource: {
        generation: scope.connection.generation,
        content: { version: pin.value.revision, expectedDigest: pin.value.digest },
      },
    };
  }
  // Fact scope/key routes do not encode historical fact versions. Preserve the
  // exact source in Raw instead of silently offering a current value as history.
  if (kind === "planning_change" && item?.kind === "request") return null;
  return null;
}
