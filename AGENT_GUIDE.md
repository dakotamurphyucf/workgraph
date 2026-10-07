# Workgraph: context guide for agents

Workgraph is a local task graph, durable working memory and coordination service.
Use its CLI to record work, recover context and coordinate with other agents.
The harness owns model calls, context assembly/eviction, process execution and
external tools. Workgraph records supplied facts; it does not launch agents,
isolate checkouts, count model tokens or stop external processes. No MCP is needed.

## Connection and command contract

Obtain these from the harness: executable path (`WG`), absolute Unix socket
(`SOCKET`), workspace ID, stable actor ID, and optional invocation/run ID. Reuse
the provided daemon. For a new local installation, build with `./dev build` and
run `_build/default/bin/main.exe serve ABS_REGISTRY ABS_SOCKET` in a separate
process. Registry, socket and workspace parents must exist; keep local data
directories private. A new workspace requires a fresh absolute root directory.
For example, `"$WG" workspace create "$SOCKET" --workspace demo --actor operator
--name Demo --root /absolute/new-workspace --save-request
/absolute/requests/create-workspace.json` creates and opens one; the request-file
parent must already exist. Workspaces are independent; transactions do not span them.

```sh
"$WG" request "$SOCKET" initialize
"$WG" daemon health "$SOCKET"
"$WG" workspace list "$SOCKET"
"$WG" workspace overview "$SOCKET" --workspace demo
```

All of these forms use the same API:

```sh
"$WG" call "$SOCKET" ticket.context '{"workspace_id":"demo","ticket_id":"task"}'
"$WG" request "$SOCKET" ticket.context --workspace demo --ticket-id task
"$WG" ticket context "$SOCKET" --workspace demo --ticket-id task
```

Use `request SOCKET METHOD` for methods with multiple dots such as
`review.policy.put`. `--params-file FILE` reads a JSON object; `--field-file FIELD
FILE` supplies a UTF-8 string; `--json-field FIELD JSON` supplies arrays, objects,
booleans or null. Plain field flags supply strings, except the documented boolean
flags. `--workspace` and `--actor` alias `workspace_id` and `actor_id`. Unknown or
duplicate fields reject; omission and null are not interchangeable everywhere.

IDs contain 1–96 ASCII letters, digits, underscores or hyphens. Display keys
(`WG-1`) are labels: `ticket.resolve --display-key WG-1` returns the ticket ID
used by relationships and mutations. Creation can generate IDs where documented;
use the returned ID. Revisions, tokens, offsets and limits are **decimal strings**
in JSON. Enum spelling and tagged object/array shapes are API-specific; use the
linked method references and examples rather than guessing.

Default stdout is JSON-RPC: success is `.result`; server errors are `.error`
(typed kind in `.error.data.kind`). Local CLI/transport errors are JSON on stderr.
Errors return nonzero status. A planning mutation's `.result` is a durable receipt:
`{workspace_revision, durable:true, result}`; its operation result is therefore
**`.result.result`**. Standard planning queries use
`{workspace_revision, data, budget}` inside `.result`. Administration, history and
extension queries have their own shapes; do not blindly unwrap every result twice.
`--text` is for human inspection, not parsing.

## Writes, retries and ownership

Planning writes require `workspace_id`, `actor_id`, `mutation_id`; include the
same optional `run_id` throughout claim-protected work. Administrative writes
also require actor/mutation IDs, but have registry-scoped receipts. Session history
has its own commit stream. Request correlation IDs are not idempotency keys.

Prefer saving each write **before** it is sent:

```sh
"$WG" ticket create "$SOCKET" --workspace demo --actor worker \
  --ticket-id task --title 'Verify restart recovery' \
  --description 'Record progress, restart, and recover the same context.' \
  --save-request /absolute/requests/create-task.json
# After a timeout/disconnect, retry this exact file:
"$WG" retry "$SOCKET" /absolute/requests/create-task.json
```

The save directory must exist and the request file must be fresh. The CLI generates
a mutation ID if absent and syncs the file before transmission. Retries return
the original receipt, even if later work changed the object. Never change the
arguments, run attribution or mutation ID to recover an uncertain write. Inspect
`workspace.receipt` or `registry.receipt` by actor/mutation ID if needed. There are
no automatic retries. A deliberate new operation needs a fresh mutation ID/file.

