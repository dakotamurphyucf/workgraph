# Local coordination guide

A standalone empty ticket.claim_next is strictly nondurable: no receipt, head,
attempt, feed event or persisted bytes. Its exact identity may reevaluate until a
selection commits, when successful retry freezes the original receipt. An explicit
transaction batch remains durable. Capture filtered [attention](../skills/workgraph/references/attention.md)
before checking/parking, and retain consumed cursors. Automatic required path holds
track exact borrowers and clean up only when the last borrower exits; Manual holds
survive. See [ownership](../skills/workgraph/references/path-conditions-recovery.md) for bounded reservation
wait and exact release/recovery rules.

Workgraph is a standalone local coordination service with a JSON CLI. The
harness owns model/provider calls, prompt and context assembly, context resets,
process launch and termination, external tool access, tokenizer-specific
counting, and decisions about when to stop. Workgraph records the actor, run,
ticket claim, attempt, review, evidence, comments, reported usage and durable
history that the harness supplies. It does not launch agents or enforce external
side effects.

The example in [`skills/workgraph/scripts/coordination-workflow.sh`](../skills/workgraph/scripts/coordination-workflow.sh)
shows an orchestrator registering worker/reviewer runs, a worker claiming ready
work, and both agents recording comments. It requires an already-open workspace
and a ready ticket. It uses saved CLI request files so the same workflow can be
retried after an uncertain response.

## Runs, claims and attempts

Use a stable, distinct `run_id` for each invocation. A run record is an
attribution and lifecycle record; the harness owns the process that it describes.
[run.register](../skills/workgraph/references/api/run.register.md) stores its actor, objective,
capabilities and optional process/worktree references. Use
[ticket.claim_next](../skills/workgraph/references/api/ticket.claim_next.md) with a fresh stable attempt
ID and the registered worker's `target_run_id` to atomically choose eligible ready
work, claim it and start its attempt. The result's named alternative tells you
whether work was selected; use its complete claim and attempt records.
The ticket claim token fences protected progress, handoffs, completion and
attempt ownership. Include the same `actor_id` and `run_id` on those operations.

Claims have no expiry by default. Timed leases are opt-in through
`lease_duration_ms` on `ticket.claim`, `ticket.start` or `ticket.claim_next` (1 ms through 24
hours). Renew a timed claim using `ticket.renew_lease` with its token and exact
`expected_lease_revision`.
Reservation leases are also opt-in; `reservation.acquire` defaults to indefinite
ownership, and renewal requires the run, token and expected lease revision.
`run.heartbeat` and `run.observe` are observations only; neither renews a ticket
claim or reservation. `run.heartbeat` takes `workspace_id`, `target_run_id` and
`actor_id`; it does not accept a `mutation_id`. It returns an advisory
observation, the last persisted observation if any, and a `durable` flag.
Heartbeats are coalesced to at most one flush per workspace every ten seconds;
shutdown flushes the latest value. A repeated heartbeat is a new server-time
observation rather than an exact-once retry. An expired lease means the fencing
token is no longer valid; it does not show that a process stopped or that its
checkout is safe to reuse. Before replacing work, confirm the old process is
stopped or isolated and use an exact guarded [ticket recovery](../skills/workgraph/references/api/ticket.recover.md)
or [reservation recovery](../skills/workgraph/references/api/reservation.recover.md). Required checkout
paths and external conditions participate in start readiness; their records do
not fence filesystem writes. Workgraph cannot prevent a process from writing
directly to external files.

Attempts can record session links and versioned resource or handoff checkpoints.
Finish an attempt with `attempt.finish` and a terminal state plus nonempty
evidence. Completing a ticket also needs its current claim token and nonempty
evidence. A completed attempt/ticket is durable planning state, not proof that
the harness's external worktree or provider state was committed.

