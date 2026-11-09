import { describe, expect, it } from "vitest";
import * as d from "../../../src/core/protocol/decoders";
import type { HttpClient, HttpRequest, HttpResult } from "../../../src/core/protocol/http";
import { jsonField } from "../../../src/core/json";
import { createResourcesClient } from "../../../src/features/knowledge/resources/client";
import { decode, json } from "../../work/actions-fixtures";
const scope = {
  connection: decode(d.connectionProfile, {
    id: "local",
    generation: "9007199254740993",
    label: "Synthetic",
    socket: "/tmp/synthetic.sock",
  }),
  workspaceId: decode(d.identifier, "demo"),
};
function fixture(data: unknown, revision = "9007199254740994") {
  const calls: HttpRequest<unknown>[] = [],
    http: HttpClient = {
      processing: {} as HttpClient["processing"],
      request: <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
        calls.push(request);
        const decoded = request.codec.decode(
          json({ response: { data, meta: { workspace_revision: revision } }, pagination: null }),
        );
        return Promise.resolve(
          decoded.ok
            ? { ok: true, data: decoded.value, httpStatus: 200 }
            : {
                ok: false,
                failure: {
                  kind: "protocol",
                  message: decoded.issue.expected,
                  issue: decoded.issue,
                },
              },
        );
      },
    };
  return { calls, client: createResourcesClient(http) };
}
describe("Resource request captures and continuations", () => {
  it("rejects a continuation without its original capture before sending", async () => {
    const f = fixture({});
    const result = await f.client.list(scope, { offset: decode(d.decimal, "100") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("input");
    expect(f.calls).toHaveLength(0);
  });
  it("retains project filter and exact large decimal planning capture separately from endpoint generation", async () => {
    const f = fixture({ items: [], offset: "100", remaining: "0", next_offset: null });
    const result = await f.client.list(scope, {
      offset: decode(d.decimal, "100"),
      atRevision: decode(d.decimal, "9007199254740994"),
      target: { kind: "project", id: decode(d.identifier, "release") },
    });
    expect(result.ok).toBe(true);
    const body = f.calls[0]!.body!;
    expect(jsonField(body, "generation")).toEqual(d.jsonString("9007199254740993"));
    const params = jsonField(body, "params")!;
    expect(jsonField(params, "at_revision")).toEqual(d.jsonString("9007199254740994"));
    expect(jsonField(params, "target")).toEqual(
      d.jsonObject([
        ["kind", d.jsonString("project")],
        ["id", d.jsonString("release")],
      ]),
    );
  });
  it("rejects a mismatched query capture rather than accepting current data", async () => {
    const f = fixture({ items: [], offset: "100", remaining: "0", next_offset: null }, "99");
    const result = await f.client.list(scope, {
      offset: decode(d.decimal, "100"),
      atRevision: decode(d.decimal, "100"),
    });
    expect(result.ok).toBe(false);
  });
  it("does not substitute current when a historical version is absent", async () => {
    const f = fixture({ items: [], offset: "2", remaining: "0", next_offset: null }, "100");
    const result = await f.client.version(
      scope,
      decode(d.identifier, "artifact"),
      decode(d.decimal, "3"),
      decode(d.decimal, "100"),
    );
    expect(result.ok).toBe(false);
    expect(f.calls).toHaveLength(1);
    expect(jsonField(jsonField(f.calls[0]!.body!, "params")!, "offset")).toEqual(d.jsonString("2"));
  });
});
