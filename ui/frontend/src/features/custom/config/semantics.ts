import { canonicalJson, type JsonValue } from "../../../core/json";
import type { ConfigDocument, ConfigIssue, ConfigSource, ViewConfig } from "./types";
import * as d from "../../../core/protocol/decoders";
import { TICKET_STATUSES } from "../../work/read-model.types";

export type FieldKind = "text" | "number" | "boolean" | "time" | "json";
interface SourceContract {
  readonly scopes: readonly string[];
  readonly fields: Readonly<Record<string, FieldKind>>;
  readonly server: Readonly<
    Record<
      string,
      "id" | "text" | "boolean" | "priority" | "status" | "prefix" | "scope" | "thread_state"
    >
  >;
  readonly sorts: readonly string[];
  readonly groups: readonly string[];
}
/** These are adapter fields, not arbitrary paths into a daemon response. */
const contracts: Readonly<Record<ConfigSource, SourceContract>> = {
  tickets: {
    scopes: ["workspace", "project"],
    fields: {
      ticket_id: "text",
      title: "text",
      status: "text",
      priority: "number",
      assignee_id: "text",
      project_id: "text",
      milestone_id: "text",
    },
    server: {
      project_id: "id",
      assignee_id: "id",
      label_id: "id",
      milestone_id: "id",
      priority: "priority",
      status: "status",
      text: "text",
    },
    sorts: ["title", "status", "priority", "assignee_id", "project_id", "milestone_id"],
    groups: ["status", "priority", "assignee_id", "project_id", "milestone_id"],
  },
  runs: {
    scopes: ["workspace"],
    fields: {
      run_id: "text",
      actor_id: "text",
      status: "text",
      objective: "text",
      parent_run_id: "text",
    },
    server: {},
    sorts: ["run_id", "actor_id", "status"],
    groups: ["actor_id", "status"],
  },
  attempts: {
    scopes: ["workspace", "ticket"],
    fields: {
      attempt_id: "text",
      ticket_id: "text",
      target_run_id: "text",
      state: "text",
    },
    server: { ticket_id: "id", target_run_id: "id" },
    sorts: ["state"],
    groups: ["state", "ticket_id", "target_run_id"],
  },
  sessions: {
    scopes: ["workspace"],
    fields: {
      session_id: "text",
      title: "text",
      actor_id: "text",
      run_id: "text",
      archived: "boolean",
      created_at: "time",
      last_event_at: "time",
    },
    server: { run_id: "id", include_archived: "boolean" },
    sorts: ["session_id", "created_at", "last_event_at"],
    groups: ["actor_id", "run_id", "archived"],
  },
  resources: {
    scopes: ["workspace", "project", "ticket", "milestone"],
    fields: {
      resource_id: "text",
      name: "text",
      mime_type: "text",
      version: "number",
      size_bytes: "number",
      archived: "boolean",
    },
    server: { include_archived: "boolean" },
    sorts: ["name", "mime_type", "version", "size_bytes"],
    groups: ["mime_type", "archived"],
  },
  facts: {
    scopes: ["workspace", "project", "ticket", "milestone"],
    fields: { key: "text", revision: "number", value: "json" },
    server: { key: "prefix" },
    sorts: ["key", "revision"],
    groups: ["key"],
  },
  discussions: {
    scopes: ["workspace", "project"],
    fields: {
      thread_id: "text",
      title: "text",
      board_id: "text",
      scope: "text",
      state: "text",
      unresolved: "boolean",
    },
    server: {
      actor_id: "id",
      board_id: "id",
      scope: "scope",
      state: "thread_state",
      text: "text",
      unresolved: "boolean",
    },
    sorts: ["title", "state", "board_id"],
    groups: ["state", "board_id"],
  },
  activity: {
    scopes: ["workspace", "project", "ticket"],
    fields: { kind: "text", actor_id: "text", revision: "number", summary: "text" },
    server: {},
    sorts: [],
    groups: [],
  },
};
for (const contract of Object.values(contracts)) {
  Object.freeze(contract.scopes);
  Object.freeze(contract.fields);
  Object.freeze(contract.server);
  Object.freeze(contract.sorts);
  Object.freeze(contract.groups);
  Object.freeze(contract);
}
export const sourceContracts = Object.freeze(contracts);
function validServerValue(type: string, value: JsonValue): boolean {
  switch (type) {
    case "id":
      return d.identifier.decode(value).ok;
    case "boolean":
      return value.kind === "boolean";
    case "priority":
      return value.kind === "string" && ["0", "1", "2", "3", "4"].includes(value.value);
    case "status":
      return value.kind === "string" && TICKET_STATUSES.some((status) => status === value.value);
    case "scope":
      return value.kind === "string" && (value.value === "workspace" || value.value === "project");
    case "thread_state":
      return (
        value.kind === "string" && ["open", "awaiting_response", "resolved"].includes(value.value)
      );
    default:
      return value.kind === "string";
  }
}
function validateView(view: ViewConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const issue = (path: string[], message: string) => issues.push({ path, message });
  const contract = sourceContracts[view.source];
  if (!contract.scopes.includes(view.scope.kind))
    issue(["scope"], `Unsupported ${view.source} scope.`);
  const field = (name: string, path: string[]) => {
    if (!Object.hasOwn(contract.fields, name)) issue(path, `Unknown ${view.source} adapter field.`);
  };
  const columns = new Set<string>();
  for (const [i, column] of view.columns.entries()) {
    if (columns.has(column.id)) issue(["columns", String(i), "id"], "Column IDs must be unique.");
    columns.add(column.id);
    if (column.selector.kind === "field")
      field(column.selector.field, ["columns", String(i), "selector"]);
    else if (view.source !== "facts" && view.source !== "resources")
      issue(
        ["columns", String(i), "selector"],
        "Pointers select fact values or explicitly decoded resource JSON only.",
      );
  }
  const serverFields = new Set<string>();
  for (const [i, filter] of view.filters.entries()) {
    const path = ["filters", String(i)];
    if ("pointer" in filter) {
      if (view.source !== "facts")
        issue(path, "Pointer predicates are supported only for fact values.");
      if (
        view.filter_mode === "server" &&
        !canonicalJson(filter.value, {
          maxBytes: 4096,
          maxDepth: 1,
          maxNodes: 8,
          maxStringBytes: 4096,
        }).ok
      )
        issue(path, "Native fact scalar predicates must encode within 4096 bytes.");
      continue;
    }
    if (view.filter_mode === "loaded") field(filter.field, [...path, "field"]);
    if (
      view.filter_mode === "loaded" &&
      (filter.op === "literal_prefix" || filter.op === "contains_text") &&
      contract.fields[filter.field] !== "text"
    )
      issue(path, "Literal text operators require a documented text field.");
    if (view.filter_mode === "server") {
      const kind = Object.hasOwn(contract.server, filter.field)
        ? contract.server[filter.field]
        : undefined;
      const op =
        kind === "prefix" ? "literal_prefix" : filter.field === "text" ? "contains_text" : "equals";
      if (
        kind === undefined ||
        filter.op === "one_of" ||
        filter.op !== op ||
        !validServerValue(
          kind,
          typeof filter.value === "string" ? d.jsonString(filter.value) : filter.value,
        )
      )
        issue(
          path,
          "This exact field/operator/value is not supported by the server adapter; use loaded mode.",
        );
      if (
        view.source === "tickets" &&
        filter.field === "text" &&
        filter.op === "contains_text" &&
        new TextEncoder().encode(filter.value).byteLength > 256
      )
        issue(path, "Ticket server text is bounded to 256 UTF-8 bytes.");
      if (
        view.source === "discussions" &&
        filter.field === "scope" &&
        (filter.op !== "equals" ||
          filter.value.kind !== "string" ||
          filter.value.value !== view.scope.kind)
      )
        issue(
          path,
          "Scope kind must agree with the explicit workspace/project view scope; its identity comes from that capture.",
        );
      if (
        view.source === "facts" &&
        filter.field === "key" &&
        filter.op === "literal_prefix" &&
        (new TextEncoder().encode(filter.value).byteLength > 128 ||
          filter.value.trim().length === 0)
      )
        issue(path, "Native fact prefixes must be nonblank and at most 128 UTF-8 bytes.");
      if (serverFields.has(filter.field))
        issue(path, "Server selectors must not repeat a native parameter.");
      serverFields.add(filter.field);
      if (
        (view.scope.kind === "ticket" && filter.field === "ticket_id") ||
        (view.scope.kind === "project" && filter.field === "project_id")
      ) {
        if (
          filter.op !== "equals" ||
          filter.value.kind !== "string" ||
          filter.value.value !== view.scope.id
        )
          issue(path, "Filter conflicts with the explicit scope target.");
      }
    }
  }
  if (view.source === "sessions" && view.filter_mode === "server" && view.sort.length > 1)
    issue(
      ["sort"],
      "Native session order accepts one field; use loaded mode for compound sorting.",
    );
  const sorts = new Set<string>();
  for (const [i, sort] of view.sort.entries()) {
    if (!contract.sorts.includes(sort.field)) issue(["sort", String(i)], "Unsupported sort field.");
    if (sorts.has(sort.field)) issue(["sort", String(i)], "Sort fields must be unique.");
    sorts.add(sort.field);
    if (
      view.filter_mode === "server" &&
      view.source === "sessions" &&
      sort.field === "session_id" &&
      sort.direction !== "asc"
    )
      issue(["sort", String(i)], "Native session ID order is ascending.");

    if (
      view.filter_mode === "server" &&
      view.source === "sessions" &&
      sort.field !== "session_id" &&
      sort.direction !== "desc"
    )
      issue(["sort", String(i)], "Native session timestamp order is descending.");
  }
  if (view.group_by !== null && !contract.groups.includes(view.group_by))
    issue(["group_by"], "Unsupported grouping field.");
  if (
    view.presentation === "board" &&
    (view.group_by === null || (view.source === "tickets" && view.group_by !== "status"))
  )
    issue(["group_by"], "A board needs supported grouping; ticket boards group by status.");
  if (view.presentation === "timeline" && contract.fields[view.sort[0]?.field ?? ""] !== "time")
    issue(["sort"], "A timeline needs a documented timestamp as its first sort field.");
  return issues;
}
export function semanticIssues(document: ConfigDocument): readonly ConfigIssue[] {
  if (!("kind" in document)) return [];
  switch (document.kind) {
    case "view":
      return validateView(document);
    case "renderer": {
      const issues: ConfigIssue[] = [];
      if (document.match.key_prefix !== undefined && document.match.entity !== "fact")
        issues.push({ path: ["match", "key_prefix"], message: "Key prefixes match facts only." });
      if (document.match.mime_type !== undefined && document.match.entity !== "resource")
        issues.push({
          path: ["match", "mime_type"],
          message: "MIME selectors match resources only.",
        });
      return issues;
    }
    case "catalog": {
      const seen = new Set<string>();
      const issues: ConfigIssue[] = [];
      for (const [i, entry] of document.entries.entries()) {
        if (seen.has(entry.id))
          issues.push({
            path: ["entries", String(i)],
            message: "Catalog configuration IDs must be unique.",
          });
        seen.add(entry.id);
      }
      return issues;
    }
  }
}