Templates are [registered](../skills/workgraph/references/api/template.register.md) against a versioned
resource and [instantiated](../skills/workgraph/references/api/template.instance_register.md) with a
stable instance ID plus string parameters. Instantiation
validates dependency aliases and cycles, then stages the planned tickets and
instance record together. `allocation.pool_put` and
`allocation.ticket_policy_put` can constrain active attempts, capabilities and
eligible pools and optional cooperative allowed actors. All direct acquisition,
reassignment and replay paths enforce authoritative admission. Pool occupancy counts
a ticket once when claimed or attempted; existing max_active_attempts bounds attempts.
Use ticket.ready/readiness with target_run_id or run-selected coordinator.overview
for current eligibility; an observation is not an ownership grant.

Before launching a run, use `ticket.ready` or `ticket.readiness` with
`candidate:{"actor_id":"worker","capabilities":["ocaml"]}` to assess the
prospective actor without creating a probe run. This selector is mutually
exclusive with `target_run_id`. The response distinguishes graph, candidate and
run assessments. Candidate checks include allowed actors, capabilities and shared
pool capacity; run lifecycle/budgets and required path ownership remain explicit
unknowns. A positive candidate assessment remains advisory: the real claim/start
must pass all current acquisition checks.

## Comments, review and evidence

Use `comment.add` for discussion on a ticket (or a typed `target`), and
`ticket.progress` for token-fenced progress while holding a claim. A reviewer
can add a `kind: "evidence"` comment with its own actor and run; comments remain
ordinary discussion records. For a formal approval gate, configure the scoped
[acceptance policy](../skills/workgraph/references/api/acceptance.policy.put.md) or its narrow
[review-policy operation](../skills/workgraph/references/api/review.policy.put.md). Read the
[effective policy](../skills/workgraph/references/api/acceptance.policy.effective.md) before starting.
Publish an exact [manifest](../skills/workgraph/references/api/manifest.publish.md), then
[submit it](../skills/workgraph/references/api/review.submit.md). Eligible reviewers record a
[verdict](../skills/workgraph/references/api/review.record.md), named validators add
[results](../skills/workgraph/references/api/validation.add.md), and [review.accept](../skills/workgraph/references/api/review.accept.md)
checks the current requirements. Required criteria additionally need exact
[acceptance assertions](../skills/workgraph/references/api/acceptance.assert.md).

Manifests and reviews pin exact versions. A contract pins a published resource
version by resource ID, revision and digest. A manifest names its attempt,
ticket, contract revision, and sorted input/output artifacts. Review records
refer to the submitted manifest, contract and policy revisions; replacing any of
those makes old approval insufficient for the new submission. `evidence.context`
and `review.gate` explain current evidence state and blockers. See
[`docs/evidence.md`](evidence.md) for the evidence model and pin forms.

Communication threads are separate typed records. [thread.reply](../skills/workgraph/references/api/thread.reply.md)
creates a discussion comment and attaches it atomically using the observed thread
revision. A reply parent must already be attached to that thread. Use the generated
contract for canonical input names, including `reply_to_id`; output comment
provenance uses `reply_to_comment_id`. Thread changes use the same workspace,
actor, mutation ID and optional run attribution as other planning mutations.

## Stable CLI requests and recovery

Use `workgraph request SOCKET METHOD --params-file params.json --save-request request.json`
for writes. A saved request is created and synced before the CLI sends it. On a
disconnect or `Outcome_unknown`, retry the exact file with
`workgraph retry SOCKET request.json`; do not rebuild it with a new mutation ID.
The saved request freezes the method, IDs, parameters and run attribution.
Successful retries return the original receipt. Reusing a mutation ID with
changed parameters fails with `Idempotency_conflict`. The CLI does not retry
automatically. `--json-field FIELD JSON` sets an object, array or null field;
`--field-file FIELD FILE` reads a UTF-8 string. Mutations require an explicit
`mutation_id`, or `--save-request` can generate one when absent. See
[`skills/workgraph/scripts/coordination-workflow.sh`](../skills/workgraph/scripts/coordination-workflow.sh) for
a small saved-request helper.

