export const VIEWER_LIMITS = Object.freeze({
  jsonBytes: 4 * 1024 * 1024,
  jsonRows: 2_000,
  expandedPointers: 2_000,
  imageBytes: 8 * 1024 * 1024,
  imageEdge: 8_192,
  imagePixels: 16_000_000,
  textBytes: 256 * 1024,
  textLines: 10_000,
  comparisonCells: 1_000_000,
  changes: 2_000,
  labelCharacters: 4_096,
  deadlineMs: 2_000,
  sliceMs: 100,
  activeJobs: 2,
  admittedBytes: 32 * 1024 * 1024,
});
export class ViewerProblem extends Error {
  override name = "ViewerProblem";
  constructor(
    readonly kind: "malformed" | "unsupported" | "budget",
    message: string,
  ) {
    super(message);
  }
}

/** The existing lossless parser is synchronous inside a bounded worker phase. An
 * overrun is checked after return; the main stage watchdog can terminate it. */
export function viewerPhase<T>(action: () => T): T {
  const started = performance.now();
  const value = action();
  if (performance.now() - started > VIEWER_LIMITS.sliceMs)
    throw new ViewerProblem(
      "budget",
      "Viewer phase exceeded its 100ms processing budget. Source and verified download remain available.",
    );
  return value;
}
