import { DEFAULT_JSON_LIMITS, type JsonLimits, type JsonValue } from "../../json";
import type { Operation, Preparation } from "../types";
import type { CapturedPayload, FormatSelection } from "../../../features/history/formats/types";
export const HTTP_LIMITS: JsonLimits = Object.freeze({ ...DEFAULT_JSON_LIMITS, maxDepth: 96 });
export const OPERATION_LIMITS: JsonLimits = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxDepth: 96,
  maxNodes: 400_000,
  maxStringBytes: 16 * 1024 * 1024,
});
export const PROCESSING_LIMITS = Object.freeze({
  active: 1,
  // Page reads and an open selector can enqueue a burst of small decoding jobs.
  // The aggregate byte reservation below still bounds retained input.
  queued: 64,
  admittedBytes: 32 * 1024 * 1024,
  deadlineMs: 30_000,
});
export type ProcessingJob =
  | { readonly kind: "parse"; readonly source: string | Uint8Array; readonly limits: JsonLimits }
  | {
      readonly kind: "encode";
      readonly value: JsonValue;
      readonly limits: JsonLimits;
      readonly canonical: boolean;
    }
  | {
      readonly kind: "http";
      readonly bytes: Uint8Array;
      readonly budget: "ordinary" | "operation";
      readonly operation: boolean;
    }
  | { readonly kind: "admit"; readonly preparation: Preparation }
  | { readonly kind: "observe"; readonly operation: Operation }
  | {
      readonly kind: "project";
      readonly capture: CapturedPayload;
      readonly selection: FormatSelection;
    };
