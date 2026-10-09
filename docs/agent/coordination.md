# Runs, allocation, leases, templates and change feeds

Read [the shared CLI and wire contract](cli-contract.md) before constructing requests.
Return to [the capability guide](../../AGENT_GUIDE.md) to choose another reference.
The generated contracts below declare the exact current fields, lowercase enums,
tagged objects, bounds and result envelopes from the runtime codecs. Use those
contracts for request construction; no prototype tagged-array wire format applies.

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
substitutes parameters once in titles/descriptions and validates the bounded DAG.
Generated ticket IDs are deterministic for instance ID and node alias. Each
expanded create, dependency and enabled allocation/review policy counts toward
the atomic transaction limit; the registered instance records its full plan.

| Method | Exact codec contract |
| --- | --- |
| `run.register` | [run.register](../api-reference/run.register.md) |
| `run.transition` | [run.transition](../api-reference/run.transition.md) |
| `run.observe` | [run.observe](../api-reference/run.observe.md) |
| `run.link_session` | [run.link_session](../api-reference/run.link_session.md) |
| `run.get` | [run.get](../api-reference/run.get.md) |
| `run.list` | [run.list](../api-reference/run.list.md) |
| `attempt.start` | [attempt.start](../api-reference/attempt.start.md) |
| `attempt.checkpoint` | [attempt.checkpoint](../api-reference/attempt.checkpoint.md) |
| `attempt.finish` | [attempt.finish](../api-reference/attempt.finish.md) |
| `attempt.get` | [attempt.get](../api-reference/attempt.get.md) |
| `attempt.list` | [attempt.list](../api-reference/attempt.list.md) |
| `run.actions` | [run.actions](../api-reference/run.actions.md) |
| `run.action_acknowledge` | [run.action_acknowledge](../api-reference/run.action_acknowledge.md) |
| `allocation.pool_put` | [allocation.pool_put](../api-reference/allocation.pool_put.md) |
| `allocation.ticket_policy_put` | [allocation.ticket_policy_put](../api-reference/allocation.ticket_policy_put.md) |
| `allocation.pools` | [allocation.pools](../api-reference/allocation.pools.md) |
| `allocation.ticket_policies` | [allocation.ticket_policies](../api-reference/allocation.ticket_policies.md) |
| `ticket.claim_next` | [ticket.claim_next](../api-reference/ticket.claim_next.md) |
| `run.budget_put` | [run.budget_put](../api-reference/run.budget_put.md) |
| `run.budget_get` | [run.budget_get](../api-reference/run.budget_get.md) |
| `usage.report` | [usage.report](../api-reference/usage.report.md) |
| `usage.list` | [usage.list](../api-reference/usage.list.md) |
| `run.budget_attention` | [run.budget_attention](../api-reference/run.budget_attention.md) |
| `ticket.renew_lease` | [ticket.renew_lease](../api-reference/ticket.renew_lease.md) |
| `run.heartbeat` | [run.heartbeat](../api-reference/run.heartbeat.md) |
| `run.heartbeat_get` | [run.heartbeat_get](../api-reference/run.heartbeat_get.md) |
| `reservation.acquire` | [reservation.acquire](../api-reference/reservation.acquire.md) |
| `reservation.renew` | [reservation.renew](../api-reference/reservation.renew.md) |
| `reservation.release` | [reservation.release](../api-reference/reservation.release.md) |
| `reservation.get` | [reservation.get](../api-reference/reservation.get.md) |
| `reservation.list` | [reservation.list](../api-reference/reservation.list.md) |
| `template.register` | [template.register](../api-reference/template.register.md) |
| `template.get` | [template.get](../api-reference/template.get.md) |
| `template.list` | [template.list](../api-reference/template.list.md) |
| `template.instantiate` | [template.instantiate](../api-reference/template.instantiate.md) |
| `template.instance_register` | [template.instance_register](../api-reference/template.instance_register.md) |
| `template.instance_get` | [template.instance_get](../api-reference/template.instance_get.md) |
| `template.instance_list` | [template.instance_list](../api-reference/template.instance_list.md) |
| `coordinator.overview` | [coordinator.overview](../api-reference/coordinator.overview.md) |
| `changes.read` | [changes.read](../api-reference/changes.read.md) |
| `changes.wait` | [changes.wait](../api-reference/changes.wait.md) |

