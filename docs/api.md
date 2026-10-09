# API and runtime reference

This reference documents the current CLI, planning API, client, resource transfers,
exports and storage contracts. Start with the [README](../README.md) for installation
and a quickstart or the [agent context guide](../AGENT_GUIDE.md) for concise operating
instructions. Coordination, communication, evidence and history have their own
linked guides below.

Every successful JSON-RPC response has `result.data` (the operation output) and
`result.meta` (applicable durability, query revision, capture and budget metadata).
Planning writes report `meta.durable` and `meta.workspace_revision`; domain query
revisions and history positions remain distinct. See the exact
[shared contract](agent/cli-contract.md) and [capability index](../AGENT_GUIDE.md)
for discovery. Exact parameters, defaults, tagged alternatives and complete results
are generated from the executable in the [per-method reference](api-reference/index.md).
This guide explains operating rules and workflows rather than maintaining another
copy of those schemas.

Commands in the fresh-workspace example use known initial revisions and tokens.
For existing work, read the current values and use the returned claim token.
Run all examples from the repository root after building or installing Workgraph.

## Run a workspace

Use two terminals. From this package directory in the first terminal:

```sh
mkdir -p -m 700 .local
./dev run serve "$PWD/.local/registry" "$PWD/.local/wg.sock"
```

The daemon stays in the foreground. Ctrl-C or SIGTERM drains admitted requests
and closes its resources. Keep the socket's parent directory private; the socket
itself is set to mode 0600. Use a shorter absolute path if your checkout location
would exceed the OS socket path limit.

In the second terminal, use the built executable directly:

```sh
WG="$PWD/_build/default/bin/main.exe"
SOCKET="$PWD/.local/wg.sock"

"$WG" call "$SOCKET" workspace.create \
  "{\"workspace_id\":\"demo\",\"actor_id\":\"operator\",\"mutation_id\":\"create-demo\",\"name\":\"Demo\",\"root\":\"$PWD/.local/demo\"}"

"$WG" call "$SOCKET" project.create \
  '{"workspace_id":"demo","actor_id":"agent","mutation_id":"project-1","project_id":"mvp","title":"Build the MVP"}'

"$WG" call "$SOCKET" ticket.create \
  '{"workspace_id":"demo","actor_id":"agent","mutation_id":"ticket-1","ticket_id":"task-1","project_id":"mvp","title":"Verify restart recovery","description":"Save progress, restart, and recover context."}'

"$WG" call "$SOCKET" ticket.claim \
  '{"workspace_id":"demo","actor_id":"agent","mutation_id":"claim-1","ticket_id":"task-1","expected_revision":"1"}'

"$WG" call "$SOCKET" comment.add \
  '{"workspace_id":"demo","actor_id":"agent","mutation_id":"progress-1","target":{"kind":"ticket","id":"task-1"},"body":"Created the test fixture. Next: restart and verify."}'

"$WG" call "$SOCKET" handoff.set \
  '{"workspace_id":"demo","actor_id":"agent","mutation_id":"handoff-1","ticket_id":"task-1","expected_revision":"0","token":"1","summary":"Fixture ready","next_steps":"Restart the daemon and read ticket.context","evidence":"Workspace and ticket creation succeeded"}'

"$WG" call "$SOCKET" ticket.context \
  '{"workspace_id":"demo","ticket_id":"task-1"}'
```

Stop and restart the daemon with the same registry/socket arguments. The ticket,
claim, comments, handoff and mutation receipts recover from disk. `ticket.context`
includes the latest handoff and comments newer than its coverage cursor; the
full transaction history is available through `activity.since` and exports.
Subsequent updates include edits and tombstones of older comments, not only newly
created comments. The coverage cursor is conservative for progress and handoff
updates committed together: that transaction’s updates remain visible.

Complete the claimed ticket with the token returned by `ticket.claim`:

```sh
"$WG" call "$SOCKET" ticket.complete \
  '{"workspace_id":"demo","actor_id":"agent","mutation_id":"complete-1","ticket_id":"task-1","token":"1","evidence":"Restart recovered the handoff and ticket context"}'
```

The CLI writes one JSON response to stdout and returns a nonzero exit status for
errors. Diagnostics go to stderr. Every connection currently carries one request
and one response. Library clients can use `Workgraph.Client.execute` or the typed
`invoke`, `mutate`, `administrate` and `query` entry points.

## Request conventions

