# Coordinate workers, allocate work and observe changes

Read [the shared CLI and wire contract](cli-contract.md) before constructing requests.
Return to [the capability guide](../SKILL.md) to choose another reference.
The [method contracts](api/index.md) define exact inputs and results. This guide
explains the lifecycle and the decisions those fields represent.

## Terms and ownership

An **actor** identifies a cooperating participant. A **run** records one invocation
of that actor. An **attempt** records one run's effort on one ticket under a
particular claim. A ticket **claim** grants logical ownership; its **token** fences
stale writers: an old owner cannot use an earlier token for protected updates.
A **lease** is that ownership's recorded lifetime and renewal
revision. Timed leases have a deadline; indefinite leases have none. Expiry blocks
new protected work but does not remove the old holder or stop its process.

An allocation **pool** limits simultaneous occupancy; a ticket allocation **policy**
selects eligible capabilities, pools and optional actors. A named **reservation**
coordinates an arbitrary shared or exclusive resource. For file or directory
ownership, use [path reservations](path-conditions-recovery.md).

**Admission** means checking whether the current rules permit an operation.
**Provenance** records where information came from and who supplied it. A
**projection** is a derived view of stored records, such as the coordination view
used to list runs; its version counter can differ from an individual run's revision.

## Run a worker through one attempt

1. Let the harness provision the process and checkout. Record the invocation with
   [run.register](api/run.register.md), including its immutable objective,
   capabilities and optional parent/process/worktree references.
2. Configure any pool, ticket policy and run budget before claiming work. To see
   eligibility for this worker, use `ticket.ready` or `ticket.readiness` with its
   `target_run_id`; a read without that selector reports graph readiness only.
3. Select work with [ticket.claim_next](api/ticket.claim_next.md). Supply a fresh
   `attempt_id`, the registered `target_run_id` and the same envelope `run_id`.
   Inspect `kind` before extracting any claim or attempt. Alternatively, claim an
   explicit ticket and then call `attempt.start`; claiming alone starts no attempt.
4. Retain the returned claim token, lease revision and attempt revision. Include
   actor/run/token on protected writes, record progress and immutable checkpoints,
   and renew a timed claim before expiry when work must continue. A heartbeat is
   advisory and cannot renew ownership.
5. Satisfy configured evidence gates and finish the attempt. Ticket completion or
   release and external process shutdown remain separate lifecycle actions unless
   deliberately grouped in a supported planning transaction.
6. When no work was selected, inspect the response's bounded eligibility explanation.
   Capture [attention](attention.md) before checking again and parking in a filtered
   wait; repeated acquisition writes are unnecessary polling.

A known `kind:"empty"` standalone selection is nondurable and creates no attempt or
receipt. Its unchanged request identity may be reevaluated when work changes. A
committed selection has an immutable receipt: retry the saved request to recover
it. An uncertain reply is never evidence that selection was empty.

## Attribution, counters and capture

Workgraph records coordination. The harness launches and stops processes, isolates
checkouts, integrates external changes and enforces provider spending. Actor and
run IDs are attribution. Silence, cancellation, lease expiry and terminal records
do not establish that a worker stopped. See [ownership and external conditions](path-conditions-recovery.md)
for logical worktree paths, required ownership, guarded recovery and external gates.

Mutation envelopes carry workspace_id, actor_id, mutation_id and optional run_id.
The target_run_id field selects a run; run_id supplies mutation attribution.
Exact retries use the saved request. Durable receipt metadata is in result.meta;
record/entity revisions and projection revisions are separate counters. List
captures must retain their own returned query revision while paging.

Feed byte budgets count the complete result.data/result.meta envelope, excluding
JSON-RPC. Feed rows and their captured target metadata remain whole. Budget
omitted_items counts rows omitted by byte fitting, separately from limit paging;
omitted_fields stays zero. If the next row cannot fit, increase max_bytes with
the unchanged cursor. A consumed feed cursor captures the next available range;
changed or unavailable retained lineage returns Conflict and requires a fresh scan.
Filtering uses lowercase public change names such as ticket_put and session_created.
A history feed timestamp can be empty and run_id null; neither implies an event's
time or run. Feed positions are commit positions, not per-session event sequence.

Templates pin the digest of exact canonical JSON specification bytes: sorted
object keys, compact JSON, preserved array order and string contents. Expansion
substitutes parameters once in titles/descriptions and validates the bounded
dependency graph, rejecting cycles.
Generated ticket IDs are deterministic for instance ID and node alias. Each
expanded create, dependency and enabled allocation/review policy counts toward
the atomic transaction limit; the registered instance records its full plan.