```xml
<workgraph_reference name="coordination">
<coordination_api>
  <contract><![CDATA[Use the generated method contracts above for exact fields and wire shapes. Whole-item budgets and explicit captured revisions preserve resumable reads. No operation here launches a process or infers safe worktree reuse.]]></contract>
  <method name="run.register" mode="M"><![CDATA[Registers provenance for a new worker invocation. Parent, owner, objective, capabilities and process/worktree references remain immutable. The harness creates the process and checkout.]]></method>
  <method name="run.transition" mode="M"><![CDATA[Records a lifecycle transition. A terminal run cannot transition again. Completed requires no active attempts. Parent stop policies create explicit runner actions; the harness performs them.]]></method>
  <method name="run.observe" mode="M"><![CDATA[Commits an advancing liveness observation for the owned nonterminal run. It does not renew a lease. Use heartbeat for coalesced advisory observations.]]></method>
  <method name="run.link_session" mode="M"><![CDATA[Adds one distinct existing session to an owned nonterminal run. Attempt session linkage remains separate and immutable.]]></method>
  <method name="run.get" mode="Q"><![CDATA[Reads a registered run; a missing identity returns Not_found.]]></method>
  <method name="run.list" mode="Q"><![CDATA[Reads runs in stable ID order from the run coordination projection.]]></method>
  <method name="attempt.start" mode="M"><![CDATA[Requires the current actor/run/ticket claim token and valid lease. Capability, pool and attempt budgets are checked. Starting an attempt does not acquire a ticket claim.]]></method>
  <method name="attempt.checkpoint" mode="M"><![CDATA[Appends an exact existing resource content version or handoff version. Historical checkpoint pins cannot be rewritten or removed. The current ownership fence must still match.]]></method>
  <method name="attempt.finish" mode="M"><![CDATA[Changes only the attempt. Ordinary ungated attempts finish with supplied evidence. Configured acceptance gates require the exact current attempt manifest and its matching proofs. Failure/cancellation permit cleanup after expiry, with the exact current owner/token. Ticket release and external process shutdown are separate actions.]]></method>
  <method name="attempt.get" mode="Q"><![CDATA[Reads an attempt with its complete checkpoint and session provenance; a missing identity returns Not_found.]]></method>
  <method name="attempt.list" mode="Q"><![CDATA[Combines exact ticket and run filters over stable attempt ID order.]]></method>
  <method name="run.actions" mode="Q"><![CDATA[Reads pending parent/child runner actions. Reading does not acknowledge an action or change either run.]]></method>
  <method name="run.action_acknowledge" mode="M"><![CDATA[Records evidence that the harness handled one pending action. The parent or child owner may acknowledge; this does not transition the child.]]></method>
  <method name="allocation.pool_put" mode="M"><![CDATA[Updates a configured pool bound. Lowering the bound can prevent future allocation; it does not stop active attempts.]]></method>
  <method name="allocation.ticket_policy_put" mode="M"><![CDATA[Sets required capabilities and named pools. All capabilities and all pool capacities must be available. An active attempt prevents editing its ticket policy.]]></method>
  <method name="allocation.pools" mode="Q"><![CDATA[Reads configured pool definitions. Inspect current attempts or coordinator metadata for consumption.]]></method>
  <method name="allocation.ticket_policies" mode="Q"><![CDATA[Reads ticket allocation policies; empty capability/pool lists remove those restrictions.]]></method>
  <method name="ticket.claim_next" mode="M"><![CDATA[Atomically chooses eligible work, acquires the ticket and required path ownership, and starts an attempt. Priority precedes unspecified priority, then creation order and ticket ID. An empty selection is a durable result. Resume or retrieve the ticket to inspect its granted token.]]></method>
  <method name="run.budget_put" mode="M"><![CDATA[Replaces configured attempt/concurrency bounds and externally reported spending attention limits. Null removes a limit. Provider spending remains the harness responsibility.]]></method>
  <method name="run.budget_get" mode="Q"><![CDATA[Reads configured bounds; absence means unbounded allocation and returns Not_found.]]></method>
  <method name="usage.report" mode="M"><![CDATA[Records immutable externally reported spending with its attribution and provenance. Identical ID/content duplicates are recognized; conflicting content cannot replace a report.]]></method>
  <method name="usage.list" mode="Q"><![CDATA[Reads immutable usage records in usage ID order. These reports do not prove provider totals.]]></method>
  <method name="run.budget_attention" mode="Q"><![CDATA[Reports configured spending limits reached or exceeded. Saturated totals are explicitly lower bounds. This method never creates a cancellation or enforces spending.]]></method>
  <method name="ticket.renew_lease" mode="M"><![CDATA[Requires the exact current claim token and lease revision, an unexpired timed lease and accepted server clock. It keeps the claim token and advances the lease revision. Indefinite leases cannot renew.]]></method>
  <method name="run.heartbeat" mode="advisory-write"><![CDATA[Writes a coalesced advisory observation outside planning history. The registered owner must match. Heartbeats do not renew ownership and are not transactional mutation receipts.]]></method>
  <method name="run.heartbeat_get" mode="Q"><![CDATA[Reads the latest advisory heartbeat; a missing observation returns Not_found.]]></method>
  <method name="reservation.acquire" mode="M"><![CDATA[Acquires all requested named reservations atomically. Exclusive ownership conflicts with any other holder; shared ownership permits shared holders. Names are arbitrary nonblank names, independent of lexical path ownership.]]></method>
  <method name="reservation.renew" mode="M"><![CDATA[Requires the exact holder token and lease revision. Keeps holder token/mode and advances only the lease revision.]]></method>
  <method name="reservation.release" mode="M"><![CDATA[Removes only the exact matching holder. Cleanup is allowed after expiry or terminal run, with the current actor/run/token. Other shared holders and the reservation epoch remain.]]></method>
  <method name="reservation.get" mode="Q"><![CDATA[Reads complete current holders, tokens and leases. A previously released name may have no holders.]]></method>
  <method name="reservation.list" mode="Q"><![CDATA[Reads reservations in stable name order from the run coordination projection.]]></method>
  <method name="template.register" mode="M"><![CDATA[Pins an immutable resource content version whose digest equals the canonical JSON template specification digest. Identical versions are duplicates; conflicting content cannot replace them.]]></method>
  <method name="template.get" mode="Q"><![CDATA[Reads one complete pinned template version.]]></method>
  <method name="template.list" mode="Q"><![CDATA[Reads registered template versions.]]></method>
  <method name="template.instantiate" mode="M"><![CDATA[Expands literal parameters and creates the deterministic ticket graph and enabled policies in one serialized transaction. Reusing an identical instance returns its original graph; changed parameters conflict.]]></method>
  <method name="template.instance_register" mode="M"><![CDATA[Validates a deterministic instance against an already existing graph. It does not create tickets itself.]]></method>
  <method name="template.instance_get" mode="Q"><![CDATA[Reads the complete immutable instance and generated ticket plan.]]></method>
  <method name="template.instance_list" mode="Q"><![CDATA[Reads instances in stable instance ID order.]]></method>
  <method name="coordinator.overview" mode="Q"><![CDATA[Reads whole typed rows from one current planning/head/heartbeat capture. Rows sort by kind then stable source key, independently of claim-next priority. A registered run selector checks allocation rules; no selector reports graph readiness. Unknown run selectors return Not_found. Cursor pages preserve the first clock and reject changed revision, head, filters, heartbeat capture or clock regression. An oversized next row preserves its position with needs_larger_budget, next_item_source and exact required_bytes. Dependency edges have a separate bounded prefix and omission count; no task duration is inferred.]]></method>
  <method name="changes.read" mode="Q"><![CDATA[Reads complete captured commit metadata immediately. Planning workspace revisions and global history journal commit sequences are independent; retain separate cursors for each source/filter combination. Metadata items retain all captured targets, attribution, timestamp and lowercase change kinds. Full planning change bodies are available through activity.since; session events and payloads use history methods.]]></method>
  <method name="changes.wait" mode="Q"><![CDATA[Uses the same feed capture and response as changes.read, with a bounded wait outside the serialized transaction dispatcher. It returns matching items, an oversized next item or an ordinary empty timeout response. It advances past nonmatching commits while preserving filters. Disconnect and shutdown cancel waiting without acknowledgements or ownership changes.]]></method>
</coordination_api>
</workgraph_reference>
```
