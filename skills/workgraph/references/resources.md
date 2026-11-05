# Resources and file transfers

Read [the CLI and wire contract](cli-contract.md) for request construction and retries.
Return to [the capability guide](../SKILL.md) to choose another workflow. Each daemon
method below links its authoritative generated request/result contract in [the API
reference](api/index.md). The upload/download CLI helpers are local orchestration, with
their own contracts here.

## What a resource stores

A **resource** is a named attachment in a workspace: notes, a patch, a command log or
binary file. Its metadata includes its title and links to tickets or other recorded
entities. Publishing content creates an immutable version: later edits cannot change
those bytes. The **harness** is the external caller that chooses what to publish and
what to include in an agent's context.

There are two independent revisions. The resource's **metadata revision** guards updates
against concurrent edits. A **content-version revision** selects retained bytes. For
example, changing a title advances metadata revision while leaving content version `"1"`
unchanged. An evidence pin therefore records the resource ID, content version and
SHA-256 digest, rather than just the latest metadata revision.

## Choose how to publish

Use resource.put_text for at most 65536 UTF-8 bytes. Use raw upload staging or the
resource upload CLI helper for larger text or arbitrary binary bytes, up to 64MiB.
Resources are immutable content versions plus editable metadata. Every metadata/content
mutation uses the current resource metadata `expected_revision`; "0" creates a resource.
Metadata edits, links and archive changes increment metadata revision without creating
content versions. Publication increments content-version revision independently and
captures exact bytes/digest/size/filename/MIME/actor/timestamp. For evidence, pin
version.revision and digest, not resource.revision. Keep returned generated resource
IDs. resource.put_text requires title on creation. On update, omitted title preserves
the current title after checking the exact metadata revision; an explicit blank title
rejects. Omitted filename/MIME preserve current metadata on update. Logical filenames
are basenames, not filesystem paths. MIME types are type/subtype without parameters.
Consult the generated contract for validation limits. Archive hides resources from
ordinary lists, retains all bytes/versions/links and permits direct reads/history.
Unarchive before publishing new content. Links make metadata visible in target contexts
without loading bytes. Publishing does not itself update a ticket handoff, discussion
request or model prompt; the harness chooses context and side effects.

### Publish small text and link a ticket atomically

Use the local `resource publish_text` helper for text up to 65536 UTF-8 bytes when
publication and a ticket link must succeed together:

```sh
workgraph --context /absolute/agent.json resource publish_text \
  --ticket-id task --resource-id findings --expected-revision 0 \
  --title Findings --field-file text /absolute/findings.md \
  --save-request /absolute/new-request.json
```

The helper expands to one `transaction.apply`: `resource.put_text` at the supplied
metadata revision, followed by `resource.link` at that revision plus one. A missing
ticket, stale revision or already existing link fails the whole transaction without
publishing content or changing metadata. To update text that is already linked to the
same ticket, use `resource.put_text` with the current metadata revision; it preserves
existing links. Do not unlink a resource just to use this helper. Omit resource-id to generate an ID on
creation; keep the returned ID. Title is required on creation; omitted title,
filename and MIME type on update follow the normal put_text preservation rules.
Use `--field-file text -` for stdin. The usual explicit workspace/actor/run defaults
apply; attribution is cooperative metadata. This helper is not a daemon method.

Use a configured request directory, `--save-request`, or a stable mutation-id.
The saved file is the exact ordinary transaction, including the materialized text;
`workgraph retry /absolute/new-request.json` never rereads a deleted or changed input,
refreshes the guards or adds another content version. Retry uncertain outcomes using
that saved request. Success retains the standard durable transaction receipt:
`.result.data.results[0].data` contains resource_id, the publication revision and
immutable `version.{revision,digest}`; `.result.data.results[1].data` contains the final
linked metadata revision (one greater). Pin the immutable version and digest for
evidence. Publication and linking do not approve a ticket.

## Discover metadata, then read pinned bytes

Planning queries return a **workspace revision**, the planning journal position they
observed. Passing it as `at_revision` guards a continuation against intervening edits;
it does not retrieve an arbitrary old snapshot. A **budget** is the response byte limit;
inspect omission diagnostics before treating a bounded summary as complete.

