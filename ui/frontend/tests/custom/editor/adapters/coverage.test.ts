import { afterEach, expect, it } from "vitest";
import { jsonField, parseJsonText, type JsonValue } from "../../../../src/core/json";
import * as d from "../../../../src/core/protocol/decoders";
import type { HttpClient, HttpRequest, HttpResult } from "../../../../src/core/protocol/http";
import {
  createSourceAdapter,
  decodeSourcePage,
} from "../../../../src/features/custom/editor/source";
import type { CustomPage } from "../../../../src/features/custom/editor/types";
import type { ReadInvocation } from "../../../../src/core/protocol/types";
import { initialQuery } from "../../../../src/features/custom/config";
import { createTestProcessor } from "../../../core/processing-harness";
import { view } from "../../config/fixtures";
import { target, json } from "../fixtures";
import fixtures from "./native-companion-fixtures.json";
const processors: ReturnType<typeof createTestProcessor>[] = [];
afterEach(() => {
  for (const processor of processors.splice(0)) processor.dispose();
});
function get(value: JsonValue, name: string): JsonValue {
  const found = jsonField(value, name);
  if (found === undefined) throw new Error(name);
  return found;
}
function fixture(method: string): JsonValue {
  const found = fixtures.find(
    (item) => (JSON.parse(item.request ?? "{}") as { method?: string }).method === method,
  );
  if (!found) throw new Error(method);
  const parsed = parseJsonText(found.response);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return get(parsed.value.value, "data");
}
function set(value: JsonValue, name: string, next: JsonValue) {
  if (value.kind !== "object") throw new Error("object");
  return d.jsonObject([
    ...value.fields.filter((f) => f.name !== name).map((f) => [f.name, f.value] as const),
    [name, next],
  ]);
}
function data(wire: JsonValue) {
  return get(get(wire, "response"), "data");
}
function items(wire: JsonValue) {
  const found = get(data(wire), "items");
  if (found.kind !== "array") throw new Error("items");
  return found.items;
}
function withData(wire: JsonValue, value: JsonValue) {
  return set(wire, "response", set(get(wire, "response"), "data", value));
}
function withItems(wire: JsonValue, value: readonly JsonValue[]) {
  return withData(wire, set(data(wire), "items", d.jsonArray(value)));
}
function method(body: JsonValue | undefined) {
  const found = body && jsonField(body, "method");
  if (found?.kind !== "string") throw new Error("method");
  return found.value;
}
function client(
  read: (
    name: string,
    input: HttpRequest<unknown>,
  ) => JsonValue | Promise<JsonValue> | HttpResult<never>,
): HttpClient {
  const processing = createTestProcessor();
  processors.push(processing);
  return {
    processing,
    request: async <T>(input: HttpRequest<T>): Promise<HttpResult<T>> => {
      const value = await read(method(input.body), input);
      if ("ok" in value) return value;
      const decoded = input.codec.decode(value);
      if (!decoded.ok) throw new Error(decoded.issue.expected);
      return { ok: true, data: decoded.value, httpStatus: 200 };
    },
  };
}
function invocation(source: Parameters<typeof view>[0], changes = {}) {
  const config = view(source, changes),
    query = initialQuery(config, target.workspaceId);
  const invocation: ReadInvocation = {
    connection_id: target.connection.id,
    generation: target.connection.generation,
    lane: source === "sessions" ? "history" : "visible",
    method: query.method,
    params: query.params,
  };
  return { config, invocation };
}
function page(result: HttpResult<CustomPage>) {
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result.data;
}
const signal = () => new AbortController().signal,
  project = { scope: { kind: "project", id: "release" } };
