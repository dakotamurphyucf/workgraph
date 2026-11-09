import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import { test, expect } from "@playwright/test";
import { fixtureBinary } from "../../../../test-support/daemon-fixture.mjs";
import type { HttpClient, HttpRequest, HttpResult } from "../../../src/core/protocol/http";
import { jsonField } from "../../../src/core/json";
import * as d from "../../../src/core/protocol/decoders";
import {
  createParticipantsClient,
  invocation,
} from "../../../src/features/participants/runs/client";
import {
  capture,
  initialInput,
  prepareDraft,
  readRequest,
} from "../../../src/features/participants/runs/model";
import type {
  ParticipantsDraft,
  ParticipantsInput,
  ParticipantsPanel,
} from "../../../src/features/participants/runs/types";
import type { FeatureContext } from "../../../src/app/types";
import { createTestProcessor } from "../../core/processing-harness";
import { actor, attempt, decode, next, response, run, target } from "./fixtures";
const execute = promisify(execFile);
// Offline parity uses the exact provisioned executable; no browser or daemon requests.
// eslint-disable-next-line no-empty-pattern
test("Participants forms and all24 native selectors match executable request schemas", async ({}, info) => {
  const processing = createTestProcessor(),
    http: HttpClient = {
      processing,
      request: <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
        const method = request.body === undefined ? undefined : jsonField(request.body, "method");
        if (method?.kind !== "string") throw new Error("Expected selector");
        const data =
          method.value === "run.get"
            ? response(run, { query_scope: "runs", history_capture: { head: null } })
            : method.value === "attempt.get"
              ? response(attempt, { query_scope: "runs" })
              : method.value === "actor.list"
                ? response(
                    { items: [actor], offset: "0", remaining: "0", next_offset: null },
                    { workspace_revision: "7" },
                  )
                : method.value === "run.budget_get"
                  ? response(
                      { target_run_id: "run", revision: "2" },
                      { query_scope: "policy", query_revision: "2" },
                    )
                  : response(
                      {
                        ticket: {
                          ticket_id: "ticket",
                          project_id: "actual-project",
                          claim: { actor_id: "author", run_id: "run", token: "7" },
                        },
                      },
                      { workspace_revision: "7" },
                    );
        const value = request.codec.decode(
          d.jsonObject([
            [
              "response",
              d.jsonObject([
                ["data", data.response.data],
                ["meta", data.response.meta],
              ]),
            ],
            ["pagination", d.jsonNull()],
          ]),
        );
        if (!value.ok) throw new Error(value.issue.expected);
        return Promise.resolve({ ok: true, httpStatus: 200, data: value.value });
      },
    },
    context: FeatureContext = {
      client: http,
      connection: target.connection,
      profileState: "current",
      route: {
        view: "participants",
        connectionId: "local",
        workspaceId: "workspace",
        projectId: "project",
        entityId: null,
      },
      writer: { actorId: "author", runId: "run" },
      navigate: () => undefined,
    },
    api = createParticipantsClient(http),
    saved = capture(context, null),
    ajv = new Ajv2020({ strict: false, allErrors: true }),
    checks: { method: string; variants: number }[] = [];
  ajv.addKeyword({
    keyword: "x-maxUtf8Bytes",
    type: "string",
    validate: (max: number, value: string) => Buffer.byteLength(value) <= max,
  });
  ajv.addKeyword({
    keyword: "x-maximumDecimal",
    type: "string",
    validate: (max: string, value: string) =>
      /^(0|[1-9][0-9]*)$/u.test(value) && BigInt(value) <= BigInt(max),
  });
  const inputs: ParticipantsInput[] = [
    {
      method: "actor.put",
      actorId: "author",
      name: "Real author",
      actorKind: "person",
      archived: false,
    },
    {
      method: "run.register",
      runId: "actual-invocation",
      objective: "An already-running invocation",
      capabilities: "build\nverify",
      parentRunId: "",
      parentStopPolicy: "continue",
      processRef: "",
      worktreeRef: "",
    },
    {
      method: "run.register",
      runId: "actual-child",
      objective: "Existing child invocation",
      capabilities: "",
      parentRunId: "run",
      parentStopPolicy: "request_cancel",
      processRef: "harness:42",
      worktreeRef: "/work/tree",
    },
    { method: "run.transition", runId: "run", status: "waiting", evidence: "Waiting for review" },
    { method: "run.transition", runId: "run", status: "completed", evidence: "Verified complete" },
    { method: "run.observe", runId: "run", observedUnixMs: "9223372036854775807" },
    { method: "run.heartbeat", runId: "run" },
    { method: "run.link_session", runId: "run", sessionId: "session" },
    {
      method: "attempt.start",
      runId: "run",
      ticketId: "ticket",
      attemptId: "new-attempt",
      sessionIds: "session",
    },
    {
      method: "attempt.checkpoint",
      attemptId: "attempt",
      checkpointKind: "resource",
      targetId: "proof",
      revision: "9007199254740993",
    },
    {
      method: "attempt.checkpoint",
      attemptId: "attempt",
      checkpointKind: "handoff",
      targetId: "ticket",
      revision: "2",
    },
    {
      method: "attempt.finish",
      attemptId: "attempt",
      state: "completed",
      evidence: "Verified completion",
    },
    {
      method: "run.action_acknowledge",
      childRunId: "child",
      evidence: "Harness handled the real request",
    },
    {
      method: "run.budget_put",
      runId: "run",
      maxAttempts: "",
      maxActiveAttempts: "2",
      reportedTokenLimit: "9223372036854775807",
      reportedElapsedMsLimit: "",
    },
  ];
  try {
    const pending = new Map<string, import("../../../src/core/protocol/types").JsonObject[]>();
    for (const input of inputs) {
      const id = decode(d.identifier, "parity-intention"),
        draft: ParticipantsDraft = {
          id,
          capture: saved,
          input,
          phase: { kind: "editing" },
          issue: null,
          unexpected: null,
        };
      // Observation validation intentionally needs a strictly earlier recorded time.
      const selectedInput = input.method === "run.observe" ? { ...draft, capture: saved } : draft;
      const value = await prepareDraft(
        selectedInput,
        input.method === "run.observe"
          ? {
              ...api,
              detail: async (scope, method, id, signal) => {
                const result = await api.detail(scope, method, id, signal);
                return result.ok && result.data.value.kind === "run"
                  ? {
                      ...result,
                      data: {
                        ...result.data,
                        value: {
                          kind: "run" as const,
                          run: { ...result.data.value.run, last_observed_unix_ms: "1" },
                        },
                      },
                    }
                  : result;
              },
            }
          : api,
        new AbortController().signal,
      );
      const variants = pending.get(input.method) ?? [];
      variants.push(value.params);
      pending.set(input.method, variants);
    }
    const filters = { actorId: "author", runId: "run", ticketId: "ticket" };
    for (const panel of [
      "actors",
      "catalog",
      "runs",
      "attempts",
      "actor-overview",
      "coordinator",
      "actions",
      "budget",
      "budget-attention",
      "heartbeat",
    ] as const satisfies readonly ParticipantsPanel[]) {
      const request = readRequest(target, panel, filters);
      pending.set(request.method, [request.params]);
    }
    pending.set("run.get", [
      invocation(target, "run.get", [
        ["target_run_id", d.jsonString("run")],
        ["head", d.jsonNull()],
        ["max_bytes", d.jsonString("1048576")],
      ]).params,
    ]);
    pending.set("attempt.get", [
      invocation(target, "attempt.get", [
        ["attempt_id", d.jsonString("attempt")],
        ["max_bytes", d.jsonString("1048576")],
      ]).params,
    ]);
    pending.set("run.sessions", [
      invocation(
        target,
        "run.sessions",
        Object.entries(next.params)
          .filter(([key]) => key !== "workspace_id")
          .map(([key, value]) => [key, value === null ? d.jsonNull() : d.jsonString(value)]),
      ).params,
    ]);
    for (const [method, variants] of pending) {
      const { stdout } = await execute(fixtureBinary(), ["schema", method], {
          maxBuffer: 8 * 1024 * 1024,
          timeout: 10000,
          killSignal: "SIGKILL",
        }),
        schema = (JSON.parse(stdout) as { methods: { params: object }[] }).methods[0]?.params;
      if (schema === undefined) throw new Error(`Missing ${method}`);
      const validate = ajv.compile(schema);
      for (const params of variants) {
        const encoded = await processing.encode(params);
        if (!encoded.ok)
          throw new Error(`${method}: ${encoded.failure.kind}: ${encoded.failure.message}`);
        if (!encoded.value.ok) throw new Error(`${method}: ${encoded.value.error.message}`);
        const value: unknown = JSON.parse(encoded.value.value);
        expect(validate(value), `${method}: ${JSON.stringify(validate.errors)}`).toBe(true);
        expect(validate({ ...(value as object), unexpected_field: true })).toBe(false);
      }
      checks.push({ method, variants: variants.length });
    }
    expect(checks).toHaveLength(24);
    await info.attach("participants-native-schema-parity", {
      body: JSON.stringify(checks, null, 2),
      contentType: "application/json",
    });
    expect(initialInput("run.register", saved).method).toBe("run.register");
  } finally {
    processing.dispose();
  }
});