Query metadata first; retrieve only needed immutable versions. resource.get/list/history
are bounded planning queries with meta.workspace_revision and meta.budget. Continue list
or history pages with next_offset and the returned workspace_revision as at_revision,
preserving filters. Positive offset requires at_revision; any supplied at_revision must
match current planning revision. A planning change conflicts: restart the metadata page
traversal. History items are retained content versions, not metadata-edit history.
Inspect truncated/omitted_fields/omitted_items and JSON-pointer budget details before
using metadata as complete. details_complete=false means the omission detail list is
incomplete. Text/target arrays may be shortened; identities and immutable version
identity remain complete. Budget trimming can shorten a page further than its requested
limit. Use resource.read for complete small UTF-8 content; it rejects large/non-UTF-8
bytes with Invalid_argument and points to resource.read_text for larger UTF-8 ranges,
resource.read_chunk for binary, or the CLI downloader. None of these byte reads accepts
max_bytes. With omitted version, reads select latest at execution. Pin the first
returned content version for every later byte request, independently of metadata
revisions/planning changes. read_chunk offsets count bytes and lengths are 1..262144
bytes. Verify resource/version, offset, whole digest and size identity, every
chunk_digest, and the final assembled SHA-256. Advance with next_offset until null/EOF;
offset=size_bytes returns an empty EOF chunk. Empty files and arbitrary binary bytes are
supported. The CLI downloader does this verification.

### Read large UTF-8 text without Base64

resource.read_text accepts the same workspace/resource/version selectors as read_chunk,
plus byte offset (default 0) and length (default 65536, 1..262144). The whole resource
may be up to 64MiB. Its response includes plain UTF-8 text, resource_id, immutable
version/digest, whole size_bytes, offset, chunk_digest, next_offset and eof. Pin the
first version and digest for every continuation even if newer content is published.
Verify each chunk_digest against the UTF-8 bytes and the assembled whole SHA-256.

A range ends at a complete Unicode scalar. A valid trailing partial scalar at a
non-EOF boundary is retained for the next read; next_offset advances by the returned
text's UTF-8 byte length, which can be less than requested length. Never advance by
character count or the requested length. Offset must start a scalar. A request too
short to contain its first scalar rejects with Invalid_argument; length at least 4
always accommodates one valid scalar. Offset equal to size_bytes returns empty EOF.
Offsets past EOF reject. Invalid selected bytes or a truncated scalar at actual EOF
reject without replacement characters or skipping bytes. Validation covers the selected
range; bytes outside it can still be invalid. Use read_chunk/download for opaque bytes.
No planning capture or max_bytes budget is needed because versions are immutable and
the byte range itself is bounded.

```text
resource.read_text {"workspace_id":"demo","resource_id":"report","offset":"0","length":"65536"}
resource.read_text {"workspace_id":"demo","resource_id":"report","version":"1","offset":"65534","length":"65536"}
```

The second request is illustrative: use the actual first response's version and
next_offset, retaining its digest and verifying each chunk before assembling it.

## Reuse pinned inputs across tickets in one run

Use [input-cache.py](../scripts/input-cache.py) once per shared immutable input, then
reuse its returned path for later tickets. The standalone Python standard-library helper
calls the existing verified downloader on a miss. It never claims work or changes daemon
state. Keep the cache under the run's private state directory outside every checkout;
`--worktree` explicitly rejects a cache inside that resolved checkout. Create an owned
0700 directory (or let the helper create one with an existing parent). Cache files,
pins, downloaded input, context files and request journals must stay out of Git.

Obtain an approved content pin once. Content version is not the resource metadata
revision. For example, with explicit existing context, source checkout and state paths:

```sh
SOCKET=$(jq -er '.socket' "$CONTEXT")
WORKSPACE=$(jq -er '.workspace_id' "$CONTEXT")
RESOURCE=shared-input
META=$("$WG" --context "$CONTEXT" resource get --resource-id "$RESOURCE") || exit 1
VERSION=$(printf '%s' "$META" | jq -er '.result.data.current_version.revision') || exit 1
DIGEST=$(printf '%s' "$META" | jq -er '.result.data.current_version.digest') || exit 1
SIZE=$(printf '%s' "$META" | jq -er '.result.data.current_version.size_bytes') || exit 1
python3 /absolute/skill/scripts/input-cache.py \
  --workgraph "$WG" --socket "$SOCKET" --workspace-id "$WORKSPACE" \
  --resource-id "$RESOURCE" --version "$VERSION" --digest "$DIGEST" --size-bytes "$SIZE" \
  --cache-directory "$RUN_STATE/inputs" --worktree "$SOURCE_CHECKOUT"
```