All paths are absolute; parent directories must already exist. Creation and export
destinations must not exist. Workspace roots, pending restore/create roots, active
export destinations and the daemon registry must not overlap. Existing ancestors
are canonicalized, so alternate spellings or symlink ancestors cannot bypass these
ownership checks. Keep each workspace and export in its own directory; do not edit
or replace managed storage directories while the daemon owns them.
Explicit IDs are stable keys of 1–96 ASCII letters, digits, underscores or hyphens.
Workspace/project/milestone/ticket/comment creation can omit the ID; the daemon
then generates a secure random ID after checking the original request receipt.
New text resources and upload publication can omit resource_id at revision zero.
Saved requests need not predict the generated ID: retries return the original
receipt. Batch creation aliases work with generated IDs. ID types remain distinct
inside OCaml.

Tickets receive workspace-local display keys `WG-1`, `WG-2`, and so on, in creation
order. Renaming, moving and archiving preserve the key; keys are never reused.
Use `ticket resolve --display-key WG-1` to find its opaque ID. Relationships continue
to use IDs. Display keys are preserved by durable replay.

Domain mutations require `workspace_id`, `actor_id` and `mutation_id`.
Optional `run_id` identifies an invocation separately from its actor. It is stored
in the audit and participates in request identity: changing the run while reusing
an actor/mutation key conflicts. Omitting a run is also part of that identity.
Claims are owned by actor, optional run and fencing token together. Supply the same
run on progress, release, completion and claimed handoffs; a new invocation must
explicitly reassign using `claimant_id` and optional `claimant_run_id`.
Run IDs may remain unregistered invocation markers. When granting a claim to an
existing registered run, its actor must match the claimant and its lifecycle must
be nonterminal. Existing claims remain explicit ownership until released or
reassigned. Reassignment comments preserve the complete reason as their body.
Held-work queries can filter by actor/run. Saved resource upload plans retain run
attribution through their final durable publication.
Administrative lifecycle and export start/cancel/retry calls require `actor_id` and
`mutation_id` as well. Their receipt scope is the local registry, independent of
workspace mutation receipts. Administrative receipts retain the original result:
retrying an old open after a later close does not reopen the workspace. Keep the
same mutation ID and parameters when retrying after a disconnect or timeout.
Receipts survive restart; changed parameters with an existing key fail with
`Idempotency_conflict`. A request ID only correlates the response. Revisions,
claim tokens, pagination offsets and limits are decimal strings in JSON.

Use the generated method contracts for request fields and result shapes:

- [Workspace creation](api-reference/workspace.create.md), [registry receipts](api-reference/registry.receipt.md) and [health](api-reference/daemon.health.md).
- [Ticket creation](api-reference/ticket.create.md), [claim](api-reference/ticket.claim.md), [start](api-reference/ticket.start.md), [finish](api-reference/ticket.finish.md) and [reopen](api-reference/ticket.reopen.md).
- [Atomic transactions](api-reference/transaction.apply.md), including declared alias fields.
- [Comments](api-reference/comment.add.md), [handoffs](api-reference/handoff.set.md) and [ticket context](api-reference/ticket.context.md).
- [Resources](api-reference/resource.put_text.md), [upload admission](api-reference/upload.begin.md) and [publication](api-reference/resource.finish_upload.md).
- [Export admission](api-reference/workspace.export.md), [job listing](api-reference/export.list.md), [verification](api-reference/export.verify.md) and [restore](api-reference/workspace.restore.md).

The [full index](api-reference/index.md) covers the remaining planning, coordination,
communication, evidence, history and administration methods. Tagged objects and
ID field names are specific to each contract; use its schema rather than guessing
from an internal or durable representation.

Catalog `put` operations replace catalog metadata: expected revision `"0"` creates,
subsequent replacements require the current revision. Names may change; a status's
category cannot. Archiving catalogs retains existing references and prevents new
assignments. Default semantic categories work without custom catalog entries.
`ticket.metadata` selects a custom status ID; category-based updates and claim
transitions clear that custom selection. Priority is `"1"` urgent through `"4"`
low, or `"0"` unspecified. Assignment is independent of an exclusive claim.

`transaction.apply` commits all operations with one workspace revision and one
receipt. It executes preconditions in declared order and validates the final
hierarchy/graphs. Failure discards every staged change. Optional `as` aliases
name explicit or generated IDs in project/ticket/milestone/resource creation; use
`"$alias"` in ID fields to reference them (including forward references). Nested
batches and administration methods are rejected.

