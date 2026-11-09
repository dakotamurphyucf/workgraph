import { describe, expect, it } from "vitest";
import { jsonField } from "../../../src/core/json";
import * as d from "../../../src/core/protocol/decoders";
import {
  createCoordinationClient,
  decodePage,
  invocation,
} from "../../../src/features/participants/coordination/client";
import { poolCodec } from "../../../src/features/participants/coordination/codecs";
import type { HttpClient, HttpRequest, HttpResult } from "../../../src/core/protocol/http";
import { createTestProcessor } from "../../core/processing-harness";
import { response, target } from "../runs/fixtures";

const pool = { name: "compiler", revision: "4", limit: "2" };
describe("coordination captured page traversal", () => {
  it("continues exact selectors at the original namespace revision, ignoring executable pagination objects", () => {
    const request = invocation(target, "allocation.pools", [["limit", d.jsonString("100")]]),
      read = {
        ...response(
          { items: [pool], next_offset: "1", omitted: "1" },
          { query_scope: "runs", query_revision: "9" },
        ),
        pagination: d.jsonObject([["method", d.jsonString("daemon.shutdown")]]),
      };
    const result = decodePage(target, request, read);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("fixture");
    expect(result.data.continuation?.method).toBe("allocation.pools");
    expect(result.data.continuation?.connection_id).toBe(target.connection.id);
    expect(jsonField(result.data.continuation!.params, "expected_revision")).toEqual({
      kind: "string",
      value: "9",
    });
  });
  it("rejects no-progress/mismatched capture while retaining advancing partial traversal", () => {
    const request = invocation(target, "reservation.list", [
      ["offset", d.jsonString("2")],
      ["expected_revision", d.jsonString("9")],
    ]);
    for (const data of [
      { items: [], next_offset: "2", omitted: "1" },
      { items: [{}], next_offset: "4", omitted: "1" },
      { items: [], next_offset: null, omitted: "1" },
    ])
      expect(
        decodePage(target, request, response(data, { query_scope: "runs", query_revision: "9" }))
          .ok,
      ).toBe(false);
    expect(
      decodePage(
        target,
        request,
        response(
          { items: [{}], next_offset: "3", omitted: "1" },
          { query_scope: "runs", query_revision: "10" },
        ),
      ).ok,
    ).toBe(false);
    const partial = decodePage(
      target,
      request,
      response(
        { items: [{}], next_offset: "3", omitted: "1" },
        {
          query_scope: "runs",
          query_revision: "9",
          budget: {
            omitted_items: "0",
            omitted_fields: "1",
            truncated: true,
            details_complete: false,
          },
        },
      ),
    );
    expect(partial.ok).toBe(true);
    if (!partial.ok) throw new Error("fixture");
    expect(partial.data.completeness).toBe("partial");
    expect(partial.data.continuation).not.toBeNull();
  });
  it("never derives absence from a partial guard catalog and preserves revision-bound traversal", async () => {
    const processing = createTestProcessor();
    const selectors: string[] = [];
    let partial = true;
    const http: HttpClient = {
      processing,
      request: <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
        const params = request.body === undefined ? undefined : jsonField(request.body, "params"),
          offset = params === undefined ? undefined : jsonField(params, "offset");
        selectors.push(offset?.kind === "string" ? offset.value : "0");
        const v = response(
          {
            items: offset === undefined ? [pool] : [],
            next_offset: offset === undefined ? "1" : null,
            omitted: offset === undefined ? "1" : "0",
          },
          {
            query_scope: "runs",
            query_revision: "9",
            ...(partial
              ? {
                  budget: {
                    omitted_items: "0",
                    omitted_fields: "1",
                    truncated: true,
                    details_complete: false,
                  },
                }
              : {}),
          },
        );
        const data = request.codec.decode(
          d.jsonObject([
            [
              "response",
              d.jsonObject([
                ["data", v.response.data],
                ["meta", v.response.meta],
              ]),
            ],
            ["pagination", d.jsonNull()],
          ]),
        );
        if (!data.ok) throw new Error(data.issue.expected);
        return Promise.resolve({ ok: true, httpStatus: 200, data: data.value });
      },
    };
    try {
      const api = createCoordinationClient(http),
        first = await api.lookup(
          target,
          "allocation.pools",
          poolCodec,
          () => false,
          new AbortController().signal,
        );
      expect(first.ok).toBe(false);
      expect(selectors).toEqual(["0"]);
      partial = false;
      selectors.length = 0;
      const second = await api.lookup(
        target,
        "allocation.pools",
        poolCodec,
        () => false,
        new AbortController().signal,
      );
      expect(second.ok).toBe(true);
      expect(selectors).toEqual(["0", "1"]);
      if (second.ok) expect(second.data.value).toBeNull();
    } finally {
      processing.dispose();
    }
  });
  it("forbids a selector from replacing the captured workspace", () => {
    expect(() =>
      invocation(target, "reservation.get", [["workspace_id", d.jsonString("other")]]),
    ).toThrow(/overridden/);
    expect(
      decodePage(
        target,
        invocation(target, "allocation.pools"),
        response(
          { items: [], next_offset: null, omitted: "0" },
          { query_scope: "policy", query_revision: "9" },
        ),
      ).ok,
    ).toBe(false);
  });
});
