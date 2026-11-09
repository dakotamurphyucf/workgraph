import type { TicketComment } from "./types";
/** Merge overlapping pages and live updates without allowing an older captured
 * revision to undo an edit or tombstone. Stable creation order reads as a thread. */
export function mergeCommentTimeline(
  ...sources: readonly (readonly TicketComment[])[]
): readonly TicketComment[] {
  const comments = new Map<string, TicketComment>();
  for (const source of sources)
    for (const item of source) {
      const old = comments.get(item.id);
      if (!old || BigInt(item.revision) > BigInt(old.revision)) comments.set(item.id, item);
    }
  return [...comments.values()].sort((a, b) =>
    BigInt(a.sequence) < BigInt(b.sequence)
      ? -1
      : BigInt(a.sequence) > BigInt(b.sequence)
        ? 1
        : a.id.localeCompare(b.id),
  );
}
