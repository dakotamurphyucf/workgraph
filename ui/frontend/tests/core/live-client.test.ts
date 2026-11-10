import { afterEach, expect, it, vi } from "vitest";
import { createLiveChangeReader } from "../../src/core/state/live-client";
import { createHttpClient } from "../../src/core/protocol/http";
import * as d from "../../src/core/protocol/decoders";
import { createTestProcessor } from "./processing-harness";
import type { LiveScope } from "../../src/core/state/live-types";
const processors: ReturnType<typeof createTestProcessor>[] = [];
afterEach(() => {
  for (const processor of processors.splice(0)) processor.dispose();
});
function id(value: string) {
  const result = d.identifier.decode(d.jsonString(value));
  if (!result.ok) throw new Error("Invalid fixture ID");
  return result.value;
}
function decimal(value: string) {
  const result = d.decimal.decode(d.jsonString(value));
  if (!result.ok) throw new Error("Invalid fixture decimal");
  return result.value;
}
const scope: LiveScope = {
  connection: { id: id("local"), generation: decimal("1"), label: "Local", socket: "/tmp/local" },
  workspaceId: id("workspace"),
  projectId: null,
};
const page = (source: string) => ({
  source,
  through: "5",
  cursor: `${source}-cursor`,
  items: [],
  has_more: false,
  needs_larger_budget: false,
});
const response = () => ({
  workspace_id: "workspace",
  planning: page("planning"),
  history: page("history"),
  runtime_signature: null,
  runtime_changed: false,
});
function fixture(data: unknown) {
  const processing = createTestProcessor();
  processors.push(processing);
  const fetch = vi.fn<typeof globalThis.fetch>(() => {
    const body = JSON.stringify({ ok: true, data });
    return Promise.resolve(
      new Response(body, {
        headers: {
          "content-length": String(new TextEncoder().encode(body).length),
          "content-type": "application/json",
        },
      }),
    );
  });
  const http = createHttpClient({
    origin: "http://127.0.0.1:8787",
    capability: "a".repeat(64),
    processing,
    fetch,
  });
  return { fetch, reader: createLiveChangeReader(http) };
}
it("observes both feeds in one authenticated request with exact cursor positions", async () => {
  const { fetch, reader } = fixture(response());
  const result = await reader.read(
    scope,
    ["planning", "history"],
    { planning: "p0", history: "h0", runtime: null },
    true,
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    ok: true,
    data: { cursor: { planning: "planning-cursor", history: "history-cursor" }, changed: false },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0] ?? [];
  if (!(url instanceof URL) || typeof init?.body !== "string")
    throw new Error("Invalid HTTP request");
  expect(url.href).toBe("http://127.0.0.1:8787/ui-api/v1/live-observations");
  expect(JSON.parse(init.body)).toMatchObject({
    connection_id: "local",
    generation: "1",
    observation: {
      workspace_id: "workspace",
      planning_cursor: "p0",
      history_cursor: "h0",
      wait: true,
    },
  });
});
it.each([
  { ...response(), workspace_id: "other" },
  { ...response(), planning: page("history") },
  { ...response(), history: null },
  { ...response(), runtime_signature: "b".repeat(64) },
  { ...response(), runtime_changed: true },
])("rejects mismatched workspace, sources and runtime observations", async (data) => {
  const { reader } = fixture(data);
  const result = await reader.read(
    scope,
    ["planning", "history"],
    null,
    false,
    new AbortController().signal,
  );
  expect(result).toMatchObject({ ok: false, failure: { kind: "protocol" } });
});
it("abandons a silently stalled observation after 45 seconds for cursor-preserving retry", async () => {
  vi.useFakeTimers();
  try {
    const processing = createTestProcessor();
    processors.push(processing);
    const fetch: typeof globalThis.fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    const http = createHttpClient({
      origin: "http://127.0.0.1:8787",
      capability: "a".repeat(64),
      processing,
      fetch,
    });
    const result = createLiveChangeReader(http).read(
      scope,
      ["planning"],
      null,
      false,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(45000);
    expect(await result).toMatchObject({ ok: false, failure: { kind: "network" } });
  } finally {
    vi.useRealTimers();
  }
});

it("cancels on the server and consumes the normal response without aborting its HTTP request", async () => {
  const processing = createTestProcessor();
  processors.push(processing);
  let reply!: (value: Response) => void;
  let transportSignal: AbortSignal | null | undefined;
  let original: { observation?: { observation_id?: string } } | undefined;
  const makeResponse = () => {
    const body = JSON.stringify({ ok: true, data: { cancelled: true } });
    return new Response(body, {
      headers: { "content-type": "application/json", "content-length": String(body.length) },
    });
  };
  const send = vi.fn<typeof fetch>((url, init) => {
    if (!(url instanceof URL) || typeof init?.body !== "string")
      throw new Error("Expected URL and exact request body");
    if (url.pathname.endsWith("/cancel")) {
      const body = JSON.parse(init.body) as { cancellation: { observation_id: string } };
      expect(body.cancellation.observation_id).toBe(original?.observation?.observation_id);
      reply(makeResponse());
      return Promise.resolve(makeResponse());
    }
    transportSignal = init?.signal;
    original = JSON.parse(init.body) as typeof original;
    return new Promise<Response>((resolve) => {
      reply = resolve;
    });
  });
  const reader = createLiveChangeReader(
    createHttpClient({
      origin: "http://127.0.0.1:8787",
      capability: "a".repeat(64),
      processing,
      fetch: send,
    }),
  );
  const logical = new AbortController();
  const pending = reader.read(scope, ["planning"], null, false, logical.signal);
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  logical.abort();
  expect(await pending).toMatchObject({ ok: false, failure: { kind: "aborted" } });
  expect(send).toHaveBeenCalledTimes(2);
  expect(transportSignal?.aborted).toBe(false);
});
