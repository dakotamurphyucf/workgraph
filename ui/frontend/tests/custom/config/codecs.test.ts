import { describe, expect, it } from "vitest";
import { parseJsonText } from "../../../src/core/json";
import { decodeConfigValue } from "../../../src/features/custom/config/decode";
import { boundedInteger } from "../../../src/features/custom/config/values";
const pin = { resource_id: "renderer", version: "1", digest: "a".repeat(64), size_bytes: "10" };
export const view = {
  config_version: 1,
  kind: "view",
  id: "release-facts",
  title: "Release facts",
  source: "facts",
  scope: { kind: "project", id: "runtime" },
  filter_mode: "server",
  filters: [{ field: "key", op: "literal_prefix", value: "release." }],
  sort: [],
  group_by: null,
  presentation: "table",
  columns: [
    {
      id: "key",
      selector: { kind: "field", field: "key" },
      label: "Key",
      format: { type: "text" },
    },
    {
      id: "state",
      selector: { kind: "pointer", pointer: "/state" },
      label: "State",
      format: { type: "text" },
    },
  ],
};
export const renderer = {
  config_version: 1,
  kind: "renderer",
  id: "release-check",
  title: "Release check",
  match: { entity: "fact", key_prefix: "release.", root_type: "object" },
  presentation: {
    type: "fields",
    fields: [
      {
        pointer: "/state",
        label: "State",
        format: { type: "enum", values: [{ value: "ok", label: "Ready", tone: "success" }] },
      },
      { pointer: "/elapsed_ms", label: "Elapsed", format: { type: "duration", unit: "ms" } },
    ],
  },
  fallback: "generic",
};
export function decode(raw: string) {
  const parsed = parseJsonText(raw);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return decodeConfigValue(parsed.value.value);
}
const checked = (value: unknown) => decode(JSON.stringify(value));
describe("reviewed closed configuration v1", () => {
  it("accepts the four exact roots and retains unknown versions without v1 coercion", () => {
    for (const value of [
      view,
      renderer,
      {
        config_version: 1,
        kind: "catalog",
        entries: [{ kind: "renderer", id: "release-check", pin }],
      },
      { config_version: 1, catalog: pin },
    ])
      expect(checked(value).kind).toBe("valid");
    expect(checked({ config_version: 2, arbitrary_future_field: true }).kind).toBe(
      "unsupported_version",
    );
    for (const config_version of [0, -1, 2])
      expect(checked({ config_version, future: true }).kind).toBe("unsupported_version");
    expect(checked({ config_version: "2" }).kind).toBe("invalid");
    for (const value of [
      { ...view, script: "fetch('https://example.com')" },
      { config_version: 1, kind: "index", catalog: pin },
      { config_version: 1, catalog: { ...pin, version: 1 } },
      { config_version: 1, catalog: { ...pin, size_bytes: "4611686018427387904" } },
    ])
      expect(checked(value).kind).toBe("invalid");
  });
  it("rejects illegal fields, cross-entity matching, duplicate identities and bounded selectors", () => {
    for (const value of [
      { ...view, columns: [...view.columns, view.columns[0]] },
      { ...view, title: "é".repeat(257) },
      { ...view, columns: [{ ...view.columns[0], width: 79 }] },
      { ...view, filters: Array(9).fill(view.filters[0]) },
      {
        ...view,
        columns: [{ ...view.columns[0], selector: { kind: "pointer", pointer: "/bad~2" } }],
      },
      { ...renderer, match: { entity: "resource", key_prefix: "release." } },
      { ...renderer, match: { entity: "history", mime_type: "text/plain" } },
      { ...renderer, presentation: { type: "code", pointer: "", language: "remote-grammar" } },
      {
        config_version: 1,
        kind: "catalog",
        entries: [
          { kind: "view", id: "same", pin },
          { kind: "renderer", id: "same", pin },
        ],
      },
    ])
      expect(checked(value).kind).toBe("invalid");
    expect(boundedInteger("100.000000000000000000001", 80, 800)).toBeNull();
    expect(boundedInteger("8e1", 80, 800)).toBe(80);
    expect(boundedInteger("800.000", 80, 800)).toBe(800);
    expect(boundedInteger("800.00000000000001", 80, 800)).toBeNull();
  });
  it("keeps server contracts separate from loaded-only filters and legal scopes", () => {
    const runs = {
      ...view,
      source: "runs",
      scope: { kind: "workspace" },
      columns: [{ ...view.columns[0], selector: { kind: "field", field: "actor_id" } }],
      filters: [{ field: "actor_id", op: "equals", value: "actor" }],
    };
    expect(checked(runs).kind).toBe("invalid");
    expect(checked({ ...runs, filter_mode: "loaded" }).kind).toBe("valid");
    expect(
      checked({
        ...runs,
        filter_mode: "loaded",
        filters: [{ field: "private_internals", op: "equals", value: "actor" }],
      }).kind,
    ).toBe("invalid");
    expect(
      checked({
        ...view,
        source: "activity",
        scope: { kind: "workspace" },
        columns: [{ ...view.columns[0], selector: { kind: "field", field: "summary" } }],
      }).kind,
    ).toBe("invalid");
    expect(
      checked({ ...view, source: "facts", scope: { kind: "ticket", id: "ticket" } }).kind,
    ).toBe("valid");
    expect(checked({ ...runs, scope: { kind: "project", id: "p" }, filters: [] }).kind).toBe(
      "invalid",
    );
  });
  it("requires explicit board grouping and supported timeline timestamps", () => {
    const sessions = {
      ...view,
      source: "sessions",
      scope: { kind: "workspace" },
      filters: [],
      columns: [{ ...view.columns[0], selector: { kind: "field", field: "title" } }],
      presentation: "timeline",
      sort: [{ field: "created_at", direction: "desc", nulls: "last" }],
    };
    expect(checked(sessions).kind).toBe("valid");
    expect(checked({ ...sessions, sort: [] }).kind).toBe("invalid");
    expect(
      checked({ ...sessions, sort: [{ field: "created_at", direction: "asc", nulls: "last" }] })
        .kind,
    ).toBe("invalid");
    const tickets = {
      ...sessions,
      source: "tickets",
      presentation: "board",
      sort: [],
      group_by: "status",
    };
    expect(checked(tickets).kind).toBe("valid");
    expect(checked({ ...tickets, group_by: "priority" }).kind).toBe("invalid");
  });
});
it("validates endpoint-specific text/prefix/state and single native session ordering", () => {
  const base = {
    ...view,
    source: "sessions",
    scope: { kind: "workspace" },
    filters: [],
    columns: [{ ...view.columns[0], selector: { kind: "field", field: "title" } }],
    sort: [{ field: "session_id", direction: "asc", nulls: "last" }],
  };
  expect(checked(base).kind).toBe("valid");
  expect(
    checked({ ...base, sort: [{ field: "session_id", direction: "desc", nulls: "last" }] }).kind,
  ).toBe("invalid");
  expect(
    checked({
      ...base,
      sort: [...base.sort, { field: "created_at", direction: "desc", nulls: "last" }],
    }).kind,
  ).toBe("invalid");
  expect(
    checked({
      ...base,
      filter_mode: "loaded",
      sort: [...base.sort, { field: "created_at", direction: "asc", nulls: "last" }],
    }).kind,
  ).toBe("valid");
  const tickets = {
    ...base,
    source: "tickets",
    sort: [],
    filters: [{ field: "text", op: "contains_text", value: "é".repeat(129) }],
  };
  expect(checked(tickets).kind).toBe("invalid");
  expect(
    checked({
      ...tickets,
      filter_mode: "loaded",
      filters: [{ field: "title", op: "contains_text", value: "é".repeat(129) }],
    }).kind,
  ).toBe("valid");
  expect(
    checked({ ...view, filters: [{ field: "key", op: "literal_prefix", value: "é".repeat(65) }] })
      .kind,
  ).toBe("invalid");
  expect(
    checked({ ...view, filters: [{ pointer: "", op: "equals", value: "x".repeat(4096) }] }).kind,
  ).toBe("invalid");
  const discussions = {
    ...base,
    source: "discussions",
    sort: [],
    filters: [{ field: "state", op: "equals", value: "done" }],
  };
  expect(checked(discussions).kind).toBe("invalid");
  expect(
    checked({ ...discussions, filters: [{ field: "scope", op: "equals", value: "project" }] }).kind,
  ).toBe("invalid");
  expect(
    checked({ ...discussions, filters: [{ field: "state", op: "equals", value: "resolved" }] })
      .kind,
  ).toBe("valid");
});

