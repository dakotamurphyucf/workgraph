# Workgraph format and durability

Workgraph is an early preview with one current schema. The format
version on every persisted or wire representation is `1`; decoders require that
version and the complete current shape. Unknown fields, missing required fields,
and unsupported versions fail closed. There are no legacy readers, automatic
migrations, or backward compatibility promises. A future format change will be
designed explicitly and will update its decoder and documentation together.

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

| Representation | Current version | Required contents |
| --- | --- | --- |
| Workspace descriptor, HEAD, transaction, event | 1 | Complete current fields; exact schema |
| Local registry | 1 | Workspaces, receipts, creates, exports, and restores maps |
| Portable snapshot and export manifest | 1 | Full state, head, history head, options, and files |
| Export-all container manifest | 1 | Exact workspace vector, omissions, and member manifest hashes |
| Saved CLI upload plan | 1 | Content size/hash and durable request identity |
| Wire profile reported by `initialize` | 1 | Current method codecs and envelope/error names |

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
length, then 1..4194304 bytes of JSON. The envelope has `jsonrpc:"2.0"`, an ID,
method, and optional object params. The OCaml client uses nonempty string IDs of at
most 256 bytes; the server also accepts finite numeric IDs and null. Methods have
1..128 bytes. Unknown fields, batch envelope arrays, and malformed params are
rejected. Notifications are discarded without performing any mutation.

Successful responses contain `result`; failures contain only `error`. Malformed
frames/envelopes use code -32600 and null ID. Admitted application failures use
-32000 and the request ID. `error.message` equals `error.data.message`;
`error.data.kind` is one of these current names:

`Invalid_argument`, `Not_found`, `Conflict`, `Blocked`, `Dependency_cycle`,
`Already_claimed`, `Stale_claim`, `Idempotency_conflict`, `Corrupt_store`,
`Storage_unavailable`, `Outcome_unknown`, `Workspace_closed`, `Unsupported_version`.

Clients reject unknown codes/discriminators, mismatched IDs, and ambiguous
envelopes. This restricted profile does not implement every general JSON-RPC error
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
