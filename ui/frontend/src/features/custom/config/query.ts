import type { JsonValue } from "../../../core/json";
import * as d from "../../../core/protocol/decoders";
import type { Identifier, JsonObject } from "../../../core/protocol/types";
import { configJson, scopeJson } from "./encode";
import { decodeConfigValue } from "./decode";
import { ConfigInputError } from "./publication";
import type { ViewConfig } from "./types";
/** Initial query only. Continuations must retain the endpoint, scope and native capture returned by the owning adapter. */
export function initialQuery(
  config: ViewConfig,
  workspaceId: Identifier,
): { readonly method: string; readonly params: JsonObject; readonly loadedOnly: boolean } {
  const decoded = decodeConfigValue(configJson(config));
  if (decoded.kind !== "valid" || !("kind" in decoded.document) || decoded.document.kind !== "view")
    throw new ConfigInputError("Repair the view configuration before querying.");
  const view = decoded.document;
  const fields: (readonly [string, JsonValue])[] = [
    ["workspace_id", d.jsonString(workspaceId)],
    ["limit", d.jsonString("100")],
    ["max_bytes", d.jsonString("1048576")],
  ];
  let method: string;
  switch (view.source) {
    case "tickets":
      method = "ticket.list";
      if (view.scope.kind === "project") fields.push(["project_id", d.jsonString(view.scope.id)]);
      break;
    case "runs":
      method = "run.list";
      break;
    case "attempts":
      method = "attempt.list";
      if (view.scope.kind === "ticket") fields.push(["ticket_id", d.jsonString(view.scope.id)]);
      break;
    case "sessions":
      method = "session.list";
      if (view.filter_mode === "server" && view.sort[0] !== undefined)
        fields.push(["order", d.jsonString(view.sort[0].field)]);
      break;
    case "resources":
      method = "resource.list";
      fields.push(["target", scopeJson(view.scope)]);
      break;
    case "facts":
      method = "fact.keys";
      fields.push(["scope", scopeJson(view.scope)]);
      break;
    case "discussions":
      method = "thread.list";
      fields.push(["scope", scopeJson(view.scope)]);
      break;
    case "activity":
      method = "activity.digest";
      fields.push([
        "scope",
        d.jsonObject([
          ["kind", d.jsonString(view.scope.kind)],
          ...(view.scope.kind === "workspace"
            ? []
            : [
                [
                  view.scope.kind === "project" ? "project_id" : "ticket_id",
                  d.jsonString(view.scope.id),
                ] as const,
              ]),
        ]),
      ]);
      break;
  }
  if (view.filter_mode === "server") {
    const predicates: JsonValue[] = [];
    for (const filter of view.filters) {
      if ("pointer" in filter) {
        predicates.push(
          d.jsonObject([
            ["pointer", d.jsonString(filter.pointer)],
            ["equals", filter.value],
          ]),
        );
        continue;
      }
      if (filter.op === "one_of") throw new Error("Validated server filter cannot contain one_of.");
      if (
        (view.source === "discussions" && filter.field === "scope") ||
        (view.source === "tickets" &&
          view.scope.kind === "project" &&
          filter.field === "project_id") ||
        (view.source === "attempts" && view.scope.kind === "ticket" && filter.field === "ticket_id")
      )
        continue;
      fields.push([
        view.source === "facts" && filter.field === "key" ? "prefix" : filter.field,
        typeof filter.value === "string" ? d.jsonString(filter.value) : filter.value,
      ]);
    }
    if (predicates.length > 0) fields.push(["predicates", d.jsonArray(predicates)]);
  }
  return Object.freeze({
    method,
    params: d.jsonObject(fields),
    loadedOnly:
      view.filter_mode === "loaded" || (view.sort.length > 0 && view.source !== "sessions"),
  });
}
