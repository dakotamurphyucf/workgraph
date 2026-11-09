import { FORMAT_LIMITS } from "../../../features/history/formats/limits";
import { DEFAULT_JSON_LIMITS, type JsonLimits } from "../../json";
import { capturedJsonWeight, isCapturedJson } from "../../json/capture";
import { captureOperation, capturePreparation, CaptureError, jsonCapture } from "./captures";
import { HTTP_LIMITS, OPERATION_LIMITS, PROCESSING_LIMITS, type ProcessingJob } from "./jobs";
import { dataObject, readMessage, transfers, type WorkerMessage } from "./messages";
import { createGraphReader, writeGraph, WireError, type GraphReader, type GraphPart } from "./wire";
import type {
  ProtocolProcessor,
  ProtocolWorkerFactory,
  ProtocolWorkerPort,
  ProcessingResult,
} from "./types";
function browserPort(): ProtocolWorkerPort {
  const worker = new Worker(new URL("./protocol.worker.ts", import.meta.url), { type: "module" });
  return {
    listen(receive, failed) {
      const message = (event: MessageEvent<unknown>) => receive(event.data);
      const error = (event: ErrorEvent) => {
        event.preventDefault();
        failed(event.error instanceof Error ? event.error : new Error(event.message));
      };
      const malformed = () => failed(new Error("Worker message could not be deserialized."));
      worker.addEventListener("message", message);
      worker.addEventListener("error", error);
      worker.addEventListener("messageerror", malformed);
      return () => {
        worker.removeEventListener("message", message);
        worker.removeEventListener("error", error);
        worker.removeEventListener("messageerror", malformed);
      };
    },
    send(message, transfer = []) {
      worker.postMessage(message, transfer);
    },
    terminate() {
      worker.terminate();
    },
  };
}
interface Entry {
  readonly id: string;
  readonly job: ProcessingJob;
  readonly weight: number;
  readonly resolve: (value: ProcessingResult<unknown>) => void;
  readonly reject: (error: unknown) => void;
  readonly input: Generator<GraphPart>;
  readonly output: GraphReader;
  readonly signal: AbortSignal | undefined;
  readonly abort: () => void;
  timer: ReturnType<typeof setTimeout>;
  sent: number;
  received: number;
  phase: "ready" | "input" | "output";
}
const failure = (
  kind: "aborted" | "busy" | "timeout" | "protocol",
  message: string,
): ProcessingResult<never> => ({ ok: false, failure: { kind, message } });
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function resultShape(job: ProcessingJob, value: unknown): boolean {
  if (!object(value)) return false;
  if (job.kind === "project")
    return (
      typeof value.status === "string" &&
      ["recognized", "generic", "unsupported", "ambiguous"].includes(value.status) &&
      object(value.capture)
    );
  if (typeof value.ok !== "boolean") return false;
  if (!value.ok)
    return job.kind === "parse" || job.kind === "encode"
      ? object(value.error) &&
          typeof value.error.code === "string" &&
          typeof value.error.message === "string"
      : typeof value.message === "string";
  switch (job.kind) {
    case "parse":
      return (
        dataObject(value.value, ["source", "byteLength", "value"]) &&
        typeof value.value.source === "string" &&
        typeof value.value.byteLength === "number" &&
        object(value.value.value) &&
        isCapturedJson(value.value.value)
      );
    case "encode":
      return typeof value.value === "string";
    case "http":
      return object(value.value) && isCapturedJson(value.value);
    case "admit":
      return object(value.preparation) && typeof value.identity === "string";
    case "observe":
      return (
        object(value.operation) &&
        typeof value.preparationIdentity === "string" &&
        typeof value.requestIdentity === "string" &&
        (value.receiptIdentity === null || typeof value.receiptIdentity === "string")
      );
  }
}
/** One reusable worker, bounded FIFO and transferred, acknowledged graph slices. */
export function createProtocolProcessor(
  factory: ProtocolWorkerFactory = browserPort,
): ProtocolProcessor {
  let port: ProtocolWorkerPort | null = null;
  let unlisten: (() => void) | null = null;
  let active: Entry | null = null;
  let idleFailure: Error | null = null;
  let disposed = false;
  let nextId = 0;
  let reserved = 0;
  const queue: Entry[] = [];
  const stop = () => {
    unlisten?.();
    unlisten = null;
    port?.terminate();
    port = null;
  };
  function settle(entry: Entry, value: ProcessingResult<unknown> | null, error?: unknown) {
    if (active !== entry && !queue.includes(entry)) return;
    if (active === entry) active = null;
    else queue.splice(queue.indexOf(entry), 1);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener("abort", entry.abort);
    entry.output.clear();
    reserved -= entry.weight;
    if (value !== null) entry.resolve(value);
    else entry.reject(error);
    queueMicrotask(pump);
  }
  function expected(entry: Entry, kind: "aborted" | "timeout" | "protocol", message: string) {
    if (active === entry) stop();
    settle(entry, failure(kind, message));
  }
  function bug(error: unknown) {
    const entry = active;
    stop();
    if (entry) settle(entry, null, error);
    else
      idleFailure =
        error instanceof Error
          ? error
          : new Error("Unexpected idle worker failure", { cause: error });
  }
  function send(message: WorkerMessage) {
    if (!port) throw new Error("Missing active worker port.");
    port.send(message, transfers(message));
  }
  function nextInput(entry: Entry) {
    const part = entry.input.next();
    if (part.done) {
      entry.phase = "output";
      return;
    }
    entry.sent += 1;
    entry.phase = "input";
    send({ kind: "input", id: entry.id, sequence: entry.sent, part: part.value });
  }
  function receive(value: unknown) {
    const entry = active;
    if (!entry) {
      stop();
      return;
    }
    try {
      const message = readMessage(value);
      if (!message || message.id !== entry.id)
        throw new WireError("Malformed or stale processing response.");
      if (message.kind === "error") {
        const error = new Error(message.error.message);
        error.name = message.error.name;
        error.stack = message.error.stack;
        bug(error);
        return;
      }
      if (message.kind === "failure") {
        expected(entry, "protocol", message.message);
        return;
      }
      if (message.kind === "ready" && entry.phase === "ready") nextInput(entry);
      else if (
        message.kind === "accepted" &&
        entry.phase === "input" &&
        message.sequence === entry.sent
      )
        nextInput(entry);
      else if (
        message.kind === "output" &&
        entry.phase === "output" &&
        message.sequence === entry.received + 1
      ) {
        entry.received += 1;
        entry.output.accept(message.part);
        send({ kind: "ack", id: entry.id, sequence: message.sequence });
        if (message.part.kind === "end") {
          const result = entry.output.finish();
          if (!resultShape(entry.job, result))
            throw new WireError("Invalid processing result shape.");
          settle(entry, { ok: true, value: result });
        }
      } else throw new WireError("Invalid processing response sequence or direction.");
    } catch (error: unknown) {
      if (error instanceof WireError) expected(entry, "protocol", error.message);
      else bug(error);
    }
  }
  function pump() {
    if (active || disposed) return;
    const entry = queue.shift();
    if (!entry) return;
    active = entry;
    try {
      if (!port) {
        port = factory();
        unlisten = port.listen(receive, bug);
      }
      send({ kind: "start", id: entry.id });
    } catch (error: unknown) {
      bug(error);
    }
  }
  function submit<T>(
    job: ProcessingJob,
    signal: AbortSignal | undefined,
    weight: number,
  ): Promise<ProcessingResult<T>> {
    if (idleFailure !== null) return Promise.reject(idleFailure);
    if (disposed || signal?.aborted)
      return Promise.resolve(failure("aborted", "Processing was cancelled."));
    if (
      queue.length >= PROCESSING_LIMITS.queued ||
      reserved + weight > PROCESSING_LIMITS.admittedBytes
    )
      return Promise.resolve(
        failure("busy", "Protocol processing capacity is full. Retry explicitly."),
      );
    return new Promise<ProcessingResult<T>>((resolve, reject) => {
      const entry: Entry = {
        id: `job-${++nextId}`,
        job,
        weight,
        resolve: (value) => resolve(value as ProcessingResult<T>),
        reject,
        input: writeGraph(job),
        output: createGraphReader(),
        signal,
        abort: () => expected(entry, "aborted", "Processing was cancelled."),
        timer: setTimeout(
          () => expected(entry, "timeout", "Protocol processing exceeded its deadline."),
          PROCESSING_LIMITS.deadlineMs,
        ),
        sent: 0,
        received: 0,
        phase: "ready",
      };
      reserved += weight;
      queue.push(entry);
      signal?.addEventListener("abort", entry.abort, { once: true });
      pump();
    });
  }
  function captured<T>(
    make: () => ProcessingJob,
    signal: AbortSignal | undefined,
    weight: number,
  ): Promise<ProcessingResult<T>> {
    if (disposed || signal?.aborted)
      return Promise.resolve(failure("aborted", "Processing was cancelled."));
    if (
      queue.length >= PROCESSING_LIMITS.queued ||
      reserved + weight > PROCESSING_LIMITS.admittedBytes
    )
      return Promise.resolve(
        failure("busy", "Protocol processing capacity is full. Retry explicitly."),
      );
    try {
      return submit<T>(make(), signal, weight);
    } catch (error: unknown) {
      if (error instanceof CaptureError) return Promise.resolve(failure("protocol", error.message));
      return Promise.reject(
        error instanceof Error
          ? error
          : new Error("Unexpected non-Error capture exception", { cause: error }),
      );
    }
  }
  const limits = (value: JsonLimits | undefined) =>
    Object.freeze({ ...(value ?? DEFAULT_JSON_LIMITS) });
  const unavailable = (signal: AbortSignal | undefined) =>
    disposed || signal?.aborted ? failure("aborted", "Processing was cancelled.") : null;
  const invalidLimits = (bounds: JsonLimits) =>
    Object.keys(OPERATION_LIMITS).some((key) => {
      const name = key as keyof JsonLimits;
      const value = bounds[name];
      return !Number.isSafeInteger(value) || value < 0 || value > OPERATION_LIMITS[name];
    });
  const jsonError = (code: "invalid_limits" | "byte_limit", message: string) => ({
    ok: true as const,
    value: { ok: false as const, error: { code, message } },
  });

  return {
    parse(source, options) {
      const cancelled = unavailable(options?.signal);
      if (cancelled) return Promise.resolve(cancelled);
      const bounds = limits(options?.limits);
      if (invalidLimits(bounds))
        return Promise.resolve(
          jsonError("invalid_limits", "Invalid protocol processing JSON limits."),
        );
      if ((typeof source === "string" ? source.length : source.byteLength) > bounds.maxBytes)
        return Promise.resolve(jsonError("byte_limit", "JSON source exceeds its byte budget."));
      return captured(
        () => ({
          kind: "parse",
          source: typeof source === "string" ? source : source.slice(),
          limits: bounds,
        }),
        options?.signal,
        typeof source === "string"
          ? Math.min(bounds.maxBytes, source.length * 3)
          : source.byteLength,
      );
    },
    encode(input, options) {
      let value;
      try {
        value = jsonCapture(input);
      } catch (error: unknown) {
        if (error instanceof CaptureError)
          return Promise.resolve(failure("protocol", error.message));
        return Promise.reject(
          error instanceof Error
            ? error
            : new Error("Unexpected capture failure", { cause: error }),
        );
      }
      const cancelled = unavailable(options?.signal);
      if (cancelled) return Promise.resolve(cancelled);
      const bounds = limits(options?.limits);
      if (invalidLimits(bounds))
        return Promise.resolve(
          jsonError("invalid_limits", "Invalid protocol processing JSON limits."),
        );
      return captured(
        () => ({
          kind: "encode",
          value: jsonCapture(value),
          limits: bounds,
          canonical: options?.canonical ?? false,
        }),
        options?.signal,
        Math.min(bounds.maxBytes, capturedJsonWeight(value)),
      );
    },
    decodeHttp(bytes, options) {
      const cancelled = unavailable(options.signal);
      if (cancelled) return Promise.resolve(cancelled);
      const maxBytes =
        options.budget === "operation" ? OPERATION_LIMITS.maxBytes : HTTP_LIMITS.maxBytes;
      if (bytes.byteLength > maxBytes)
        return Promise.resolve({
          ok: true,
          value: { ok: false, message: "JSON response exceeds its byte budget.", issue: undefined },
        });
      return captured(
        () => ({
          kind: "http",
          bytes: bytes.slice(),
          budget: options.budget,
          operation: options.operation,
        }),
        options.signal,
        bytes.byteLength,
      );
    },
    admitPreparation(preparation, options) {
      return captured(
        () => ({ kind: "admit", preparation: capturePreparation(preparation) }),
        options?.signal,
        Math.min(HTTP_LIMITS.maxBytes, capturedJsonWeight(preparation.params) + 4096),
      );
    },
    observeOperation(operation, options) {
      return captured(
        () => ({ kind: "observe", operation: captureOperation(operation) }),
        options?.signal,
        Math.min(
          OPERATION_LIMITS.maxBytes,
          capturedJsonWeight(operation.request) +
            capturedJsonWeight(operation.preparation.params) +
            (operation.state.kind === "committed" || operation.state.kind === "observed"
              ? capturedJsonWeight(operation.state.response.data) +
                capturedJsonWeight(operation.state.response.meta)
              : 4096) +
            4096,
        ),
      );
    },
    project(capture, selection = "auto", options) {
      const cancelled = unavailable(options?.signal);
      if (cancelled) return Promise.resolve(cancelled);
      const base = { capture, selection, document: null };
      if (selection === "generic")
        return Promise.resolve({
          ok: true,
          value: { ...base, status: "generic", reason: "explicit-generic" },
        });
      if (capture.completeness === "partial")
        return Promise.resolve({
          ok: true,
          value: { ...base, status: "unsupported", reason: "partial", issues: [] },
        });
      // Use the same complete-event ceiling as retrieval and the format registry.
      if (capture.bytes.byteLength > FORMAT_LIMITS.maxBytes)
        return Promise.resolve({
          ok: true,
          value: { ...base, status: "unsupported", reason: "byte-budget", issues: [] },
        });
      return captured(
        () => ({
          kind: "project",
          selection,
          capture: Object.freeze({
            captureId: capture.captureId,
            scopeId: Object.freeze<[string, string, string, string]>([...capture.scopeId]),
            metadata: jsonCapture(capture.metadata),
            bytes: capture.bytes.slice(),
            completeness: capture.completeness,
            producer: capture.producer === null ? null : Object.freeze({ ...capture.producer }),
          }),
        }),
        options?.signal,
        capture.bytes.byteLength +
          Math.min(HTTP_LIMITS.maxBytes, capturedJsonWeight(capture.metadata)),
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      if (active) settle(active, failure("aborted", "Protocol processor disposed."));
      for (const entry of [...queue])
        settle(entry, failure("aborted", "Protocol processor disposed."));
    },
  };
}
