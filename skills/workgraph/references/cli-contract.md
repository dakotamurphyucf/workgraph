# CLI requests, responses, retry and limits

Read this before constructing requests. The CLI is the `workgraph` command-line
program; a method is an operation such as `ticket.context`. Read [getting
started](getting-started.md) for a runnable setup and [concepts](concepts.md) for
claims, receipts, revisions and captures. The wire contract describes the exact
messages used by direct clients; ordinary CLI users can skip the transport section.
Return to [the capability guide](../SKILL.md) to choose another reference.
Unless a result is explicitly shown as a complete envelope, it describes `result.data`;
receipt, query and capture metadata are in `result.meta`. These are the current preview
contracts for the 0.8.0 package candidate/application API 0.7. This source guide
does not announce a published 0.8.0 download. Normal daemon reads accept current formats;
[offline migration](migration.md) converts only the supported 0.6.2 workspace
representation into a new root. Resolve uncertain requests with the old executable
first; use a fresh registry, socket, context and request journals after conversion.
See [format compatibility](compatibility.md).

## Connection and CLI

### Setup

Use an installed `workgraph` executable, or an absolute path to a built executable.
`workgraph --version` prints the application version; `workgraph --help` prints CLI syntax.
For a new local daemon, create its private parent directories, then run in a separate process:

```sh
workgraph serve /absolute/registry-directory /absolute/daemon.sock
```

The registry argument is a directory. Existing registry data is recovered on restart.
Use absolute paths; creation/export/restore/download destinations must be fresh and their
parents must exist. Workspace, registry and export roots must not overlap. On WSL keep
managed data under the Linux home filesystem, not /mnt/c. Run as the owning normal user.
Ctrl-C, SIGTERM, or daemon.shutdown drains admitted work. Reuse the same registry/socket
on restart. Do not delete a live daemon's socket, lock files or managed storage files.
Startup uses an exclusive socket-path owner guard, shared across registries and parent
path aliases. Crash recovery may remove only the exact socket filesystem identity
previously recorded by that guard. Unknown, symlinked, replaced, bound or live peer paths
are refused. Connection refusal, a PID guess or a registry lock alone grants no cleanup
authority. A crash before socket identity publication conservatively requires a fresh
private endpoint. Do not remove guard/registry locks or storage to force startup.

Shell examples assume `WG` (executable), `SOCKET` (daemon socket), `WORKSPACE`
(workspace ID), `ACTOR` (your actor ID) and `REQUESTS` (private request directory)
are set by your runner. The [setup walkthrough](getting-started.md) introduces
these values; only use the variables needed by the chosen example.
REQUESTS must exist. Use a new filename for every new write. Never replace a retry file.
`jq` is only needed for examples that extract JSON in shell; the CLI itself does not need it.

### Forms

```text
"$WG" call "$SOCKET" METHOD '{"workspace_id":"demo", ...}'
"$WG" request "$SOCKET" METHOD [OPTIONS] [--field value ...]
"$WG" FAMILY ACTION "$SOCKET" [OPTIONS] [--field value ...]
"$WG" retry "$SOCKET" /absolute/saved-request.json [--timeout SECONDS] [--output text]
```

For the accountable-question feature (called the request domain), a context
allows these forms:

```sh
workgraph --context /abs/agent/context.json request get --request-id question-1
workgraph --context /abs/agent/context.json request list --ticket-id task
```

With context or --socket, get/list/ask/resolve/... selects request.ACTION. The generic
request ABS_SOCKET METHOD form keeps METHOD unchanged; dotted methods remain supported.
Incomplete/ambiguous forms give corrected usage instead of guessing a socket.

Equivalent ways to read one ticket:

```sh
workgraph call /abs/s ticket.context '{"workspace_id":"demo","ticket_id":"task"}'
workgraph request /abs/s ticket.context --workspace-id demo --ticket-id task
workgraph ticket context /abs/s --workspace-id demo --ticket-id task
```

Use request for multi-dot methods, e.g. review.policy.put. FAMILY ACTION joins with a dot,
except reserved CLI prefixes. For request.create use `workgraph request SOCKET request.create
...`, not `workgraph request create SOCKET ...`.
Raw call supplies fields in one parameter JSON object; field flags are not added to it.
Explicit local context/self options use the same addressing rules as named requests.

Agent-local setup (choose actual private absolute paths):

```sh
workgraph init --context /abs/agent/context.json --socket /abs/workgraph.sock \
  --workspace-id demo --actor-id worker --root /abs/workspace --name Demo \
  --request-directory /abs/agent/requests
```

