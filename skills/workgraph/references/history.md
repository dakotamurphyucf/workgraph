# Sessions and retained conversation history

Read [the shared CLI and wire contract](cli-contract.md) before constructing requests.
Return to [the capability guide](../SKILL.md) to choose another reference. Unless a
result is explicitly shown as a complete envelope, it describes `result.data`; receipt,
query and capture metadata are in `result.meta`. These are the current preview
contracts, not compatibility guarantees for previously published previews.

## What sessions retain

A **session** is a named sequence of conversation observations supplied by an external
agent or its **harness**: the program that calls a model, runs tools and chooses
context. An observation can be a message, tool call, tool result or another
caller-defined event. Workgraph stores what the harness supplies. The harness still owns
provider calls, payload conversion, searchable-text selection, context assembly and
eviction. Recording a session does not publish a team discussion or guarantee provider
replay.

Session mutations commit to a separate **history journal**, an append-only record of
session changes. They do not advance the planning workspace revision used by tickets and
resources. Referencing a committed history event from a later planning mutation requires
a second commit; there is no atomic commit spanning both journals. Preserve source IDs
and wait for `result.meta.durable: true` before evicting the only copy of an
observation.

## Request fields and response locations

Every history mutation supplies `workspace_id`, `actor_id` and a stable `mutation_id`,
with optional `run_id` attribution. Every query supplies `workspace_id`. See [the CLI
contract](cli-contract.md) for saving the exact request before sending it and recovering
an uncertain response without changing its identity.

Omit absent optional arguments unless a nullable value is explicitly documented. Unknown
or duplicate fields reject. IDs are strings; counters, sequences, offsets, byte lengths
and limits are canonical nonnegative decimal strings, such as `"0"` or `"12"`. Session
IDs contain 1–96 ASCII letters, digits, underscores or hyphens.

Method results below describe `result.data`. Durable acknowledgements are in
`result.meta.durable`; immutable capture metadata is in `result.meta.history_capture`.
History results have neither a planning workspace revision nor a planning budget
omissions object.

## Shared record shapes

The following are JSON shapes. Descriptive placeholder strings identify fields; use real
IDs and digests when making requests.

### Entity references

An entity reference selects an existing workspace object. Its `kind` determines what the
ID names. The workspace itself needs no ID inside the reference.

```jsonl
{"kind":"workspace"}
{"kind":"project","id":"project-id"}
{"kind":"milestone","id":"milestone-id"}
{"kind":"ticket","id":"ticket-id"}
{"kind":"resource","id":"resource-id"}
```

### Event references

An event reference selects one committed observation by session ID and that session’s
event sequence. It does not name a planning revision.

```json
{
  "session_id": "conversation",
  "sequence": "1"
}
```

### Blob references

A blob reference identifies already installed bytes by SHA-256 digest and size. Use
[resource uploads](resources.md) to install a large payload before appending it.

```json
{
  "digest": "64 lowercase hexadecimal SHA-256 characters",
  "size_bytes": "byte count 0..67108864"
}
```

### Inline or blob content

Supply small bytes inline as Base64, or reference an installed blob. Payload bytes are
opaque; searchable text must decode to complete valid UTF-8.

```jsonl
{"kind":"inline","bytes_base64":"standard Base64 of opaque bytes"}
{"kind":"blob","blob":{"digest":"64 lowercase hexadecimal SHA-256 characters","size_bytes":"byte count"}}
```

### Session event input

```json
{
  "client_id": "stable-source-event-id",
  "role": "user",
  "kind": "message",
  "phase": "completed",
  "correlation": null,
  "provenance": null,
  "payload": {
    "kind": "inline",
    "bytes_base64": "UmVxdWlyZW1lbnQ6IEJMVUU="
  },
  "searchable_text": {
    "kind": "inline",
    "bytes_base64": "UmVxdWlyZW1lbnQ6IEJMVUU="
  },
  "resource_versions": [],
  "attachments": []
}
```

### Session event input rules

