import type { Route } from "../../app/types";
import { jsonField, type JsonValue } from "../../core/json";
import { jsonObject, jsonString } from "../../core/protocol/decoders";
import type { JsonObject } from "../../core/protocol/types";
import { field } from "../overview/codecs";
import { sourceRoute } from "../overview/model";
import type { OverviewScope } from "../overview/types";

export interface ChangeDescription {
  readonly verb: string;
  readonly subject: string;
  readonly detail: string | null;
  readonly route: Route | null;
}
function at(value: JsonValue | undefined, ...path: string[]): JsonValue | undefined {
  for (const key of path) value = value === undefined ? undefined : jsonField(value, key);
  return value;
}
function text(value: JsonValue | undefined, key: string): string | null {
  return value === undefined ? null : field(value, key);
}
/** Describe only facts in the retained change. A ticket snapshot is not a diff:
 * do not claim an assignment/status/dependency changed just because it is present. */
export function describeChange(change: JsonObject, scope: OverviewScope): ChangeDescription {
  const kind = field(change, "kind") ?? "unknown change";
  const link = (kind: string, key: string, id: string | null, revision?: string | null) =>
    id === null
      ? null
      : sourceRoute(
          scope,
          jsonObject([
            ["kind", jsonString(kind)],
            [key, jsonString(id)],
            ...(revision == null ? [] : [["revision", jsonString(revision)] as const]),
          ]),
        );
  if (["ticket_put", "project_put", "milestone_put"].includes(kind)) {
    const name = kind.replace("_put", ""),
      record = at(change, name);
    const id = text(record, `${name}_id`);
    return {
      verb: text(record, "revision") === "1" ? `created ${name}` : `updated ${name}`,
      subject: text(record, "title") ?? id ?? name,
      detail: [text(record, "display_key") ?? id, text(record, "status")?.replaceAll("_", " ")]
        .filter(Boolean)
        .join(" · "),
      route: name === "ticket" ? link("ticket", "ticket_id", id) : null,
    };
  }
  if (kind === "comment_changed") {
    const record = at(change, "change"),
      version = at(record, "version"),
      target = at(record, "target");
    const operation = text(record, "kind"),
      category = text(record, "comment_kind") ?? "comment";
    const tombstone = at(version, "tombstone");
    const deleted = tombstone?.kind === "boolean" && tombstone.value;
    const targetName = text(target, "kind") ?? "workspace";
    const id = text(target, `${targetName}_id`);
    return {
      verb: deleted
        ? "removed a comment on"
        : operation === "create"
          ? text(record, "reply_to_comment_id") !== null
            ? "replied on"
            : category === "progress"
              ? "shared progress on"
              : `added a ${category} on`
          : "edited a comment on",
      subject: id ?? text(record, "comment_id") ?? targetName,
      detail: deleted ? "Comment removed" : text(version, "body"),
      route:
        targetName === "ticket"
          ? link("ticket", "ticket_id", id)
          : link("comment", "comment_id", text(record, "comment_id"), text(version, "revision")),
    };
  }
  if (kind === "resource_changed") {
    const record = at(change, "change"),
      metadata = at(record, "metadata");
    return {
      verb:
        text(record, "kind") === "published"
          ? "published resource"
          : "updated resource details for",
      subject: text(metadata, "title") ?? text(record, "resource_id") ?? "resource",
      detail: [text(record, "resource_id"), text(metadata, "description")]
        .filter(Boolean)
        .join(" · "),
      route: null,
    };
  }
  if (kind === "facts_changed") {
    const record = at(change, "fact"),
      deleted = at(record, "deleted");
    return {
      verb:
        deleted?.kind === "boolean" && deleted.value
          ? "deleted fact"
          : text(record, "revision") === "1"
            ? "created fact"
            : "updated fact",
      subject: text(record, "key") ?? "fact",
      detail: [
        text(at(record, "scope"), "kind"),
        text(record, "revision") ? `Version ${text(record, "revision")}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      route: null,
    };
  }
  if (kind === "agent_run_changed") {
    const update = at(change, "event", "update"),
      run = at(update, "run");
    if (run !== undefined)
      return {
        verb: text(run, "revision") === "1" ? "registered run" : "updated run",
        subject: text(run, "run_id") ?? "run",
        detail: [text(run, "status"), text(run, "objective")].filter(Boolean).join(" · "),
        route: link("run", "run_id", text(run, "run_id")),
      };
  }
  if (kind === "policy_changed") {
    const command = at(change, "change", "command"),
      usage = at(command, "usage");
    if (text(command, "kind") === "usage_report" && usage !== undefined) {
      const run = text(at(usage, "scope"), "run_id");
      return {
        verb: "reported usage for",
        subject: run ?? "an attempt",
        detail: `${text(usage, "tokens") ?? "Unknown"} tokens · ${text(usage, "elapsed_ms") ?? "Unknown"} ms (reported)`,
        route: link("run", "run_id", run),
      };
    }
  }
  const labels: Readonly<Record<string, string>> = {
    facts_changed: "updated a fact",
    communication_changed: "recorded a discussion update",
    agent_run_changed: "recorded a participant update",
    hierarchy_policy_put: "updated workflow rules",
    amendment_changed: "updated a ticket amendment",
    amendment_unchanged: "acknowledged an amendment",
    evidence_changed: "recorded an evidence update",
    policy_changed: "updated run policy",
    policy_unchanged: "confirmed run policy",
    ticket_recovered: "recovered ticket ownership",
    signal_receipt: "recorded a signal receipt",
    settings_changed: "updated workspace settings",
    workspace_updated: "updated the workspace",
    handoff_put: "updated a handoff",
    resource_changed: "recorded a resource update",
    allocation_empty: "found no work to allocate",
  };
  return {
    verb: labels[kind] ?? `recorded ${kind.replaceAll("_", " ")}`,
    subject: "",
    detail: null,
    route: null,
  };
}
/** Native Core timestamps carry nanoseconds. Date needs milliseconds; display
 * browser-local time but preserve the complete native timestamp in details. */
export function auditDate(timestamp: string): Date | null {
  const date = new Date(timestamp.replace(" ", "T").replace(/(\.\d{3})\d+(?=Z$)/u, "$1"));
  return Number.isNaN(date.getTime()) ? null : date;
}