it.each(["runs", "attempts", "sessions", "activity"] as const)(
  "retains actual unreported byte coverage separately from traversal: %s",
  (source) => {
    const input = invocation(source),
      wire = d.readResponse.decode(fixture(input.invocation.method));
    if (!wire.ok) throw new Error("wire");
    const result = page(decodeSourcePage(target, input.config, input.invocation, wire.value));
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.complete).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.byteCoverage?.kind).toBe("not_reported");
  },
);
it("binds discussion native scope guarantee to original selectors", () => {
  const input = invocation("discussions", project),
    wire = d.readResponse.decode(fixture("thread.list"));
  if (!wire.ok) throw new Error("wire");
  const result = page(decodeSourcePage(target, input.config, input.invocation, wire.value));
  expect(result.rows[0]?.fields.scope).toEqual(d.jsonString("project"));
  expect(
    decodeSourcePage(
      target,
      input.config,
      {
        ...input.invocation,
        params: set(input.invocation.params, "scope", json({ kind: "workspace" })),
      },
      wire.value,
    ).ok,
  ).toBe(false);
});
it("rejects substituted endpoint, workspace, method and duplicate Activity identity", () => {
  const input = invocation("activity"),
    wire = d.readResponse.decode(fixture("activity.digest"));
  if (!wire.ok) throw new Error("wire");
  for (const change of [
    { generation: "2" },
    { method: "ticket.list" },
    { params: set(input.invocation.params, "workspace_id", d.jsonString("elsewhere")) },
  ])
    expect(
      decodeSourcePage(
        target,
        input.config,
        { ...input.invocation, ...change } as ReadInvocation,
        wire.value,
      ).ok,
    ).toBe(false);
  const entries = get(wire.value.response.data, "entries");
  if (entries.kind !== "array" || !entries.items[0]) throw new Error("entries");
  expect(
    decodeSourcePage(target, input.config, input.invocation, {
      ...wire.value,
      response: {
        ...wire.value.response,
        data: set(
          wire.value.response.data,
          "entries",
          d.jsonArray([entries.items[0], entries.items[0]]),
        ),
      },
    }).ok,
  ).toBe(false);
});
it("captures mutable input before await and rejects a successful response after abort", async () => {
  let release: (value: JsonValue) => void = () => {
    throw new Error("not waiting");
  };
  const http = client(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const owner = { connection: { ...target.connection }, workspaceId: target.workspaceId },
    config = { ...view("tickets"), title: "Original" },
    abort = new AbortController();
  const pending = createSourceAdapter(http).initial(owner, config, abort.signal);
  config.title = "Changed";
  owner.connection.label = "Changed";
  abort.abort();
  release(fixture("ticket.list"));
  expect(await pending).toEqual({ ok: false, failure: { kind: "aborted" } });
  const next = createSourceAdapter(client(() => fixture("ticket.list"))).initial(
    owner,
    config,
    signal(),
  );
  config.title = "Later";
  owner.connection.label = "Later";
  const result = page(await next);
  expect(result.view.title).toBe("Changed");
  expect(result.target.connection.label).toBe("Changed");
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.rows)).toBe(true);
  expect(Object.isFrozen(result.view)).toBe(true);
});
it("keeps unexpected errors distinct from expected row coverage", async () => {
  const failure = new Error("unexpected transport failure");
  await expect(
    createSourceAdapter(
      client(() => {
        throw failure;
      }),
    ).initial(target, view("tickets"), signal()),
  ).rejects.toBe(failure);
});
it("retains exact fact value, planning guard and original join response", async () => {
  const calls: HttpRequest<unknown>[] = [];
  const result = page(
    await createSourceAdapter(
      client((name, input) => {
        calls.push(input);
        return fixture(name);
      }),
    ).initial(target, view("facts", project), signal()),
  );
  expect(result.enrichment?.rows[0]?.status).toBe("decoded");
  expect(result.rows[0]?.decoded && jsonField(result.rows[0].decoded, "exact")).toEqual(
    d.jsonNumber("9007199254740993"),
  );
  expect(result.enrichment?.reads).toHaveLength(1);
  const params = calls[1]?.body && jsonField(calls[1].body, "params");
  expect(params && jsonField(params, "at_revision")).toEqual(d.jsonString("15"));
  expect(params && jsonField(params, "keys")).toEqual(
    d.jsonArray([d.jsonString("fixture.settings")]),
  );
});
it.each(["missing", "deleted", "budget", "wrong_revision", "failed"] as const)(
  "keeps fact %s distinct without guessed pointer values",
  async (kind) => {
    const http = client((name) => {
      if (name === "fact.keys") {
        const wire = fixture(name),
          item = items(wire)[0];
        if (kind !== "deleted" || item?.kind !== "object") return wire;
        return withItems(wire, [
          set(
            set(
              d.jsonObject(
                item.fields.filter((f) => f.name !== "value_type").map((f) => [f.name, f.value]),
              ),
              "deleted",
              d.jsonBoolean(true),
            ),
            "revision",
            d.jsonString("2"),
          ),
        ]);
      }
      let wire = fixture(name);
      const item = items(wire)[0];
      if (!item) throw new Error("item");
      if (kind === "failed") return { ok: false, failure: { kind: "network", message: "offline" } };
      if (kind === "missing")
        return withItems(wire, [
          json({
            scope: { kind: "project", id: "release" },
            key: "fixture.settings",
            missing: true,
          }),
        ]);
      if (kind === "deleted") {
        if (item.kind !== "object") throw new Error("item");
        return withItems(wire, [
          set(
            set(
              d.jsonObject(
                item.fields
                  .filter((f) => !["value", "value_type", "canonical_bytes"].includes(f.name))
                  .map((f) => [f.name, f.value]),
              ),
              "deleted",
              d.jsonBoolean(true),
            ),
            "revision",
            d.jsonString("2"),
          ),
        ]);
      }
      if (kind === "wrong_revision")
        return withItems(wire, [set(item, "revision", d.jsonString("99"))]);
      wire = set(
        wire,
        "response",
        set(
          get(wire, "response"),
          "meta",
          set(
            get(get(wire, "response"), "meta"),
            "budget",
            json({ truncated: true, omitted_fields: "1", omitted_items: "0" }),
          ),
        ),
      );
      return wire;
    });
    const result = page(
      await createSourceAdapter(http).initial(target, view("facts", project), signal()),
    );
    expect(result.rows[0]?.decoded).toBeUndefined();
    expect(result.partial).toBe(true);
    expect(result.enrichment?.rows[0]?.status).toBe(
      (
        {
          missing: "missing",
          deleted: "deleted",
          budget: "budget",
          wrong_revision: "invalid",
          failed: "unavailable",
        } as const
      )[kind],
    );
  },
);
async function resourceWire(
  bytes: Uint8Array,
  options: { mime?: string; size?: number; hash?: string } = {},
) {
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  let wire = fixture("resource.list");
  const row = items(wire)[0];
  if (!row) throw new Error("row");
  const size = String(options.size ?? bytes.length),
    hash = options.hash ?? digest;
  wire = withItems(wire, [
    set(
      row,
      "current_version",
      set(
        set(
          set(get(row, "current_version"), "size_bytes", d.jsonString(size)),
          "digest",
          d.jsonString(hash),
        ),
        "mime_type",
        d.jsonString(options.mime ?? "application/json"),
      ),
    ),
  ]);
  return {
    wire,
    range: json({
      response: {
        data: {
          resource_id: "notes",
          version: "1",
          digest: hash,
          size_bytes: size,
          offset: "0",
          chunk_digest: hash,
          data_base64: btoa(String.fromCharCode(...bytes)),
          next_offset: null,
          eof: true,
        },
        meta: {},
      },
      pagination: null,
    }),
  };
}
const pointerView = () =>
  view("resources", {
    ...project,
    columns: [
      {
        id: "pointer",
        selector: { kind: "pointer", pointer: "/exact" },
        label: "Exact",
        format: { type: "number" },
      },
    ],
  });
