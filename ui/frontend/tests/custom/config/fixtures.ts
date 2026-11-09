import { parseJsonText } from "../../../src/core/json";
import * as d from "../../../src/core/protocol/decoders";
import { decodeConfigValue } from "../../../src/features/custom/config/decode";
import type {
  ConfigSource,
  ViewConfig,
  ConfigPublicationIntention,
} from "../../../src/features/custom/config/types";
export const identifier = (text: string) => {
  const r = d.identifier.decode(d.jsonString(text));
  if (!r.ok) throw new Error("identifier");
  return r.value;
};
export const decimal = (text: string) => {
  const r = d.decimal.decode(d.jsonString(text));
  if (!r.ok) throw new Error("decimal");
  return r.value;
};
export function view(source: ConfigSource = "facts", changes: object = {}): ViewConfig {
  const field = {
    tickets: "title",
    runs: "actor_id",
    attempts: "state",
    sessions: "title",
    resources: "name",
    facts: "key",
    discussions: "title",
    activity: "summary",
  }[source];
  const parsed = parseJsonText(
    JSON.stringify({
      config_version: 1,
      kind: "view",
      id: "config-view",
      title: "Configuration view",
      source,
      scope: { kind: "workspace" },
      filter_mode: "server",
      filters: [],
      sort: [],
      group_by: null,
      presentation: "table",
      columns: [
        { id: "main", selector: { kind: "field", field }, label: "Main", format: { type: "text" } },
      ],
      ...changes,
    }),
  );
  if (!parsed.ok) throw new Error(parsed.error.message);
  const result = decodeConfigValue(parsed.value.value);
  if (result.kind !== "valid" || !("kind" in result.document) || result.document.kind !== "view")
    throw new Error(JSON.stringify(result));
  return result.document;
}
export function intention(
  connection: ConfigPublicationIntention["capture"]["connection"],
  changes: Partial<ConfigPublicationIntention> = {},
): ConfigPublicationIntention {
  return {
    intentionId: identifier("config-publication"),
    documentResourceId: identifier("custom-view"),
    catalogResourceId: identifier("custom-catalog"),
    document: view(),
    capture: {
      connection,
      workspaceId: identifier("demo"),
      writer: { actorId: identifier("fixture-author"), runId: null },
      link: { kind: "workspace" },
      index: { scope: { kind: "workspace" }, expectedRevision: decimal("0") },
      documentBase: { kind: "missing" },
      catalogBase: { kind: "missing" },
      catalog: { kind: "new" },
    },
    ...changes,
  };
}