client_id, role, kind and phase are arbitrary nonempty valid UTF-8 strings, each 1..256
bytes; they are not validated enum arrays. Conventionally use role=user/assistant/tool,
kind=message/tool_call/tool_result, and phase=completed. Explicit partial lifecycle
observations are allowed; Workgraph does not infer provider lifecycle.

correlation is null or a UTF-8 string of at most 256 bytes. provenance is any JSON value
whose canonical JSON is at most 4096 bytes and whose container nesting depth is at most
32.

`payload` is required inline or blob content; its opaque bytes may be invalid UTF-8.
`searchable_text` is either null or inline/blob content containing complete valid UTF-8
text, never a prefix silently represented as complete. `attachments` is an array of at
most 100 blob references; each referenced blob must already be installed in this workspace. resource_versions is an
optional array of at most 100 objects {resource_id,revision}, where revision is a
content version string in 1..100000, not the resource metadata revision; referenced
versions must exist.

Each inline content value is at most 16MiB; sum of inline payload and searchable text over one
append is at most 16MiB. Blob content and attachments are at most 64MiB each.

Resolved scope/resource/session references never accept planning transaction aliases;
opaque provenance/payload values remain literal. The protocol's 4MiB request frame can
bind earlier than these library ceilings: stage larger content as resources using
uploads, then reference installed blobs.

### Session record

```json
{
  "workspace_id": "demo",
  "session_id": "conversation",
  "title": "Conversation",
  "actor_id": "harness",
  "run_id": null,
  "parent_event": null,
  "scopes": [
    {
      "kind": "ticket",
      "id": "task"
    }
  ],
  "archived": false
}
```

### Committed event

```json
{
  "event_ref": {
    "session_id": "conversation",
    "sequence": "1"
  },
  "identity_hash": "64 lowercase hexadecimal SHA-256 characters",
  "actor_id": "harness",
  "run_id": null,
  "event": {
    "client_id": "source-1",
    "role": "user",
    "kind": "message",
    "phase": "completed",
    "correlation": null,
    "provenance": null,
    "payload": {
      "kind": "blob",
      "blob": {
        "digest": "64 lowercase hexadecimal SHA-256 characters",
        "size_bytes": "17"
      }
    },
    "searchable_text": null,
    "resource_versions": [],
    "attachments": []
  }
}
```

### Immutable history capture

```json
{
  "workspace_id": "demo",
  "head": "immutable history journal SHA-256 or null",
  "sequence": "journal commit count",
  "sessions": [
    {
      "session_id": "conversation",
      "through": "last event sequence"
    }
  ]
}
```

## Capture and retention rules

A **capture** fixes which retained journal head and session event bounds a read sees.
Omitting query `head` captures current history. head as a 64-character lowercase digest
selects that retained immutable journal head. Explicit head:null selects the empty
history capture, not current history. Reuse returned meta.history_capture.head across
session-list/read/search pages and payload expansion; later appends cannot invalidate or
enter that capture.

The capture contains the complete session/head vector, which itself can exceed a small
budget. History query max_bytes defaults to "65536", range "4096".."1048576"; results
fit this byte budget or return Blocked, rather than using planning query text/array
truncation. Query limit is "1".."100". History queue admission is bounded to eight
active/queued queries; Conflict means retry after another query finishes.

The current retention contract retains every acknowledged event; capacity exhaustion
rejects new work with Blocked and deletes nothing. History journal is bounded to 1000000
commits, 4MiB per encoded batch and 64MiB retained encoded batch metadata.

Bytes referenced by events are durable before acknowledgement. Crash recovery excludes
orphan/unpublished tails and verifies referenced blobs; uncertain publication fences the
owner until recovery.

Exact actor-scoped mutation retries recover the original durable {data,meta} response;
changing method/arguments/run attribution under that key conflicts.

## `session.create`

[Complete request and result schema](api/session.create.md).

Supply the mutation fields `workspace_id`, `actor_id`, `mutation_id` and optional
`run_id`, followed by the method arguments below.

### Arguments

Required session_id, title (nonempty 1..512 UTF-8 bytes). Optional
parent_event=event reference of an already committed local event, scopes=[] array of at most
100 unique existing entity reference objects. Omit parent_event when absent; parent_event:null
is not accepted as an optional create argument. The stored actor and optional run come
from the mutation fields. Session ID is explicit and is not generated.

