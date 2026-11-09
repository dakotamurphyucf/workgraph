import { describe, expect, it } from "vitest";
import {
  planningTarget,
  canOpenPlanningScope,
  planningKey,
} from "../../../src/features/history/scope-navigation/model";
import {
  decodePlanningRecord,
  planningInvocation,
  readPlanningTarget,
} from "../../../src/features/history/scope-navigation/client";
import * as d from "../../../src/core/protocol/decoders";
import { parseJsonText, jsonField } from "../../../src/core/json";
import type { Codec } from "../../../src/core/protocol/codec";
import type { HttpClient, HttpRequest, HttpResult } from "../../../src/core/protocol/http";
import type { PlanningTarget } from "../../../src/features/history/scope-navigation/types";
import type { ReadResponse } from "../../../src/core/protocol/types";
import { createTestProcessor } from "../../core/processing-harness";
function decode<T>(codec: Codec<T>, value: unknown): T {
  const parsed = parseJsonText(JSON.stringify(value));
  if (!parsed.ok) throw new Error(parsed.error.message);
  const result = codec.decode(parsed.value.value);
  if (!result.ok) throw new Error(JSON.stringify(result.issue));
  return result.value;
}
const id = (v: string) => decode(d.identifier, v),
  decimal = (v: string) => decode(d.positiveDecimal, v);
const target: PlanningTarget = {
  connectionId: id("local"),
  workspaceId: id("demo"),
  generation: decimal("1"),
  kind: "project",
  id: id("project"),
};
const response = (data: unknown): ReadResponse =>
  decode(d.readResponse, { response: { data, meta: {} }, pagination: null });
