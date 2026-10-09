# Atomic transaction contracts

`transaction.apply` uses the actual planning-family request and result codecs.
Each operation has a closed method discriminator; nested transactions, queries,
administration, uploads and history appends are excluded. The catalog composes the
same operation codec with the ordinary mutation identity. Domain decoding consumes
the typed operation list, then checks creation aliases and entity kinds.

Results are ordered `{method,data}` records. Each `data` uses its method's normal
receipt schema, validated while preparation is still pure. A batch publishes once,
after all operations and final-state invariants pass. A failed batch publishes none.
Exact retry returns the original complete result without reapplying operations.

Fact scopes share the same field declarations for resolved IDs and transaction
references. Only scope IDs admit aliases; arbitrary JSON fact values remain
literal. This was verified with an independent fixture containing alias-looking
strings and entity-shaped objects inside the stored fact value.

On 2026-10-08, macOS ARM64:

- `./dev build lib/workgraph.cma @test/planning_api/runtest
  @test/resume/runtest @test/codex_hooks/runtest @test/facts/runtest` passed.
- `./dev build @test/transaction_api/runtest` passed the independent real-socket
  test (0.499 seconds): a ticket/fact/comment transaction, literal fact data,
  method-tagged receipts, malformed/forbidden/nested/duplicate-alias rejection,
  all-or-nothing failure and exact receipt replay after daemon restart.

These are focused checks. Full-tree formatting, all tests and installed-package
qualification remain separate requirements.
