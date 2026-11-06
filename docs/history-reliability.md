# History reliability and bounded retrieval

Workgraph keeps conversation history separately from planning transactions. The
harness imports events; Workgraph retains exact payload bytes, metadata and
immutable history captures. This design supports local agent teams and transcript
viewers without a separate database service.

## Parallel execution and parser ownership

The daemon uses OCaml 5 domains. Its planning dispatcher serializes state changes,
but storage and read workers execute concurrently. JSON decoding therefore creates
an independent parser for every invocation, including number validation. The pinned
Jsonaf default parser retains mutable parsing state and must not be called directly
from concurrent production code. `Json.parse` and `Json.parse_with_limit` retain the
existing depth, size, duplicate-key, UTF-8 and finite-number checks.

Mutable worker state has one domain owner. Captures shared across domains are
immutable. Returned values and completion messages transfer results without sharing
mutable parsers, maps or index handles. See [engineering standards](../engineering-standards.md).

## Captured reads and worker admission

Omitting `head` captures current committed history. Supplying a digest selects that
exact ancestor; supplying JSON null selects empty history. Subsequent transcript
pages and payload reads should use the returned head so concurrent imports cannot
change the selected history.

The current head reuses the verified in-memory capture. Previously resolved heads
can reuse an immutable capture cache. Cold historical reconstruction validates the
history chain and referenced blobs on a read worker, rather than making the
serialized dispatcher wait for complete replay.

History reads use two independent bounded lanes:

- Current or cached metadata and payload reads.
- Searches and cold historical reconstruction.

Each lane admits at most 16 outstanding operations, including running, queued and
completed operations awaiting dispatcher cleanup. All searches execute on one lane
with a worker-owned index. Each worker retains indexes for at most eight roots;
index eviction does not alter committed history. Each job pins its workspace against close or restore
until completion. Writes use the serialized persistence path rather than those
read slots. This isolates search/reconstruction backlogs from ordinary captured
reads and planning/history writes; it does not promise equal service per client.

When a lane is full, the read fails with a retryable `Conflict`. Clients should
bound concurrency and retry reads with backoff, not spin or launch more readers.
A client timeout is not evidence that a write failed: preserve the exact saved
mutation request and follow the normal uncertain-write procedure.

The dispatcher and each read worker retain at most eight cache entries, each cache
with a 16 MiB weighted-metadata budget. Cache keys include workspace, root open
generation and exact head. The accounting is a retention heuristic, not a heap
limit; current journal state and queued captures also use memory. Oversized
captures remain readable but bypass the cache. Reopening a root cannot reuse
another generation's cache entry. Idle cache entries do not keep roots pinned.

A payload read still verifies its complete referenced blob before returning a
range. Small requested ranges can therefore involve more disk I/O than their
returned byte count. Hash verification remains part of the integrity contract.

## Transcript pages and content

`history.read` returns bounded event metadata. Pass its event references to
`history.payloads` to retrieve primary payload prefixes for up to 100 events under
one head. Results preserve request order and duplicates; every requested reference
is represented. The response byte budget covers the entire public result,
including metadata and Base64 expansion.

Each item's payload reports `offset`, `next_offset`, `total_bytes` and `has_more`.
Continue partial items through `history.payload` with the same head, event reference
and returned next offset. A small budget can return an empty prefix with
`has_more: true`; this is not an empty source payload. If all item metadata cannot
fit, the request fails explicitly. Missing event references fail the whole batch.
Attachments and searchable-text ranges remain available through `history.payload`.

## Search coverage versus pagination

`history.search` reports `index_complete` for index coverage and `has_more` for
continued traversal. These are independent questions. An incomplete index is not
proof that no matching event exists; `restart_after_indexing` requires restarting
the search after indexing rather than continuing beyond missing events.

A terminal search page has `has_more: false` and `next: null`. Nonterminal complete
index pages supply an exact next event position. CLI continuation metadata follows
the same decision. Search returns one hit per matching event; it does not claim to
return every occurrence inside an event payload.

## Session and run views

Session metadata records nullable `created_at_unix_ms` and
`last_event_at_unix_ms`. New daemon operations supply observed Unix epoch
milliseconds. Last-event time changes only when new events commit; retries,
deduplicated imports and archiving do not invent new activity. Clock regressions
are preserved, so timestamps do not establish causal ordering.

`session.list` supports ID order, newest creation or newest last-event order, with
unknown times last and session-ID tie breaking. An explicit run filter selects
session metadata naming that run; a context's writer run is never silently applied
as a read filter. Original transcript/provider timestamps remain opaque source
content and are distinct from Workgraph ingestion times.

Run read views combine explicit `run.link_session` links with sessions whose
metadata names the run. This reverse association is derived from captured history;
it does not add a second write to session creation or change the stored run
revision. Bounded previews report omitted associations and provide a continuation.
`run.sessions` traverses the full union using both an exact history head and run
revision. Planning resume records retain their stored explicit links; use the run
read views for derived history associations. Association reads may omit the history
capture's session-watermark vector: omission means not included, not an empty
workspace.

## Compact usage

`usage.aggregate` accepts `metrics_layout`: `rows` (the existing default), `nested`
(one complete metrics array per group), or `totals_only` (group summaries without
metric detail). Nested groups preserve metric names, units and overflow state and
are never silently clipped. If a complete group exceeds the budget, increase the
budget according to the response or select a less detailed layout. Continuations
bind the selected layout, filters and captured revision.

## Upgrades

The new timestamp representation requires explicit migration from the supported
0.6.2-era workspace format. Earlier preview formats are not supported. Migration
writes a new workspace root and preserves the source; it does not upgrade an active
daemon in place. Old creation/activity times are unknown and remain null. Historical
head digests change as batches are translated; event identities and payload bytes
remain intact. Follow the release's migration instructions for source shutdown,
verification, new registry/context setup and saved-request handling.