Add --start-daemon true --registry /abs/registry --daemon-log /abs/daemon.log to
start a daemon when unavailable. `workgraph init --help`, `help init` and bootstrap
equivalents print helper usage offline, without loading context or creating files.
Repeated setup reuses the registered workspace; a supplied root must identify its registered root. Existing contexts must match.
Setup reports context, workspace, actor, socket, root and request directory. Startup
races reuse a responding compatible daemon through the typed socket-owner result.
Readiness verifies the initialize handshake and reports bounded child exit/log diagnostics;
bootstrap creation/open requests are saved in the configured request directory
before sending, or beside the context when no directory is configured. The
directory is created and validated before daemon startup or a mutation.

Ordinary calls never create/select a workspace from cwd. Supply --context ABS_FILE
on each invocation to use that agent's defaults. The positional socket is optional
with a context or --socket ABS_SOCKET; --socket overrides a positional/context socket.
Explicit --workspace-id, --actor-id and --run-id override context defaults. Ordinary
reads receive workspace scope but no automatic actor filter or run attribution.
`transaction.preflight` uses the context's intended writer actor/run, just like
`transaction.apply`, to check the same ownership rules without making a change or
saving a mutation journal. An observer context must supply an explicit actor to
preview a write. There is
no shared current ticket or global mutable actor. A context with no run_id supplies
no run identity; target_run_id and fresh attempt_id remain explicit for claim_next.
Raw API envelopes require all schema-required inputs. Context defaults supply only
admitted scope/attribution fields; saved journaling can generate missing mutation_id.
ticket.get is a CLI alias for ticket.context, canonicalized before saving retry bytes.
The daemon has only the canonical ticket.context method; raw socket callers use it.
Brief help shows one level of nested object/array/tagged inputs; --full or schema METHOD
provides complete contracts.

For offline feature discovery, use `workgraph capabilities [ID]` to browse the
feature map or `workgraph discover 'intent text'` for a ranked set of methods,
local helpers and workflow recipes. `--capability ID`, `--kind
method|helper|workflow` and `--limit 1..20` (default 5) narrow discovery. Both
commands support `--output text|json`; `discover --catalog` emits the full metadata
inventory without schemas. `help FAMILY` explains a family's distinctions and
starting points; `help workflow.ID` gives an advisory recipe. Continue with
`help METHOD`, `fields METHOD` or `schema METHOD` for its actual contract. The
[discovery index](discovery/index.md) provides portable copies of the decision cards.
These commands need no context, socket or daemon and search CLI metadata.
`search.query` searches recorded workspace content; `history.search` searches
imported conversation history. Feature categories are distinct from a run's
eligibility capabilities; neither discovery nor core/advanced tiers grant permissions.

For machine-readable input discovery, `workgraph fields METHOD` runs offline and
needs no context or daemon. It returns `fields` ordered by name, each with a
`requirement` (`required`, `optional`, or `conditional`), a readable `summary`,
`descriptions`, the complete field `schema`, and the `--json-field` argument form.
Limits such as UTF-8 bytes and array length come from the executable codecs.
`validation_schema` preserves the full unfactored request contract, including
nested alternatives and cross-field descriptions; it is equivalent to the
reference-expanded `schema METHOD` params. The flat list is a discovery aid,
not an independent validator. Context defaults can supply some raw-required fields.

```sh
workgraph fields ticket.start > /absolute/private/ticket-start-fields.json
jq '.fields[] | {name, requirement, summary}' /absolute/private/ticket-start-fields.json
workgraph fields resource.put_text | jq '.fields[] | select(.name == "text")'
```

Structured values use `--json-field FIELD JSON` or a params file. Supply quoted JSON
for a string, an actual array for an array, and an actual object for an object.
The full catalog remains available through `workgraph schema`; method modes say
whether a call is a read, an ephemeral write or a durable mutation. Local helpers
such as `resource.publish_text` have dedicated `help`, not daemon schemas.


--self explicitly supplies a missing actor recipient for inbox.read/wait/ack and
request.list/acknowledge/accept, or target_run_id for run.get/transition/observe/link_session.
Explicit recipient/target_run_id wins, even without context. Otherwise supply --context
with actor/run identity, or an explicit selector. General reads never apply self filters
by default. --self does not select request.reassign destinations or run.register IDs.
It is a local flag, not an API field; raw JSON self fields remain unknown parameters.
Saved-request retry rejects --self so it cannot change the frozen operation.

Options for named requests:

```text
--output json|text           JSON output (default), or human-readable output.
--timeout SECONDS            Positive finite timeout, default 30, maximum 3600.
--params-file FILE|-         Merge a JSON parameter object (duplicate fields reject).
--json-field FIELD JSON      Supply a JSON object, array, boolean, number or null.
--field-file FIELD FILE|-    Read exact UTF-8 bytes, including trailing newlines.
--save-request ABS_FILE      Sync exact retry bytes; reuse only identical existing bytes.
--request-directory ABS_DIR  Sync an ordinary durable write under its envelope-hash filename.
--self                      Explicit context actor recipient or current run selector.
--FIELD VALUE               Hyphens become underscores. Declared Boolean fields accept
                            true/false; text and decimal fields remain strings.
```

Field names are literal: --actor sets actor, --actor-id sets actor_id, and --text VALUE
sets text. Output formatting uses --output text. Parameter-file keys are normalized
from hyphens to underscores, with no workspace/actor aliases. Nested keys are untouched.
For mixed/nullable Boolean alternatives use --json-field with explicit JSON.
Array/object parameters need `--json-field FIELD JSON` or `--params-file FILE`;
`--recipients '[...]'` is a string, while `--json-field recipients '[...]'` is an
array. The CLI reports this distinction before sending a malformed request.
Raw JSON, --json-field, --field-file and --params-file values are never coerced.
For example --include-markdown true is Boolean, while --title true is the text "true".
Configured request directories must already exist for ordinary calls; init creates
the chosen directory. Ordinary request files are private, published atomically without
replacement and synced with their parent before sending; stderr reports
saved_request: ABS_FILE. Existing identical full-envelope bytes may be verified and
re-synced. Different bytes at the same destination reject without overwriting.
A failed save sends
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

### Inspect local mutation journals

`workgraph journal inspect /absolute/request.json` shows metadata for one current
saved request. `workgraph journal list /absolute/requests` scans sorted, nonrecursive
`.json` files, with per-file validation diagnostics. These offline helpers do not load
context defaults, contact a daemon, replay a mutation or read an upload's source file.
They expose the exact saved method, canonical full `envelope_hash`, and `mutation`
scope/actor/mutation/run plus server `request_hash` when applicable. They omit payloads.

Receipt namespaces differ. `planning` hashes the method, unscoped command fields and
optional run attribution; workspace/actor/mutation identify its receipt scope/key.
`registry` hashes the method and original full parameters. `history` uses the same
full-parameter hash formula in an independent per-workspace receipt journal.
Generated entity IDs and transaction aliases remain unresolved in the saved request
hash. Saved method aliases are never rewritten. A local `resource.upload` plan exposes
its own envelope hash and a distinct `resource.finish_upload` planning mutation/hash;
an optional later ticket link is a separate workflow. No plan hash proves either commit.

`commit_status=unchecked` and `transmission_status=unknown` are deliberate. A journal
is a saved attempt: it can precede failed transport, rejection, cancellation, or a
nondurable empty allocation observation. Its presence, absence or duplicate count
does not establish a commit. Confirm actual durable receipts separately, and use
`retry` with the original file after uncertainty. Files do not bind an authenticated
server; the caller chooses the intended endpoint for receipt lookup or retry.

Listing accepts `--limit COUNT` (1..1000; default100), `--after BASENAME` and
`--max-bytes BYTES` (aggregate input budget4..64MiB; default16MiB). Each file is bounded
to4MiB; a directory may contain at most10000 names. Output is capped at1MiB. Inspect
`complete`, `next_after` and `stop` before treating results as complete; continue with
the same limits and returned `next_after`. `charged_bytes` conservatively charges
failed reads against the input budget. `groups` reports duplicate or conflicting
request hashes within the same namespace/actor/mutation scope and **returned entries
only**. A different request ID can change the envelope hash while preserving the
server request hash. Partial pages cannot prove there are no other conflicting files.
The scan is a local observation; concurrent changes can require restarting it.
If a file cannot be read within the remaining page input budget, the page stops
before that filename. Resuming from `next_after` retries the same file with the full
budget and can then return its per-file diagnostic.

Ordinary request-directory filenames are SHA-256 of the canonical complete envelope,
followed by `.json`. An exact explicit identity/request can reuse the same durable
file. A fresh generated mutation remains a new operation with a new filename; an
existing `--save-request` never supplies or replaces that generated identity.
Changed payloads with an explicitly reused identity at different paths remain
inspectable as a potential hash conflict; the daemon decides actual idempotency.
Bootstrap and reservation-wait retain their documented separate journal naming rules.

New journal publication syncs a private sibling stage, links it without replacement,
then syncs the parent. Concurrent identical saves verify/re-sync one complete winner;
different bytes have one winner and a rejecting loser. Existing symlinks, special
files, truncated or different bytes reject unchanged. Identical regular hardlinks
are permitted; journal directories and their files must remain private and immutable.
Cancellation and unexpected
exceptions propagate. Interrupted stages or installed files remain inspectable;
private `.journal-*.stage` siblings are excluded from ordinary `.json` listings and
may be inspected explicitly. Re-sync an exact installed file to recover interrupted
local publication; no network request starts unless saving succeeds. Never delete
the only saved identity after an uncertain remote outcome.

