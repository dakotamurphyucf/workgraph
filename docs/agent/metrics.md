# Workspace metrics

```xml
<workgraph_reference topic="metrics">
<purpose><![CDATA[
Observe lightweight workspace outcomes, reported usage and admission allowances.
This is a read-only diagnostic; it creates no activity or usage report. Client calls,
failures and latency belong to the external wrapper in docs/agent/evaluation.md.
]]></purpose>
<method name="workspace.metrics" envelope="Q"><![CDATA[
Required: workspace_id. Optional: at_revision (exact observed planning revision),
max_bytes (4096..1048576, default65536). Omit absent optional fields; null rejects.

workgraph call /absolute/workgraph.sock workspace.metrics \
  '{"workspace_id":"demo","max_bytes":"4096"}'

Returns result.data with all fields below; result.meta.workspace_revision matches
planning_commits. Decimal quantities are strings. at_revision conflicts if planning
changed. History has its own commit count and head, independent of planning. The
complete response fits max_bytes or fails Invalid_argument with budget guidance;
meters and counters are never silently clipped.
]]></method>
<counters><![CDATA[
planning_commits: committed planning transactions, including durable no-op receipts.
Exact transport retries retrieve the existing receipt without increasing this count.
history_commits/history_head: independent committed session journal and its digest;
head is null only for empty history. Queries and rejected operations increase neither.
observed_unix_ms: server observation time used for open status intervals.

statuses: five rows for backlog,todo,in_progress,done,canceled. Each contains tickets
(current count including archived tickets), elapsed_ms (sum of known wall-clock
intervals), closed_intervals, open_intervals, unknown_intervals, overflow. Every ticket
has one open interval in its current status, including done/canceled. Unrelated
progress/comments do not reset an interval. The server's recorded UTC timestamps
supply transition time; arbitrary, out-of-range or regressed timestamps make an
interval unknown. Unknown intervals do not contribute elapsed time. A clock jump
forward remains a wall-clock observation, not measured work. Saturated sums set overflow.

completion_transitions and reopenings count recorded transitions, including repeated
cycles on the same ticket; they are not unique tasks, productivity or causal rework.
completed_tickets_with_evidence counts currently done tickets with retained immutable
completion evidence. tickets_with_recorded_manifest counts tickets ever having a
manifest. stored_assertions and stored_accepted_submissions count retained assertion
records and latest submissions whose stored state is accepted. They do not assert
that those proofs remain current, relevant or sufficient; use acceptance APIs for that.

reported_usage: observations,tokens,elapsed_ms,overflow from explicit usage.report
records. These are additive provider/harness reports, including run and attempt
reports; do not report the same spending under both scopes. They are not measured
model usage, unique requests or elapsed workspace runtime. Zero observations means
nothing was reported. Totals saturate at signed64-bit maximum with overflow=true.
]]></counters>
<admission><![CDATA[
planning_admission and storage_admission contain {name,unit,used,limit,remaining}.
remaining=limit-used uses the exact ceilings enforced by the owning module.

Planning meters: planning_payload_bytes (retained event payloads), tickets,projects,
milestones,resources,referenced_resource_bytes,fact_keys,fact_version_bytes.
Resource accounting deduplicates digest identities across retained resource versions;
unknown optional sizes use the same conservative64KiB allowance as the
admission guard. This measures resource-reference allowance, not all disk content.
Fact keys include tombstones and fact bytes include retained versions.

Storage meters: planning_commits,planning_transaction_bytes (full encoded retained
transactions including receipts),history_commits,history_batch_bytes (retained encoded
journal batches),active_uploads,reserved_upload_bytes. Private upload reservations
count declared sizes, including completed staging until forgotten; restart discards
unpublished staging. Planning payload bytes and complete transaction bytes are
different guards, not additive estimates of disk footprint.

These allowances do not report physical free disk space, process memory, history
payload blob size, filesystem overhead or orphan files. Command/frame/blob-size,
queue, dependency, ownership and configured allocation limits still apply. Positive
remaining capacity is not a promise that a particular operation will be admitted.
The query reads owner counters and folds retained planning audit in memory. Cost is
linear in retained planning changes; there is no disk walk or metrics service.
]]></admission>
</workgraph_reference>
```