Moving a ticket moves its entire descendant subtree to the destination project;
children keep their parent links and clear milestone assignments on project
changes. Project/milestone progress is derived; their explicit status changes only
on request. Archive retains history and rejects hiding unresolved prerequisites
of visible work. Archived views remain available through `include_archived` and
direct context queries.

Statuses are `backlog`, `todo`, `in_progress`, `done` and `canceled`. Only done
prerequisites unblock work. Parents and dependencies are separately acyclic.
Ticket completion checks prerequisites and children. Default claims persist until
release/completion; after a crash, resume with the recorded actor/run/token.
Opt-in timed claims require explicit lease renewal; expiry does not stop the
external worker. A trusted actor may explicitly reassign an observed claim with
`ticket.reassign` and a reason after finishing its active attempt; previous tokens
become stale. For a crashed worker, use guarded recovery only after confirming it
is stopped or isolated. While claimed,
title/description/status edits require release first; progress and handoff updates
remain available. Protected `ticket.progress` and handoff updates require the
current claim token; ordinary `comment.add` permits other trusted actors to discuss
reserved work. Claim tokens protect completion/release, not external checkout
writes or unrestricted comments by other trusted local actors. Explicit holds
block both readiness and completion without changing status. Waivers record an
actor and reason, satisfy an edge, and retain that edge for cycle validation;
revoking a waiver restores blocking. `ticket.readiness` and context explain the
current status, claim, hold and prerequisite reasons.

Discussion targets are `{ "kind": "workspace" }` or
`{ "kind": "project" | "milestone" | "ticket" | "resource", "id": "…" }`.
Comment kinds are `comment`, `progress`, `decision`, `blocker` and `evidence`.
Replies retain the same target and must reference a live comment. Edits append a
revision without changing the ticket revision. Tombstones hide the current body;
`comment.history` and exports retain earlier versions. Editing a tombstone creates
a new live revision. Author/creation time remain stable; each revision records its
editor, timestamp and activity cursor. Explicit comment IDs can be batch aliases.

Handoff history preserves earlier summaries and provenance. Optional
`covers_through` must be at or before the state observed by the transaction;
omitting it covers that prior state. Scoped audit queries retain membership at
the time of the event, including both projects when moving a ticket. Filtering by
a workspace target includes all its events.

Bounded queries disclose byte and item omissions through `result.meta.budget`.
Its returned-byte count covers the complete canonical `{data,meta}` result,
excluding the JSON-RPC transport wrapper. Query views remain valid according to
the method's public result codec. Some views clip prose or collections; proof,
policy, binding and other complete records are fitted as whole records. When a
complete record cannot fit, the method reports an error asking for a larger
budget. Inspect the method's generated contract and omission details before
treating a bounded response as complete. Portable exports retain authoritative
transactions and complete referenced bytes.

For offset pages, retain the observed revision or snapshot fence and the returned
next offset; an intervening change rejects the stale page. Cursors count returned
items so byte fitting does not skip records. An explicitly empty, nonadvancing
partial page requires a larger budget. Defaults and maximums are declared in each
[query schema](api-reference/index.md).

Ready work sorts by priority, creation order (including within a batch), then ID. Workspace
overview shows status counts, active projects, held/blocked work and recent
changes. Project brief groups ready/in-progress/blocked tickets. Ticket context
includes activity since handoff coverage. Use [ticket.resume](api-reference/ticket.resume.md)
for a captured resume packet and [ticket.blockers](api-reference/ticket.blockers.md)
for further prerequisite details.

Search is an ASCII case-insensitive substring match over current workspace,
project, milestone and ticket fields, comments, handoffs, resource metadata and
text resource prefixes. `text` is 1–256 bytes. `kinds` may select `workspace`,
`project`, `milestone`, `ticket`, `comment`, `handoff`, `resource`, `resource_text`.
Results sort by that kind order, then stable ID. Each hit includes source revision,
target, matched fields, original byte offsets and UTF-8 snippets. `index_revision`
is the workspace revision read; there is no asynchronously stale index.