it("separates native query options from projected row columns and loaded predicates", () => {
  for (const [source, field, value] of [
    ["sessions", "include_archived", false],
    ["resources", "include_archived", false],
    ["tickets", "text", "needle"],
    ["tickets", "label_id", "label"],
    ["discussions", "text", "needle"],
  ] as const) {
    const base = {
      ...view,
      source,
      scope: { kind: "workspace" },
      columns: [
        {
          ...view.columns[0],
          selector: { kind: "field", field: source === "resources" ? "name" : "title" },
        },
      ],
      filters: [{ field, op: field === "text" ? "contains_text" : "equals", value }],
    };
    expect(checked(base).kind).toBe("valid");
    expect(checked({ ...base, filter_mode: "loaded" }).kind).toBe("invalid");
    expect(
      checked({
        ...base,
        filters: [],
        columns: [{ ...base.columns[0], selector: { kind: "field", field } }],
      }).kind,
    ).toBe("invalid");
  }
});

it("keeps discussion actor selector separate from nonexistent row ownership", () => {
  const threadView = {
    ...view,
    source: "discussions",
    filters: [],
    columns: [{ ...view.columns[0], selector: { kind: "field", field: "title" } }],
  };
  expect(
    checked({ ...threadView, filters: [{ field: "actor_id", op: "equals", value: "actor" }] }).kind,
  ).toBe("valid");
  for (const patch of [
    { columns: [{ ...threadView.columns[0], selector: { kind: "field", field: "actor_id" } }] },
    { filter_mode: "loaded", filters: [{ field: "actor_id", op: "equals", value: "actor" }] },
    { sort: [{ field: "actor_id", direction: "asc", nulls: "last" }] },
    { group_by: "actor_id" },
  ])
    expect(checked({ ...threadView, ...patch }).kind).toBe("invalid");
});
