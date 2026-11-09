import { describe, expect, it, vi } from "vitest";
import * as d from "../../../src/core/protocol/decoders";
import type { HttpClient } from "../../../src/core/protocol/http";
import type {
  ManagedOperation,
  ManagedResult,
  OperationController,
} from "../../../src/core/state/operations";
import {
  createResourceDraftController,
  resourcePreparation,
} from "../../../src/features/knowledge/resources/drafts";
import { resourceRecordCodec } from "../../../src/features/knowledge/resources/codecs";
import type {
  ResourceCapture,
  ResourceRecord,
} from "../../../src/features/knowledge/resources/types";
import { context, decode, response } from "../../work/actions-fixtures";
import { jsonField } from "../../../src/core/json";
const ctx = context({} as HttpClient);
const scope = { connection: ctx.connection, workspaceId: decode(d.identifier, "demo") };
function fixture() {
  const entries = new Map<string, ManagedOperation>();
  const register = vi.fn<OperationController["register"]>((preparation) => {
    const entry: ManagedOperation = { preparation, operation: null, phase: { kind: "draft" } };
    entries.set(preparation.intention_id, entry);
    return Promise.resolve({ ok: true, entry });
  });
  const act = vi.fn<OperationController["act"]>(() =>
    Promise.resolve({
      ok: false,
      failure: { kind: "input", message: "Synthetic native rejection" },
    }),
  );
  const operations: OperationController = {
    register,
    act,
    get: (id) => entries.get(id),
    list: () => [...entries.values()],
    subscribe: () => () => undefined,
    adopt: () =>
      Promise.resolve({ ok: false, failure: { kind: "input", message: "Unexpected adopt" } }),
    dispose: () => undefined,
  };
  return { drafts: createResourceDraftController(operations), operations, register, act };
}
function base(): ResourceCapture<ResourceRecord> {
  return {
    scope,
    queryRevision: decode(d.decimal, "90"),
    partial: false,
    response: response({}),
    value: decode(resourceRecordCodec, {
      resource_id: "artifact",
      revision: "9007199254740993",
      version_count: "2",
      metadata: {
        title: "Published title",
        filename: "data.txt",
        mime_type: "text/plain",
        description: "kept description",
        archived: false,
        targets: [],
      },
      current_version: {
        revision: "2",
        digest: "a".repeat(64),
        size_bytes: "3",
        actor_id: "author",
        timestamp: "synthetic",
        filename: "data.txt",
        mime_type: "text/plain",
      },
    }),
  };
}
async function valid(f: ReturnType<typeof fixture>) {
  await f.drafts.open(ctx, scope, "text");
  const draft = f.drafts.get().drafts[0]!;
  f.drafts.edit(draft.id, {
    ...draft.input,
    resourceId: "artifact",
    title: "Document",
    text: "source",
  });
  return f.drafts.get().drafts[0]!;
}
describe("captured resource editors", () => {
  it("rejects incomplete input without registration, permits repair, and preserves admitted intention on close", async () => {
    const f = fixture();
    await f.drafts.open(ctx, scope, "text");
    const draft = f.drafts.get().drafts[0]!;
    await f.drafts.save(draft.id);
    expect(f.register).not.toHaveBeenCalled();
    expect(f.drafts.get().drafts[0]?.phase).toBe("editing");
    f.drafts.edit(draft.id, {
      ...draft.input,
      resourceId: "artifact",
      title: "Document",
      text: "",
    });
    await f.drafts.save(draft.id, false);
    expect(f.register).toHaveBeenCalledOnce();
    expect(f.act).not.toHaveBeenCalled();
    const preparation = f.operations.get(draft.id)?.preparation;
    expect(jsonField(preparation!.params, "text")).toEqual(d.jsonString(""));
    f.drafts.discard(draft.id);
    expect(f.drafts.get().drafts).toHaveLength(0);
    expect(f.operations.get(draft.id)).toBeDefined();
  });
  it("unlocks a known local admission rejection without losing the editable draft", async () => {
    const f = fixture(),
      draft = await valid(f);
    f.register.mockResolvedValueOnce({
      ok: false,
      failure: { kind: "input", message: "Envelope exceeds request budget" },
    });
    await f.drafts.save(draft.id);
    expect(f.drafts.get().drafts[0]?.phase).toBe("editing");
    expect(f.drafts.get().drafts[0]?.input.text).toBe("source");
    f.drafts.edit(draft.id, { ...draft.input, text: "repaired" });
    await f.drafts.save(draft.id, false);
    expect(f.register).toHaveBeenCalledTimes(2);
  });
  it("locks an immutable captured draft while asynchronous registration is pending", async () => {
    const f = fixture(),
      draft = await valid(f);
    let release!: (value: ManagedResult) => void;
    f.register.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const pending = f.drafts.save(draft.id);
    f.drafts.edit(draft.id, { ...draft.input, text: "changed" });
    f.drafts.discard(draft.id);
    expect(f.drafts.get().drafts[0]?.phase).toBe("saving");
    expect(f.drafts.get().drafts[0]?.input.text).toBe("source");
    release({ ok: false, failure: { kind: "input", message: "No admission" } });
    await pending;
    expect(f.drafts.get().drafts[0]?.phase).toBe("editing");
  });
  it("captures writer before asynchronous source read and keeps actual metadata guard", async () => {
    const f = fixture();
    let release!: (value: ArrayBuffer) => void;
    const blob = new Blob(["old"]);
    vi.spyOn(blob, "arrayBuffer").mockImplementation(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const mutable = { ...ctx, writer: { ...ctx.writer } };
    const pending = f.drafts.open(mutable, scope, "text", base(), {
      blob,
      version: decode(d.decimal, "1"),
    });
    mutable.writer.actorId = "other";
    release(new TextEncoder().encode("old").buffer);
    await pending;
    const draft = f.drafts.get().drafts[0]!,
      p = resourcePreparation(draft);
    expect(p.context.writer.actor_id).toBe("author");
    expect(jsonField(p.params, "expected_revision")).toEqual(d.jsonString("9007199254740993"));
    expect(draft.input.filename).toBe("data.txt");
  });
  it("preserves omitted metadata and explicit empty replacement independently", async () => {
    const f = fixture();
    await f.drafts.open(ctx, scope, "metadata", base());
    const draft = f.drafts.get().drafts[0]!;
    f.drafts.edit(draft.id, {
      ...draft.input,
      description: "",
      changes: { ...draft.input.changes, description: true },
    });
    const p = resourcePreparation(f.drafts.get().drafts[0]!);
    expect(p.method).toBe("resource.update");
    expect(jsonField(p.params, "title")).toBeUndefined();
    expect(jsonField(p.params, "description")).toEqual(d.jsonString(""));
  });
  it("rejects incomplete metadata and oversized text without silently replacing them", async () => {
    const f = fixture();
    await f.drafts.open(ctx, scope, "metadata", { ...base(), partial: true });
    expect(f.drafts.get().drafts).toHaveLength(0);
    await f.drafts.open(ctx, scope, "text", base(), {
      blob: new Blob(["x".repeat(65537)]),
      version: decode(d.decimal, "1"),
    });
    expect(f.drafts.get().drafts).toHaveLength(0);
    expect(f.drafts.get().issue).toContain("64KiB");
  });
  it("retains unexpected storage/Blob failures rather than classifying them as binary", async () => {
    const f = fixture(),
      blob = new Blob(["x"]),
      error = new Error("Unexpected source failure");
    vi.spyOn(blob, "arrayBuffer").mockRejectedValue(error);
    await f.drafts.open(ctx, scope, "text", base(), { blob, version: decode(d.decimal, "1") });
    expect(f.drafts.get().unexpected?.error).toBe(error);
  });
});
