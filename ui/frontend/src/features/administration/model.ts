import { jsonField, type JsonValue } from "../../core/json";
import * as c from "../../core/protocol/codec";
import * as d from "../../core/protocol/decoders";
import type { Identifier, JsonObject } from "../../core/protocol/types";
import { observerContext, DraftInputError } from "../connections/model";
import type { AdminAction, AdminSelection, FrozenAdmin, LocalAction } from "./types";

export function identifier(value: string, label: string): Identifier {
  const result = d.identifier.decode(d.jsonString(value));
  if (!result.ok)
    throw new DraftInputError(
      `${label} requires 1–96 ASCII letters, digits, underscores or hyphens.`,
    );
  return result.value;
}
export function absolutePath(value: string, host = "daemon"): string {
  if (
    !value.startsWith("/") ||
    value.includes("\0") ||
    new TextEncoder().encode(value).length > 65536
  )
    throw new DraftInputError(`Enter an absolute path of at most 64 KiB on the ${host} host.`);
  return value;
}
export function identity(): Identifier {
  return identifier(`admin-${crypto.randomUUID()}`, "Generated identity");
}
/** Only bounded identifiers/paths are encoded here. Arbitrary restore JSON is parsed by the shared worker. */
export function freezeDaemon(
  selection: AdminSelection,
  action: AdminAction,
  intention: Identifier,
  roots?: JsonObject,
): FrozenAdmin {
  if (!selection.current || selection.connection === null)
    throw new DraftInputError("Choose a current connection before preparing this daemon action.");
  const context = observerContext(selection.route, selection.writer);
  if (context.writer === null)
    throw new DraftInputError("Choose an acting actor before preparing a daemon action.");
  const fields: [string, JsonValue][] = [["actor_id", d.jsonString(context.writer.actor_id)]];
  const put = (key: string, value: string) => fields.push([key, d.jsonString(value)]);
  let method: string;
  switch (action.kind) {
    case "workspace_export":
      method = "workspace.export";
      put("workspace_id", identifier(action.workspaceId, "Workspace"));
      put("destination", absolutePath(action.destination));
      break;
    case "export_all":
      method = "daemon.export_all";
      put("destination", absolutePath(action.destination));
      fields.push(["allow_partial", { kind: "boolean", value: action.allowPartial }]);
      break;
    case "export_cancel":
    case "export_retry":
      method = action.kind.replace("_", ".");
      put("job_id", identifier(action.jobId, "Export job"));
      break;
    case "workspace_restore":
      method = "workspace.restore";
      put("directory", absolutePath(action.directory));
      put("root", absolutePath(action.root));
      break;
    case "restore_all":
      method = "daemon.restore_all";
      put("directory", absolutePath(action.directory));
      if (!roots || roots.fields.length === 0 || roots.fields.length > 1000)
        throw new DraftInputError(
          "Provide an exact, nonempty workspace-to-root object with at most 1000 entries.",
        );
      for (const field of roots.fields) {
        identifier(field.name, "Workspace");
        const path = c.text.decode(field.value);
        if (!path.ok)
          throw new DraftInputError("Every restore root must be an absolute daemon-host path.");
        absolutePath(path.value);
      }
      fields.push(["roots", roots]);
      break;
    case "restore_cancel":
      method = "restore.cancel";
      put("target_actor_id", identifier(action.targetActor, "Original restore actor"));
      put("target_mutation_id", identifier(action.targetMutation, "Original restore mutation"));
      break;
  }
  return {
    kind: "daemon",
    preparation: {
      intention_id: intention,
      context: { ...context, writer: context.writer },
      connection_id: selection.connection.id,
      generation: selection.connection.generation,
      method,
      params: d.jsonObject(fields),
    },
  };
}
export function freezeLocal(
  selection: AdminSelection,
  action: LocalAction,
  intention: Identifier,
): FrozenAdmin {
  if (action.kind === "migrate_0_6_2") {
    absolutePath(action.source, "companion");
    absolutePath(action.destination, "companion");
    if (action.source === action.destination)
      throw new DraftInputError("Migration requires a fresh destination distinct from the source.");
  } else {
    absolutePath(action.stage, "companion");
    if (!/^[a-f0-9]{64}$/u.test(action.owner_token))
      throw new DraftInputError(
        "Use the exact 64-character cleanup owner token from the native helper diagnostic.",
      );
  }
  return {
    kind: "local",
    plan: {
      intention_id: intention,
      context: observerContext(selection.route, selection.writer),
      action,
    },
  };
}
/** Shell text is a copyable external handoff; this function never executes it. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function retryCommand(socket: string, path: string): string {
  return `workgraph retry ${shellQuote(absolutePath(socket, "selected daemon"))} ${shellQuote(absolutePath(path, "companion"))}`;
}
export function field<T>(value: JsonValue, name: string, codec: c.Codec<T>): T {
  const result = codec.decode(jsonField(value, name), [name]);
  if (!result.ok)
    throw new DraftInputError(
      `Result field ${name}: expected ${result.issue.expected}. Raw data is retained below.`,
    );
  return result.value;
}
