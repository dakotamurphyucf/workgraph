# Filtered attention and actor overview

Use this reference when an agent needs to learn what changed while it was working, or
wait for recorded activity affecting selected work. An **actor** is a caller's recorded
identity. The **harness** is the external program that schedules actors and runs their
processes; Workgraph reports recorded state and never infers whether a process is alive.
Read [the CLI contract](cli-contract.md) for connection and retries, and
[coordination](coordination.md) for claims, runs and admission.

**Readiness** means recorded prerequisites and control rules permit work; with a run
selector it also includes that run's admission constraints. **Invalidation activity**
means a change could affect a previous readiness assessment, so reassess before acting.
A **consumer** identifies an independent inbox reader. Reading an inbox does not
acknowledge its delivery: `inbox.ack` does that explicitly.

## Capture, check, then wait

A **cursor** records the captured upper boundary and how far its items were consumed.
First capture activity, then check current readiness, then read or wait from that
cursor. This order avoids losing a change between the check and the wait.

attention.read/wait combine bounded committed communication, fact, ticket and readiness
invalidation activity. Selectors inside the filter object (project_id, ticket_ids,
run_id, kinds, fact_scope/fact_prefix and explicit recipient/consumer_id) compose with
AND; selected source kinds compose with OR. Communication requires an explicit recipient
and consumer. Reading never acknowledges any delivery. Logical notification groups
retain every raw delivery ID for selective inbox.ack. Capture before checking current
readiness, then read/park from the consumed cursor to avoid a missed wake. Wait is
bounded outside the serialized dispatcher and cancels without acknowledgements or
ownership changes. Keep source-specific continuation and selected filters. A cursor
freezes the upper bound and exact next fragment position; advance only through consumed
items, never through an undelivered high-water mark. Cross-project prerequisite, path
and shared-pool changes can invalidate selected work. Historical routing uses
event-bound membership, parent and policy heads, including milestone-linked discussions;
later edits do not move old events into a new scope. initial_readiness requests a
separately captured CURRENT snapshot. readiness_cursor pages that snapshot independently
of durable activity. It is not a history of each transient eligible state, and clock
expiry alone promises no durable wake: explicitly recheck timed eligibility. Without
run_id, readiness is graph readiness; with it, the authoritative admission assessment
includes actor, capabilities, budgets and pools. Nested readiness makes this family
manually paged; --paginate does not flatten it.

## Inspect an actor’s current responsibilities

A planning **capture** fixes the revision used to assemble a response. It describes
recorded responsibilities at that boundary, rather than a live process inventory.

actor.overview returns bounded current typed rows for claims, attempts, reservations,
incoming/outgoing requests and inbox work from one planning capture. Roles can overlap;
do not deduplicate distinct responsibilities by ticket alone. Consumer-specific unread
state is separate from request status and attempt ownership. Continuations retain their
filters/revision and reject changed captures instead of silently restarting. No view
infers process liveness, readiness history or automatic acknowledgement.

### `attention.read`

[Complete request and result schema](api/attention.read.md).

Read filtered captured activity and optional separately paged current readiness.

### `attention.wait`

[Complete request and result schema](api/attention.wait.md).

Bounded park and recheck with the same cursor/filter contract; no durable write or
acknowledgement.

### `actor.overview`

[Complete request and result schema](api/actor.overview.md).

Captured current actor work, ownership and explicit-consumer inbox rows.

## Read a project's activity

After [setting up an agent context](getting-started.md), replace these paths and choose
an existing project. `CONTEXT` supplies the socket and workspace. This read omits
communication because no recipient or inbox consumer is selected.

```sh
WG=/absolute/path/to/workgraph
CONTEXT=/absolute/private/agent/context.json

"$WG" --context "$CONTEXT" attention read \
  --json-field filter '{"project_id":"demo-project","kinds":["ticket","fact","readiness"]}' \
  --initial-readiness true --max-bytes 65536
```

Keep the returned durable cursor separately from readiness_cursor. Reuse the exact
filter and drain each continuation before claiming the observation is complete.
