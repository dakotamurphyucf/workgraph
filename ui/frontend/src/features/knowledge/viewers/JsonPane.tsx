import { useEffect, useMemo, useState } from "react";
import { Button, Toolbar } from "../../../components/Primitives";
import type { ContentSource } from "../../../content/types";
import type { JsonTree, ViewerResult, ViewerWorker } from "./types";
import { VIEWER_LIMITS as L } from "./limits";
export function JsonPane({
  source,
  worker,
  description = "Explore the file’s fields using the arrows. Numbers are shown exactly as saved. Open Original file and display options below to read or copy the source.",
}: {
  readonly description?: string;
  readonly source: ContentSource;
  readonly worker: ViewerWorker;
}) {
  const [navigation, setNavigation] = useState<{
    readonly source: ContentSource;
    readonly expanded: readonly string[];
    readonly offset: number;
  }>({ source, expanded: [], offset: 0 });
  const expanded = useMemo(
    () => (navigation.source === source ? navigation.expanded : []),
    [navigation, source],
  );
  const offset = navigation.source === source ? navigation.offset : 0;
  const [state, setState] = useState<{
    readonly source: ContentSource;
    readonly expanded: readonly string[];
    readonly offset: number;
    readonly result: ViewerResult<JsonTree>;
  } | null>(null);
  const [unexpected, setUnexpected] = useState<{
    readonly source: ContentSource;
    readonly error: unknown;
  } | null>(null);
  const expansionKey = JSON.stringify(expanded);
  useEffect(() => {
    const abort = new AbortController();
    const captured = expanded;
    void worker
      .json(source, captured, offset, abort.signal)
      .then((result) => {
        if (!abort.signal.aborted) setState({ source, expanded: captured, offset, result });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) setUnexpected({ source, error });
      });
    return () => abort.abort();
  }, [source, worker, expanded, offset]);
  if (unexpected?.source === source) throw unexpected.error;
  // Keep the last tree mounted while the worker computes an expansion. Replacing
  // it with a loading line collapses the scroll container and loses the reader's place.
  const result = state?.source === source ? state.result : null;
  const pending =
    state?.source !== source ||
    JSON.stringify(state.expanded) !== expansionKey ||
    state.offset !== offset;
  const displayedOffset = result?.ok ? result.value.offset : offset;
  const occurrences = new Map<string, number>();
  function toggle(pointer: string, depth: number) {
    const key = depth < 2 ? `!${pointer}` : pointer;
    setNavigation({
      source,
      expanded: expanded.includes(key)
        ? expanded.filter((p) => p !== key)
        : [...expanded, key].slice(-L.expandedPointers),
      offset,
    });
  }
  return (
    <section aria-label="Lossless JSON tree" className="wg-rich-json" aria-busy={pending}>
      <p className="wg-hint">{description}</p>
      {!result ? (
        <p role="status">Parsing bounded JSON…</p>
      ) : !result.ok ? (
        <p role="alert">
          <strong>{result.kind}</strong>: {result.message}
        </p>
      ) : (
        <>
          <div role="list" aria-label="JSON fields">
            {result.value.rows.map((row, index) => {
              const identity = row.pointer ?? `unaddressable:${displayedOffset + index}`;
              const occurrence = occurrences.get(identity) ?? 0;
              occurrences.set(identity, occurrence + 1);
              return (
                <div
                  role="listitem"
                  key={`${identity}:${occurrence}`}
                  className="wg-json-row"
                  style={{ paddingInlineStart: `${Math.min(row.depth, 16) * 16}px` }}
                >
                  {row.children > 0 ? (
                    <Button
                      aria-expanded={row.expanded}
                      disabled={row.pointer === null || pending}
                      aria-label={`${row.expanded ? "Collapse" : "Expand"} ${row.label}`}
                      onClick={() => {
                        if (row.pointer !== null) toggle(row.pointer, row.depth);
                      }}
                    >
                      {row.expanded ? "▾" : "▸"}
                    </Button>
                  ) : (
                    <span aria-hidden="true" className="wg-json-spacer" />
                  )}
                  <code
                    className="wg-json-name"
                    title={
                      row.pointer ??
                      "Path exceeds the bounded pointer limit; exact source is retained."
                    }
                  >
                    {row.label}
                  </code>
                  <span className={`wg-json-value wg-json-value--${row.type}`}>{row.preview}</span>
                  <span className="wg-json-type">
                    {row.type}
                    {row.pointer === null && row.children > 0 ? " · pointer limit; use Source" : ""}
                  </span>
                </div>
              );
            })}
          </div>
          <Toolbar label="JSON rows">
            <span>
              {result.value.totalRows === 0 ? 0 : displayedOffset + 1}–
              {displayedOffset + result.value.rows.length} of {result.value.totalRows} expanded rows
            </span>
            <Button
              disabled={pending || offset === 0}
              onClick={() =>
                setNavigation({ source, expanded, offset: Math.max(0, offset - L.jsonRows) })
              }
            >
              Previous JSON rows
            </Button>
            <Button
              disabled={pending || offset + result.value.rows.length >= result.value.totalRows}
              onClick={() => setNavigation({ source, expanded, offset: offset + L.jsonRows })}
            >
              Next JSON rows
            </Button>
          </Toolbar>
        </>
      )}
    </section>
  );
}
