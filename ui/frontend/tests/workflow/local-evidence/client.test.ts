import { describe, it, expect, afterEach } from "vitest";
import * as codecs from "../../../src/features/workflow/local-evidence/codecs";
import { createExecutionClient } from "../../../src/features/workflow/local-evidence/client";
import type { HttpClient, HttpRequest, HttpResult } from "../../../src/core/protocol/http";
import type { OutputSelection } from "../../../src/features/workflow/local-evidence/types";
import { createTestProcessor } from "../../core/processing-harness";
import {
  json,
  rawOutput,
  deferred,
  decimal,
  digest,
  rawStage,
  rawJob,
  profile,
  identifier,
} from "./fixtures";
const clean: (() => void)[] = [];
afterEach(() => clean.splice(0).forEach((f) => f()));
function setup() {
  const processing = createTestProcessor();
  clean.push(() => processing.dispose());
  let answer: (request: HttpRequest<unknown>) => Promise<unknown> = () =>
    Promise.resolve(rawOutput);
  const requests: HttpRequest<unknown>[] = [];
  const http: HttpClient = {
    processing,
    request: async <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
      requests.push(request);
      const data = await answer(request);
      const parsed = request.codec.decode(json(data));
      return parsed.ok
        ? { ok: true, data: parsed.value, httpStatus: 200 }
        : {
            ok: false,
            failure: { kind: "protocol", message: parsed.issue.expected, issue: parsed.issue },
          };
    },
  };
  return {
    client: createExecutionClient(http),
    requests,
    setAnswer: (callback: typeof answer) => {
      answer = callback;
    },
  };
}
describe("Local evidence native DTO and exact associations", () => {
  it("captures range and path scalars before deferred caller mutation", async () => {
    const h = setup(),
      pending = deferred<unknown>();
    h.setAnswer(() => pending.promise);
    const target = { directory: "/tmp/stage", capture_digest: decodeDigest() };
    const selection: {
      kind: "range";
      offset: import("../../../src/core/protocol/types").Decimal;
      length: import("../../../src/core/protocol/types").Decimal;
    } = { kind: "range", offset: decimal("0"), length: decimal("4") };
    const read = h.client.inspectOutput(target, "stdout", selection, new AbortController().signal);
    target.directory = "/tmp/other";
    selection.offset = decimal("99");
    selection.length = decimal("1");
    pending.resolve(rawOutput);
    expect((await read).ok).toBe(true);
  });
  it("rejects output from another selection and intent from another directory", async () => {
    const h = setup();
    h.setAnswer(() =>
      Promise.resolve({
        ...rawOutput,
        offset: "1",
        returned_bytes: "3",
        omitted_retained_bytes: "1",
        data_base64: "/2Fi",
      }),
    );
    const selection: OutputSelection = {
      kind: "range",
      offset: decimal("0"),
      length: decimal("4"),
    };
    const result = await h.client.inspectOutput(
      { directory: "/tmp/stage", capture_digest: decodeDigest() },
      "stdout",
      selection,
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("protocol");
    h.setAnswer(() =>
      Promise.resolve({
        directory: "/tmp/other",
        intent_digest: digest,
        saved_request: "/tmp/other/publication.json",
        request: {},
        original_endpoint_recorded: false,
      }),
    );
    expect(
      (await h.client.inspectIntent({ directory: "/tmp/stage" }, new AbortController().signal)).ok,
    ).toBe(false);
  });
  it("compares actual canonical encoded plan text and rejects changed returned intent", async () => {
    const h = setup();
    const plan = {
      kind: "ui_prepared" as const,
      intention_id: identifier("publish"),
      connection: profile,
      directory: "/tmp/stage",
      capture_digest: decodeDigest(),
      context: {
        workspace_id: identifier("demo"),
        project_id: null,
        writer: { actor_id: identifier("author"), run_id: null },
      },
      params: {
        workspace_id: identifier("demo"),
        actor_id: identifier("author"),
        mutation_id: identifier("publish"),
        resource_id: identifier("artifact"),
        expected_revision: decimal("0"),
        title: "Saved evidence",
      },
    };
    h.setAnswer(() => Promise.resolve(rawJob(plan)));
    expect((await h.client.prepare(plan)).ok).toBe(true);
    h.setAnswer(() =>
      Promise.resolve(rawJob({ ...plan, params: { ...plan.params, title: "Changed title" } })),
    );
    const changed = await h.client.prepare(plan);
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.failure.kind).toBe("protocol");
  });
  it("rejects fabricated lifecycle fields and native count/base64 inconsistencies", () => {
    expect(
      codecs.stage.decode(json({ ...rawStage, command: { ...rawStage.command, argv: [] } })).ok,
    ).toBe(false);
    expect(
      codecs.stage.decode(json({ ...rawStage, started_unix_ms: "9223372036854775808" })).ok,
    ).toBe(false);
    expect(codecs.inspected.decode(json({ ...rawOutput, data_base64: "AP9hYh==" })).ok).toBe(false);
    expect(codecs.inspected.decode(json({ ...rawOutput, returned_bytes: "3" })).ok).toBe(false);
    expect(codecs.inspected.decode(json({ ...rawOutput, at_observed_end: true })).ok).toBe(false);
    expect(
      codecs.inspected.decode(
        json({
          ...rawOutput,
          observed_bytes: "4",
          truncated: false,
          at_observed_end: true,
          eof: false,
        }),
      ).ok,
    ).toBe(true);
  });
});
function decodeDigest() {
  const result = codecs.stage.decode(json(rawStage));
  if (!result.ok || result.value.kind !== "finished") throw new Error("fixture");
  return result.value.capture.digest;
}
