import type { ProtocolProcessor, ProcessingResult } from "../../../core/protocol/worker";
import type { CapturedPayload, FormatSelection, ProjectionResult } from "./types";
/** Browser entry: expensive parsing/recognition/projection remains inside the owned worker. */
export async function projectCapturedPayloadAsync(
  processing: ProtocolProcessor,
  capture: CapturedPayload,
  selection: FormatSelection = "auto",
  signal?: AbortSignal,
): Promise<ProcessingResult<ProjectionResult>> {
  const result = await processing.project(
    capture,
    selection,
    signal === undefined ? undefined : { signal },
  );
  // Original capture is authoritative and retains its exact bytes/object identity.
  return result.ok ? { ok: true, value: Object.freeze({ ...result.value, capture }) } : result;
}
