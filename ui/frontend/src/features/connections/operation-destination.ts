/** Display projection only. Never changes a preparation, request, navigation context or retry. */
export interface DestinationReference {
  readonly kind: "project" | "milestone" | "ticket" | "resource";
  /** Explicit immutable parameter; not inferred ancestry or current selection. */
  readonly id: string;
}
export type OperationTarget =
  | { readonly kind: "daemon" }
  | {
      readonly kind: "workspace_registry";
      readonly action: "create" | "register" | "open" | "close" | "unregister";
      readonly workspaceId: string | null;
      /** Captured native root for create/register, not a browser filesystem operation. */
      readonly root: string | null;
    }
  | {
      readonly kind: "workspace";
      readonly workspaceId: string;
      readonly references: readonly DestinationReference[];
    }
  | {
      readonly kind: "batch";
      readonly workspaceId: string | null;
      /** Multiple entities/aliases remain explicit in Exact request; no guessed single target. */
      readonly operationCount: number | null;
    }
  | {
      readonly kind: "unspecified";
      readonly references: readonly DestinationReference[];
    };
export interface OperationDestination {
  readonly source: "captured_parameters" | "saved_request";
  readonly method: string;
  readonly target: OperationTarget;
}
import { jsonField } from "../../core/json";
import type { JsonObject, Operation, Preparation } from "../../core/protocol/types";

const registryActions = new Map<string, "create" | "register" | "open" | "close" | "unregister">([
  ["workspace.create", "create"],
  ["workspace.register", "register"],
  ["workspace.open", "open"],
  ["workspace.close", "close"],
  ["workspace.unregister", "unregister"],
]);

function text(params: JsonObject, name: string): string | null {
  const value = jsonField(params, name);
  return value?.kind === "string" && value.value.length > 0 ? value.value : null;
}
function references(params: JsonObject): readonly DestinationReference[] {
  const found: DestinationReference[] = [];
  for (const kind of ["project", "milestone", "ticket", "resource"] as const) {
    const id = text(params, `${kind}_id`);
    if (id !== null) found.push(Object.freeze({ kind, id }));
  }
  return Object.freeze(found);
}

/** Input has already passed the shared preparation/operation decoder. The saved
 * request is authoritative after preparation; navigation context is never read. */
export function operationDestination(
  preparation: Preparation,
  operation: Operation | null,
): OperationDestination {
  const source = operation === null ? "captured_parameters" : "saved_request";
  const methodValue = operation === null ? null : jsonField(operation.request, "method");
  const paramsValue = operation === null ? null : jsonField(operation.request, "params");
  const method = methodValue?.kind === "string" ? methodValue.value : preparation.method;
  const params = paramsValue?.kind === "object" ? paramsValue : preparation.params;
  const workspaceId = text(params, "workspace_id");
  let target: OperationTarget;
  const action = registryActions.get(method);
  if (method.startsWith("daemon.")) target = { kind: "daemon" };
  else if (action !== undefined)
    target = { kind: "workspace_registry", action, workspaceId, root: text(params, "root") };
  else if (method === "transaction.apply" || method === "transaction.preflight") {
    const operations = jsonField(params, "operations");
    target = {
      kind: "batch",
      workspaceId,
      operationCount: operations?.kind === "array" ? operations.items.length : null,
    };
  } else if (workspaceId !== null)
    target = { kind: "workspace", workspaceId, references: references(params) };
  else target = { kind: "unspecified", references: references(params) };
  return Object.freeze({ source, method, target: Object.freeze(target) });
}

/** Parameter references do not establish entity ancestry or destination defaults. */
export function destinationText(destination: OperationDestination): string {
  const target = destination.target;
  const refs = (values: readonly DestinationReference[]) =>
    values.map((value) => `${value.kind} reference ${value.id}`).join(" · ");
  switch (target.kind) {
    case "daemon":
      return "Daemon endpoint (no workspace target).";
    case "workspace_registry": {
      const identity =
        target.workspaceId === null
          ? target.action === "create"
            ? "New workspace (ID assigned by the daemon)"
            : target.action === "register"
              ? "Workspace registry (ID read from the captured root)"
              : "Workspace registry (workspace ID not summarized)"
          : `Workspace ${target.workspaceId}`;
      return `${identity}${target.root === null ? "" : ` · root ${target.root}`}.`;
    }
    case "workspace": {
      const explicit = refs(target.references);
      return `Workspace ${target.workspaceId}${explicit === "" ? "" : ` · ${explicit}`}.`;
    }
    case "batch":
      return `${target.workspaceId === null ? "Workspace not summarized" : `Workspace ${target.workspaceId}`} · batch of ${target.operationCount ?? "multiple"} operations; entity targets and aliases are in the exact request.`;
    case "unspecified": {
      const explicit = refs(target.references);
      return `Target not summarized${explicit === "" ? "" : ` · ${explicit}`}; inspect the exact request.`;
    }
  }
}
