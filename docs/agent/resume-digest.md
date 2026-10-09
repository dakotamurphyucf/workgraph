# Recorded resume and activity digest

```xml
<workgraph_reference name="resume_digest">
<contract><![CDATA[
`ticket.resume` returns a deterministic brief from one immutable planning capture.
It reads recorded task fields, current ownership and readiness, the latest handoff,
path requirements, external conditions, recovery audits, the effective acceptance
policy and completion gates, associated run and latest attempt, outstanding requests, selected facts and
changes after the handoff's recorded coverage. It performs no model execution or
external side effects.

```json
{"method":"ticket.resume","params":{"workspace_id":"example","ticket_id":"task","max_bytes":"65536","change_limit":"10","include_markdown":false,"fact_selections":[{"scope":{"kind":"ticket","id":"task"},"key":"decision"}]}}
```

The required task excerpt preserves its exact current claim, lease, hold, status,
project membership fence and control counters. It excludes relation and history
arrays with explicit counts. Its exact source references lead to the complete
canonical task record; excluded history is never silently described as empty.
Known descriptive text may be a UTF-8 prefix, with original and omitted byte
counts. Facts, pins, identities and leases are whole records. Selected facts use
exact scopes with no inheritance or inferred relevance. Missing and deleted keys
are distinct warnings. Ticket fact key discovery is returned separately from
selected values; it is not a claim that every discovered fact is relevant.

Task description and latest handoff prose use the space remaining after selecting
records and history, rather than a fixed 256-byte excerpt. Short instructions stay
complete when they fit. Markdown labels `Ticket description` and `Handoff objective`
separately and renders the latest handoff once; its structured audit row remains in
`changes` with the original source and coverage. Omissions still disclose exact bytes.

Discover small memory values with `fact.keys` for the exact scope, then select only
the keys needed for this task using `fact_selections` as in the example above. Key
discovery does not load values into the resume automatically.

Handoff freshness follows recorded coverage and the current claim token. A new
claim by the same actor can make the saved handoff incomplete. Missing coverage,
new recorded activity, unavailable observation time and omitted sections are
explicit. The daemon supplies its current observation time; pure State callers
must supply a time when requesting timed ownership diagnostics.

Post-handoff warnings include activity kinds and counts. `handoff_bookkeeping_activity`
means only handoff records and claim transitions followed coverage; inspect the
current owner before acting. `handoff_new_activity` includes other recorded changes.
Neither warning moves coverage or a cursor, or proves that external work has stopped.

`activity.digest` classifies committed transitions into completion, reopening,
decision, blocker, request, condition, recovery, ownership, progress, fact, task
change and resource rows. It compares actual historical task transitions and
retains exact source content or disclosed prose excerpts. Other resolved changes
are counted separately. A fact change is not inferred to be a decision.

```json
{"method":"activity.digest","params":{"workspace_id":"example","scope":{"kind":"ticket","ticket_id":"task"},"after":"0","limit":"50","max_bytes":"65536","include_markdown":false}}
```

The scope may be workspace (the default), project or ticket. Project selection
includes recorded ticket and milestone containment. A resource-targeted record
belongs to its explicitly recorded target scopes at that captured position: one
resource-link hop, followed by ticket/milestone project containment. Resource-to-
resource chains are not traversed. Removing a link appears once in its previous
scope; later comments on the unlinked resource do not belong to that scope. No
current membership is borrowed for an older captured page. Returned cursors bind
workspace, scope and the exact retained audit prefix. Continue with the same scope
and the returned cursor, omitting `after`. Rows are ordered by workspace revision
and zero-based change ordinal, so a large transaction can span multiple pages
without losing its remaining rows. A page keeps its original `capture.through`
and request summary despite intervening commits. Outstanding requests and their
scope are reconstructed at that captured boundary, using captured thread links
and board scope. A completed cursor validates its old prefix before advancing to
a fresh upper boundary. A different workspace, scope or restored prefix rejects
the cursor with `Conflict`; malformed cursor data is `Invalid_argument`.

Both methods measure the complete public response, including metadata, provenance,
counts, continuation and optional Markdown, against `max_bytes` (4096–1048576,
default 65536). Whole optional records are omitted with section counts. A digest
whose first complete row cannot fit returns an actionable error to increase the
budget; it never skips that row. A resume may omit all change rows while returning
its essential task; its cursor continues them through `activity.digest` with the
same ticket scope. `include_markdown` defaults to false. When true, structured
records and deterministic Markdown are fitted together. Markdown escapes recorded
text and contains stable source labels rather than interpolated remote URLs.

Source references identify recorded versions. A current getter with `at_revision`
is an exact current capture guard, not a historical snapshot reader. Expand a
`planning_change` source using `activity.since` after its workspace revision minus
one, page until the pinned revision appears, then select the exact change ordinal
from that audit's complete public changes. Comment, fact and request histories
also retain their exact versions. A task recovery is represented by its complete
recovery audit and exact guards; use its preceding task source plus that audit to
reconstruct the recovered control fields. Current task/run getters may already
have moved beyond a pinned version. The source and capture references disclose
this distinction rather than promising a current getter returns old content.
]]></contract>
<methods>
<method name="ticket.resume" mode="read">
<params><![CDATA[workspace_id; ticket_id; optional run_id, at_revision (current guard), max_bytes 4096..1048576, change_limit1..100, fact_selections<=16 exact {scope,key}, fact_prefix<=128 UTF8 bytes, include_markdown defaultfalse. Unknown/duplicate fields reject. Fact scopes use kind plus id; digest scopes use project_id or ticket_id.]]></params>
<result><![CDATA[result.meta.workspace_revision; result.data {ticket_id,capture,observed_unix_ms,items,changes,warnings,counts,cursor,has_more,markdown?}. Items include kind,summary,typed sources,actual record and clipped_fields. Captured task excerpt counts excluded history arrays; current ownership/control fields remain exact. Counts include section,total,returned,omitted.]]></result>
</method>
<method name="activity.digest" mode="read">
<params><![CDATA[workspace_id; optional scope workspace|project(project_id)|ticket(ticket_id), after or cursor (mutually exclusive), limit1..100, max_bytes4096..1048576, include_markdown defaultfalse. Keep scope unchanged across cursor pages.]]></params>
<result><![CDATA[result.meta.workspace_revision; result.data {capture,entries,outstanding_requests,counts,cursor,has_more,markdown?}. capture {after,after_change_index nullable,through,lineage}. Each entry has workspace_revision,change_index,category,item with exact source refs. Complete records fit atomically; no first row fits returns Invalid_argument increasebudget.]]></result>
</method>
</methods>
</workgraph_reference>
```
