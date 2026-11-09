import * as c from "../../core/protocol/codec";
import * as d from "../../core/protocol/decoders";
import type { HttpClient, HttpResult } from "../../core/protocol/http";
import type { ConnectionProfile, Identifier } from "../../core/protocol/types";
import type { DaemonCapabilities, Launch, LaunchPlan, LaunchState, ObserverContext } from "./types";

const absolutePath = c.refine(
  c.text,
  (value) => value.startsWith("/") && !value.includes("\0"),
  "absolute host path",
);
const contextCodec: c.Codec<ObserverContext> = c.record({
  workspace_id: c.nullable(d.identifier),
  project_id: c.nullable(d.identifier),
  writer: c.nullable(c.record({ actor_id: d.identifier, run_id: c.nullable(d.identifier) })),
});
const planCodec: c.Codec<LaunchPlan> = c.record({
  intention_id: d.identifier,
  connection: d.connectionProfile,
  context: contextCodec,
  registry: absolutePath,
  log: absolutePath,
  timeout_seconds: c.refine(
    d.decimal,
    (value) => BigInt(value) >= 1n && BigInt(value) <= 300n,
    "1..300 seconds",
  ),
});
const observation: c.Codec<
  "existing_endpoint" | "startup_attempt_observed_ready" | "observed_competition"
