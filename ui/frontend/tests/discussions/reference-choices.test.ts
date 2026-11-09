import { harness } from "../participants/runs/harness";
import { run, attempt, response } from "../participants/runs/fixtures";
import { jsonField } from "../../src/core/json";
import { afterEach, describe, expect, it } from "vitest";
import type { HttpClient, HttpRequest, HttpResult } from "../../src/core/protocol/http";
import { readReferenceChoices } from "../../src/features/discussions/reference-choices";
import { createTestProcessor } from "../core/processing-harness";
import { context, decode, json, target } from "../work/actions-fixtures";
import * as d from "../../src/core/protocol/decoders";
const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});
function fixture(mode: "ok" | "duplicate" | "changed" | "incomplete") {
  const processing = createTestProcessor();
  disposals.push(() => processing.dispose());
  let calls = 0;
  const http: HttpClient = {
    processing,
    request: <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
      calls++;
      const second = calls === 2;
      const data = {
        items: [
          {
            board_id: second && mode !== "duplicate" ? "second" : "first",
            revision: "1",
            title: second ? "Second board" : "First board",
            scope: { kind: "workspace" },
          },
        ],
        offset: second ? "1" : "0",
        next_offset: second ? null : "1",
        remaining: second ? "0" : "1",
      };
      const params = {
        workspace_id: "demo",
        offset: "1",
        limit: "25",
        max_bytes: "1048576",
        revision: "7",
      };
      const result = request.codec.decode(
        json({
          response: {
            data,
            meta: {
              query_scope: "communication",
              query_revision: second && mode === "changed" ? "8" : "7",
              budget: {
                truncated: mode === "incomplete",
                omitted_fields: "0",
                omitted_items: "0",
                details_complete: mode !== "incomplete",
              },
            },
          },
          pagination: second ? null : { next_request: { method: "board.list", params } },
        }),
      );
      if (!result.ok) throw new Error(result.issue.expected);
      return Promise.resolve({ ok: true, httpStatus: 200, data: result.value });
    },
  };
  const scope = {
    connection: context(http).connection,
    workspaceId: decode(d.identifier, "demo"),
    projectId: null,
  };
  return { http, scope, calls: () => calls };
}
describe("workspace reference directory", () => {
  it("loads every ticket page without treating normal pagination as lost details", async () => {
    const processing = createTestProcessor();
    disposals.push(() => processing.dispose());
    let calls = 0;
    const http: HttpClient = {
      processing,
      request: <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
        calls++;
        const second = calls === 2;
        const raw = target(http).ticket.value.ticket.raw;
        const ticket = d.jsonObject(
          raw.fields.map((field) => [
            field.name,
            field.name === "ticket_id" ? d.jsonString(second ? "second" : "first") : field.value,
          ]),
        );
        const page = d.jsonObject([
          ["items", d.jsonArray([ticket])],
          ["offset", d.jsonString(second ? "1" : "0")],
          ["remaining", d.jsonString(second ? "0" : "1")],
          ["next_offset", second ? d.jsonNull() : d.jsonString("1")],
        ]);
        const decoded = request.codec.decode(
          d.jsonObject([
            [
              "response",
              d.jsonObject([
                ["data", page],
                [
                  "meta",
                  json({
                    workspace_revision: "7",
                    budget: {
                      truncated: false,
                      omitted_fields: "0",
                      omitted_items: "0",
                      details_complete: true,
                    },
                  }),
                ],
              ]),
            ],
            [
              "pagination",
              json({
                capture: { workspace_revision: "7" },
                consistency: "current_revision_guard",
                complete: second,
                stop: second ? "complete" : "page_limit",
                retry_request: null,
                next_request: second
                  ? null
                  : {
                      jsonrpc: "2.0",
                      workgraph_api: "0.7",
                      id: "next-ticket-page",
                      method: "ticket.list",
                      params: {
                        workspace_id: "demo",
                        limit: "40",
                        max_bytes: "1048576",
                        include_archived: false,
                        at_revision: "7",
                        offset: "1",
                      },
                    },
              }),
            ],
          ]),
        );
        if (!decoded.ok) throw new Error(decoded.issue.expected);
        return Promise.resolve({ ok: true, httpStatus: 200, data: decoded.value });
      },
    };
    const result = await readReferenceChoices(
      http,
      {
        connection: context(http).connection,
        workspaceId: decode(d.identifier, "demo"),
        projectId: null,
      },
      "ticket",
      new AbortController().signal,
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result).toMatchObject({ ok: true, data: [{ id: "first" }, { id: "second" }] });
    expect(calls).toBe(2);
  });

  it("follows native board continuations instead of stopping at the first list page", async () => {
    const f = fixture("ok");
    const result = await readReferenceChoices(
      f.http,
      f.scope,
      "board",
      new AbortController().signal,
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result).toMatchObject({ ok: true, data: [{ id: "first" }, { id: "second" }] });
    expect(f.calls()).toBe(2);
  });
  for (const mode of ["duplicate", "changed", "incomplete"] as const)
    it(`rejects ${mode} directory captures instead of offering misleading choices`, async () => {
      const f = fixture(mode);
      const result = await readReferenceChoices(
        f.http,
        f.scope,
        "board",
        new AbortController().signal,
      );
      expect(result.ok).toBe(false);
    });
  it("does not start reads for a cancelled directory", async () => {
    const f = fixture("ok"),
      abort = new AbortController();
    abort.abort();
    expect(await readReferenceChoices(f.http, f.scope, "board", abort.signal)).toEqual({
      ok: false,
      failure: { kind: "aborted" },
    });
    expect(f.calls()).toBe(0);
  });
});

