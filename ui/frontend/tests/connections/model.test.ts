import { describe, expect, it } from "vitest";
import type { FeatureContext } from "../../src/app/types";
import { jsonField, parseJsonText, stringifyJson } from "../../src/core/json";
import * as d from "../../src/core/protocol/decoders";
import type { HttpClient } from "../../src/core/protocol/http";
import type { ProtocolProcessor } from "../../src/core/protocol/worker";
import type { JsonObject } from "../../src/core/protocol/types";
import {
  DraftInputError,
  entityPage,
  freezeAction,
  observerContext,
  readScope,
} from "../../src/features/connections/model";
import {
  createConnectionDraftStore,
  type LifecycleEditor,
} from "../../src/features/connections/store";
import {
  createConnectionsClient,
  launchCodec,
  sameLaunchPlan,
} from "../../src/features/connections/client";
import type { LaunchPlan, LifecycleAction } from "../../src/features/connections/types";

const unused = (): Promise<never> =>
  Promise.reject(new Error("Unexpected processor request in pure model fixture"));
const processing: ProtocolProcessor = {
  parse: unused,
  encode: unused,
  decodeHttp: unused,
  admitPreparation: unused,
  observeOperation: unused,
  project: unused,
  dispose: () => {},
};
const http: HttpClient = { processing, request: unused };
function json(source: string) {
  const parsed = parseJsonText(source);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value.value;
}
function object(source: string): JsonObject {
  const value = json(source);
  if (value.kind !== "object") throw new Error("Expected object");
  return value;
}
function identifier(value: string) {
  const found = d.identifier.decode(d.jsonString(value));
  if (!found.ok) throw new Error(found.issue.expected);
  return found.value;
}
const profileResult = d.connectionProfile.decode(
  json('{"id":"local","generation":"1","label":"Local","socket":"/tmp/model.sock"}'),
);
if (!profileResult.ok) throw new Error("Invalid fixture profile");
const connection = profileResult.value;
const context: FeatureContext = {
  client: http,
  connection,
  profileState: "current",
  route: {
    view: "overview",
    connectionId: "local",
    workspaceId: "selected",
    projectId: "project",
    entityId: null,
  },
  writer: { actorId: "original", runId: "original-run" },
  navigate: () => {},
};
const fields = {
  id: "target",
  name: "Name",
  root: "/tmp/workspace",
  title: "Title",
  summary: "Summary",
  description: "Unsent text\n雪",
  instructions: "Instructions",
  acceptance: "Criteria",
  priority: "2",
  status: "todo",
  project: "project",
  date: "",
  revision: "1",
  evidence: "Observed evidence",
  nextSteps: "Continue",
};
function editor(): LifecycleEditor {
  return {
    context: { ...context, route: { ...context.route }, writer: { ...context.writer } },
    kind: "project_edit",
    fields: { ...fields },
    archived: false,
    review: null,
    registration: "idle",
  };
}
const plan: LaunchPlan = {
  intention_id: identifier("launch"),
  connection,
  context: observerContext(context.route, context.writer),
  registry: "/tmp/registry",
  log: "/tmp/start.log",
  timeout_seconds: (() => {
    const value = d.decimal.decode(d.jsonString("15"));
    if (!value.ok) throw new Error("fixture");
    return value.value;
  })(),
};

