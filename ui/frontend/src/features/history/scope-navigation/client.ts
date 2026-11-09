import { jsonField } from "../../../core/json";
import { createCompanion } from "../../../core/protocol/client";
import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type { HttpClient, HttpResult } from "../../../core/protocol/http";
import type { JsonObject, ReadInvocation, ReadResponse } from "../../../core/protocol/types";
import { ticketReadCodec } from "../../work/read-model.codec";
import type { PlanningCapture, PlanningRecord, PlanningTarget } from "./types";

function projected<T>(codec: c.Codec<T>, names: readonly string[]): c.Codec<T> {
  const allowed = new Set(names);
  return {
    decode(value, path = []) {
      if (value?.kind !== "object") return c.mismatch(path, "planning record");
      return codec.decode(
        { ...value, fields: value.fields.filter((field) => allowed.has(field.name)) },
        path,
      );
    },
  };
}
function fields<S extends Readonly<Record<string, c.Codec<unknown>>>>(shape: S) {
  return projected(c.record(shape), Object.keys(shape));
}
const workspace = fields({
  name: c.text,
  settings: fields({
    name: c.nullable(c.text),
    description: c.text,
    summary: c.text,
    instructions: c.text,
    revision: d.decimal,
    archived: c.boolean,
  }),
});
const project = fields({
  project_id: d.identifier,
  title: c.text,
  description: c.text,
  summary: c.text,
  acceptance_criteria: c.text,
  revision: d.decimal,
  archived: c.boolean,
  status: c.text,
});
const milestone = fields({
  milestone_id: d.identifier,
  project_id: d.identifier,
  title: c.text,
  description: c.text,
  target_date: c.nullable(c.text),
  revision: d.decimal,
  archived: c.boolean,
  status: c.text,
});
const invalid = (message: string): HttpResult<never> => ({
  ok: false,
  failure: { kind: "protocol", message, issue: undefined },
});
export function planningInvocation(target: PlanningTarget): ReadInvocation {
  const extra =
    target.kind === "workspace" ? [] : [[`${target.kind}_id`, d.jsonString(target.id)] as const];
  return Object.freeze({
    connection_id: target.connectionId,
    generation: target.generation,
    method: target.kind === "ticket" ? "ticket.read" : `${target.kind}.get`,
    lane: "visible",
    params: d.jsonObject([
      ["workspace_id", d.jsonString(target.workspaceId)],
      ...extra,
      ["max_bytes", d.jsonString("1048576")],
    ]),
  });
}
/** Project validated current records while retaining the entire lossless response.
 * Explicit descriptive omissions remain available in metadata, never called full. */
export function decodePlanningRecord(
  target: PlanningTarget,
  response: ReadResponse,
): HttpResult<PlanningRecord> {
  const base = {
    kind: target.kind,
    id: target.id,
    summary: "",
    description: "",
    instructions: "",
    acceptance: "",
    status: null,
    projectId: null,
    targetDate: null,
  };
  const data = response.response.data;
  switch (target.kind) {
    case "workspace": {
      const v = workspace.decode(data);
      return v.ok
        ? {
            ok: true,
            httpStatus: 200,
            data: { ...base, title: v.value.settings.name ?? v.value.name, ...v.value.settings },
          }
        : invalid("Malformed workspace planning response.");
    }
    case "project": {
      const v = project.decode(data);
      return v.ok && v.value.project_id === target.id
        ? {
            ok: true,
            httpStatus: 200,
            data: {
              ...base,
              ...v.value,
              acceptance: v.value.acceptance_criteria,
              projectId: v.value.project_id,
            },
          }
        : invalid("Project response does not match the recorded target.");
    }
    case "milestone": {
      const v = milestone.decode(jsonField(data, "milestone"));
      return v.ok && v.value.milestone_id === target.id
        ? {
            ok: true,
            httpStatus: 200,
            data: {
              ...base,
              ...v.value,
              projectId: v.value.project_id,
              targetDate: v.value.target_date,
            },
          }
        : invalid("Milestone response does not match the recorded target.");
    }
    case "ticket": {
      const v = ticketReadCodec.decode(data);
      return v.ok && v.value.ticket.ticket_id === target.id
        ? {
            ok: true,
            httpStatus: 200,
            data: {
              ...base,
              ...v.value.ticket,
              acceptance: v.value.ticket.acceptance_criteria,
              projectId: v.value.ticket.project_id,
            },
          }
        : invalid("Ticket response does not match the recorded target.");
    }
  }
}
export async function readPlanningTarget(
  http: HttpClient,
  input: PlanningTarget,
  signal: AbortSignal,
): Promise<HttpResult<PlanningCapture>> {
  const target = Object.freeze({ ...input });
  const profile = await http.request({
    method: "GET",
    path: `/connections/${encodeURIComponent(target.connectionId)}/generations/${encodeURIComponent(target.generation)}`,
    codec: d.connectionProfile,
    signal,
  });
  if (!profile.ok) return profile;
  if (signal.aborted) return { ok: false, failure: { kind: "aborted" } };
  if (profile.data.id !== target.connectionId || profile.data.generation !== target.generation)
    return invalid("Retained connection lookup changed the recorded endpoint identity.");
  const response = await createCompanion(http).read(planningInvocation(target), signal);
  if (!response.ok) return response;
  if (signal.aborted) return { ok: false, failure: { kind: "aborted" } };
  const record = decodePlanningRecord(target, response.data);
  return record.ok
    ? {
        ok: true,
        httpStatus: response.httpStatus,
        data: Object.freeze({
          target,
          connection: profile.data,
          record: record.data,
          response: response.data,
        }),
      }
    : record;
}
export function planningResponseJson(response: ReadResponse): JsonObject {
  return d.jsonObject([
    ["data", response.response.data],
    ["meta", response.response.meta],
    ["pagination", response.pagination ?? d.jsonNull()],
  ]);
}