### Result

```json
{
  "session": "session record object",
  "through": "0"
}
```

### Behavior

A new session has no events; a fork stores a parent event reference, without copying its
ancestor events into this session. New mutation with an existing session ID returns
Conflict. Retry the original mutation after an uncertain response.

### Example

```json
{
  "workspace_id": "demo",
  "actor_id": "harness",
  "mutation_id": "create-session",
  "session_id": "conversation",
  "title": "Conversation",
  "scopes": [
    {
      "kind": "ticket",
      "id": "task"
    }
  ]
}
```

## `session.archive`

[Complete request and result schema](api/session.archive.md).

Supply the mutation fields `workspace_id`, `actor_id`, `mutation_id` and optional
`run_id`, followed by the method arguments below.

### Arguments

Required session_id.

### Result

```json
{
  "session": "session record with archived:true"
}
```

### Behavior

Retains all history and references; future append rejects with Conflict. There is no
unarchive method. Direct get/read/search and include_archived session-list remain
available.

### Example

```json
{
  "workspace_id": "demo",
  "actor_id": "harness",
  "mutation_id": "archive-session",
  "session_id": "conversation"
}
```

## `session.append`

[Complete request and result schema](api/session.append.md).

Supply the mutation fields `workspace_id`, `actor_id`, `mutation_id` and optional
`run_id`, followed by the method arguments below.

### Arguments

Required session_id and events array of 1..128 session event input objects. See complete
input schema above.

### Result

```json
{
  "session_id": "conversation",
  "through": "last committed event sequence",
  "events": [
    {
      "session_id": "conversation",
      "sequence": "1"
    }
  ]
}
```

### Behavior

Assigns consecutive server event sequences starting at one, preserves input order for
new events, and returns one event reference per input, including repeated existing
source IDs. Same client_id and identical event content in a session deduplicates even
with a new mutation ID; changed content returns Idempotency_conflict. Identity includes
role/kind/phase/correlation/provenance/resource references/attachments and exact
payload/text byte identity; an inline body and identical installed blob have the same
identity. The stored actor/run attribution remains that of the original committed event.
One append publishes its whole new batch or none. Archive prohibits new appends. through
is a session event sequence, distinct from meta.history_capture.sequence (history
journal commit count) and planning workspace_revision.

### Example

```json
{
  "workspace_id": "demo",
  "actor_id": "harness",
  "mutation_id": "append-source-1",
  "session_id": "conversation",
  "events": [
    {
      "client_id": "source-1",
      "role": "user",
      "kind": "message",
      "phase": "completed",
      "correlation": null,
      "provenance": {
        "adapter": "example"
      },
      "payload": {
        "kind": "inline",
        "bytes_base64": "UmVxdWlyZW1lbnQ6IEJMVUU="
      },
      "searchable_text": {
        "kind": "inline",
        "bytes_base64": "UmVxdWlyZW1lbnQ6IEJMVUU="
      },
      "resource_versions": [],
      "attachments": []
    }
  ]
}
```

## `session.get`

[Complete request and result schema](api/session.get.md).

Supply `workspace_id`, followed by the method arguments below. This is a read-only
query; it needs no actor or mutation identity.

### Arguments

Required session_id. Optional head, max_bytes.

### Result

```json
{
  "session": "session record object",
  "through": "last event sequence in capture"
}
```

### Behavior

Not_found if the session is absent from the selected capture. Archived sessions are
returned.

### Example

```json
{
  "workspace_id": "demo",
  "session_id": "conversation",
  "max_bytes": "65536"
}
```

## `session.list`

[Complete request and result schema](api/session.list.md).

Supply `workspace_id`, followed by the method arguments below. This is a read-only
query; it needs no actor or mutation identity.

### Arguments

Optional head, max_bytes, offset="0", limit="50", include_archived=false (JSON Boolean).

### Result

```json
{
  "items": [
    "session record objects"
  ],
  "next_offset": "offset plus returned item count",
  "has_more": false
}
```

### Behavior

