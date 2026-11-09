import { dataObject, readMessage, transfers, type WorkerMessage } from "./messages";
import { createGraphReader, writeGraph, WireError, type GraphReader } from "./wire";
import { processJob } from "./processor";
import type { ProcessingJob } from "./jobs";
import { OPERATION_LIMITS } from "./jobs";

function limits(value: unknown): boolean {
  return (
    dataObject(value, ["maxBytes", "maxDepth", "maxNodes", "maxStringBytes"]) &&
    (Object.keys(OPERATION_LIMITS) as (keyof typeof OPERATION_LIMITS)[]).every(
      (key) =>
        typeof value[key] === "number" &&
        Number.isSafeInteger(value[key]) &&
        value[key] >= 0 &&
        value[key] <= OPERATION_LIMITS[key],
    )
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function preparation(value: unknown): boolean {
  return (
    dataObject(value, [
      "intention_id",
      "context",
      "connection_id",
      "generation",
      "method",
      "params",
    ]) &&
    [value.intention_id, value.connection_id, value.generation, value.method].every(
      (x) => typeof x === "string",
    ) &&
    record(value.params) &&
    dataObject(value.context, ["workspace_id", "project_id", "writer"]) &&
    [value.context.workspace_id, value.context.project_id].every(
      (x) => x === null || typeof x === "string",
    ) &&
    dataObject(value.context.writer, ["actor_id", "run_id"]) &&
    typeof value.context.writer.actor_id === "string" &&
    (value.context.writer.run_id === null || typeof value.context.writer.run_id === "string")
  );
}
function profile(value: unknown): boolean {
  return (
    dataObject(value, ["id", "generation", "label", "socket"]) &&
    Object.values(value).every((x) => typeof x === "string")
  );
}
function problem(value: unknown): boolean {
  return (
    dataObject(value, ["kind", "message", "details"]) &&
    typeof value.kind === "string" &&
    typeof value.message === "string" &&
    (value.details === undefined || record(value.details))
  );
}
function operation(value: unknown): boolean {
  if (
    !dataObject(value, [
      "format",
      "operation_id",
      "preparation",
      "preparation_input_hash",
      "connection",
      "request",
      "journal_path",
      "revision",
      "state",
      "diagnostic",
      "receipt_lookup_supported",
    ]) ||
    !dataObject(value.preparation, ["intention_id", "context", "connection", "method", "params"]) ||
    !record(value.state) ||
    !profile(value.connection) ||
    !record(value.request)
  )
    return false;
  const snapshot = value.preparation;
  if (
    !profile(snapshot.connection) ||
    !preparation({
      intention_id: snapshot.intention_id,
      context: snapshot.context,
      connection_id: "checked-by-domain",
      generation: "1",
      method: snapshot.method,
      params: snapshot.params,
    })
  )
    return false;
  const state = value.state;
  const shape =
    state.kind === "committed" || state.kind === "observed"
      ? dataObject(state, ["kind", "response"]) &&
        dataObject(state.response, ["data", "meta"]) &&
        record(state.response.data) &&
        record(state.response.meta)
      : state.kind === "rejected" || state.kind === "outcome_unknown"
        ? dataObject(state, ["kind", "problem"]) && problem(state.problem)
        : dataObject(state, ["kind"]) &&
          (state.kind === "prepared_unsent" || state.kind === "sending");
  return (
    shape &&
    typeof value.receipt_lookup_supported === "boolean" &&
    [value.format, value.operation_id, value.preparation_input_hash, value.revision].every(
      (x) => typeof x === "string",
    ) &&
    (value.journal_path === null || typeof value.journal_path === "string") &&
    (value.diagnostic === null || problem(value.diagnostic))
  );
}
export function readJob(value: unknown): ProcessingJob | null {
  if (!record(value)) return null;
  switch (value.kind) {
    case "parse":
      if (
        dataObject(value, ["kind", "source", "limits"]) &&
        (typeof value.source === "string" || value.source instanceof Uint8Array) &&
        limits(value.limits)
      )
        return value as ProcessingJob;
      break;
    case "encode":
      if (
        dataObject(value, ["kind", "value", "limits", "canonical"]) &&
        record(value.value) &&
        limits(value.limits) &&
        typeof value.canonical === "boolean"
      )
        return value as ProcessingJob;
      break;
    case "http":
      if (
        dataObject(value, ["kind", "bytes", "budget", "operation"]) &&
        value.bytes instanceof Uint8Array &&
        (value.budget === "ordinary" || value.budget === "operation") &&
        typeof value.operation === "boolean"
      )
        return value as ProcessingJob;
      break;
    case "admit":
      if (dataObject(value, ["kind", "preparation"]) && preparation(value.preparation))
        return value as ProcessingJob;
      break;
    case "observe":
      if (dataObject(value, ["kind", "operation"]) && operation(value.operation))
        return value as ProcessingJob;
      break;
    case "project":
      if (
        dataObject(value, ["kind", "capture", "selection"]) &&
        typeof value.selection === "string" &&
        [
          "auto",
          "generic",
          "anthropic.messages.response.v1",
          "openai.responses.object.v1",
          "openai.responses.event.v1",
          "openai.chat-completions.object.v1",
          "claude.agent-sdk.message.v1",
          "codex.rollout-jsonl.7cdb219.v1",
        ].includes(value.selection) &&
        dataObject(value.capture, [
          "captureId",
          "scopeId",
          "metadata",
          "bytes",
          "completeness",
          "producer",
        ]) &&
        typeof value.capture.captureId === "string" &&
        Array.isArray(value.capture.scopeId) &&
        value.capture.scopeId.length === 4 &&
        value.capture.scopeId.every((x) => typeof x === "string") &&
        value.capture.bytes instanceof Uint8Array &&
        (value.capture.completeness === "complete" || value.capture.completeness === "partial") &&
        record(value.capture.metadata) &&
        (value.capture.producer === null ||
          (dataObject(value.capture.producer, ["name", "revision"]) &&
            typeof value.capture.producer.name === "string" &&
            typeof value.capture.producer.revision === "string"))
      )
        return value as ProcessingJob;
      break;
  }
  return null;
}
interface Active {
  readonly id: string;
  readonly input: GraphReader;
  sequence: number;
  output: number;
  waiting: (() => void) | null;
  computing: boolean;
}
/** Reusable dedicated worker session. No I/O, native calls, dynamic method dispatch or cross-job retained data. */
export function createWorkerSession(
  send: (message: WorkerMessage, transfer: Transferable[]) => void,
) {
  let active: Active | null = null;
  let disposed = false;
  const post = (message: WorkerMessage) => {
    if (!disposed) send(message, transfers(message));
  };
  const fail = (entry: Active, error: unknown) => {
    entry.input.clear();
    if (active !== entry || disposed) return;
    active = null;
    if (error instanceof WireError)
      post({ kind: "failure", id: entry.id, message: error.message.slice(0, 4096) });
    else {
      const bug =
        error instanceof Error ? error : new Error("Unexpected non-Error worker exception");
      post({
        kind: "error",
        id: entry.id,
        error: {
          name: bug.name.slice(0, 4096),
          message: bug.message.slice(0, 4096),
          stack: (bug.stack ?? "").slice(0, 4096),
        },
      });
    }
  };
  async function complete(entry: Active) {
    const job = readJob(entry.input.finish());
    if (!job) throw new WireError("Invalid processing job.");
    const result = await processJob(job);
    for (const part of writeGraph(result)) {
      if (disposed || active !== entry) return;
      entry.output += 1;
      await new Promise<void>((resolve) => {
        entry.waiting = resolve;
        post({ kind: "output", id: entry.id, sequence: entry.output, part });
      });
    }
    if (active === entry) active = null;
  }
  return {
    receive(value: unknown) {
      if (disposed) return;
      const message = readMessage(value);
      if (!message) {
        if (active) fail(active, new WireError("Malformed worker control message."));
        return;
      }
      if (message.kind === "start") {
        if (active) {
          fail(active, new WireError("A worker cannot admit overlapping jobs."));
          return;
        }
        active = {
          id: message.id,
          input: createGraphReader(),
          sequence: 0,
          output: 0,
          waiting: null,
          computing: false,
        };
        post({ kind: "ready", id: message.id });
        return;
      }
      const entry = active;
      if (!entry || message.id !== entry.id) {
        if (entry) fail(entry, new WireError("Wrong worker job identity."));
        return;
      }
      try {
        if (message.kind === "ack") {
          if (message.sequence !== entry.output || entry.waiting === null)
            throw new WireError("Invalid output acknowledgement.");
          const settle = entry.waiting;
          entry.waiting = null;
          settle();
        } else if (message.kind === "input") {
          if (entry.computing || message.sequence !== entry.sequence + 1)
            throw new WireError("Invalid processing input sequence.");
          entry.sequence = message.sequence;
          entry.input.accept(message.part);
          post({ kind: "accepted", id: entry.id, sequence: message.sequence });
          if (message.part.kind === "end") {
            entry.computing = true;
            void complete(entry).catch((error) => fail(entry, error));
          }
        } else throw new WireError("Unexpected worker message direction.");
      } catch (error: unknown) {
        fail(entry, error);
      }
    },
    dispose() {
      disposed = true;
      active?.input.clear();
      active = null;
    },
  };
}
