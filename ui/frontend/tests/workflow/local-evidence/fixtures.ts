import { parseJsonText, type JsonValue } from "../../../src/core/json";
import type { Codec } from "../../../src/core/protocol/codec";
import * as d from "../../../src/core/protocol/decoders";
import * as codecs from "../../../src/features/workflow/local-evidence/codecs";
import type { HttpResult } from "../../../src/core/protocol/http";
export const digest = "a".repeat(64),
  otherDigest = "b".repeat(64);
export function json(value: unknown): JsonValue {
  const result = parseJsonText(JSON.stringify(value));
  if (!result.ok) throw new Error(result.error.message);
  return result.value.value;
}
export function decode<T>(codec: Codec<T>, value: unknown): T {
  const result = codec.decode(json(value));
  if (!result.ok) throw new Error(`${result.issue.path.join(".")}: ${result.issue.expected}`);
  return result.value;
}
export const decimal = (value: string) => decode(d.decimal, value);
export const identifier = (value: string) => decode(d.identifier, value);
export const profile = decode(d.connectionProfile, {
  id: "local",
  generation: "1",
  label: "Local",
  socket: "/tmp/original.sock",
});
export const outcome = { kind: "exited", code: "7" };
export const source = { kind: "not_requested" };
export const rawStage = {
  kind: "finished",
  directory: "/tmp/stage",
  command: { argv: ["/never-run", "literal ; $(argument)", ""], cwd: "/tmp", output_limit: "4" },
  owner_token: digest,
  publication_intent: "absent",
  capture: { digest, size_bytes: "500" },
  outcome,
  started_unix_ms: "2",
  finished_unix_ms: "1",
  elapsed_ms: "3",
  source_before: source,
  source_after: source,
  stdout: {
    digest,
    size_bytes: "4",
    observed_bytes: "9",
    observed_sha256: otherDigest,
    eof: true,
    truncated: true,
  },
  stderr: {
    digest,
    size_bytes: "0",
    observed_bytes: "0",
    observed_sha256: digest,
    eof: true,
    truncated: false,
  },
};
export const stage = decode(codecs.stage, rawStage);
export const rawOutput = {
  directory: "/tmp/stage",
  capture_digest: digest,
  stream: "stdout",
  selection: "range",
  retention: "prefix",
  offset: "0",
  returned_bytes: "4",
  retained_bytes: "4",
  omitted_retained_bytes: "0",
  observed_bytes: "9",
  observed_sha256: otherDigest,
  eof: true,
  truncated: true,
  at_observed_end: false,
  text: "\0�ab",
  text_lossy: true,
  data_base64: "AP9hYg==",
  source_before: source,
  source_after: source,
  outcome,
};
export const output = decode(codecs.inspected, rawOutput);
export const ok = <T>(data: T): HttpResult<T> => ({ ok: true, data, httpStatus: 200 });
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export function rawJob(
  plan: import("../../../src/features/workflow/local-evidence/types").PublicationPlan,
  kind: "prepared_unsent" | "outcome_unknown" | "running" = "prepared_unsent",
) {
  const params =
    plan.kind === "ui_prepared"
      ? plan.params
      : {
          workspace_id: "demo",
          actor_id: "original-author",
          mutation_id: "external",
          resource_id: "artifact",
          expected_revision: "0",
          title: "External capture",
        };
  return {
    plan,
    input_hash: "c".repeat(64),
    revision: "1",
    saved_request: `${plan.directory}/publication.json`,
    native_request: {
      jsonrpc: "2.0",
      workgraph_api: "0.7",
      id: "execution-publication",
      method: "resource.upload",
      params: {
        ...params,
        transfer_version: "2",
        upload_id: "saved-upload",
        file: `${plan.directory}/capture.json`,
        digest: plan.kind === "ui_prepared" ? plan.capture_digest : digest,
        size_bytes: "500",
        filename: "execution-capture.json",
        mime_type: "application/json",
      },
    },
    intent_digest: plan.kind === "operator_bound_external" ? plan.intent_digest : digest,
    state:
      kind === "prepared_unsent"
        ? { kind }
        : kind === "running"
          ? { kind, previous: null }
          : {
              kind,
              diagnostic: { kind: "Outcome_unknown", message: "External outcome not inspected" },
            },
    diagnostic: null,
  };
}
export function job(...args: Parameters<typeof rawJob>) {
  return decode(codecs.job, rawJob(...args));
}
