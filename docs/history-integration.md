# Harness conversation history integration

Workgraph preserves observable session events and retrieves complete retained searchable text. The harness supplies events, searchable text and scoped tool access. It owns model calls, prompt assembly, tokenizer budgets, summaries, context eviction, process execution and external side effects. Recording a transcript does not publish it to collaborators, authenticate an actor or guarantee that a provider can replay the preserved payload.

Run the Python standard-library reference adapter against an existing daemon:

```sh
python3 examples/history-adapter.py /absolute/daemon.sock \
  /absolute/observable.jsonl /absolute/ingest-cursor.json \
  --workspace workspace-id --session conversation --ticket ticket-id
```

Each input line describes a completed observable event by default. Supply a stable `source_id`, `role`, `kind`, `phase`, optional tool `correlation`, and either `payload` (JSON) or `payload_base64` (opaque bytes). `searchable_text` supplies complete supported UTF-8 text; absent text is explicitly unsearchable. The adapter preserves JSON payloads as canonical JSON bytes and base64 payloads byte-for-byte. It records the phase supplied by an external harness, including explicit partial lifecycle observations; it does not infer provider lifecycle semantics.

```json
{"source_id":"provider-message-42","role":"tool","kind":"tool_result","correlation":"call-7","payload":{"output":"A requirement near the end of a long result"},"searchable_text":"A requirement near the end of a long result"}
```

The adapter syncs an exact pending append request before sending it and advances its synced ingest cursor only after receiving `durable:true` and the session `through` watermark. A crash after acknowledgement but before cursor persistence retries the same request; receipt identity and source-event identity prevent duplicates. Keep the observable source and cursor durable until ingestion resumes. The adapter rejects changed/truncated acknowledged source prefixes rather than silently ingesting a different conversation. Large opaque bodies can use an already installed blob reference through the typed protocol; the example adapter intentionally rejects requests beyond the existing 4MiB framing budget rather than implementing provider upload policy.

The adapter publishes a small ordinary `recovery-index` resource containing workspace, session, ticket, note and retrieval instructions. Retain these references and active harness instructions after a reset. The index is a bootstrap record; it does not reconstruct context automatically.

Session mutations are `session.create`, `session.archive` and `session.append`; planning workspace revisions are independent of session event sequences. A session can link local entity scopes and an already committed parent/fork event. An archived session remains readable and searchable. Appending history acknowledges its own journal commit; subsequently publishing a note/reference is a separate planning transaction. Failure between these commits leaves recoverable history, without cross-stream atomicity.

Retrieve metadata with `session.get`, `session.list`, `history.get` or `history.read` (`before`, `after`, `around`). `history.search` returns stable `{session_id,sequence}` references, snippets and UTF-8 byte offsets, with event-kind filtering. Search text includes the entire supported text blob, including content beyond the current resource search prefix. `history.payload` expands payload, searchable text or an attachment into base64 chunks with `next_offset` and `has_more`; metadata retrieval does not silently truncate preserved payloads.

Read/search results expose a captured history `head`; send this head on later pages to exclude concurrent appends. Session sequences start at one, while an `after` read can start at anchor zero. Read limits are 1..100 metadata records; query budgets are 4KiB..1MiB. Payload chunks are at most 256KiB and are reduced to fit the requested result budget. Workgraph counts bytes; the harness decides tokenizer budgets and which results enter model context.

Search coverage reports `indexed_through` and `committed_through` per session, `unindexed_events`, and `unsearchable_events`. When coverage is incomplete, `restart_after_indexing:true` and `next:null` require restarting the search after indexing catches up. An empty partial response never establishes absence. Rebuildable local indexes are secondary; acknowledged journal events and blob bytes are authoritative and readable immediately.

Session history uses immutable journal batches and synced atomic HEAD publication. Recovery ignores uncommitted orphan tails and detects canonical/hash/blob inconsistencies. An uncertain publication fences that persistence owner until recovery. Retained metadata and file size limits are safety ceilings, not demonstrated capacity claims. The first history release retains all acknowledged events; exhaustion rejects new work and never silently deletes events. Exports capture one planning revision plus the immutable history head/session vector and associated blobs; the exporter writes frozen HEAD bytes rather than copying a mutable live HEAD.

Run the external deterministic reset demonstration after building the executable:

```sh
./dev build bin/main.exe
python3 examples/history-recovery-demo.py _build/default/bin/main.exe
```

The driver starts a local daemon, records a requirement, a 300KiB tool result and a later correction, deliberately terminates the adapter after a durable acknowledgement, resumes it, and clears its simulated active context twice, recording a correction between resets. It expands a matching tool call and result using their shared correlation. It compares a saved agent note with selective history recovery, reports retrieval calls/response bytes, verifies the correction and retrieves a fact beyond 64KiB. This is a correctness fixture, not a live-model efficiency result. No model credentials, remote index, embeddings or first-party MCP are required.

| Operation | Owner and commit boundary | Failure and retry |
| --- | --- | --- |
| Create/archive session | Dispatcher validation; persistence owner commits one history batch and HEAD | Retry exact actor-scoped mutation ID; invalid scopes/fork refs reject |
| Append events | Persistence owner installs referenced bytes, immutable batch, then synced HEAD | Lost acknowledgement retries same request; changed event IDs/content conflict; uncertain owner fences |
| Read event/payload | Worker reads pinned immutable capture and blob ranges | Capture excludes later events; unsupported/outside references reject; preserved bytes remain authoritative |
| Search history | Bounded worker rebuilds derived local text index and searches fixed capture | Coverage and unsearchable parts are explicit; incomplete search restarts after indexing |
| Publish note/recovery index | Existing planning transaction after history acknowledgement | Independent receipt; failure leaves committed history available for recovery |
| Export/restore history | Serialized planning revision/history capture; worker verifies immutable inventory and frozen HEAD bytes | Exact captured heads survive retries; missing/corrupt hashes or references reject admission |
