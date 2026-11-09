import { afterEach, describe, expect, it } from "vitest";
import { parseJsonText, jsonField } from "../../src/core/json";
import type { Codec } from "../../src/core/protocol/codec";
import * as codecs from "../../src/features/discussions/requests/codecs";
import { nativeResponses } from "./requests-native-fixtures";
function decode<T>(codec: Codec<T>, value: unknown) {
  const parsed = parseJsonText(JSON.stringify(value));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return codec.decode(parsed.value.value);
}
function mutable(key: keyof typeof nativeResponses): Record<string, unknown> {
  // Only bounded synthetic fixture data; production parsing is worker-owned.
  const value: unknown = JSON.parse(JSON.stringify(nativeResponses[key]));
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Fixture record");
  return Object.fromEntries(Object.entries(value));
}
describe("actual native Requests response contracts", () => {
  it("decodes current bodies separately from historical snapshots and original thread summary", () => {
    const current = decode(codecs.currentRequest, nativeResponses["get-resolved"]);
    const history = decode(codecs.page(codecs.request), nativeResponses.history);
    const list = decode(codecs.page(codecs.listedRequest), nativeResponses.list);
    expect(current.ok).toBe(true);
    expect(history.ok).toBe(true);
    expect(list.ok).toBe(true);
    if (!current.ok || !history.ok || !list.ok) throw new Error("Native response mismatch");
    expect(current.value.revision).toBe("7");
    expect(current.value.questionBody.body).toBe("Original immutable question?");
    expect(current.value.answerBody?.body).toBe("Original immutable answer.");
    expect(current.value.related?.currentQuestion.body).toBe("Original immutable question?");
    expect(history.value.items[0]?.revision).toBe("1");
    expect(history.value.nextOffset).toBe("1");
    expect(list.value.items[0]?.threadSummary.title).toBe("Implementation discussion");
    expect(list.value.items[0]?.deadlineUnixMs).toBe("9223372036854775807");
    expect(decode(codecs.currentRequest, nativeResponses.history.items[0]).ok).toBe(false);
  });
  it("retains pinned question and answer while current expanded question changes", () => {
    const result = decode(codecs.currentRequest, nativeResponses["get-pinned-after-edit"]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Native response mismatch");
    expect(result.value.questionBody.body).toBe("Original immutable question?");
    expect(result.value.answerBody?.body).toBe("Original immutable answer.");
    expect(result.value.related?.currentQuestion.body).toBe("Edited current question differs");
    expect(result.value.related?.currentQuestion.revision).toBe("2");
  });
  it("rejects mismatched pinned bodies, status answers and current expansions", () => {
    for (const field of ["question", "answer"] as const) {
      const changed = mutable("get-resolved");
      changed[field] = { ...nativeResponses["get-resolved"][field], comment_id: "different" };
      expect(decode(codecs.currentRequest, changed).ok).toBe(false);
    }
    const changed = mutable("get-resolved");
    changed.related = { ...nativeResponses["get-resolved"].related, request_revision: "8" };
    expect(decode(codecs.currentRequest, changed).ok).toBe(false);
  });
  it("keeps frozen delivery expansion distinct from changed current team", () => {
    const request = decode(codecs.currentRequest, nativeResponses["created-frozen-routing"]),
      team = decode(codecs.team, nativeResponses["team.get"]);
    expect(request.ok).toBe(true);
    expect(team.ok).toBe(true);
    if (!request.ok || !team.ok) throw new Error("Native response mismatch");
    expect(request.value.deliveries.map((x) => x.recipient)).toEqual([
      { kind: "actor", id: "human" },
      { kind: "run", id: "recipient-run" },
    ]);
    expect(team.value.members).toEqual([]);
    expect(decode(codecs.page(codecs.team), nativeResponses["team.list"]).ok).toBe(true);
  });
  it("decodes scoped subscriptions and preserves their explicit recipient", () => {
    const result = decode(codecs.subscription, nativeResponses["subscription.get"]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Native response mismatch");
    expect(result.value.recipient).toEqual({ kind: "actor", id: "human" });
    expect(result.value.filter.scope).toEqual({ kind: "project", id: "release" });
    expect(result.value.filter.threadId).toBe(null);
    expect(decode(codecs.page(codecs.subscription), nativeResponses["subscription.list"]).ok).toBe(
      true,
    );
  });
  it("decodes mixed inbox packets with nullable bodies and labelled current request status", () => {
    const result = decode(codecs.inbox, nativeResponses["inbox.read"]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Native response mismatch");
    expect(result.value.items[0]?.capturedBody).toBe(null);
    const request = result.value.items.find((x) => x.kind === "request_created");
    expect(request?.currentRequestStatus).toBe("resolved");
    expect(request?.sourceRevision).toBe("1");
    expect(request?.currentSourceRevision).toBe("7");
    expect(request?.capturedBody?.body).toBe("Original immutable question?");
    expect(decode(codecs.inbox, nativeResponses["inbox-after-ack"]).ok).toBe(true);
  });
  it("decodes a timeout-empty wait without inventing an advancing cursor or acknowledgement", () => {
    const result = decode(codecs.inbox, nativeResponses["inbox.wait"]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Native response mismatch");
    expect(result.value.items).toEqual([]);
    expect(result.value.after).toBe("0");
    expect(result.value.nextAfter).toBe("0");
    expect(result.value.through).toBe("0");
    expect(decode(codecs.inbox, { ...nativeResponses["inbox.wait"], next_after: "1" }).ok).toBe(
      false,
    );
  });
  it("rejects causal-body substitution and unordered or out-of-range packets", () => {
    const value = nativeResponses["inbox.read"],
      first = value.items[0],
      captured = value.items.find((x) => x.body_source !== null);
    if (first === undefined || captured === undefined || captured.body_source === null)
      throw new Error("Native fixture packet");
    expect(
      decode(codecs.inbox, {
        ...value,
        items: [{ ...captured, body_source: { ...captured.body_source, revision: "2" } }],
      }).ok,
    ).toBe(false);
    expect(decode(codecs.inbox, { ...value, items: [first, first] }).ok).toBe(false);
    expect(decode(codecs.inbox, { ...value, through: "0" }).ok).toBe(false);
  });
  it("retains unknown daemon raw fields and validates counters and int64 timestamps", () => {
    const value = { ...nativeResponses["get-resolved"], future: { exact: "preserved" } },
      result = decode(codecs.currentRequest, value);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Native fixture");
    expect(jsonField(result.value.raw, "future")?.kind).toBe("object");
    for (const deadline of ["01", "-1", "9223372036854775808"])
      expect(decode(codecs.currentRequest, { ...value, deadline_unix_ms: deadline }).ok).toBe(
        false,
      );
    expect(decode(codecs.currentRequest, { ...value, revision: "0" }).ok).toBe(false);
  });
});

import * as d from "../../src/core/protocol/decoders";
import type { HttpClient } from "../../src/core/protocol/http";
import type { Captured, Endpoint } from "../../src/features/discussions/threads/types";
import { endpoint } from "../../src/features/discussions/threads/model";
import { preparation, RequestsInputError } from "../../src/features/discussions/requests/model";
import type {
  CurrentRequest,
  RequestsDraft,
  RequestsInput,
} from "../../src/features/discussions/requests/types";
import { object as objectCodec } from "../../src/core/protocol/codec";
import { createTestProcessor } from "../core/processing-harness";
import { context, decode as required, json } from "../work/actions-fixtures";
const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});
function draft(input: RequestsInput): RequestsDraft {
  const processing = createTestProcessor();
  disposals.push(() => processing.dispose());
  const http: HttpClient = {
    request: () => {
      throw new Error("Pure fixture has no HTTP");
    },
    processing,
  };
  const ctx = { ...context(http), writer: { actorId: "fixture-author", runId: null } };
  return {
    id: required(d.identifier, "intention"),
    context: ctx,
    endpoint: endpoint(ctx),
    input,
    editRevision: 0,
    phase: { kind: "editing" },
    issue: null,
    unexpected: null,
    guards: {
      request: undefined,
      thread: undefined,
      comment: undefined,
      team: undefined,
      subscription: undefined,
      inbox: undefined,
    },
  };
}
function guard<T>(e: Endpoint, method: string, key: string, target: string, value: T): Captured<T> {
  return {
    endpoint: e,
    invocation: {
      connection_id: e.connectionId,
      generation: e.generation,
      lane: "visible",
      method,
      params: d.jsonObject([
        ["workspace_id", d.jsonString(e.workspaceId)],
        [key, d.jsonString(target)],
      ]),
    },
    response: {
      response: {
        data: d.jsonNull(),
        meta: required(objectCodec, {
          budget: {
            truncated: false,
            omitted_fields: "0",
            omitted_items: "0",
            details_complete: true,
          },
        }),
      },
      pagination: null,
    },
    value,
  };
}
function guarded(input: RequestsInput): RequestsDraft {
  const original = draft(input);
  const raw = {
    ...nativeResponses["get-resolved"],
    status: { kind: "open" },
    answer: null,
    responsibility: { kind: "unaccepted" },
    deliveries: nativeResponses["get-resolved"].deliveries.map((item) => ({
      ...item,
      acknowledged: null,
    })),
  };
  const current = required(codecs.currentRequest, raw);
  return {
    ...original,
    guards: {
      ...original.guards,
      request: guard(original.endpoint, "request.get", "request_id", current.id, current),
    },
  };
}
const fields = {
  id: "new-request",
  kind: "clarification" as const,
  recipients: [{ kind: "actor" as const, id: "human" }],
  resolverId: "fixture-author",
  priority: "2",
  deadlineUnixMs: "9223372036854775807",
  relatedIds: [],
  supersedesIds: [],
};
function field(value: RequestsDraft, name: string) {
  return jsonField(preparation(value).params, name);
}
describe("native request record invariants", () => {
  it("rejects contradictory frozen recipients/responsibility and impossible title totals", () => {
    const current = mutable("get-resolved");
    current.deliveries = [
      nativeResponses["get-resolved"].deliveries[0],
      nativeResponses["get-resolved"].deliveries[0],
    ];
    expect(decode(codecs.currentRequest, current).ok).toBe(false);
    const foreign = mutable("get-resolved");
    foreign.responsibility = {
      kind: "accepted",
      recipient: { kind: "actor", id: "foreign" },
      attribution: { actor_id: "fixture-author", run_id: null, timestamp: "2026-11-07" },
    };
    expect(decode(codecs.currentRequest, foreign).ok).toBe(false);
    const item = nativeResponses.list.items[0];
    if (item === undefined) throw new Error("list fixture");
    expect(
      decode(codecs.listedRequest, {
        ...item,
        thread_summary: { ...item.thread_summary, title_bytes: "513" },
      }).ok,
    ).toBe(false);
  });
});
describe("captured Requests action preparation", () => {
  it("prepares a question with exact original actor, int64 deadline and selected context, without hidden defaults", () => {
    const value = draft({
      method: "request.ask",
      fields,
      body: "Question",
      destination: { kind: "new", title: "Discussion", boardId: "", ticketId: "ticket" },
    });
    const prepared = preparation(value);
    expect(prepared.context).toEqual({
      workspace_id: "demo",
      project_id: "list-project",
      writer: { actor_id: "fixture-author", run_id: null },
    });
    expect(field(value, "deadline_unix_ms")).toEqual(d.jsonString("9223372036854775807"));
    expect(field(value, "run_id")).toBeUndefined();
    expect(field(value, "mutation_id")).toBeUndefined();
    expect(new Set(prepared.params.fields.map((item) => item.name)).size).toBe(
      prepared.params.fields.length,
    );
    expect(() =>
      preparation({
        ...value,
        input: {
          ...value.input,
          method: "request.ask",
          fields: { ...fields, deadlineUnixMs: "9223372036854775808" },
          body: "Q",
          destination: { kind: "new", title: "T", boardId: "", ticketId: "" },
        },
      }),
    ).toThrow(RequestsInputError);
  });
  it("distinguishes delivery acknowledgement from accepting responsibility", () => {
    for (const method of ["request.acknowledge", "request.accept"] as const) {
      const value = guarded({
        method,
        requestId: "probe-question",
        recipient: { kind: "actor", id: "human" },
      });
      const human = {
        ...value,
        context: { ...value.context, writer: { actorId: "human", runId: null } },
      };
      expect(preparation(human).method).toBe(method);
      expect(field(human, "expected_revision")).toEqual(d.jsonString("7"));
      expect(() => preparation(value)).toThrow(/original writer must match/);
    }
  });
  it("enforces original designated resolver and frozen responsibility recipients", () => {
    const value = guarded({
      method: "request.reassign",
      requestId: "probe-question",
      recipient: { kind: "run", id: "recipient-run" },
    });
    expect(field(value, "recipient")).toEqual(json({ kind: "run", id: "recipient-run" }));
    expect(() =>
      preparation({
        ...value,
        input: {
          method: "request.reassign",
          requestId: "probe-question",
          recipient: { kind: "actor", id: "stranger" },
        },
      }),
    ).toThrow(/frozen delivery/);
    expect(
      field(
        {
          ...value,
          input: { method: "request.reassign", requestId: "probe-question", recipient: null },
        },
        "recipient",
      ),
    ).toEqual(d.jsonNull());
    expect(() =>
      preparation({
        ...value,
        context: { ...value.context, writer: { actorId: "human", runId: null } },
      }),
    ).toThrow(/designated resolver/);
    expect(
      field(
        { ...value, input: { method: "request.resolve", requestId: "probe-question", body: "" } },
        "body",
      ),
    ).toBeUndefined();
    expect(
      field(
        {
          ...value,
          input: { method: "request.resolve", requestId: "probe-question", body: "Answer" },
        },
        "body",
      ),
    ).toEqual(d.jsonString("Answer"));
  });
  it("keeps metadata preserve, clear and replacement distinct", () => {
    const base = {
      method: "request.metadata" as const,
      requestId: "probe-question",
      priority: { kind: "keep" as const },
      deadlineUnixMs: { kind: "keep" as const },
      relatedIds: { kind: "keep" as const },
      supersedesIds: { kind: "keep" as const },
    };
    const value = guarded(base);
    expect(field(value, "deadline_unix_ms")).toBeUndefined();
    expect(
      field(
        {
          ...value,
          input: {
            ...base,
            deadlineUnixMs: { kind: "clear" },
            relatedIds: { kind: "value", value: [] },
          },
        },
        "deadline_unix_ms",
      ),
    ).toEqual(d.jsonNull());
    expect(
      field(
        { ...value, input: { ...base, relatedIds: { kind: "value", value: [] } } },
        "related_request_ids",
      ),
    ).toEqual(d.jsonArray([]));
  });
  it("refuses terminal, foreign endpoint and mismatched request guard association", () => {
    const value = guarded({ method: "request.cancel", requestId: "probe-question" });
    const saved = value.guards.request;
    if (saved === undefined) throw new Error("guard");
    expect(() =>
      preparation({
        ...value,
        guards: {
          ...value.guards,
          request: {
            ...saved,
            endpoint: { ...saved.endpoint, generation: required(d.positiveDecimal, "2") },
          },
        },
      }),
    ).toThrow(/original endpoint/);
    expect(() =>
      preparation({
        ...value,
        guards: {
          ...value.guards,
          request: {
            ...saved,
            invocation: {
              ...saved.invocation,
              params: d.jsonObject([
                ["workspace_id", d.jsonString("demo")],
                ["request_id", d.jsonString("other")],
              ]),
            },
          },
        },
      }),
    ).toThrow(/another request/);
    const terminal: CurrentRequest = {
      ...saved.value,
      status: { kind: "cancelled", attribution: saved.value.created },
    };
    expect(() =>
      preparation({
        ...value,
        guards: { ...value.guards, request: { ...saved, value: terminal } },
      }),
    ).toThrow(/terminal/);
  });
  it("separates actionable Inbox ack from received-message consumers and checks captured selected IDs", () => {
    const page = required(codecs.inbox, nativeResponses["inbox.read"]);
    const input = {
      method: "inbox.ack" as const,
      consumerId: page.consumerId,
      recipient: page.recipient,
      notificationIds: page.items.slice(0, 1).map((item) => item.id),
    };
    const initial = draft(input),
      value = {
        ...initial,
        context: { ...initial.context, writer: { actorId: "human", runId: null } },
        guards: {
          ...initial.guards,
          inbox: guard(initial.endpoint, "inbox.read", "consumer_id", page.consumerId, page),
        },
      };
    expect(preparation(value).method).toBe("inbox.ack");
    expect(() =>
      preparation({ ...value, input: { ...input, consumerId: "ui-received-private" } }),
    ).toThrow(/read-only/);
    expect(() =>
      preparation({ ...value, input: { ...input, notificationIds: [required(d.decimal, "999")] } }),
    ).toThrow(/captured Inbox page/);
    expect(() =>
      preparation({
        ...value,
        context: { ...value.context, writer: { actorId: "other", runId: null } },
      }),
    ).toThrow(/original writer/);
  });
  it("uses zero revision for new routing and validates immutable subscription recipients", () => {
    const team = draft({
      method: "team.put",
      existing: false,
      teamId: "routing",
      title: "Team",
      members: [
        { kind: "actor", id: "human" },
        { kind: "actor", id: "human" },
      ],
    });
    expect(field(team, "expected_revision")).toEqual(d.jsonString("0"));
    expect(field(team, "members")).toEqual(json([{ kind: "actor", id: "human" }]));
    const value = draft({
      method: "subscription.put",
      existing: false,
      subscriptionId: "sub",
      recipient: { kind: "actor", id: "fixture-author" },
      filter: { scope: null, threadId: "", kinds: [] },
      active: false,
    });
    expect(field(value, "filter")).toEqual(json({ kinds: [] }));
    expect(field(value, "active")).toEqual(d.jsonBoolean(false));
    const allKinds = draft({
      method: "subscription.put",
      existing: false,
      subscriptionId: "all-kinds",
      recipient: { kind: "actor", id: "fixture-author" },
      filter: { scope: null, threadId: "", kinds: [...codecs.notificationKinds] },
      active: true,
    });
    expect(field(allKinds, "filter")).toEqual(json({ kinds: [...codecs.notificationKinds] }));
    expect(() =>
      preparation({
        ...value,
        input: {
          method: "subscription.put",
          existing: false,
          subscriptionId: "sub",
          recipient: { kind: "actor", id: "other" },
          filter: { scope: null, threadId: "", kinds: [] },
          active: true,
        },
      }),
    ).toThrow(/original writer/);
  });
});