| Method | Exact codec contract |
| --- | --- |
| `run.register` | [run.register](api/run.register.md) |
| `run.transition` | [run.transition](api/run.transition.md) |
| `run.observe` | [run.observe](api/run.observe.md) |
| `run.link_session` | [run.link_session](api/run.link_session.md) |
| `run.get` | [run.get](api/run.get.md) |
| `run.list` | [run.list](api/run.list.md) |
| `attempt.start` | [attempt.start](api/attempt.start.md) |
| `attempt.checkpoint` | [attempt.checkpoint](api/attempt.checkpoint.md) |
| `attempt.finish` | [attempt.finish](api/attempt.finish.md) |
| `attempt.get` | [attempt.get](api/attempt.get.md) |
| `attempt.list` | [attempt.list](api/attempt.list.md) |
| `run.actions` | [run.actions](api/run.actions.md) |
| `run.action_acknowledge` | [run.action_acknowledge](api/run.action_acknowledge.md) |
| `allocation.pool_put` | [allocation.pool_put](api/allocation.pool_put.md) |
| `allocation.ticket_policy_put` | [allocation.ticket_policy_put](api/allocation.ticket_policy_put.md) |
| `allocation.pools` | [allocation.pools](api/allocation.pools.md) |
| `allocation.ticket_policies` | [allocation.ticket_policies](api/allocation.ticket_policies.md) |
| `ticket.claim_next` | [ticket.claim_next](api/ticket.claim_next.md) |
| `run.budget_put` | [run.budget_put](api/run.budget_put.md) |
| `run.budget_get` | [run.budget_get](api/run.budget_get.md) |
| `usage.report` | [usage.report](api/usage.report.md) |
| `usage.list` | [usage.list](api/usage.list.md) |
| `run.budget_attention` | [run.budget_attention](api/run.budget_attention.md) |
| `ticket.renew_lease` | [ticket.renew_lease](api/ticket.renew_lease.md) |
| `run.heartbeat` | [run.heartbeat](api/run.heartbeat.md) |
| `run.heartbeat_get` | [run.heartbeat_get](api/run.heartbeat_get.md) |
| `reservation.acquire` | [reservation.acquire](api/reservation.acquire.md) |
| `reservation.renew` | [reservation.renew](api/reservation.renew.md) |
| `reservation.release` | [reservation.release](api/reservation.release.md) |
| `reservation.get` | [reservation.get](api/reservation.get.md) |
| `reservation.list` | [reservation.list](api/reservation.list.md) |
| `template.register` | [template.register](api/template.register.md) |
| `template.get` | [template.get](api/template.get.md) |
| `template.list` | [template.list](api/template.list.md) |
| `template.instantiate` | [template.instantiate](api/template.instantiate.md) |
| `template.instance_register` | [template.instance_register](api/template.instance_register.md) |
| `template.instance_get` | [template.instance_get](api/template.instance_get.md) |
| `template.instance_list` | [template.instance_list](api/template.instance_list.md) |
| `coordinator.overview` | [coordinator.overview](api/coordinator.overview.md) |
| `changes.read` | [changes.read](api/changes.read.md) |
| `changes.wait` | [changes.wait](api/changes.wait.md) |

## Read mutation receipts correctly

Use the generated method contracts above for exact fields and wire shapes. Whole-item budgets and explicit captured revisions preserve resumable reads. Run register/transition/observe/link_session return the resulting bounded snapshot {run_id,revision,status,actor_id,last_observed_unix_ms,session_ids}. Pool and ticket allocation policy receipts include their actual identity and settings; path policy receipts name the affected revision. Use each entity's revision as its next expected_revision. Attempt mutations return {attempt_id,revision,state}. Shared reservation/action/condition/recovery results instead name coordination_revision; nested records retain their own counters. None of these is the enclosing result.meta.workspace_revision. Coordinator unobserved_run means no heartbeat is recorded; stale_run means an existing observation is stale. Neither grants ownership or proves the external process stopped. No operation here launches a process or infers safe worktree reuse.

### `run.register`

Registers provenance for a new worker invocation. Parent, owner, objective, capabilities and process/worktree references remain immutable. The harness creates the process and checkout.

### `run.transition`

Records a lifecycle transition. A terminal run cannot transition again. Completed requires no active attempts. Parent stop policies create explicit runner actions; the harness performs them.

