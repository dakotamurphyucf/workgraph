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

## Watch only communication

Set **both** `filter.recipient` and `filter.consumer_id`. The recipient is an exact
actor or run address; the consumer is your independent reader name. Set
`kinds:["communication"]` explicitly: the default also includes fact, ticket and
readiness activity, which can make a message watcher noisy. A run recipient receives
only deliveries addressed to that run, not every delivery addressed to its actor.

This foreground example prints communication without acknowledging it. It requires
`jq`, a configured context, and an existing private `AGENT_DIR`. Replace `lead` and
the consumer name. Stop with Ctrl-C. For an actor that must process each delivery
through a callback and then acknowledge it, use the separate
[notification watcher](harness-hooks.md) instead.

```sh
WG=/absolute/path/to/workgraph
CONTEXT=/absolute/private/agent/context.json
AGENT_DIR=/absolute/private/agent
FILTER='{"recipient":{"kind":"actor","id":"lead"},"consumer_id":"lead-observer","kinds":["communication"]}'
CURSOR=
METHOD=attention.read
BUDGET=65536

while :; do
  set -- --json-field filter "$FILTER" --max-bytes "$BUDGET"
  if [ -n "$CURSOR" ]; then set -- "$@" --cursor "$CURSOR"; fi
  if [ "$METHOD" = attention.wait ]; then set -- "$@" --timeout-ms 20000; fi
  "$WG" --context "$CONTEXT" "$METHOD" "$@" > "$AGENT_DIR/attention.json" || exit 1
  jq -c '.result.data.items[]' "$AGENT_DIR/attention.json" || exit 1
  # Advance only after consuming all returned items (printing them here).
  CURSOR=$(jq -er '.result.data.cursor' "$AGENT_DIR/attention.json") || exit 1
  if jq -e '.result.data.needs_larger_budget' "$AGENT_DIR/attention.json" >/dev/null; then
    if [ "$BUDGET" = 1048576 ]; then
      printf '%s\n' 'Item still cannot fit; keep attention.json and inspect required_bytes.' >&2
      exit 1
    fi
    BUDGET=1048576
    METHOD=attention.read
  elif jq -e '.result.data.has_more' "$AGENT_DIR/attention.json" >/dev/null; then
    METHOD=attention.read
  else
    METHOD=attention.wait
  fi
done
```

Keep the last successfully consumed cursor and its exact filter to resume the same
watch. This example starts from retained history when `CURSOR` is empty; it does not
provide a durable callback checkpoint. Replaying an old cursor can repeat observations.
Never replace it with a guessed high-water mark, change its filter, or combine it
with `after`. A timeout is a normal empty response: retain its returned cursor and
wait again. This loop does not request a separate readiness snapshot.

## Diagnose an empty inbox

An empty page is not evidence that no notification was sent. Check these values in
order; `inbox.read` is read-only, so investigating does not consume delivery:

| Check | What can hide an expected notification |
| --- | --- |
| Workspace and recipient | A different workspace, actor ID, or run ID; actor and run addresses are distinct. |
| `consumer_id` | That consumer may already have acknowledged the IDs. A different reader has independent acknowledgement state. |
| `after` and `through` | `after` excludes earlier IDs; a captured `through` excludes later arrivals. The response echoes both boundaries and the effective recipient/consumer. |
| `kinds`, `ticket_id`, `exclude_self` | Filters can exclude a real delivery. Actor self-filtering excludes all writes from that actor; run self-filtering excludes only that exact attributed run. |
| `remaining` and budget metadata | Drain `next_after` under the same `through` and filters. Do not treat a bounded result as a complete absence check. |

For a controlled comparison, read with the same recipient, a fresh diagnostic
consumer name, `after: "0"`, no `through`, no kind/ticket filters and
`exclude_self: false`. This reveals retained unread delivery for that diagnostic
consumer; it does not reset or repair another consumer. Reads and attention watches
never acknowledge. `inbox.ack`, request delivery acknowledgement, accepting request
responsibility, and resolving a request are separate operations. A resolved request
can still have an unread notification.
