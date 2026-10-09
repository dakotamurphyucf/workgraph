# Discussion integrity and entry-point fixes

Generated ticket-completion evidence has a persistent `completion` origin. It cannot
be edited or tombstoned, including by its original author. A correction is a new
`comment.add` with `kind: "evidence"` and `reply_to` referencing the original comment.
It does not reopen the ticket. Ordinary comments, including progress notes and
correction replies, have an `authored` origin and allow only their original actor
to revise or tombstone them. Earlier versions remain available.

These checks are cooperative attribution rules, not authentication. Actor catalog
membership does not prove who sent a request.

Resolved-event replay checks comment attribution against the transaction and binds
claimed ticket completion to its adjacent nonblank, immutable evidence. It rejects
missing evidence, downgraded origins, orphaned completion origins, and revisions
that violate authorship. Existing immutable review/validation records remain intact.
The current schema is the only supported format; there is no prototype migration.

The CLI now accepts advisory `run.heartbeat` calls without a mutation ID. A heartbeat
can be persisted in its private cache; it does not become a planning transaction.
`coordinator.overview` now consumes the workspace selector at the service boundary
and validates the remaining query fields normally.

Validation on macOS ARM64, 2026-10-08:

- `./dev fmt` applied the pinned formatter.
- `./dev build @fmt @runtest @install` passed, including 66 real daemon/socket tests.
- Added independent malformed-event/replay tests, author/edit/tombstone tests,
  linked-correction restart checks, coordinator strict-field checks and CLI heartbeat
  parity. Existing review/validation and export/restore tests passed.
- Root reviewed the implementation and tests; an independent reviewer found replay
  gaps that were fixed and retested, then reported no remaining package blockers.

This record covers the integrity package, not later lifecycle/API changes or final
platform artifact qualification. Release publication is a separate action.
