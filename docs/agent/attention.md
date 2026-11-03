# Filtered attention and actor overview

Read [the CLI contract](cli-contract.md) and [coordination](coordination.md). These
are observations of recorded state; the harness owns scheduling and processes.

```xml
<workgraph_reference name="attention">
<workflow name="capture-check-park"><![CDATA[
attention.read/wait combine bounded committed communication, fact, ticket and readiness
invalidation activity. Selectors inside the filter object (project_id, ticket_ids,
run_id, kinds, fact_scope/fact_prefix and explicit recipient/consumer_id) compose with AND; selected source kinds compose with OR. Communication requires an
explicit recipient and consumer. Reading never acknowledges any delivery. Logical
notification groups retain every raw delivery ID for selective inbox.acknowledge.
Capture before checking current readiness, then read/park from the consumed cursor to
avoid a missed wake. Wait is bounded outside the serialized dispatcher and cancels
without acknowledgements or ownership changes. Keep source-specific continuation and
selected filters. A cursor freezes the upper bound and exact next fragment position;
advance only through consumed items, never through an undelivered high-water mark.
Cross-project prerequisite, path and shared-pool changes can invalidate selected work.
Historical routing uses event-bound membership, parent and policy heads, including
milestone-linked discussions; later edits do not move old events into a new scope.
initial_readiness requests a separately captured CURRENT snapshot. readiness_cursor
pages that snapshot independently of durable activity. It is not a history of each
transient eligible state, and clock expiry alone promises no durable wake: explicitly
recheck timed eligibility. Without run_id, readiness is graph readiness; with it,
the authoritative admission assessment includes actor, capabilities, budgets and pools.
Nested readiness makes this family manually paged; --paginate does not flatten it.
]]></workflow>
<workflow name="actor-current-work"><![CDATA[
actor.overview returns bounded current typed rows for claims, attempts, reservations,
incoming/outgoing requests and inbox work from one planning capture. Roles can overlap;
do not deduplicate distinct responsibilities by ticket alone. Consumer-specific unread
state is separate from request status and attempt ownership. Continuations retain their
filters/revision and reject changed captures instead of silently restarting. No view
infers process liveness, readiness history or automatic acknowledgement.
]]></workflow>
<method name="attention.read" mode="Q"><contract href="../api-reference/attention.read.md"/><behavior>Read filtered captured activity and optional separately paged current readiness.</behavior></method>
<method name="attention.wait" mode="Q"><contract href="../api-reference/attention.wait.md"/><behavior>Bounded park and recheck with the same cursor/filter contract; no durable write or acknowledgement.</behavior></method>
<method name="actor.overview" mode="Q"><contract href="../api-reference/actor.overview.md"/><behavior>Captured current actor work, ownership and explicit-consumer inbox rows.</behavior></method>
<workflow name="filtered-read-example"><![CDATA[
Select an existing project explicitly, and omit communication unless you provide its
recipient/consumer selectors:

"$WG" --context "$CONTEXT" attention read \
  --json-field filter '{"project_id":"demo-project","kinds":["ticket","fact","readiness"]}' \
  --initial-readiness true --max-bytes 65536

Keep the returned durable cursor separately from readiness_cursor. Reuse the exact
filter and drain each continuation before claiming the observation is complete.
]]></workflow>
</workgraph_reference>
```
