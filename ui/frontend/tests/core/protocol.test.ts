import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonField, parseJsonText, type JsonValue } from "../../src/core/json";
import * as c from "../../src/core/protocol/codec";
import * as d from "../../src/core/protocol/decoders";
import { createHttpClient as httpClient, type HttpOptions } from "../../src/core/protocol/http";

import { createTestProcessor } from "./processing-harness";
const processors: ReturnType<typeof createTestProcessor>[] = [];
afterEach(() => {
  for (const p of processors.splice(0)) p.dispose();
});
function createHttpClient(options: HttpOptions) {
  const processing = createTestProcessor();
  processors.push(processing);
  return httpClient({ ...options, processing });
}
function value(source: string): JsonValue {
  const parsed = parseJsonText(source);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value.value;
}
const capability = "a".repeat(64);
const origin = "http://127.0.0.1:8787";
const jsonResponse = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(new TextEncoder().encode(body).byteLength),
    },
  });
const profile = '{"id":"local","generation":"1","label":"Local","socket":"/tmp/daemon.sock"}';
const operationFixture = (state: string): string =>
  `{"format":"workgraph-ui-operation-1","operation_id":"op-1","preparation":{"intention_id":"intent-1","context":{"workspace_id":null,"project_id":null,"writer":{"actor_id":"rowan","run_id":null}},"connection":${profile},"method":"ticket.create","params":{"actor_id":"rowan"}},"preparation_input_hash":"${"b".repeat(64)}","connection":${profile},"request":{"jsonrpc":"2.0","workgraph_api":"0.7","id":"1","method":"ticket.create","params":{"actor_id":"rowan","mutation_id":"m-1"}},"journal_path":"/tmp/journal/op-1.json","revision":"1","state":${state},"diagnostic":null,"receipt_lookup_supported":true}`;

