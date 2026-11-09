import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  HttpClient,
  HttpFailure,
  HttpRequest,
  HttpResult,
} from "../../../src/core/protocol/http";
import * as c from "../../../src/core/protocol/codec";
import * as d from "../../../src/core/protocol/decoders";
import type { OperationController } from "../../../src/core/state/operations";
import type { CustomPage, CustomTarget } from "../../../src/features/custom/editor/types";
import { jsonField } from "../../../src/core/json";
import { personalDocument } from "../../../src/features/custom/editor/settings";
import type { ViewConfig } from "../../../src/features/custom/config";
import { createCustomController } from "../../../src/features/custom/editor/controller";
import {
  defaultView,
  defaultRenderer,
  id,
  counter,
} from "../../../src/features/custom/editor/model";
import { createTestProcessor } from "../../core/processing-harness";
import { decode, json, target } from "./fixtures";
const catalogs = vi.hoisted(() => ({ load: vi.fn(), open: vi.fn(), dispose: vi.fn() }));
const source = vi.hoisted(() => ({ initial: vi.fn(), next: vi.fn() }));
vi.mock("../../../src/features/custom/editor/source", () => ({
  createSourceAdapter: () => source,
}));
vi.mock("../../../src/features/custom/editor/shared", () => ({
  SharedReadError: class extends Error {},
  createSharedConfiguration: () => catalogs,
}));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function object(value: unknown) {
  return decode(c.object, value);
}
function ok<T>(data: T): HttpResult<T> {
  return { ok: true, data, httpStatus: 200 };
}
function page(
  view: ViewConfig,
  names: readonly string[] = ["a"],
  extra: Partial<CustomPage> = {},
): CustomPage {
  return {
    target,
    view,
    invocation: {
      connection_id: target.connection.id,
      generation: target.connection.generation,
      method: "ticket.list",
      params: object({ workspace_id: "demo" }),
      lane: "visible",
    },
    response: { response: { data: object({}), meta: object({}) }, pagination: null },
    capture: { kind: "planning", revision: counter("1") },
    rows: names.map((identity) => ({
      identity,
      fields: { title: json(identity) },
      raw: json({ title: identity }),
    })),
    complete: true,
    partial: false,
    next: null,
    retry: null,
    stop: "complete",
    ...extra,
  };
}
const disposals: (() => void)[] = [];
afterEach(() =>
  disposals
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose()),
);
beforeEach(() => {
  source.initial.mockReset();
  source.next.mockReset();
  source.initial.mockImplementation((_target: CustomTarget, view: ViewConfig) =>
    Promise.resolve(ok(page(view))),
  );
});
function harness() {
  const processing = createTestProcessor();
  let failure: HttpFailure | null = null,
    writes = 0;
  const document = defaultView(id("view"), { kind: "workspace" });
  const sourceText = JSON.stringify(document);
  let observedTarget = target;
  let documents = [{ id: id("view"), source: sourceText }];
  const writeBodies: unknown[] = [];
  let revision = "1",
    selectedId: string | null = null;
  const http: HttpClient = {
    processing,
    request<T>(request: HttpRequest<T>): Promise<HttpResult<T>> {
      if (request.path.endsWith("replace")) {
        writes++;
        writeBodies.push(request.body);
        if (failure !== null) return Promise.resolve({ ok: false, failure });
        revision = (BigInt(revision) + 1n).toString();
        const supplied =
          request.body?.kind === "object" ? jsonField(request.body, "documents") : undefined;
        const parsed =
          supplied === undefined ? null : c.array(personalDocument, 25).decode(supplied);
        if (parsed === null || !parsed.ok)
          throw new Error("Fixture expected valid document replacement");
        documents = [...parsed.value];
        const field =
          request.body?.kind === "object"
            ? request.body.fields.find((field) => field.name === "selected_id")?.value
            : undefined;
        selectedId = field?.kind === "string" ? field.value : null;
      }
      const result = request.codec.decode(
        json({
          target: {
            connection: observedTarget.connection,
            workspace_id: observedTarget.workspaceId,
          },
          revision,
          documents,
          selected_id: selectedId,
        }),
      );
      if (!result.ok) throw new Error(result.issue.expected);
      return Promise.resolve(ok(result.value));
    },
  };
  const operations: OperationController = {
    get: () => undefined,
    list: () => [],
    subscribe: () => () => {},
    register: () => Promise.resolve({ ok: false, failure: { kind: "input", message: "unused" } }),
    adopt: () => Promise.resolve({ ok: false, failure: { kind: "input", message: "unused" } }),
    act: () => Promise.resolve({ ok: false, failure: { kind: "input", message: "unused" } }),
    dispose() {},
  };
  const controller = createCustomController({ http, operations });
  disposals.push(processing.dispose, controller.dispose);
  return {
    controller,
    processing,
    document,
    sourceText,
    get writes() {
      return writes;
    },
    get writeBodies() {
      return writeBodies;
    },
    externalDocument() {
      documents = [...documents, { id: id("concurrent"), source: "retained concurrent source" }];
      revision = (BigInt(revision) + 1n).toString();
    },
    clearFailure() {
      failure = null;
    },
    setObservedTarget(value: CustomTarget) {
      observedTarget = value;
    },
    advanceRevision() {
      revision = (BigInt(revision) + 1n).toString();
    },
    setFailure(value: HttpFailure) {
      failure = value;
    },
  };
}
async function ready(h: ReturnType<typeof harness>) {
  h.controller.selectSavedTarget(target);
  await vi.waitFor(() => expect(h.controller.get().personal.kind).toBe("ready"));
  h.controller.editPersonal(id("view"));
  await vi.waitFor(() => {
    const draft = h.controller.get().draft;
    expect(draft?.kind === "editing" && draft.decoded?.kind).toBe("valid");
  });
}
it("caches external-store snapshots and retains original drafts across read target changes", async () => {
  const h = harness();
  await ready(h);
  const first = h.controller.get();
  expect(h.controller.get()).toBe(first);
  h.controller.selectSavedTarget({ ...target, workspaceId: id("other") });
  expect(h.controller.get().draft).toBe(first.draft);
  expect(h.controller.get().active).toBeNull();
});
it("publishes saved CAS acknowledgement independently of stalled optional titles and fences timeout/late completion", async () => {
  const h = harness();
  await ready(h);
  await vi.waitFor(() => expect(h.controller.get().personalLabels?.status).toBe("complete"));
  const parsed = await h.processing.parse(h.sourceText);
  const hold = deferred<typeof parsed>();
  const spy = vi.spyOn(h.processing, "parse").mockReturnValue(hold.promise);
  vi.useFakeTimers();
  try {
    await h.controller.savePersonal();
    expect(h.controller.get().personalSave).toEqual({
      kind: "saved",
      revision: "2",
      confirmation: "acknowledged",
    });
    expect(h.controller.get().personal.kind).toBe("ready");
    expect(h.controller.get().personalLabels?.status).toBe("loading");
    expect(h.controller.get().personalLabels?.documents[0]?.title).toBeNull();
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.controller.get().personalLabels?.status).toBe("unavailable");
    hold.resolve(parsed);
    await Promise.resolve();
    expect(h.controller.get().personalLabels?.documents[0]?.title).toBeNull();
    expect(h.controller.get().personalSave.kind).toBe("saved");
    expect(source.initial).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
    vi.useRealTimers();
  }
});
it("fences optional names from a superseded target without activating a saved view", async () => {
  const h = harness();
  await ready(h);
  await vi.waitFor(() => expect(h.controller.get().personalLabels?.status).toBe("complete"));
  const parsed = await h.processing.parse(h.sourceText),
    hold = deferred<typeof parsed>();
  const spy = vi.spyOn(h.processing, "parse").mockReturnValueOnce(hold.promise);
  try {
    await h.controller.inspectPersonal();
    const next = { ...target, workspaceId: id("other") };
    h.setObservedTarget(next);
    h.controller.selectSavedTarget(next);
    await vi.waitFor(() =>
      expect(h.controller.get().personalLabels?.settings.target.workspaceId).toBe("other"),
    );
    hold.resolve(parsed);
    await vi.waitFor(() => expect(h.controller.get().personalLabels?.status).toBe("complete"));
    expect(h.controller.get().personalLabels?.settings.target.workspaceId).toBe("other");
    expect(h.controller.get().active).toBeNull();
    expect(source.initial).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});
it("preserves a working view on failed activation and fences superseded candidates", async () => {
  const h = harness();
  await ready(h);
  await h.controller.activate();
  const active = h.controller.get().active,
    rows = h.controller.get().loaded;
  source.initial.mockResolvedValueOnce({
    ok: false,
    failure: { kind: "network", message: "offline" },
  });
  await h.controller.activate();
  expect(h.controller.get().active).toBe(active);
  expect(h.controller.get().loaded).toBe(rows);
  const old = deferred<HttpResult<CustomPage>>();
  source.initial.mockReturnValueOnce(old.promise);
  const pending = h.controller.activate();
  await h.controller.activate();
  const newer = h.controller.get().active;
  old.resolve(ok(page(h.document, ["obsolete"])));
  await pending;
  expect(h.controller.get().active).toBe(newer);
  expect(h.controller.get().loaded[0]?.identity).toBe("a");
});
it.each(["switch", "dispose"] as const)(
  "does not publish candidate completion after %s",
  async (action) => {
    const h = harness();
    await ready(h);
    const hold = deferred<HttpResult<CustomPage>>();
    source.initial.mockReturnValueOnce(hold.promise);
    const pending = h.controller.activate();
    if (action === "switch")
      h.controller.selectSavedTarget({ ...target, workspaceId: id("other") });
    else h.controller.dispose();
    const before = h.controller.get();
    hold.reject(new TypeError("obsolete"));
    await pending;
    expect(h.controller.get()).toBe(before);
    expect(h.controller.get().active).toBeNull();
  },
);
it("retains row cap and per-row enrichment across pages and replaces retry coverage", async () => {
  const h = harness();
  await ready(h);
  const invocation = page(h.document).invocation;
  const enrichment = (names: readonly string[], status: "missing" | "decoded") => ({
    kind: "fact_values" as const,
    rows: names.map((identity) => ({ identity, status, message: null, pin: null })),
    reads: [],
    limits: null,
  });
  source.initial.mockResolvedValueOnce(
    ok(page(h.document, ["a"], { next: invocation, enrichment: enrichment(["a"], "missing") })),
  );
  await h.controller.activate();
  source.next.mockResolvedValueOnce(
    ok(
      page(h.document, ["b"], {
        next: invocation,
        retry: invocation,
        enrichment: enrichment(["b"], "missing"),
      }),
    ),
  );
  await h.controller.continue("next");
  expect(h.controller.get().loadedCoverage.map((item) => item.identity)).toEqual(["a", "b"]);
  source.next.mockResolvedValueOnce(
    ok(page(h.document, ["b"], { next: invocation, enrichment: enrichment(["b"], "decoded") })),
  );
  await h.controller.continue("retry");
  expect(h.controller.get().loadedCoverage.map((item) => item.status)).toEqual([
    "missing",
    "decoded",
  ]);
  source.next.mockResolvedValueOnce(
    ok(
      page(
        h.document,
        Array.from({ length: 511 }, (_, index) => `c${index}`),
        { next: invocation },
      ),
    ),
  );
  await h.controller.continue("next");
  expect(h.controller.get().loaded).toHaveLength(512);
  expect(h.controller.get().loadedLimitReached).toBe(true);
  const calls = source.next.mock.calls.length;
  await h.controller.continue("next");
  expect(source.next).toHaveBeenCalledTimes(calls);
  h.controller.setMode("raw");
  expect(h.controller.get().loadedLimitReached).toBe(true);
  await h.controller.refresh();
  expect(h.controller.get().loadedLimitReached).toBe(false);
});
it.each(["Conflict", "Invalid_argument", "Outcome_unknown", "network"])(
  "distinguishes %s save result without changing guard",
  async (kind) => {
    const h = harness();
    await ready(h);
    h.setFailure(
      kind === "network"
        ? { kind: "network", message: "lost response" }
        : {
            kind: "remote",
            problem: decode(d.problem, { kind, message: "native reason", details: null }),
            httpStatus: 409,
          },
    );
    await h.controller.savePersonal();
    const state = h.controller.get().personalSave;
    expect(state.kind).toBe(
      kind === "Conflict" || kind === "Invalid_argument" ? "rejected" : "unknown",
    );
    expect("plan" in state && state.plan.expectedRevision).toBe("1");
    await h.controller.savePersonal();
    expect(h.writes).toBe(1);
  },
);
it("keeps invalid form text across modes and refuses activation/save", async () => {
  const h = harness();
  await ready(h);
  h.controller.editForm({
    candidate: json(h.document),
    text: { "/columns/0/limit": "-" },
    errors: [{ path: ["columns", "0", "limit"], message: "unfinished" }],
  });
  await vi.waitFor(() => {
    const draft = h.controller.get().draft;
    expect(draft?.kind === "editing" && !draft.busy).toBe(true);
  });
  h.controller.setMode("raw");
  h.controller.setMode("form");
  await h.controller.activate();
  await h.controller.savePersonal();
  expect(h.controller.get().active).toBeNull();
  expect(h.writes).toBe(0);
  const draft = h.controller.get().draft;
  expect(draft?.kind === "editing" && draft.form?.text["/columns/0/limit"]).toBe("-");
});
it("rejects invalid explicit import mapping before any settings write", async () => {
  const h = harness();
  h.controller.selectSavedTarget(target);
  await h.controller.inspectPersonal();
  await h.controller.importSource(
    JSON.stringify({
      settings_version: 1,
      documents: [{ id: "view", source: h.sourceText }],
      selected_id: null,
    }),
  );
  h.controller.mapImport(0, { kind: "ticket", id: id("ticket") });
  await h.controller.adoptImport();
  expect(h.writes).toBe(0);
  expect(h.controller.get().message).toContain("scope");
  expect(h.controller.get().imported?.documents[0]?.source).toBe(h.sourceText);
});
it.each(["switch", "import", "dispose"] as const)(
  "does not send obsolete import after %s during encoding",
  async (action) => {
    const h = harness();
    h.controller.selectSavedTarget(target);
    await h.controller.inspectPersonal();
    await h.controller.importSource(
      JSON.stringify({
        settings_version: 1,
        documents: [{ id: "view", source: h.sourceText }],
        selected_id: null,
      }),
    );
    h.controller.mapImport(0, { kind: "workspace" });
    const gate = deferred<void>(),
      original = h.processing.encode;
    vi.spyOn(h.processing, "encode").mockImplementationOnce(async (value, options) => {
      const encoded = await original(value, options);
      await gate.promise;
      return encoded;
    });
    const pending = h.controller.adoptImport();
    if (action === "switch")
      h.controller.selectSavedTarget({ ...target, workspaceId: id("other") });
    else if (action === "dispose") h.controller.dispose();
    else
      await h.controller.importSource(
        JSON.stringify({ settings_version: 1, documents: [], selected_id: null }),
      );
    gate.resolve();
    await pending;
    expect(h.writes).toBe(0);
  },
);
it("persists preferred selection only by explicit CAS and never activates it", async () => {
  const h = harness();
  h.controller.selectSavedTarget(target);
  await h.controller.inspectPersonal();
  await h.controller.setPersonalDefault(id("view"));
  expect(h.writes).toBe(1);
  expect(h.controller.get().active).toBeNull();
  const personal = h.controller.get().personal;
  expect(personal.kind === "ready" && personal.value.selectedId).toBe("view");
});

it("does not attribute an identical newer state to a definitively rejected save", async () => {
  const h = harness();
  await ready(h);
  h.setFailure({
    kind: "remote",
    httpStatus: 409,
    problem: decode(d.problem, { kind: "Conflict", message: "stale guard", details: null }),
  });
  await h.controller.savePersonal();
  h.advanceRevision();
  await h.controller.inspectPersonal();
  const state = h.controller.get().personalSave;
  expect(state.kind).toBe("conflict");
  expect("observed" in state && state.observed?.revision).toBe("2");
  expect("plan" in state && state.plan.expectedRevision).toBe("1");
  expect(h.writes).toBe(1);
});
it("does not transplant another target's personal guard into a retained shared draft", async () => {
  const h = harness();
  const other = { ...target, workspaceId: id("other") };
  h.setObservedTarget(other);
  h.controller.selectSavedTarget(other);
  await vi.waitFor(() => expect(h.controller.get().personal.kind).toBe("ready"));
  const pin = {
    resource_id: id("shared-view"),
    version: counter("1"),
    digest: decode(d.digest, "b".repeat(64)),
    size_bytes: counter(String(h.sourceText.length)),
  };
  const capture = {
    scope: target,
    pin,
    blob: new Blob([h.sourceText]),
    decoded: { kind: "valid" as const, document: h.document, raw: json(h.document) },
  };
  catalogs.load.mockResolvedValue(
    ok({
      scope: { kind: "workspace" },
      indexRevision: counter("1"),
      capture,
      renderers: [],
      unavailable: [],
    }),
  );
  catalogs.open.mockResolvedValue({ ok: true, capture });
  await h.controller.loadShared({ kind: "workspace" });
  await vi.waitFor(() => expect(h.controller.get().shared.kind).toBe("ready"));
  await h.controller.openShared(id("view"));
  await vi.waitFor(() => {
    const draft = h.controller.get().draft;
    expect(draft?.kind === "editing" && !draft.busy).toBe(true);
  });
  const draft = h.controller.get().draft;
  expect(draft?.kind === "editing" && draft.target.workspaceId).toBe("demo");
  expect(draft?.kind === "editing" && draft.personalBase).toBeNull();
  expect(h.writes).toBe(0);
});

it.each(["preferred", "remove", "import"] as const)(
  "explicit no-draft %s conflict discard refreshes before a deliberate action, preserving concurrent documents",
  async (action) => {
    const h = harness();
    h.controller.selectSavedTarget(target);
    await vi.waitFor(() => expect(h.controller.get().personal.kind).toBe("ready"));
    if (action === "import") {
      await h.controller.importSource(
        JSON.stringify({
          settings_version: 1,
          documents: [{ id: "imported", source: JSON.stringify(defaultRenderer(id("imported"))) }],
          selected_id: null,
        }),
      );
    }
    const perform = () =>
      action === "preferred"
        ? h.controller.setPersonalDefault(id("view"))
        : action === "remove"
          ? h.controller.removePersonal(id("view"))
          : h.controller.adoptImport();
    h.setFailure({
      kind: "remote",
      httpStatus: 409,
      problem: decode(d.problem, { kind: "Conflict", message: "concurrent CAS", details: null }),
    });
    await perform();
    expect(h.controller.get().draft).toBeNull();
    expect(h.controller.get().personalSave.kind).toBe("rejected");
    h.externalDocument();
    await h.controller.inspectPersonal();
    const saved = h.controller.get().personalSave;
    expect(saved.kind).toBe("conflict");
    expect("plan" in saved && saved.plan.expectedRevision).toBe("1");
    const imported = h.controller.get().imported;
    const discard = h.controller.discardPersonalSave();
    expect(h.writes).toBe(1);
    expect(h.controller.get().personalSave.kind).toBe("idle");
    const pending = h.controller.get().personal;
    expect(pending.kind === "loading" && pending.previous === undefined).toBe(true);
    await discard;
    expect(h.controller.get().imported).toBe(imported);
    const observed = h.controller.get().personal;
    expect(observed.kind === "ready" && observed.value.documents.map((d) => d.id)).toEqual([
      "view",
      "concurrent",
    ]);
    h.clearFailure();
    await perform();
    expect(h.writes).toBe(2);
    expect(h.controller.get().personalSave.kind).toBe("saved");
    const body = h.writeBodies[1];
    expect(JSON.stringify(body)).toContain('"value":"2"');
    expect(JSON.stringify(body)).toContain("retained concurrent source");
  },
);

it("activated results join live refresh without a duplicate initial read and continuations stay pinned", async () => {
  const h = harness();
  await ready(h);
  await h.controller.activate();
  expect(source.initial).toHaveBeenCalledTimes(1);
  const invocation = page(h.document).invocation;
  source.initial.mockResolvedValueOnce(
    ok(page(h.document, ["new-live-row"], { next: invocation })),
  );
  await h.controller.refreshLive(new AbortController().signal);
  expect(source.initial).toHaveBeenCalledTimes(2);
  expect(h.controller.get().loaded.map((row) => row.identity)).toEqual(["new-live-row"]);
  source.next.mockResolvedValueOnce(ok(page(h.document, ["continued-row"])));
  await h.controller.continue("next");
  await h.controller.refreshLive(new AbortController().signal);
  expect(source.initial).toHaveBeenCalledTimes(2);
  expect(h.controller.get().loaded.map((row) => row.identity)).toEqual([
    "new-live-row",
    "continued-row",
  ]);
});