### `run.observe`

Commits an advancing liveness observation for the owned nonterminal run. It does not renew a lease. Use `run.heartbeat` for coalesced advisory observations.

### `run.link_session`

Adds one distinct existing session to an owned nonterminal run. Attempt session linkage remains separate and immutable.

### `run.get`

Reads a registered run; a missing identity returns Not_found.

### `run.list`

Reads runs in stable ID order from the run coordination projection.

### `attempt.start`

Requires the current actor/run/ticket claim token and valid lease. Capability, pool and attempt budgets are checked. Starting an attempt does not acquire a ticket claim.

### `attempt.checkpoint`

Appends an exact existing resource content version or handoff version. Historical checkpoint pins cannot be rewritten or removed. The current ownership fence must still match.

### `attempt.finish`

Changes only the attempt. Ordinary ungated attempts finish with supplied evidence. Configured acceptance gates require the exact current attempt manifest and its matching proofs. Failure/cancellation permit cleanup after expiry, with the exact current owner/token. Ticket release and external process shutdown are separate actions.

### `attempt.get`

Reads an attempt with its complete checkpoint and session provenance; a missing identity returns Not_found.

### `attempt.list`

Combines exact ticket and run filters over stable attempt ID order.

### `run.actions`

Reads pending parent/child runner actions. Reading does not acknowledge an action or change either run.

### `run.action_acknowledge`

Records evidence that the harness handled one pending action. The parent or child owner may acknowledge; this does not transition the child.

### `allocation.pool_put`

Updates a configured pool bound. Lowering the bound can prevent future allocation; it does not stop active attempts.

### `allocation.ticket_policy_put`

Sets required capabilities, named pools and optional allowed_actor_ids. Omitted allowed_actor_ids preserves the existing restriction; null removes it; a list contains 1..100 distinct actors, so [] rejects. Restrictions apply to direct claim/start, reassignment, claim-next and replay; restricted work needs an actor-owned registered eligible run. These are cooperative scheduling rules, not authentication. A current claim or nonterminal attempt freezes allocation policy. All required capabilities, budgets and new pool occupancy must pass; a ticket with a claim or nonterminal attempt consumes one slot, not one slot per attempt. Shrinking a pool retains existing occupancy but does not bypass other admission checks.

### `allocation.pools`

Reads configured pool definitions. Inspect current attempts or coordinator metadata for consumption.

### `allocation.ticket_policies`

Reads ticket allocation policies; empty capability/pool lists remove those restrictions.

### `ticket.claim_next`

Requires explicit registered nonterminal target_run_id, matching actor/envelope run_id and a fresh attempt_id. Atomically selects eligible work, acquires required paths and starts an attempt. Priority precedes unspecified priority, then creation order and ticket ID. Inspect kind before extracting claim.token; selected contains actual claim and attempt receipts. leaf_only excludes unfinished children without inheriting a parent completion gate. A standalone empty response has meta.durable=false and unchanged planning revision: no receipt, attempt, feed entry or persisted bytes. Its bounded explanation reports captured candidates, overlapping exclusion reasons and run limits. The exact uncommitted request identity may reevaluate when work changes; once selected commits, retry returns the immutable original receipt. Explicit transaction.apply batches, including empty selection, remain durable. Never adopt a pre-existing attempt or turn uncertainty into empty. Capture attention before checking readiness/parking instead of spinning acquisition writes.

### `run.budget_put`

Replaces configured attempt/concurrency bounds and externally reported spending attention limits. Null removes a limit. Provider spending remains the harness responsibility.

### `run.budget_get`

Reads configured bounds; absence means unbounded allocation and returns Not_found.

### `usage.report`

Records immutable externally reported spending with its attribution and provenance. Identical ID/content duplicates are recognized; conflicting content cannot replace a report.

### `usage.list`

Reads immutable usage records in usage ID order. These reports do not prove provider totals.

### `run.budget_attention`

Reports configured spending limits reached or exceeded. Saturated totals are explicitly lower bounds. This method never creates a cancellation or enforces spending.

### `ticket.renew_lease`

Requires the exact current claim token and lease revision, an unexpired timed lease and accepted server clock. It keeps the claim token and advances the lease revision. Indefinite leases cannot renew.

### `run.heartbeat`

Writes a coalesced advisory observation outside planning history. The registered owner must match. Heartbeats do not renew ownership and are not transactional mutation receipts.

### `run.heartbeat_get`

