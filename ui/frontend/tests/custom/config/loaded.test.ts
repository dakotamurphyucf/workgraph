import { expect, it } from "vitest";
import {
  matchesLoaded,
  sortLoaded,
  timelineTime,
  utcTime,
  projectSessionRow,
} from "../../../src/features/custom/config/loaded";
import { decodeConfigValue } from "../../../src/features/custom/config/decode";
import { initialQuery } from "../../../src/features/custom/config/query";
import { parseJsonText, jsonField } from "../../../src/core/json";
import * as d from "../../../src/core/protocol/decoders";
import { sessionRecord } from "../../../src/features/history/transcript/codecs";
import { semanticIssues } from "../../../src/features/custom/config/semantics";
import type { ViewConfig } from "../../../src/features/custom/config/types";
function config(source: string, changes: object = {}): ViewConfig {
  const parsed = parseJsonText(
    JSON.stringify({
      config_version: 1,
      kind: "view",
      id: "fixture",
      title: "Fixture",
      source,
      scope: { kind: "workspace" },
      filter_mode: "loaded",
      filters: [],
      sort: [],
      group_by: null,
      presentation: "table",
      columns: [
        {
          id: "value",
          selector: {
            kind: "field",
            field: source === "facts" ? "key" : source === "resources" ? "name" : "title",
          },
          label: "Value",
          format: { type: "text" },
        },
      ],
      ...changes,
    }),
  );
  if (!parsed.ok) throw new Error("parse");
  const result = decodeConfigValue(parsed.value.value);
  if (result.kind !== "valid" || !("kind" in result.document) || result.document.kind !== "view")
    throw new Error(JSON.stringify(result));
  return result.document;
}
it("keeps exact typed filters literal and makes missing distinct from null", () => {
  const row = {
    identity: "r",
    fields: { name: d.jsonString("Case.[literal]*"), value: d.jsonNull(), n: d.jsonNumber("1.0") },
    decoded: d.jsonObject([["n", d.jsonNull()]]),
  };
  expect(matchesLoaded(row, { field: "name", op: "contains_text", value: "[literal]*" })).toBe(
    true,
  );
  expect(matchesLoaded(row, { field: "name", op: "literal_prefix", value: "case" })).toBe(false);
  expect(
    matchesLoaded(row, { field: "n", op: "equals", value: { kind: "number", lexeme: "1" } }),
  ).toBe(false);
  expect(matchesLoaded(row, { pointer: "/n", op: "equals", value: { kind: "null" } })).toBe(true);
  expect(matchesLoaded(row, { pointer: "/missing", op: "equals", value: { kind: "null" } })).toBe(
    false,
  );
});
it("sorts huge numbers exactly, nulls last in either direction, identity ties and invalid dates explicitly", () => {
  const view = config("resources", {
    sort: [{ field: "size_bytes", direction: "desc", nulls: "last" }],
  });
  const rows = [
    { identity: "missing", fields: {} },
    { identity: "a", fields: { size_bytes: d.jsonNumber("9007199254740993") } },
    { identity: "b", fields: { size_bytes: d.jsonNumber("9007199254740992") } },
    { identity: "z", fields: { size_bytes: d.jsonNumber("9007199254740993.0") } },
  ];
  expect(sortLoaded(rows, view).map((row) => row.identity)).toEqual(["a", "z", "b", "missing"]);
  expect(
    sortLoaded(rows, {
      ...view,
      sort: [{ field: "size_bytes", direction: "asc", nulls: "last" }],
    }).map((row) => row.identity),
  ).toEqual(["b", "a", "z", "missing"]);
  for (const date of ["2026-02-30T00:00:00Z", "2026-01-01", "2026-01-01T00:00:00+01:00"])
    expect(utcTime(d.jsonString(date))).toBeNull();
  const sessions = config("sessions", {
    presentation: "timeline",
    sort: [{ field: "created_at", direction: "desc", nulls: "last" }],
  });
  expect(timelineTime({ identity: "unknown", fields: {} }, sessions)).toBeNull();
  expect(
    timelineTime(
      { identity: "known", fields: { created_at: d.jsonString("1970-01-01T00:00:00Z") } },
      sessions,
    ),
  ).toBe(0);
});
it("lowers exact native scope kinds without inventing project IDs or leaking loaded filters", () => {
  const ws = d.identifier.decode(d.jsonString("demo"));
  if (!ws.ok) throw new Error("ws");
  const discussion = config("discussions", {
    filter_mode: "server",
    scope: { kind: "project", id: "project" },
    filters: [
      { field: "scope", op: "equals", value: "project" },
      { field: "state", op: "equals", value: "open" },
    ],
  });
  const query = initialQuery(discussion, ws.value);
  expect(query.method).toBe("thread.list");
  expect(jsonField(query.params, "scope")).toEqual(
    d.jsonObject([
      ["kind", d.jsonString("project")],
      ["id", d.jsonString("project")],
    ]),
  );
  expect(query.params.fields.filter((field) => field.name === "scope")).toHaveLength(1);
  const loaded = initialQuery({ ...discussion, filter_mode: "loaded" }, ws.value);
  expect(jsonField(loaded.params, "state")).toBeUndefined();
  expect(loaded.loadedOnly).toBe(true);
});

it("projects native session milliseconds exactly and never invents attempt timestamps", () => {
  const parsed = parseJsonText(
    JSON.stringify({
      workspace_id: "demo",
      session_id: "known",
      title: "Session",
      actor_id: "actor",
      run_id: null,
      parent_event: null,
      scopes: [],
      archived: false,
      created_at_unix_ms: "9007199254740993",
      last_event_at_unix_ms: null,
    }),
  );
  if (!parsed.ok) throw new Error("parse");
  const session = sessionRecord.decode(parsed.value.value);
  if (!session.ok) throw new Error(session.issue.expected);
  const row = projectSessionRow(session.value);
  expect(row.fields.created_at).toEqual(d.jsonNumber("9007199254740993"));
  expect(row.fields.last_event_at).toEqual(d.jsonNull());
  const timeline = config("sessions", {
    presentation: "timeline",
    sort: [{ field: "created_at", direction: "asc", nulls: "last" }],
  });
  const lower = projectSessionRow({
    ...session.value,
    session_id: session.value.actor_id,
    created_at_unix_ms: "9007199254740992",
  });
  expect(sortLoaded([row, lower], timeline).map((r) => r.identity)).toEqual(["actor", "known"]);
  expect(timelineTime(row, timeline)).toBeNull();
  expect(
    timelineTime(
      projectSessionRow({ ...session.value, created_at_unix_ms: "1761955200123" }),
      timeline,
    ),
  ).toBe(1761955200123);
  const nanoRows = [
    { identity: "earlier", fields: { created_at: d.jsonString("2026-01-01T00:00:00.000000001Z") } },
    { identity: "later", fields: { created_at: d.jsonString("2026-01-01T00:00:00.000000002Z") } },
  ];
  expect(sortLoaded([...nanoRows].reverse(), timeline).map((r) => r.identity)).toEqual([
    "earlier",
    "later",
  ]);
  expect(
    semanticIssues({
      ...timeline,
      source: "attempts",
      columns: [],
      sort: [{ field: "created_at", direction: "asc", nulls: "last" }],
    }),
  ).not.toEqual([]);
});
