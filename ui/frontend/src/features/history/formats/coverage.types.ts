import type { AdapterDescriptor, ProjectionResult } from "./types";

/** One event in the currently captured window, never an inferred session-wide scan. */
export interface FormatCoverageEntry {
  readonly payload: "unloaded" | "partial" | "complete";
  readonly projection: ProjectionResult | null;
}
export interface FormatMatchCount {
  readonly adapter: AdapterDescriptor;
  readonly count: number;
  readonly shapeOnly: number;
  readonly producerPinned: number;
}
export interface FormatFallbackCount {
  readonly reason: Extract<ProjectionResult, { readonly status: "unsupported" }>["reason"];
  readonly count: number;
}
/** Local bounded counts, not daemon totals or a completeness/producer guarantee. */
export interface FormatCoverage {
  readonly windowEvents: number;
  readonly loaded: number;
  readonly partial: number;
  readonly matched: number;
  readonly explicitGeneric: number;
  readonly unsupported: number;
  readonly ambiguous: number;
  readonly pending: number;
  readonly unloaded: number;
  readonly matches: readonly FormatMatchCount[];
  readonly fallbacks: readonly FormatFallbackCount[];
}
