# Workgraph format and durability

Workgraph is an early preview with one current schema per representation. The
0.4 preview deliberately breaks the 0.3 application API and affected stored roots.
It has no legacy readers, automatic migrations, or backward compatibility promises.
A package version, application API identifier and stored-format identifier serve
different purposes; they need not have the same value.

Readers inspect a root's format marker before decoding its version-dependent
fields. A missing or unsupported string marker reports `Unsupported_version` with
`representation`, `observed` and `supported` details. A malformed marker type or
duplicate field remains `Invalid_argument`. Unknown or missing fields within the
current format also fail validation. Only the current complete shape is accepted.

Portable workspace storage uses `Storage` and `Storage_event`. Event definitions
are independent of evolving domain records. A validated bridge converts current
domain events to the persisted event representation and back. Structural decoding
checks exact fields and types; deterministic state replay checks references,
transitions, and derived indexes. Transaction recovery verifies the actor against
the `actor:mutation` receipt key, transaction/event/response revisions, lowercase
SHA-256 hashes, predecessor shape, and `durable:true`. The store also checks exact
file hashes, workspace identity, sequence continuity, unique receipt keys, and
referenced blob bytes. Commit validates before installing blobs or publishing a
head.

| Representation | Current identifier | Required contents |
| --- | --- | --- |
| Application request and saved retry envelope | `workgraph_api:"0.4"` | JSON-RPC 2.0 envelope and current method parameters |
| `initialize` result | `workgraph_api:"0.4"` | Current capabilities; `registry_format_version:"3"` |
| Workspace descriptor | `version:"3"` | Workspace identity and complete current fields |
| Planning transaction and planning event envelope | `version:"3"` | Complete current transaction/events and durable receipt |
| Local registry | `version:"3"` | Workspaces, receipts, creates, exports, and restores maps |
| Workspace export manifest | `version:"3"` | Full state, head, history head, options, and files |
| Workspace-set export manifest | `version:"3"` | Exact workspace vector, omissions, and member manifest hashes |
| Planning HEAD, history HEAD and history batch | `version:"1"` | Their unchanged independent representations |
| Advisory heartbeat cache | `version:"1"` | Its unchanged independent representation |
| Saved CLI upload parameters | `transfer_version:"1"` | Content size/hash and durable request identity, inside a current API envelope |

Unchanged nested event representations retain their own identifiers. Changing the
outer planning envelope does not renumber every nested format.

Use the matching released binary and its bundled guide to inspect older data.
For this preview, create a fresh registry and fresh workspace roots for 0.4, with
a separate socket if an older daemon is still running. Preserve older data for use
with its matching binary. Do not change a marker by hand or point the new daemon
at old roots expecting a migration. Old saved requests and old exports are not a
supported route into 0.4.

Unsupported registry startup rejects before creating its daemon lock; unsupported
workspace descriptors reject before creating workspace lock/repair directories.
Unsupported export roots reject before restore staging or registration. These
checks preserve the rejected source trees; they are not a promise that arbitrary
corruption in a supported format never invokes ordinary recovery.

The registry stores machine-local paths, receipts, jobs, and intents; it is not
portable workspace data. Snapshot manifests cover the full state and file
inventory. Restore verifies manifest hashes, replays canonical history, and
checks blobs before registering roots closed. Export verification checks the
inventory and hashes; it does not claim canonical replay validation.

No automatic history rewrite, checkpoint, compaction, or garbage collection
runs. Orphan transaction/blob and abandoned export/restore stages are retained.
Back up closed workspaces and the registry when preserving local job and
administrative history. Unsupported or corrupt data is rejected for operator
recovery; do not edit HEAD or registry JSON to force it to load. Downgrades and
migration from formats created by other builds are unsupported.

## Bytes and numbers