Use `workspace.receipt` or `registry.receipt` to inspect a receipt when a retry
file is unavailable. `Conflict` generally means a revision/precondition changed;
re-read the object, decide whether the operation is still wanted, then send a
new request with a new mutation ID. `Already_claimed`, `Blocked` and `Stale_claim`
are domain outcomes that need coordination or a fresh owner/token. `Storage_unavailable`
means the operation was not acknowledged as durable. Treat `Outcome_unknown` as
an uncertain commit and replay the unchanged saved request before deciding to
perform a different operation.

## History and reported budgets

The harness decides which observable prompts, assistant outputs, tool calls and
results to retain and sends those completed observations through
`session.create` / `session.append`. It owns prompt construction, tokenization,
summaries and context eviction. Workgraph stores searchable supplied text and
opaque payload bytes; its byte limits are not tokenizer limits. Search and read
against a captured history head when assembling context. The Python reference
adapter demonstrates a durable input cursor and exact append retries:
[`docs/history-integration.md`](history-integration.md).

[run.budget_put](../skills/workgraph/references/api/run.budget_put.md) may set maximum total and active attempts plus reported token
and elapsed-time limits. Attempt limits are enforced by allocation. Token and
elapsed-time values are externally reported observations; Workgraph does not
measure provider spending or stop inference. [usage.report](../skills/workgraph/references/api/usage.report.md) stores nonnegative
attributed totals with stable IDs, and [run.budget_attention](../skills/workgraph/references/api/run.budget_attention.md) reports when those
reported limits are reached. The harness must decide whether to stop or continue.

## Scope and recovery limits

This package is an experimental local single-daemon system. Keep the socket and
workspace directories private to trusted local users. It provides durable local
transactions, receipts, fencing checks and bounded queries, but it does not
provide remote authentication, distributed consensus, SaaS availability or
cross-workspace transactions. Workgraph records coordination; it cannot roll
back arbitrary model calls, filesystem edits or other external effects. After a
crash, resume from the durable run/attempt/ticket state and saved request files;
inspect context and history before launching replacement work.

Only the current schema and wire format are supported. There is no prototype
format compatibility or migration path. Keep backups before replacing a local
workspace with data from another build.

## Deterministic external runner

`python3 skills/workgraph/scripts/coordination-runner.py SOCKET --root /fresh/workspace --state-dir /fresh/request-files`
creates a fresh `fork-join-demo` workspace. Use `--workspace` to choose its ID.
The scripted runner instantiates a pinned template, claims two independent child
tickets, injects a failed worker, replaces it with a fenced claim, publishes exact
artifacts, and reviews the join through rejection, correction and approval. It
also handles a child cancellation request, then checks close/reopen and full
export/restore against retained coordination and history records. Saved request
files preserve exact mutation identities. Run the whole demonstration with fresh
paths; saved writes alone do not make its entire procedural script resumable.

Run-filtered `coordinator.overview` distinguishes graph readiness from actual
allocation eligibility. `allocation_blocked` entries identify missing capabilities,
full pools, terminal runs or allocation budget limits. Without a run filter,
`ready_work` reports graph readiness only.

Ordinary registered attempts can complete with evidence and no manifest. When
configured review or validation gates require a manifest, acceptance must bind
that attempt's current inputs and outputs. A replacement attempt cannot inherit
an earlier attempt's approval.

### Discover participants

`participant.list` returns actor-ID ordered, bounded whole records from the actor
catalog and retained attributed planning commits. `registration` is the complete
catalog record (including archived identities), or null for unregistered writers.
`observed` contains inclusive `first_revision` and `last_revision` workspace commit
bounds, or null for catalog-only identities. These cover retained history, not an
actor's lifetime. `sources` identifies `catalog`, `activity`, `fact`, `comment`,
`request`, and `run` provenance; the run family includes coordination writes. Old
fact versions and tombstones, comment revisions, and terminal request/run activity
remain discoverable through their retained attribution. Merely naming an assignee,
recipient or resolver does not establish observed participation.

This read never creates catalog actors or runs. Neither registration nor past
activity asserts current liveness. Use `limit` (1..100, default 50), `offset`, and
`max_bytes` (4096..1048576, default 65536). Continue `next_offset` with the same
`at_revision` from `meta.workspace_revision`; intervening mutations fail Conflict
and require a rescan. Byte fitting removes only complete record suffixes and
advances by the number actually returned. The same capture and offsets survive
daemon restart. `actor.list` continues to list only catalog registrations.