describe("captured lifecycle preparation", () => {
  it.each(["workspace_edit", "workspace_archive"] as const)(
    "%s emits one actual target and retains different selected workspace audit context",
    (kind) => {
      const action: LifecycleAction =
        kind === "workspace_edit"
          ? {
              kind,
              id: "target",
              revision: "0",
              name: "Name",
              summary: "Summary",
              description: "Description",
              instructions: "Instructions",
            }
          : { kind, id: "target", revision: "0", archived: true };
      const frozen = freezeAction(context, action, identifier("intent"));
      expect(
        frozen.preparation.params.fields.filter((field) => field.name === "workspace_id"),
      ).toEqual([{ name: "workspace_id", value: d.jsonString("target") }]);
      expect(jsonField(frozen.preparation.params, "expected_revision")).toEqual(d.jsonString("0"));
      expect(frozen.preparation.context.workspace_id).toBe("selected");
      expect(stringifyJson(frozen.preparation.params).ok).toBe(true);
    },
  );
  it("registry administration omits unadmitted run while planning captures it; shutdown has explicit empty params", () => {
    const registry = freezeAction(
      context,
      { kind: "workspace_register", root: "/tmp/existing" },
      identifier("registry"),
    );
    expect(registry.preparation.params.fields.map((field) => field.name)).toEqual([
      "actor_id",
      "root",
    ]);
    expect(registry.preparation.context.writer.run_id).toBe("original-run");
    const planning = freezeAction(
      context,
      { kind: "project_create", id: "", title: "Title", description: "" },
      identifier("planning"),
    );
    expect(jsonField(planning.preparation.params, "run_id")).toEqual(d.jsonString("original-run"));
    expect(jsonField(planning.preparation.params, "project_id")).toBeUndefined();
    const stop = freezeAction(context, { kind: "daemon_stop" }, identifier("stop"));
    expect(stop.preparation.params.fields).toEqual([]);
    expect(stop.preparation.context.writer.actor_id).toBe("original");
  });
  it("date clearing, per-entity completion and evidence are explicit", () => {
    const cleared = freezeAction(
      context,
      { kind: "milestone_schedule", id: "milestone", revision: "2", date: "" },
      identifier("schedule"),
    );
    expect(cleared.preparation.method).toBe("milestone.schedule");
    expect(jsonField(cleared.preparation.params, "target_date")).toEqual({ kind: "null" });
    expect(() =>
      freezeAction(
        context,
        { kind: "milestone_schedule", id: "milestone", revision: "2", date: "2026-02-30" },
        identifier("bad"),
      ),
    ).toThrow(DraftInputError);
    const finish = freezeAction(
      context,
      {
        kind: "project_finish",
        id: "project",
        revision: "3",
        evidence: "Actual checks",
        summary: "Done",
        nextSteps: "Review",
      },
      identifier("finish"),
    );
    expect(jsonField(finish.preparation.params, "handoff")).toEqual(
      object('{"summary":"Done","next_steps":"Review"}'),
    );
    expect(() =>
      freezeAction(
        context,
        {
          kind: "project_finish",
          id: "project",
          revision: "3",
          evidence: " ",
          summary: "Done",
          nextSteps: "Review",
        },
        identifier("blank"),
      ),
    ).toThrow(DraftInputError);
  });
  it("reads retain run-only selection, while observer startup never silently drops that selected run", () => {
    const selected = { ...context, writer: { actorId: null, runId: "run-only" } };
    expect(readScope(selected).runId).toBe("run-only");
    expect(() => observerContext(selected.route, selected.writer)).toThrow(DraftInputError);
    expect(observerContext(context.route, { actorId: null, runId: null }).writer).toBeNull();
    expect(() =>
      freezeAction(
        { ...context, writer: { actorId: null, runId: null } },
        { kind: "daemon_stop" },
        identifier("read-only"),
      ),
    ).toThrow(DraftInputError);
  });
});