Reads the latest advisory heartbeat; a missing observation returns Not_found.

### `reservation.acquire`

Acquires all requested named reservations atomically. Exclusive ownership conflicts with any other holder; shared ownership permits shared holders. Names are arbitrary nonblank names, independent of lexical path ownership.

### `reservation.renew`

Requires the exact holder token and lease revision. Keeps holder token/mode and advances only the lease revision.

### `reservation.release`

Removes only the exact matching holder. Cleanup is allowed after expiry or terminal run, with the current actor/run/token. Other shared holders and the reservation epoch remain.

### `reservation.get`

Reads complete current holders, tokens and leases. A previously released name may have no holders.

### `reservation.list`

Reads reservations in stable name order from the run coordination projection.

### `template.register`

Pins an immutable resource content version whose digest equals the canonical JSON template specification digest. Identical versions are duplicates; conflicting content cannot replace them.

### `template.get`

Reads one complete pinned template version.

### `template.list`

Reads registered template versions.

### `template.instantiate`

Expands literal parameters and creates the deterministic ticket graph and enabled policies in one serialized transaction. Reusing an identical instance returns its original graph; changed parameters conflict.

### `template.instance_register`

Validates a deterministic instance against an already existing graph. It does not create tickets itself.

### `template.instance_get`

Reads the complete immutable instance and generated ticket plan.

### `template.instance_list`

Reads instances in stable instance ID order.

### `coordinator.overview`

Reads whole typed rows from one current planning/head/heartbeat capture. Rows sort by kind then stable source key, independently of claim-next priority. A registered run selector checks allocation rules; no selector reports graph readiness. Unknown run selectors return Not_found. Cursor pages preserve the first clock and reject changed revision, head, filters, heartbeat capture or clock regression. An oversized next row preserves its position with needs_larger_budget, next_item_source and exact required_bytes. Dependency edges have a separate bounded prefix and omission count; no task duration is inferred.

### `changes.read`

Reads complete captured commit metadata immediately. Planning workspace revisions and global history journal commit sequences are independent; retain separate cursors for each source/filter combination. Metadata items retain all captured targets, attribution, timestamp and lowercase change kinds. Full planning change bodies are available through activity.since; session events and payloads use history methods.

### `changes.wait`

Uses the same feed capture and response as changes.read, with a bounded wait outside the serialized transaction dispatcher. It returns matching items, an oversized next item or an ordinary empty timeout response. It advances past nonmatching commits while preserving filters. Disconnect and shutdown cancel waiting without acknowledgements or ownership changes.

## Admission rules and idle workers

`ticket.ready` and `ticket.readiness` accept `target_run_id` to assess the recorded
run using the same admission rules as acquisition. Alternatively, supply a
read-only `candidate` object with `actor_id` and `capabilities`, for example:

```json
{"candidate":{"actor_id":"worker","capabilities":["ocaml"]}}
```

The selectors are mutually exclusive and are never filled from context defaults.
A candidate needs no registered actor or probe run. It checks status, holds,
prerequisites, external conditions, allowed actors, supplied capabilities and
current shared pool capacity. Candidate capabilities must contain at most 100
distinct nonblank names, each at most 96 UTF-8 bytes; an empty array is valid.

Both reads include `assessment.scope` (`graph`, `candidate` or `run`) and
`assessment.unknown_checks`. A candidate always reports `run_lifecycle` and
`run_budget` as unknown, and reports `required_path_ownership` when applicable.
Candidate `ready:true` means the checks possible without a run passed. It does
not establish that a later invocation can acquire those paths or has an available
attempt budget. Actual claim/start rechecks its actor, run, ownership and budgets
atomically. These reads create no run, attempt, claim or reservation.

Omitting both selectors preserves graph readiness, which does not check an
actor's allocation policy. Ready-work pagination retains the selector assessment
beside the ordinary items/offset/remaining/next_offset fields; unknowns cover all
matching candidates before pagination. Retain the same `candidate` and filters
on each subsequent page, passing the first page's `workspace_revision` as
`at_revision`; a missing or stale capture guard rejects.
coordinator.overview also applies actor policy and run budgets when selected by run.
Direct ticket.claim reserves ownership but creates no attempt. Existing
max_active_attempts bounds nonterminal attempts; same-ticket retained pool occupancy still
requires actor/run/capability/budget/ownership checks. Released tickets return predictably
to the normal priority/creation/ID ordering. Reported run lifecycle is not external
process state.