describe("participant reference choices", () => {
  for (const kind of ["run", "attempt"] as const) {
    it(`loads guarded ${kind} pages and preserves their exact IDs`, async () => {
      let calls = 0;
      const h = harness({
        read: (_method, params) => {
          const second = calls++ > 0;
          if (second) {
            expect(jsonField(params, "expected_revision")).toEqual(d.jsonString("7"));
            if (kind === "run") expect(jsonField(params, "head")).toEqual(d.jsonNull());
          }
          return Promise.resolve({
            ok: true,
            httpStatus: 200,
            data: response(
              {
                items: [
                  kind === "run"
                    ? { ...run, run_id: second ? "second" : "first" }
                    : { ...attempt, attempt_id: second ? "second" : "first" },
                ],
                next_offset: second ? null : "1",
                omitted: second ? "0" : "1",
              },
              { query_scope: "runs", query_revision: "7", history_capture: { head: null } },
            ),
          });
        },
      });
      const result = await readReferenceChoices(
        h.context.client,
        {
          connection: h.context.connection,
          workspaceId: decode(d.identifier, "workspace"),
          projectId: null,
        },
        kind,
        new AbortController().signal,
      );
      expect(result.ok && result.data.map((x) => x.id)).toEqual(["first", "second"]);
      expect(calls).toBe(2);
    });
  }
  it("rejects a changed run-directory revision instead of presenting mixed choices", async () => {
    let calls = 0;
    const h = harness({
      read: () => {
        const second = calls++ > 0;
        return Promise.resolve({
          ok: true,
          httpStatus: 200,
          data: response(
            {
              items: [{ ...run, run_id: second ? "second" : "first" }],
              next_offset: second ? null : "1",
              omitted: second ? "0" : "1",
            },
            {
              query_scope: "runs",
              query_revision: second ? "8" : "7",
              history_capture: { head: null },
            },
          ),
        });
      },
    });
    const result = await readReferenceChoices(
      h.context.client,
      {
        connection: h.context.connection,
        workspaceId: decode(d.identifier, "workspace"),
        projectId: null,
      },
      "run",
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
  });
});

it("offers configured pool names and named reservations without inventing ownership", async () => {
  for (const kind of ["pool", "reservation"] as const) {
    const h = harness({
      read: () =>
        Promise.resolve({
          ok: true,
          httpStatus: 200,
          data: response(
            {
              items:
                kind === "pool"
                  ? [{ name: "Review capacity", limit: "2", revision: "1" }]
                  : [{ reservation_id: "browser-slot", epoch: "1", holders: [] }],
              next_offset: null,
              omitted: "0",
            },
            { query_scope: "runs", query_revision: "7" },
          ),
        }),
    });
    const result = await readReferenceChoices(
      h.context.client,
      {
        connection: h.context.connection,
        workspaceId: decode(d.identifier, "workspace"),
        projectId: null,
      },
      kind,
      new AbortController().signal,
    );
    expect(result.ok && result.data[0]?.id).toBe(
      kind === "pool" ? "Review capacity" : "browser-slot",
    );
  }
});

describe("session choices", () => {
  it.each([false, true])(
    "pins subsequent pages and rejects a changed capture (%s)",
    async (changed) => {
      const processing = createTestProcessor();
      disposals.push(() => processing.dispose());
      const requests: HttpRequest<unknown>[] = [];
      const http: HttpClient = {
        processing,
        request: <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
          requests.push(request);
          const second = requests.length === 2;
          const decoded = request.codec.decode(
            json({
              response: {
                data: {
                  items: [
                    {
                      workspace_id: "demo",
                      session_id: second ? "two" : "one",
                      title: second ? "Second session" : "First session",
                      actor_id: "alice",
                      run_id: null,
                      parent_event: null,
                      scopes: [],
                      archived: second,
                      created_at_unix_ms: null,
                      last_event_at_unix_ms: null,
                    },
                  ],
                  next_offset: second ? "2" : "1",
                  has_more: !second,
                },
                meta: {
                  history_capture: {
                    workspace_id: "demo",
                    head: (changed && second ? "b" : "a").repeat(64),
                    sequence: "2",
                    sessions: [
                      { session_id: "one", through: "0" },
                      { session_id: "two", through: "0" },
                    ],
                  },
                },
              },
              pagination: null,
            }),
          );
          if (!decoded.ok) throw Error(decoded.issue.expected);
          return Promise.resolve({ ok: true, httpStatus: 200, data: decoded.value });
        },
      };
      const result = await readReferenceChoices(
        http,
        {
          connection: context(http).connection,
          workspaceId: decode(d.identifier, "demo"),
          projectId: null,
        },
        "session",
        new AbortController().signal,
      );
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1]?.body)).toContain("a".repeat(64));
      expect(result.ok).toBe(!changed);
      if (result.ok)
        expect(result.data.map((x) => [x.id, x.detail])).toEqual([
          ["one", "alice · Open"],
          ["two", "alice · Archived"],
        ]);
    },
  );
});

