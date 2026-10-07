# Workgraph agent guidance

Read `engineering-standards.md` before changing code. Read `AGENT_GUIDE.md` when
using Workgraph as a tool; it describes the runtime API rather than development
policy.

Workgraph is a standalone OCaml/Core/Eio package with its own Dune root. Use
`./dev` and the existing pinned toolchain; never change unrelated opam switches
or global defaults. `WORKGRAPH_OPAM_SWITCH` selects an already provisioned matching
switch. Keep the package independently buildable and its dependencies explicit.

Draft coherent types and `.mli` interfaces before implementation. Use typed
comparison, receiver-first APIs, validated invariants, Jane Street formatting/PPX
and meaningful expect tests. Validate public decoders and durable replay as well
as command preparation. Use Eio for I/O; keep unsupported native filesystem
primitives in the narrow `Platform` adapter and blocking calls in system threads.
Preserve cancellation and unexpected exceptions instead of disguising them as
domain errors. Do not promote prototype shortcuts into production contracts.

Preserve serialized planning transactions, immutable captures, durable publication
before acknowledgement, exact retry identities and uncertain-write fencing.
Workgraph is a lightweight local state service. The harness owns agent processes,
prompt/context policy and external side effects. Do not introduce a model runtime,
MCP server, distributed coordination or compatibility with unreleased prototype
formats without an explicit requirement. Only the current schema is supported.

Run focused checks while editing, then apply `./dev fmt` and verify
`./dev build @fmt @runtest @install`. These include real daemon/socket tests;
report any environment restriction instead of claiming an unexecuted check passed.
Do not replace a failing test expectation without establishing the intended
behavior. Keep CLI examples and public `.mli` contracts consistent with changes.

Use `scratch/` for local experiments, logs, implementation notes and handoffs;
it is ignored by Git and excluded from Dune discovery, as is generated `dist/`.
Every implementing agent must keep its own notepad under
`scratch/agents/<unique-agent-or-session-id>/`, with a separate `<ticket-id>.md`
per ticket (or named task file) and a short `index.md` of active work and next steps.
Never overwrite another agent's notes or append history to a shared global notepad.

Update notes as work proceeds and before compaction/handoff: decisions, changed
files, exact commands/results, running processes and concrete next steps. Summarize
stale detail and link logs. Durable accepted designs and completion evidence belong
in `docs/`; local implementation plans and handoffs stay in scratch. Use external
trackers only when authorized. Packaging uses an explicit source allowlist; update
it when adding documentation that standalone users need. Never publish or commit
local workspace data, request files, credentials or experimental logs as source.