### Transport

The CLI handles transport. Direct clients use a Unix stream socket with JSON-RPC 2.0:
4-byte unsigned big-endian byte length, then that many UTF-8 JSON bytes. Maximum frame
4 MiB, maximum JSON nesting depth 64. Params is an object. Send a nonempty string
request id of at most 256 UTF-8 bytes; notifications without an id are not supported.
Example request:

```json
{"jsonrpc":"2.0","workgraph_api":"0.7","id":"read-1","method":"ticket.context","params":{"workspace_id":"demo","ticket_id":"task"}}
```

The application marker is required on every request, including initialize and saved exact
retries. The CLI supplies it; no discovery round trip is needed. Missing/unsupported
profiles return Unsupported_version before method-dependent interpretation. Valid parsed
IDs survive envelope rejection when possible. A strict JSON-RPC invalid-envelope rejection
may use null ID, including an older peer rejecting the application marker; it establishes
rejection before dispatch. This recognizes rejection without supporting older wire data.
Package version, workgraph_api and independently versioned persisted roots are separate identities.
Read [compatibility](compatibility.md) for the current storage-format inventory;
opening never migrates old data.
Successful responses have `result:{data,meta}`. Error responses instead have
`error:{code,message,data}`; `error.data.kind` is the programmatic problem kind,
for example `Conflict`. The complete shapes are in the [common API contract](api/common.md).
Do not interpret the JSON-RPC id as a mutation idempotency key. Validate matching response
id and exactly one result/error. In JSON mode the CLI prints one JSON-RPC envelope to
stdout for every result or expected failure, including local validation, input-file and
transport failures, and exits nonzero on failure. Error details remain at
`error.data`, with code `-32000`; local failures use ID `"cli"` until a saved request
ID is available, then preserve that exact ID. Stderr carries diagnostics such as
`saved_request: PATH`. In text mode errors go to stderr. Raw resource-download stdout
and evidence inspection with `--output bytes` keep errors and receipts on stderr,
so even a partial byte stream is never followed by an error envelope. A lost reply or
timeout after transmission may be an uncertain
write; inspect/retry its saved identity. Malformed, mismatched or unreadable responses
after a write could have executed remain uncertain; an unreadable error is no proof of
nonexecution. Never replace the mutation ID after uncertainty. A connection failure
before any send reports failure before execution. The CLI never automatically retries.

Check the exit status before extracting a response. Piping a failed command into
`jq '.result.data'` can print `null` and hide the original failure. For example:

```sh
if ! wg ticket context --ticket-id "$TICKET" \
    > "$AGENT_DIR/response.json" 2> "$AGENT_DIR/diagnostic.txt"; then
  cat "$AGENT_DIR/diagnostic.txt" >&2
  cat "$AGENT_DIR/response.json" >&2
  exit 1
fi
jq -e '.result.data.ticket' "$AGENT_DIR/response.json" || exit 1
```

A fact's value may legitimately be JSON `null`; it is not deletion or proof that a
shell pipeline failed. If your task requires an object with particular fields,
validate that requirement before constructing the request. For example,
`jq -e 'type == "object" and (.summary | type == "string")' "$FACT_FILE"`
checks for an object with a string summary. Build the parameter object from that
file with `jq --slurpfile`, or supply it through `--params-file`, and check both
commands' exit statuses. Facts have a 4 KiB canonical JSON limit; put longer notes
in a resource and keep a short summary or reference in the fact.

## Common contract

### Common fields and compact notation

A request's parameter object contains both shared identity/scope fields and the
chosen method's fields. Some focused references abbreviate those shared fields:

| Label | Meaning | Shared fields |
| --- | --- | --- |
| `M` | Planning mutation: a write to workspace planning state | `workspace_id`, `actor_id`, `mutation_id`; optional `run_id` |
| `Q` | Workspace query: a read | `workspace_id`; any actor filters are explicit and do not make it a write |
| `A` | Administrative write | `actor_id`, `mutation_id`, then method fields; no `run_id` |
| `N` | No shared fields | The method lists every field |
| `P` | A method's supported planning read/page options | `at_revision`, `max_bytes`, and where declared `limit`, `offset`, `include_archived`; never assume all apply |