describe("resource link choices", () => {
  it.each(["project", "milestone", "resource"] as const)(
    "loads %s choices at one planning revision",
    async (kind) => {
      const processing = createTestProcessor();
      disposals.push(() => processing.dispose());
      const requests: HttpRequest<unknown>[] = [];
      const http: HttpClient = {
        processing,
        request: <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
          requests.push(request);
          const second = requests.length === 2;
          const meta = { title: second ? "Second record" : "First record", archived: second };
          const row = {
            [`${kind}_id`]: second ? "second" : "first",
            ...(kind === "resource" ? { metadata: meta } : meta),
          };
          const result = request.codec.decode(
            json({
              response: {
                data: {
                  items: [row],
                  offset: second ? "1" : "0",
                  next_offset: second ? null : "1",
                  remaining: second ? "0" : "1",
                },
                meta: { workspace_revision: "7", budget: { truncated: false } },
              },
              pagination: null,
            }),
          );
          if (!result.ok) throw new Error(result.issue.expected);
          return Promise.resolve({ ok: true, httpStatus: 200, data: result.value });
        },
      };
      const scope = {
        connection: context(http).connection,
        workspaceId: decode(d.identifier, "demo"),
        projectId: null,
      };
      const result = await readReferenceChoices(http, scope, kind, new AbortController().signal);
      expect(result.ok && result.data.map((item) => item.id)).toEqual(["first", "second"]);
      const body = requests[1]?.body;
      if (!body) throw new Error("Missing continuation");
      const params = jsonField(body, "params");
      if (!params) throw new Error("Missing params");
      expect(jsonField(params, "at_revision")).toEqual(d.jsonString("7"));
    },
  );
  it.each(["changed", "partial", "stalled", "duplicate"] as const)(
    "rejects %s project choices",
    async (mode) => {
      const processing = createTestProcessor();
      disposals.push(() => processing.dispose());
      let count = 0;
      const http: HttpClient = {
        processing,
        request: <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
          const second = ++count === 2;
          const result = request.codec.decode(
            json({
              response: {
                data: {
                  items: [
                    {
                      project_id: second && mode !== "duplicate" ? "second" : "first",
                      title: "Project",
                      archived: false,
                    },
                  ],
                  next_offset: mode === "stalled" ? "0" : second ? null : "1",
                  remaining: second ? "0" : "1",
                },
                meta: {
                  workspace_revision: second && mode === "changed" ? "8" : "7",
                  budget: { truncated: mode === "partial" },
                },
              },
              pagination: null,
            }),
          );
          if (!result.ok) throw new Error(result.issue.expected);
          return Promise.resolve({ ok: true, httpStatus: 200, data: result.value });
        },
      };
      const result = await readReferenceChoices(
        http,
        {
          connection: context(http).connection,
          workspaceId: decode(d.identifier, "demo"),
          projectId: null,
        },
        "project",
        new AbortController().signal,
      );
      expect(result.ok).toBe(false);
    },
  );
});
