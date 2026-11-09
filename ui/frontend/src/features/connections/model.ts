import { jsonField, type JsonValue } from "../../core/json";
import * as c from "../../core/protocol/codec";
import * as d from "../../core/protocol/decoders";
import type { FeatureContext, Route, WriterSelection } from "../../app/types";
import type { Identifier, JsonObject, ReadResponse } from "../../core/protocol/types";
import type { EntityPage, FrozenAction, LifecycleAction, ObserverContext } from "./types";

export class DraftInputError extends Error {}
export class ProjectionError extends Error {}

export function newIdentity(): Identifier {
  const decoded = d.identifier.decode(d.jsonString(`life-${crypto.randomUUID()}`));
  if (!decoded.ok) throw new Error("Generated identity is invalid.");
  return decoded.value;
}
function id(value: string, name: string): Identifier {
  const result = d.identifier.decode(d.jsonString(value));
  if (!result.ok)
    throw new DraftInputError(
      `${name} requires 1–96 ASCII letters, digits, underscores or hyphens.`,
    );
  return result.value;
}
function revision(value: string, positive: boolean): string {
  const decoded = (positive ? d.positiveDecimal : d.decimal).decode(d.jsonString(value));
  if (!decoded.ok)
    throw new DraftInputError("Refresh the entity and use its exact positive revision.");
  return decoded.value;
}
function path(value: string): string {
  if (!value.startsWith("/") || value.includes("\0"))
    throw new DraftInputError("Enter an absolute path on the companion host.");
  return value;
}
function date(value: string): JsonValue {
  if (value === "") return { kind: "null" };
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value))
    throw new DraftInputError("Use YYYY-MM-DD, or clear the date explicitly.");
  const instant = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== value)
    throw new DraftInputError("Use an actual calendar date.");
  return d.jsonString(value);
}
export function observerContext(route: Route, writer: WriterSelection): ObserverContext {
  if (writer.actorId === null && writer.runId !== null)
    throw new DraftInputError(
      "Choose an actor or clear the run before capturing an observer startup plan.",
    );
  return {
    workspace_id: route.workspaceId === null ? null : id(route.workspaceId, "Workspace"),
    project_id: route.projectId === null ? null : id(route.projectId, "Project"),
    writer:
      writer.actorId === null
        ? null
        : {
            actor_id: id(writer.actorId, "Actor"),
            run_id: writer.runId === null ? null : id(writer.runId, "Run"),
          },
  };
}
/** Pure explicit action preparation. No hidden defaults, execution or automatic retries. */
export function freezeAction(
  context: FeatureContext,
  action: LifecycleAction,
  intention: Identifier,
): FrozenAction {
  if (context.profileState !== "current")
    throw new DraftInputError("Refresh the connection directory before capturing a new action.");
  const captured = observerContext(context.route, context.writer);
  if (captured.writer === null)
    throw new DraftInputError("Choose an acting actor before preparing a daemon action.");
  const fields: [string, JsonValue][] = [];
  const put = (key: string, value: string) => {
    fields.push([key, d.jsonString(value)]);
  };
  const entity = (kind: string, value: string) => {
    put(`${kind}_id`, id(value, kind));
  };
  const guard = (value: string, positive = true) => {
    put("expected_revision", revision(value, positive));
  };
  const scoped = (workspace = captured.workspace_id) => {
    if (workspace === null)
      throw new DraftInputError("Select an open workspace for this planning action.");
    put("workspace_id", workspace);
    if (captured.writer?.run_id !== null && captured.writer?.run_id !== undefined)
      put("run_id", captured.writer.run_id);
  };
  if (action.kind !== "daemon_stop") put("actor_id", captured.writer.actor_id);
  let method: string;
  switch (action.kind) {
    case "workspace_create":
      method = "workspace.create";
      if (action.id !== "") entity("workspace", action.id);
      put("name", action.name);
      put("root", path(action.root));
      break;
    case "workspace_register":
      method = "workspace.register";
      put("root", path(action.root));
      break;
    case "workspace_open":
    case "workspace_close":
    case "workspace_unregister":
      method = action.kind.replace("_", ".");
      entity("workspace", action.id);
      break;
    case "workspace_edit":
      method = "workspace.update";
      scoped(id(action.id, "Workspace"));
      guard(action.revision, false);
      put("name", action.name);
      put("summary", action.summary);
      put("description", action.description);
      put("instructions", action.instructions);
      break;
    case "workspace_archive":
      method = "workspace.archive";
      scoped(id(action.id, "Workspace"));
      guard(action.revision, false);
      fields.push(["archived", { kind: "boolean", value: action.archived }]);
      break;
    case "project_create":
      method = "project.create";
      scoped();
      if (action.id !== "") entity("project", action.id);
      put("title", action.title);
      put("description", action.description);
      break;
    case "project_edit":
      method = "project.update";
      scoped();
      entity("project", action.id);
      guard(action.revision);
      put("title", action.title);
      put("summary", action.summary);
      put("description", action.description);
      put("acceptance_criteria", action.acceptance);
      if (action.priority !== "") {
        const result = d.decimal.decode(d.jsonString(action.priority));
        if (!result.ok || BigInt(result.value) > 4n)
          throw new DraftInputError("Priority requires an exact integer from 0 to 4.");
        put("priority", result.value);
      }
      put("status", action.status);
      break;
    case "project_archive":
      method = "project.archive";
      scoped();
      entity("project", action.id);
      guard(action.revision);
      fields.push(["archived", { kind: "boolean", value: action.archived }]);
      break;
    case "project_finish":
      method = "project.finish";
      scoped();
      entity("project", action.id);
      guard(action.revision);
      if (action.evidence.trim() === "")
        throw new DraftInputError("Completion evidence is required.");
      put("evidence", action.evidence);
      fields.push([
        "handoff",
        d.jsonObject([
          ["summary", d.jsonString(action.summary)],
          ["next_steps", d.jsonString(action.nextSteps)],
        ]),
      ]);
      break;
    case "milestone_create":
      method = "milestone.create";
      scoped();
      if (action.id !== "") entity("milestone", action.id);
      entity("project", action.project);
      put("title", action.title);
      put("description", action.description);
      if (action.date !== "") fields.push(["target_date", date(action.date)]);
      break;
    case "milestone_edit":
      method = "milestone.update";
      scoped();
      entity("milestone", action.id);
      guard(action.revision);
      put("title", action.title);
      put("description", action.description);
      put("status", action.status);
      break;
    case "milestone_archive":
      method = "milestone.archive";
      scoped();
      entity("milestone", action.id);
      guard(action.revision);
      fields.push(["archived", { kind: "boolean", value: action.archived }]);
      break;
    case "milestone_schedule":
      method = "milestone.schedule";
      scoped();
      entity("milestone", action.id);
      guard(action.revision);
      fields.push(["target_date", date(action.date)]);
      break;
    case "daemon_stop":
      method = "daemon.shutdown";
      break;
  }
  return {
    label: method,
    preparation: {
      intention_id: intention,
      context: { ...captured, writer: captured.writer },
      connection_id: context.connection.id,
      generation: context.connection.generation,
      method,
      params: d.jsonObject(fields),
    },
  };
}

