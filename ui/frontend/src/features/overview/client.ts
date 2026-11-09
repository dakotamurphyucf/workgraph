import { currentRequest } from "../discussions/requests/codecs";
import { listCodec, ticketReadCodec } from "../work/read-model.codec";
import { canonicalJson, jsonField, type JsonValue } from "../../core/json";
import { createCompanion } from "../../core/protocol/client";
import type { Codec } from "../../core/protocol/codec";
import * as c from "../../core/protocol/codec";
import * as d from "../../core/protocol/decoders";
import type { HttpClient, HttpResult } from "../../core/protocol/http";
import type { ReadInvocation, ReadResponse } from "../../core/protocol/types";
import { invalid } from "../history/transcript/client";
import * as codec from "./codecs";
import { invocation, cursorInvocation, queryKey } from "./model";
import type {
  ActivityDigest,
  AttentionPage,
  CoordinationPage,
  Observation,
  OverviewScope,
  OverviewSummary,
} from "./types";

const nativeRequest = c.record({
  jsonrpc: c.literal("2.0"),
  workgraph_api: c.literal("0.7"),
  id: c.text,
  method: c.text,
  params: c.object,
});
function sameJson(a: JsonValue, b: JsonValue): boolean {
  const x = canonicalJson(a),
    y = canonicalJson(b);
  return x.ok && y.ok && x.value === y.value;
}
/** Only the exact native cursor continuation of the saved request is admitted.
 * Metadata cannot select a different method, endpoint or actor/filter. */