Text extraction reads at most 32 current files, 64 KiB per file and 1 MiB total per
request. Supported MIME types are text/*, application/json, application/xml and
application/javascript. Historical revisions and tombstoned bodies are not searched.
`coverage` and the paginated `unindexed_resources` report excluded or partial files,
including unsupported MIME, invalid UTF-8, prefix truncation and scan limits. Narrow
`target` or `project_id` to search files excluded by the aggregate budget. Target
scope includes directly attached resources; project scope includes attachments to
that project's tickets and milestones. Full file bytes remain separately downloadable.

`./dev exec bench/query_bench.exe` measures query latency and allocations for a
1,000-ticket/1,000-comment in-memory fixture. It is a small benchmark fixture,
not a capacity qualification workload or a performance guarantee.

The wire envelope is a restricted JSON-RPC-style profile: four-byte big-endian
payload byte length followed by UTF-8 JSON. `initialize` reports protocol version
1. Batch arrays are unsupported and notifications do not perform mutations.
Application errors appear in `error.data.kind`. This is not a complete general
JSON-RPC server.

The CLI is the supported agent integration path. Users can build skills and shell
scripts around it, or maintain their own external MCP tools. MCP support is outside
this project's scope and is not planned as a first-party feature.

## Resources and binary uploads

A resource has a metadata revision and independently numbered content versions.
All content and metadata mutations require the current metadata `expected_revision`.
Renaming/linking/archiving increments that revision without rewriting a content
version. Each version preserves its digest, byte count, filename, MIME type, actor
and timestamp. `resource.get` returns metadata, `current_version` and
`version_count`; `resource.history` paginates all versions in ascending order.

Filenames are logical basenames (1–255 bytes), never paths. MIME values use a
`type/subtype` without parameters. Resource links accept the same typed targets
as discussion. References appear in workspace overview, project brief and ticket
context without loading attachment bytes. Archiving hides a resource from normal
lists while direct metadata/history/download queries remain available.

For a binary file:

1. Calculate the file's SHA-256 and byte length. Call `upload.begin` with a stable
   upload ID. Upload requests use actor attribution but do not need mutation IDs.
2. Send contiguous chunks of at most 262,144 bytes via `upload.chunk`, using standard
   padded Base64. Identical chunk retries are safe. Differing retries, overlapping
   ranges and gaps return conflicts. `upload.status` reports the next byte offset.
3. Call `resource.finish_upload` with a stable mutation ID and resource metadata.
   The worker verifies the full checksum and size, syncs and installs the blob,
   then commits the resource version through the normal durable transaction path.
   Reuse the same finish mutation ID/parameters after a lost response or restart.
4. Download with `resource.read_chunk`. It returns Base64 bytes, a chunk hash, the
   whole-file digest/size, `next_offset` and `eof`. Supply `version` to read older
   content. Verify the complete assembled file against its digest.

Uploads are private staging state, not durable workspace publications. Restart
removes abandoned `.part` files under the held writer lock; start a new upload
unless a prior finish already has a durable receipt. `upload.abort` releases local
admission capacity; already installed but unpublished blobs remain harmless orphans.
A failed metadata revision check can leave such an orphan and no visible version.
You may retry finish with corrected metadata and a new mutation ID while the upload
remains live. Publication is currently a standalone mutation, outside batch groups.

Limits are 64 MiB per file, eight active uploads and 256 MiB reserved upload bytes
per workspace, and 512 MiB of distinct referenced blob bytes. Resource history and
orphan blobs are retained; the referenced-byte limit is not a total disk quota.
Streaming verification, export and downloads use buffers no larger than 256 KiB.
Empty files and arbitrary non-UTF-8 bytes are supported. Multiple resources may
reference identical bytes while retaining independent metadata. The generated
[resource contracts](api-reference/resource.get.md) describe canonical public
metadata and version records.

Workspace metadata is portable transaction history. `workspace.update` applies a
revision-checked patch; omitted fields are preserved. Renaming leaves the immutable
creation descriptor intact and exposes the current name through queries and exports.
`workspace.archive` excludes tickets from scheduling and rejects active claims;
explicit context/history queries still work. Archiving does not close or unregister
the workspace. `workspace.get` returns current name and metadata; registry listings
report the archive flag for loaded workspaces, or null for closed/unavailable ones.

## CLI and OCaml client

Every method family can use named fields instead of a JSON argument:

```sh
"$WG" ticket create "$SOCKET" --workspace demo --actor agent \
  --ticket-id verify-cli --title "Verify CLI recovery" \
  --save-request "$PWD/.local/create-ticket.request.json"
"$WG" retry "$SOCKET" "$PWD/.local/create-ticket.request.json"
"$WG" ticket context "$SOCKET" --workspace demo --ticket-id verify-cli --text
"$WG" workspace archive "$SOCKET" --workspace demo --actor agent \
  --expected-revision 0 --archived true --mutation-id archive-demo
```

`--save-request` creates and syncs a new file before sending. It generates a secure
mutation ID only when one is absent. Keep that file and use `retry` after a lost
reply; retry rejects parameter overrides. Without a saved request, provide an
explicit stable `--mutation-id`. Existing request files are never overwritten.
Actor identity is always explicit. `--field-file description FILE` reads UTF-8
text; `--params-file FILE` reads a parameter object; `--json-field target JSON`
passes arrays, objects or null. Decimal revisions remain strings. The aliases
`--workspace`/`--actor` expand to their `_id` fields. `request SOCKET METHOD`
is equivalent to `FAMILY ACTION SOCKET`; `call SOCKET METHOD JSON` remains available.

Output defaults to canonical JSON. `--text` prints readable field/value content.
Received application errors are JSON response envelopes on stdout (or stderr in
text mode); local/transport diagnostics go to stderr. A nonzero exit status
indicates failure. `--timeout SECONDS` uses a finite monotonic deadline, default
30 seconds, maximum one hour. A timed-out write, early disconnect, or invalid
acknowledgement reports `Outcome_unknown` once transmission might have started.
There are no automatic retries. Use `registry receipt` or `workspace receipt`
to inspect a known mutation, then retry the same request when appropriate.

The OCaml library exposes `Client.create`, `execute`/`invoke`, typed `mutate` for
all public `Domain_command.t` operations, typed `administrate` for workspace
lifecycle, and typed `query` selectors with workspace-revision/budget envelopes.
`Wire_command.encode` preserves omitted patches versus nullable clears and rejects
worker-internal resource publication. Method codecs validate public requests and
results, including bounded query projections and disclosed omissions. These views
are not durable replay events. Client responses validate version, matching request
ID and mutually exclusive result/error.
The integration fixture `test/client_workflow.ml` demonstrates typed create, atomic
project/ticket/comment creation, receipt retry and context inspection across restart.
`resource upload` and `resource download` are local CLI workflows over the bounded
wire methods; they are not additional daemon methods:

```sh
"$WG" resource upload "$SOCKET" --workspace demo --actor agent \
  --resource-id research --expected-revision 0 --title "Research attachment" \
  --file "$PWD/research.pdf" --save-request "$PWD/.local/upload.request.json"
"$WG" retry "$SOCKET" "$PWD/.local/upload.request.json"
"$WG" resource download "$SOCKET" --workspace demo --resource-id research \
  --version 1 --destination "$PWD/research-copy.pdf"
```

Uploads default to the source basename and `application/octet-stream`; override
`--filename`/`--mime-type` as needed. Saved v1 upload plans pin size and SHA-256 before
transmission, plus the original mutation ID. Retries inspect the durable receipt
first: a previously successful upload can be retried even after removing the local
source. Incomplete retries reject changed source content, resume acknowledged chunks,
or start the same upload again after a daemon restart. No failed network operation
is retried implicitly. A CLI timeout applies to each bounded request.

Downloads use at most 256KiB chunks, pin one resource version, validate range and
content hashes, and sync bytes before publishing to a fresh destination. An atomic
hard link prevents replacement even if another writer creates the destination during
the download. This POSIX primitive is isolated in the platform adapter because
Eio.Path has no equivalent. Source and staging files share the destination filesystem.
Errors before publication remove private partial files when possible; a killed client
may leave `.downloading-*` files. A directory-sync failure after publication reports
`Outcome_unknown` and leaves the complete destination available for inspection.

`examples/agent-workflow.sh` creates a workspace/project/dependency graph, discussion,
attachment and handoff using only CLI commands. The integration suite reruns it after
a daemon restart and checks that receipts preserve the same state. No external skill,
model account, or first-party MCP server is required.

## Export and Git handoff

```sh
"$WG" workspace export "$SOCKET" --workspace demo --actor operator \
  --destination "$PWD/.local/export-1" --save-request "$PWD/.local/export.request.json"
# Use the returned job_id to inspect completion before closing the source.
"$WG" export get "$SOCKET" --job-id JOB_ID
"$WG" call "$SOCKET" workspace.close '{"workspace_id":"demo","actor_id":"operator","mutation_id":"close-demo"}'
```

Exports contain readable project/milestone/ticket Markdown, complete workspace JSON,
resource versions, transaction audit records and a `portable/` directory holding
the canonical workspace tree. The current version-1 manifest records file hashes,
workspace identity, captured planning revision/head, history head and full-export
options. Earlier prototype manifest shapes are unsupported. Output is published
by an exclusive directory rename after staging is complete.
A small POSIX adapter uses macOS `renamex_np(RENAME_EXCL)` or Linux
`renameat2(RENAME_NOREPLACE)` so even a raced empty destination is never overwritten.
It fails on unsupported kernels/filesystems instead of using replacing rename.
See [validation](validation.md) for current platform evidence. Export admission
captures committed immutable state and returns a durable job record immediately.
A separate export domain writes files while ordinary mutations
continue through the persistence worker. Job admission and its administrative
receipt share one atomic registry write. `export get` reports the current status;
retrying the admission request returns its original receipt without starting twice.
The daemon accepts at most eight active jobs; one export worker writes them in order.

Active jobs pin source workspaces open. Wait for completion or cancel before closing
or unregistering a source. `export cancel` succeeds only before publication begins;
then the job transitions to `canceled` without publishing its destination. Graceful
shutdown requests cancellation and drains job results before releasing stores.
Interrupted jobs reconcile at restart: only a verified destination with matching
captured heads becomes `completed`; a private staging tree never counts as complete.
`export retry` writes a fresh attempt using the original captured revisions, even
if the source has advanced. Failed/canceled staging trees remain private; no automatic
history or staging garbage collector runs. Completed status records publication
history; use `export verify` when checking the current integrity of stored output.

`daemon export_all` captures one vector across every registered workspace at a single
dispatcher boundary. Complete mode requires all roots open and available. Explicit
`--allow-partial true` records unavailable workspace IDs in `omitted` and sets the
container manifest's `complete` to false. Each `workspaces/ID/` member is a full
snapshot; the container includes member hashes and no original-machine root paths.

`export list` uses bounded pages. Pass its `snapshot` value as `--at-snapshot` for
subsequent offsets; changes to jobs invalidate the listing instead of mixing pages.

After `workspace.close`, commit/copy the workspace's `workspace.json`, `HEAD.json`,
`transactions/`, `blobs/` and generated `.gitignore` using your normal Git tools.
Keep `.local/` untracked. Pull on the receiving machine while its workspace is
closed, then `workspace.register` the new root or `workspace.open` its existing
registration. Only one machine writes at a time. No automatic Git operations run.

Restore into a fresh root using a saved administrative request:

```sh
"$WG" workspace restore "$SOCKET" --actor operator \
  --directory "$PWD/.local/export-1" --root "$PWD/.local/restored" \
  --save-request "$PWD/.local/restore.request.json"
"$WG" retry "$SOCKET" "$PWD/.local/restore.request.json"
```

The original workspace ID must be unregistered in this registry before selecting
its restored copy. Restore verifies the full manifest, copies only portable files,
replays the transaction chain and validates every referenced blob and the exact
canonical inventory. Only then does it publish the fresh root and register it
**closed**. The result is the named `kind: installed` alternative with
`open: false`; cancellation uses `kind: canceled`. See the
[restore result](api-reference/workspace.restore.md). Open it explicitly with
`workspace open`. No source `.local/` files
are copied. Restoring preserves history, resource versions and workspace receipts.

`daemon restore_all --directory EXPORT --json-field roots '{"demo":"/new/demo"}'`
requires an exact mapping for every member of a complete export-all container.
Partial backups cannot be restored as complete sets; a full individual member can
be restored explicitly. Every target parent must exist and every destination must
be fresh. Different roots can reside on different filesystems: publication across
roots is resumable, not a filesystem-wide atomic rename. Registrations and the
success receipt commit together only after all roots validate and publish.

A synced registry intent reserves identities/roots before copying. Retry the exact
saved request after interruption or a storage error. Installed roots bearing that
intent's private marker are replayed and reused, even if their export source is
no longer present; unfinished roots still require their original pinned manifest.
New attempts use fresh staging directories and leave abandoned stages for manual
inspection. Restore runs through the serial persistence path; use a longer CLI
`--timeout` for large backups. A client timeout does not cancel admitted work.
`registry receipt` distinguishes pending and committed restore requests.

If validation failed and **none** of the target roots was published or occupied,
`restore cancel --target-actor-id ACTOR --target-mutation-id MUTATION` (with its own
actor/mutation) releases the reservation and stores a canceled original receipt.
Use a new mutation ID for a repaired backup. Cancellation never removes workspace
files and refuses a partly published restore; complete its original retry instead.

Registration of an already copied portable root also validates the chain and every
referenced blob before serving it. `export verify` validates the complete file inventory, checksums and descriptor/head
metadata, rejecting extra/missing files, symlinks and unsafe paths. It streams large
projections up to 1GiB each, with a 64MiB manifest and 4GiB aggregate bound. Its result
explicitly reports `canonical_state_validated: false`: full transaction/domain
recovery occurs during restore or registration of a portable copy. One daemon rejects two
registered copies with the same workspace identity. Re-register a moved directory
only after closing it and removing the old path (for example by moving it). The
new head must descend from the last closed head. To deliberately select an existing
copy instead, unregister the old registration first. Unregister releases its lock
and removes only the registry entry; workspace files and prior receipts remain.

Creation first syncs a registry intent with a secure random ownership token. A
retry with the same actor/mutation and parameters resumes its token-specific stage
or recognizes its installed directory using a private `.local/creation.json`
marker. It never rewrites an installed workspace. Other mutations cannot take a
pending create's root or identity. Fix a storage error, then retry the original
request; `registry.receipt` reports `pending`, `committed`, or `absent`. The registry
is bounded to 4MiB and never evicts receipts. Unknown registry write outcomes or
detected external registry edits fence requests until restart; `daemon.health`
and `workspace.list` expose the fence, open intent, and pending create count.
Workspace receipt lookup requires an open, unfenced workspace. These diagnostic
lookups do not resolve an uncertain write by guessing from missing in-memory data.

Related-ticket links use `related add` and `related remove`, with `ticket_id`,
`related_id`, `expected_revision` and `related_expected_revision`. Both endpoint
revisions update in one transaction. Links are symmetric, workspace-local and
limited to 100 per ticket. They appear in context and persist through export/restore;
they do not affect blockers, readiness or completion. Cycles of related links are
allowed; dependency cycles remain rejected.

## Storage and ownership

The main Eio domain owns in-memory projections and serializes requests. One Eio
worker domain owns disk operations and its own switch/file lifetimes. A request
first produces validated resolved events, then installs blobs and an immutable
transaction, then replaces/syncs `HEAD.json`. Only after durable acknowledgement
does the dispatcher publish the candidate and answer. Client disconnection does
not cancel an admitted mutation. The socket listener remains concurrent while
the dispatcher waits for persistence.

The registry and each workspace have OS advisory locks. Recovery follows the
authoritative head, ignores uncommitted orphan files and quarantines invalid
chains/blobs. External head/descriptor edits fence further writes. An uncertain
head write requires closing/recovering the workspace before retrying. A registry
write failure requires daemon restart. Closed intent and last-closed head survive
restart, allowing detection of rollback/divergence against that known head.

Workgraph is for a trusted local user and local filesystems. Actor names are audit
attribution, not authentication. Keep runtime/root parent directories private.
Current validation covers macOS file, rename and directory-sync paths; see
[validation](validation.md). Actual hardware power-loss behavior remains untested.
Process-kill tests do not prove hardware power-loss behavior.

Current bounds: 4 MiB wire frames/authoritative JSON files, nesting depth 64, 512-byte titles,
64 KiB text bodies, 10,000 tickets, 1,000 projects/milestones/actors/labels,
100 custom statuses, 100 labels per ticket, 10,000 resources and 100 links per resource,
100,000 transactions, 64 MiB
resolved event data and 128 MiB stored transaction bytes per workspace. The limits
are enforced to bound the local service, not measured capacity claims. Large responses
require smaller query pages. There is no history pruning or blob garbage collection.

## Coordination workflow

The standalone JSON CLI supports attributed runs and attempts, ready-ticket
claim-next, optional ticket and reservation leases, communication threads,
comments, structured evidence and reviews, run budgets, and observable session
history. The harness remains responsible for model calls, context assembly,
process launching, external side effects, token counting and stopping inference.
Heartbeats record liveness observations and never extend ownership; reported
token and elapsed-time limits require the harness to enforce provider spending.

See the [coordination guide](coordination-guide.md) and its
[CLI workflow example](../examples/coordination-workflow.sh). For durable transcript
ingestion and retrieval, see the [history integration guide](history-integration.md).
