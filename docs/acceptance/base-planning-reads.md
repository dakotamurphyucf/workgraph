# Base planning read qualification

Eight current read methods use executable request and result codecs:
workspace.get, project.get/list, milestone.get/list and actor/label/status.list.
Their shared public views use canonical project_id, milestone_id/project_id and
catalog actor_id/label_id/status_id fields. Project and Milestone mutation receipts
use the same codecs and typed model projections. Private planning snapshots and
durable replay events retain independent encodings.

Bounded responses protect identity, titles/names, revisions, counters, status,
dates, progress and cursor metadata. Only declared descriptive text fields and
page suffixes can shorten. Every omission is counted in the final response byte
budget. Retained pages advance by their actual returned count; oversized essential
records return an actionable error. Explicit null rejects optional request fields,
and positive offsets require the observed workspace revision.

On 2026-10-08 the pinned build completed the owned
`@test/planning_read/runtest` target. Native tests and the real daemon/socket
fixture passed; the socket fixture took 0.838s. The fixture exercises all eight
methods, Unicode descriptions under a 4KiB budget, protected long titles,
non-skipping bounded pages, archived filtering, revision conflicts, restart and
exact original mutation retry. Native coverage independently validates malformed
inputs, typed encoders/cursors and canonical receipts with durable replay.
The combined run also passed workspace metrics and admission checks; its
`@test/planning_api/runtest` target reported an unrelated template role policy
expectation mismatch assigned to that family owner.

The capability guide checker passed with 233 documented methods. The qualified
executable catalog contained 201 descriptors, with 35 documented methods still
missing descriptors and three lifecycle descriptors still missing method nodes.
Rich planning contexts, canonical Ticket/Handoff records, complete activity
changes and the final formatting/full tests/install gate remain separate work.
