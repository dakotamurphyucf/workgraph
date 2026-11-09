import { afterEach, expect, it } from "vitest";
import * as d from "../../../src/core/protocol/decoders";
import type { HttpClient, HttpRequest, HttpResult } from "../../../src/core/protocol/http";
import {
  createPersonalClient,
  inventoryCodec,
  settingsCodec,
} from "../../../src/features/custom/editor/settings";
import { createTestProcessor } from "../../core/processing-harness";
import { decode, json, settings, target } from "./fixtures";
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((dispose) => dispose()));
it("retains unknown source but rejects endpoint or workspace guard transplantation", () => {
  const codec = settingsCodec(target),
    source = settings();
  expect(decode(codec, source).documents[0]?.source).toBe("future opaque source");
  for (const changed of [
    { ...source, target: { ...source.target, workspace_id: "other" } },
    {
      ...source,
      target: { ...source.target, connection: { ...source.target.connection, generation: "2" } },
    },
    {
      ...source,
      target: {
        ...source.target,
        connection: { ...source.target.connection, socket: "/tmp/other.sock" },
      },
    },
    { ...source, documents: [...source.documents, ...source.documents] },
    { ...source, selected_id: "missing" },
  ])
    expect(codec.decode(json(changed)).ok).toBe(false);
});
it("bounds inventory across targets and exposes old exact target without portable source data", () => {
  const item = { target: settings().target, document_ids: ["view"], selected_id: "view" };
  const result = decode(inventoryCodec, { revision: "7", items: [item] });
  expect(result.targets[0]?.target.connection.socket).toBe("/tmp/original.sock");
  expect(inventoryCodec.decode(json({ revision: "7", items: [item, item] })).ok).toBe(false);
  expect(
    inventoryCodec.decode(json({ revision: "7", items: [{ ...item, document_ids: [] }] })).ok,
  ).toBe(false);
});
it("captures mutable caller save input before awaiting and validates exact saved source", async () => {
  const processing = createTestProcessor();
  cleanup.push(processing.dispose);
  let complete: () => void = () => {
    throw new Error("pending");
  };
  const hold = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let seen: HttpRequest<unknown> | null = null;
  const http: HttpClient = {
    processing,
    async request<T>(request: HttpRequest<T>): Promise<HttpResult<T>> {
      seen = request;
      await hold;
      const decoded = request.codec.decode(json(settings()));
      return decoded.ok
        ? { ok: true, data: decoded.value, httpStatus: 200 }
        : {
            ok: false,
            failure: { kind: "protocol", message: decoded.issue.expected, issue: decoded.issue },
          };
    },
  };
  const mutableTarget = { connection: { ...target.connection }, workspaceId: target.workspaceId };
  const document = { id: decode(d.identifier, "view"), source: "future opaque source" };
  const pending = createPersonalClient(http).replace({
    target: mutableTarget,
    expectedRevision: decode(d.decimal, "0"),
    documents: [document],
    selectedId: document.id,
  });
  mutableTarget.connection.socket = "/tmp/retargeted.sock";
  document.source = "changed after await";
  complete();
  expect((await pending).ok).toBe(true);
  expect(seen).not.toBeNull();
});
it("rejects a successful-looking replace with changed documents or wrong revision", async () => {
  const processing = createTestProcessor();
  cleanup.push(processing.dispose);
  const http: HttpClient = {
    processing,
    request<T>(request: HttpRequest<T>): Promise<HttpResult<T>> {
      const decoded = request.codec.decode(
        json({ ...settings("8"), documents: [{ id: "view", source: "different" }] }),
      );
      return Promise.resolve(
        decoded.ok
          ? { ok: true, data: decoded.value, httpStatus: 200 }
          : {
              ok: false,
              failure: { kind: "protocol", message: decoded.issue.expected, issue: decoded.issue },
            },
      );
    },
  };
  const result = await createPersonalClient(http).replace({
    target,
    expectedRevision: decode(d.decimal, "0"),
    documents: [{ id: decode(d.identifier, "view"), source: "original" }],
    selectedId: null,
  });
  expect(result.ok).toBe(false);
});
it("matches only an explicit valid root schema declaration without inference or source mutation", async () => {
  const { declaredSchema } = await import("../../../src/features/custom/editor/model");
  const { chooseRenderer } = await import("../../../src/features/custom/config");
  const renderer = {
    config_version: 1 as const,
    kind: "renderer" as const,
    id: decode(d.identifier, "schema-renderer"),
    title: "Schema renderer",
    match: {
      entity: "fact" as const,
      schema: { id: decode(d.identifier, "example-measurement"), version: "1" },
    },
    presentation: { type: "json" as const, pointer: "" },
    fallback: "generic" as const,
  };
  const pin = {
    resource_id: renderer.id,
    version: decode(d.decimal, "1"),
    digest: decode(d.digest, "a".repeat(64)),
    size_bytes: decode(d.decimal, "1"),
  };
  const cases = [
    { input: { schema: { id: "example-measurement", version: "1" } }, match: true, invalid: false },
    {
      input: { schema: { id: "example-measurement", version: "2" } },
      match: false,
      invalid: false,
    },
    { input: { schema: { id: "example-measurement", version: 1 } }, match: false, invalid: true },
    {
      input: { schema: { id: "example-measurement", version: "1", extra: true } },
      match: false,
      invalid: true,
    },
    { input: { schema: { id: "example-measurement", version: "" } }, match: false, invalid: true },
    { input: { id: "example-measurement", version: "1" }, match: false, invalid: false },
    {
      input: [{ schema: { id: "example-measurement", version: "1" } }],
      match: false,
      invalid: false,
    },
  ];
  for (const item of cases) {
    const value = json(item.input),
      before = JSON.stringify(value),
      declared = declaredSchema(value);
    const result = chooseRenderer([{ renderer, pin }], {
      entity: "fact",
      value,
      schema: declared.schema,
    });
    expect(result.kind === "renderer").toBe(item.match);
    expect(declared.message !== null).toBe(item.invalid);
    expect(JSON.stringify(value)).toBe(before);
    expect(
      chooseRenderer([{ renderer, pin }], { entity: "fact", value, schema: declared.schema }, pin)
        .kind,
    ).toBe("renderer");
  }
});