it("activates JSON pointers only after full pin/hash/eof/UTF-8/worker verification", async () => {
  const { wire, range } = await resourceWire(
    new TextEncoder().encode('{"exact":9007199254740993}'),
  );
  const methods: string[] = [];
  const result = page(
    await createSourceAdapter(
      client((name) => {
        methods.push(name);
        return name === "resource.list" ? wire : range;
      }),
    ).initial(target, pointerView(), signal()),
  );
  expect(methods).toEqual(["resource.list", "resource.read_chunk"]);
  expect(result.rows[0]?.decoded && jsonField(result.rows[0].decoded, "exact")).toEqual(
    d.jsonNumber("9007199254740993"),
  );
  expect(result.enrichment?.rows[0]?.status).toBe("decoded");
  expect(result.enrichment?.reads).toHaveLength(1);
  expect(result.enrichment?.rows[0]?.pin?.version).toBe("1");
  expect(result.enrichment?.limits).toEqual({ perResourceBytes: 65536, pageBytes: 1048576 });
});
it.each(["oversize", "binary", "hash", "utf8", "json", "not_eof"] as const)(
  "keeps resource %s coverage explicit and the exact fallback pin",
  async (kind) => {
    const bytes =
      kind === "utf8"
        ? new Uint8Array([255])
        : new TextEncoder().encode(kind === "json" ? "{bad" : '{"exact":1}');
    const { wire, range } = await resourceWire(
      bytes,
      kind === "oversize"
        ? { size: 65537 }
        : kind === "binary"
          ? { mime: "application/octet-stream" }
          : kind === "hash"
            ? { hash: "a".repeat(64) }
            : {},
    );
    let reads = 0;
    const result = page(
      await createSourceAdapter(
        client((name) => {
          if (name === "resource.list") return wire;
          reads++;
          return kind === "not_eof"
            ? withData(
                range,
                set(
                  set(data(range), "eof", d.jsonBoolean(false)),
                  "next_offset",
                  d.jsonString("1"),
                ),
              )
            : range;
        }),
      ).initial(target, pointerView(), signal()),
    );
    expect(result.rows[0]?.decoded).toBeUndefined();
    expect(result.enrichment?.rows[0]?.pin).not.toBeNull();
    expect(result.enrichment?.rows[0]?.status).toBe(
      kind === "oversize" ? "budget" : kind === "binary" ? "unsupported" : "invalid",
    );
    expect(reads).toBe(kind === "oversize" || kind === "binary" ? 0 : 1);
  },
);
it("makes no content request without a pointer column", async () => {
  const calls: string[] = [];
  const result = page(
    await createSourceAdapter(
      client((name) => {
        calls.push(name);
        return fixture(name);
      }),
    ).initial(target, view("resources", project), signal()),
  );
  expect(calls).toEqual(["resource.list"]);
  expect(result.enrichment).toBeUndefined();
});
it("rejects resource pointer predicates before querying; valid fact pointer filters still obtain whole values", async () => {
  expect(() =>
    view("resources", {
      ...project,
      filter_mode: "loaded",
      filters: [{ pointer: "/index", op: "equals", value: 1 }],
    }),
  ).toThrow();
  const names: string[] = [];
  const result = page(
    await createSourceAdapter(
      client((name) => {
        names.push(name);
        return fixture(name);
      }),
    ).initial(
      target,
      view("facts", {
        ...project,
        filter_mode: "loaded",
        filters: [{ pointer: "/nullable", op: "equals", value: null }],
      }),
      signal(),
    ),
  );
  expect(names).toEqual(["fact.keys", "fact.multi_get"]);
  expect(result.rows[0]?.decoded && jsonField(result.rows[0].decoded, "nullable")).toEqual(
    d.jsonNull(),
  );
});
it("bounds resource pointer acquisition by the aggregate page budget", async () => {
  const bytes = new TextEncoder().encode('{"pad":"' + "a".repeat(65526) + '"}');
  expect(bytes.length).toBe(65536);
  const { wire, range } = await resourceWire(bytes),
    record = items(wire)[0];
  if (!record) throw new Error("record");
  const records = Array.from({ length: 17 }, (_, index) =>
    set(record, "resource_id", d.jsonString(`row-${index}`)),
  );
  let readCount = 0;
  const result = page(
    await createSourceAdapter(
      client((name, input) => {
        if (name === "resource.list") return withItems(wire, records);
        readCount++;
        const params = input.body && jsonField(input.body, "params"),
          id = params && jsonField(params, "resource_id");
        if (id === undefined) throw new Error("id");
        return withData(range, set(data(range), "resource_id", id));
      }),
    ).initial(target, pointerView(), signal()),
  );
  expect(readCount).toBe(16);
  expect(result.enrichment?.rows.filter((row) => row.status === "decoded")).toHaveLength(16);
  expect(result.enrichment?.rows[16]?.status).toBe("budget");
  expect(result.rows[16]?.decoded).toBeUndefined();
});
it("rejects guards from the wrong namespace without treating them as source selectors", () => {
  const input = invocation("tickets"),
    wire = d.readResponse.decode(fixture("ticket.list"));
  if (!wire.ok) throw new Error("wire");
  expect(
    decodeSourcePage(
      target,
      input.config,
      {
        ...input.invocation,
        params: set(input.invocation.params, "expected_revision", d.jsonString("15")),
      },
      wire.value,
    ).ok,
  ).toBe(false);
});
it("does not send a continuation with a substituted original capture guard", async () => {
  let calls = 0;
  const api = createSourceAdapter(
    client(() => {
      calls++;
      return fixture("ticket.list");
    }),
  );
  const first = page(await api.initial(target, view("tickets"), signal()));
  const selected = {
    ...first.invocation,
    params: set(
      set(first.invocation.params, "at_revision", d.jsonString("99")),
      "offset",
      d.jsonString("3"),
    ),
  };
  const result = await api.next({ ...first, next: selected }, "next", signal());
  expect(result.ok).toBe(false);
  expect(calls).toBe(1);
});
it("a late successful fact join cannot publish after abort", async () => {
  let release: (value: JsonValue) => void = () => {
      throw new Error("not joining");
    },
    started: () => void = () => {
      throw new Error("not started");
    };
  const joined = new Promise<void>((resolve) => {
      started = resolve;
    }),
    abort = new AbortController();
  const api = createSourceAdapter(
    client((name) =>
      name === "fact.keys"
        ? fixture(name)
        : new Promise((resolve) => {
            release = resolve;
            started();
          }),
    ),
  );
  const pending = api.initial(target, view("facts", project), abort.signal);
  await joined;
  abort.abort();
  release(fixture("fact.multi_get"));
  expect(await pending).toEqual({ ok: false, failure: { kind: "aborted" } });
});
it("a worker JSON result completed after cancellation cannot activate resource pointers", async () => {
  const { wire, range } = await resourceWire(new TextEncoder().encode('{"index":1}'));
  const base = client((name) => (name === "resource.list" ? wire : range)),
    abort = new AbortController();
  let release: () => void = () => {
      throw new Error("not processing");
    },
    started: () => void = () => {
      throw new Error("not started");
    };
  const waiting = new Promise<void>((resolve) => {
      started = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const http: HttpClient = {
    ...base,
    processing: {
      ...base.processing,
      parse: async (source, options) => {
        const result = await base.processing.parse(source, options);
        started();
        await gate;
        return result;
      },
    },
  };
  const pending = createSourceAdapter(http).initial(target, pointerView(), abort.signal);
  await waiting;
  abort.abort();
  release();
  expect(await pending).toEqual({ ok: false, failure: { kind: "aborted" } });
});
it("worker capacity failure retains metadata and exact pin as unavailable coverage", async () => {
  const { wire, range } = await resourceWire(new TextEncoder().encode('{"index":1}')),
    base = client((name) => (name === "resource.list" ? wire : range));
  const http: HttpClient = {
    ...base,
    processing: {
      ...base.processing,
      parse: () =>
        Promise.resolve({ ok: false, failure: { kind: "busy", message: "bounded queue" } }),
    },
  };
  const result = page(await createSourceAdapter(http).initial(target, pointerView(), signal()));
  expect(result.rows[0]?.decoded).toBeUndefined();
  expect(result.enrichment?.rows[0]?.status).toBe("unavailable");
  expect(result.enrichment?.rows[0]?.pin?.resource_id).toBe("notes");
});
it("captures the maximum valid small literal filter aggregate without sharing caller scalars", async () => {
  const config = view("tickets", {
    filter_mode: "loaded",
    filters: Array.from({ length: 8 }, () => ({
      field: "title",
      op: "one_of",
      values: Array.from({ length: 32 }, (_, index) => String(index)),
    })),
  });
  const result = page(
    await createSourceAdapter(client(() => fixture("ticket.list"))).initial(
      target,
      config,
      signal(),
    ),
  );
  expect(result.view.filters).toHaveLength(8);
  expect(result.view.filters[0]?.op).toBe("one_of");
});