function consumed<T>(object: JsonObject, name: string, codec: c.Codec<T>): T {
  const result = codec.decode(jsonField(object, name), [name]);
  if (!result.ok)
    throw new ProjectionError(
      `Invalid ${name}: ${result.issue.expected}. Raw response remains available.`,
    );
  return result.value;
}
/** Method projections validate consumed fields and retain the complete arbitrary source. */
export function entityPage(
  kind: "workspace" | "project" | "milestone",
  response: ReadResponse,
): EntityPage {
  const data = c.object.decode(response.response.data);
  if (!data.ok) throw new ProjectionError("Expected an object response; inspect raw data.");
  const found = jsonField(data.value, kind === "workspace" ? "workspaces" : "items");
  if (found?.kind !== "array" || found.items.length > 10000)
    throw new ProjectionError("Expected a bounded entity page; inspect raw data.");
  const rows = found.items.map((value) => {
    if (value.kind !== "object") throw new ProjectionError("Invalid entity row; inspect raw data.");
    const optional = <T>(name: string, codec: c.Codec<T>): T | null =>
      jsonField(value, name) === undefined ? null : consumed(value, name, c.nullable(codec));
    return {
      id: consumed(value, `${kind}_id`, d.identifier),
      title: consumed(value, kind === "workspace" ? "name" : "title", c.text),
      revision: optional("revision", d.positiveDecimal),
      archived: optional("archived", c.boolean),
      status: optional("status", c.text),
      root: optional("root", c.text),
      open: optional("open", c.boolean),
      date: optional("target_date", c.text),
      raw: value,
    };
  });
  const budget = jsonField(response.response.meta, "budget");
  const truncated = budget?.kind === "object" ? jsonField(budget, "truncated") : undefined;
  return {
    rows,
    raw: response.response.data,
    partial: truncated?.kind === "boolean" && truncated.value,
    continuation: response.pagination,
  };
}

export function readScope(context: FeatureContext) {
  return {
    connectionId: context.connection.id,
    generation: context.connection.generation,
    workspaceId:
      context.route.workspaceId === null ? undefined : id(context.route.workspaceId, "Workspace"),
    projectId:
      context.route.projectId === null ? undefined : id(context.route.projectId, "Project"),
    actorId: context.writer.actorId === null ? undefined : id(context.writer.actorId, "Actor"),
    runId: context.writer.runId === null ? undefined : id(context.writer.runId, "Run"),
    history: { kind: "current" as const },
  };
}
