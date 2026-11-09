import type {
  FormatCoverage,
  FormatCoverageEntry,
  FormatFallbackCount,
  FormatMatchCount,
} from "./coverage.types";
/** Summarize only admitted projections for payloads actually loaded in this window. */
export function formatCoverage(entries: readonly FormatCoverageEntry[]): FormatCoverage {
  let loaded = 0,
    partial = 0,
    matched = 0,
    explicitGeneric = 0,
    unsupported = 0,
    ambiguous = 0,
    pending = 0,
    unloaded = 0;
  const matches = new Map<string, FormatMatchCount>();
  const fallbacks = new Map<FormatFallbackCount["reason"], number>();
  for (const entry of entries) {
    if (entry.payload === "unloaded") {
      unloaded++;
      continue;
    }
    loaded++;
    if (entry.payload === "partial") partial++;
    const result = entry.projection;
    if (result === null) {
      pending++;
      continue;
    }
    switch (result.status) {
      case "recognized": {
        matched++;
        const previous = matches.get(result.adapter.id);
        matches.set(result.adapter.id, {
          adapter: result.adapter,
          count: (previous?.count ?? 0) + 1,
          shapeOnly:
            (previous?.shapeOnly ?? 0) + (result.recognition === "validated-shape" ? 1 : 0),
          producerPinned:
            (previous?.producerPinned ?? 0) + (result.recognition === "producer-pinned" ? 1 : 0),
        });
        break;
      }
      case "generic":
        explicitGeneric++;
        break;
      case "unsupported":
        unsupported++;
        fallbacks.set(result.reason, (fallbacks.get(result.reason) ?? 0) + 1);
        break;
      case "ambiguous":
        ambiguous++;
        break;
    }
  }
  return {
    windowEvents: entries.length,
    loaded,
    partial,
    matched,
    explicitGeneric,
    unsupported,
    ambiguous,
    pending,
    unloaded,
    matches: [...matches.values()],
    fallbacks: [...fallbacks].map(([reason, count]) => ({ reason, count })),
  };
}