Ordered by session ID; excludes archived sessions by default. For the next page use
next_offset with the same meta.history_capture.head and filters. Offset may be positive
without a head, but then each call takes a new capture, so use head for stable
pagination. Byte fitting may return fewer than limit. Capture/item that cannot fit
returns Blocked.

### Example

```json
{
  "workspace_id": "demo",
  "offset": "0",
  "limit": "50",
  "include_archived": true
}
```

## `history.get`

[Complete request and result schema](api/history.get.md).

Supply `workspace_id`, followed by the method arguments below. This is a read-only
query; it needs no actor or mutation identity.

### Arguments

Required event_ref=event reference. Optional head, max_bytes.

### Result

One committed event object directly in data; the selected capture is in
meta.history_capture. Use a previously returned head to pin the lookup.

### Behavior

Not_found for a missing session or event outside this capture. Payload bytes require
history.payload.

### Example

```json
{
  "workspace_id": "demo",
  "event_ref": {
    "session_id": "conversation",
    "sequence": "1"
  }
}
```

## `history.read`

[Complete request and result schema](api/history.read.md).

Supply `workspace_id`, followed by the method arguments below. This is a read-only
query; it needs no actor or mutation identity.

### Arguments

Required session_id and direction="before"|"after"|"around" (plain string). Optional
anchor="0", limit="50", head, max_bytes. Anchor must be between zero and the selected
session upper bound, inclusive.

### Result

```json
{
  "session_id": "conversation",
  "through": "upper event bound",
  "items": [
    "committed event objects"
  ],
  "has_more": false,
  "next_anchor": "last returned event sequence, or supplied anchor if empty",
  "omitted_for_budget": "count omitted from the selected limited page"
}
```

### Behavior

after excludes anchor and returns increasing sequences; continue after next_anchor with
the same head. before excludes anchor and returns decreasing sequences; continue before
next_anchor. around starts at max(1,anchor-floor(limit/2)) and returns up to limit
events in increasing order. To continue beyond an around page, use direction=after with
next_anchor; repeatedly applying around recenters and can overlap. For an empty session
anchor=0 is valid. Budget fitting may shorten a page; has_more means more candidates
remain, not incomplete index coverage. omitted_for_budget counts only the remaining
selected page candidates. An oversized capture/event returns Blocked.

### Example

```json
{
  "workspace_id": "demo",
  "session_id": "conversation",
  "direction": "around",
  "anchor": "1",
  "limit": "10",
  "max_bytes": "65536"
}
```

## `history.search`

[Complete request and result schema](api/history.search.md).

Supply `workspace_id`, followed by the method arguments below. This is a read-only
query; it needs no actor or mutation identity.

### Arguments

Required text (nonempty valid UTF-8, at most 256 bytes). Optional session_id (otherwise
all captured sessions), kinds=array of exact event kind strings, after_event=event reference,
limit="50", max_bytes, head. Omit absent filters; null is not equivalent to omission.

### Result

```json
{
  "items": [
    {
      "event_ref": {
        "session_id": "conversation",
        "sequence": "1"
      },
      "kind": "message",
      "role": "user",
      "byte_offset": "0",
      "snippet": "Requirement: BLUE"
    }
  ],
  "next": null,
  "restart_after_indexing": false,
  "has_more": false,
  "coverage": [
    {
      "session_id": "conversation",
      "committed_through": "1",
      "indexed_through": "1"
    }
  ],
  "complete": true,
  "unindexed_events": "0",
  "unsearchable_events": "0",
  "omitted_for_budget": "0"
}
```

### Behavior

Searches the complete adapter-supplied searchable text blob with case-insensitive
substring matching (ASCII lowercase transformation, not Unicode case folding), one hit
per event at its first matching byte offset. Snippets are UTF-8-safe prefixes of at most
512 bytes. Ordering is session ID then sequence, not wall-clock order across sessions.
after_event is exclusive in this ordering, must exist in the capture, and next is the
last scanned reference, which may be a nonmatching event; use next, not the last hit.
Continue only when has_more=true with unchanged head/text/session/kinds. coverage lists
every captured session, even with a session filter; unsearchable/unindexed counts apply
to the filtered set. complete=true means filtered events have been indexed, not that
every opaque payload is searchable or that pagination is exhausted. No searchable_text
contributes to unsearchable_events. If complete=false/restart_after_indexing=true,
next=null: restart from the beginning after indexing; an empty partial result proves no
absence. The daemon rebuilds/updates its derived disk index before each search; there is
no separate public history-index wait method. Source journal/blobs remain authoritative.
Expand a hit using history.read and history.payload with meta.history_capture.head.

