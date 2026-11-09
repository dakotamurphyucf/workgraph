import type { JsonDocument, JsonLimits, JsonResult, JsonValue } from "../../json";
import type { DecodeIssue } from "../codec";
import type { Operation, Preparation } from "../types";
import type {
  CapturedPayload,
  FormatSelection,
  ProjectionResult,
} from "../../../features/history/formats/types";

export interface ProcessingOptions {
  readonly signal?: AbortSignal;
  readonly limits?: JsonLimits;
}
export interface ProcessingFailure {
  readonly kind: "aborted" | "busy" | "timeout" | "protocol";
  readonly message: string;
}
/** Expected capacity/cancellation/wire failures. Unexpected worker exceptions reject. */
export type ProcessingResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ProcessingFailure };
export type HttpDecode =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly message: string; readonly issue: DecodeIssue | undefined };
export type PreparationAdmission =
  | { readonly ok: true; readonly preparation: Preparation; readonly identity: string }
  | { readonly ok: false; readonly message: string };
export type OperationObservation =
  | {
      readonly ok: true;
      readonly operation: Operation;
      readonly preparationIdentity: string;
      readonly requestIdentity: string;
      readonly receiptIdentity: string | null;
    }
  | { readonly ok: false; readonly message: string };

/**
 * One application owner. Authoritative results retain original protocol limits.
 * Inputs are captured synchronously before yielding; owned full-size JSON trees stay immutable.
 * Cancellation removes queued work or terminates the active worker, never a daemon write.
 */
export interface ProtocolProcessor {
  readonly parse: (
    source: string | Uint8Array,
    options?: ProcessingOptions,
  ) => Promise<ProcessingResult<JsonResult<JsonDocument>>>;
  readonly encode: (
    value: JsonValue,
    options?: ProcessingOptions & { readonly canonical?: boolean },
  ) => Promise<ProcessingResult<JsonResult<string>>>;
  /** Full operation envelope validation, including exact canonical saved params, runs in worker. */
  readonly decodeHttp: (
    bytes: Uint8Array,
    options: ProcessingOptions & {
      readonly budget: "ordinary" | "operation";
      readonly operation: boolean;
    },
  ) => Promise<ProcessingResult<HttpDecode>>;
  readonly admitPreparation: (
    preparation: Preparation,
    options?: Pick<ProcessingOptions, "signal">,
  ) => Promise<ProcessingResult<PreparationAdmission>>;
  readonly observeOperation: (
    operation: Operation,
    options?: Pick<ProcessingOptions, "signal">,
  ) => Promise<ProcessingResult<OperationObservation>>;
  readonly project: (
    capture: CapturedPayload,
    selection?: FormatSelection,
    options?: Pick<ProcessingOptions, "signal">,
  ) => Promise<ProcessingResult<ProjectionResult>>;
  /** Idempotent. Does not execute/retry/recover an operation or stop a companion/daemon. */
  readonly dispose: () => void;
}

export interface ProtocolWorkerPort {
  readonly listen: (
    receive: (message: unknown) => void,
    failed: (error: Error) => void,
  ) => () => void;
  readonly send: (message: unknown, transfer?: Transferable[]) => void;
  readonly terminate: () => void;
}
export type ProtocolWorkerFactory = () => ProtocolWorkerPort;
