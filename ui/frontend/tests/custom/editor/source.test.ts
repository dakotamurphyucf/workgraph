import { expect, it } from "vitest";
import { jsonField, parseJsonText, type JsonValue } from "../../../src/core/json";
import * as c from "../../../src/core/protocol/codec";
import * as d from "../../../src/core/protocol/decoders";
import type { ReadInvocation, ReadResponse } from "../../../src/core/protocol/types";
import { decodeSourcePage } from "../../../src/features/custom/editor/source";
import { initialQuery, type ConfigSource } from "../../../src/features/custom/config";
import { view } from "../config/fixtures";
import { decode, json, target } from "./fixtures";
import fixtures from "./native-source-fixtures.json";
const names: readonly ConfigSource[] = [
  "tickets",
  "runs",
  "attempts",
  "sessions",
  "resources",
  "facts",
  "discussions",
  "activity",
];
function rawFixture(index: number) {
  const fixture = fixtures[index];
  if (fixture === undefined) throw new Error("native fixture");
  const parsed = parseJsonText(fixture.response);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const result = d.publicResponse.decode(jsonField(parsed.value.value, "result"));
  if (!result.ok) throw new Error(result.issue.expected);
  const source = names[index];
  if (source === undefined) throw new Error("source");
  const config = view(
    source,
    index === 4 || index === 5 || index === 6 ? { scope: { kind: "project", id: "release" } } : {},
  );
  const meta = result.value.meta;
  const head = jsonField(jsonField(meta, "history_capture") ?? d.jsonNull(), "head");
  const capture =
    source === "sessions"
      ? d.jsonObject([["head", head ?? d.jsonNull()]])
      : source === "activity"
        ? d.jsonObject([
            [
              "through",
              jsonField(jsonField(result.value.data, "capture") ?? d.jsonNull(), "through") ??
                d.jsonNull(),
            ],
            [
              "lineage",
              jsonField(jsonField(result.value.data, "capture") ?? d.jsonNull(), "lineage") ??
                d.jsonNull(),
            ],
          ])
        : source === "runs" || source === "attempts" || source === "discussions"
          ? d.jsonObject([
              ["query_revision", jsonField(meta, "query_revision") ?? d.jsonNull()],
              ["query_scope", d.jsonString(source === "discussions" ? "communication" : "runs")],
              ...(head === undefined ? [] : [["head", head] as const]),
            ])
          : d.jsonObject([
              ["workspace_revision", jsonField(meta, "workspace_revision") ?? d.jsonNull()],
            ]);
  const pagination = decode(c.object, {
    complete: true,
    stop: "complete",
    consistency:
      source === "sessions"
        ? "immutable_history_head"
        : source === "activity"
          ? "opaque_captured_cursor"
          : "current_revision_guard",
    capture: null,
    next_request: null,
    retry_request: null,
    required_bytes: null,
    returned_bytes: "100",
    max_bytes: "65536",
  });
  const response: ReadResponse = {
    response: result.value,
    pagination: d.jsonObject(
      pagination.fields.map((field) => [
        field.name,
        field.name === "capture" ? capture : field.value,
      ]),
    ),
  };
  const query = initialQuery(config, target.workspaceId);
  const invocation: ReadInvocation = {
    connection_id: target.connection.id,
    generation: target.connection.generation,
    lane: source === "sessions" ? "history" : "visible",
    method: query.method,
    params: query.params,
  };
  return { config, response, invocation };
}
function set(value: JsonValue, name: string, field: JsonValue) {
  if (value.kind !== "object") throw new Error("object");
  return d.jsonObject([
    ...value.fields
      .filter((item) => item.name !== name)
      .map((item) => [item.name, item.value] as const),
    [name, field],
  ]);
}
it.each(names.map((name, index) => ({ name, index })))(
  "projects actual native $name readback without invented row fields",
  ({ index }) => {
    const { config, response, invocation } = rawFixture(index),
      page = decodeSourcePage(target, config, invocation, response);
    if (!page.ok)
      throw new Error(page.failure.kind === "protocol" ? page.failure.message : page.failure.kind);
    expect(page.data.rows.length).toBeGreaterThan(0);
    if (config.source === "sessions")
      expect(page.data.rows[0]?.fields.created_at?.kind).toBe("number");
    if (config.source === "attempts")
      expect(page.data.rows[0]?.fields).not.toHaveProperty("created_at");
    if (config.source === "discussions")
      expect(page.data.rows[0]?.fields).not.toHaveProperty("actor_id");
  },
);
it("valid advancing traversal survives omitted fields while remaining explicitly partial", () => {
  const { config, response, invocation } = rawFixture(0);
  if (response.pagination === null) throw new Error("pagination");
  const revision = jsonField(response.response.meta, "workspace_revision") ?? d.jsonNull();
  const params = set(set(invocation.params, "offset", d.jsonString("3")), "at_revision", revision);
  const request = d.jsonObject([
    ["jsonrpc", d.jsonString("2.0")],
    ["workgraph_api", d.jsonString("0.7")],
    ["id", d.jsonString("next")],
    ["method", d.jsonString(invocation.method)],
    ["params", params],
  ]);
  const pagination = set(
    set(
      set(response.pagination, "complete", d.jsonBoolean(false)),
      "stop",
      d.jsonString("page_limit"),
    ),
    "next_request",
    request,
  );
  const result = decodeSourcePage(target, config, invocation, {
    response: {
      data: set(
        set(response.response.data, "next_offset", d.jsonString("3")),
        "remaining",
        d.jsonString("1"),
      ),
      meta: set(
        response.response.meta,
        "budget",
        json({ truncated: true, omitted_fields: "1", omitted_items: "0" }),
      ),
    },
    pagination,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("page");
  expect(result.data.partial).toBe(true);
  expect(result.data.next).not.toBeNull();
  expect(result.data.complete).toBe(false);
  const changed = set(params, "project_id", d.jsonString("another-project"));
  const invalid = set(pagination, "next_request", set(request, "params", changed));
  expect(
    decodeSourcePage(target, config, invocation, { ...response, pagination: invalid }).ok,
  ).toBe(false);
  const wrongOffset = set(
    pagination,
    "next_request",
    set(request, "params", set(params, "offset", d.jsonString("0"))),
  );
  expect(
    decodeSourcePage(target, config, invocation, { ...response, pagination: wrongOffset }).ok,
  ).toBe(false);
});
it("rejects continuation capture metadata inconsistent with original returned native capture", () => {
  const { config, response, invocation } = rawFixture(0);
  if (response.pagination === null) throw new Error("pagination");
  const changed = set(response.pagination, "capture", json({ workspace_revision: "999" }));
  expect(
    decodeSourcePage(target, config, invocation, { ...response, pagination: changed }).ok,
  ).toBe(false);
});