export function nextInvocation<T extends CoordinationPage | ActivityDigest>(
  observed: Observation<T>,
): HttpResult<ReadInvocation> {
  const page = observed.value;
  const cursor = "hasMore" in page ? (page.hasMore ? page.cursor : null) : page.cursor;
  if (cursor === null) return invalid("This captured page has no continuation.");
  if ("needsLargerBudget" in page && page.needsLargerBudget)
    return invalid("This whole item needs a larger byte budget; refresh explicitly.");
  const expected = cursorInvocation(observed.invocation, cursor);
  const metadata = observed.response.pagination;
  const decoded = nativeRequest.decode(
    metadata === null ? undefined : jsonField(metadata, "next_request"),
  );
  if (
    !decoded.ok ||
    decoded.value.method !== expected.method ||
    !sameJson(decoded.value.params, expected.params)
  )
    return invalid("Native continuation changed the captured method or selectors.");
  return {
    ok: true,
    data: Object.freeze({ ...expected, params: decoded.value.params }),
    httpStatus: 200,
  };
}
export function decodeObservation<T>(
  scope: OverviewScope,
  request: ReadInvocation,
  response: ReadResponse,
  decoder: Codec<T>,
  partial: (value: T) => boolean,
): HttpResult<Observation<T>> {
  if (
    request.connection_id !== scope.connection.id ||
    request.generation !== scope.connection.generation ||
    codec.field(request.params, "workspace_id") !== scope.workspaceId
  )
    return invalid("Read invocation changed its captured endpoint or workspace.");
  const value = decoder.decode(response.response.data),
    revision = d.decimal.decode(jsonField(response.response.meta, "workspace_revision"));
  if (!value.ok)
    return invalid(
      `Invalid ${request.method} at ${value.issue.path.join("/")}: expected ${value.issue.expected}.`,
    );
  if (!revision.ok) return invalid("Current read is missing its planning revision.");
  const at = codec.field(request.params, "at_revision");
  if (at !== null && at !== revision.value)
    return invalid("Current read changed its requested planning capture.");
  const returnedWorkspace = codec.field(response.response.data, "workspace_id");
  if (returnedWorkspace !== null && returnedWorkspace !== scope.workspaceId)
    return invalid("Read returned another workspace.");
  if (request.method === "project.brief") {
    const project = jsonField(response.response.data, "project");
    if (
      project === undefined ||
      codec.field(project, "project_id") !== codec.field(request.params, "project_id")
    )
      return invalid("Brief returned another project.");
  }
  queryKey(scope, request);
  const budget = jsonField(response.response.meta, "budget");
  const truncated = budget === undefined ? undefined : jsonField(budget, "truncated");
  if (truncated !== undefined && truncated.kind !== "boolean")
    return invalid("Invalid page budget truncation marker.");
  return {
    ok: true,
    data: Object.freeze({
      value: value.value,
      invocation: request,
      response,
      revision: revision.value,
      partial: partial(value.value) || (truncated?.kind === "boolean" && truncated.value),
    }),
    httpStatus: 200,
  };
}
/** Native cursor identity is checked again on the returned page, before publication. */
export function continued<T extends CoordinationPage | ActivityDigest>(
  before: Observation<T>,
  result: HttpResult<Observation<T>>,
): HttpResult<Observation<T>> {
  if (!result.ok) return result;
  const a = before.value,
    b = result.data.value;
  if ("capture" in a && "capture" in b) {
    const last = a.entries.at(-1);
    if (
      a.capture.through !== b.capture.through ||
      a.capture.lineage !== b.capture.lineage ||
      last === undefined ||
      b.capture.after !== last.revision ||
      b.capture.afterChangeIndex !== last.changeIndex
    )
      return invalid("Activity continuation changed its captured window or exact position.");
  } else if ("observedUnixMs" in a && "observedUnixMs" in b) {
    if (before.revision !== result.data.revision || a.observedUnixMs !== b.observedUnixMs)
      return invalid("Coordination continuation changed its current capture. Refresh explicitly.");
  } else return invalid("Continuation changed its response family.");
  return result;
}
export function createOverviewClient(http: HttpClient) {
  const companion = createCompanion(http);
  const read = async <T>(
    scope: OverviewScope,
    request: ReadInvocation,
    decoder: Codec<T>,
    partial: (value: T) => boolean,
    signal: AbortSignal,
  ): Promise<HttpResult<Observation<T>>> => {
    const result = await companion.read(request, signal);
    return result.ok ? decodeObservation(scope, request, result.data, decoder, partial) : result;
  };
  const summary = async (
    scope: OverviewScope,
    request: ReadInvocation,
    signal: AbortSignal,
  ): Promise<HttpResult<Observation<OverviewSummary>>> => {
    const result = await read(
      scope,
      request,
      scope.projectId === null ? codec.workspaceSummary : codec.projectSummary,
      (v: OverviewSummary) =>
        [v.projects, v.ready, v.working, v.blocked].some((p) => p !== null && p.remaining !== "0"),
      signal,
    );
    if (!result.ok) return result;
    const observed = result.data;
    if (scope.projectId === null) {
      const projects = [];
      for (const project of observed.value.projects?.items ?? []) {
        if (signal.aborted) return { ok: false, failure: { kind: "aborted" } };
        const projectScope = { ...scope, projectId: project.projectId };
        const detail = await summary(
          projectScope,
          invocation(projectScope, "project.brief", [
            ["project_id", d.jsonString(project.projectId)],
            ["at_revision", d.jsonString(observed.revision)],
            ["limit", d.jsonString("1")],
            ["max_bytes", d.jsonString("65536")],
          ]),
          signal,
        );
        projects.push(detail.ok ? { ...project, overview: detail.data.value } : project);
      }
      const working = [];
      for (const ticket of observed.value.working.items) {
        if (signal.aborted) return { ok: false, failure: { kind: "aborted" } };
        const detail = await read(
          scope,
          invocation(scope, "ticket.read", [
            ["ticket_id", d.jsonString(ticket.ticketId)],
            ["at_revision", d.jsonString(observed.revision)],
          ]),
          ticketReadCodec,
          () => false,
          signal,
        );
        const record =
          detail.ok && detail.data.value.ticket.ticket_id === ticket.ticketId
            ? detail.data.value.ticket
            : null;
        working.push(
          record === null
            ? ticket
            : {
                ...ticket,
                actorId: record.claim?.actor_id ?? record.assignee_id,
                runId: record.claim?.run_id ?? null,
              },
        );
      }
      return {
        ...result,
        data: {
          ...observed,
          value: {
            ...observed.value,
            projects:
              observed.value.projects === null
                ? null
                : { ...observed.value.projects, items: projects },
            working: { ...observed.value.working, items: working },
          },
        },
      };
    }
    // Compact project summaries omit assignment and full status counts. Read
    // bounded pages at the same revision; never infer totals from visible rows.
    const detail = async (status: "in_progress" | "backlog" | "todo" | "canceled") => {
      const request = invocation(scope, "ticket.list", [
        ["project_id", d.jsonString(scope.projectId!)],
        ["status", d.jsonString(status)],
        ["at_revision", d.jsonString(observed.revision)],
        ["limit", d.jsonString(status === "in_progress" ? "8" : "1")],
        ["max_bytes", d.jsonString("65536")],
      ]);
      const response = await companion.read(request, signal);
      if (!response.ok) return null;
      const revision = d.decimal.decode(
        jsonField(response.data.response.meta, "workspace_revision"),
      );
      const page = listCodec.decode(response.data.response.data);
      const budget = jsonField(response.data.response.meta, "budget");
      const truncated = budget === undefined ? undefined : jsonField(budget, "truncated");
      if (
        truncated?.kind !== "boolean" ||
        truncated.value ||
        !revision.ok ||
        revision.value !== observed.revision ||
        !page.ok ||
        page.value.offset !== "0"
      )
        return null;
      const count = (
        BigInt(page.value.items.length) + BigInt(page.value.remaining)
      ).toString() as import("../../core/protocol/types").Decimal;
      return { status, count, items: page.value.items };
    };
    const details = [];
    for (const status of ["in_progress", "backlog", "todo", "canceled"] as const) {
      if (signal.aborted) return { ok: false, failure: { kind: "aborted" } };
      details.push(await detail(status));
    }
    if (signal.aborted) return { ok: false, failure: { kind: "aborted" } };
    const working = details.find((row) => row?.status === "in_progress");
    const counts = details
      .filter((row) => row !== null)
      .map(({ status, count }) => ({ status, count }));
    const progress = observed.value.progress;
    const complete =
      progress !== null &&
      counts.length === 4 &&
      counts.reduce((sum, row) => sum + BigInt(row.count), BigInt(progress.done)) ===
        BigInt(progress.total);
    return {
      ...result,
      data: {
        ...observed,
        value: {
          ...observed.value,
          statusCounts: complete ? [...counts, { status: "done", count: progress.done }] : [],
          working: {
            ...observed.value.working,
            items: observed.value.working.items.map((ticket) => {
              const record = working?.items.find((row) => row.ticket_id === ticket.ticketId);
              return record === undefined
                ? ticket
                : {
                    ...ticket,
                    actorId: record.claim?.actor_id ?? record.assignee_id,
                    runId: record.claim?.run_id ?? null,
                  };
            }),
          },
        },
      },
    };
  };
  return {
    summary,
    coordination: async (
      scope: OverviewScope,
      request: ReadInvocation,
      signal: AbortSignal,
    ): Promise<HttpResult<Observation<CoordinationPage>>> => {
      const result = await read(
        scope,
        request,
        codec.coordinationPage,
        (v) => v.omitted !== "0",
        signal,
      );
      if (!result.ok) return result;
      const items = [];
      for (const row of result.data.value.items) {
        if (signal.aborted) return { ok: false, failure: { kind: "aborted" } };
        const ticketId = codec.field(row.source, "ticket_id");
        const requestId = codec.field(row.source, "request_id");
        let detail: import("./types").CoordinationRow["detail"];
        if (requestId !== null && row.kind === "unanswered_request") {
          // Communication captures have their own query revision, not a
          // planning revision. Show independently current request details only
          // while the same request/question is still open; never relabel that
          // read as the coordinator's planning snapshot.
          const response = await companion.read(
            invocation(scope, "request.get", [
              ["request_id", d.jsonString(requestId)],
              ["max_bytes", d.jsonString("65536")],
            ]),
            signal,
          );
          if (response.ok) {
            const decoded = currentRequest.decode(response.data.response.data);
            const metadata = jsonField(row.raw, "metadata");
            if (
              decoded.ok &&
              decoded.value.id === requestId &&
              decoded.value.status.kind === "open" &&
              metadata !== undefined &&
              codec.field(metadata, "comment_id") === decoded.value.question.id
            ) {
              const record = decoded.value;
              detail = {
                title: record.questionBody.body,
                actorId: record.resolverId,
                byline: `${record.created.actorId} asked ${record.resolverId}`,
                capture: "current_request",
              };
            }
          }
        } else if (ticketId !== null && row.kind !== "ready_work") {
          const response = await read(
            scope,
            invocation(scope, "ticket.read", [
              ["ticket_id", d.jsonString(ticketId)],
              ["at_revision", d.jsonString(result.data.revision)],
            ]),
            ticketReadCodec,
            () => false,
            signal,
          );
          if (response.ok && response.data.value.ticket.ticket_id === ticketId) {
            const record = response.data.value.ticket;
            const actorId = record.claim?.actor_id ?? record.assignee_id;
            detail = {
              title: record.title,
              actorId,
              byline: [record.display_key, actorId].filter(Boolean).join(" · "),
              capture: "planning",
            };
          }
        }
        items.push(detail === undefined ? row : { ...row, detail });
      }
      return { ...result, data: { ...result.data, value: { ...result.data.value, items } } };
    },
    attention: (scope: OverviewScope, request: ReadInvocation, signal: AbortSignal) =>
      read(
        scope,
        request,
        codec.attentionPage,
        (v: AttentionPage) => v.hasMore || v.needsLargerBudget,
        signal,
      ),
    digest: (scope: OverviewScope, request: ReadInvocation, signal: AbortSignal) =>
      read(
        scope,
        request,
        codec.activityDigest,
        (v: ActivityDigest) =>
          v.hasMore ||
          v.counts.some((x) => x.omitted !== "0") ||
          v.entries.some((x) => x.item.clipped.length > 0),
        signal,
      ),
  };
}
