import { jsonField } from "../../../core/json";
import { auxiliaryKey } from "./auxiliary";
import { ActionInputError, counter, object, readText, scalarText, validId } from "./model";
import type { FormInput, WorkDraft } from "./types";

/** Caller explicitly replaces fields. Completing a read never modifies an editor. */
export function filledInputs(draft: WorkDraft): Readonly<Record<string, FormInput>> {
  const key = auxiliaryKey(draft),
    capture = key === null ? undefined : draft.auxiliary[key];
  if (capture === undefined)
    throw new ActionInputError("Load a complete referenced record before replacing form values.");
  const data = object(capture.response.response.data, "Loaded record"),
    values: Record<string, FormInput> = { ...draft.inputs };
  const set = (name: string, value: string) => {
    values[name] = { kind: "scalar", presence: "value", text: value };
  };
  if (draft.method === "ticket.paths.put") {
    const rows = jsonField(data, "declarations");
    if (rows?.kind !== "array" || rows.items.length > 100)
      throw new ActionInputError("Path policy rows are malformed.");
    values.declarations = {
      kind: "paths",
      rows: rows.items.map((item) => {
        const row = object(item, "Path declaration"),
          target = object(jsonField(row, "target"), "Path target"),
          kind = readText(jsonField(target, "kind"), "Path kind"),
          mode = readText(jsonField(row, "mode"), "Path mode");
        if ((kind !== "file" && kind !== "subtree") || (mode !== "shared" && mode !== "exclusive"))
          throw new ActionInputError("Invalid path declaration enums.");
        return {
          worktreeId: readText(jsonField(target, "worktree_id"), "Worktree"),
          kind,
          path: readText(jsonField(target, "path"), "Logical path"),
          mode,
        };
      }),
    };
    const required = jsonField(data, "require_reservations");
    if (required?.kind !== "boolean") throw new ActionInputError("Missing reservation rule.");
    set("require_reservations", String(required.value));
    set("_revision_source", "loaded");
  } else if (draft.method === "ticket.hierarchy.put") {
    const effective = object(jsonField(data, "effective"), "Effective hierarchy policy");
    set(
      "descendant_prerequisites",
      readText(jsonField(effective, "descendant_prerequisites"), "Descendant policy"),
    );
    set(
      "child_completion",
      readText(jsonField(effective, "child_completion"), "Completion policy"),
    );
  } else if (draft.method === "label.put" || draft.method === "status.put") {
    const idKey = draft.method === "label.put" ? "label_id" : "status_id",
      items = jsonField(data, "items");
    if (items?.kind !== "array") throw new ActionInputError("Directory items are malformed.");
    const item = items.items.find(
      (value) =>
        value.kind === "object" &&
        jsonField(value, idKey)?.kind === "string" &&
        readText(jsonField(value, idKey), idKey) === scalarText(draft, idKey),
    );
    const record = object(item, "Selected directory record");
    set("name", readText(jsonField(record, "name"), "Name"));
    if (draft.method === "label.put")
      set("description", readText(jsonField(record, "description"), "Description"));
    else set("category", readText(jsonField(record, "category"), "Category"));
    const archived = jsonField(record, "archived");
    if (archived?.kind !== "boolean") throw new ActionInputError("Missing archival state.");
    set("archived", String(archived.value));
    set("_revision_source", "loaded");
  } else if (draft.method === "ticket.amendment.publish") {
    const item = object(jsonField(data, "item"), "Amendment item"),
      content = object(jsonField(item, "content"), "Amendment content");
    if (readText(jsonField(content, "kind"), "Content kind") !== "published")
      throw new ActionInputError("Only a published instruction revision can populate this form.");
    const publication = object(jsonField(content, "publication"), "Publication"),
      source = object(jsonField(publication, "source"), "Instruction source"),
      kind = readText(jsonField(source, "kind"), "Source kind");
    set("title", readText(jsonField(publication, "title"), "Title"));
    set("source_kind", kind);
    if (kind === "text")
      set("source_body", readText(jsonField(source, "body"), "Instruction text"));
    else if (kind === "resource") {
      const pin = object(jsonField(source, "pin"), "Resource pin");
      set("resource_id", readText(jsonField(pin, "resource_id"), "Resource"));
      set("resource_revision", readText(jsonField(pin, "revision"), "Version"));
      set("resource_digest", readText(jsonField(pin, "digest"), "Digest"));
    } else throw new ActionInputError("Unsupported instruction source.");
    const ack = jsonField(publication, "require_ack");
    if (ack?.kind !== "boolean") throw new ActionInputError("Missing acknowledgement rule.");
    set("require_ack", String(ack.value));
    const supersedes = jsonField(publication, "supersedes");
    if (supersedes?.kind !== "array" || supersedes.items.length > 32)
      throw new ActionInputError("Superseded instruction references are malformed.");
    values.supersedes = {
      kind: "amendments",
      rows: supersedes.items.map((value) => {
        const record = object(value, "Superseded amendment");
        return {
          amendmentId: validId(
            readText(jsonField(record, "amendment_id"), "Amendment ID"),
            "Amendment ID",
          ),
          revision: counter(
            readText(jsonField(record, "revision"), "Amendment version"),
            "Amendment version",
            true,
          ),
        };
      }),
    };
    set("_revision_source", "loaded");
  } else throw new ActionInputError("This action has no replaceable fields in its loaded record.");
  return Object.freeze(values);
}
