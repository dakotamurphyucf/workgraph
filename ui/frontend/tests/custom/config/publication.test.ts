import { afterEach, expect, it, vi } from "vitest";
import { parseJsonText, jsonField, canonicalJson } from "../../../src/core/json";
import * as d from "../../../src/core/protocol/decoders";
import { prepareConfigPublication } from "../../../src/features/custom/config/publication";
import { decodeConfigValue } from "../../../src/features/custom/config/decode";
import type { ConfigPublicationIntention } from "../../../src/features/custom/config/types";
import { createTestProcessor } from "../../core/processing-harness";
function id(s: string) {
  const r = d.identifier.decode(d.jsonString(s));
  if (!r.ok) throw new Error("id");
  return r.value;
}
function decimal(s: string) {
  const r = d.decimal.decode(d.jsonString(s));
  if (!r.ok) throw new Error("decimal");
  return r.value;
}
function digest(s: string) {
  const r = d.digest.decode(d.jsonString(s));
  if (!r.ok) throw new Error("digest");
  return r.value;
}
const processors: ReturnType<typeof createTestProcessor>[] = [];
afterEach(() => {
  processors.splice(0).forEach((p) => p.dispose());
  vi.restoreAllMocks();
});
export function intention(): ConfigPublicationIntention {
  const parsed = parseJsonText(
    '{"config_version":1,"kind":"view","id":"facts","title":"Facts","source":"facts","scope":{"kind":"ticket","id":"ticket"},"filter_mode":"server","filters":[{"pointer":"/n","op":"equals","value":9007199254740993}],"sort":[],"group_by":null,"presentation":"table","columns":[{"id":"key","selector":{"kind":"field","field":"key"},"label":"Key","format":{"type":"text"}}]}',
  );
  if (!parsed.ok) throw new Error("parse");
  const decoded = decodeConfigValue(parsed.value.value);
  if (decoded.kind !== "valid" || !("kind" in decoded.document) || decoded.document.kind !== "view")
    throw new Error("view");
  return {
    intentionId: id("publish"),
    documentResourceId: id("config"),
    catalogResourceId: id("catalog"),
    document: decoded.document,
    capture: {
      connection: {
        id: id("local"),
        generation: decimal("2"),
        socket: "/tmp/owned.sock",
        label: "Owned",
      },
      workspaceId: id("workspace"),
      writer: { actorId: id("writer"), runId: id("run") },
      link: { kind: "project", id: id("project") },
      index: { scope: { kind: "ticket", id: id("ticket") }, expectedRevision: decimal("4") },
      documentBase: { kind: "missing" },
      catalogBase: { kind: "missing" },
      catalog: { kind: "new" },
    },
  };
}
function processor() {
  const p = createTestProcessor();
  processors.push(p);
  return p;
}
it("prepares five explicit guarded operations, exact pins and distinct link/index targets", async () => {
  const prepared = await prepareConfigPublication(processor(), intention());
  const ops = jsonField(prepared.preparation.params, "operations");
  if (ops?.kind !== "array") throw new Error("ops");
  expect(ops.items.map((op) => jsonField(op, "method"))).toEqual(
    ["resource.put_text", "resource.link", "resource.put_text", "resource.link", "fact.put"].map(
      d.jsonString,
    ),
  );
  expect(jsonField(jsonField(ops.items[1]!, "params")!, "expected_revision")).toEqual(
    d.jsonString("1"),
  );
  expect(jsonField(jsonField(ops.items[1]!, "params")!, "target")).toEqual(
    d.jsonObject([
      ["kind", d.jsonString("project")],
      ["id", d.jsonString("project")],
    ]),
  );
  expect(jsonField(jsonField(ops.items[4]!, "params")!, "scope")).toEqual(
    d.jsonObject([
      ["kind", d.jsonString("ticket")],
      ["id", d.jsonString("ticket")],
    ]),
  );
  for (const [index, pin] of [
    [0, prepared.documentPin],
    [2, prepared.catalogPin],
  ] as const) {
    const text = jsonField(jsonField(ops.items[index]!, "params")!, "text");
    if (text?.kind !== "string") throw new Error("text");
    const bytes = new TextEncoder().encode(text.value);
    const actual = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (v) =>
      v.toString(16).padStart(2, "0"),
    ).join("");
    expect(pin.digest).toBe(actual);
    expect(pin.size_bytes).toBe(String(bytes.length));
    expect(pin.version).toBe("1");
  }
  expect(canonicalJson(prepared.preparation.params)).toMatchObject({ ok: true });
});
it("uses complete content count instead of metadata revision and omits existing links", async () => {
  const original = intention();
  const base = (resourceId: string) => ({
    kind: "existing" as const,
    scope: { connection: original.capture.connection, workspaceId: original.capture.workspaceId },
    link: original.capture.link,
    resourceId: id(resourceId),
    metadataRevision: decimal("12"),
    versionCount: decimal("3"),
    content: {
      resource_id: id(resourceId),
      version: decimal("3"),
      digest: digest("a".repeat(64)),
      size_bytes: decimal("50"),
    },
    linked: true,
  });
  const prepared = await prepareConfigPublication(processor(), {
    ...original,
    capture: {
      ...original.capture,
      documentBase: base("config"),
      catalogBase: { kind: "missing" },
    },
  });
  expect(prepared.documentPin.version).toBe("4");
  expect(prepared.catalogPin.version).toBe("1");
  const ops = jsonField(prepared.preparation.params, "operations");
  expect(ops?.kind === "array" && ops.items.length).toBe(4);
  const before = processor();
  await expect(
    prepareConfigPublication(before, {
      ...original,
      catalogResourceId: original.documentResourceId,
    }),
  ).rejects.toThrow("distinct");
});
it("retains the exact encoded document and original writer when caller data changes during processing", async () => {
  const original = intention(),
    writer = { actorId: id("before"), runId: null };
  const literal = { kind: "string" as const, value: "before" };
  const document = {
    ...original.document,
    title: "Before",
    filters: [{ pointer: "/value", op: "equals" as const, value: literal }],
  };
  const p = processor(),
    encode = p.encode;
  let release: (() => void) | undefined;
  let first = true;
  const processing = {
    ...p,
    encode: (value: Parameters<typeof encode>[0], options?: Parameters<typeof encode>[1]) => {
      const pending = encode(value, options);
      if (!first) return pending;
      first = false;
      return new Promise<void>((resolve) => {
        release = resolve;
      }).then(() => pending);
    },
  };
  const pending = prepareConfigPublication(processing, {
    ...original,
    document,
    capture: { ...original.capture, writer },
  });
  document.title = "After";
  literal.value = "after";
  writer.actorId = id("after");
  release?.();
  const result = await pending;
  expect(result.intention.document.title).toBe("Before");
  expect(
    result.intention.document.kind === "view" && result.intention.document.filters[0],
  ).toMatchObject({ value: { kind: "string", value: "before" } });
  expect(result.preparation.context.writer.actor_id).toBe("before");
});
it("keeps worker cancellation/capacity/deadline distinct from invalid config and preserves unexpected exceptions", async () => {
  const p = processor();
  for (const kind of ["aborted", "busy", "timeout", "protocol"] as const)
    await expect(
      prepareConfigPublication(
        { ...p, encode: () => Promise.resolve({ ok: false, failure: { kind, message: kind } }) },
        intention(),
      ),
    ).rejects.toMatchObject({ kind, message: kind });
  await expect(
    prepareConfigPublication(
      { ...p, encode: () => Promise.reject(new TypeError("defect")) },
      intention(),
    ),
  ).rejects.toThrow("defect");
});
it("retains verified prior catalog entries and rejects a mismatched source before preparing replacement", async () => {
  const original = intention();
  const text =
    '{"config_version":1,"kind":"catalog","entries":[{"kind":"renderer","id":"existing","pin":{"resource_id":"existing-source","version":"2","digest":"' +
    "b".repeat(64) +
    '","size_bytes":"90"}}]}';
  const blob = new Blob([text]);
  const hash = digest(
    Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
      (v) => v.toString(16).padStart(2, "0"),
    ).join(""),
  );
  const content = {
    resource_id: id("catalog"),
    version: decimal("3"),
    digest: hash,
    size_bytes: decimal(String(blob.size)),
  };
  const parsed = parseJsonText(text);
  if (!parsed.ok) throw new Error("parse");
  const source = {
    scope: { connection: original.capture.connection, workspaceId: original.capture.workspaceId },
    pin: content,
    blob,
    decoded: decodeConfigValue(parsed.value.value),
  };
  const captured = {
    ...original,
    capture: {
      ...original.capture,
      catalogBase: {
        kind: "existing" as const,
        scope: source.scope,
        link: original.capture.link,
        resourceId: id("catalog"),
        metadataRevision: decimal("12"),
        versionCount: decimal("3"),
        content,
        linked: true,
      },
      catalog: { kind: "existing" as const, capture: source },
    },
  };
  const result = await prepareConfigPublication(processor(), captured);
  expect(result.catalogPin.version).toBe("4");
  const ops = jsonField(result.preparation.params, "operations");
  if (ops?.kind !== "array") throw new Error("ops");
  const published = jsonField(jsonField(ops.items[2]!, "params")!, "text");
  if (published?.kind !== "string") throw new Error("text");
  expect(published.value).toContain('"existing-source"');
  expect(published.value).toContain('"facts"');
  await expect(
    prepareConfigPublication(processor(), {
      ...captured,
      capture: {
        ...captured.capture,
        catalog: {
          kind: "existing",
          capture: { ...source, scope: { ...source.scope, workspaceId: id("other") } },
        },
      },
    }),
  ).rejects.toThrow("endpoint, workspace");
  await expect(
    prepareConfigPublication(processor(), {
      ...captured,
      capture: {
        ...captured.capture,
        catalog: {
          kind: "existing",
          capture: { ...source, blob: new Blob(["x".repeat(blob.size)]) },
        },
      },
    }),
  ).rejects.toThrow("SHA-256");
});
it("does not return a publishable preparation after cancellation races the final digest", async () => {
  const abort = new AbortController();
  let calls = 0;
  const original = crypto.subtle.digest.bind(crypto.subtle);
  const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation((algorithm, data) => {
    const result = original(algorithm, data);
    calls++;
    return calls === 2
      ? result.then((digest) => {
          abort.abort();
          return digest;
        })
      : result;
  });
  try {
    await expect(
      prepareConfigPublication(processor(), intention(), abort.signal),
    ).rejects.toMatchObject({ kind: "aborted" });
  } finally {
    spy.mockRestore();
  }
});