describe("companion DTOs", () => {
  it("validates the actual saved request envelope and immutable params", () => {
    const valid = operationFixture('{"kind":"prepared_unsent"}');
    for (const invalid of [
      valid.replace('"workgraph_api":"0.7",', ""),
      valid.replace('"workgraph_api":"0.7"', '"workgraph_api":"0.6"'),
      valid.replace('"id":"1"', '"id":""'),
      valid.replace('"id":"1"', '"id":2'),
      valid.replace('"id":"1"', '"id":"1","unknown":true'),
      valid.replace('"actor_id":"rowan","mutation_id"', '"actor_id":"other","mutation_id"'),
      valid.replace('"mutation_id":"m-1"', '"mutation_id":null'),
      valid.replace('"mutation_id":"m-1"', '"mutation_id":"m-1","extra":true'),
    ])
      expect(d.operation.decode(value(invalid)).ok).toBe(false);
  });
  it("keeps counters exact and rejects noncanonical or out-of-range strings", () => {
    expect(d.decimal.decode(value('"4611686018427387903"'))).toEqual({
      ok: true,
      value: "4611686018427387903",
    });
    for (const source of ['"01"', "1", '"1e3"', '"4611686018427387904"', '"1\\n"'])
      expect(d.decimal.decode(value(source)).ok).toBe(false);
    expect(d.positiveDecimal.decode(value('"0"')).ok).toBe(false);
  });
  it("validates closed DTOs while retaining arbitrary payload fields and numbers", () => {
    expect(d.connectionProfile.decode(value(profile)).ok).toBe(true);
    expect(d.connectionProfile.decode(value(profile.replace('"id":', '"extra":1,"id":'))).ok).toBe(
      false,
    );
    const result = d.readResponse.decode(
      value('{"response":{"data":{"n":9007199254740993},"meta":{"head":null}},"pagination":null}'),
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(jsonField(result.value.response.data, "n")).toEqual({
        kind: "number",
        lexeme: "9007199254740993",
      });
  });
  it("distinguishes committed, observed, uncertain and rejected operation states", () => {
    for (const kind of ["prepared_unsent", "sending"])
      expect(d.operation.decode(value(operationFixture(`{"kind":"${kind}"}`))).ok).toBe(true);
    for (const kind of ["committed", "observed"])
      expect(
        d.operation.decode(
          value(operationFixture(`{"kind":"${kind}","response":{"data":{},"meta":{}}}`)),
        ).ok,
      ).toBe(true);
    expect(
      d.operation.decode(
        value(
          operationFixture(
            '{"kind":"outcome_unknown","problem":{"kind":"Outcome_unknown","message":"lost reply"}}',
          ),
        ),
      ).ok,
    ).toBe(true);
    expect(
      d.operation.decode(
        value(
          operationFixture(
            '{"kind":"rejected","problem":{"kind":"Outcome_unknown","message":"lost reply"}}',
          ),
        ),
      ).ok,
    ).toBe(false);
    expect(d.operation.decode(value(operationFixture('{"kind":"committed"}'))).ok).toBe(false);
    expect(d.operation.decode(value(operationFixture('{"kind":"__proto__"}'))).ok).toBe(false);
  });
  it("rejects inconsistent captured endpoint or original method", () => {
    const fixture = operationFixture('{"kind":"prepared_unsent"}');
    expect(
      d.operation.decode(
        value(
          fixture.replace(
            '"request":{"jsonrpc":"2.0","workgraph_api":"0.7","id":"1","method":"ticket.create"',
            '"request":{"jsonrpc":"2.0","workgraph_api":"0.7","id":"1","method":"ticket.finish"',
          ),
        ),
      ).ok,
    ).toBe(false);
    expect(
      d.operation.decode(value(fixture.replace('"generation":"1"', '"generation":"2"'))).ok,
    ).toBe(false);
  });
});

describe("bounded same-origin HTTP", () => {
  it.each([
    {},
    { "Content-Length": "-1" },
    { "Content-Length": "1.0" },
    { "Content-Length": "01" },
    { "Content-Length": "2, 2" },
    { "Content-Length": "999999999999999999999999999999999999999" },
    { "Content-Length": String(4 * 1024 * 1024 + 1) },
    { "Content-Length": "2", "Transfer-Encoding": "chunked" },
    { "Content-Length": "2", "Transfer-Encoding": "" },
    { "Content-Length": "2", "Content-Encoding": "gzip" },
    { "Content-Length": "2", "Content-Encoding": "identity" },
  ])("rejects invalid native response framing before consuming: %j", async (headers) => {
    const response = new Response("{}", {
      headers: { "Content-Type": "application/json", ...headers },
    });
    const consume = vi.spyOn(response, "arrayBuffer");
    const client = createHttpClient({ origin, capability, fetch: () => Promise.resolve(response) });
    const result = await client.request({ path: "/catalog", method: "GET", codec: c.raw });
    expect(!result.ok && result.failure.kind).toBe("protocol");
    expect(consume).not.toHaveBeenCalled();
    expect(response.body?.locked).toBe(false);
  });
  it.each(["{", "{} "])("rejects a truncated or overflowing declared body: %j", async (body) => {
    const response = new Response(body, {
      headers: { "Content-Type": "application/json", "Content-Length": "2" },
    });
    const client = createHttpClient({ origin, capability, fetch: () => Promise.resolve(response) });
    const result = await client.request({ path: "/catalog", method: "GET", codec: c.raw });
    expect(!result.ok && result.failure.kind).toBe("protocol");
  });
  it("uses byte lengths for Unicode and preserves a native body transport failure", async () => {
    const unicode = createHttpClient({
      origin,
      capability,
      fetch: () => Promise.resolve(jsonResponse('{"ok":true,"data":"雪"}')),
    });
    expect((await unicode.request({ path: "/catalog", method: "GET", codec: c.raw })).ok).toBe(
      true,
    );
    const response = jsonResponse("{}");
    vi.spyOn(response, "arrayBuffer").mockRejectedValue(new TypeError("truncated HTTP body"));
    let calls = 0;
    const interrupted = createHttpClient({
      origin,
      capability,
      fetch: () => {
        calls += 1;
        return Promise.resolve(response);
      },
    });
    const result = await interrupted.request({
      path: "/operations/op-1/execute",
      method: "POST",
      body: value("{}"),
      codec: d.operation,
    });
    expect(!result.ok && result.failure.kind).toBe("network");
    expect(calls).toBe(1);
  });
  it("uses the larger operation budget explicitly and permits bounded response wrappers", async () => {
    const source = `{"ok":true,"data":"${"x".repeat(4 * 1024 * 1024)}"}`;
    const client = createHttpClient({
      origin,
      capability,
      fetch: () => Promise.resolve(jsonResponse(source)),
    });
    expect((await client.request({ path: "/catalog", method: "GET", codec: c.raw })).ok).toBe(
      false,
    );
    expect(
      (
        await client.request({
          path: "/operations/op-1",
          method: "GET",
          codec: c.raw,
          responseBudget: "operation",
        })
      ).ok,
    ).toBe(true);
    const deep = createHttpClient({
      origin,
      capability,
      fetch: () =>
        Promise.resolve(jsonResponse(`{"ok":true,"data":${"[".repeat(70)}0${"]".repeat(70)}}`)),
    });
    expect(
      (
        await deep.request({
          path: "/operations/op-1",
          method: "GET",
          codec: c.raw,
          responseBudget: "operation",
        })
      ).ok,
    ).toBe(true);
    const excessive = createHttpClient({
      origin,
      capability,
      fetch: () =>
        Promise.resolve(
          new Response("{}", {
            headers: {
              "Content-Type": "application/json",
              "Content-Length": String(16 * 1024 * 1024 + 1),
            },
          }),
        ),
    });
    expect(
      (
        await excessive.request({
          path: "/operations/op-1",
          method: "GET",
          codec: c.raw,
          responseBudget: "operation",
        })
      ).ok,
    ).toBe(false);
  });
  it("reports cancellation during body streaming as an aborted read", async () => {
    const abort = new AbortController();
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const client = createHttpClient({
      origin,
      capability,
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"ok":'));
                abort.signal.addEventListener(
                  "abort",
                  () => {
                    controller.error(new DOMException("Canceled", "AbortError"));
                  },
                  { once: true },
                );
                started();
              },
            }),
            { headers: { "Content-Type": "application/json", "Content-Length": "20" } },
          ),
        ),
    });
    const pending = client.request({
      path: "/catalog",
      method: "GET",
      codec: c.raw,
      signal: abort.signal,
    });
    await reading;
    abort.abort();
    expect(await pending).toEqual({ ok: false, failure: { kind: "aborted" } });
  });
  it("sends the capability only as a header, disables redirects and preserves raw numbers", async () => {
    let calls = 0;
    const client = createHttpClient({
      origin,
      capability,
      fetch: (input, init) => {
        calls += 1;
        expect(input instanceof URL ? input.href : input).toBe(origin + "/ui-api/v1/read");
        expect(new Headers(init?.headers).get("X-Workgraph-UI-Capability")).toBe(capability);
        expect(init?.redirect).toBe("error");
        expect(init?.body).toBe('{"number":9007199254740993}');
        return Promise.resolve(jsonResponse('{"ok":true,"data":{"n":1e1000}}'));
      },
    });
    const result = await client.request({
      path: "/read",
      method: "POST",
      body: value('{"number":9007199254740993}'),
      codec: c.object,
    });
    expect(result.ok && jsonField(result.data, "n")).toEqual({ kind: "number", lexeme: "1e1000" });
    expect(calls).toBe(1);
  });
  it("retries a reset read once immediately, with identical bytes, but not domain failures", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(jsonResponse('{"ok":true,"data":{}}'));
    const client = createHttpClient({ origin, capability, fetch: send });
    expect(
      (
        await client.request({
          path: "/read",
          method: "POST",
          body: value('{"n":9007199254740993}'),
          codec: c.raw,
        })
      ).ok,
    ).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![1]?.body).toBe(send.mock.calls[1]![1]?.body);
    const failed = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("reset"));
    const lost = createHttpClient({ origin, capability, fetch: failed });
    expect(await lost.request({ path: "/connections", method: "GET", codec: c.raw })).toMatchObject(
      { ok: false, failure: { kind: "network" } },
    );
    expect(failed).toHaveBeenCalledTimes(2);
    const domain = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        jsonResponse('{"ok":false,"error":{"kind":"Blocked","message":"busy"}}', 409),
      ),
    );
    expect(
      (
        await createHttpClient({ origin, capability, fetch: domain }).request({
          path: "/read",
          method: "POST",
          body: value("{}"),
          codec: c.raw,
        })
      ).ok,
    ).toBe(false);
    expect(domain).toHaveBeenCalledTimes(1);
  });
  it("retries a read when the connection fails during body transfer", async () => {
    const interrupted = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":'));
          controller.error(new TypeError("connection reset during response"));
        },
      }),
      { headers: { "content-type": "application/json", "content-length": "21" } },
    );
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(interrupted)
      .mockResolvedValueOnce(jsonResponse('{"ok":true,"data":{}}'));
    const client = createHttpClient({ origin, capability, fetch: send });
    expect((await client.request({ path: "/connections", method: "GET", codec: c.raw })).ok).toBe(
      true,
    );
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("bounds a silently stalled saved-connection read without retrying a timeout immediately", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn<typeof fetch>(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          }),
      );
      const client = createHttpClient({ origin, capability, fetch: send });
      const pending = client.request({ path: "/connections", method: "GET", codec: c.raw });
      await vi.advanceTimersByTimeAsync(10000);
      expect(await pending).toMatchObject({
        ok: false,
        failure: { kind: "network", message: "Companion read timed out." },
      });
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not retry or call network loss a rejected mutation", async () => {
    let calls = 0;
    const client = createHttpClient({
      origin,
      capability,
      fetch: () => {
        calls += 1;
        return Promise.reject(new TypeError("network interrupted"));
      },
    });
    const result = await client.request({
      path: "/operations/op-1/execute",
      method: "POST",
      body: value("{}"),
      codec: d.operation,
    });
    expect(!result.ok && result.failure.kind).toBe("network");
    expect(calls).toBe(1);
  });
  it("retains a valid typed remote problem and rejects contradictory envelopes", async () => {
    const client = createHttpClient({
      origin,
      capability,
      fetch: () =>
        Promise.resolve(
          jsonResponse(
            '{"ok":false,"error":{"kind":"Outcome_unknown","message":"receipt unavailable","details":{"head":null}}}',
            503,
          ),
        ),
    });
    const result = await client.request({
      path: "/read",
      method: "POST",
      body: value("{}"),
      codec: c.raw,
    });
    expect(!result.ok && result.failure.kind === "remote" && result.failure.problem.kind).toBe(
      "Outcome_unknown",
    );
    const invalid = createHttpClient({
      origin,
      capability,
      fetch: () => Promise.resolve(jsonResponse('{"ok":true,"data":{},"error":{}}')),
    });
    expect((await invalid.request({ path: "/catalog", method: "GET", codec: c.raw })).ok).toBe(
      false,
    );
  });
  it("rejects duplicate keys, HTML and oversized declared bodies", async () => {
    for (const response of [
      jsonResponse('{"ok":true,"ok":true,"data":{}}'),
      new Response("<html>wrong endpoint</html>", { headers: { "content-type": "text/html" } }),
      jsonResponse(" ".repeat(4 * 1024 * 1024 + 1)),
    ]) {
      const client = createHttpClient({
        origin,
        capability,
        fetch: () => Promise.resolve(response),
      });
      const result = await client.request({ path: "/catalog", method: "GET", codec: c.raw });
      expect(!result.ok && result.failure.kind).toBe("protocol");
    }
  });
  it("rejects escaping routes before fetch and honors already aborted reads", async () => {
    let calls = 0;
    const client = createHttpClient({
      origin,
      capability,
      fetch: () => {
        calls += 1;
        return Promise.resolve(jsonResponse("{}"));
      },
    });
    for (const path of ["//example.com", "/../../../outside", "/catalog#fragment"])
      expect((await client.request({ path, method: "GET", codec: c.raw })).ok).toBe(false);
    const controller = new AbortController();
    controller.abort();
    const aborted = await client.request({
      path: "/catalog",
      method: "GET",
      codec: c.raw,
      signal: controller.signal,
    });
    expect(!aborted.ok && aborted.failure.kind).toBe("aborted");
    expect(calls).toBe(0);
  });
  it("preserves unexpected decoder exceptions rather than relabeling them network errors", async () => {
    const client = createHttpClient({
      origin,
      capability,
      fetch: () => Promise.resolve(jsonResponse('{"ok":true,"data":{}}')),
    });
    const bug = new TypeError("decoder implementation bug");
    await expect(
      client.request({
        path: "/catalog",
        method: "GET",
        codec: {
          decode: () => {
            throw bug;
          },
        },
      }),
    ).rejects.toBe(bug);
  });
});
