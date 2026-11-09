import * as c from "../../core/protocol/codec";
import * as d from "../../core/protocol/decoders";
import type { HttpClient, HttpResult } from "../../core/protocol/http";
import type { Identifier, Problem } from "../../core/protocol/types";
import { contextJson } from "../connections/client";
import type { ExportJob, LocalAction, LocalJob, LocalPlan, LocalState } from "./types";

function choice<const T extends readonly string[]>(values: T): c.Codec<T[number]> {
  return {
    decode: (value, path = []) => {
      const result = c.text.decode(value, path);
      if (!result.ok) return result;
      const found = values.find((item) => item === result.value);
      return found === undefined
        ? c.mismatch(path, values.join(" | "))
        : { ok: true, value: found };
    },
  };
}
const hostPath = c.refine(
  c.text,
  (value) => value.startsWith("/") && !value.includes("\0"),
  "absolute host path",
);
const actionCodec: c.Codec<LocalAction> = c.tagged<LocalAction>("kind", {
  migrate_0_6_2: c.record({
    kind: c.literal("migrate_0_6_2"),
    source: hostPath,
    destination: hostPath,
  }),
  cleanup_stage: c.record({
    kind: c.literal("cleanup_stage"),
    stage: hostPath,
    owner_token: d.digest,
  }),
});
const planCodec: c.Codec<LocalPlan> = c.record({
  intention_id: d.identifier,
  context: c.record({
    workspace_id: c.nullable(d.identifier),
    project_id: c.nullable(d.identifier),
    writer: c.nullable(c.record({ actor_id: d.identifier, run_id: c.nullable(d.identifier) })),
  }),
  action: actionCodec,
});
const stateCodec: c.Codec<LocalState> = c.tagged<LocalState>("status", {
  prepared_unsent: c.record({ status: c.literal("prepared_unsent") }),
  running: c.record({ status: c.literal("running") }),
  canceled_unsent: c.record({ status: c.literal("canceled_unsent") }),
  failed: c.record({ status: c.literal("failed"), problem: d.problem }),
  outcome_unknown: c.record({ status: c.literal("outcome_unknown"), problem: d.problem }),
  succeeded: c.record({
    status: c.literal("succeeded"),
    summary: c.object,
    report: c.nullable(
      c.record({ path: hostPath, sha256: d.digest, byte_count: d.positiveDecimal }),
    ),
  }),
});
const localJobShape: c.Codec<LocalJob> = c.record({
  plan: planCodec,
  execution_action: actionCodec,
  input_hash: d.digest,
  revision: d.positiveDecimal,
  cancel_requested: c.boolean,
  state: stateCodec,
  diagnostic: c.nullable(d.problem),
});
const migratedSummary = c.record({
  workspace_id: d.identifier,
  source: hostPath,
  destination: hostPath,
  planning_revision: d.decimal,
  planning_head: c.nullable(d.digest),
  source_history_head: c.nullable(d.digest),
  history_head: c.nullable(d.digest),
  from_release: c.literal("0.6.2"),
  source_format: c.literal("5"),
  source_history_format: c.literal("1"),
  register_in_fresh_registry: c.literal(true),
  old_api_requests_supported: c.literal(false),
  history_head_count: d.decimal,
});
export const localJobCodec: c.Codec<LocalJob> = c.refine(
  localJobShape,
  (job) => {
    if (job.plan.action.kind !== job.execution_action.kind) return false;
    if (
      job.plan.action.kind === "cleanup_stage" &&
      (job.execution_action.kind !== "cleanup_stage" ||
        job.plan.action.owner_token !== job.execution_action.owner_token)
    )
      return false;
    if (job.state.status === "prepared_unsent" && job.cancel_requested) return false;
    if (job.state.status === "canceled_unsent" && !job.cancel_requested) return false;
    if (job.state.status !== "succeeded") return true;
    if (job.state.report === null && job.diagnostic === null) return false;
    if (
      job.state.report !== null &&
      (!job.state.report.path.endsWith(`/admin-report-${job.plan.intention_id}.data`) ||
        BigInt(job.state.report.byte_count) > 256n * 1024n * 1024n)
    )
      return false;
    if (job.execution_action.kind === "cleanup_stage") {
      const result = c
        .record({ kind: c.literal("cleaned"), stage: hostPath })
        .decode(job.state.summary);
      return result.ok && result.value.stage === job.execution_action.stage;
    }
    const result = migratedSummary.decode(job.state.summary);
    if (!result.ok) return false;
    const value = result.value;
    return (
      value.source === job.execution_action.source &&
      value.destination === job.execution_action.destination &&
      BigInt(value.planning_revision) <= 100000n &&
      BigInt(value.history_head_count) <= 1000000n &&
      (value.planning_revision === "0") === (value.planning_head === null) &&
      (value.history_head_count === "0") === (value.source_history_head === null) &&
      (value.source_history_head === null) === (value.history_head === null)
    );
  },
  "consistent captured local job and typed helper result",
);
export const exportJobCodec: c.Codec<ExportJob> = c.record({
  job_id: d.identifier,
  kind: choice(["workspace", "all"]),
  destination: hostPath,
  captures: c.array(
    c.record({
      workspace_id: d.identifier,
      revision: d.decimal,
      head: c.nullable(d.digest),
      history_head: c.nullable(d.digest),
    }),
    1000,
  ),
  omitted: c.array(d.identifier, 1000),
  status: choice(["running", "completed", "failed", "canceled", "interrupted"]),
  attempt: d.positiveDecimal,
  cancel_requested: c.boolean,
  error: c.nullable(c.text),
});
export function actionJson(action: LocalAction) {
  return action.kind === "migrate_0_6_2"
    ? d.jsonObject([
        ["kind", d.jsonString(action.kind)],
        ["source", d.jsonString(action.source)],
        ["destination", d.jsonString(action.destination)],
      ])
    : d.jsonObject([
        ["kind", d.jsonString(action.kind)],
        ["stage", d.jsonString(action.stage)],
        ["owner_token", d.jsonString(action.owner_token)],
      ]);
}
export function planJson(plan: LocalPlan) {
  return d.jsonObject([
    ["intention_id", d.jsonString(plan.intention_id)],
    ["context", contextJson(plan.context)],
    ["action", actionJson(plan.action)],
  ]);
}
function problemJson(problem: Problem | null) {
  if (problem === null) return d.jsonNull();
  return d.jsonObject([
    ["kind", d.jsonString(problem.kind)],
    ["message", d.jsonString(problem.message)],
    ...(problem.details === undefined ? [] : [["details", problem.details] as const]),
  ]);
}
/** Full revisioned observation, encoded in the shared protocol worker for equality. */
export function observationJson(job: LocalJob) {
  const state = job.state;
  return d.jsonObject([
    ["cancel_requested", d.jsonBoolean(job.cancel_requested)],
    ["diagnostic", problemJson(job.diagnostic)],
    [
      "state",
      d.jsonObject([
        ["status", d.jsonString(state.status)],
        ...("problem" in state ? [["problem", problemJson(state.problem)] as const] : []),
        ...(state.status === "succeeded"
          ? [
              ["summary", state.summary] as const,
              [
                "report",
                state.report === null
                  ? d.jsonNull()
                  : d.jsonObject([
                      ["path", d.jsonString(state.report.path)],
                      ["sha256", d.jsonString(state.report.sha256)],
                      ["byte_count", d.jsonString(state.report.byte_count)],
                    ]),
              ] as const,
            ]
          : []),
      ]),
    ],
  ]);
}
export function samePlan(left: LocalPlan, right: LocalPlan): boolean {
  const a = left.context,
    b = right.context;
  return (
    left.intention_id === right.intention_id &&
    a.workspace_id === b.workspace_id &&
    a.project_id === b.project_id &&
    (a.writer === null
      ? b.writer === null
      : b.writer !== null &&
        a.writer.actor_id === b.writer.actor_id &&
        a.writer.run_id === b.writer.run_id) &&
    sameAction(left.action, right.action)
  );
}
export function sameAction(left: LocalAction, right: LocalAction): boolean {
  if (left.kind === "migrate_0_6_2")
    return (
      right.kind === "migrate_0_6_2" &&
      left.source === right.source &&
      left.destination === right.destination
    );
  return (
    right.kind === "cleanup_stage" &&
    left.stage === right.stage &&
    left.owner_token === right.owner_token
  );
}
function bind(
  result: HttpResult<LocalJob>,
  id: Identifier,
  plan?: LocalPlan,
): HttpResult<LocalJob> {
  if (!result.ok) return result;
  if (
    result.data.plan.intention_id !== id ||
    (plan !== undefined && !samePlan(plan, result.data.plan))
  )
    return {
      ok: false,
      failure: {
        kind: "protocol",
        message:
          "Companion returned another captured local plan; the original identity remains unchanged.",
        issue: undefined,
      },
    };
  return result;
}
export function createAdministrationClient(http: HttpClient) {
  return {
    prepare: async (plan: LocalPlan) =>
      bind(
        await http.request({
          path: "/admin-jobs/prepare",
          method: "POST",
          body: planJson(plan),
          codec: localJobCodec,
        }),
        plan.intention_id,
        plan,
      ),
    inspect: async (id: Identifier, signal?: AbortSignal) =>
      bind(
        await http.request({
          path: `/admin-jobs/${id}`,
          method: "GET",
          codec: localJobCodec,
          ...(signal === undefined ? {} : { signal }),
        }),
        id,
      ),
    act: async (plan: LocalPlan, action: "start" | "cancel") =>
      bind(
        await http.request({
          path: `/admin-jobs/${plan.intention_id}/${action}`,
          method: "POST",
          body: d.jsonObject([]),
          codec: localJobCodec,
        }),
        plan.intention_id,
        plan,
      ),
    list: (offset = "0", signal?: AbortSignal) =>
      http.request({
        path: `/admin-jobs?offset=${offset}&limit=10`,
        method: "GET",
        codec: c.record({
          items: c.array(localJobCodec, 10),
          offset: d.decimal,
          remaining: d.decimal,
          next_offset: c.nullable(d.decimal),
        }),
        ...(signal === undefined ? {} : { signal }),
      }),
    operations: (offset = "0", signal?: AbortSignal) =>
      http.request({
        path: `/operations?offset=${offset}&limit=100`,
        method: "GET",
        codec: c.record({
          items: c.array(c.object, 100),
          offset: d.decimal,
          remaining: d.decimal,
          next_offset: c.nullable(d.decimal),
        }),
        ...(signal === undefined ? {} : { signal }),
      }),
    journals: (directory: string | null, after: string | null, signal?: AbortSignal) =>
      http.request({
        path: "/journals/list",
        method: "POST",
        body: d.jsonObject([
          ["directory", directory === null ? d.jsonNull() : d.jsonString(directory)],
          ["after", after === null ? d.jsonNull() : d.jsonString(after)],
          ["limit", d.jsonString("100")],
          ["max_bytes", d.jsonString("67108864")],
        ]),
        codec: c.object,
        ...(signal === undefined ? {} : { signal }),
      }),
    journal: (path: string, signal?: AbortSignal) =>
      http.request({
        path: "/journals/inspect",
        method: "POST",
        body: d.jsonObject([["path", d.jsonString(path)]]),
        codec: c.object,
        ...(signal === undefined ? {} : { signal }),
      }),
  };
}
