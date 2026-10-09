# Local coordination guide

Workgraph is a standalone local coordination service with a JSON CLI. The
harness owns model/provider calls, prompt and context assembly, context resets,
process launch and termination, external tool access, tokenizer-specific
counting, and decisions about when to stop. Workgraph records the actor, run,
ticket claim, attempt, review, evidence, comments, reported usage and durable
history that the harness supplies. It does not launch agents or enforce external
side effects.

The example in [`examples/coordination-workflow.sh`](../examples/coordination-workflow.sh)
shows an orchestrator registering worker/reviewer runs, a worker claiming ready
work, and both agents recording comments. It requires an already-open workspace
and a ready ticket. It uses saved CLI request files so the same workflow can be
retried after an uncertain response.

## Runs, claims and attempts

Use a stable, distinct `run_id` for each invocation. A run record is an
attribution and lifecycle record; the harness owns the process that it describes.
[run.register](api-reference/run.register.md) stores its actor, objective,
capabilities and optional process/worktree references. Use
[ticket.claim_next](api-reference/ticket.claim_next.md) with a fresh stable attempt
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
stopped or isolated and use an exact guarded [ticket recovery](api-reference/ticket.recover.md)
or [reservation recovery](api-reference/reservation.recover.md). Required checkout
paths and external conditions participate in start readiness; their records do
not fence filesystem writes. Workgraph cannot prevent a process from writing
directly to external files.

Attempts can record session links and versioned resource or handoff checkpoints.
Finish an attempt with `attempt.finish` and a terminal state plus nonempty
evidence. Completing a ticket also needs its current claim token and nonempty
evidence. A completed attempt/ticket is durable planning state, not proof that
the harness's external worktree or provider state was committed.

Templates are [registered](api-reference/template.register.md) against a versioned
resource and [instantiated](api-reference/template.instance_register.md) with a
stable instance ID plus string parameters. Instantiation
validates dependency aliases and cycles, then stages the planned tickets and
instance record together. `allocation.pool_put` and
`allocation.ticket_policy_put` can constrain active attempts, capabilities and
eligible pools; `ticket.claim_next` applies those allocation rules to ready work.

## Comments, review and evidence

Use `comment.add` for discussion on a ticket (or a typed `target`), and
`ticket.progress` for token-fenced progress while holding a claim. A reviewer
can add a `kind: "evidence"` comment with its own actor and run; comments remain
ordinary discussion records. For a formal approval gate, configure the scoped
[acceptance policy](api-reference/acceptance.policy.put.md) or its narrow
[review-policy operation](api-reference/review.policy.put.md). Read the
[effective policy](api-reference/acceptance.policy.effective.md) before starting.
Publish an exact [manifest](api-reference/manifest.publish.md), then
[submit it](api-reference/review.submit.md). Eligible reviewers record a
[verdict](api-reference/review.record.md), named validators add
[results](api-reference/validation.add.md), and [review.accept](api-reference/review.accept.md)
checks the current requirements. Required criteria additionally need exact
[acceptance assertions](api-reference/acceptance.assert.md).

Manifests and reviews pin exact versions. A contract pins a published resource
version by resource ID, revision and digest. A manifest names its attempt,
ticket, contract revision, and sorted input/output artifacts. Review records
refer to the submitted manifest, contract and policy revisions; replacing any of
those makes old approval insufficient for the new submission. `evidence.context`
and `review.gate` explain current evidence state and blockers. See
[`docs/evidence.md`](evidence.md) for the evidence model and pin forms.

Communication threads are separate typed records. [thread.reply](api-reference/thread.reply.md)
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
[`examples/coordination-workflow.sh`](../examples/coordination-workflow.sh) for
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

[run.budget_put](api-reference/run.budget_put.md) may set maximum total and active attempts plus reported token
and elapsed-time limits. Attempt limits are enforced by allocation. Token and
elapsed-time values are externally reported observations; Workgraph does not
measure provider spending or stop inference. [usage.report](api-reference/usage.report.md) stores nonnegative
attributed totals with stable IDs, and [run.budget_attention](api-reference/run.budget_attention.md) reports when those
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

`python3 examples/coordination-runner.py SOCKET --root /fresh/workspace --state-dir /fresh/request-files`
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
