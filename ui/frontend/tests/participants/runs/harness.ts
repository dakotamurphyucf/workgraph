import { afterEach } from "vitest";
import { jsonField } from "../../../src/core/json";
import * as d from "../../../src/core/protocol/decoders";
import { createOperationController } from "../../../src/core/state/operations";
import { createParticipantsClient } from "../../../src/features/participants/runs/client";
import { createParticipantsController } from "../../../src/features/participants/runs/controller";
import type { HttpClient, HttpRequest, HttpResult } from "../../../src/core/protocol/http";
import type { FeatureContext } from "../../../src/app/types";
import type {
  ConnectionProfile,
  JsonObject,
  Operation,
  Preparation,
  ReadResponse,
} from "../../../src/core/protocol/types";
import { createTestProcessor } from "../../core/processing-harness";
import { actor, attempt, decode, json, response, run, target } from "./fixtures";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const done of cleanups.splice(0).reverse()) done();
});
export const ok = <T>(data: T): HttpResult<T> => ({ ok: true, data, httpStatus: 200 });
export function text(value: import("../../../src/core/json").JsonValue | undefined, name: string) {
  const field = value === undefined ? undefined : jsonField(value, name);
  return field?.kind === "string" ? field.value : "";
}
export function harness(
  options: {
    read?: (
      method: string,
      params: JsonObject,
      signal: AbortSignal | undefined,
    ) => Promise<HttpResult<ReadResponse>>;
    attach?: (generation: string) => Promise<
      HttpResult<{
        readonly connection: ConnectionProfile;
        readonly initialize: ReadResponse["response"];
        readonly health: ReadResponse["response"];
      }>
    >;
    prepare?: (input: Preparation) => Promise<HttpResult<Operation>>;
  } = {},
) {
  const processing = createTestProcessor(),
    calls: {
      method: string;
      params: JsonObject;
      generation: string;
      signal: AbortSignal | undefined;
    }[] = [],
    sent: Preparation[] = [];
  const defaults = (method: string, params: JsonObject): ReadResponse => {
    if (method === "run.get")
      return response(
        { ...run, run_id: text(params, "target_run_id") },
        { query_scope: "runs", history_capture: { head: null } },
      );
    if (method === "attempt.get") return response(attempt, { query_scope: "runs" });
    if (method === "run.list")
      return response(
        { items: [run], next_offset: null, omitted: "0" },
        { query_scope: "runs", query_revision: "7", history_capture: { head: null } },
      );
    if (method === "actor.list")
      return response(
        { items: [actor], offset: "0", remaining: "0", next_offset: null },
        { workspace_revision: "7" },
      );
    if (method === "ticket.read")
      return response(
        {
          ticket: {
            ticket_id: text(params, "ticket_id"),
            project_id: "actual-project",
            claim: { actor_id: "author", run_id: "run", token: "7", lease: {} },
          },
        },
        { workspace_revision: "7" },
      );
    return response(
      { items: [], offset: "0", remaining: "0", next_offset: null },
      { workspace_revision: "7" },
    );
  };
  const http: HttpClient = {
    processing,
    request: async <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
      if (request.body === undefined) throw new Error("Unexpected request without captured body");
      if (request.path.includes("/attach")) {
        const result =
          options.attach === undefined
            ? ok({
                connection: {
                  ...target.connection,
                  generation: decode(d.positiveDecimal, text(request.body, "generation")),
                },
                initialize: response({}).response,
                health: response({}).response,
              })
            : await options.attach(text(request.body, "generation"));
        if (!result.ok) return result;
        const parsed = request.codec.decode(json(result.data));
        if (!parsed.ok) throw new Error(parsed.issue.expected);
        return ok(parsed.value);
      }
      const params = jsonField(request.body, "params"),
        method = text(request.body, "method");
      if (params?.kind !== "object") throw new Error("Missing captured read params");
      calls.push({
        method,
        params,
        generation: text(request.body, "generation"),
        signal: request.signal,
      });
      const result =
        options.read === undefined
          ? ok(defaults(method, params))
          : await options.read(method, params, request.signal);
      if (!result.ok) return result;
      const value = request.codec.decode(
        d.jsonObject([
          [
            "response",
            d.jsonObject([
              ["data", result.data.response.data],
              ["meta", result.data.response.meta],
            ]),
          ],
          ["pagination", result.data.pagination ?? d.jsonNull()],
        ]),
      );
      if (!value.ok) throw new Error(value.issue.expected);
      return ok(value.value);
    },
  };
  const unexpected = (): Promise<never> =>
    Promise.reject(new Error("Unexpected operation request"));
  const operation = (input: Preparation): Operation => ({
    format: "workgraph-ui-operation-1",
    operation_id: input.intention_id,
    preparation: { ...input, connection: target.connection },
    preparation_input_hash: decode(d.digest, "a".repeat(64)),
    connection: target.connection,
    request: d.jsonObject([
      ["jsonrpc", d.jsonString("2.0")],
      ["workgraph_api", d.jsonString("0.7")],
      ["id", d.jsonString("test")],
      ["method", d.jsonString(input.method)],
      ["params", input.params],
    ]),
    journal_path: "/tmp/owned-test/request.json",
    revision: decode(d.positiveDecimal, "1"),
    state: { kind: "prepared_unsent" },
    diagnostic: null,
    receipt_lookup_supported: input.method !== "run.heartbeat",
  });
  const operations = createOperationController(
      {
        connections: unexpected,
        read: unexpected,
        inspect: unexpected,
        act: unexpected,
        prepare: (input) => {
          sent.push(input);
          return options.prepare?.(input) ?? Promise.resolve(ok(operation(input)));
        },
      },
      processing,
    ),
    controller = createParticipantsController({ http, operations });
  const context: FeatureContext = {
    client: http,
    connection: target.connection,
    profileState: "current",
    route: {
      view: "participants",
      connectionId: target.connection.id,
      workspaceId: target.workspaceId,
      projectId: "display-project",
      entityId: null,
    },
    writer: { actorId: "author", runId: "run" },
    navigate: () => undefined,
  };
  cleanups.push(() => {
    controller.dispose();
    operations.dispose();
    processing.dispose();
  });
  return {
    http,
    api: createParticipantsClient(http),
    controller,
    operations,
    context,
    calls,
    sent,
    defaults,
    operation,
  };
}
