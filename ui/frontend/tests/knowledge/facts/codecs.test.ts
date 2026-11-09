import { describe, expect, it } from "vitest";
import { canonicalJson, jsonField } from "../../../src/core/json";
import * as d from "../../../src/core/protocol/decoders";
import {
  factKeyCodec,
  factObservationCodec,
  factPageCodec,
  factVersionCodec,
  keyCodec,
  scopeCodec,
} from "../../../src/features/knowledge/facts/codecs";
import { decodeCapture, createFactsClient } from "../../../src/features/knowledge/facts/client";
import type { HttpClient, HttpRequest, HttpResult } from "../../../src/core/protocol/http";
import type { ReadResponse } from "../../../src/core/protocol/types";
import { createTestProcessor } from "../../core/processing-harness";
import { decode, json, page, record, response, source, target } from "./fixtures";

describe("Fact exact native projections", () => {
  it("separates present null, missing and attributed tombstone", () => {
    const value = decode(factVersionCodec, record);
    expect(value.kind).toBe("value");
    if (value.kind !== "value") throw new Error("value");
    expect(value.value.kind).toBe("null");
    expect(
      decode(factObservationCodec, { scope: record.scope, key: "missing", missing: true }).kind,
    ).toBe("missing");
    const base = Object.fromEntries(
      Object.entries(record).filter(([name]) => name !== "value" && name !== "value_type"),
    );
    expect(decode(factVersionCodec, { ...base, revision: "2", deleted: true }).kind).toBe(
      "deleted",
    );
    for (const patch of [
      { deleted: true },
      { deleted: true, revision: "2" },
      { value_type: "object" },
      { value: undefined },
      { run_id: null },
      { revision: "0" },
      { changed_at_revision: "0" },
      { timestamp: "" },
    ])
      expect(factVersionCodec.decode(json({ ...record, ...patch })).ok).toBe(false);
    expect(
      factObservationCodec.decode(
        json({ scope: record.scope, key: "missing", missing: true, value: null }),
      ).ok,
    ).toBe(false);
  });
  it("retains exact large numbers, numeric spellings, own prototype-named fields and scalar roots", () => {
    for (const text of [
      "900719925474099312345",
      "1.0",
      "1e0",
      '{"__proto__":{"constructor":null},"toString":9007199254740993}',
      "false",
      '"literal $ref"',
    ]) {
      const raw = source(text),
        dto = d.jsonObject([
          ...Object.entries(record)
            .filter(([k]) => k !== "value" && k !== "value_type")
            .map(([k, v]) => [k, json(v)] as const),
          ["value_type", d.jsonString(raw.kind)],
          ["value", raw],
        ]),
        r = factVersionCodec.decode(dto);
      expect(r.ok).toBe(true);
      if (!r.ok || r.value.kind !== "value") throw new Error("decode");
      expect(canonicalJson(r.value.value)).toEqual(canonicalJson(raw));
    }
  });
  it("checks canonical value byte/container bounds, key controls, explicit scopes and reference uniqueness", () => {
    expect(
      factVersionCodec.decode(json({ ...record, value_type: "string", value: "a".repeat(4094) }))
        .ok,
    ).toBe(true);
    expect(
      factVersionCodec.decode(json({ ...record, value_type: "string", value: "a".repeat(4095) }))
        .ok,
    ).toBe(false);
    for (const count of [16, 17]) {
      let value: unknown = null;
      for (let n = 0; n < count; n++) value = { x: value };
      expect(factVersionCodec.decode(json({ ...record, value_type: "object", value })).ok).toBe(
        count === 16,
      );
    }
    for (const name of ["", " ", "a\n", "a\u0080", "é".repeat(65)])
      expect(keyCodec.decode(d.jsonString(name)).ok).toBe(false);
    expect(keyCodec.decode(d.jsonString("Case Sensitive.Key")).ok).toBe(true);
    expect(scopeCodec.decode(json({ kind: "resource", id: "resource" })).ok).toBe(false);
    expect(scopeCodec.decode(json({ kind: "workspace", id: "leak" })).ok).toBe(false);
    expect(
      factVersionCodec.decode(
        json({
          ...record,
          references: [
            { kind: "ticket", id: "t" },
            { kind: "ticket", id: "t" },
          ],
        }),
      ).ok,
    ).toBe(false);
  });
  it("keeps metadata value-free and rejects nonadvancing or inconsistent page cursors", () => {
    const metadata = Object.fromEntries(
      Object.entries(record).filter(([name]) => name !== "value"),
    );
    expect(factKeyCodec.decode(json(metadata)).ok).toBe(true);
    expect(factKeyCodec.decode(json(record)).ok).toBe(false);
    for (const p of [
      page([], "0", "1", "0"),
      page([metadata], "0", "1", "2"),
      page([metadata], "0", "1", null),
      page([metadata], "0", "0", "1"),
    ])
      expect(factPageCodec(factKeyCodec).decode(json(p)).ok).toBe(false);
    const captured = decodeCapture(
      target,
      response(page([metadata], "0", "1", "1"), "7", true),
      factPageCodec(factKeyCodec),
    );
    expect(captured.ok).toBe(true);
    if (!captured.ok) throw new Error("capture");
    expect(captured.data.partial).toBe(true);
    expect(captured.data.value.nextOffset).toBe("1");
    expect(
      decodeCapture(target, response(page([])), factPageCodec(factKeyCodec), decode(d.decimal, "8"))
        .ok,
    ).toBe(false);
  });
  it("validates batch order/explicit missing, history version order, scope and planning capture", async () => {
    const processing = createTestProcessor();
    let answer: ReadResponse = response(page([record]));
    const requests: HttpRequest<unknown>[] = [];
    const http: HttpClient = {
      processing,
      request: <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
        requests.push(request);
        const r = request.codec.decode(
          d.jsonObject([
            [
              "response",
              d.jsonObject([
                ["data", answer.response.data],
                ["meta", answer.response.meta],
              ]),
            ],
            ["pagination", d.jsonNull()],
          ]),
        );
        if (!r.ok) throw new Error(r.issue.expected);
        return Promise.resolve({ ok: true, data: r.value, httpStatus: 200 });
      },
    };
    try {
      const api = createFactsClient(http);
      expect((await api.multiGet(target, ["settings"])).ok).toBe(true);
      expect((await api.multiGet(target, ["other"])).ok).toBe(false);
      answer = response(page([{ scope: record.scope, key: "absent", missing: true }]));
      expect((await api.multiGet(target, ["absent"])).ok).toBe(true);
      answer = response(page([{ ...record, scope: { kind: "project", id: "foreign" } }]));
      expect((await api.multiGet(target, ["settings"])).ok).toBe(false);
      answer = response(page([{ ...record, changed_at_revision: "8" }]));
      expect((await api.multiGet(target, ["settings"])).ok).toBe(false);
      answer = response(page([{ ...record, revision: "2" }]));
      expect((await api.history(target, "settings")).ok).toBe(false);
      answer = response(page([], "9007199254740993"));
      expect(
        (
          await api.multiGet(target, ["settings"], {
            offset: decode(d.decimal, "9007199254740993"),
            atRevision: decode(d.decimal, "7"),
          })
        ).ok,
      ).toBe(false);
      const body = requests[0]?.body;
      expect(body === undefined ? undefined : jsonField(body, "generation")).toEqual(
        d.jsonString("2"),
      );
    } finally {
      processing.dispose();
    }
  });
});