it("rejects same-ID publication guards observed at a different endpoint/workspace or link", async () => {
  const original = intention();
  const base = {
    kind: "existing" as const,
    scope: { connection: original.capture.connection, workspaceId: original.capture.workspaceId },
    link: original.capture.link,
    resourceId: original.documentResourceId,
    metadataRevision: decimal("1"),
    versionCount: decimal("1"),
    content: {
      resource_id: original.documentResourceId,
      version: decimal("1"),
      digest: digest("a".repeat(64)),
      size_bytes: decimal("1"),
    },
    linked: true,
  };
  for (const changed of [
    { ...base, scope: { ...base.scope, workspaceId: id("other-workspace") } },
    {
      ...base,
      scope: { ...base.scope, connection: { ...base.scope.connection, generation: decimal("3") } },
    },
    {
      ...base,
      scope: { ...base.scope, connection: { ...base.scope.connection, socket: "/tmp/other.sock" } },
    },
    {
      ...base,
      scope: {
        ...base.scope,
        connection: { ...base.scope.connection, id: id("other-connection") },
      },
    },
    { ...base, link: { kind: "project" as const, id: id("other-project") } },
  ])
    await expect(
      prepareConfigPublication(processor(), {
        ...original,
        capture: { ...original.capture, documentBase: changed },
      }),
    ).rejects.toThrow("provenance");
});