Check success before consuming the JSON `{pin,path,status}`. Status is `stored`, `hit`
or `race_hit`. Pin records source socket, workspace, resource, exact version/digest and
size. Reuse those same values for another ticket; do not refetch latest metadata on each
ticket. A changed pin or source selects a new key and fetches anew. Each hit opens an
owned regular file without following a leaf symlink, then rechecks size and complete
SHA-256; it makes no network request and can work while the daemon is offline. Keys bind
the canonical source socket, workspace/resource and immutable byte identity, not title,
filename, ticket, metadata revision or file modification time.

A miss downloads into a fresh private cache stage, validates the exact downloader receipt
and independently hashes the file. Publication uses a hard link without replacement;
concurrent callers verify the winner before reuse. Files are read-only inputs; copy them
before editing. Corruption, symlinks and nonregular entries reject without overwriting
or refetching over an existing entry. The harness owns deliberate eviction once consumers
are done. Failed or cancelled fetches retain their private `.input-*` stage for inspection.
A directory-sync failure after publication reports `Outcome_unknown` with the installed
path retained; rerun the exact same pin to reverify it. Do not infer a successful input
from a failed command. No credentials or context file are copied into the cache.

## Stage large uploads and recover publication

**Staging** holds temporary actor-owned bytes before publication. A staging reply is not
a durable resource receipt. **Publication** installs verified bytes and commits an
immutable content version. Keep that distinction when recovering a lost response.

upload.begin/chunk/status/abort use workspace_id, actor_id and stable upload_id. Do not
supply mutation_id/run_id; the strict raw upload decoders reject them. These are
private, actor-owned EPHEMERAL staging operations. Their received offset is contiguous
staging progress, not a durable publication watermark. Only resource.finish_upload is a
normal durable planning mutation with a mutation identity/optional run attribution.
Begin with exact size/digest, send canonical padded Base64 chunks at received, inspect
status to resume, then finish with resource metadata and its observed expected_revision.
A contained previously received range with identical bytes is a safe chunk retry; gaps,
partial overlaps and changed bytes conflict. There is no implicit network retry or upload.finish daemon method.
`upload.status` and `upload.list` are read-only methods in the schema. A context
supplies the required owner actor for `upload.status`; `upload.list` needs only
the workspace and shows all staging owners. Neither read changes staging progress
or publishes a durable mutation.

upload.list gives a complete upload-ID-ordered snapshot of the at most eight live
entries, including actor_id, received/declared bytes, digest, creation/update epoch
milliseconds and receiving/ready/installed lifecycle. Its observed_unix_ms permits
computing age and idle time (clamp clock regression to zero). These are cooperative
workspace metadata, not an authentication boundary; bytes and mutation operations
retain their actor guard. No automatic idle expiry is applied: the caller may be
paused or retrying an uncertain publication. Explicit owner abort or daemon restart
removes abandoned staging. Empty uploads need no chunks. Finish requires
all bytes, verifies size/SHA-256, syncs/installs the blob, then commits the resource
version and durable receipt. It is standalone, outside transaction.apply groups. A
failed revision guard can leave an installed orphan with no resource publication.
Definitive publication preparation/commit failures release installed staging admission;
re-stage the original bytes to retry the exact saved plan, or deliberately prepare a new
plan with corrected metadata and a fresh mutation identity. Incomplete staging remains
resumable. Outcome_unknown, cancellation and unexpected exceptions do not trigger this
cleanup: retain the original finish identity and inspect/retry its exact receipt.
After publication staging is forgotten, but exact original receipt retry
still works. After lost acknowledgement/restart, retry/check the ORIGINAL finish first:
receipt lookup precedes staging lookup. If no receipt exists, re-stage the original
bytes (the same raw upload ID can begin again) and send that same finish. Restart
discards abandoned .part files under the writer lock. abort frees staging admission but
cannot undo publication or delete installed orphan blobs. Never infer publication from a
staging acknowledgement. Per workspace: eight staged uploads/256MiB reserved declared
bytes, 10000 resources, and 512MiB of distinct blobs referenced by retained content
versions. Retained orphan bytes do not count toward that referenced-byte ceiling; it is
not a total disk quota.

## Use resources for large conversation payloads

A session event can reference an installed byte **blob**, identified by its digest and
size. See [sessions and history](history.md) for event shapes and capture rules.

For oversized conversation payloads, publish exact opaque bytes/searchable text, retain
the returned content-version digest and size, then session.append with blob content.
Install before append. Retain a resource_versions reference when the resource-version
relationship matters. For retrieval, pin session history captures and resource versions,
follow byte cursors and verify digests, then carry only chosen records into harness
context.