History writes, uploads, heartbeats and feeds use their specifically documented
contracts. These labels are documentation shorthand, not API fields.

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
says it replaces a whole record. An enum is a fixed set of permitted values; use its documented strings. A
tagged alternative is an object whose named kind identifies which fields apply. Stored events and derived OCaml values are not public request
formats. For the exact fields and result use workgraph help/schema METHOD or the generated
[API index](api/index.md) and its per-method files; load only the method you need.

### Identity, revisions and receipts

Mutation receipts are scoped by workspace + actor_id + mutation_id (administration uses
registry + actor_id + mutation_id). Reusing a key with changed method, parameters or run
returns Idempotency_conflict. Retrying the exact request returns the original receipt,
even after later changes. An old successful workspace.open retry does not reopen a later
closed workspace. Use a new identity only for a deliberate new operation.

Every successful JSON-RPC response has exactly result.data and result.meta. Read the
operation output from .result.data, whether the method reads or writes. Metadata is an
object containing only applicable fields; absent metadata is {}, not null.
Committed planning mutations: {"data":{...},"meta":{"workspace_revision":"12","durable":true}}.
Standalone empty claim_next is an observation with durable:false, unchanged revision and
no stored receipt; its exact identity may reevaluate until a selection commits. Explicit
transaction batches remain durable. Never interpret an uncertain acknowledgement as empty.
Batch data is {"results":[{"method":"...","data":...},...]}; read
.result.data.results in operation order. Each item uses that method's result data contract. Planning queries use
meta.workspace_revision and meta.budget. Administrative writes use meta.durable=true.
Communication/evidence queries use meta.query_scope and meta.query_revision; run/policy
lists do likewise. A direct run/policy record retains its entity revision inside data.
History queries place immutable captures in meta.history_capture; history mutations use
meta.durable=true. History feeds use meta.history_sequence, never workspace_revision.
Export listings use meta.snapshot and meta.budget. Upload staging, resource byte reads,
heartbeats and daemon diagnostics have empty meta. Record revisions remain inside data.
ticket.finish and ticket.release return
data.ticket_revision for the affected ticket; finish retains any completed attempt result.
request.get reports data.revision for the request and data.thread_revision for its current
discussion thread. Neither is the planning receipt meta.workspace_revision or the
communication query meta.query_revision.
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
old run's identity. Tokens are visible sequential stale-writer fences, not credentials;
never use another owner's token even when a read exposes it. Expiry/heartbeat/cancellation
records do not stop external processes. claim_next requires a registered nonterminal run
owned by actor_id, matching target_run_id/run_id attribution and a fresh attempt_id.

### Shared shapes

An entity reference (`Entity_ref`) identifies a target or link. These are alternative
JSON objects; a workspace reference has no `id` field:

```text
  {"kind":"workspace"}                         // no id field
  {"kind":"project","id":"p"}
  {"kind":"milestone","id":"m"}
  {"kind":"ticket","id":"t"}
  {"kind":"resource","id":"r"}
```

Project/ticket/milestone status and status category:
  "backlog" | "todo" | "in_progress" | "done" | "canceled"
Discussion kind:
  "comment" | "progress" | "decision" | "blocker" | "evidence"
Priority: "1" urgent, "2" high, "3" normal, "4" low, "0" unspecified.
Display keys such as WG-1 are permanent labels, not ticket IDs. Resolve with ticket.resolve.
IDs may be omitted only for workspace/project/milestone/ticket/comment creation and new
resource creation/publication at revision zero. Capture the returned generated ID; exact
retries return that same ID. No extra preflight call is needed to generate IDs.

### Planning queries

Planning reads accept only the options in their method schema. Shared capture/budget
options are at_revision:dec and max_bytes:dec (default "65536", 4096..1048576). Paged
reads additionally accept limit:dec (default "50", 1..100) and offset:dec (default "0").
Current entity lists can accept include_archived:bool (default false). Scalar reads reject
paging options; history and blocker pages reject archive options. Do not apply a universal
option bundle to every query.
If offset>0, at_revision is required and must equal the captured workspace_revision.
Use the same filters and capture revision on subsequent pages. Conflict means restart
pagination against current state, not continue with a guessed revision.

A planning query's `result` has this shape (ellipsis marks explanatory placeholders):

```text
{"data":{...},"meta":{"workspace_revision":"12","budget":{"max_bytes":"65536","returned_bytes":"...","truncated":false,"omitted_fields":"0","omitted_items":"0","details":[],"details_complete":true}}}
```

