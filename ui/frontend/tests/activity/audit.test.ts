import { afterEach, expect, it } from "vitest";
import { jsonField, parseJsonText } from "../../src/core/json";
import * as d from "../../src/core/protocol/decoders";
import type { HttpClient, HttpRequest, HttpResult } from "../../src/core/protocol/http";
import type { JsonObject } from "../../src/core/protocol/types";
import { auditCodec, createActivityClient } from "../../src/features/activity/client";
import { auditDate, describeChange } from "../../src/features/activity/model";
import { field } from "../../src/features/overview/codecs";
import { counter, identifier } from "../../src/features/overview/model";
import type { OverviewScope } from "../../src/features/overview/types";
import { createTestProcessor } from "../core/processing-harness";
const clean: (() => void)[] = [];
afterEach(() => {
  for (const fn of clean.splice(0)) fn();
});
const scope: OverviewScope = {
  connection: {
    id: identifier("local", "id"),
    generation: counter("1", "generation"),
    label: "Local",
    socket: "/tmp/activity.sock",
  },
  workspaceId: identifier("demo", "id"),
  projectId: identifier("project", "id"),
  actorId: null,
  runId: null,
};
function raw(value: unknown) {
  const parsed = parseJsonText(JSON.stringify(value));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value.value;
}
function event(revision: number) {
  return {
    revision: String(revision),
    actor_id: "actual-writer",
    run_id: null,
    timestamp: "2026-11-08 04:00:46.207629056Z",
    targets: [],
    changes: [
      {
        kind: "ticket_put",
        ticket: {
          ticket_id: "task",
          title: "A task",
          revision: "2",
          status: "done",
          assignee_id: "someone-else",
        },
      },
    ],
  };
}
function setup(
  options: { total?: number; clip?: number; wrongRevision?: boolean; wrongOffset?: boolean } = {},
) {
  const calls: JsonObject[] = [],
    processing = createTestProcessor();
  clean.push(() => processing.dispose());
  const http: HttpClient = {
    processing,
    request: <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
      if (request.path !== "/read" || request.method !== "POST" || !request.body)
        throw new Error("read only");
      const params = jsonField(request.body, "params");
      if (params?.kind !== "object" || field(request.body, "method") !== "activity.since")
        throw new Error("audit selectors");
      calls.push(params);
      const total = options.total ?? 80,
        offset = Number(field(params, "offset")),
        limit = Number(field(params, "limit"));
      const count = Math.min(total - offset, limit, options.clip ?? 100);
      const data = {
        items: Array.from({ length: count }, (_, i) => event(offset + i + 1)),
        offset: String(options.wrongOffset ? offset + 1 : offset),
        remaining: String(total - offset - count),
        next_offset: offset + count === total ? null : String(offset + count),
      };
      const decoded = request.codec.decode(
        raw({
          response: {
            data,
            meta: { workspace_revision: options.wrongRevision && calls.length > 1 ? "81" : "80" },
          },
          pagination: null,
        }),
      );
      if (!decoded.ok) throw new Error(decoded.issue.expected);
      return Promise.resolve({ ok: true, data: decoded.value, httpStatus: 200 });
    },
  };
  return { api: createActivityClient(http), calls };
}
it("seeks to newest 25 events at the count capture without scanning older pages", async () => {
  const { api, calls } = setup();
  const result = await api.window(
    scope,
    { ticketId: "", actorId: "" },
    null,
    new AbortController().signal,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("window failed");
  expect(result.data.events.map((e) => e.revision)).toEqual(
    Array.from({ length: 25 }, (_, i) => String(i + 56)),
  );
  expect(result.data).toMatchObject({ start: 55n, end: 80n, total: 80n });
  expect(calls.map((c) => [field(c, "offset"), field(c, "at_revision")])).toEqual([
    ["0", null],
    ["55", "80"],
  ]);
  expect(calls.every((c) => field(c, "project_id") === "project")).toBe(true);
  const earlier = await api.window(
    scope,
    { ticketId: "", actorId: "" },
    { revision: result.data.revision, end: result.data.start, total: result.data.total },
    new AbortController().signal,
  );
  expect(earlier.ok && earlier.data.events.at(-1)?.revision).toBe("55");
});
it("follows actual byte-clipped counts without gaps or overlapping the previous window", async () => {
  const { api, calls } = setup({ clip: 7 });
  const result = await api.window(
    scope,
    { ticketId: "task", actorId: "writer" },
    null,
    new AbortController().signal,
  );
  expect(result.ok && result.data.events.length).toBe(25);
  expect(calls.map((c) => field(c, "offset"))).toEqual(["0", "55", "62", "69", "76"]);
  expect(
    calls.every((c) => field(c, "project_id") === null && field(c, "actor_id") === "writer"),
  ).toBe(true);
  expect(jsonField(calls[0]!, "target")).toEqual(
    d.jsonObject([
      ["kind", d.jsonString("ticket")],
      ["ticket_id", d.jsonString("task")],
    ]),
  );
});
it("rejects a moved capture and malformed offsets", async () => {
  for (const options of [{ wrongRevision: true }, { wrongOffset: true }]) {
    const { api } = setup(options);
    const result = await api.window(
      scope,
      { ticketId: "", actorId: "" },
      null,
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
  }
});
it("empty history needs only a count capture", async () => {
  const { api, calls } = setup({ total: 0 });
  const result = await api.window(
    scope,
    { ticketId: "", actorId: "" },
    null,
    new AbortController().signal,
  );
  expect(result.ok && result.data.events).toEqual([]);
  expect(calls.length).toBe(1);
});
it("retains immutable event identities on refresh without sharing across filters", async () => {
  const { api } = setup();
  const filter = { ticketId: "", actorId: "" };
  const signal = new AbortController().signal;
  const a = await api.window(scope, filter, null, signal);
  const b = await api.window(scope, filter, null, signal);
  const c = await api.window(scope, { ...filter, actorId: "writer" }, null, signal);
  if (!a.ok || !b.ok || !c.ok) throw new Error("window failed");
  expect(a.data.events[0]).toBe(b.data.events[0]);
  expect(a.data.events[0]).not.toBe(c.data.events[0]);
});
it("uses native attribution and nanosecond time, not assignee or current ticket state as an event", () => {
  const decoded = auditCodec.decode(raw(event(25)));
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) throw new Error("audit decode");
  expect(decoded.value.actorId).toBe("actual-writer");
  expect(auditDate(decoded.value.timestamp)?.toISOString()).toBe("2026-11-08T04:00:46.207Z");
  expect(auditDate("not a time")).toBeNull();
  expect(describeChange(decoded.value.changes[0]!, scope)).toMatchObject({
    verb: "updated ticket",
    subject: "A task",
  });
});

it("describes retained resources, fact deletion and comment revisions without inventing a target", () => {
  const describe = (value: unknown) => {
    const record = raw(value);
    if (record.kind !== "object") throw new Error("Expected change object");
    return describeChange(record, scope);
  };
  expect(
    describe({
      kind: "resource_changed",
      change: {
        kind: "published",
        resource_id: "notes",
        metadata: { title: "Launch notes", description: "Review checklist" },
      },
    }),
  ).toMatchObject({
    verb: "published resource",
    subject: "Launch notes",
    detail: "notes · Review checklist",
    route: null,
  });
  expect(
    describe({
      kind: "facts_changed",
      fact: {
        key: "launch.ready",
        revision: "2",
        deleted: true,
        scope: { kind: "project", id: "release" },
      },
    }),
  ).toMatchObject({ verb: "deleted fact", subject: "launch.ready", detail: "project · Version 2" });
  const revised = describe({
    kind: "comment_changed",
    change: {
      kind: "revise",
      comment_id: "note",
      version: { revision: "2", body: "Updated decision", tombstone: false },
    },
  });
  expect(revised.subject).toBe("note");
  expect(revised.route?.entityId).toBe("note");
  expect(revised.route?.discussion).toMatchObject({
    kind: "comment",
    revision: "2",
  });
});