const record = {
  project_id: "project",
  title: "Original project",
  description: "Original description",
  summary: "Summary",
  acceptance_criteria: "Exact criteria",
  revision: "3",
  archived: false,
  status: "todo",
};
const ok = <T>(data: T): HttpResult<T> => ({ ok: true, data, httpStatus: 200 });
describe("recorded planning target contract", () => {
  it("captures all four kinds without inferring ancestry or selecting an actor", () => {
    for (const kind of ["workspace", "project", "milestone", "ticket"] as const) {
      const source = {
        connectionId: target.connectionId,
        workspaceId: target.workspaceId,
        generation: target.generation,
        kind: "scope" as const,
        scope: kind === "workspace" ? { kind } : { kind, id: id("same") },
      };
      expect(canOpenPlanningScope(source)).toBe(true);
      const frozen = planningTarget(source);
      expect(Object.isFrozen(frozen)).toBe(true);
      expect(frozen.id).toBe(kind === "workspace" ? "demo" : "same");
      const request = planningInvocation(frozen);
      expect(request.method).toBe(kind === "ticket" ? "ticket.read" : `${kind}.get`);
      expect(request.generation).toBe("1");
      expect(request.params.fields.map((v) => v.name)).not.toContain("actor_id");
      if (kind !== "project")
        expect(request.params.fields.map((v) => v.name)).not.toContain("project_id");
      if (kind === "project")
        expect(request.params.fields.some((v) => v.name === "project_id")).toBe(true);
    }
  });
  it("does not advertise resource ScopeRef as an exact resource-version link", () => {
    expect(
      canOpenPlanningScope({
        ...target,
        kind: "scope",
        scope: { kind: "resource", id: id("resource") },
      }),
    ).toBe(false);
  });
  it("keeps endpoint generations and target kinds distinct", () => {
    expect(planningKey(target)).not.toBe(planningKey({ ...target, generation: decimal("2") }));
    expect(planningKey(target)).not.toBe(planningKey({ ...target, kind: "ticket" }));
  });
  it("binds returned project and milestone identity and preserves exact raw response", () => {
    const raw = response(record),
      result = decodePlanningRecord(target, raw);
    expect(result.ok && result.data.title).toBe("Original project");
    expect(raw.response.data).toBeDefined();
    expect(decodePlanningRecord(target, response({ ...record, project_id: "other" })).ok).toBe(
      false,
    );
    const milestone = { ...target, kind: "milestone" as const };
    expect(
      decodePlanningRecord(
        milestone,
        response({
          milestone: {
            milestone_id: "other",
            project_id: "project",
            title: "Milestone",
            description: "",
            revision: "2",
            archived: false,
            status: "todo",
            target_date: null,
          },
          progress: {},
        }),
      ).ok,
    ).toBe(false);
  });
  it("resolves retained metadata before semantic read and never substitutes current endpoint", async () => {
    const processing = createTestProcessor(),
      calls: string[] = [];
    const http: HttpClient = {
      processing,
      request: <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
        calls.push(request.path);
        const value =
          request.path === "/read"
            ? { response: { data: record, meta: {} }, pagination: null }
            : {
                id: "local",
                generation: "1",
                label: "Original endpoint",
                socket: "/tmp/original.sock",
              };
        return Promise.resolve(ok(decode(request.codec, value)));
      },
    };
    const result = await readPlanningTarget(http, target, new AbortController().signal);
    expect(calls).toEqual(["/connections/local/generations/1", "/read"]);
    expect(result.ok && result.data.connection.socket).toBe("/tmp/original.sock");
    processing.dispose();
  });
  it("snapshots a caller-owned target before awaiting retained metadata", async () => {
    const processing = createTestProcessor(),
      mutable = { ...target },
      calls: HttpRequest<unknown>[] = [];
    let resume: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const http: HttpClient = {
      processing,
      request: async <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
        calls.push(request);
        await gate;
        return ok(
          decode(
            request.codec,
            request.path === "/read"
              ? { response: { data: record, meta: {} }, pagination: null }
              : { id: "local", generation: "1", label: "Original", socket: "/tmp/original.sock" },
          ),
        );
      },
    };
    const pending = readPlanningTarget(http, mutable, new AbortController().signal);
    mutable.generation = decimal("2");
    mutable.id = id("replacement");
    mutable.workspaceId = id("other");
    if (!resume) throw new Error("Deferred profile gate missing");
    resume();
    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.failure));
    expect(result.data.target).toEqual(target);
    expect(Object.isFrozen(result.data.target)).toBe(true);
    expect(calls[0]?.path).toBe("/connections/local/generations/1");
    const body = calls[1]?.body;
    if (body === undefined) throw new Error("Semantic read body missing");
    expect(jsonField(body, "generation")).toEqual(d.jsonString("1"));
    expect(jsonField(body, "params")).toEqual(planningInvocation(target).params);
    processing.dispose();
  });
  it("missing or mismatched profile prevents any target read", async () => {
    const processing = createTestProcessor();
    for (const mismatch of [true, false]) {
      const calls: string[] = [];
      const http: HttpClient = {
        processing,
        request: <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
          calls.push(request.path);
          return Promise.resolve<HttpResult<T>>(
            mismatch
              ? ok(
                  decode(request.codec, {
                    id: "local",
                    generation: "2",
                    label: "Replacement",
                    socket: "/tmp/replacement.sock",
                  }),
                )
              : {
                  ok: false,
                  failure: {
                    kind: "remote",
                    httpStatus: 404,
                    problem: {
                      kind: "Not_found",
                      message: "Retained profile unavailable",
                      details: undefined,
                    },
                  },
                },
          );
        },
      };
      expect((await readPlanningTarget(http, target, new AbortController().signal)).ok).toBe(false);
      expect(calls).toEqual(["/connections/local/generations/1"]);
    }
    processing.dispose();
  });
  it("cancellation after retained lookup prevents the semantic read", async () => {
    const processing = createTestProcessor(),
      owner = new AbortController();
    let calls = 0;
    const http: HttpClient = {
      processing,
      request: <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
        calls++;
        owner.abort();
        return Promise.resolve(
          ok(
            decode(request.codec, {
              id: "local",
              generation: "1",
              label: "Original",
              socket: "/tmp/original.sock",
            }),
          ),
        );
      },
    };
    expect(await readPlanningTarget(http, target, owner.signal)).toEqual({
      ok: false,
      failure: { kind: "aborted" },
    });
    expect(calls).toBe(1);
    processing.dispose();
  });
});