A page is an object with `items`, `offset`, `remaining` and nullable `next_offset`.
Compact references may write `Page<Ticket>` to mean a page of tickets.
Pages appear inside `data` or a nested context field. Each nested page uses the
request's shared offset/limit. Follow `next_offset` until it is null.
A budget counts the entire result object in bytes, excluding JSON-RPC framing.
It can shorten text or arrays. Inspect meta.budget.truncated, omitted_fields/items and
its details [{path:JSON-pointer,kind:"text_bytes"|"items",omitted:dec}]. details_complete
false means the list of omission locations is itself incomplete. Narrow the query, raise
max_bytes within its bounds, or retrieve original bytes; a partial result proves no absence.
Some method families preserve whole rows and return their own continuation cursors
instead of these planning page options.
Their sections state the exact revision/cursor fields; do not reuse at_revision everywhere.
The eight base reads workspace.get, project.get/list, milestone.get/list and
actor/label/status.list reject explicit null for optional fields. Their typed budgets
preserve identities, titles/names, revisions, counters, statuses, dates and progress.
Only description/instructions/summary/acceptance_criteria text and page suffixes may
shorten. A retained page advances by its returned count; an oversized first record
fails with Invalid_argument and instructions to raise max_bytes or narrow the query.

### Record contracts

The [generated API index](api/index.md) links complete request and result
schemas from the executable's actual encoding and decoding rules.
Use workspace.get, project.get, milestone.get and ticket.context for current entity views;
ticket.list for summaries; ticket.readiness/blockers for actionable guards; handoff.get
and handoff.history for saved recovery notes; comment.get/list for discussion versions.
Use activity.since for the attributed change trail. Each method specifies its exact nested
records, source references and omission metadata. Do not treat an activity record as an
editable current entity or replay it as a command.

Keep the ownership token returned by a successful write; never predict it from next_token.
A comment's author_id is its original author; actor_id attributes the returned version.
Readiness is an observation, not permission to bypass the mutation's current-state checks.

## Errors and recovery

A problem has `kind`, `message` and optional structured `details`. Branch on
`error.data.kind`, not message wording. A **fenced** store temporarily refuses
further writes because a previous storage operation had an uncertain outcome;
recover it before attempting new work.
Optional details use a type discriminator: field (path segments, expected, suggestion),
revision (expected, actual), entity_revision (entity identity, expected, actual),
identity_collision, ownership, claim (unclaimed or actor/run/token mismatch without token
disclosure), allocation (typed admission reasons and omitted_reasons), reservation_conflict
(requested target, bounded owners and omitted_owners), readiness (ticket_id, blockers,
omitted_blockers), size (actual, maximum, unit), socket_owner,
version (representation, observed, supported), or capacity (meter, used, limit, attempted,
unit, operator_action). Capacity attempted is proposed total usage, not an increment;
operator_action points to installed recovery guidance. No ownership token is included in these
diagnostics. Field messages use escaped JSON pointers such as /operations/0/params/title.
Readiness details preserve up to 100 exact blockers with omitted_blockers; transport
keeps at most 16 with an exact listed-plus-omitted total. Allocation reasons and
reservation owners retain their own exact omission counts. Blocked ticket.finish uses
the same typed readiness model as ticket.start. Inspect ticket.readiness for the full
current view; diagnostic omission never means the omitted blockers are satisfied.

- `Invalid_argument`: unknown/duplicate fields, wrong type/enum/JSON shape, missing required key,
 bad ID/counter, or a limit. Correct construction before a deliberate new operation.

- `Not_found`: missing referenced entity/receipt subject; recover identity and current state.

- `Conflict`: stale revision/cursor or incompatible state. Re-read; do not blindly increase a
 revision. If intent changes, make a new mutation with a fresh request file.

- `Blocked`: unfinished prerequisite/child, hold, capacity/budget, reconciliation or review gate.
 Inspect readiness and the corresponding allocation/evidence state; resolve deliberately.

- `Dependency_cycle`: repair the graph; parent/dependency self-links and cycles are invalid.

- `Already_claimed`: another/current owner exists. Read ownership; do not steal via guessed token.

- `Stale_claim`: wrong actor/run/token, expired timed lease or invalid time. Reconcile ownership;
 old process state must be checked by the harness before replacement or checkout reuse.

- `Idempotency_conflict`: an existing ID/key names different content. Recover the original
 request. A timeout does not authorize changing the identity to try again.

- `Outcome_unknown`: commit/publication might have happened. Keep exact request/input bytes.
 If workspace storage is fenced, close/open it or restart for recovery, then inspect its
 receipt and retry the same saved request. A registry fence requires daemon restart first.

- `Local_io`: expected client-local file/output I/O failed. Fix the named path or permissions;
 this does not diagnose daemon storage. Missing/nonregular inputs and existing exclusive
 destinations report Invalid_argument. --field-file accepts a bounded regular file or
 explicit - for stdin (up to 4 MiB). Named pipes/devices are not regular-file inputs.