JSON is UTF-8, at most 64 levels deep, with no duplicate keys or nonfinite numeric
values. Writers sort object keys bytewise, preserve array order and string contents,
and emit compact JSON with the pinned Jsonaf encoder. No Unicode normalization is
performed. This is Workgraph canonical JSON, not a claim of RFC 8785 compatibility.
SHA-256 covers exact encoded bytes, without a self-referential digest field.
Readers can accept equivalent whitespace and key order, but verify the original
file bytes against its filename/head digest; they do not hash a rewritten
representation. Independent JSON, canonical-byte, and SHA-256 fixtures live in
`test/fixtures/`.

Sequences, revisions, tokens, offsets, and byte counts use canonical nonnegative
decimal strings: no sign, leading zeros, separators, fractions, or exponent syntax.
`Json.integer64` accepts the signed int64 nonnegative range, 0 through
9223372036854775807. Native-domain conversion is checked separately. Supported
runtime builds are 64-bit; native counters cannot exceed 4611686018427387903.
Operational bounds are smaller: 100000 workspace transactions, 32 commands per
transaction, 64MiB blobs, and the documented per-field/query limits. Values outside
a field's supported range are rejected; arithmetic never relies on accepting the
full int64 range for a sequence or allocation. JSON-RPC error codes and numeric
request IDs remain JSON numbers, rather than decimal-string domain counters.

## Wire profile and retries

Each Unix-socket connection carries one request and response: four-byte big-endian
length, then 1..4194304 bytes of JSON. The request envelope has `workgraph_api:"0.4"`, `jsonrpc:"2.0"`, an ID,
method, and optional object params. The CLI supplies the application marker, including
in saved requests. Raw clients must supply it even for `initialize`. Responses retain
the ordinary JSON-RPC envelope; the initialize result reports the application marker. The OCaml client uses nonempty string IDs of at
most 256 bytes; the server also accepts finite numeric IDs whose encoded number
is at most 256 bytes, and null. Methods have
1..128 bytes. Unknown fields, batch envelope arrays, and malformed params are
rejected. Notifications are discarded without performing any mutation.

Successful responses contain `result`; failures contain only `error`. Malformed
frames/envelopes rejected before dispatch use code -32600, preserving a valid
parsed request ID when available (otherwise null). Admitted application failures
use -32000 and the request ID. Failures after dispatch never claim an invalid
envelope: a lost or malformed write acknowledgement remains uncertain. `error.message` equals `error.data.message`;
`error.data.kind` is one of these current names:

`Invalid_argument`, `Not_found`, `Conflict`, `Blocked`, `Dependency_cycle`,
`Already_claimed`, `Stale_claim`, `Idempotency_conflict`, `Corrupt_store`,
`Storage_unavailable`, `Local_io`, `Outcome_unknown`, `Workspace_closed`, `Unsupported_version`.

Clients reject unknown codes/discriminators, mismatched IDs, and ambiguous
envelopes. A strict -32600 response with null ID is a definite pre-dispatch
rejection; its optional data must be a valid diagnostic when present. This lets
older peers reject the new application marker without implying that a write ran.
Diagnostic envelopes are bounded to 64KiB with truncated text and bounded typed
details; use the relevant readiness/query method to expand omitted detail. This restricted profile does not implement every general JSON-RPC error
or feature. `transaction.apply` is an explicit 1..32-operation atomic method, not
JSON-RPC batch dispatch. Operations check preconditions in order and validate the
final graph; one success creates one revision, audit event, and receipt.

Workspace mutation identity is `(workspace, actor_id, mutation_id)`; registry
administration has its separate `(actor_id, mutation_id)` scope. Request hashes
cover method, parameters, and optional run attribution, excluding transport request
ID. Generated entity IDs are resolved only after original request receipt lookup.
An existing key with changed content fails with `Idempotency_conflict`. Receipts
are retained, including after restart and portable restore.

A timeout or disconnect cannot establish whether an admitted write committed.
Recover a fenced workspace or registry first, inspect its receipt, then retry the
exact saved request. Do not invent a new mutation ID to resolve an unknown outcome.
The CLI never retries a write automatically. A completed export's historical
admission receipt is distinct from its current job status.