```json
{"method":"participant.list","params":{"workspace_id":"demo","limit":"50","max_bytes":"65536"}}
```

### Inspect stale observations and held work

Use `coordinator.overview` with `kinds:["stale_run","unobserved_run"]` and,
optionally, `run_id`, `actor_id` or `project_id`. This is a warning view: fresh
and terminal runs do not produce these rows. `unobserved_run` means no observation
is recorded. `stale_run` uses the requested `stale_after_ms` threshold against the
later of durable `run.observe` metadata and the current advisory heartbeat cache.

Each warning's `metadata.observation_age_ms` is the exact difference between
`data.captured_now_unix_ms` and `last_observed_unix_ms`. Missing observations have
null age and `clock_regressed:false`. A future observation has null age and
`clock_regressed:true`, conservatively stale rather than a fabricated zero age.
Pages retain the first clock; changed planning/head/heartbeat captures require a
rescan. Durable observe metadata replays with history; `.local` heartbeats are
advisory, excluded from portable history and may lose coalesced updates on abrupt
shutdown. Graceful shutdown flushes them.

`metadata.held_work` has exact `ticket_claim_count`, `named_reservation_count`,
`path_reservation_count` and `active_attempt_count`. These cover the whole run,
even when selecting a project. Retained expired ownership records still count;
this is an inventory of held records, not a count of valid fencing grants or
executing processes. Each shared reservation target counts once for the run,
regardless of other holders or automatic claim borrowers. Attempts count
nonterminal records and can overlap claimed tickets; do not sum them as tasks.
Use `actor.overview` with the owner and run to inspect claim/attempt/named/path
reservation details; that detail read has its own current capture. Valid planning
state cannot archive a claimed ticket or its scope, so the existing coordinator
ticket capture includes all retained claims without scheduling archived work.

The harness owns process/session supervision, foreground lock waits, periodic
observations, wakeups and resuming an agent that ended its turn. Configure heartbeats
and lease renewals separately: neither `run.heartbeat` nor `run.observe` renews a
claim/reservation, ends a run or releases ownership. Missing/stale observations,
lease expiry and a finished model turn never prove a process stopped or its
checkout is safe to reuse. Before replacing work, confirm the old execution is
stopped or isolated, then use exact guarded release/recovery. For ticket recovery,
choose `disposition:"requeue"` explicitly when the work should return to Todo.

### Make shared database contention visible

Use a **named reservation** such as `test-db` as a cooperative database mutex. Every
participant uses the same workspace/name and runs database work only after its
actual exclusive acquisition succeeds. This does not fence a database connection
that ignores the protocol. A lexical checkout path is a different namespace;
`reservation.contention` also supports path targets and includes overlapping held
and waiting scopes.

The three advisory methods are `reservation.waiter.put`,
`reservation.holder_note.put`, and `reservation.contention`. They use existing
registered runs and attributed serialized planning transactions. They do not
register probe runs, implement a scheduler, reserve a queue position or promise
FIFO. Other callers may acquire immediately after release regardless of announced
waiters. Notes never acquire, renew, release or steal ownership.

A waiter has one retained natural key per `(target, run)` in the waiter family.
`action:"begin"` creates/reopens it with `expected_revision:0` for creation, or its
current revision for reopening, and resets its server-time start. `refresh`
requires an unexpired Waiting record and preserves start while updating its TTL
and note. `close` requires a nonblank `reason` and withdraws it. Durations are
1..300000 milliseconds; notes are at most 1024 UTF8 bytes and close reasons at most
512. Commands reject clock overflow/regression and stale revisions. Refreshing an
expired record fails; explicitly begin again with its current revision.

