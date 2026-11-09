import { type JsonValue } from "../../../core/json";
import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type { FeatureContext } from "../../../app/types";
import type {
  Decimal,
  Identifier,
  Preparation,
  ReadInvocation,
} from "../../../core/protocol/types";
import type { HttpResult } from "../../../core/protocol/http";
import { failureText } from "../../connections/failure";
import { decimal64, fields } from "./codecs";
import { createParticipantsClient, invocation } from "./client";
import type {
  ParticipantsCapture,
  ParticipantsDraft,
  ParticipantsInput,
  ParticipantsReadMethod,
  ParticipantsSelection,
  ParticipantsTarget,
} from "./types";

export class ParticipantsInputError extends Error {}
export const MAX_DRAFTS = 24,
  MAX_DRAFT_BYTES = 256 * 1024,
  MAX_TOTAL_BYTES = 4 * 1024 * 1024;
export function identifier(value: string): Identifier {
  const result = d.identifier.decode(d.jsonString(value));
  if (!result.ok)
    throw new ParticipantsInputError(
      "Enter an actual identifier: ASCII letters, numbers, underscores or hyphens, at most 96 characters.",
    );
  return result.value;
}
export function counter(value: string, positive = false): Decimal {
  const result = (positive ? d.positiveDecimal : d.decimal).decode(d.jsonString(value));
  if (!result.ok)
    throw new ParticipantsInputError("Enter a canonical decimal counter within the daemon range.");
  return result.value;
}
export function selection(context: FeatureContext): ParticipantsSelection {
  const route = context.route;
  if (route.participant === undefined) return { kind: "none" };
  if (route.entityId === null)
    throw new ParticipantsInputError("This participant link is missing its exact target.");
  const id = identifier(route.entityId);
  switch (route.participant.kind) {
    case "actor":
      return { kind: "actor", actorId: id };
    case "run":
      return { kind: "run", runId: id };
    case "attempt":
      return { kind: "attempt", attemptId: id };
  }
}
export function target(context: FeatureContext, selected = selection(context)): ParticipantsTarget {
  if (context.route.workspaceId === null)
    throw new ParticipantsInputError("Select a workspace first.");
  return Object.freeze({
    connection: Object.freeze({ ...context.connection }),
    workspaceId: identifier(context.route.workspaceId),
    projectId: context.route.projectId === null ? null : identifier(context.route.projectId),
    selection: Object.freeze({ ...selected }),
  });
}
export function targetKey(value: ParticipantsTarget): string {
  return JSON.stringify([
    value.connection.id,
    value.connection.generation,
    value.workspaceId,
    value.projectId,
    value.selection,
  ]);
}
export function capture(
  context: FeatureContext,
  viewed: ParticipantsTarget | null,
): ParticipantsCapture {
  const scope = target(context);
  if (context.profileState !== "current")
    throw new ParticipantsInputError(
      "Refresh the connection directory before starting a new draft.",
    );
  if (
    (context.route.participant !== undefined &&
      context.route.participant.generation !== scope.connection.generation) ||
    (viewed !== null &&
      (viewed.connection.id !== scope.connection.id ||
        viewed.connection.generation !== scope.connection.generation ||
        viewed.workspaceId !== scope.workspaceId))
  )
    throw new ParticipantsInputError(
      "This record is viewed through another retained endpoint generation. Open the current target explicitly before authoring; its IDs will not be transplanted.",
    );
  if (context.writer.actorId === null)
    throw new ParticipantsInputError("Select the actual acting writer before reviewing a change.");
  return Object.freeze({
    target: scope,
    writer: Object.freeze({
      actorId: identifier(context.writer.actorId),
      runId: context.writer.runId === null ? null : identifier(context.writer.runId),
    }),
  });
}
export function inputBytes(input: ParticipantsInput): number {
  return Object.values(input).reduce(
    (sum, value) => sum + new TextEncoder().encode(String(value)).byteLength,
    0,
  );
}
export function initialInput(
  method: ParticipantsInput["method"],
  saved: ParticipantsCapture,
): ParticipantsInput {
  const s = saved.target.selection,
    run = s.kind === "run" ? s.runId : (saved.writer.runId ?? ""),
    attempt = s.kind === "attempt" ? s.attemptId : "";
  switch (method) {
    case "actor.put":
      return {
        method,
        actorId: s.kind === "actor" ? s.actorId : "",
        name: "",
        actorKind: "agent",
        archived: false,
      };
    case "run.register":
      return {
        method,
        runId: "",
        objective: "",
        capabilities: "",
        parentRunId: "",
        parentStopPolicy: "continue",
        processRef: "",
        worktreeRef: "",
      };
    case "run.transition":
      return { method, runId: run, status: "waiting", evidence: "" };
    case "run.observe":
      return { method, runId: run, observedUnixMs: "" };
    case "run.heartbeat":
      return { method, runId: run };
    case "run.link_session":
      return { method, runId: run, sessionId: "" };
    case "attempt.start":
      return { method, runId: run, ticketId: "", attemptId: "", sessionIds: "" };
    case "attempt.checkpoint":
      return { method, attemptId: attempt, checkpointKind: "resource", targetId: "", revision: "" };
    case "attempt.finish":
      return { method, attemptId: attempt, state: "completed", evidence: "" };
    case "run.action_acknowledge":
      return { method, childRunId: run, evidence: "" };
    case "run.budget_put":
      return {
        method,
        runId: run,
        maxAttempts: "",
        maxActiveAttempts: "",
        reportedTokenLimit: "",
        reportedElapsedMsLimit: "",
      };
  }
}
const text = (value: string, max: number, nonblank = false) => {
  if (
    new TextEncoder().encode(value).byteLength > max ||
    (nonblank && !/[^ \t\n\r\f\v]/u.test(value))
  )
    throw new ParticipantsInputError(
      `Enter ${nonblank ? "nonblank " : ""}text within ${max} UTF-8 bytes.`,
    );
  return value;
};
const lines = (source: string, convert: (value: string) => string, max = 100) => {
  const values = source === "" ? [] : source.split(/\r?\n/u).map(convert);
  if (values.length > max || new Set(values).size !== values.length)
    throw new ParticipantsInputError(`Enter at most ${max} distinct rows, one per line.`);
  return values;
};
function requireResult<T>(result: HttpResult<T>): T {
  if (!result.ok) throw new ParticipantsInputError(failureText(result.failure));
  return result.data;
}
/** Guard reads use the captured target and writer, never the currently mounted view. */
export async function prepareDraft(
  draft: ParticipantsDraft,
  api: ReturnType<typeof createParticipantsClient>,
  signal: AbortSignal,
): Promise<Preparation> {
  const { target: scope, writer } = draft.capture,
    input = draft.input,
    pairs: [string, JsonValue][] = [
      ["workspace_id", d.jsonString(scope.workspaceId)],
      ["actor_id", d.jsonString(writer.actorId)],
    ];
  const put = (key: string, value: string) => pairs.push([key, d.jsonString(value)]),
    set = (key: string, value: JsonValue) => pairs.push([key, value]);
  if (input.method !== "run.heartbeat") {
    put("mutation_id", draft.id);
    if (writer.runId !== null) put("run_id", writer.runId);
  }
  let projectId: Identifier | null = null;
  const ownRun = async (id: Identifier) => {
    const detail = requireResult(await api.detail(scope, "run.get", id, signal));
    if (detail.value.kind !== "run") throw new Error("Run detail codec changed type.");
    const run = detail.value.run;
    if (run.actor_id !== writer.actorId || (writer.runId !== null && writer.runId !== run.run_id))
      throw new ParticipantsInputError(
        "This action requires the recorded run's actor and, when supplied, the same run attribution. Selecting a name does not transfer ownership.",
      );
    return run;
  };
  const rawRead = async (method: string, extra: readonly (readonly [string, JsonValue])[]) =>
    requireResult(await api.read({ ...invocation(scope, "run.get", extra), method }, signal));
  switch (input.method) {
    case "actor.put": {
      const id = identifier(input.actorId);
      put("target_actor_id", id);
      put("name", text(input.name, 512, true));
      put("kind", input.actorKind);
      set("archived", d.jsonBoolean(input.archived));
      let incomplete = false;
      let request = invocation(scope, "actor.list", [
          ["include_archived", d.jsonBoolean(true)],
          ["limit", d.jsonString("100")],
          ["max_bytes", d.jsonString("1048576")],
        ]),
        guard: Decimal | undefined;
      for (let page = 0; page < 100; page++) {
        const result = requireResult(await api.page(scope, request, signal));
        incomplete ||= result.completeness === "partial";
        if (result.rows.kind !== "catalog")
          throw new Error("Actor catalog projection changed type.");
        const found = result.rows.items.find((actor) => actor.actor_id === id);
        if (found !== undefined) {
          guard = found.revision;
          break;
        }
        if (result.continuation === null) {
          if (incomplete || result.completeness !== "complete")
            throw new ParticipantsInputError(
              "Actor catalog is incomplete. Its absence cannot be used as a create guard; increase the read budget or resolve the missing records.",
            );
          guard = counter("0");
          break;
        }
        request = result.continuation;
      }
      if (guard === undefined)
        throw new ParticipantsInputError(
          "Actor catalog exceeds this guard-read budget. Refine the catalog before editing; absence was not assumed.",
        );
      put("expected_revision", guard);
      break;
    }
    case "run.register":
      put("target_run_id", identifier(input.runId));
      put("objective", text(input.objective, 16384, true));
      set(
        "capabilities",
        d.jsonArray(lines(input.capabilities, (v) => text(v, 96, true)).map(d.jsonString)),
      );
      if (input.parentRunId !== "") put("parent_run_id", identifier(input.parentRunId));
      put("parent_stop_policy", input.parentStopPolicy);
      if (input.processRef !== "") put("process_ref", text(input.processRef, 1024, true));
      if (input.worktreeRef !== "") put("worktree_ref", text(input.worktreeRef, 4096, true));
      break;
    case "run.transition":
    case "run.observe":
    case "run.link_session": {
      const id = identifier(input.runId),
        run = await ownRun(id);
      put("target_run_id", id);
      put("expected_revision", run.revision);
      if (input.method === "run.transition") {
        put("status", input.status);
        put(
          "evidence",
          text(input.evidence, 65536, ["completed", "failed", "cancelled"].includes(input.status)),
        );
      } else if (input.method === "run.observe") {
        const value = decimal64.decode(d.jsonString(input.observedUnixMs));
        if (!value.ok)
          throw new ParticipantsInputError(
            "Enter canonical nonnegative Unix milliseconds within int64 range.",
          );
        if (
          run.last_observed_unix_ms !== null &&
          BigInt(value.value) <= BigInt(run.last_observed_unix_ms)
        )
          throw new ParticipantsInputError(
            "Observation must move forward from the recorded timestamp.",
          );
        put("observed_unix_ms", value.value);
      } else put("session_id", identifier(input.sessionId));
      break;
    }
    case "run.heartbeat": {
      const id = identifier(input.runId);
      const result = requireResult(await api.detail(scope, "run.get", id, signal));
      if (result.value.kind !== "run" || result.value.run.actor_id !== writer.actorId)
        throw new ParticipantsInputError("Heartbeat requires the run's recorded actor.");
      put("target_run_id", id);
      break;
    }
    case "attempt.start": {
      const id = identifier(input.runId);
      await ownRun(id);
      const ticket = identifier(input.ticketId),
        result = await rawRead("ticket.read", [
          ["ticket_id", d.jsonString(ticket)],
          ["max_bytes", d.jsonString("1048576")],
        ]),
        record = fields({
          ticket: fields({
            ticket_id: d.identifier,
            project_id: c.nullable(d.identifier),
            claim: c.nullable(
              fields({
                actor_id: d.identifier,
                run_id: c.nullable(d.identifier),
                token: d.positiveDecimal,
              }),
            ),
          }),
        }).decode(result.response.data);
      if (!record.ok || record.value.ticket.ticket_id !== ticket)
        throw new ParticipantsInputError(
          "Ticket ownership capture is malformed or names another ticket.",
        );
      const claim = record.value.ticket.claim;
      if (
        claim === null ||
        claim.actor_id !== writer.actorId ||
        claim.run_id !== id ||
        (writer.runId !== null && claim.run_id !== writer.runId)
      )
        throw new ParticipantsInputError(
          "Starting an attempt requires this actor's actual claim bound to the target run. The observed token alone grants no ownership.",
        );
      projectId = record.value.ticket.project_id;
      put("target_run_id", id);
      put("ticket_id", ticket);
      put("token", claim.token);
      put("attempt_id", identifier(input.attemptId));
      set("session_ids", d.jsonArray(lines(input.sessionIds, identifier).map(d.jsonString)));
      break;
    }
    case "attempt.checkpoint":
    case "attempt.finish": {
      const id = identifier(input.attemptId),
        detail = requireResult(await api.detail(scope, "attempt.get", id, signal));
      if (detail.value.kind !== "attempt") throw new Error("Attempt detail codec changed type.");
      await ownRun(detail.value.attempt.run_id);
      put("attempt_id", id);
      put("expected_revision", detail.value.attempt.revision);
      if (input.method === "attempt.finish") {
        put("state", input.state);
        put("evidence", text(input.evidence, 65536, true));
      } else
        set(
          "checkpoint",
          d.jsonObject([
            ["kind", d.jsonString(input.checkpointKind)],
            [
              input.checkpointKind === "resource" ? "resource_id" : "ticket_id",
              d.jsonString(identifier(input.targetId)),
            ],
            ["revision", d.jsonString(counter(input.revision, true))],
          ]),
        );
      break;
    }
    case "run.action_acknowledge":
      put("child_run_id", identifier(input.childRunId));
      put("evidence", text(input.evidence, 65536, true));
      break;
    case "run.budget_put": {
      const id = identifier(input.runId);
      requireResult(await api.detail(scope, "run.get", id, signal));
      const observed = await api.read(
        invocation(scope, "run.budget_get", [
          ["target_run_id", d.jsonString(id)],
          ["max_bytes", d.jsonString("1048576")],
        ]),
        signal,
      );
      let revision: Decimal;
      if (
        !observed.ok &&
        observed.failure.kind === "remote" &&
        observed.failure.problem.kind === "Not_found"
      )
        revision = counter("0");
      else {
        const result = requireResult(observed),
          budget = fields({ target_run_id: d.identifier, revision: d.positiveDecimal }).decode(
            result.response.data,
          );
        if (!budget.ok || budget.value.target_run_id !== id)
          throw new ParticipantsInputError("Budget capture changed the target run.");
        revision = budget.value.revision;
      }
      put("target_run_id", id);
      put("expected_revision", revision);
      for (const [key, value, codec] of [
        ["max_attempts", input.maxAttempts, d.positiveDecimal],
        ["max_active_attempts", input.maxActiveAttempts, d.positiveDecimal],
        ["reported_token_limit", input.reportedTokenLimit, decimal64],
        ["reported_elapsed_ms_limit", input.reportedElapsedMsLimit, decimal64],
      ] as const) {
        if (value === "") set(key, d.jsonNull());
        else {
          const decoded = codec.decode(d.jsonString(value));
          if (!decoded.ok)
            throw new ParticipantsInputError(
              `Invalid ${key.replaceAll("_", " ")}. Empty means no limit.`,
            );
          put(key, decoded.value);
        }
      }
      break;
    }
  }
  if (signal.aborted) throw new DOMException("Participant guard read cancelled.", "AbortError");
  return Object.freeze({
    intention_id: draft.id,
    connection_id: scope.connection.id,
    generation: scope.connection.generation,
    context: Object.freeze({
      workspace_id: scope.workspaceId,
      project_id: projectId,
      writer: Object.freeze({ actor_id: writer.actorId, run_id: writer.runId }),
    }),
    method: input.method,
    params: d.jsonObject(pairs),
  });
}

