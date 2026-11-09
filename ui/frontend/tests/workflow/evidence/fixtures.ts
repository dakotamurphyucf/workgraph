import { afterEach } from "vitest";
import { jsonField } from "../../../src/core/json";
import * as d from "../../../src/core/protocol/decoders";
import type { Companion } from "../../../src/core/protocol/client";
import type { HttpClient, HttpRequest, HttpResult } from "../../../src/core/protocol/http";
import type {
  JsonObject,
  Operation,
  Preparation,
  ReadResponse,
} from "../../../src/core/protocol/types";
import { createOperationController } from "../../../src/core/state/operations";
import { createEvidenceController } from "../../../src/features/workflow/evidence/controller";
import { createTestProcessor } from "../../core/processing-harness";
import { context, decode, json } from "../../work/actions-fixtures";
export { context, decode, json };
const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0).reverse()) dispose();
});
export const policy = {
  ticket_id: "target",
  digest: "a".repeat(64),
  project_id: "actual-project",
  membership_revision: "9007199254740993",
  ownership_token: "7",
  sources: [{ scope: { kind: "ticket", ticket_id: "target" }, revision: "1" }],
  reviewers: [{ kind: "actor", actor_id: "reviewer" }],
  validators: ["checks"],
  criteria: [
    {
      reference: {
        scope: { kind: "ticket", ticket_id: "target" },
        policy_revision: "1",
        key: "checks",
      },
      criterion: { key: "checks", description: "Actual checks passed", required: true },
    },
  ],
  separate_actor: true,
  applied_override: null,
  stale_override: null,
  minimum_reopening_token: null,
};
export const localPolicy = {
  scope: { kind: "ticket", ticket_id: "target" },
  revision: "1",
  enabled: true,
  reviewers: policy.reviewers,
  validators: policy.validators,
  criteria: [policy.criteria[0]?.criterion],
  separate_actor: true,
  inherited_override: null,
};
export const evidenceData = {
  ticket_id: "target",
  effective_policy: policy,
  policy: localPolicy,
  manifest: null,
  submission: null,
  assertions: [],
  reviews: [],
  reconciliations: [],
  decisions: [],
};
export const ticketData = {
  ticket_id: "target",
  project_id: "actual-project",
  membership_revision: "9007199254740993",
  claim: { actor_id: "author", run_id: "run-one", token: "7", lease: {} },
};
export function response(
  data: unknown,
  revision = "9007199254740993",
  scope = "evidence",
  pagination: unknown = null,
): ReadResponse {
  return {
    response: {
      data: json(data),
      meta: json({ query_revision: revision, query_scope: scope }) as JsonObject,
    },
    pagination: pagination === null ? null : (json(pagination) as JsonObject),
  };
}
export const ok = <T>(data: T): HttpResult<T> => ({ ok: true, httpStatus: 200, data });
export function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Uninitialized deferred");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function observed(preparation: Preparation): Operation {
  return {
    format: "workgraph-ui-operation-1",
    operation_id: preparation.intention_id,
    preparation: {
      ...preparation,
      connection: decode(d.connectionProfile, {
        id: "local",
        generation: "1",
        label: "Synthetic",
        socket: "/tmp/synthetic.sock",
      }),
    },
    preparation_input_hash: decode(d.digest, "a".repeat(64)),
    connection: decode(d.connectionProfile, {
      id: "local",
      generation: "1",
      label: "Synthetic",
      socket: "/tmp/synthetic.sock",
    }),
    request: d.jsonObject([
      ["jsonrpc", d.jsonString("2.0")],
      ["workgraph_api", d.jsonString("0.7")],
      ["id", d.jsonString("test")],
      ["method", d.jsonString(preparation.method)],
      ["params", preparation.params],
    ]),
    journal_path: "/tmp/test/request.json",
    revision: decode(d.positiveDecimal, "1"),
    state: { kind: "prepared_unsent" },
    diagnostic: null,
    receipt_lookup_supported: true,
  };
}
export function read(
  value: import("../../../src/core/json").JsonValue | undefined,
  name: string,
): string {
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
    prepare?: Companion["prepare"];
  } = {},
) {
  const processing = createTestProcessor(),
    sent: Preparation[] = [];
  disposals.push(() => processing.dispose());
  const client: HttpClient = {
    processing,
    request: async <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
      if (request.body === undefined) throw new Error("Missing read invocation");
      const method = read(request.body, "method"),
        params = jsonField(request.body, "params");
      if (params?.kind !== "object") throw new Error("Missing parameters");
      const result =
        options.read === undefined
          ? ok(
              response(
                method === "evidence.context"
                  ? evidenceData
                  : method === "review.gate"
                    ? { allowed: false, problem: { kind: "blocked", message: "Needs review" } }
                    : { ticket: ticketData },
              ),
            )
          : await options.read(method, params, request.signal);
      if (!result.ok) return result;
      const decoded = request.codec.decode(
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
      if (!decoded.ok) throw new Error(decoded.issue.expected);
      return ok(decoded.value);
    },
  };
  const unexpected = (): Promise<never> => Promise.reject(new Error("Unexpected operation action"));
  const operations = createOperationController(
    {
      connections: unexpected,
      read: unexpected,
      inspect: unexpected,
      act: unexpected,
      prepare:
        options.prepare ??
        ((preparation) => {
          sent.push(preparation);
          const value = observed(preparation);
          return Promise.resolve(
            ok({
              ...value,
              request: d.jsonObject([
                ["jsonrpc", d.jsonString("2.0")],
                ["workgraph_api", d.jsonString("0.7")],
                ["id", d.jsonString("test")],
                ["method", d.jsonString(preparation.method)],
                ["params", preparation.params],
              ]),
            }),
          );
        }),
    },
    processing,
  );
  const controller = createEvidenceController({ http: client, operations });
  disposals.push(
    () => operations.dispose(),
    () => controller.dispose(),
  );
  return { processing, client, operations, controller, sent, context: context(client) };
}
