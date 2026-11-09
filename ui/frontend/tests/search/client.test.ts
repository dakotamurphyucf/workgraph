import { afterEach, describe, it, expect } from "vitest";
import * as d from "../../src/core/protocol/decoders";
import { jsonField } from "../../src/core/json";
import type { HttpClient, HttpRequest, HttpResult } from "../../src/core/protocol/http";
import { createSearchClient } from "../../src/features/search/client";
import {
  createCommentReader,
  createCommentStore,
} from "../../src/features/discussions/comments/controller";
import { commentSelection } from "../../src/features/discussions/comments/model";
import { factSelection } from "../../src/features/search/destinations";
import { mapEndpoint, pastedRoute } from "../../src/features/search/navigation";
import { destination } from "../../src/features/search/client";
import { hitCodec } from "../../src/features/search/codecs";
import { createTestProcessor } from "../core/processing-harness";
import {
  capture,
  decimal,
  deferred,
  decode,
  hit,
  wireHit,
  json,
  page,
  query,
  scope,
} from "./fixtures";
const processors: ReturnType<typeof createTestProcessor>[] = [];
afterEach(() => {
  for (const processor of processors.splice(0)) processor.dispose();
});
function http(answer: (request: HttpRequest<unknown>) => unknown) {
  const processing = createTestProcessor();
  processors.push(processing);
  const calls: HttpRequest<unknown>[] = [];
  const client: HttpClient = {
    processing,
    async request<T>(request: HttpRequest<T>): Promise<HttpResult<T>> {
      calls.push(request);
      const raw = await answer(request);
      const result = request.codec.decode(json(raw));
      return result.ok
        ? { ok: true, data: result.value, httpStatus: 200 }
        : {
            ok: false,
            failure: { kind: "protocol", message: result.issue.expected, issue: result.issue },
          };
    },
  };
  return { client, calls };
}
const envelope = (data: unknown) => ({
  response: {
    data,
    meta: {
      workspace_revision: "7",
      budget: { truncated: false, omitted_fields: "0", omitted_items: "0" },
    },
  },
  pagination: null,
});
const record = {
  comment_id: "comment",
  target: { kind: "project", id: "other-project" },
  author_id: "author",
  created_at: "2026-11-07",
  reply_to_comment_id: null,
  kind: "comment",
  origin: "authored",
  revision: "3",
  serial: "9",
  sequence: "1",
  actor_id: "author",
  timestamp: "2026-11-07",
  body: "Pinned original",
  tombstone: false,
};
describe("Search native read boundaries", () => {
  it("retains full endpoint before awaiting and rejects same id/generation with another socket before semantic read", async () => {
    const mocked = http(() => ({ ...scope.connection, socket: "/tmp/other.sock" })),
      client = createSearchClient(mocked.client);
    const result = await client.planning(scope, query, decimal("0"));
    expect(result.ok).toBe(false);
    expect(mocked.calls).toHaveLength(1);
  });
  it("uses exact native kinds/continuation and validates current capture", async () => {
    const mocked = http((request) =>
        request.method === "GET" ? scope.connection : envelope(page()),
      ),
      client = createSearchClient(mocked.client);
    expect((await client.planning(scope, query, decimal("0"))).ok).toBe(true);
    const body = mocked.calls[1]?.body;
    if (body === undefined) throw new Error("Missing native request");
    expect(jsonField(body, "method")).toEqual({ kind: "string", value: "search.query" });
    expect((await client.planning(scope, query, decimal("1"))).ok).toBe(false);
    expect(mocked.calls).toHaveLength(2);
  });
  it("never resolves a forged hit outside its retained result page", async () => {
    const mocked = http(() => scope.connection),
      client = createSearchClient(mocked.client);
    expect((await client.resolve(capture(), { ...hit })).ok).toBe(false);
    expect(mocked.calls).toHaveLength(0);
  });
  it("aborts after retained-profile resolution before semantic reads", async () => {
    const pending = deferred<unknown>(),
      mocked = http(() => pending.promise),
      abort = new AbortController();
    const result = createSearchClient(mocked.client).planning(
      scope,
      query,
      decimal("0"),
      undefined,
      abort.signal,
    );
    abort.abort();
    pending.resolve(scope.connection);
    expect(await result).toEqual({ ok: false, failure: { kind: "aborted" } });
    expect(mocked.calls).toHaveLength(1);
  });
  it("reads an exact non-ticket comment revision with actual target retained, not guessed", async () => {
    const mocked = http((request) =>
      request.method === "GET"
        ? scope.connection
        : envelope({ items: [record], offset: "2", remaining: "0", next_offset: null }),
    );
    const source = decode(hitCodec, {
        ...wireHit,
        source: { kind: "comment", comment_id: "comment", revision: "3" },
      }),
      route = destination(scope, source);
    if (route === null) throw new Error("Missing route");
    const selection = commentSelection(route);
    if (selection === null) throw new Error("Missing selection");
    const result = await createCommentReader({ http: mocked.client })(
      selection,
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Read failed");
    expect(result.data.comment.target).toEqual({ kind: "project", id: "other-project" });
    expect(result.data.selection.revision).toBe("3");
    expect(result.data.planningRevision).toBe("7");
    expect(result.data.comment.body).toBe("Pinned original");
    const params = jsonField(mocked.calls[1]?.body ?? json(null), "params");
    expect(jsonField(params ?? json(null), "offset")).toEqual({ kind: "string", value: "2" });
  });
  it("does not substitute current comment when exact history response changes revision", async () => {
    const mocked = http((request) =>
      request.method === "GET"
        ? scope.connection
        : envelope({
            items: [{ ...record, revision: "4" }],
            offset: "2",
            remaining: "0",
            next_offset: null,
          }),
    );
    const result = await createCommentReader({ http: mocked.client })(
      {
        connectionId: scope.connection.id,
        generation: scope.connection.generation,
        workspaceId: scope.workspaceId,
        commentId: decode(d.identifier, "comment"),
        revision: decimal("3"),
      },
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
  });
  for (const mode of ["exact", "missing", "partial"] as const)
    it(`resolves resource text using its immutable descriptor (${mode}), never current version`, async () => {
      const version = (revision: string, digest: string) => ({
        revision,
        digest,
        size_bytes: "12",
        actor_id: "author",
        timestamp: "2026-11-07",
        filename: "capture.md",
        mime_type: "text/markdown",
      });
      const source = decode(hitCodec, {
          ...wireHit,
          source: { kind: "resource_text", resource_id: "resource", revision: "1" },
        }),
        captured = { ...capture(), value: { ...capture().value, items: [source] } };
      const mocked = http((request) => {
        if (request.method === "GET") return scope.connection;
        const method = jsonField(request.body ?? json(null), "method");
        if (method?.kind !== "string") throw new Error("Missing method");
        if (method.value === "resource.get")
          return envelope({
            resource_id: "resource",
            revision: "9",
            metadata: {
              title: "Current metadata",
              description: "",
              filename: "capture.md",
              mime_type: "text/markdown",
              archived: false,
              targets: [],
            },
            current_version: version("2", "b".repeat(64)),
            version_count: "2",
          });
        if (method.value !== "resource.history") throw new Error("Unexpected semantic read");
        const params = jsonField(request.body ?? json(null), "params");
        expect(jsonField(params ?? json(null), "offset")).toEqual({ kind: "string", value: "0" });
        expect(jsonField(params ?? json(null), "at_revision")).toEqual({
          kind: "string",
          value: "7",
        });
        const output = envelope({
          items: mode === "missing" ? [] : [version("1", "a".repeat(64))],
          offset: "0",
          remaining: "0",
          next_offset: null,
        });
        if (mode === "partial")
          return {
            ...output,
            response: {
              ...output.response,
              meta: {
                workspace_revision: "7",
                budget: { truncated: true, omitted_fields: "1", omitted_items: "0" },
              },
            },
          };
        return output;
      });
      const result = await createSearchClient(mocked.client).resolve(captured, source);
      expect(result.ok).toBe(mode === "exact");
      if (result.ok)
        expect(result.data.resource).toEqual({
          generation: "2",
          content: { version: "1", expectedDigest: "a".repeat(64) },
        });
      expect(mocked.calls).toHaveLength(3);
    });
  it("keeps fact revision separate from planning atRevision and refuses retained-generation mismatch", () => {
    const route = destination(
      scope,
      decode(hitCodec, {
        ...wireHit,
        source: {
          kind: "fact",
          scope: { kind: "ticket", id: "ticket" },
          key: "state",
          revision: "9007199254740993",
        },
      }),
    );
    if (route === null) throw new Error("Missing fact route");
    const selected = factSelection(route, scope.connection);
    expect(selected?.factRevision).toBe("9007199254740993");
    expect(selected?.atRevision).toBeUndefined();
    expect(factSelection(route, { ...scope.connection, generation: decimal("3") })).toBeNull();
  });
  it("maps pasted endpoints only through an explicit typed transformation and preserves pins", () => {
    const route = destination(
      scope,
      decode(hitCodec, {
        ...wireHit,
        source: { kind: "comment", comment_id: "comment", revision: "3" },
      }),
    );
    if (route === null) throw new Error("Missing route");
    const mapped = mapEndpoint(route, {
      ...scope.connection,
      id: scope.workspaceId,
      generation: decimal("9"),
    });
    expect(mapped.connectionId).toBe("workspace");
    expect(mapped.discussion).toEqual({ kind: "comment", generation: "9", revision: "3" });
    expect(
      pastedRoute(
        "https://untrusted.invalid/#/work?connection=local&workspace=workspace&entity=ticket",
      ).ok,
    ).toBe(true);
    expect(pastedRoute("javascript:alert(1)").ok).toBe(false);
  });
  it("ignores a late comment failure after another selection owns the reader", async () => {
    const first = deferred<Awaited<ReturnType<ReturnType<typeof createCommentReader>>>>(),
      second = deferred<Awaited<ReturnType<ReturnType<typeof createCommentReader>>>>();
    let calls = 0;
    const store = createCommentStore(() => (++calls === 1 ? first.promise : second.promise)),
      selection = {
        connectionId: scope.connection.id,
        generation: scope.connection.generation,
        workspaceId: scope.workspaceId,
        commentId: scope.workspaceId,
        revision: decimal("3"),
      };
    const a = store.select(selection),
      b = store.select({ ...selection, revision: decimal("4") });
    second.resolve({ ok: false, failure: { kind: "network", message: "current" } });
    await b;
    first.reject(new Error("obsolete"));
    await a;
    expect(store.get().kind).toBe("failed");
    store.dispose();
  });
});