export function readRequest(
  scope: ParticipantsTarget,
  panel: import("./types").ParticipantsPanel,
  filter: import("./types").ParticipantsState["filter"],
): ReadInvocation {
  const params: [string, import("../../../core/json").JsonValue][] = [
    ["max_bytes", d.jsonString("1048576")],
  ];
  let method: ParticipantsReadMethod;
  switch (panel) {
    case "actors":
      method = "participant.list";
      break;
    case "catalog":
      method = "actor.list";
      params.push(["include_archived", d.jsonBoolean(true)]);
      break;
    case "runs":
      method = "run.list";
      break;
    case "attempts":
      method = "attempt.list";
      if (filter.runId !== "")
        params.push(["target_run_id", d.jsonString(identifier(filter.runId))]);
      if (filter.ticketId !== "")
        params.push(["ticket_id", d.jsonString(identifier(filter.ticketId))]);
      break;
    case "actor-overview":
      if (filter.actorId === "" && scope.selection.kind !== "actor")
        throw new ParticipantsInputError(
          "Choose an actor in Views & filters to open this overview.",
        );
      method = "actor.overview";
      params.push([
        "actor_id",
        d.jsonString(
          identifier(
            filter.actorId || (scope.selection.kind === "actor" ? scope.selection.actorId : ""),
          ),
        ),
      ]);
      if (filter.runId !== "") params.push(["run_id", d.jsonString(identifier(filter.runId))]);
      if (scope.projectId !== null) params.push(["project_id", d.jsonString(scope.projectId)]);
      break;
    case "coordinator":
      method = "coordinator.overview";
      if (filter.actorId !== "")
        params.push(["actor_id", d.jsonString(identifier(filter.actorId))]);
      if (filter.runId !== "") params.push(["run_id", d.jsonString(identifier(filter.runId))]);
      if (scope.projectId !== null) params.push(["project_id", d.jsonString(scope.projectId)]);
      break;
    case "actions":
      method = "run.actions";
      break;
    case "budget":
      if (filter.runId === "" && scope.selection.kind !== "run")
        throw new ParticipantsInputError("Choose a run in Views & filters to inspect this record.");
      method = "run.budget_get";
      params.push([
        "target_run_id",
        d.jsonString(
          identifier(filter.runId || (scope.selection.kind === "run" ? scope.selection.runId : "")),
        ),
      ]);
      break;
    case "budget-attention":
      method = "run.budget_attention";
      break;
    case "heartbeat":
      if (filter.runId === "" && scope.selection.kind !== "run")
        throw new ParticipantsInputError("Choose a run in Views & filters to inspect this record.");
      method = "run.heartbeat_get";
      params.splice(0);
      params.push([
        "target_run_id",
        d.jsonString(
          identifier(filter.runId || (scope.selection.kind === "run" ? scope.selection.runId : "")),
        ),
      ]);
      break;
  }
  if (!["run.budget_get", "run.heartbeat_get"].includes(method))
    params.push(["limit", d.jsonString("50")]);
  return invocation(scope, method, params);
}