## Daemon method reference

Read a method schema for exact required fields and result types.

| Method | Behavior |
| --- | --- |
| [`resource.put_text`](api/resource.put_text.md) | Publish exact small UTF-8 bytes as a new immutable version; title is required on creation; omission on a guarded update preserves the current title. Preserve description, targets and archive state. Optional creation resource_id is generated durably; retain it. Omitted filename/MIME default on creation and preserve current metadata on update. Archived publication conflicts. |
| [`resource.update`](api/resource.update.md) | Patch supplied metadata only; even an otherwise empty update advances metadata revision. Older content-version filename/MIME never change. |
| [`resource.archive`](api/resource.archive.md) | Set archive visibility while retaining all versions/links. The shared metadata decoder also accepts its documented metadata patch fields. |
| [`resource.link`](api/resource.link.md) | Link an existing typed target; duplicate links conflict. Contexts expose sorted linked metadata without fetching bytes. |
| [`resource.unlink`](api/resource.unlink.md) | Remove one target link; an absent link conflicts. Resource content is retained. |
| [`resource.brief`](api/resource.brief.md) | Read compact current metadata, latest immutable content identity, exact counts and pointers without loading bytes or replacing history/link traversal. |
| [`resource.get`](api/resource.get.md) | Fetch current summary metadata; direct reads include archived resources. Inspect budget omissions before treating metadata as complete. |
| [`resource.list`](api/resource.list.md) | Discover summaries ordered by resource ID with target/archive filters. Continue using planning at_revision and next_offset; inspect budget omissions. |
| [`resource.history`](api/resource.history.md) | Read retained immutable content versions in increasing version order, including archived resources. Use planning capture paging; metadata-only edits add no versions. |
| [`resource.read`](api/resource.read.md) | Fetch latest or pinned complete UTF-8 content up to 65536 bytes with verified version, SHA-256 and full size. Unknown resource/version returns Not_found; larger UTF-8 text uses read_text, and binary content uses read_chunk/download. |
| [`resource.read_text`](api/resource.read_text.md) | Read a bounded plain UTF-8 range, retaining incomplete trailing scalars for exact byte continuation. Pin version/digest; invalid selected UTF-8 rejects. |
| [`resource.read_chunk`](api/resource.read_chunk.md) | Fetch a verified binary byte range; pin the first selected version and follow next_offset to EOF. Verify identities, every chunk digest and assembled digest. |
| [`upload.begin`](api/upload.begin.md) | Begin/resume the same actor/ID/size/digest staging entry. Changed owner/size/digest conflicts; admission exhaustion is Invalid_argument. Empty staging is supported. |
| [`upload.chunk`](api/upload.chunk.md) | Stage a contiguous nonempty chunk of at most 256KiB, or exactly retry an identical contained range. Missing/restarted upload is Not_found; chunks after install conflict. |
| [`upload.status`](api/upload.status.md) | Observe received/declared size/digest for the live owner. Missing staging after restart/finish/abort is Not_found; different owner conflicts. |
| [`upload.list`](api/upload.list.md) | Inspect the complete bounded staging snapshot for all cooperative owners; timestamps expose age and idle time without expiring entries. |
| [`upload.abort`](api/upload.abort.md) | Discard live staging and free admission. Absent staging abort is safe; another live owner conflicts. Installed blobs/publications remain. |
| [`resource.finish_upload`](api/resource.finish_upload.md) | Verify/install the actor-owned bytes and durably publish resource metadata/version. Exact retry checks the receipt before live staging, allowing recovery after restart. Incomplete upload conflicts; size/checksum mismatch is Invalid_argument. |

## CLI file upload

```text
"$WG" resource upload "$SOCKET" --workspace-id ID --actor-id ID --resource-id ID
  --expected-revision REV --title TEXT --file ABS_FILE
  [--run-id ID] [--filename BASENAME] [--mime-type TYPE/SUBTYPE]
  (--save-request ABS_NEW_FILE, configured request-directory journaling, or --mutation-id ID)
```

Use an explicit resource ID. Source must be an absolute regular file, at most 64MiB. The
save-request parent must exist and the file must be fresh. Filename defaults to source
basename; MIME defaults to application/octet-stream. General --timeout SECONDS applies
to each wire operation separately; JSON is default output, --output text is supported.

### Behavior

