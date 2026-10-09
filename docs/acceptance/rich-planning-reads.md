# Rich planning reads qualification

The twelve executable read contracts are `workspace.overview`, `project.brief`,
`ticket.list`, `ticket.ready`, `ticket.readiness`, `ticket.blockers`,
`ticket.resolve`, `ticket.context`, `handoff.get`, `handoff.history`,
`activity.since`, and `search.query`. Their generated method references in
`docs/api-reference/` are the exact request/result schemas. The same typed codecs
validate runtime requests and results; durable planning records remain separate.

Ticket and handoff identities use named fields, including `ticket_id`,
`parent_ticket_id`, `prerequisite_ticket_ids`, `actor_id`, and `resource_ids`.
Lease decoding validates the actual allocation-lease duration/deadline and epoch
invariants. Ownership, revision counters, IDs, statuses, captures and source
provenance survive byte fitting. Scalar reads reject meaningless paging/archive
options; pages require a current `at_revision` when continuing at an offset.

Current entity descriptions can be shortened with explicit omission metadata.
Pages retain complete rows and advance their cursors. Historical handoffs and
activity changes retain their complete content. An oversized first retained row
or essential context record returns an actionable error instead of an empty
success page with an unchanged cursor. Handoff coverage defaults conservatively
to revision zero; callers explicitly supply the prefix they reviewed.

Activity has seventeen closed named change alternatives. Nested facts,
communication, runs, evidence, policies, workflow, discussion and resource changes
have validated typed snapshots. Immutable initial comment versions, original
bodies, frozen routing recipients, exact selected acknowledgement IDs, digests,
null fact values and original source attribution remain available after restart.
Discussion source actor/timestamp/sequence and handoff/publication actor/timestamp
must match their audit header. A stable signal receipt must match its accepted
signal identity, condition revision, operation, artifact, ordered evidence,
summary and actor/run. Its original timestamp and sequence stay unchanged across
later retries; a same-transaction original may have the outer revision. Fields
absent from a domain snapshot are not invented.

Search uses current source revisions and source-specific identity fields.
Fact sources retain the restricted owning `Facts.Scope` plus their exact key.
Search selectors use named entity IDs. Match/snippet coordinates count UTF-8
bytes and require valid byte boundaries. Resource-text coverage reports unsupported,
invalid, truncated and aggregate-budget omissions separately.

Focused qualification on the pinned toolchain:

```sh
./dev build @test/planning_activity/runtest @test/planning_context/runtest \
  @test/planning_ticket/runtest @test/planning_read/runtest \
  @test/communication/runtest @test/resume/runtest \
  @test/transaction_api/runtest @test/api_catalog/runtest
```

The final run exited zero. Independent malformed fixtures cover attribution,
stable signal content, zero-change/duplicate-target summaries, private tagged
arrays, source IDs, null/deletion semantics, lease controls and UTF-8 match
boundaries. Real daemon/socket cases passed for retained activity and restart,
current search, canonical context/base reads, immutable communication history,
resume and transactions. The preceding run passed all six socket suites; the
only native difference was new expect-string indentation, reviewed and corrected
before the successful rerun.

The guide/catalog comparison passed with all 238 documented methods present.
This focused evidence does not replace the repository-wide formatting, test and
installation gates.
