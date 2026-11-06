# Workspace metrics

Use workspace metrics to inspect recorded task outcomes, caller-reported usage and
remaining **admission allowances**: the limits Workgraph checks before accepting a
write. This read-only diagnostic creates neither activity nor a usage report. For client
calls, failures and latency, use the [external evaluation wrapper](evaluation.md). For
capacity recovery and moving selected work to a fresh workspace, read [capacity and
rollover](capacity-rollover.md).

A **planning commit** is a durably recorded transaction changing tickets or other
planning state, including an explicit durable no-op receipt. A **history commit**
records session observations in an independent journal. Neither count is a count of all
client calls. An **attempt** records one execution effort on a ticket; a **run** groups
caller activity. Usage at these scopes is supplied by the caller, not measured by a
model runtime inside Workgraph.

### `workspace.metrics`

Supply `workspace_id`; no actor or mutation identity is needed for this query. See [the
CLI contract](cli-contract.md) for response envelopes and request syntax.

Required: workspace_id. Optional: at_revision (exact observed planning revision),
max_bytes (4096..1048576, default 65536). Omit absent optional fields; null rejects.

After [setting up an agent context](getting-started.md), substitute its paths:

```sh
WG=/absolute/path/to/workgraph
CONTEXT=/absolute/private/agent/context.json
"$WG" --context "$CONTEXT" request workspace.metrics --max-bytes 4096
```

Returns result.data with all fields below; result.meta.workspace_revision matches
planning_commits. Decimal quantities are strings. at_revision conflicts if planning
changed. History has its own commit count and head, independent of planning. The
complete response fits max_bytes or fails Invalid_argument with budget guidance; meters
and counters are never silently clipped.

## Interpret retained counters

planning_commits: committed planning transactions, including durable no-op receipts.
Exact transport retries retrieve the existing receipt without increasing this count.
history_commits/history_head: independent committed session journal and its digest; head
is null only for empty history. Queries and rejected operations increase neither.
observed_unix_ms: server observation time used for open status intervals.

statuses: five rows for backlog,todo,in_progress,done,canceled. Each contains tickets
(current count including archived tickets), elapsed_ms (sum of known wall-clock
intervals), closed_intervals, open_intervals, unknown_intervals, overflow. Every ticket
has one open interval in its current status, including done/canceled. Unrelated
progress/comments do not reset an interval. The server's recorded UTC timestamps supply
transition time; arbitrary, out-of-range or regressed timestamps make an interval
unknown. Unknown intervals do not contribute elapsed time. A clock jump forward remains
a wall-clock observation, not measured work. Saturated sums set overflow.

completion_transitions and reopenings count recorded transitions, including repeated
cycles on the same ticket; they are not unique tasks, productivity or causal rework.
completed_tickets_with_evidence counts currently done tickets with retained immutable
completion evidence. tickets_with_recorded_manifest counts tickets ever having a
manifest. stored_assertions and stored_accepted_submissions count retained assertion
records and latest submissions whose stored state is accepted. They do not assert that
those proofs remain current, relevant or sufficient; use acceptance APIs for that.

reported_usage: observations,tokens,elapsed_ms,overflow from explicit usage.report
records. These are additive provider/harness reports, including run and attempt reports;
do not report the same spending under both scopes. They are not measured model usage,
unique requests or elapsed workspace runtime. Zero observations means nothing was
reported. Totals saturate at signed 64-bit maximum with overflow=true.

## Interpret admission meters

planning_admission and storage_admission contain {name,unit,used,limit,remaining}.
remaining=limit-used uses the exact ceilings enforced by the owning module.

Planning meters: planning_payload_bytes (retained event payloads), tickets,projects,
milestones,resources,referenced_resource_bytes,fact_keys,fact_version_bytes. Resource
accounting deduplicates digest identities across retained resource versions; unknown
optional sizes use the same conservative 64KiB allowance as the admission guard. This
measures resource-reference allowance, not all disk content. Fact keys include
tombstones and fact bytes include retained versions.

Storage meters: planning_commits,planning_transaction_bytes (full encoded retained
transactions including receipts),history_commits,history_batch_bytes (retained encoded
journal batches),active_uploads,reserved_upload_bytes. Private upload reservations count
declared sizes, including completed staging until forgotten; restart discards
unpublished staging. Planning payload bytes and complete transaction bytes are different
guards, not additive estimates of disk footprint.

These allowances do not report physical free disk space, process memory, history payload
blob size, filesystem overhead or orphan files. Command/frame/blob-size, queue,
dependency, ownership and configured allocation limits still apply. Positive remaining
capacity is not a promise that a particular operation will be admitted. The query reads
owner counters and folds retained planning audit in memory. Cost is linear in retained
planning changes; there is no disk walk or metrics service.

## Report and aggregate custom measures

usage.report accepts up to 16 distinct caller-reported {name,unit,value} metrics with
nonnegative int64 values, in addition to existing token/elapsed fields. Reports are
immutable. They are not provider billing, unique request counts or authentication. Avoid
reporting the same spending at both run and attempt scope. usage.aggregate returns
bounded captured rollups by the documented run/project/ticket selectors, preserving
measurement name and unit. Overflow is explicit, and run spending without attempt
attribution remains unassigned rather than invented ticket cost. Standalone empty
claim-next observations add no planning commit; explicit durable no-op batches still do.

### `usage.aggregate`

[Complete request and result schema](api/usage.aggregate.md).

Captured bounded usage totals and typed custom measure rollups with explicit
overflow/unassigned accounting. Keep the returned continuation and capture guards.


Choose `metrics_layout` for the detail you need:

| Layout | Items and limit unit | Custom measure detail |
| --- | --- | --- |
| `rows` (default) | One usage or metric row; `limit` counts rows | Separate `kind:"metric"` rows may continue onto another page. |
| `nested` | One `kind:"usage"` item per group; `limit` counts groups | Each item contains its complete `metrics` array, ordered by name then unit. |
| `totals_only` | One `kind:"usage"` item per group; `limit` counts groups | No metric rows or arrays; `metric_series` and `metric_overflow` remain in each summary. |

For example, capture project groups with their complete measure series:

```sh
"$WG" --context "$CONTEXT" request usage.aggregate --group-by project \
  --metrics-layout nested --limit 20 --max-bytes 65536
```

All layouts retain the same top-level totals, membership basis and unassigned run
accounting. Filters are ANDed; group attribution uses captured current ticket
membership. Metrics preserve their name and unit, with separate sums for distinct
units and explicit saturation. Tokens and elapsed milliseconds retain their existing
units. `totals_only` still computes truthful metric counts and overflow; it omits
individual metric values rather than estimating or converting them.

Nested groups are indivisible. A page contains only whole groups, even when a group's
metric array exceeds `max_bytes`. If the next group cannot fit, the response has empty
`items`, `has_more:true`, `needs_larger_budget:true`, and `required_bytes` describing the
next complete item and response metadata. The cursor stays at that group. Retry it
with a larger budget; neither arrays nor metric identifiers are shortened. The maximum
budget is 1048576 bytes. For a group exceeding that ceiling, begin a new `rows` query to
page through individual series, or use `totals_only` to omit that detail.

A continuation binds workspace, planning revision, planning lineage, effective literal
filters, group and metric layout. Its offset counts rows or groups according to layout.
You may change `limit` and `max_bytes` during continuation. Omitted default layout/group
and explicit `rows`/`workspace` have the same effective identity. Changing selectors,
layout, membership, or the planning capture requires a new query. `at_revision` guards
the current capture; it does not retrieve a historical one. A zero-observation result
has no group items. These reads do not create usage records or planning commits.
