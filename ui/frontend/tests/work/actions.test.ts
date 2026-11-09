import { afterEach, describe, expect, it } from "vitest";
import { jsonField } from "../../src/core/json";
import * as d from "../../src/core/protocol/decoders";
import type { Companion } from "../../src/core/protocol/client";
import type { HttpClient, HttpRequest, HttpResult } from "../../src/core/protocol/http";
import type { Operation, ReadResponse } from "../../src/core/protocol/types";
import {
  createOperationController,
  type OperationController,
} from "../../src/core/state/operations";
import { createWorkActionsController } from "../../src/features/work/actions/controller";
import { COMMANDS } from "../../src/features/work/actions/commands";
import { auxiliaryInvocation, validateAuxiliary } from "../../src/features/work/actions/auxiliary";
import { offeredAction } from "../../src/features/work/actions/intents";
import {
  ActionInputError,
  createdTicketId,
  preparation,
  scalarText,
} from "../../src/features/work/actions/model";
import type {
  FormInput,
  WorkActionsController,
  WorkCommand,
  WorkDraft,
} from "../../src/features/work/actions/types";
import { createTestProcessor } from "../core/processing-harness";
import { context, decode, draft, json, response, target, validDraft } from "./actions-fixtures";
import { object as objectCodec } from "../../src/core/protocol/codec";

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Uninitialized deferred.");
  };
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function harness(
  read: () => Promise<HttpResult<ReadResponse>> = () =>
    Promise.reject(new Error("Unexpected native read.")),
  prepare?: Companion["prepare"],
) {
  const processing = createTestProcessor();
  disposals.push(() => processing.dispose());
  const client: HttpClient = {
    processing,
    request: async <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
      const result = await read();
      if (!result.ok) return result;
      const decoded = request.codec.decode(
        d.jsonObject([
          [
            "response",
            d.jsonObject([
              ["data", result.data.response.data],
              ["meta", result.data.response.meta],
            ]),
          ],
          ["pagination", result.data.pagination ?? d.jsonNull()],
        ]),
      );
      if (!decoded.ok)
        throw new Error(`Fixture transport failed decoding ${decoded.issue.expected}`);
      return { ok: true, data: decoded.value, httpStatus: 200 };
    },
  };
  const unexpected = (): Promise<never> =>
    Promise.reject(new Error("Unexpected operation transport."));
  const companion: Companion = {
    connections: unexpected,
    read: unexpected,
    prepare: prepare ?? unexpected,
    inspect: unexpected,
    act: unexpected,
  };
  const operations = createOperationController(companion, processing);
  disposals.push(() => operations.dispose());
  const controller = createWorkActionsController({ client, operations });
  disposals.push(() => controller.dispose());
  return { client, processing, operations, controller };
}
const text = (text: string, presence: "omit" | "null" | "value" = "value"): FormInput => ({
  kind: "scalar",
  presence,
  text,
});
function changed(draft: WorkDraft, name: string, value: FormInput): WorkDraft {
  return { ...draft, inputs: { ...draft.inputs, [name]: value } };
}
function current(controller: WorkActionsController): WorkDraft {
  const value = controller.get().drafts.find((item) => item.id === controller.get().selectedId);
  if (value === undefined) throw new Error("No selected draft.");
  return value;
}