> = {
  decode: (value, path = []) => {
    const result = c.text.decode(value, path);
    if (!result.ok) return result;
    const found = result.value;
    return found === "existing_endpoint" ||
      found === "startup_attempt_observed_ready" ||
      found === "observed_competition"
      ? { ok: true, value: found }
      : c.mismatch(path, "known readiness observation");
  },
};
const launchState: c.Codec<LaunchState> = c.tagged<LaunchState>("status", {
  prepared_unsent: c.record({ status: c.literal("prepared_unsent") }),
  starting: c.record({ status: c.literal("starting") }),
  outcome_unknown: c.record({ status: c.literal("outcome_unknown"), problem: d.problem }),
  ready: c.record({
    status: c.literal("ready"),
    observation,
    ownership: c.literal("unknown"),
    listing: d.publicResponse,
  }),
});
export const launchCodec: c.Codec<Launch> = c.record({
  plan: planCodec,
  executable: absolutePath,
  input_hash: d.digest,
  revision: d.positiveDecimal,
  state: launchState,
  diagnostic: c.nullable(d.problem),
});
export const capabilitiesCodec: c.Codec<DaemonCapabilities> = c.record({
  available: c.boolean,
  executable: absolutePath,
  version: c.nullable(c.text),
  problem: c.nullable(d.problem),
});
export function contextJson(context: ObserverContext) {
  const nullable = (value: string | null) =>
    value === null ? { kind: "null" as const } : d.jsonString(value);
  return d.jsonObject([
    ["workspace_id", nullable(context.workspace_id)],
    ["project_id", nullable(context.project_id)],
    [
      "writer",
      context.writer === null
        ? { kind: "null" }
        : d.jsonObject([
            ["actor_id", d.jsonString(context.writer.actor_id)],
            ["run_id", nullable(context.writer.run_id)],
          ]),
    ],
  ]);
}
export function sameLaunchPlan(left: LaunchPlan, right: LaunchPlan): boolean {
  return (
    left.intention_id === right.intention_id &&
    left.connection.id === right.connection.id &&
    left.connection.generation === right.connection.generation &&
    left.connection.socket === right.connection.socket &&
    left.connection.label === right.connection.label &&
    left.registry === right.registry &&
    left.log === right.log &&
    left.timeout_seconds === right.timeout_seconds &&
    left.context.workspace_id === right.context.workspace_id &&
    left.context.project_id === right.context.project_id &&
    (left.context.writer === null
      ? right.context.writer === null
      : right.context.writer !== null &&
        left.context.writer.actor_id === right.context.writer.actor_id &&
        left.context.writer.run_id === right.context.writer.run_id)
  );
}
function bindLaunch(
  result: HttpResult<Launch>,
  identity: Identifier,
  plan?: LaunchPlan,
): HttpResult<Launch> {
  if (!result.ok) return result;
  if (
    result.data.plan.intention_id !== identity ||
    (plan !== undefined && !sameLaunchPlan(plan, result.data.plan))
  )
    return {
      ok: false,
      failure: {
        kind: "protocol",
        message: "Companion returned another captured startup plan; saved identity was preserved.",
        issue: undefined,
      },
    };
  return result;
}
export function createConnectionsClient(http: HttpClient) {
  return {
    launches: (offset = "0", signal?: AbortSignal) =>
      http.request({
        path: `/daemon-launches?offset=${offset}&limit=100`,
        method: "GET",
        codec: c.record({
          items: c.array(
            c.record({
              intention_id: d.identifier,
              connection: d.connectionProfile,
              registry: absolutePath,
              log: absolutePath,
              revision: d.positiveDecimal,
              status: c.text,
            }),
            100,
          ),
          offset: d.decimal,
          remaining: d.decimal,
          next_offset: c.nullable(d.decimal),
        }),
        ...(signal === undefined ? {} : { signal }),
      }),
    capabilities: (signal?: AbortSignal) =>
      http.request({
        path: "/daemon-capabilities",
        method: "GET",
        codec: capabilitiesCodec,
        ...(signal === undefined ? {} : { signal }),
      }),
    save: (input: {
      readonly id: Identifier;
      readonly label: string;
      readonly socket: string;
      readonly previous: ConnectionProfile | null;
    }) =>
      http.request({
        path: input.previous === null ? "/connections" : `/connections/${input.id}`,
        method: input.previous === null ? "POST" : "PUT",
        codec: d.connectionProfile,
        body: d.jsonObject([
          [
            input.previous === null ? "id" : "expected_generation",
            d.jsonString(input.previous?.generation ?? input.id),
          ],
          ["label", d.jsonString(input.label)],
          ["socket", d.jsonString(input.socket)],
        ]),
      }),
    attach: (profile: ConnectionProfile, signal?: AbortSignal) =>
      http.request({
        path: `/connections/${profile.id}/attach`,
        method: "POST",
        body: d.jsonObject([["generation", d.jsonString(profile.generation)]]),
        codec: c.record({
          connection: d.connectionProfile,
          initialize: d.publicResponse,
          health: d.publicResponse,
        }),
        ...(signal === undefined ? {} : { signal }),
      }),
    prepareLaunch: async (plan: LaunchPlan) =>
      bindLaunch(
        await http.request({
          path: "/daemon-launches/prepare",
          method: "POST",
          responseBudget: "operation",
          codec: launchCodec,
          body: d.jsonObject([
            ["intention_id", d.jsonString(plan.intention_id)],
            ["connection_id", d.jsonString(plan.connection.id)],
            ["generation", d.jsonString(plan.connection.generation)],
            ["context", contextJson(plan.context)],
            ["registry", d.jsonString(plan.registry)],
            ["log", d.jsonString(plan.log)],
            ["timeout_seconds", d.jsonString(plan.timeout_seconds)],
          ]),
        }),
        plan.intention_id,
        plan,
      ),
    launchAction: async (plan: LaunchPlan, action: "start" | "retry") =>
      bindLaunch(
        await http.request({
          path: `/daemon-launches/${plan.intention_id}/${action}`,
          method: "POST",
          body: d.jsonObject([]),
          codec: launchCodec,
          responseBudget: "operation",
        }),
        plan.intention_id,
        plan,
      ),
    inspectLaunch: async (id: Identifier, plan?: LaunchPlan, signal?: AbortSignal) =>
      bindLaunch(
        await http.request({
          path: `/daemon-launches/${id}`,
          method: "GET",
          codec: launchCodec,
          responseBudget: "operation",
          ...(signal === undefined ? {} : { signal }),
        }),
        id,
        plan,
      ),
  };
}
