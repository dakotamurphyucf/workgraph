# v0.3 preview contracts

These accepted contracts guide the changes following the v0.2 agent trials.
They describe v0.3; the released v0.2 executable retains its old API.

- `ticket.finish.handoff` patches the current handoff. Omitted rich fields and
  coverage are preserved; explicit empty strings/lists clear them. Summary and
  next steps remain required. Completion evidence becomes the new handoff evidence.
  No existing historical handoff is rewritten.
- Client-local filesystem failures use `Invalid_argument` for invalid inputs and
  `Local_io` for expected operational failures. Store corruption and uncertain
  durable writes retain their existing meanings. Socket paths obey the native
  platform byte limit. Failed binding must not unlink another listener.
- Default method help is compact and input-oriented. Complete schemas remain
  available offline with self-contained shared definitions. Core/advanced discovery
  tiers are properties of the executable catalog, not separate API registries.
- Named CLI fields use the method's declared types. Only unambiguous Boolean
  fields convert `true`/`false`; strings and decimal strings remain strings. Raw
  JSON is never coerced. Validation diagnostics identify field/index paths.
- Errors may carry a typed `details` record. It is public diagnostic data, not
  internal serialization. Other owners' fencing counters are omitted. Actor IDs
  and counters remain cooperative attribution, not authentication.
- Entity mutations return the affected entity's revision, usable immediately as
  its next revision guard. Shared coordination sequence numbers must be explicitly
  named when returned; they are not entity revisions. Unobserved runs are distinct
  from stale heartbeat observations.
- Admission meters expose deterministic 50/80/95 percent warning bands and the
  distinction between cumulative storage and temporary upload occupancy. Limits
  remain authoritative; no data is silently deleted or summarized.
- Requests, including saved exact retry requests, require top-level
  `"workgraph_api":"0.3"`. JSON-RPC remains `"jsonrpc":"2.0"`. `initialize`
  reports the same application profile. Unsupported or missing profiles reject
  before method-dependent interpretation; no discovery round trip is required.
  `Unsupported_version` diagnostics identify representation, observed profile
  (including absence), and supported profile. An unsupported root is never
  migrated as a side effect of opening it. Persisted-format roots are inventoried
  and changed once when the final preview contracts settle.

Workspaces are intended to cover finite development cycles, including substantial
multiweek projects, then be verified, archived and closed. Current admission bounds
are not measured multiweek capacity guarantees. Checkpointing/compaction and an
Irmin backend evaluation remain separate future work. No distributed authority,
authenticated actors, or automatic history merging is introduced by this preview.