describe("closed generated Work forms", () => {
  it("offers a created-ticket identity only from the committed native mutation record", () => {
    const params = decode(objectCodec, { ticket_id: "created-one" });
    const captured = { method: "ticket.create", params };
    const committed = (data: unknown) =>
      ({ kind: "committed", response: response(data).response }) as const;
    expect(createdTicketId(captured, committed({ ticket_id: "created-one" }))).toBe("created-one");
    expect(
      createdTicketId(
        { ...captured, params: decode(objectCodec, {}) },
        committed({ ticket_id: "native-generated" }),
      ),
    ).toBe("native-generated");
    expect(createdTicketId(captured, committed({ ticket_id: "other-ticket" }))).toBeNull();
    expect(
      createdTicketId(captured, committed({ ticket: { ticket_id: "created-one" } })),
    ).toBeNull();
    expect(createdTicketId(captured, committed({ ticket_id: "invalid id" }))).toBeNull();
    expect(
      createdTicketId(
        { ...captured, method: "ticket.update" },
        committed({ ticket_id: "created-one" }),
      ),
    ).toBeNull();
    expect(createdTicketId(captured, { kind: "prepared_unsent" })).toBeNull();
    expect(
      createdTicketId(captured, {
        kind: "outcome_unknown",
        problem: { kind: "Transport", message: "Lost reply", details: undefined },
      }),
    ).toBeNull();
  });
  it("retains exact directory continuations and rejects changed revision, selectors, offset and duplicate rows", () => {
    const { client } = harness(),
      initial = draft(client, "label.put"),
      invocation = auxiliaryInvocation(initial);
    const data = {
      items: [{ label_id: "one", name: "One", revision: "2", description: "", archived: false }],
      offset: "0",
      next_offset: "1",
      remaining: "2",
    };
    const next = {
      workspace_id: "demo",
      include_archived: true,
      limit: "100",
      max_bytes: "1048576",
      offset: "1",
      at_revision: "100",
    };
    const page: ReadResponse = {
      ...response(data),
      pagination: decode(objectCodec, {
        next_request: { method: "label.list", params: next },
        retry_request: { method: "label.list", params: { ...next, offset: "0" } },
      }),
    };
    const capture = validateAuxiliary(initial, invocation, page),
      retained = { ...initial, auxiliary: { workflow: capture } };
    expect(auxiliaryInvocation(retained, "next").params).toEqual(json(next));
    expect(jsonField(auxiliaryInvocation(retained, "retry").params, "offset")).toEqual(
      d.jsonString("0"),
    );
    for (const patch of [
      { at_revision: "101" },
      { offset: "0" },
      { workspace_id: "other" },
      { include_archived: false },
      { project_id: "added" },
    ]) {
      const changedPage = {
        ...capture,
        response: {
          ...page,
          pagination: decode(objectCodec, {
            next_request: { method: "label.list", params: { ...next, ...patch } },
          }),
        },
      };
      expect(() =>
        auxiliaryInvocation({ ...initial, auxiliary: { workflow: changedPage } }, "next"),
      ).toThrow(ActionInputError);
    }
    expect(() =>
      validateAuxiliary(
        initial,
        invocation,
        response({ ...data, items: [data.items[0], data.items[0]], next_offset: "2" }),
      ),
    ).toThrow(/Duplicate/u);
    expect(() =>
      validateAuxiliary(initial, invocation, response({ ...data, offset: "1", next_offset: "2" })),
    ).toThrow(/another offset/u);
  });
  it("does not accept another related ticket, planning capture or incomplete amendment as a loaded guard", () => {
    const { client } = harness(),
      related = validDraft(client, "related.add"),
      invocation = auxiliaryInvocation(related);
    expect(() =>
      validateAuxiliary(
        related,
        invocation,
        response({ ticket: { ticket_id: "wrong", revision: "2" } }),
      ),
    ).toThrow(/identity/u);
    expect(() =>
      validateAuxiliary(
        related,
        invocation,
        response({ ticket: { ticket_id: "other", revision: "2" } }, "101"),
      ),
    ).toThrow(/planning capture/u);
    const amendment = validDraft(client, "ticket.amendment.withdraw"),
      request = auxiliaryInvocation(amendment);
    expect(() =>
      validateAuxiliary(
        amendment,
        request,
        response({
          reference: { amendment_id: "amendment-id" },
          item: null,
          needs_larger_budget: true,
        }),
      ),
    ).toThrow(ActionInputError);
  });
  it("a completed reference load never overwrites edited fields; explicit fill does, with a fresh capture identity", async () => {
    const { client, controller } = harness(() =>
        Promise.resolve({
          ok: true,
          data: response({
            ticket_id: "target",
            policy: null,
            effective: { descendant_prerequisites: "inherit", child_completion: "all_done" },
          }),
          httpStatus: 200,
        }),
      ),
      id = controller.open(context(client), "ticket.hierarchy.put", target(client));
    if (id === null) throw new Error("Open failed");
    controller.edit(id, "reason", text("Keep this reviewed reason"));
    await controller.load(id);
    const first = current(controller).auxiliary.policy?.id;
    expect(scalarText(current(controller), "descendant_prerequisites")).toBe("independent");
    controller.fill(id);
    expect(scalarText(current(controller), "descendant_prerequisites")).toBe("inherit");
    expect(scalarText(current(controller), "reason")).toBe("Keep this reviewed reason");
    await controller.load(id);
    expect(current(controller).auxiliary.policy?.id).not.toBe(first);
  });
  it("applies per-editor and aggregate byte bounds at allocation/edit without losing previous drafts", () => {
    const { client, controller } = harness(),
      content = "x".repeat(3300000);
    for (let index = 0; index < 5; index++) {
      const id = controller.open(context(client), "ticket.metadata", target(client));
      if (id === null) throw new Error("Open failed");
      controller.edit(id, "label_ids", text(content));
      expect(scalarText(current(controller), "label_ids")).toBe(content);
    }
    const id = controller.open(context(client), "ticket.metadata", target(client));
    if (id === null) throw new Error("Open failed");
    controller.edit(id, "label_ids", text(content));
    expect(current(controller).issue).toMatch(/aggregate/u);
    expect(scalarText(current(controller), "label_ids")).toBe("");
    controller.edit(id, "label_ids", text("雪".repeat(1400000)));
    expect(current(controller).issue).toMatch(/4 MiB/u);
    expect(controller.get().drafts).toHaveLength(6);
  });
  it("never maps computed Ready intent to an ownership claim", () => {
    const { client } = harness(),
      ticket = target(client).ticket.value.ticket;
    expect(offeredAction({ kind: "readiness", target: "ready" }, ticket)).toEqual({
      kind: "checks",
      tab: "admission",
      label: "Review readiness checks",
    });
    expect(
      offeredAction(
        { kind: "readiness", target: "ready" },
        {
          ...ticket,
          hold: { actor_id: ticket.ticket_id, reason: "Explicit hold", timestamp: "synthetic" },
        },
      ),
    ).toEqual({
      kind: "action",
      method: "ticket.hold",
      label: "Review lifting hold",
      holdReason: "clear",
    });
    expect(offeredAction({ kind: "readiness", target: "blocked" }, ticket)).toMatchObject({
      kind: "action",
      method: "ticket.hold",
      holdReason: "set",
    });
  });
  it("encodes native booleans as booleans rather than enum strings", () => {
    const { client } = harness();
    for (const [method, key] of [
      ["ticket.archive", "archived"],
      ["ticket.amendment.publish", "require_ack"],
      ["ticket.paths.put", "require_reservations"],
    ] as const)
      expect(jsonField(preparation(validDraft(client, method)).params, key)?.kind).toBe("boolean");
  });
  it("builds every command with populated optional fields and preserves typed pins/path/supersedes/label replacement", () => {
    const { client } = harness();
    expect(COMMANDS).toHaveLength(25);
    expect(new Set(COMMANDS.map((item) => item.method)).size).toBe(25);
    for (const definition of COMMANDS) {
      const source = validDraft(client, definition.method),
        result = preparation(source);
      expect(result.method).toBe(definition.method);
      expect(result.params.fields.some((field) => field.name.startsWith("_"))).toBe(false);
      expect(result.context.project_id).toBe(
        definition.target === "ticket"
          ? "actual-project"
          : definition.target === "new"
            ? "list-project"
            : null,
      );
      expect(jsonField(result.params, "workspace_id")).toEqual(d.jsonString("demo"));
      expect(jsonField(result.params, "actor_id")).toEqual(d.jsonString("author"));
    }
    expect(
      jsonField(preparation(validDraft(client, "ticket.metadata")).params, "label_ids"),
    ).toEqual(d.jsonArray([d.jsonString("label-one"), d.jsonString("label-two")]));
    const recovery = jsonField(
      preparation(validDraft(client, "ticket.recover")).params,
      "evidence",
    );
    expect(recovery?.kind === "array" ? recovery.items.length : 0).toBe(8);
    expect(
      jsonField(preparation(validDraft(client, "ticket.amendment.withdraw")).params, "ticket_id"),
    ).toBeUndefined();
  });
  it("uses the selected cross-project ticket and available native guards, never the list project", () => {
    const { client } = harness();
    const capture = preparation(validDraft(client, "related.add"));
    expect(capture.context.project_id).toBe("actual-project");
    expect(jsonField(capture.params, "ticket_id")).toEqual(d.jsonString("target"));
    expect(jsonField(capture.params, "expected_revision")).toEqual(
      d.jsonString("9007199254740993"),
    );
    expect(jsonField(capture.params, "related_expected_revision")).toEqual(d.jsonString("17"));
    expect(jsonField(capture.params, "expected_membership_revision")).toBeUndefined();
    expect(validDraft(client, "related.add").capture.ticket?.value.ticket.membership_revision).toBe(
      "9007199254740992",
    );
    for (const method of ["dependency.add", "dependency.remove"] as const)
      expect(
        jsonField(preparation(validDraft(client, method)).params, "expected_revision"),
      ).toBeUndefined();
  });
  it("preserves omitted patches, explicit null and exact source strings", () => {
    const { client } = harness();
    const initial = draft(client, "ticket.metadata"),
      omitted = preparation(initial);
    expect(jsonField(omitted.params, "assignee_id")).toBeUndefined();
    expect(jsonField(omitted.params, "label_ids")).toBeUndefined();
    const clear = preparation(changed(initial, "assignee_id", text("ignored", "null")));
    expect(jsonField(clear.params, "assignee_id")).toEqual(d.jsonNull());
    const labels = preparation(changed(initial, "label_ids", text("")));
    expect(jsonField(labels.params, "label_ids")).toEqual(d.jsonArray([]));
    const body = "  ## New instructions\n\n雪\n";
    expect(
      jsonField(
        preparation(changed(draft(client, "ticket.update"), "description", text(body))).params,
        "description",
      ),
    ).toEqual(d.jsonString(body));
  });
  it("supports text and exact resource amendment sources without leaking form-only fields", () => {
    const { client } = harness();
    let source = validDraft(client, "ticket.amendment.publish");
    source = changed(source, "source_kind", text("resource"));
    const result = preparation(source),
      body = jsonField(result.params, "source");
    expect(body?.kind).toBe("object");
    if (body?.kind !== "object") throw new Error("Missing source");
    expect(jsonField(body, "kind")).toEqual(d.jsonString("resource"));
    for (const key of [
      "source_kind",
      "source_body",
      "resource_id",
      "resource_revision",
      "resource_digest",
    ])
      expect(jsonField(result.params, key)).toBeUndefined();
  });
  it("rejects wrong owner/run, unconfirmed recovery and claimed instruction edits without inferring expiry", () => {
    const { client } = harness();
    const source = validDraft(client, "ticket.release");
    expect(() =>
      preparation({
        ...source,
        capture: {
          ...source.capture,
          writer: { actorId: source.capture.writer.actorId, runId: null },
        },
      }),
    ).toThrow(/exact captured claim owner/u);
    expect(() =>
      preparation(changed(validDraft(client, "ticket.recover"), "confirmed", text("no"))),
    ).toThrow(/actually been stopped or isolated/u);
    expect(() => preparation(draft(client, "ticket.update", true))).toThrow(
      /instruction amendment/u,
    );
    expect(() => preparation(validDraft(client, "ticket.recover"))).not.toThrow();
  });
  it("does not invent zero revisions from missing auxiliary records or failed reads", () => {
    const { client } = harness();
    const source = changed(
      validDraft(client, "ticket.paths.put"),
      "_revision_source",
      text("loaded"),
    );
    expect(() => preparation({ ...source, auxiliary: {} })).toThrow(/Load the actual/u);
    expect(
      jsonField(
        preparation(changed(source, "_revision_source", text("new"))).params,
        "expected_revision",
      ),
    ).toEqual(d.jsonString("0"));
    expect(() =>
      preparation({ ...validDraft(client, "ticket.amendment.acknowledge"), auxiliary: {} }),
    ).toThrow(/Load the actual/u);
  });
  it("rejects stale related identities and malformed structured collection input", () => {
    const { client } = harness();
    expect(() =>
      preparation(changed(validDraft(client, "related.add"), "related_id", text("different"))),
    ).toThrow(/changed after/u);
    for (const path of ["../escape", "/absolute", "src/*", "src\\escape"]) {
      const source = changed(validDraft(client, "ticket.paths.put"), "declarations", {
        kind: "paths",
        rows: [{ worktreeId: "tree", kind: "file", path, mode: "exclusive" }],
      });
      expect(() => preparation(source)).toThrow(ActionInputError);
    }
    expect(() =>
      preparation(changed(validDraft(client, "ticket.metadata"), "label_ids", text("one\none"))),
    ).toThrow(/distinct label/u);
  });
});

