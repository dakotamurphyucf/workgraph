import * as d from "../../../../core/protocol/decoders";
import { sourceContracts, type ConfigSource } from "../../config";
import type { FormDraft } from "./types";
import { change, textAt, variant } from "./model";

/** An explicit unsaved reset of query/layout fields, preserving identity and
 * unknown top-level fields. No source switch silently rewrites the user's query. */
export function suggestedSetup(draft: FormDraft, source: ConfigSource): FormDraft {
  const contract = sourceContracts[source];
  const preferred: Readonly<Record<ConfigSource, readonly string[]>> = {
    tickets: ["title", "status", "priority"],
    runs: ["actor_id", "status", "objective"],
    attempts: ["ticket_id", "state", "target_run_id"],
    sessions: ["title", "created_at", "archived"],
    resources: ["name", "mime_type", "size_bytes"],
    facts: ["key", "revision"],
    discussions: ["title", "state", "unresolved"],
    activity: ["summary", "kind", "actor_id"],
  };
  let next = change(
    draft,
    ["columns"],
    d.jsonArray(
      preferred[source].map((field) =>
        d.jsonObject([
          ["id", d.jsonString(field)],
          [
            "label",
            d.jsonString(
              field.replaceAll("_", " ").replace(/^./u, (letter) => letter.toUpperCase()),
            ),
          ],
          [
            "selector",
            d.jsonObject([
              ["kind", d.jsonString("field")],
              ["field", d.jsonString(field)],
            ]),
          ],
          [
            "format",
            d.jsonObject([
              [
                "type",
                d.jsonString(
                  field === "size_bytes"
                    ? "bytes"
                    : contract.fields[field] === "time"
                      ? "unix_ms"
                      : contract.fields[field] === "boolean"
                        ? "boolean"
                        : contract.fields[field] === "number"
                          ? "number"
                          : "text",
                ),
              ],
            ]),
          ],
        ]),
      ),
    ),
  );
  for (const key of ["sort", "filters"] as const) next = change(next, [key], d.jsonArray([]));
  next = change(next, ["group_by"], d.jsonNull());
  next = change(next, ["presentation"], d.jsonString("table"));
  next = change(next, ["filter_mode"], d.jsonString("server"));
  if (!contract.scopes.includes(textAt(next, ["scope", "kind"])))
    next = variant(next, ["scope"], ["kind", "id"], [["kind", d.jsonString("workspace")]]);
  return next;
}