Keep these counters distinct:

| Counter | Use |
| --- | --- |
| Workspace revision | Planning transaction order and stable query pagination |
| Entity `revision` | `expected_revision` for that entity's next edit |
| Claim `token` | Actor/run ownership fence for progress, completion and handoff |
| Lease revision | Exact timed-lease renewal precondition |
| Session event sequence / history `head` | Conversation position / fixed history capture |
| Inbox/change cursor | Feed-specific position; retain the returned cursor |

## Working and resuming

1. Read workspace instructions, `project.brief`, then active `ticket.context`.
   Inspect its handoff, subsequent activity, readiness and claim. Retrieve linked
   resources only as needed. `search.query` finds planning text; `history.search`
   searches supplied conversation text.
2. Break the objective into tickets with acceptance criteria. Projects/milestones
   and parent links organize work; dependency edges control execution. Only done
   prerequisites unblock dependents; canceled prerequisites still block. Holds
   and waivers are explicit. Assignment alone does not reserve a ticket.
3. Query `ticket.ready` / `ticket.readiness`, then claim with the observed **ticket**
   revision. Preserve the returned token. A conflicting claim means re-read and
   choose work again, not overwrite another owner.
4. Record meaningful progress, decisions, evidence and remaining steps. Attach
   large logs/research as resources. Update the handoff before compaction or pause.
5. Run acceptance checks and attach evidence before completion. For registered
   attempts, publish that attempt's latest input/output manifest; configured review
   gates must accept that exact manifest. A plain discussion approval is insufficient.

Minimal claim/progress/handoff on the fresh ticket above (substitute observed
revisions/token on existing work):

```sh
"$WG" ticket claim "$SOCKET" --workspace demo --actor worker \
  --ticket-id task --expected-revision 1 --save-request /absolute/requests/claim.json
# Set TOKEN to the token returned inside .result.result; never infer it from revision.
"$WG" ticket progress "$SOCKET" --workspace demo --actor worker \
  --ticket-id task --token "$TOKEN" --body 'Fixture written; restart check is next.' \
  --save-request /absolute/requests/progress.json
"$WG" handoff set "$SOCKET" --workspace demo --actor worker \
  --ticket-id task --token "$TOKEN" --expected-revision 0 \
  --summary 'Fixture ready; restart check pending.' --next-steps 'Restart, then read context.' \
  --evidence 'Fixture creation passed.' --save-request /absolute/requests/handoff.json
```

`handoff.set` uses the handoff's own revision (`"0"` for first creation).
Optional fields include objective, completed, decisions, blockers, resource IDs
and `covers_through`. Set coverage only to a workspace revision actually reviewed;
the default is conservative. Useful notes state what changed, why, exact checks
and results, blockers, running processes and the next concrete action.

Retain a tiny recovery index across context resets: tool/connection instructions,
workspace/project/ticket IDs, actor/run/attempt, claim identity, history session IDs,
relevant resource versions and saved-request locations. Recover through queries;
do not put the entire transcript into every prompt. Workgraph preserves the data
you send, not facts you left only in discarded context.

## Resources, bounded retrieval and history

`resource.put_text` creates/updates text with `expected_revision`; `resource.link`
attaches it using a typed target such as `{"kind":"ticket","id":"task"}`.
`resource.upload` and `resource.download` handle files. Save upload requests and
retain the source bytes for retries. Content versions and metadata revisions are
distinct; pin content versions/digests for evidence. Resources are portable;
machine-local file paths alone are not.

Start with bounded summaries. Inspect `budget.truncated`, omission details and
page cursors before concluding that a result is complete. Standard planning offset
pages require `at_revision`; communication/evidence lists use `revision`, and
coordination lists use `expected_revision`, populated from the returned `revision`.
Stale revisions require a fresh query.
`ticket.context` includes handoff-following activity; use further pages or
`activity.since` for the rest. Planning resource search has bounded text coverage;
it is not full conversation search. Byte budgets are not model token budgets.

The harness can persist observable messages/tool calls/results using
`session.create` and `session.append`, with stable source IDs, opaque payload
bytes and separately supplied searchable UTF-8 text. Recording history does not
automatically publish a team message or update a handoff. See the
[history adapter contract](docs/history-integration.md) and runnable
[adapter](examples/history-adapter.py) for exact event shapes and crash-safe ingestion.