describe("launch-owned Work editors and admission", () => {
  it("rejects an over-budget full request while retaining the only draft for repair or explicit discard", async () => {
    const { client, controller, operations } = harness(),
      id = controller.open(context(client), "ticket.metadata", target(client));
    if (id === null) throw new Error("Open failed");
    // Input fits 4MiB, but JSON quotes/commas and the full request envelope exceed it.
    const labels = Array.from({ length: 44000 }, (_, index) =>
      `label-${index}`.padEnd(94, "x"),
    ).join("\n");
    controller.edit(id, "label_ids", text(labels));
    expect(scalarText(current(controller), "label_ids")).toBe(labels);
    await controller.prepare(id);
    expect(current(controller).phase.kind).toBe("editing");
    expect(current(controller).issue).toMatch(/byte|MiB|budget|limit/iu);
    expect(operations.get(id)).toBeUndefined();
    expect(scalarText(current(controller), "label_ids")).toBe(labels);
    controller.edit(id, "label_ids", text("repaired-label"));
    await controller.prepare(id);
    expect(current(controller).phase.kind).toBe("captured");
    expect(operations.get(id)).toBeDefined();
    controller.close(id);
    expect(controller.get().drafts).toHaveLength(0);
    expect(operations.get(id)).toBeDefined();
    const other = controller.open(context(client), "ticket.metadata", target(client));
    if (other === null) throw new Error("Open failed");
    controller.edit(other, "label_ids", text(labels));
    await controller.prepare(other);
    controller.close(other);
    expect(operations.get(other)).toBeUndefined();
    expect(controller.get().drafts).toHaveLength(0);
  });
  it("retains unsent input and immutable writer/target across view context changes", () => {
    const { client, controller } = harness(),
      ctx = context(client),
      id = controller.open(ctx, "ticket.update", target(client));
    if (id === null) throw new Error("Open failed");
    controller.edit(id, "title", text("Unsent draft"));
    controller.select(null);
    controller.select(id);
    expect(scalarText(current(controller), "title")).toBe("Unsent draft");
    expect(current(controller).capture.projectId).toBe("actual-project");
    expect(current(controller).capture.writer.runId).toBe("run-one");
    expect(
      controller.open({ ...ctx, profileState: "unavailable" }, "ticket.create", null),
    ).toBeNull();
    expect(current(controller).capture.writer.actorId).toBe("author");
    expect(scalarText(current(controller), "title")).toBe("Unsent draft");
    expect(
      controller.open(
        {
          ...ctx,
          connection: {
            ...ctx.connection,
            generation: draft(client, "ticket.create").capture.connection.generation,
            id: validDraft(client, "ticket.create").id,
          },
        },
        "ticket.update",
        target(client),
      ),
    ).toBeNull();
  });
  it("ignores a late auxiliary reply after editing, preparation or close", async () => {
    const gate = deferred<HttpResult<ReadResponse>>(),
      { client, controller, operations } = harness(() => gate.promise),
      id = controller.open(context(client), "ticket.hierarchy.put", target(client));
    if (id === null) throw new Error("Open failed");
    const loading = controller.load(id);
    controller.edit(id, "reason", text("Keep this exact new reason"));
    await controller.prepare(id);
    expect(current(controller).issue).toMatch(/Load the actual/u);
    controller.close(id);
    gate.resolve({
      ok: true,
      data: response({
        ticket_id: "target",
        policy: null,
        effective: { descendant_prerequisites: "inherit", child_completion: "all_done" },
      }),
      httpStatus: 200,
    });
    await loading;
    expect(controller.get().drafts).toHaveLength(0);
    expect(operations.list()).toHaveLength(0);
  });
  it("locks capture while async admission settles and local rejection returns to repairable editing", async () => {
    const h = harness(),
      gate = deferred<void>();
    const operations: OperationController = {
        ...h.operations,
        register: async (value) => {
          await gate.promise;
          return h.operations.register(value);
        },
      },
      controller = createWorkActionsController({ client: h.client, operations });
    disposals.push(() => controller.dispose());
    const id = controller.open(context(h.client), "ticket.update", target(h.client));
    if (id === null) throw new Error("Open failed");
    controller.edit(id, "title", text("Exact before await"));
    const pending = controller.prepare(id);
    expect(current(controller).phase.kind).toBe("capturing");
    controller.edit(id, "title", text("Late edit"));
    controller.close(id);
    expect(controller.get().drafts).toHaveLength(1);
    gate.resolve();
    await pending;
    expect(current(controller).phase.kind).toBe("captured");
    expect(
      jsonField(h.operations.get(id)?.preparation.params ?? d.jsonObject([]), "title"),
    ).toEqual(d.jsonString("Exact before await"));
    controller.fill(id);
    expect(current(controller).phase.kind).toBe("captured");
  });
  it("one Review freezes the original actor/target, coalesces clicks and never executes or retries an unconfirmed prepare", async () => {
    const gate = deferred<HttpResult<Operation>>();
    let calls = 0;
    const h = harness(undefined, async (captured) => {
      calls++;
      expect(captured.context.writer.actor_id).toBe("author");
      expect(captured.context.project_id).toBe("actual-project");
      expect(jsonField(captured.params, "title")).toEqual(d.jsonString("Reviewed once"));
      return gate.promise;
    });
    const id = h.controller.open(context(h.client), "ticket.update", target(h.client));
    if (id === null) throw new Error("Open failed");
    h.controller.edit(id, "title", text("Reviewed once"));
    const pending = h.controller.review(id);
    await h.controller.review(id);
    h.controller.edit(id, "title", text("Too late"));
    await expect.poll(() => calls).toBe(1);
    gate.resolve({ ok: false, failure: { kind: "network", message: "Preparation reply lost" } });
    await pending;
    expect(h.operations.get(id)?.phase.kind).toBe("unconfirmed");
    expect(current(h.controller).phase.kind).toBe("captured");
    expect(current(h.controller).issue).toMatch(/Preparation reply lost/u);
    await h.controller.review(id);
    expect(calls).toBe(1);
    expect(h.operations.get(id)?.operation).toBeNull();
  });
  it("a deferred failed admission retains the exact local intention without preparing or retrying it", async () => {
    const h = harness(),
      gate = deferred<void>();
    let prepares = 0;
    const operations: OperationController = {
      ...h.operations,
      register: async (value) => {
        await gate.promise;
        await h.operations.register(value);
        return {
          ok: false,
          failure: { kind: "network", message: "Local admission acknowledgement unavailable" },
        };
      },
      act: () => {
        prepares++;
        return Promise.reject(new Error("Failed admission cannot prepare"));
      },
    };
    const controller = createWorkActionsController({ client: h.client, operations });
    disposals.push(() => controller.dispose());
    const id = controller.open(context(h.client), "ticket.update", target(h.client));
    if (id === null) throw new Error("Open failed");
    controller.edit(id, "title", text("Exact retained admission"));
    const pending = controller.review(id);
    await controller.review(id);
    gate.resolve();
    await pending;
    await controller.review(id);
    expect(prepares).toBe(0);
    expect(h.operations.get(id)?.phase.kind).toBe("draft");
    expect(jsonField(h.operations.get(id)!.preparation.params, "title")).toEqual(
      d.jsonString("Exact retained admission"),
    );
    expect(current(controller).phase.kind).toBe("captured");
    expect(current(controller).issue).toMatch(/admission acknowledgement/u);
  });
  it("disposal or deliberate close after local capture prevents a late Review from preparing a hidden removed draft", async () => {
    for (const ending of ["dispose", "close"] as const) {
      const h = harness(),
        gate = deferred<void>();
      let prepares = 0;
      const operations: OperationController = {
        ...h.operations,
        register: async (value) => {
          await gate.promise;
          return h.operations.register(value);
        },
        act: () => {
          prepares++;
          return Promise.reject(new Error("Obsolete Review must not prepare"));
        },
      };
      const controller = createWorkActionsController({ client: h.client, operations });
      disposals.push(() => controller.dispose());
      const id = controller.open(context(h.client), "ticket.update", target(h.client));
      if (id === null) throw new Error("Open failed");
      controller.edit(id, "title", text("Retained capture"));
      let off: () => void = () => undefined;
      if (ending === "close")
        off = controller.subscribe(() => {
          if (
            controller
              .get()
              .drafts.some((draft) => draft.id === id && draft.phase.kind === "captured")
          ) {
            off();
            controller.close(id);
          }
        });
      const pending = controller.review(id);
      if (ending === "dispose") controller.dispose();
      gate.resolve();
      await pending;
      off();
      expect(prepares).toBe(0);
      expect(h.operations.get(id)?.phase.kind).toBe("draft");
      if (ending === "close") expect(controller.get().drafts).toHaveLength(0);
    }
  });
  it("allows more than 32 sequential captured actions while retaining every saved identity", async () => {
    const { client, controller, operations } = harness();
    for (let serial = 0; serial < 35; serial++) {
      const id = controller.open(context(client), "ticket.archive", target(client));
      if (id === null) throw new Error("Open failed");
      await controller.prepare(id);
      expect(current(controller).phase.kind).toBe("captured");
      controller.close(id);
    }
    expect(controller.get().drafts).toHaveLength(0);
    expect(operations.list()).toHaveLength(35);
    expect(new Set(operations.list().map((item) => item.preparation.intention_id)).size).toBe(35);
  });
  it("preserves expected remote failures and unexpected exceptions separately", async () => {
    const failure = harness(() =>
        Promise.resolve({
          ok: false,
          failure: { kind: "network", message: "offline" },
        }),
      ),
      id = failure.controller.open(
        context(failure.client),
        "ticket.hierarchy.put",
        target(failure.client),
      );
    if (id === null) throw new Error("Open failed");
    await failure.controller.load(id);
    expect(current(failure.controller).issue).toMatch(/offline/u);
    expect(current(failure.controller).auxiliary).toEqual({});
    const error = new Error("worker implementation failure"),
      unexpected = harness(() => Promise.reject(error)),
      other = unexpected.controller.open(
        context(unexpected.client),
        "ticket.hierarchy.put",
        target(unexpected.client),
      );
    if (other === null) throw new Error("Open failed");
    await unexpected.controller.load(other);
    expect(current(unexpected.controller).unexpected?.error).toBe(error);
  });
  it.each(["ticket.create", "ticket.update", "ticket.metadata", "ticket.move"] as const)(
    "keeps full typed %s input on schema or local admission failure",
    async (method: WorkCommand) => {
      const { client, controller } = harness(),
        id = controller.open(
          context(client),
          method,
          method === "ticket.create" ? null : target(client),
        );
      if (id === null) throw new Error("Open failed");
      const field =
        method === "ticket.metadata"
          ? "assignee_id"
          : method === "ticket.move"
            ? "project_id"
            : "title";
      controller.edit(id, field, text("invalid value ".repeat(1000)));
      await controller.prepare(id);
      expect(current(controller).phase.kind).toBe("editing");
      expect(current(controller).issue).not.toBeNull();
      expect(scalarText(current(controller), field)).toBe("invalid value ".repeat(1000));
      controller.edit(id, field, text(method === "ticket.move" ? "fixed-project" : "Fixed"));
      await controller.prepare(id);
      expect(current(controller).phase.kind).toBe("captured");
    },
  );
});