- `Storage_unavailable`: storage operation could not establish success. Preserve request/evidence,
 fix disk/permissions/filesystem availability, recover ownership, then retry the same identity.

- `Workspace_closed`: open the registered workspace with a fresh admin request when authorized;
 inspect daemon.health for unavailable/quarantined roots. A closed root is not deleted.

- `Corrupt_store`: stop writes to affected data, retain originals/logs, and restore a verified
 backup into a fresh root. Never rewrite HEAD/transactions/blobs to guess a repair.

- `Unsupported_version`: incompatible wire/storage/export representation. Use a matching build;
 normal startup does not convert old data. Preserve the source and follow
 [migration](migration.md) only when it matches the supported source representation.

A disconnect does not cancel admitted work. A durable receipt is the authority for that
write, not a guess based on current memory. Hashes detect corruption but do not authenticate
an actor who can replace the whole store. Keep backups and private directories. Atomic
planning batches do not roll back model calls, external file changes, or history-stream
writes committed separately. Successful filesystem syncs and process-kill tests are not a
proof of actual storage-device power-loss behavior.

## Bounds and storage

Current local-service ceilings include: 4MiB wire frames and authoritative planning JSON,
JSON nesting 64, titles512 UTF-8 bytes, most planning text 64 KiB, 10000 tickets, 1000 projects,
1000 milestones/actors/labels, 100 custom statuses, 100 labels or related links per ticket,
10000 resources and 100 links per resource, 100000 planning transactions, 64 MiB resolved event
data and 128 MiB stored planning transaction bytes per workspace. Specialized families have
their own limits stated inline. These are admission bounds, not measured capacity targets.
Smaller query pages may be needed before a frame/byte budget is exhausted. The registry is
bounded to 4 MiB and never evicts receipts. There is no automatic blob garbage collection,
history pruning, or distributed writer reconciliation. Limits reject new work rather than
silently deleting acknowledged history. Advisory heartbeat data is private .local state and
is excluded from portable history. The current schema is the only supported schema.

## Materialized input and bounded pages

Only one stdin consumer is allowed across --params-file - and --field-file FIELD -. Input
is materialized and validated before saving the exact request. An invalid materialized
parameter object can produce a local error envelope with no daemon call or saved
journal; raw RPC validation produces a server error envelope. Both use stdout in
JSON mode. Retry rejects new
input/identity overrides before consuming stdin. Observer contexts may omit actor/run;
write attribution must still be supplied. Offline help never opens context or contacts a
daemon.

Opt-in --paginate traverses declared supported top-level collection families. Defaults are
--page-limit 100 and --total-bytes 16777216; ranges are 1..1000 pages and 4096..67108864
bytes. Selectors and each family's planning/domain revision, immutable history head,
export snapshot, opaque cursor or inbox through boundary remain fixed. Each exact page is
retained in data.pages. Inspect
data.pagination.complete/stop/capture/next_request/retry_request/problem and process exit.
An incomplete traversal stops nonzero; it never refreshes guards, retries implicitly,
acknowledges delivery or splits a transaction. Body/index omissions remain visible even on
complete traversal. Resume the exact next_request; retry_request repeats an unconsumed
position. Nested multi-section views and waits reject this helper, including attention's
separate readiness pages. Run help pagination for the exact supported method list.

### Exact continuation on a single page

Ordinary `request` and friendly CLI reads of supported collections add validated
client-only `result.meta.pagination`. It contains `complete`, `stop`, `consistency`,
`capture`, `next_request` and `retry_request`. `next_request` advances exactly the
returned position; `retry_request` repeats an unconsumed position. Neither is an
instruction to discard a stale guard or restart from the latest state. Unsupported
methods and bounded views such as `history.read` with direction `around` keep their
original result shape. Raw `call` and saved `retry` return the original wire result.

Save the complete next/retry request JSON and pass it to `workgraph retry SOCKET
ABS_FILE`, or use its exact method and parameters for another ordinary read.
Planning pages retain `at_revision`, domain pages retain their declared
`expected_revision` or `revision` together with query scope, and export lists retain
`at_snapshot`. These guards detect changes. Immutable audit/digest cursors and history
heads instead retain the original capture while newer commits arrive. Inbox `through`
counts notifications. All selectors remain attached to their original family.
`ticket.resume` continues its history through `activity.digest` with the same ticket
scope and returned cursor; current task fields are not reread as a substitute.

`ticket.recovery.list` is a planning read whose continuation uses
`expected_revision` with the captured `meta.workspace_revision`. The separate
`recovery.list` method uses `meta.query_revision` in the runs domain. The CLI
supplies the appropriate continuation guard; neither method accepts `meta` or
`query_revision` as request parameters.

