import { jsonField, type JsonValue } from "../../../core/json";
import * as d from "../../../core/protocol/decoders";
import type { JsonObject, ReadInvocation, ReadResponse } from "../../../core/protocol/types";
import {
  ActionInputError,
  counter,
  identity,
  object,
  readText,
  scalarText,
  validId,
} from "./model";
import type { AuxiliaryCapture, WorkDraft } from "./types";

export function auxiliaryKey(draft: WorkDraft): string | null {
  switch (draft.method) {
    case "related.add":
    case "related.remove":
      return "related";
    case "ticket.paths.put":
    case "ticket.hierarchy.put":
      return "policy";
    case "ticket.amendment.publish":
    case "ticket.amendment.withdraw":
    case "ticket.amendment.acknowledge":
      return "amendment";
    case "label.put":
    case "status.put":
      return "workflow";
    case "dependency.add":
    case "dependency.remove":
    case "dependency.waive":
    case "ticket.archive":
    case "ticket.claim":
    case "ticket.create":
    case "ticket.hold":
    case "ticket.metadata":
    case "ticket.move":
    case "ticket.reassign":
    case "ticket.recover":
    case "ticket.release":
    case "ticket.renew_lease":
    case "ticket.reopen":
    case "ticket.start":
    case "ticket.update":
      return null;
  }
}
function bool(value: JsonObject, name: string, expected: boolean): boolean {
  const field = jsonField(value, name);
  return field?.kind === "boolean" && field.value === expected;
}
export function auxiliaryInvocation(draft: WorkDraft, page?: "next" | "retry"): ReadInvocation {
  const key = auxiliaryKey(draft);
  if (key === null) throw new ActionInputError("This command has no auxiliary read.");
  const fields: [string, JsonValue][] = [["workspace_id", d.jsonString(draft.capture.workspaceId)]];
  const put = (name: string, value: string) => fields.push([name, d.jsonString(value)]);
  let method: string;
  if (key === "related") {
    method = "ticket.read";
    put("ticket_id", validId(scalarText(draft, "related_id"), "Related ticket"));
    const revision = draft.capture.ticket?.revision;
    if (revision === undefined) throw new ActionInputError("No captured planning revision.");
    put("at_revision", revision);
    put("max_bytes", "1048576");
  } else if (key === "amendment") {
    method = "ticket.amendment.get";
    put("amendment_id", validId(scalarText(draft, "amendment_id"), "Amendment"));
    put("max_bytes", "1048576");
  } else if (key === "policy") {
    method = draft.method === "ticket.paths.put" ? "ticket.paths.get" : "ticket.hierarchy.get";
    const ticket = draft.capture.ticket?.value.ticket;
    if (ticket === undefined) throw new ActionInputError("No captured ticket.");
    put("ticket_id", ticket.ticket_id);
    if (method === "ticket.paths.get") put("max_bytes", "1048576");
  } else {
    method = draft.method === "label.put" ? "label.list" : "status.list";
    fields.push(["include_archived", d.jsonBoolean(true)]);
    put("limit", "100");
    put("max_bytes", "1048576");
    put("offset", "0");
  }
  const params = page === undefined ? d.jsonObject(fields) : continuation(draft, method, page);
  return {
    connection_id: draft.capture.connection.id,
    generation: draft.capture.connection.generation,
    method,
    params,
    lane: "visible",
  };
}
function continuation(draft: WorkDraft, method: string, kind: "next" | "retry"): JsonObject {
  if (method !== "label.list" && method !== "status.list")
    throw new ActionInputError("Only the workflow directory has another page.");
  const prior = draft.auxiliary.workflow;
  if (prior?.kind !== "present" || prior.method !== method)
    throw new ActionInputError("Load the directory first.");
  const pagination = prior.response.pagination;
  if (pagination === null)
    throw new ActionInputError("This response did not retain a continuation.");
  const request = object(
    jsonField(pagination, kind === "next" ? "next_request" : "retry_request"),
    "Native continuation",
  );
  if (readText(jsonField(request, "method"), "Continuation method") !== method)
    throw new ActionInputError("Continuation changed the method.");
  const params = object(jsonField(request, "params"), "Continuation parameters");
  const allowed = new Set([
    "workspace_id",
    "include_archived",
    "limit",
    "max_bytes",
    "offset",
    "at_revision",
  ]);
  if (params.fields.some((field) => !allowed.has(field.name)))
    throw new ActionInputError("Continuation changed the directory selectors.");
  for (const name of ["workspace_id", "limit", "max_bytes"])
    if (readText(jsonField(params, name), name) !== readText(jsonField(prior.params, name), name))
      throw new ActionInputError("Continuation changed the directory capture.");
  if (!bool(params, "include_archived", true))
    throw new ActionInputError("Continuation changed archival selectors.");
  const revision = readText(
    jsonField(prior.response.response.meta, "workspace_revision"),
    "Directory planning revision",
  );
  if (readText(jsonField(params, "at_revision"), "Continuation revision") !== revision)
    throw new ActionInputError("Continuation changed the planning revision.");
  const data = object(prior.response.response.data, "Directory page");
  const expected =
    kind === "next"
      ? readText(jsonField(data, "next_offset"), "Next offset")
      : readText(jsonField(prior.params, "offset"), "Retry offset");
  if (readText(jsonField(params, "offset"), "Continuation offset") !== expected)
    throw new ActionInputError("Continuation changed the page offset.");
  return params;
}
export function validateAuxiliary(
  draft: WorkDraft,
  invocation: ReadInvocation,
  response: ReadResponse,
): AuxiliaryCapture {
  const data = object(response.response.data, "Auxiliary response");
  const ticketId = draft.capture.ticket?.value.ticket.ticket_id;
  if (invocation.method === "ticket.read") {
    const value = object(jsonField(data, "ticket"), "Related ticket");
    if (
      readText(jsonField(value, "ticket_id"), "Related ticket ID") !==
      readText(jsonField(invocation.params, "ticket_id"), "Requested ticket")
    )
      throw new ActionInputError("Related ticket read changed identity.");
    if (
      readText(jsonField(response.response.meta, "workspace_revision"), "Planning revision") !==
      readText(jsonField(invocation.params, "at_revision"), "Requested revision")
    )
      throw new ActionInputError("Related ticket read changed planning capture.");
    counter(readText(jsonField(value, "revision"), "Related revision"), "Related revision", true);
  } else if (
    invocation.method === "ticket.paths.get" ||
    invocation.method === "ticket.hierarchy.get"
  ) {
    if (readText(jsonField(data, "ticket_id"), "Policy ticket") !== ticketId)
      throw new ActionInputError("Policy belongs to another ticket.");
    if (invocation.method === "ticket.paths.get")
      counter(readText(jsonField(data, "revision"), "Policy revision"), "Policy revision", true);
    else {
      const policy = jsonField(data, "policy");
      if (policy?.kind !== "null")
        counter(
          readText(
            jsonField(object(policy, "Stored hierarchy policy"), "revision"),
            "Hierarchy revision",
          ),
          "Hierarchy revision",
          true,
        );
    }
  } else if (invocation.method === "ticket.amendment.get") {
    const reference = object(jsonField(data, "reference"), "Amendment reference");
    if (
      readText(jsonField(reference, "amendment_id"), "Returned amendment") !==
      readText(jsonField(invocation.params, "amendment_id"), "Requested amendment")
    )
      throw new ActionInputError("Amendment read changed identity.");
    const item = object(jsonField(data, "item"), "Complete amendment item");
    if (
      !bool(data, "needs_larger_budget", false) ||
      readText(jsonField(item, "ticket_id"), "Amendment ticket") !== ticketId
    )
      throw new ActionInputError("The complete amendment for this ticket was not returned.");
    counter(readText(jsonField(data, "head_revision"), "Amendment head"), "Amendment head", true);
  } else {
    const items = jsonField(data, "items");
    if (items?.kind !== "array" || items.items.length > 100)
      throw new ActionInputError("Directory page is malformed.");
    const offset = counter(
      readText(jsonField(data, "offset"), "Directory offset"),
      "Directory offset",
    );
    if (offset !== readText(jsonField(invocation.params, "offset"), "Requested offset"))
      throw new ActionInputError("Directory returned another offset.");
    const revision = counter(
      readText(jsonField(response.response.meta, "workspace_revision"), "Directory capture"),
      "Directory capture",
    );
    const requested = jsonField(invocation.params, "at_revision");
    if (requested !== undefined && readText(requested, "Requested capture") !== revision)
      throw new ActionInputError("Directory planning capture changed.");
    const next = jsonField(data, "next_offset");
    if (
      next?.kind !== "null" &&
      (counter(readText(next, "Next offset"), "Next offset") !==
        String(BigInt(offset) + BigInt(items.items.length)) ||
        items.items.length === 0)
    )
      throw new ActionInputError("Directory continuation did not advance by its returned items.");
    counter(readText(jsonField(data, "remaining"), "Remaining records"), "Remaining records");
    const idKey = invocation.method === "label.list" ? "label_id" : "status_id",
      seen = new Set<string>();
    for (const item of items.items) {
      const record = object(item, "Workflow record"),
        id = validId(readText(jsonField(record, idKey), idKey), idKey);
      if (seen.has(id)) throw new ActionInputError("Duplicate directory identity.");
      seen.add(id);
      counter(
        readText(jsonField(record, "revision"), "Workflow revision"),
        "Workflow revision",
        true,
      );
    }
  }
  return Object.freeze({
    id: identity("work-reference"),
    kind: "present",
    method: invocation.method,
    params: invocation.params,
    response,
  });
}
