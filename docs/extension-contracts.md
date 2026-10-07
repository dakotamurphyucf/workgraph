# Local coordination and history contracts

Workgraph is a local workspace and memory store for an agent harness. The harness
owns model calls, context selection, compaction policy, agent launching, external
side effects, provider token accounting, and deciding which work to pursue. No
MCP server, external database, broker, or distributed consensus service is needed.

This preview has one current format. Earlier prototype schemas and migrations are
not supported. Format tags reject unexpected data; they do not introduce a second
implementation or compatibility branch.

| Operations | Owner and durable boundary | Retry and retrieval |
| --- | --- | --- |
| Planning, boards, threads, requests, teams, subscriptions, runs, attempts, reservations, evidence, review, templates, budgets | The serial dispatcher prepares an immutable transaction; the persistence worker syncs referenced blobs, the transaction, and HEAD before publishing state | Actor-scoped mutation IDs return the original receipt; changed content conflicts. Atomic batches either publish all effects or none |
| Session create/archive/append | The same persistence owner maintains a separate immutable journal and synced history HEAD | Stable mutation IDs recover lost acknowledgements. Per-session client event IDs deduplicate exact content and reject changed content. Appending a transcript does not consume a planning revision |
| Historical reads and lexical search | A bounded history worker reads an immutable capture while the workspace root is pinned | Exact payload bytes and complete supplied searchable text remain separate. A private disk index can be rebuilt. Explicit heads and event references recover an earlier context |
| Changes read/wait | Durable audit metadata only; a parked connection waits outside the transaction dispatcher | Cursors bind workspace, source, filters, a captured upper bound, and history lineage. Changed or unavailable history requires an explicit rescan. Bodies are retrieved separately |
| Coordinator overview | A pure view of committed state plus explicitly advisory heartbeat observations | Pagination binds revision, authoritative HEAD, filters, captured time, and heartbeat observations. Budget limits preserve whole rows; an oversized row stays at the same cursor |
| Ticket and reservation leases | Opt-in durable grants and exact renewals, with server time and fencing tokens | Default ownership is indefinite. Heartbeats do not renew leases. Expiry never asserts that a process stopped; explicit reassignment advances the fence |
| Heartbeats | A private `.local` advisory cache, coalesced across the workspace | Responses distinguish the latest observation from the persisted observation. Close/shutdown flush the cache when possible. It is excluded from portable history and cannot grant ownership |
| Exports and restores | Immutable planning revision plus history HEAD, complete verified inventory, fresh staging root, synced publication | Retries retain the original capture vector. Both domain and history ancestry participate in one-writer Git handoffs. Fenced owners can still close for recovery |

A review decision refers to an exact submission, manifest, contract, and policy.
Later evidence cannot reuse an earlier approval. Rejection creates actionable
communication; changing declared inputs creates reconciliation records. Completed
historical work is preserved until explicitly reopened. Resource/comment changes
and their reconciliation records are committed atomically.

Templates are pinned to resource versions and instantiate within the existing
atomic transaction limit. Budgets distinguish enforceable allocation limits from
externally reported spending. Workgraph reports attention items; it does not stop
an inference provider or kill an agent process.

Use ordinary scoped progress notes, handoffs, decisions, resources, and a small
recovery index to make context reconstruction predictable. The reference
[history adapter](history-integration.md) preserves exact historical content and
stable links; it does not prescribe a universal summarization strategy.