The helper hashes the source and expands a version-1 upload plan. With request
journaling, it syncs the exact plan before sending. It checks workspace.receipt for the
finish identity, begins/resumes staging, sends chunks of up to 256KiB and invokes
resource.finish_upload. The saved plan freezes all metadata/run/mutation IDs, source
absolute path, size, digest and deterministic upload_id. Decoding checks that the saved
upload_id matches its frozen identity before transmission. Its result is the durable finish receipt. Recover with
workgraph retry SOCKET SAVED_FILE. Completed retry can succeed after removing the source
because receipt lookup precedes reading it. Incomplete retry verifies unchanged source
bytes, resumes received or re-stages after restart. Changed source conflicts. No failed
network operation retries implicitly. resource.upload is CLI-only: raw daemon calls
fail. Use the helper's saved plan, rather than constructing an upload-plan schema.

### Abort a saved upload plan

```text
"$WG" resource upload-abort [ABS_SOCKET] ABS_SAVED_UPLOAD_PLAN
  [--timeout SECONDS] [--output json|text]
```

With context defaults, its workspace and actor (when supplied) must match the saved
plan. Source bytes are never read. The helper validates the frozen upload ID and calls
owner-scoped upload.abort; it never removes immutable blobs, resource versions or finish
receipts. Repeating abort is safe. To recover publication instead, use the original
`workgraph retry [ABS_SOCKET] ABS_SAVED_UPLOAD_PLAN`; it checks the exact finish receipt
before looking at the source or staging. Aborting while publication is uncertain cannot
undo a committed version, so retain the saved plan and recover that receipt first.

## CLI file download

```text
"$WG" resource download "$SOCKET" --workspace-id ID --resource-id ID
  --destination ABS_NEW_FILE [--version CONTENT_VERSION]
```

No actor/run/mutation ID is accepted. Destination must be fresh and absolute, with an
existing parent. General --timeout SECONDS and --output json|text are local CLI options.

### Behavior

The helper reads 256KiB chunks, pins the first version if omitted, verifies
range/size/chunk and complete SHA-256, syncs a private 0600 file, atomically publishes
without replacing any existing destination and syncs its directory. The result
identifies resource/version/digest, size_bytes and destination. It does not mutate
workspace state; resource.download is CLI-only. Before publication, errors leave no
destination; private-file cleanup is best effort and a killed client may leave an
unreferenced .downloading-* file. A directory-sync failure AFTER publication reports
Outcome_unknown with the complete destination retained for inspection. Do not blindly
delete/re-download it. Repeating against an existing destination returns
Invalid_argument with its local path, including when another process creates that
destination before publication.

## Publish and download examples

First [set up a workspace](getting-started.md). Replace the following absolute paths
with your executable, socket and existing private request directory. These commands
assume workspace `demo` exists and the example resource IDs are unused. `SOURCE` must be
an existing absolute regular file; `DESTINATION` must be fresh with an existing parent.
Every new write uses a fresh saved-request filename.

```sh
WG=/absolute/path/to/workgraph
SOCKET=/absolute/private/workgraph.sock
REQUESTS=/absolute/private/requests
SOURCE=/absolute/path/to/hello.bin
DESTINATION=/absolute/path/to/hello-copy.bin

"$WG" request "$SOCKET" resource.put_text \
  --workspace-id demo --actor-id worker --resource-id note \
  --expected-revision 0 --title Note --text 'Recorded evidence.' \
  --save-request "$REQUESTS/publish-note.json"
"$WG" request "$SOCKET" resource.read \
  --workspace-id demo --resource-id note --version 1

"$WG" resource upload "$SOCKET" \
  --workspace-id demo --actor-id worker --resource-id attachment \
  --expected-revision 0 --title Attachment --file "$SOURCE" \
  --save-request "$REQUESTS/upload-attachment.json"
"$WG" retry "$SOCKET" "$REQUESTS/upload-attachment.json"
"$WG" resource download "$SOCKET" \
  --workspace-id demo --resource-id attachment --version 1 \
  --destination "$DESTINATION"
```

The explicit retry illustrates receipt recovery and does not create another content
version. Retain the actual returned version and digest; `1` is appropriate here only
because these resources are newly created.

## Byte input and streaming

For small text use --field-file text ABS_FILE or --field-file text - to preserve exact
newlines; --params-file FILE|- materializes one JSON parameter object. At most one stdin
source is allowed. Inputs validate and freeze before journaling; retry reads only the
saved request and rejects new input flags. For download, direct streaming stdout can
emit a prefix before a later integrity error. Use the explicit spool mode when the
entire content must verify before emission. Inspect resource download --help for
destination/stdout options; always check exit before consuming the result.