Use `session.get/list`, `history.get/read/search` to select context, then
`history.payload` to expand complete payload/text/attachment chunks. `history.read`
uses `before`, `after` or `around`; sequences start at one, and an `after` read may
start at anchor zero. Reuse the returned history `head` on later pages to exclude
new appends. Preserve `{session_id,sequence}` references. Search reports indexed
and committed coverage plus unsearchable events. If `restart_after_indexing:true`,
restart after indexing catches up; an empty partial response proves no absence.
Follow payload `next_offset`/`has_more` to retrieve all bytes.

## Multiple agents and communication

Register invocations with `run.register` (actor, objective, capabilities and
optional parent/worktree/process references). Use `ticket.claim_next` with a
registered run and stable attempt ID to atomically select eligible work, claim
it and create its attempt. The operation result is `kind:"selected"` with claim
and attempt fields, or `kind:"empty"`. Run-filtered `coordinator.overview` explains
eligible ready work and `allocation_blocked`; unfiltered readiness is graph-only.

| Need | Primitives and behavior |
| --- | --- |
| Reusable fork/join plans | Versioned `template.register/instantiate`; tickets, dependencies and instance commit together |
| Bound parallel work | Allocation pools, ticket capability/pool policies and run attempt budgets |
| Reserve a shared local asset | `reservation.acquire/renew/release`; harness honors ownership before external writes |
| Preserve task execution | Attempt checkpoints/session links; `attempt.finish` records terminal outcome and evidence |
| Request another agent's action | Board → thread → attached message → typed request, with recipients and designated resolver |
| Separate receipt from responsibility | Request acknowledge, accept, reassign, resolve/cancel are distinct transitions |
| Review exact artifacts | Contracts, manifests, review submission/verdicts/validators and acceptance gates |
| Handle changed inputs | Decisions, invalidation and reconciliation retain explicit evidence/version relationships |
| Wake a waiting harness | `changes.read/wait`; durable cursors and bounded results, without busy polling |

Use `thread.reply` with the thread revision to atomically add and attach a comment.
`thread.search` searches titles; discussion search handles message bodies.
Subscriptions plus `inbox.read` expose durable notifications. Reading does not
mark notifications read or acknowledge/accept a request. `inbox.mark_read` advances
the recipient's persisted position explicitly; preserve the fixed `through` bound
while paging. Teams snapshot recipients at request creation. Resolving a request
does not complete its ticket or resolve its thread.

Claims/reservations are indefinite by default. Opt-in timed leases require explicit
renewal with the ownership token and lease revision. `run.heartbeat` is a coalesced
observation, not a lease renewal or exact-once mutation; its durability flag matters.
Lease expiry, cancellation and run termination records do not stop a process or
fence external filesystem writes. The harness must stop/check old workers before
reusing their checkout. Token/time budgets use externally reported usage; Workgraph
does not measure provider spending or terminate inference.

## Failure handling and portable handoff

| Outcome | Action |
| --- | --- |
| `Outcome_unknown` / lost write reply | Retry the unchanged saved request; inspect receipt before changing intent |
| `Conflict` | Read current state; if a revised operation is still wanted, issue a fresh mutation |
| `Idempotency_conflict` | Same key has different content; recover original request, do not mutate it |
| `Already_claimed`, `Blocked`, `Stale_claim` | Re-read readiness/ownership; resolve blockers or deliberately reassign |
| `Storage_unavailable`, `Corrupt_store` | Preserve evidence, stop dependent work and involve the operator; no durability assumption |

`workspace.export` starts an asynchronous captured snapshot; poll `export.get`
until completed and verify the destination. For Git transfer, close the workspace
before committing/pulling and hand off the sole writer. Keep registry files and
retry files outside the portable workspace. Never edit live storage files. Only
the current preview schema is supported; no prototype migration is provided.

Load detailed references on demand: [API reference](docs/api.md),
[task workflow](docs/agent-workflow.md), [coordination](docs/coordination-guide.md),
[communication](docs/communication.md), [evidence](docs/evidence.md),
[history](docs/history-integration.md), [operations](docs/operator-guide.md).
The [external fork/join runner](examples/coordination-runner.py) demonstrates failure,
replacement, cancellation, exact-artifact review and export/restore using the CLI.
