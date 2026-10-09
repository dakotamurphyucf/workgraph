# CLI, wire contract, errors and limits

Read this shared CLI and wire contract before constructing requests.
Return to [the capability guide](../../AGENT_GUIDE.md) to choose another reference.
Unless a result is explicitly shown as a complete envelope, it describes `result.data`;
receipt, query and capture metadata are in `result.meta`. These are the current preview
contracts, not compatibility guarantees for previously published previews.

```xml
<workgraph_reference name="cli-contract">
<connection_and_cli>
<setup><![CDATA[
Use an installed `workgraph` executable, or an absolute path to a built executable.
`workgraph --version` prints the application version; `workgraph --help` prints CLI syntax.
For a new local daemon, create its private parent directories, then run in a separate process:
  workgraph serve /absolute/registry-directory /absolute/daemon.sock
The registry argument is a directory. Existing registry data is recovered on restart.
Use absolute paths; creation/export/restore/download destinations must be fresh and their
parents must exist. Workspace, registry and export roots must not overlap. On WSL keep
managed data under the Linux home filesystem, not /mnt/c. Run as the owning normal user.
Ctrl-C, SIGTERM, or daemon.shutdown drains admitted work. Reuse the same registry/socket
on restart. Do not delete a live daemon's socket, lock files or managed storage files.

Shell examples assume WG, SOCKET, WORKSPACE, ACTOR and REQUESTS are set by the harness.
REQUESTS must exist. Use a new filename for every new write. Never replace a retry file.
`jq` is only needed for examples that extract JSON in shell; the CLI itself does not need it.
]]></setup>
<forms><![CDATA[
"$WG" call "$SOCKET" METHOD '{"workspace_id":"demo", ...}'
"$WG" request "$SOCKET" METHOD [OPTIONS] [--field value ...]
"$WG" FAMILY ACTION "$SOCKET" [OPTIONS] [--field value ...]
"$WG" retry "$SOCKET" /absolute/saved-request.json [--timeout SECONDS] [--output text]

Example equivalents:
  workgraph call /abs/s ticket.context '{"workspace_id":"demo","ticket_id":"task"}'
  workgraph request /abs/s ticket.context --workspace-id demo --ticket-id task
  workgraph ticket context /abs/s --workspace-id demo --ticket-id task
Use request for multi-dot methods, e.g. review.policy.put. FAMILY ACTION joins with a dot,
except reserved CLI prefixes. For request.create use `workgraph request SOCKET request.create
...`, not `workgraph request create SOCKET ...`.
Raw call supplies fields in one parameter JSON object; field flags are not added to it.
Explicit local context/self options use the same addressing rules as named requests.

Agent-local setup:
workgraph init --context /abs/agent/context.json --socket /abs/workgraph.sock \
  --workspace-id demo --actor-id worker --root /abs/workspace --name Demo \
  --request-directory /abs/agent/requests
Add --start-daemon true --registry /abs/registry --daemon-log /abs/daemon.log to
start a daemon when unavailable. Repeated setup reuses the registered workspace;
a supplied root must identify its registered root. Existing contexts must match.
Setup reports context, workspace, actor, socket, root and request directory. Startup
races reuse the daemon that acquired its registry lock. Failure reports diagnostics;
bootstrap creation requests are saved beside the context for exact recovery.

Ordinary calls never create/select a workspace from cwd. Supply --context ABS_FILE
on each invocation to use that agent's defaults. The positional socket is optional
with a context or --socket ABS_SOCKET; --socket overrides a positional/context socket.
Explicit --workspace-id, --actor-id and --run-id override context defaults. Reads
receive workspace scope but no automatic actor filter or run attribution. There is
no shared current ticket or global mutable actor.

--self explicitly supplies a missing actor recipient for inbox.read/wait/ack and
request.list/acknowledge/accept, or target_run_id for run.get/transition/observe/link_session.
Explicit recipient/target_run_id wins, even without context. Otherwise supply --context
with actor/run identity, or an explicit selector. General reads never apply self filters
by default. --self does not select request.reassign destinations or run.register IDs.
It is a local flag, not an API field; raw JSON self fields remain unknown parameters.
Saved-request retry rejects --self so it cannot change the frozen operation.

Options for named requests:
--output json|text           JSON output (default), or human-readable output.
--timeout SECONDS            Positive finite timeout, default 30, maximum 3600.
--params-file FILE           Merge a JSON parameter object (duplicate fields reject).
--json-field FIELD JSON      Supply a JSON object, array, boolean, number or null.
--field-file FIELD FILE      Read a UTF-8 string from a file.
--save-request ABS_FILE      Sync a fresh exact retry file before transmission.
--request-directory ABS_DIR  Sync a fresh random-named file for each durable write.
--self                      Explicit context actor recipient or current run selector.
--FIELD VALUE               Hyphens become underscores. Declared Boolean fields accept
                            true/false; text and decimal fields remain strings.

Field names are literal: --actor sets actor, --actor-id sets actor_id, and --text VALUE
sets text. Output formatting uses --output text. Parameter-file keys are normalized
from hyphens to underscores, with no workspace/actor aliases. Nested keys are untouched.
For mixed/nullable Boolean alternatives use --json-field with explicit JSON.
Raw JSON, --json-field, --field-file and --params-file values are never coerced.
For example --include-markdown true is Boolean, while --title true is the text "true".
Configured request directories must already exist for ordinary calls; init creates
the chosen directory. Files are private, created exclusively and synced with their
parent before sending; stderr reports saved_request: ABS_FILE. A failed save sends
nothing. When mutation_id is absent, journaling generates a fresh stable identity.
A command reissue is a new operation; retry submits the identical saved operation,
without context field injection or an additional journal file. Explicit mutation_id
allows caller-managed recovery without a file. No automatic retries occur.
Omitting a field differs from setting null; send null only where explicitly allowed.
Saved requests freeze method, parameters, mutation ID and run attribution. `retry` accepts
no parameter overrides and also understands saved resource-upload plans. A normal saved
request is the full JSON-RPC request object shown below, with its exact method and params.
A harness can create/sync such a fresh file itself, then use retry for its first send and
later retries.
]]></forms>
<transport><![CDATA[
The CLI handles transport. Direct clients use a Unix stream socket with JSON-RPC 2.0:
4-byte unsigned big-endian byte length, then that many UTF-8 JSON bytes. Maximum frame
4 MiB, maximum JSON nesting depth 64. Params is an object. Send a request id (nonempty
string <=256 bytes recommended); notifications without an id are not supported.
Example request:
{"jsonrpc":"2.0","workgraph_api":"0.3","id":"read-1","method":"ticket.context","params":{"workspace_id":"demo","ticket_id":"task"}}
The application marker is required on every request, including initialize and saved exact
retries. The CLI supplies it; no discovery round trip is needed. Missing/unsupported
profiles return Unsupported_version before method-dependent interpretation. Package
version, workgraph_api and independently versioned persisted roots are separate identities.
Read docs/compatibility.md for the current-root inventory; opening never migrates old data.
Success: {"jsonrpc":"2.0","id":"read-1","result":{"data":{...},"meta":{...}}}
Error: {"jsonrpc":"2.0","id":"read-1","error":{"code":-32000,"message":"...","data":{"kind":"Conflict","message":"..."}}}
Do not interpret the JSON-RPC id as a mutation idempotency key. Validate matching response
id and exactly one result/error. The CLI prints server responses to stdout in JSON mode,
local/transport diagnostics to stderr, and exits nonzero on failure. In text mode server
errors also go to stderr. A lost reply or timeout after transmission may be an uncertain
write; inspect/retry its saved identity. The CLI never automatically retries.
]]></transport>
</connection_and_cli>
<common_contract>
<notation><![CDATA[
Method entries list additional parameters after one of these envelopes:
M (planning mutation): workspace_id, actor_id, mutation_id; optional run_id.
Q (workspace query): workspace_id. Optional actor filters do not make a query a mutation.
A (administrative write): actor_id, mutation_id plus the method's fields; no run_id.
N: no common envelope; the entry lists every field.
History writes, uploads, heartbeats and feeds have their explicitly stated contracts.

Fields without ? are required. ? means may be omitted, not automatically nullable.
`id` is a case-sensitive string of 1..96 ASCII letters, digits, underscores or hyphens.
Different entity ID types are distinct even if their string values match.
`dec` is a nonnegative canonical decimal STRING, e.g. "0", "1", "65536"; no JSON number,
negative sign, plus sign, whitespace, exponent or leading zeros. Counts/revisions/offsets/
claim tokens/limits use dec unless a schema explicitly says otherwise. Epoch milliseconds
also use decimal strings; timestamps returned for display can be treated as opaque strings.
`bool` is JSON true/false. `text` is UTF-8. `digest` is 64 lowercase SHA-256 hex characters.
`X|null` explicitly permits JSON null. A list is a JSON array. Field spelling is exact:
run vs run_id, ticket vs ticket_id, resource vs resource_id are NOT interchangeable.

Unknown/duplicate fields reject. Updates preserve omitted patch fields unless a method
says it replaces a whole record. Public enums use their documented strings and payload
variants use named objects. Stored events and derived OCaml values are not public request
formats. For the exact fields and result use workgraph help/schema METHOD or the generated
docs/api-reference/METHOD.md beside the entry guide; load only the method you need.
]]></notation>
<identity_revisions_and_receipts><![CDATA[
Mutation receipts are scoped by workspace + actor_id + mutation_id (administration uses
registry + actor_id + mutation_id). Reusing a key with changed method, parameters or run
returns Idempotency_conflict. Retrying the exact request returns the original receipt,
even after later changes. An old successful workspace.open retry does not reopen a later
closed workspace. Use a new identity only for a deliberate new operation.

Every successful JSON-RPC response has exactly result.data and result.meta. Read the
operation output from .result.data, whether the method reads or writes. Metadata is an
object containing only applicable fields; absent metadata is {}, not null.
Planning mutations: {"data":{...},"meta":{"workspace_revision":"12","durable":true}}.
Batch data is {"results":[{"method":"...","data":...},...]}; read
.result.data.results in operation order. Each item uses that method's result data contract. Planning queries use
meta.workspace_revision and meta.budget. Administrative writes use meta.durable=true.
Communication/evidence queries use meta.query_scope and meta.query_revision; run/policy
lists do likewise. A direct run/policy record retains its entity revision inside data.
History queries place immutable captures in meta.history_capture; history mutations use
meta.durable=true. History feeds use meta.history_sequence, never workspace_revision.
Export listings use meta.snapshot and meta.budget. Upload staging, resource byte reads,
heartbeats and daemon diagnostics have empty meta. Record revisions remain inside data.
Receipt lookup data.response is the original complete {data,meta} success object.
The planning workspace revision advances once per committed planning transaction.

Keep separate: workspace_revision; each entity's revision; handoff revision; claim token;
lease revision; communication/evidence/coordination query revisions; session event sequence;
history head; inbox/feed cursor. Never derive one from another. Read the relevant current
value before a guarded update. Fresh catalogs/settings/handoffs use expected_revision "0";
new projects/milestones/tickets start at entity revision "1".

Most supplied actor/run IDs are attribution, not authentication. Optional run_id must stay
the same for claim-protected work; actor+run+token together identify an owner. An invocation
run_id can be unregistered. If a registered run receives a claim, its actor must match and
its lifecycle must be nonterminal. A new invocation uses explicit reassignment, not the
old run's identity. Expiry/heartbeat/cancellation records do not stop external processes.
]]></identity_revisions_and_receipts>
<shared_shapes><![CDATA[
Entity_ref (for target/links):
  {"kind":"workspace"}                         // no id field
  {"kind":"project","id":"p"}
  {"kind":"milestone","id":"m"}
  {"kind":"ticket","id":"t"}
  {"kind":"resource","id":"r"}
Project/ticket/milestone status and status category:
  "backlog" | "todo" | "in_progress" | "done" | "canceled"
Discussion kind:
  "comment" | "progress" | "decision" | "blocker" | "evidence"
Priority: "1" urgent, "2" high, "3" normal, "4" low, "0" unspecified.
Display keys such as WG-1 are permanent labels, not ticket IDs. Resolve with ticket.resolve.
IDs may be omitted only for workspace/project/milestone/ticket/comment creation and new
resource creation/publication at revision zero. Capture the returned generated ID; exact
retries return that same ID. No extra preflight call is needed to generate IDs.
]]></shared_shapes>
<planning_queries><![CDATA[
Planning reads accept only the options in their method schema. Shared capture/budget
options are at_revision:dec and max_bytes:dec (default "65536", 4096..1048576). Paged
reads additionally accept limit:dec (default "50", 1..100) and offset:dec (default "0").
Current entity lists can accept include_archived:bool (default false). Scalar reads reject
paging options; history and blocker pages reject archive options. Do not apply a universal
option bundle to every query.
If offset>0, at_revision is required and must equal the captured workspace_revision.
Use the same filters and capture revision on subsequent pages. Conflict means restart
pagination against current state, not continue with a guessed revision.

Planning query response.result:
{"data":{...},"meta":{"workspace_revision":"12","budget":{"max_bytes":"65536","returned_bytes":"...","truncated":false,"omitted_fields":"0","omitted_items":"0","details":[],"details_complete":true}}}
Page = {items:[...],offset:dec,remaining:dec,next_offset:dec|null} inside data, or a nested
context field. Each nested page uses the request's shared offset/limit. Follow next_offset.
A budget counts the entire result object in bytes, excluding JSON-RPC framing. It can shorten text or arrays. Inspect meta.budget.truncated, omitted_fields/items and
its details [{path:JSON-pointer,kind:"text_bytes"|"items",omitted:dec}]. details_complete
false means the list of omission locations is itself incomplete. Narrow the query, raise
max_bytes within its bounds, or retrieve original bytes; a partial result proves no absence.
Some extension families preserve whole rows and return their own cursors instead of P.
Their sections state the exact revision/cursor fields; do not reuse at_revision everywhere.
The eight base reads workspace.get, project.get/list, milestone.get/list and
actor/label/status.list reject explicit null for optional fields. Their typed budgets
preserve identities, titles/names, revisions, counters, statuses, dates and progress.
Only description/instructions/summary/acceptance_criteria text and page suffixes may
shorten. A retained page advances by its returned count; an oversized first record
fails with Invalid_argument and instructions to raise max_bytes or narrow the query.
]]></planning_queries>
<record_contracts><![CDATA[
The generated docs/api-reference/METHOD.md files contain complete request and result
schemas from the actual executable codecs. Paths are relative to the entry guide.
Use workspace.get, project.get, milestone.get and ticket.context for current entity views;
ticket.list for summaries; ticket.readiness/blockers for actionable guards; handoff.get
and handoff.history for saved recovery notes; comment.get/list for discussion versions.
Use activity.since for the attributed change trail. Each method specifies its exact nested
records, source references and omission metadata. Do not treat an activity record as an
editable current entity or replay it as a command.

Keep the ownership token returned by a successful write; never predict it from next_token.
A comment's author_id is its original author; actor_id attributes the returned version.
Readiness is an observation, not permission to bypass the mutation's current-state checks.
]]></record_contracts>
</common_contract>
<errors_and_recovery><![CDATA[
Problem={kind:string,message:string,details?:object}; branch on error.data.kind, not message wording.
Optional details use a type discriminator: field (path segments, expected, suggestion),
revision (expected, actual), ownership (actor_id, run_id), readiness (ticket_id, blockers),
version (representation, observed, supported), or capacity (meter, used, limit, attempted,
unit, operator_action). Capacity attempted is proposed total usage, not an increment;
operator_action points to installed recovery guidance. No ownership token is included in these
diagnostics. Field messages use escaped JSON pointers such as /operations/0/params/title.
Readiness details are bounded summaries; inspect ticket.readiness for the full current view.
Invalid_argument: unknown/duplicate fields, wrong type/enum/JSON shape, missing required key,
 bad ID/counter, or a limit. Correct construction before a deliberate new operation.
Not_found: missing referenced entity/receipt subject; recover identity and current state.
Conflict: stale revision/cursor or incompatible state. Re-read; do not blindly increase a
 revision. If intent changes, make a new mutation with a fresh request file.
Blocked: unfinished prerequisite/child, hold, capacity/budget, reconciliation or review gate.
 Inspect readiness and the corresponding allocation/evidence state; resolve deliberately.
Dependency_cycle: repair the graph; parent/dependency self-links and cycles are invalid.
Already_claimed: another/current owner exists. Read ownership; do not steal via guessed token.
Stale_claim: wrong actor/run/token, expired timed lease or invalid time. Reconcile ownership;
 old process state must be checked by the harness before replacement or checkout reuse.
Idempotency_conflict: an existing ID/key names different content. Recover the original
 request. A timeout does not authorize changing the identity to try again.
Outcome_unknown: commit/publication might have happened. Keep exact request/input bytes.
 If workspace storage is fenced, close/open it or restart for recovery, then inspect its
 receipt and retry the same saved request. A registry fence requires daemon restart first.
Local_io: expected client-local file/output I/O failed. Fix the named path or permissions;
 this does not diagnose daemon storage. Missing/nonregular inputs and existing exclusive
 destinations report Invalid_argument. --field-file requires a regular file up to 4MiB;
 stdin, pipes and devices are not supported.
Storage_unavailable: storage operation could not establish success. Preserve request/evidence,
 fix disk/permissions/filesystem availability, recover ownership, then retry the same identity.
Workspace_closed: open the registered workspace with a fresh admin request when authorized;
 inspect daemon.health for unavailable/quarantined roots. A closed root is not deleted.
Corrupt_store: stop writes to affected data, retain originals/logs, and restore a verified
 backup into a fresh root. Never rewrite HEAD/transactions/blobs to guess a repair.
Unsupported_version: incompatible wire/storage/export representation. Use a matching build;
 this preview has no automatic prototype migration. Preserve the source data unchanged.

A disconnect does not cancel admitted work. A durable receipt is the authority for that
write, not a guess based on current memory. Hashes detect corruption but do not authenticate
an actor who can replace the whole store. Keep backups and private directories. Atomic
planning batches do not roll back model calls, external file changes, or history-stream
writes committed separately. Successful filesystem syncs and process-kill tests are not a
proof of actual storage-device power-loss behavior.
]]></errors_and_recovery>
<bounds_and_storage><![CDATA[
Current local-service ceilings include: 4MiB wire frames and authoritative planning JSON,
JSON nesting64, titles512 UTF-8 bytes, most planning text64KiB, 10000 tickets, 1000 projects,
1000 milestones/actors/labels, 100 custom statuses, 100 labels or related links per ticket,
10000 resources and100 links per resource, 100000 planning transactions,64MiB resolved event
data and128MiB stored planning transaction bytes per workspace. Specialized families have
their own limits stated inline. These are admission bounds, not measured capacity targets.
Smaller query pages may be needed before a frame/byte budget is exhausted. The registry is
bounded to4MiB and never evicts receipts. There is no automatic blob garbage collection,
history pruning, or distributed writer reconciliation. Limits reject new work rather than
silently deleting acknowledged history. Advisory heartbeat data is private .local state and
is excluded from portable history. The current schema is the only supported schema.
]]></bounds_and_storage>
</workgraph_reference>
```