The daemon's `max_bytes` and `meta.budget.returned_bytes` describe its original
payload. Client continuation metadata independently records its own `max_bytes`
(65536) and canonical `returned_bytes`. If an exact continuation exceeds that cap,
`stop:"metadata_limit"`, `complete:false` and `required_bytes` disclose the omission;
the original page is preserved and request fields are never clipped. A supported
single-page read still exits successfully when more pages remain. Explicit
`--paginate` retains its bounded collection envelope and incomplete exit status.

For example, a read requested with `--max-bytes 1048576` may return a 108 KB page
and only about 300 bytes of continuation metadata. Read
`meta.budget.max_bytes` / `meta.budget.returned_bytes` for the page, and
`meta.pagination.max_bytes` / `meta.pagination.returned_bytes` for the small
metadata object. The latter's 65536-byte limit does not reduce the requested page
budget. These counts use canonical UTF-8 JSON; pretty printing and the outer
JSON-RPC envelope add bytes. Some methods omit `meta.budget`; in that case it is
absent, and `meta.pagination` must not be used as a page-size estimate.

### Choose the actual receipt field

There is no universal result ID, revision or status. `help receipts` gives a compact
offline reference; `help METHOD` lists the specific result paths.

| Operation | Read from `.result` |
| --- | --- |
| `request.ask` | `data.request_id`, `data.request_revision`, `data.thread_revision`, `data.question`; no status or generic revision. |
| `request.get` | `data.revision` guards that request; `data.status.kind` is its state; `data.question` is the original pinned question body/version; `data.answer` is the pinned answer body/version or null. |
| `request.resolve` | `data.request_revision`, `data.thread_revision`, `data.status.kind`; `data.answer` is a comment/version reference, not the expanded body. |
| `ticket.progress` | `data.comment_id` identifies the new progress note; it does not return a new ticket revision. |
| Receipt-bearing workspace mutation | `meta.workspace_revision` identifies the commit, not a ticket, comment, thread or resource revision. |
| List read | Usually `data.items`, with method-specific continuation and budget metadata; do not assume the result itself is an array. |

After progress, read `ticket.get` if you need the ticket's current revision, and
`comment.get` for the progress comment. For an answer, use `request.get` or
[the bounded request wait helper](communication-evidence.md#wait-for-one-requests-answer).
The latter preserves the request data paths and adds local `meta.wait`; it does not
write or acknowledge delivery.

### Nested section continuations

Ordinary `ticket.context` reads and `thread.get` / `request.get` reads with
`include_messages=true` expose `meta.pagination.sections`. Each entry contains:

- `path`: the JSON pointer identifying the collection in the result, such as
  `/data/children`, `/data/updates`, or `/data/related/messages`.
- `complete` and `stop`: whether that collection has been fully returned.
- `next_request` or `retry_request`: the exact request envelope to save and execute.
- `response_path`, when present: the collection's location in that next/retry
  response. Otherwise consume the original `path`.

The enclosing `meta.pagination.next_request` and `retry_request` are null for
nested collections. Choose a section and consume only that section from the next
response; a context request returns other sections too. This is not an automatic
multi-section merge, and `--paginate` still applies only to supported flat reads.

```sh
workgraph --context "$CONTEXT" ticket context --ticket-id "$TICKET" --limit 10 > context.json
jq '.result.meta.pagination.sections[] | select(.path == "/data/children") | .next_request' context.json > next.json
# Only run this if next.json contains a request, not null.
workgraph retry "$SOCKET" "$PWD/next.json" > next-page.json
```

Ticket context continuations retain `at_revision` and each section's returned
offset. Expanded discussion continuations retain **both** communication `revision`
and `discussion_serial`, plus `message_offset`. Original selectors, limits,
and method names are preserved, except for the explicit fact-key handoff below.
Do not replace these guards with current values:
a conflict means the captured traversal became stale.

Text clipping produces a same-position `retry_request`; increase only `max_bytes`
when retrying it. Unsafe item omissions remain incomplete. A returned first
unconsumed offset is never skipped. The combined metadata remains capped at
64 KiB; `metadata_limit` reports an unavailable continuation instead of clipping it.
Ticket fact-key discovery continues through `fact.keys`, retaining the same
workspace revision and ticket scope. Its section has `response_path:"/data"`
because the dedicated listing returns its page there. Embedded evidence retains
its own domain-specific read APIs and capture metadata.
Raw `call` and saved `retry` retain exact daemon responses without CLI decoration;
use an ordinary named read with the saved parameters when another decorated page
is needed.
