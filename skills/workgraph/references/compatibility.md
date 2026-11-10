# Match binaries, APIs and stored formats

Workgraph supports one current schema per representation. The 0.8.3 release retains the representations introduced in package 0.7.0:
application API 0.7, workspace/export format 6, history batch format 2 and saved
upload plan 2. Registry and planning transaction/event formats remain 5; planning
and history heads remain 1. Independent identifiers do not need to match.

The 0.7.0 release changed stored history metadata and public read views. Normal daemon
startup, registration and restore do not convert older formats. The explicit
[offline migration helper](migration.md) accepts only the released 0.6.2 workspace
representation and writes a new root while preserving its source. Resolve uncertain
old requests with their old executable first, then use a fresh registry, socket,
contexts and request journals. Older preview formats are outside its scope.

## Identify the representation before reading it

The **package version** identifies the executable release. The **application API**
identifies request and response contracts. A **stored format** identifies one
persistent representation, such as a registry or transaction envelope. A **receipt**
is the recorded outcome of an exact mutation identity. A **head** identifies the
published end of a durable history. Independent representations keep independent
version markers, counters and heads.

Readers inspect a root's format marker before decoding its version-dependent
fields. A missing or unsupported string marker reports `Unsupported_version` with
`representation`, `observed` and `supported` details. A malformed marker type or
duplicate field remains `Invalid_argument`. Unknown or missing fields within the
current format also fail validation. Only the current complete shape is accepted.

Portable workspace storage separates stored event definitions from evolving
in-memory records. A validated conversion connects current domain events with
the persisted representation in both directions. Structural decoding
checks exact fields and types; deterministic state replay checks references,
transitions, and derived indexes. Transaction recovery verifies the actor against
the `actor:mutation` receipt key, transaction/event/response revisions, lowercase
SHA-256 hashes, predecessor shape, and `durable:true`. The store also checks exact
file hashes, workspace identity, sequence continuity, unique receipt keys, and
referenced blob bytes. Commit validates before installing blobs or publishing a
head.

| Representation | Current identifier | Required contents |
| --- | --- | --- |
| Application request and saved retry envelope | `workgraph_api:"0.7"` | JSON-RPC 2.0 envelope and current method parameters |
| `initialize` result | `workgraph_api:"0.7"` | Current capabilities; `registry_format_version:"5"` |
| Workspace descriptor | `version:"6"` | Workspace identity and complete current fields |
| Planning transaction and planning event envelope | `version:"5"` | Complete current transaction/events and durable receipt |
| Local registry | `version:"5"` | Workspaces, receipts, creates, exports, and restores maps |
| Workspace export manifest | `version:"6"` | Full state, head, history head, options, and files |
| Workspace-set export manifest | `version:"6"` | Exact workspace vector, omissions, and member manifest hashes |
| Planning HEAD and history HEAD | `version:"1"` | Their unchanged independent representations |
| History batch | `version:"2"` | Session creation/last-event times and append commit time are required nullable epoch-ms fields |
| Advisory heartbeat cache | `version:"1"` | Its unchanged independent representation |
| Saved CLI upload parameters | `transfer_version:"2"` | Explicit upload identity, content size/hash and durable request identity, inside a current API envelope |

Unchanged nested event representations retain their own identifiers. A new workspace
or export marker does not renumber planning transactions, events or heads.

## Convert supported old workspaces explicitly

Keep the matching old binary, stopped roots, exports and exact saved requests.
Use [migration](migration.md) to validate and translate the supported 0.6.2-format
workspace into a fresh root. The converter verifies source chains and blobs, replays
the translated result with current readers and publishes without replacing a target.
Planning bytes, IDs, revisions and heads remain unchanged. History batches acquire
nullable server timestamps, so history digests change; the report maps old batch
heads to new ones. Unknown old times stay null. The daemon does not alias old pins.

Create a fresh registry and contexts pointing at the new socket. Preserve old
journals intact: API 0.6 saved requests cannot be retried unchanged against API 0.7,
even where internal receipt identity survives. Old registry jobs, unfinished uploads,
exports and request directories are not converter inputs. Generate new exports
from the migrated workspace. Earlier preview formats need their matching binary;
never edit format markers or copy old registry files to bypass these checks.

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
conversion from representations outside the explicit migration contract are unsupported.

## Bytes and numbers

JSON is UTF-8, at most 64 levels deep, with no duplicate keys or nonfinite numeric
values. Writers sort object keys bytewise, preserve array order and string contents,
and emit compact JSON with the pinned Jsonaf encoder. No Unicode normalization is
performed. This is Workgraph canonical JSON, not a claim of RFC 8785 compatibility.
SHA-256 covers exact encoded bytes, without a self-referential digest field.
Readers can accept equivalent whitespace and key order, but verify the original
file bytes against its filename/head digest; they do not hash a rewritten
representation.

Sequences, revisions, tokens, offsets, and byte counts use canonical nonnegative
decimal strings: no sign, leading zeros, separators, fractions, or exponent syntax.
The wire decimal parser accepts the nonnegative signed 64-bit range, 0 through
9223372036854775807. Native-domain conversion is checked separately. Supported
runtime builds are 64-bit; native counters cannot exceed 4611686018427387903.
Operational bounds are smaller: 100000 workspace transactions, 128 commands per
transaction, 64MiB blobs, and the documented per-field/query limits. Values outside
a field's supported range are rejected; arithmetic never relies on accepting the
full int64 range for a sequence or allocation. JSON-RPC error codes and numeric
request IDs remain JSON numbers, rather than decimal-string domain counters.

## Wire profile and retries

Each Unix-socket connection carries one request and response: four-byte big-endian
length, then 1..4194304 bytes of JSON. The request envelope has `workgraph_api:"0.7"`, `jsonrpc:"2.0"`, an ID,
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
or feature. `transaction.apply` is an explicit 1..128-operation atomic method, not
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