describe("application lifetime drafts", () => {
  it.each(["pending", "registered", "copy"] as const)(
    "a deferred guarded prefill cannot overwrite %s review or a newly authored copy",
    async (mode) => {
      const store = createConnectionDraftStore();
      const original = editor();
      store.editor.set(original);
      const selection = store.editor.captureSelection();
      let resolve!: (value: LifecycleEditor) => void;
      const delayed = new Promise<LifecycleEditor>((done) => {
        resolve = done;
      });
      const publication = delayed.then((value) => {
        if (selection.isCurrent()) store.editor.set(value);
      });
      const replacement: LifecycleEditor =
        mode === "copy"
          ? { ...original, fields: { ...original.fields, title: "Newly authored exact copy" } }
          : {
              ...original,
              review: freezeAction(
                original.context,
                {
                  kind: "project_create",
                  id: "reviewed",
                  title: "Original reviewed target",
                  description: "",
                },
                identifier("reviewed-intention"),
              ),
              registration: mode,
            };
      store.editor.set(replacement);
      resolve({
        ...original,
        fields: {
          ...original.fields,
          id: "late-other-entity",
          title: "Must never replace chosen draft",
        },
      });
      await publication;
      expect(store.editor.get()).toBe(replacement);
      expect(selection.isCurrent()).toBe(false);
    },
  );
  it("prefill selection fences null/create/close ABA and attempted over-budget edits", () => {
    const store = createConnectionDraftStore();
    const empty = store.editor.captureSelection();
    store.editor.set(editor());
    store.editor.set(null);
    expect(store.editor.get()).toBeNull();
    expect(empty.isCurrent()).toBe(false);
    store.editor.set(editor());
    const selected = store.editor.captureSelection();
    const before = store.editor.get();
    expect(
      store.editor.set({
        ...editor(),
        fields: { ...fields, title: "x".repeat(2 * 1024 * 1024 + 1) },
      }),
    ).toBe(false);
    expect(store.editor.get()).toBe(before);
    expect(selected.isCurrent()).toBe(false);
  });
  it("remounted consumers recover exact unsent text, original scope/writer, and one pending registration identity", () => {
    const store = createConnectionDraftStore();
    const original = editor();
    store.editor.set(original);
    const frozen = freezeAction(
      original.context,
      {
        kind: "project_edit",
        id: "target",
        revision: "1",
        title: fields.title,
        summary: fields.summary,
        description: fields.description,
        acceptance: fields.acceptance,
        priority: fields.priority,
        status: fields.status,
      },
      identifier("same-intention"),
    );
    store.editor.set({ ...original, review: frozen, registration: "pending" });
    // A second feature consumer after navigation uses the same application owner.
    const returned = store.editor.get();
    expect(returned?.fields.description).toBe("Unsent text\n雪");
    expect(returned?.context.writer.actorId).toBe("original");
    expect(returned?.context.route.workspaceId).toBe("selected");
    expect(returned?.review?.preparation.intention_id).toBe("same-intention");
    expect(returned?.registration).toBe("pending");
    store.manager.set((previous) => ({
      ...previous,
      draft: {
        id: "saved",
        label: "Pending label",
        socket: "/tmp/pending.sock",
        previous: connection,
      },
      registry: "/tmp/original-registry",
      frozen: plan,
      busy: true,
    }));
    expect(store.manager.get().draft.previous?.generation).toBe("1");
    expect(store.manager.get().frozen?.context.writer?.actor_id).toBe("original");
    expect(store.manager.get().busy).toBe(true);
  });
  it("oversized edits report ordinary visible validation and retain the previous draft", () => {
    const store = createConnectionDraftStore();
    store.editor.set(editor());
    const previous = store.editor.get();
    let changes = 0;
    const stop = store.editor.subscribe(() => {
      changes += 1;
    });
    expect(
      store.editor.set({
        ...editor(),
        fields: { ...fields, description: "x".repeat(2 * 1024 * 1024 + 1) },
      }),
    ).toBe(false);
    expect(store.editor.get()).toBe(previous);
    expect(store.editor.issue()).toContain("previous draft was preserved");
    expect(changes).toBe(1);
    stop();
    expect(
      store.manager.set((previous) => ({ ...previous, registry: "x".repeat(2 * 1024 * 1024 + 1) })),
    ).toBe(false);
    expect(store.manager.get().registry).toBe("");
    expect(store.manager.issue()).not.toBeNull();
  });
});

describe("lossless projections and native helper identity", () => {
  it("consumed fields are validated while unknown numbers and complete raw rows survive", () => {
    const data = object(
      '{"items":[{"project_id":"project","title":"A","revision":"2","archived":false,"status":"todo","future":{"exact":9007199254740993}}]}',
    );
    const result = entityPage("project", {
      response: { data, meta: object('{"budget":{"truncated":true}}') },
      pagination: object('{"stop":"server_field_omissions","complete":false}'),
    });
    expect(result.partial).toBe(true);
    const items = jsonField(data, "items");
    expect(result.rows[0]?.raw).toBe(items?.kind === "array" ? items.items[0] : null);
    const encoded = stringifyJson(result.raw);
    expect(encoded.ok && encoded.value).toContain("9007199254740993");
  });
  it("closed launch codecs reject false ownership/unknown fields and identity changes fail without retry", async () => {
    const raw = object(
      '{"plan":{"intention_id":"launch","connection":{"id":"other","generation":"1","label":"Other","socket":"/tmp/other.sock"},"context":{"workspace_id":"selected","project_id":"project","writer":{"actor_id":"original","run_id":"original-run"}},"registry":"/tmp/registry","log":"/tmp/start.log","timeout_seconds":"15"},"executable":"/tmp/workgraph","input_hash":"' +
        "a".repeat(64) +
        '","revision":"1","state":{"status":"prepared_unsent"},"diagnostic":null}',
    );
    const decoded = launchCodec.decode(raw);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("fixture");
    expect(sameLaunchPlan(plan, decoded.value.plan)).toBe(false);
    let calls = 0;
    const transport: HttpClient = {
      processing,
      request: async (request) => {
        await Promise.resolve();
        calls += 1;
        const found = request.codec.decode(raw);
        if (!found.ok)
          return {
            ok: false,
            failure: { kind: "protocol", message: "fixture", issue: found.issue },
          };
        return { ok: true, data: found.value, httpStatus: 200 };
      },
    };
    const result = await createConnectionsClient(transport).prepareLaunch(plan);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("wrong plan accepted");
    expect(result.failure.kind).toBe("protocol");
    expect(calls).toBe(1);
    expect(launchCodec.decode(object('{"extra":true}')).ok).toBe(false);
  });
});
