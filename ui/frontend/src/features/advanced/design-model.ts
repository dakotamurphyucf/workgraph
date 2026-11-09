import type { FeatureContext } from "../../app/types";
import type { IconName } from "../../components/Icon";
import type { ReferenceKind } from "../discussions/reference-choices";
import type { AdvancedDraft } from "./types";
import { jsonField } from "../../core/json";
import type { JsonObject } from "./fields";
export const EXPLORER_SECTIONS = {
  methods: {
    title: "Methods",
    icon: "advanced",
    tone: "blue",
    description:
      "Browse operations the daemon can perform. Read methods retrieve information; write methods can change saved data.",
  },
  helpers: {
    title: "Helpers",
    icon: "workflow",
    tone: "purple",
    description:
      "Find guided workflows and CLI shortcuts. These instructions help you combine operations for a task.",
  },
  host: {
    title: "Host tools",
    icon: "connection",
    tone: "green",
    description:
      "Copy commands for the machine running Workgraph. The browser shows instructions and never runs a shell command.",
  },
  saved: {
    title: "Saved requests",
    icon: "saved",
    tone: "orange",
    description:
      "Inspect requests registered during this browser session. Review their original destination and outcome before executing or retrying.",
  },
} satisfies Record<string, { title: string; icon: IconName; tone: string; description: string }>;

/** Only existing read targets and explicit relationship fields use directory
 * suggestions. New record IDs remain free text. Never borrow current workspace
 * suggestions for a differently targeted or stale captured request. */
export function fieldChoiceKind(
  method: string,
  mode: string,
  name: string,
): ReferenceKind | "actor" | null {
  const references: Readonly<Record<string, ReferenceKind | "actor">> = {
    ticket_id: "ticket",
    project_id: "project",
    milestone_id: "milestone",
    resource_id: "resource",
    board_id: "board",
    thread_id: "thread",
    run_id: "run",
    attempt_id: "attempt",
    actor_id: "actor",
  };
  const relationships: Readonly<Record<string, ReferenceKind | "actor">> = {
    parent_ticket_id: "ticket",
    assignee_id: "actor",
    destination_board_id: "board",
  };
  if (Object.hasOwn(relationships, name)) return relationships[name] ?? null;
  if (mode !== "read" || /\.(create|register)$/u.test(method)) return null;
  return Object.hasOwn(references, name) ? (references[name] ?? null) : null;
}
export function matchesChoiceScope(
  context: FeatureContext,
  draft: AdvancedDraft,
  params: JsonObject,
): boolean {
  const workspace = jsonField(params, "workspace_id");
  return (
    workspace?.kind === "string" &&
    workspace.value === draft.selection.workspaceId &&
    workspace.value === context.route.workspaceId &&
    context.connection.id === draft.selection.connection.id &&
    context.connection.generation === draft.selection.connection.generation &&
    context.connection.socket === draft.selection.connection.socket
  );
}
