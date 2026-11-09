import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import { test, expect } from "@playwright/test";
import { fixtureBinary } from "../../../../test-support/daemon-fixture.mjs";
import { stringifyJson } from "../../../src/core/json";
import * as d from "../../../src/core/protocol/decoders";
import {
  conditionCodec,
  reservationCodec,
} from "../../../src/features/participants/coordination/codecs";
import {
  command,
  counter,
  identifier,
} from "../../../src/features/participants/coordination/model";
import type {
  CoordinationDraft,
  CoordinationInput,
  HolderFence,
  ProofPinInput,
} from "../../../src/features/participants/coordination/types";
import { decode, response, target } from "../runs/fixtures";
const execute = promisify(execFile);
// Offline codec parity needs no browser, daemon or mutable workspace.
// eslint-disable-next-line no-empty-pattern
test("coordination structured commands match exact executable schemas", async ({}, info) => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
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
  const p = { worktreeId: "worktree", kind: "subtree" as const, path: "src" },
    holder = {
      actor_id: "author",
      run_id: "run",
      token: "7",
      mode: "exclusive",
      lease: {
        epoch: "7",
        revision: "3",
        last_unix_ms: "0",
        duration_ms: "1000",
        deadline_unix_ms: "1000",
      },
      origin: { kind: "manual" },
    };
  const named = decode(reservationCodec("named"), {
      reservation_id: "compiler",
      epoch: "7",
      holders: [holder],
    }),
    path = decode(reservationCodec("path"), {
      target: { worktree_id: "worktree", kind: "subtree", path: "src" },
      epoch: "7",
      holders: [holder],
    });
  const f = (value: typeof named): HolderFence => ({
    reservation: {
      scope: target,
      value,
      response: response({}),
      namespace: "runs",
      revision: counter("8"),
    },
    holder: value.holders[0]!,
  });
  const pins: ProofPinInput[] = [
    { kind: "resource", resourceId: "proof", version: "1", digest: "a".repeat(64) },
    { kind: "event", sessionId: "session", sequence: "1" },
    { kind: "commit", repository: "repo", objectId: "b".repeat(40) },
    { kind: "checksum", source: "artifact", digest: "c".repeat(64) },
    ...(["comment", "amendment", "contract", "decision"] as const).map((kind) => ({
      kind,
      id: "proof",
      revision: "1",
    })),
  ];
  const inputs: CoordinationInput[] = [
    { kind: "pool", name: "compiler", limit: "2" },
    ...([{ kind: "unrestricted" }, { kind: "allow", ids: ["author"] }] as const).map((actors) => ({
      kind: "policy" as const,
      ticketId: "task",
      capabilities: ["compile"],
      pools: ["compiler"],
      actors,
    })),
    {
      kind: "paths",
      ticketId: "task",
      requireReservations: true,
      paths: [{ target: p, mode: "exclusive" }],
    },
    ...(["", "1000"] as const).flatMap((durationMs) => [
      {
        kind: "acquire" as const,
        targetRunId: "run",
        acquisition: {
          kind: "named" as const,
          requests: [{ reservationId: "compiler", mode: "exclusive" as const, durationMs }],
        },
      },
      {
        kind: "acquire" as const,
        targetRunId: "run",
        acquisition: {
          kind: "paths" as const,
          requests: [{ target: p, mode: "shared" as const, durationMs }],
        },
      },
    ]),
    ...[f(named), f(path)].flatMap((fence) => [
      { kind: "renew" as const, fence },
      { kind: "release" as const, fence },
      {
        kind: "holder-note" as const,
        expectedRevision: "3",
        fence,
        action: {
          kind: "set" as const,
          durationMs: "1000",
          note: "Finishing compiler",
          expectedReleaseUnixMs: "9223372036854775807",
        },
      },
      {
        kind: "holder-note" as const,
        expectedRevision: "3",
        fence,
        action: { kind: "clear" as const },
      },
      {
        kind: "recover" as const,
        recovery: {
          kind: "reservation" as const,
          fence,
          recoveryId: "recovery",
          confirmation: "isolated" as const,
          reason: "Operator isolated previous invocation",
          evidence: pins,
        },
      },
    ]),
    ...(["begin", "refresh"] as const).map((kind) => ({
      kind: "waiter" as const,
      target: { kind: "named" as const, reservationId: "compiler" },
      targetRunId: "run",
      action: { kind, durationMs: "1000", note: "Waiting explicitly" },
    })),
    {
      kind: "waiter",
      target: { kind: "path", target: p },
      targetRunId: "run",
      action: { kind: "close", reason: "Work canceled" },
    },
    ...pins.map((artifact) => ({
      kind: "condition" as const,
      conditionId: "outside",
      ticketId: "task",
      operationId: "outside-check",
      artifact,
      required: true,
      label: "External verification",
      recipients: ["author"],
    })),
  ];
  const declaration = decode(conditionCodec, {
    condition_id: "outside",
    revision: "3",
    ticket_id: "task",
    operation_id: "outside-check",
    artifact: { kind: "resource", resource_id: "proof", revision: "1", digest: "a".repeat(64) },
    required: true,
    label: "External verification",
    creator: "author",
    creator_run: "run",
    recipients: ["author"],
  });
  inputs.push({
    kind: "signal",
    declaration: {
      scope: target,
      value: declaration,
      response: response({}),
      namespace: "runs",
      revision: counter("8"),
    },
    signalId: "observed",
    evidence: pins,
    summary: "Observed the external result",
  });
  for (const disposition of ["preserve_status", "requeue"] as const)
    inputs.push({
      kind: "recover",
      recovery: {
        kind: "ticket",
        fence: {
          scope: target,
          ticketId: identifier("task"),
          ticketRevision: counter("9"),
          projectId: identifier("actual-project"),
          actorId: identifier("old-author"),
          runId: null,
          token: counter("7"),
          lease: decode(reservationCodec("named"), {
            reservation_id: "compiler",
            epoch: "7",
            holders: [holder],
          }).holders[0]!.lease,
          response: response({}),
        },
        disposition,
        recoveryId: "ticket-recovery",
        confirmation: "stopped",
        reason: "Operator observed stopped claimant",
        evidence: pins,
      },
    });
  const checks: { method: string; input: string }[] = [];
  for (const input of inputs) {
    const draft: CoordinationDraft = {
        id: identifier("intention"),
        scope: target,
        writer: { actor_id: identifier("author"), run_id: identifier("run") },
        input,
        phase: { kind: "editing" },
        issue: null,
        unexpected: null,
      },
      request = command(draft, counter("2"));
    const { stdout } = await execute(fixtureBinary(), ["schema", request.method], {
      maxBuffer: 8 * 1024 * 1024,
    });
    const schema = (JSON.parse(stdout) as { methods: { params: object }[] }).methods[0]?.params;
    if (schema === undefined) throw new Error(`Missing ${request.method}`);
    const validate = ajv.compile(schema),
      encoded = stringifyJson(
        d.jsonObject([
          ...request.params.fields.map((field) => [field.name, field.value] as const),
          ["mutation_id", d.jsonString("exact-wire-identity")],
        ]),
      );
    if (!encoded.ok) throw new Error(encoded.error.message);
    const valid = validate(JSON.parse(encoded.value) as unknown);
    expect(valid, `${request.method}: ${JSON.stringify(validate.errors)}`).toBe(true);
    checks.push({ method: request.method, input: input.kind });
  }
  await info.attach("native-request-schema-parity", {
    body: JSON.stringify(checks, null, 2),
    contentType: "application/json",
  });
});
