export const CONTENT_LIMITS = Object.freeze({
  inputBytes: 16 * 1024 * 1024,
  richBytes: 2 * 1024 * 1024,
  richLines: 100_000,
  nodes: 250_000,
  depth: 96,
  highlightBytes: 2 * 1024 * 1024,
  highlightLines: 100_000,
  sourceLines: 200,
  lineCharacters: 4_096,
  windowCharacters: 64 * 1024,
  rawBytes: 4_096,
  deadlineMs: 10_000,
  sliceMs: 2_000,
  workers: 2,
  pending: 24,
  waiting: 128,
  admittedBytes: 32 * 1024 * 1024,
});
export class PreviewBudget extends Error {
  override name = "PreviewBudget";
}
/** Limits synchronous phases in the worker; main-side watchdog also terminates a stalled phase. */
export function phase<T>(action: () => T): T {
  const started = performance.now();
  const result = action();
  if (performance.now() - started > CONTENT_LIMITS.sliceMs)
    throw new PreviewBudget(`Preview phase exceeded its ${CONTENT_LIMITS.sliceMs}ms work budget.`);
  return result;
}

/** Render DTO nodes and syntax nodes share one aggregate depth/node budget. Root depth is zero. */
export class RenderBudget {
  private nodes = 0;
  consume(depth: number): boolean {
    this.nodes += 1;
    return this.nodes <= CONTENT_LIMITS.nodes && depth <= CONTENT_LIMITS.depth;
  }
}