### Example

```json
{
  "workspace_id": "demo",
  "session_id": "conversation",
  "text": "Requirement",
  "kinds": [
    "message",
    "tool_result"
  ],
  "limit": "10",
  "max_bytes": "65536"
}
```

## `history.payload`

[Complete request and result schema](api/history.payload.md).

Supply `workspace_id`, followed by the method arguments below. This is a read-only
query; it needs no actor or mutation identity.

### Arguments

Required event_ref=event reference. Optional
part={kind:"payload"}|{kind:"searchable_text"}|{kind:"attachment",index:"0"} (default
payload; attachment index is zero-based in 0..99), offset="0", length="32768"
(0..262144), max_bytes, head. Offset is a byte offset in 0..total_bytes.

### Result

```json
{
  "blob": {
    "digest": "64 lowercase hexadecimal SHA-256 characters",
    "size_bytes": "total byte count"
  },
  "offset": "requested offset",
  "bytes_base64": "Base64 chunk",
  "next_offset": "offset plus returned byte count",
  "total_bytes": "complete blob byte count",
  "has_more": false
}
```

### Behavior

Retrieves exact opaque payload, searchable UTF-8 text, or attachment bytes from the
immutable capture. Missing searchable text or attachment returns Not_found. Actual chunk
length is the largest prefix up to the requested length and remaining bytes that fits
the complete data/meta response; an oversized capture or insufficient space for one
requested byte returns Blocked; follow next_offset while has_more=true. next_offset is
always a decimal string, including EOF, unlike resource.read_chunk's nullable EOF
cursor. Zero length is accepted and may produce has_more=true without advancing; request
a positive length for retrieval loops. Verify assembled bytes against
blob.digest/size_bytes when materializing a complete file. Metadata alone never
substitutes for preserved bytes.

### Example

```json
{
  "workspace_id": "demo",
  "event_ref": {
    "session_id": "conversation",
    "sequence": "1"
  },
  "part": {
    "kind": "payload"
  },
  "offset": "0",
  "length": "4096",
  "max_bytes": "65536"
}
```

## Minimal recording and retrieval workflow

After [setting up a workspace and agent context](getting-started.md), set these to its
existing paths. `WG` is the executable; `CONTEXT` contains socket, workspace, actor and
request-directory defaults. The request directory must exist and each new write needs a
fresh journal filename.

```sh
WG=/absolute/path/to/workgraph
CONTEXT=/absolute/private/agent/context.json
REQUESTS=/absolute/private/agent/requests

"$WG" --context "$CONTEXT" request session.create \
  --session-id conversation --title 'Conversation' \
  --save-request "$REQUESTS/create-conversation.json"

"$WG" --context "$CONTEXT" request session.append \
  --session-id conversation \
  --json-field events '[{"client_id":"source-1","role":"user","kind":"message","phase":"completed","payload":{"kind":"inline","bytes_base64":"UmVxdWlyZW1lbnQ6IEJMVUU="},"searchable_text":{"kind":"inline","bytes_base64":"UmVxdWlyZW1lbnQ6IEJMVUU="}}]' \
  --save-request "$REQUESTS/append-source-1.json"

"$WG" --context "$CONTEXT" request history.read \
  --session-id conversation --direction after --anchor 0 --limit 10
```

The Base64 example represents `Requirement: BLUE`. Check each write's durable receipt.
Save the read's `result.meta.history_capture.head`; send that exact `head` in later
pages and payload reads. For a lost write response, use `workgraph retry` with the saved
request rather than constructing another append. For an adapter implementation, see
[history-adapter.py](../scripts/history-adapter.py); inspect its configuration before
using it with an existing harness.