A holder note has its own `(target, run)` key and revision. `action:"set"` takes
`duration_ms`, `note`, and optional nullable `expected_release_unix_ms`; `clear`
removes its visible contents. Both require the exact **current stored holder**
actor/run/target/token. For a covering path hold, use its actual held target, not a
contained requested file. The release estimate is caller-declared and may be
missing or overdue. It is neither a lease deadline nor a promise. Expired stored
ownership can still have a note; writing it does not restore a valid lease.
Cleared, expired and different-fence notes are omitted from active holder rows.

The workspace has a hard **lifetime cap of 1000 retained keys across both
families**, including closed, cleared and expired records. The family distinguishes
a waiter key from a holder-note key with the same target/run. Existing keys retain
their revision fences and can be reused; new keys at capacity return a distinct
`Blocked` advisory-capacity error. Closing or expiry does not free capacity. There
is no silent eviction, fence reset, background cleanup or automatic grant.

`reservation.contention` requires `target`:

```json
{"kind":"named","reservation_id":"test-db"}
```

For paths use `{"kind":"path","target":{"worktree_id":"checkout","kind":"subtree","path":"src"}}`.
The bounded read returns whole `holder` and `waiter` rows with `advisory:true`.
Holder rows contain actual stored holders and matching notes. Waiter rows show
attributed actor/run, server start/update/expiry, current run status, phase,
`elapsed_ms` and `clock_regressed`. Elapsed is the captured **age since the latest
begin**, including inactive rows when requested; it is not measured process or
lock-hold duration. A regressed clock returns null elapsed. Closed, expired or
explicitly terminal-run waiters leave active visibility; `include_inactive:true`
exposes their labelled retained records. Expiry and terminal run metadata do not
prove that an external process stopped waiting or released anything.

Rows sort by family/target/run, not arrival time. Paging accepts `cursor`, `limit`
1..100 (default 50) and `max_bytes` 4096..1048576 (default 65536), retains the first
clock, and rejects changed planning revision/history lineage/selectors. An
oversized next row retains its position with `needs_larger_budget` and
`required_bytes`. Start a fresh read without a cursor to reassess current expiry.

For a database test pass:

1. The holder acquires `test-db` with `reservation.acquire`, saving its exact
   request and retaining the actual returned holder token. It may then set an
   expected-release note under that token and the note's current revision.
2. A waiter explicitly announces its intent, saving this request as usual:

   ```json
   {"target":{"kind":"named","reservation_id":"test-db"},"target_run_id":"waiter-run","expected_revision":"0","action":"begin","duration_ms":"300000","note":"Needs the test database for the next pass"}
   ```

3. Run the existing bounded acquisition helper **in the foreground**, for example:

   ```sh
   workgraph reservation wait "$SOCKET" \
     --workspace-id demo --actor-id waiter \
     --json-field target_run_id '"waiter-run"' \
     --json-field requests '[{"reservation_id":"test-db","mode":"exclusive"}]' \
     --request-directory /absolute/private/wait-requests \
     --wait-ms 150000 --max-attempts 100 --wait-slice-ms 25000
   ```

   Inspect `data.wait.completed` and the actual `data.daemon_response` grant. Only
   a completed validated acquisition permits database work. The helper preserves
   exact saved requests on uncertainty; retry those bytes instead of changing
   identity or refreshing ownership guards. An advisory note is never evidence
   of acquisition. The helper does not announce, refresh or close waiter records.
4. After a bounded loop, explicitly refresh before expiry to keep announcing a
   continued wait, or close with the current record revision when no longer
   waiting. On uncertainty, retain the original acquisition journal and describe
   that handoff accurately; do not claim an acquired grant. Harness cleanup should
   close the note on cancellation. If interrupted, its TTL eventually removes
   active visibility without changing any reservation.
5. The holder explicitly releases with the actual fencing token when done. Renew
   timed leases separately if needed; updating an expected-release note does not
   renew them. After acquiring, the former waiter closes its advisory record and
   follows the same holder/release protocol.

Save each mutation before transmission using the normal `request --save-request`
workflow. Note receipts have `{advisory:true,record}`; `record.revision` guards that
advisory record, not a grant, run revision or workspace capture. Exact retries
return their original immutable receipt even after closure, expiry or a later
holder token. Re-read contention/current ownership to inspect current state.
