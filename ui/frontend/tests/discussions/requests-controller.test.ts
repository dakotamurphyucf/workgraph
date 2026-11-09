import { afterEach, describe, expect, it } from "vitest";
import * as c from "../../src/core/protocol/codec";
import * as d from "../../src/core/protocol/decoders";
import { jsonField } from "../../src/core/json";
import type { HttpClient, HttpRequest, HttpResult } from "../../src/core/protocol/http";
import type { ReadResponse } from "../../src/core/protocol/types";
import { createOperationController } from "../../src/core/state/operations";
import {
  continued,
  invocation,
  locate,
  validate,
} from "../../src/features/discussions/requests/client";
import {
  createRequestsController,
  retainedInbox,
} from "../../src/features/discussions/requests/controller";
import { endpoint } from "../../src/features/discussions/threads/model";
import type { RequestsRead } from "../../src/features/discussions/requests/types";
import { createTestProcessor } from "../core/processing-harness";
import { context, decode, json } from "../work/actions-fixtures";
import { nativeResponses } from "./requests-native-fixtures";
const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});
const ok = <T>(data: T): HttpResult<T> => ({ ok: true, httpStatus: 200, data });
function response(data: unknown, revision = "400", planning = false): ReadResponse {
  return {
    response: {
      data: json(data),
      meta: decode(c.object, {
        ...(planning
          ? { workspace_revision: revision }
          : { query_scope: "communication", query_revision: revision }),
        budget: {
          truncated: false,
          omitted_fields: "0",
          omitted_items: "0",
          details_complete: true,
        },
      }),
    },
    pagination: null,
  };
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("uninitialized");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness(read?: (request: HttpRequest<unknown>) => Promise<HttpResult<ReadResponse>>) {
  const processing = createTestProcessor();
  let reads = 0,
    prepares = 0;
  const http: HttpClient = {
    processing,
    request: async <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
      reads++;
      if (read === undefined) throw new Error("Unexpected native read");
      const result = await read(request);
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
      if (!decoded.ok) throw new Error(decoded.issue.expected);
      return ok(decoded.value);
    },
  };
  const unexpected = (): Promise<never> => Promise.reject(new Error("Unexpected operation"));
  const operations = createOperationController(
    {
      connections: unexpected,
      read: unexpected,
      prepare: () => {
        prepares++;
        return Promise.resolve({
          ok: false as const,
          failure: { kind: "network" as const, message: "Observed connection failure" },
        });
      },
      inspect: unexpected,
      act: unexpected,
    },
    processing,
  );
  const controller = createRequestsController({ http, operations });
  const selection = { ...context(http), writer: { actorId: "fixture-author", runId: null } };
  controller.open(selection);
  disposals.push(
    () => controller.dispose(),
    () => operations.dispose(),
    () => processing.dispose(),
  );
  return { controller, selection, http, operations, counts: () => ({ reads, prepares }) };
}
function current(h: ReturnType<typeof harness>) {
  const value = h.controller
    .get()
    .drafts.find((draft) => draft.id === h.controller.get().selectedDraftId);
  if (value === undefined) throw new Error("Missing draft");
  return value;
}
function openRequest() {
  return {
    ...nativeResponses["get-resolved"],
    status: { kind: "open" },
    answer: null,
    responsibility: { kind: "unaccepted" },
    deliveries: nativeResponses["get-resolved"].deliveries.map((item) => ({
      ...item,
      acknowledged: null,
    })),
  };
}
describe("Requests native reads and retained ownership", () => {
  it("feeds actual native current/history/nullable routing/inbox responses through production adapters", () => {
    const h = harness(),
      e = endpoint(h.selection);
    const cases: readonly [RequestsRead, unknown][] = [
      [
        { kind: "request", requestId: decode(d.identifier, "probe-question") },
        nativeResponses["get-resolved"],
      ],
      [
        {
          kind: "history",
          requestId: decode(d.identifier, "probe-question"),
          selectedRevision: decode(d.positiveDecimal, "7"),
        },
        nativeResponses.history,
      ],
      [{ kind: "teams" }, nativeResponses["team.list"]],
      [
        { kind: "subscriptions", recipient: { kind: "actor", id: "human" } },
        nativeResponses["subscription.list"],
      ],
      [
        {
          kind: "inbox",
          wait: true,
          filter: {
            consumerId: "probe-wait",
            recipient: { kind: "actor", id: "human" },
            after: "0",
            through: "0",
            kinds: [],
            ticketId: "",
            excludeSelf: false,
          },
        },
        nativeResponses["inbox.wait"],
      ],
    ];
    for (const [selector, data] of cases) {
      const request = invocation(e, selector);
      const value =
        selector.kind === "inbox" ? { ...(data as object), consumer_id: "probe-wait" } : data;
      const result = validate(e, selector, request, response(value));
      expect(result.ok).toBe(true);
    }
  });
  it("does not send selected entity revision as request.history query capture", () => {
    const h = harness(),
      selector: RequestsRead = {
        kind: "history",
        requestId: decode(d.identifier, "probe-question"),
        selectedRevision: decode(d.positiveDecimal, "7"),
      };
    expect(
      jsonField(invocation(endpoint(h.selection), selector).params, "revision"),
    ).toBeUndefined();
  });
  it("rejects changed current identities and captured query revisions", () => {
    const h = harness(),
      e = endpoint(h.selection),
      selector: RequestsRead = { kind: "request", requestId: decode(d.identifier, "different") };
    expect(
      validate(e, selector, invocation(e, selector), response(nativeResponses["get-resolved"])).ok,
    ).toBe(false);
    const team: RequestsRead = { kind: "teams" };
    const request = invocation(e, team);
    expect(
      validate(
        e,
        team,
        {
          ...request,
          params: d.jsonObject([
            ...request.params.fields.map((f) => [f.name, f.value] as [string, typeof f.value]),
            ["revision", d.jsonString("399")],
          ]),
        },
        response(nativeResponses["team.list"]),
      ).ok,
    ).toBe(false);
  });
  it("checks exact native continuation capture and fixed filters before using it", async () => {
    const h = harness(),
      e = endpoint(h.selection),
      selector: RequestsRead = {
        kind: "history",
        requestId: decode(d.identifier, "probe-question"),
        selectedRevision: null,
      },
      request = invocation(e, selector);
    const params = d.jsonObject(
      request.params.fields
        .filter((f) => f.name !== "offset")
        .map((f) => [f.name, f.value] as [string, typeof f.value])
        .concat([
          ["offset", d.jsonString("1")],
          ["revision", d.jsonString("400")],
        ]),
    );
    const saved = d.jsonObject([
      ["method", d.jsonString("request.history")],
      ["params", params],
    ]);
    const source = response(nativeResponses.history);
    const result = validate(e, selector, request, {
      ...source,
      pagination: d.jsonObject([["next_request", saved]]),
    });
    if (!result.ok) throw new Error("fixture capture");
    expect((await continued(h.http, result.data, "next")).ok).toBe(true);
    const bad = d.jsonObject(
      params.fields.map((f) => [f.name, f.name === "request_id" ? d.jsonString("other") : f.value]),
    );
    expect(
      (
        await continued(
          h.http,
          {
            ...result.data,
            captured: {
              ...result.data.captured,
              response: {
                ...result.data.captured.response,
                pagination: d.jsonObject([
                  [
                    "next_request",
                    d.jsonObject([
                      ["method", d.jsonString("request.history")],
                      ["params", bad],
                    ]),
                  ],
                ]),
              },
            },
          },
          "next",
        )
      ).ok,
    ).toBe(false);
  });
  it("locates exact historical snapshot over native pages using separate communication capture", async () => {
    const seen: unknown[] = [];
    const h = harness((request) => {
      seen.push(request.body);
      return Promise.resolve(
        ok(
          response({
            items: [{ ...nativeResponses.history.items[0], revision: "7" }],
            offset: "1",
            remaining: "0",
            next_offset: null,
          }),
        ),
      );
    });
    const e = endpoint(h.selection),
      selector: RequestsRead = {
        kind: "history",
        requestId: decode(d.identifier, "probe-question"),
        selectedRevision: decode(d.positiveDecimal, "7"),
      },
      request = invocation(e, selector);
    const params = d.jsonObject(
      request.params.fields
        .filter((f) => f.name !== "offset")
        .map((f) => [f.name, f.value] as [string, typeof f.value])
        .concat([
          ["offset", d.jsonString("1")],
          ["revision", d.jsonString("400")],
        ]),
    );
    const initial = validate(e, selector, request, {
      ...response(nativeResponses.history),
      pagination: d.jsonObject([
        [
          "next_request",
          d.jsonObject([
            ["method", d.jsonString("request.history")],
            ["params", params],
          ]),
        ],
      ]),
    });
    if (!initial.ok) throw new Error("initial history");
    const result = await locate(h.http, initial.data, new AbortController().signal);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("located history");
    expect(
      result.data.captured.value.kind === "history" &&
        result.data.captured.value.page.items[0]?.revision,
    ).toBe("7");
    expect(jsonField(result.data.captured.invocation.params, "revision")).toEqual(
      d.jsonString("400"),
    );
    expect(seen).toHaveLength(1);
  });
  it("locates one notification across captured pages without changing recipient/consumer/through", async () => {
    const original = nativeResponses["inbox.read"],
      first = original.items[0];
    if (first === undefined) throw new Error("notification fixture");
    const h = harness(() =>
      Promise.resolve(
        ok(
          response({
            ...original,
            items: [{ ...first, notification_id: "2", sequence: "12" }],
            after: "1",
            through: "2",
            next_after: "2",
            remaining: "0",
          }),
        ),
      ),
    );
    const e = endpoint(h.selection),
      selector: RequestsRead = {
        kind: "inbox",
        wait: false,
        filter: {
          consumerId: original.consumer_id,
          recipient: { kind: "actor", id: "human" },
          after: "0",
          through: "2",
          kinds: [],
          ticketId: "",
          excludeSelf: false,
        },
      },
      request = invocation(e, selector);
    const params = d.jsonObject(
      request.params.fields.map((field) => [
        field.name,
        field.name === "after" ? d.jsonString("1") : field.value,
      ]),
    );
    const source = response({
      ...original,
      items: [{ ...first, notification_id: "1", sequence: "11" }],
      after: "0",
      through: "2",
      next_after: "1",
      remaining: "1",
    });
    const initial = validate(e, selector, request, {
      ...source,
      pagination: d.jsonObject([
        [
          "next_request",
          d.jsonObject([
            ["method", d.jsonString("inbox.read")],
            ["params", params],
          ]),
        ],
      ]),
    });
    if (!initial.ok) throw new Error("initial notification");
    const result = await locate(
      h.http,
      initial.data,
      new AbortController().signal,
      decode(d.decimal, "2"),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error("notification locate");
    const value = result.data.captured.value;
    expect(value.kind === "inbox" && value.page.items.map((item) => item.id)).toEqual(["2"]);
    expect(jsonField(result.data.captured.invocation.params, "after")).toEqual(d.jsonString("1"));
    expect(h.counts().reads).toBe(1);
  });
  it("retains original action and writer across current selection changes, coalescing Review without Execute", async () => {
    const pending = deferred<HttpResult<ReadResponse>>();
    const h = harness(() => pending.promise);
    const id = h.controller.create({
      method: "request.resolve",
      requestId: "probe-question",
      body: "Original answer",
    });
    if (id === null) throw new Error("draft");
    const a = h.controller.review(id),
      b = h.controller.review(id);
    await Promise.resolve();
    h.controller.open({
      ...h.selection,
      writer: { actorId: "human", runId: null },
      route: { ...h.selection.route, projectId: "other-project" },
    });
    h.controller.edit(id, {
      method: "request.resolve",
      requestId: "probe-question",
      body: "Replacement",
    });
    pending.resolve(ok(response(openRequest())));
    await Promise.all([a, b]);
    expect(h.counts()).toEqual({ reads: 1, prepares: 1 });
    expect(current(h).input).toEqual({
      method: "request.resolve",
      requestId: "probe-question",
      body: "Original answer",
    });
    expect(h.operations.get(id)?.preparation.context.writer.actor_id).toBe("fixture-author");
    expect(current(h).phase.kind).toBe("captured");
    expect(h.operations.get(id)?.phase.kind).toBe("unconfirmed");
    await h.controller.review(id);
    expect(h.counts()).toEqual({ reads: 1, prepares: 2 });
  });
  it("ignores a superseded guard read after editing, preserving later text and no registration", async () => {
    const pending = deferred<HttpResult<ReadResponse>>(),
      h = harness(() => pending.promise);
    const id = h.controller.create({
      method: "request.resolve",
      requestId: "probe-question",
      body: "Original",
    });
    if (id === null) throw new Error("draft");
    const loaded = h.controller.loadGuards(id);
    h.controller.edit(id, {
      method: "request.resolve",
      requestId: "probe-question",
      body: "Later",
    });
    pending.resolve(ok(response(openRequest())));
    await loaded;
    expect(current(h).input).toEqual({
      method: "request.resolve",
      requestId: "probe-question",
      body: "Later",
    });
    expect(current(h).guards.request).toBeUndefined();
    expect(h.operations.get(id)).toBeUndefined();
  });
  it("retains project list scope and saved draft independently of Back/Forward and actor selection", () => {
    const h = harness();
    const id = h.controller.create({
      method: "team.put",
      existing: false,
      teamId: "team",
      title: "Original",
      members: [],
    });
    expect(h.controller.get().filter.scope).toEqual({ kind: "project", id: "list-project" });
    h.controller.open({ ...h.selection, route: { ...h.selection.route, projectId: "second" } });
    expect(h.controller.get().filter.scope).toEqual({ kind: "project", id: "second" });
    h.controller.open(h.selection);
    expect(h.controller.get().filter.scope).toEqual({ kind: "project", id: "list-project" });
    expect(h.controller.get().drafts[0]?.id).toBe(id);
  });
  it("keeps request collection filters across detail navigation and resets them for a new project", () => {
    const h = harness();
    const e = endpoint(h.selection);
    h.controller.open(h.selection, { ...e, kind: "requests" });
    const filter = { ...h.controller.get().filter, openOnly: true, resolverId: "reviewer" };
    h.controller.filter(filter);
    h.controller.open(h.selection, {
      ...e,
      kind: "request",
      requestId: decode(d.identifier, "question"),
      revision: null,
    });
    expect(h.controller.get().filter).toEqual(filter);
    h.controller.open(h.selection, { ...e, kind: "requests" });
    expect(h.controller.get().filter).toEqual(filter);
    h.controller.open(
      { ...h.selection, route: { ...h.selection.route, projectId: "other" } },
      { ...e, kind: "request", requestId: decode(d.identifier, "question"), revision: null },
    );
    expect(h.controller.get().filter.scope).toEqual({ kind: "project", id: "other" });
    expect(h.controller.get().filter.resolverId).toBe("");
  });
  it("defaults fresh Inbox entries to the UI actor, preserves overrides while open, and resets on reentry", () => {
    const h = harness();
    const target = { ...endpoint(h.selection), kind: "inbox" as const, capture: null };
    const selected = { ...h.selection, writer: { actorId: "reader", runId: "reader-run" } };
    h.controller.open(selected, target, true);
    expect(h.controller.get().inboxFilter.recipient).toEqual({ kind: "actor", id: "reader" });
    const consumer = h.controller.get().inboxFilter.consumerId;
    const manual = {
      ...h.controller.get().inboxFilter,
      recipient: { kind: "actor" as const, id: "other" },
      after: "12",
      through: "20",
    };
    h.controller.inboxFilter(manual);
    h.controller.open(h.selection, target);
    expect(h.controller.get().inboxFilter).toEqual(manual);
    h.controller.open(h.selection, target, true);
    expect(h.controller.get().inboxFilter).toMatchObject({
      consumerId: consumer,
      recipient: { kind: "actor", id: "fixture-author" },
      after: "0",
      through: "",
    });
    h.controller.open(h.selection, { ...endpoint(h.selection), kind: "routing", entity: null });
    h.controller.open(selected, target);
    expect(h.controller.get().inboxFilter.recipient.id).toBe("reader");
    h.controller.open({ ...selected, writer: { actorId: null, runId: null } }, target, true);
    expect(h.controller.get().inboxFilter.recipient.id).toBe("");
    expect(h.counts()).toEqual({ reads: 0, prepares: 0 });
  });
  it("omits native Inbox kinds for the editor's all-kinds selection", () => {
    const h = harness();
    const e = endpoint(h.selection);
    const filter = {
      ...h.controller.get().inboxFilter,
      consumerId: "reader",
      recipient: { kind: "actor" as const, id: "human" },
    };
    const all = invocation(e, { kind: "inbox", filter, wait: false });
    expect(jsonField(all.params, "kinds")).toBeUndefined();
    const specific = invocation(e, {
      kind: "inbox",
      filter: { ...filter, kinds: ["request_updated"] },
      wait: true,
    });
    expect(jsonField(specific.params, "kinds")).toEqual(json(["request_updated"]));
  });
  it("normalizes retained Inbox selector identity and refuses current recipient substitution", async () => {
    const h = harness(() =>
      Promise.resolve(
        ok(response({ ...nativeResponses["inbox.wait"], consumer_id: "ui-inbox-original" })),
      ),
    );
    const e = endpoint(h.selection),
      capture = {
        consumerId: "ui-inbox-original",
        recipient: { kind: "actor" as const, id: "human" },
        after: "0",
        through: "0",
        kinds: [],
        ticketId: "",
        excludeSelf: false,
        notificationId: null,
      };
    h.controller.open(h.selection, { ...e, kind: "inbox", capture }, true);
    expect(h.controller.get().inboxFilter).toEqual(retainedInbox(capture));
    await h.controller.read({ kind: "inbox", filter: retainedInbox(capture), wait: false });
    expect(h.counts().reads).toBe(1);
    await h.controller.read({
      kind: "inbox",
      filter: { ...retainedInbox(capture), recipient: { kind: "actor", id: "fixture-author" } },
      wait: false,
    });
    expect(h.counts().reads).toBe(1);
    expect(h.controller.get().reads.get("inbox")?.kind).toBe("failed");
  });
  it("refreshes retained-generation provenance without discarding the captured read or draft", () => {
    const h = harness();
    const target = {
      ...endpoint(h.selection),
      kind: "request" as const,
      requestId: decode(d.identifier, "probe-question"),
      revision: null,
    };
    h.controller.open(h.selection, target);
    expect(h.controller.get().historicalGeneration).toBe(false);
    const created = h.controller.create({ method: "request.cancel", requestId: "probe-question" });
    expect(created).not.toBeNull();
    const retained = h.controller.get();
    const changed = {
      ...h.selection,
      connection: { ...h.selection.connection, generation: decode(d.positiveDecimal, "2") },
    };
    h.controller.open(changed, target);
    expect(h.controller.get().historicalGeneration).toBe(true);
    expect(h.controller.get().reads).toBe(retained.reads);
    expect(h.controller.get().drafts).toBe(retained.drafts);
    expect(
      h.controller.create({ method: "request.cancel", requestId: "probe-question" }),
    ).toBeNull();
    expect(h.controller.get().issue).toMatch(/retained endpoint/);
    h.controller.open(h.selection, target);
    expect(h.controller.get().historicalGeneration).toBe(false);
  });

  it("keeps historical request links read-only until explicit current selection", () => {
    const h = harness(),
      e = endpoint(h.selection);
    h.controller.open(h.selection, {
      ...e,
      kind: "request",
      requestId: decode(d.identifier, "probe-question"),
      revision: decode(d.positiveDecimal, "1"),
    });
    expect(
      h.controller.create({ method: "request.cancel", requestId: "probe-question" }),
    ).toBeNull();
    expect(h.controller.get().issue).toMatch(/historical/);
    h.controller.open(h.selection, {
      ...e,
      kind: "request",
      requestId: decode(d.identifier, "probe-question"),
      revision: null,
    });
    expect(
      h.controller.create({ method: "request.cancel", requestId: "probe-question" }),
    ).not.toBeNull();
  });
  it("bounds retained input, preserving the previous draft on oversized edits", () => {
    const h = harness();
    const id = h.controller.create({
      method: "request.resolve",
      requestId: "probe-question",
      body: "Original",
    });
    if (id === null) throw new Error("draft");
    h.controller.edit(id, {
      method: "request.resolve",
      requestId: "probe-question",
      body: "x".repeat(2 * 1024 * 1024),
    });
    expect(current(h).input).toEqual({
      method: "request.resolve",
      requestId: "probe-question",
      body: "Original",
    });
    expect(current(h).issue).toMatch(/budget/);
  });
});

it("keeps the request collection and filters when selecting questions without retaining old detail", async () => {
  const h = harness(() =>
    Promise.resolve(ok(response({ items: [], offset: "0", remaining: "0", next_offset: null }))),
  );
  const e = endpoint(h.selection);
  h.controller.open(h.selection, { ...e, kind: "requests" });
  const filter = { ...h.controller.get().filter, resolverId: "reviewer" };
  h.controller.filter(filter);
  await h.controller.read({ kind: "requests", filter });
  expect(h.controller.get().reads.get("requests")?.kind).toBe("ready");
  const before = h.controller.get().reads.get("requests");
  h.controller.open(h.selection, {
    ...e,
    kind: "request",
    requestId: decode(d.identifier, "one"),
    revision: null,
  });
  expect(h.controller.get().reads.get("requests")).toBe(before);
  expect(h.controller.get().filter).toEqual(filter);
  h.controller.open(h.selection, {
    ...e,
    kind: "request",
    requestId: decode(d.identifier, "two"),
    revision: null,
  });
  expect(h.controller.get().reads.get("requests")).toBe(before);
  expect(h.controller.get().reads.has("request")).toBe(false);
  await h.controller.refreshLive(new AbortController().signal);
  expect(h.controller.get().reads.get("requests")?.kind).toBe("ready");
  h.controller.open(
    { ...h.selection, route: { ...h.selection.route, projectId: "other" } },
    { ...e, kind: "requests" },
  );
  expect(h.controller.get().reads.size).toBe(0);
  expect(h.controller.get().filter.resolverId).toBe("");
});
