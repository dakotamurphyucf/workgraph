import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type { JsonValue } from "../../../core/json";
import type { HttpClient, HttpResult } from "../../../core/protocol/http";
import * as codecs from "./codecs";
import type { ExecutionClient, PublicationPlan } from "./types";
const text = d.jsonString;
const obj = d.jsonObject;
export const planJson = (plan: PublicationPlan): JsonValue => {
  const common: (readonly [string, JsonValue])[] = [
    ["kind", text(plan.kind)],
    ["intention_id", text(plan.intention_id)],
    ["directory", text(plan.directory)],
    [
      "connection",
      obj([
        ["id", text(plan.connection.id)],
        ["generation", text(plan.connection.generation)],
        ["socket", text(plan.connection.socket)],
        ["label", text(plan.connection.label)],
      ]),
    ],
  ];
  if (plan.kind === "operator_bound_external")
    return obj([...common, ["intent_digest", text(plan.intent_digest)]]);
  return obj([
    ...common,
    ["capture_digest", text(plan.capture_digest)],
    [
      "context",
      obj([
        [
          "workspace_id",
          plan.context.workspace_id === null ? d.jsonNull() : text(plan.context.workspace_id),
        ],
        [
          "project_id",
          plan.context.project_id === null ? d.jsonNull() : text(plan.context.project_id),
        ],
        [
          "writer",
          obj([
            ["actor_id", text(plan.context.writer.actor_id)],
            [
              "run_id",
              plan.context.writer.run_id === null ? d.jsonNull() : text(plan.context.writer.run_id),
            ],
          ]),
        ],
      ]),
    ],
    [
      "params",
      obj(
        Object.entries(plan.params).flatMap(([name, value]) =>
          value === undefined ? [] : [[name, text(value)] as const],
        ),
      ),
    ],
  ]);
};
const bad = (message: string): HttpResult<never> => ({
  ok: false,
  failure: { kind: "protocol", message, issue: undefined },
});
export function createExecutionClient(http: HttpClient): ExecutionClient {
  async function jobAction(id: import("../../../core/protocol/types").Identifier, action: string) {
    const result = await http.request({
      method: "POST",
      path: `/execution-publications/${encodeURIComponent(id)}/${action}`,
      body: obj([]),
      codec: codecs.job,
      responseBudget: "operation",
    });
    return result.ok && result.data.plan.intention_id !== id
      ? bad("Publication action returned another intention.")
      : result;
  }
  return {
    inspectStage: async (target, signal) => {
      const directory = target.directory;
      const result = await http.request({
        method: "POST",
        path: "/execution-stages/inspect",
        body: obj([["directory", text(directory)]]),
        codec: codecs.stage,
        signal,
      });
      return result.ok && result.data.directory !== directory
        ? bad("Stage response named another host directory.")
        : result;
    },
    inspectOutput: async (target, stream, selection, signal) => {
      const directory = target.directory,
        digest = target.capture_digest;
      const captured = Object.freeze({ ...selection });
      const body = obj([
        ["directory", text(directory)],
        ["capture_digest", text(digest)],
        ["stream", text(stream)],
        [
          "selection",
          obj([
            ["kind", text(captured.kind)],
            ["length", text(captured.length)],
            ...(captured.kind === "range" ? [["offset", text(captured.offset)] as const] : []),
          ]),
        ],
      ]);
      const result = await http.request({
        method: "POST",
        path: "/execution-stages/output",
        body,
        codec: codecs.inspected,
        signal,
      });
      return result.ok &&
        (result.data.directory !== directory ||
          result.data.capture_digest !== digest ||
          result.data.stream !== stream ||
          result.data.selection !== captured.kind ||
          (captured.kind === "range" && result.data.offset !== captured.offset) ||
          BigInt(result.data.returned_bytes) > BigInt(captured.length))
        ? bad("Output response differs from the exact requested stage, stream or range.")
        : result;
    },
    inspectIntent: async (target, signal) => {
      const directory = target.directory;
      const result = await http.request({
        method: "POST",
        path: "/execution-stages/intent",
        body: obj([["directory", text(directory)]]),
        codec: codecs.externalIntent,
        signal,
      });
      return result.ok && result.data.directory !== directory
        ? bad("Native intent response named another host directory.")
        : result;
    },
    prepare: async (plan, signal) => {
      const body = planJson(plan);
      const expected = codecs.plan.decode(body);
      if (!expected.ok)
        return { ok: false, failure: { kind: "input", message: expected.issue.expected } };
      const result = await http.request({
        method: "POST",
        path: "/execution-publications/prepare",
        body,
        codec: codecs.job,
        ...(signal === undefined ? {} : { signal }),
      });
      if (!result.ok) return result;
      const [before, after] = await Promise.all([
        http.processing.encode(body, {
          canonical: true,
          ...(signal === undefined ? {} : { signal }),
        }),
        http.processing.encode(planJson(result.data.plan), {
          canonical: true,
          ...(signal === undefined ? {} : { signal }),
        }),
      ]);
      if (signal?.aborted) return { ok: false, failure: { kind: "aborted" } };
      for (const encoded of [before, after]) {
        if (!encoded.ok)
          return encoded.failure.kind === "aborted"
            ? { ok: false, failure: { kind: "aborted" } }
            : bad(encoded.failure.message);
        if (!encoded.value.ok) return bad(encoded.value.error.message);
      }
      if (!before.ok || !after.ok || !before.value.ok || !after.value.ok)
        throw new Error("Verified publication association lost its encoded values.");
      return before.value.value === after.value.value
        ? result
        : bad("Prepared publication returned different captured input.");
    },
    start: (id) => jobAction(id, "start"),
    retryExact: (id) => jobAction(id, "retry-exact"),
    recover: (id) => jobAction(id, "recover"),
    inspect: async (id, signal) => {
      const result = await http.request({
        method: "GET",
        path: `/execution-publications/${encodeURIComponent(id)}`,
        codec: codecs.job,
        responseBudget: "operation",
        signal,
      });
      return result.ok && result.data.plan.intention_id !== id
        ? bad("Publication inspection returned another intention.")
        : result;
    },
    list: (offset, signal) =>
      http.request({
        method: "GET",
        path: `/execution-publications?offset=${offset}&limit=25`,
        codec: c.record({
          items: c.array(codecs.summary, 25),
          next_offset: c.nullable(d.decimal),
          total: d.decimal,
        }),
        signal,
      }),
    cleanup: (target, signal) =>
      http.request({
        method: "POST",
        path: "/execution-stages/cleanup",
        body: obj([
          ["directory", text(target.directory)],
          ["owner_token", text(target.owner_token)],
        ]),
        codec: c.record({ directory: codecs.hostPath, cleaned: c.literal(true) }),
        ...(signal === undefined ? {} : { signal }),
      }),
  };
}
