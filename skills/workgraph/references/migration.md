# Migrate a released 0.6.2 workspace

The offline `migrate` helper converts the workspace formats supported by Workgraph
0.6.2 into a fresh root for the current release. The original committed files stay
unchanged. Ordinary daemon startup, registration and restore accept only current
formats; they do not convert older data automatically.

This converter supports workspace format 5, planning transaction/event format 5,
planning/history HEAD format 1 and history batch format 1. These are the released
0.6.2 representations. A workspace records format identifiers, so the converter
cannot prove which patch version originally wrote it. Earlier formats are rejected.

## Convert and cut over

First resolve uncertain writes with the **old 0.6.2 executable and daemon**, using
the original saved request files. Stop that daemon before converting. The migration
requires the source writer lock and rejects a root that is still open.

Run the new executable with absolute paths. The destination must not exist, and
neither root may contain the other.

```sh
workgraph migrate --from 0.6.2 \
  --source /absolute/old-workspace \
  --destination /absolute/new-workspace
```

The helper validates the original hash chains, transforms history metadata, copies
referenced blobs, and opens the staged output through the ordinary current replay
and integrity checks. It publishes the complete root with an atomic rename that
cannot replace an existing destination, then syncs the parent directory. Success
prints JSON with the workspace identity, unchanged planning head and revision,
old and new history heads, and a mapping for every historical batch digest. The
same report is retained in the new root's `.local/migration.json` ownership record.

Register the verified destination separately in a fresh registry. For example,
start its daemon in one terminal:

```sh
workgraph serve /absolute/new-registry /absolute/new-socket
```

Then register the existing migrated root:

```sh
workgraph workspace register /absolute/new-socket \
  --root /absolute/new-workspace \
  --actor-id migration --mutation-id register-migrated \
  --save-request /absolute/new-request-directory/register.json
```

Point new client contexts at the new socket. The old root and registry remain
available for inspection with the old executable; migration does not delete them.
Do not treat ongoing use of both roots as synchronized workspaces.

## What is preserved

Planning transactions keep their original bytes, sequence numbers, heads, mutation
keys, request hashes and receipts. Entity IDs, retained resource versions and
resource bytes remain unchanged. History session IDs, event sequences, parent
references, event input identity hashes, payload bytes, searchable text,
attachments, resource-version references and typed event evidence pins survive.
Old history receipt metadata is converted with its journal record.

Old sessions have explicit null `created_at_unix_ms` and `last_event_at_unix_ms`.
Old append changes have null `committed_at_unix_ms`. Migration does not infer times
from file modification dates, import time or opaque source timestamps. A subsequent
new append records a known last-event time while unknown creation stays null.
Existing source timestamps inside user payloads or provenance remain user data.

History batch bytes change, so their SHA256 hashes and history HEAD change. Use the
reported mapping when explicitly translating a historical read pin; reacquire
pagination captures and cursors. The daemon does not silently alias an old history
head to a new one. Planning heads remain unchanged.

The current API is 0.7. Saved 0.6 request envelopes cannot be retried unchanged
against it. Preserving internal receipt identities does not make old API files
compatible. Resolve uncertain old requests before migration; leave their exact
saved bytes intact.

## Scope and failures

The converter copies committed workspace state and its referenced blobs. It does
not copy uncommitted orphan files, local indexes, heartbeat caches, unfinished
uploads, registry jobs or intents, old exports, or request directories. Registering
into a fresh registry avoids changing old administrative receipt/path bindings.
Generate new exports from the migrated root; do not edit old manifests in place.

Corrupt source hashes or references, unsupported/mixed versions, symlinked
canonical files or directories, held locks, overlapping roots and destination
collisions reject. New required metadata can increase history record sizes; a
source too close to target capacity limits may reject with a capacity diagnostic.
The helper never splits a committed batch or transaction to fit a limit.

An expected error after staging reports an owned staging path and cleanup token.
The source remains intact. Inspect the failure, then remove that unpublished stage
explicitly before starting a new conversion:

```sh
workgraph migrate cleanup \
  --stage /absolute/new-workspace.migrating-TOKEN \
  --owner-token TOKEN
```

Cleanup checks the ownership marker, active migration lock and complete file
allowlist before deleting anything. It refuses unexpected entries, wrong tokens
and published destinations. If creating the ownership marker itself failed, the
error identifies a partial directory and says automatic cleanup is unavailable.
No generic resume operation is provided: after owned-stage cleanup, rerun from the
unchanged source.

If the final rename succeeded but syncing its parent failed, the result is
`Outcome_unknown` and names the published destination. Inspect and verify that
root; never overwrite or delete it to resolve the uncertainty. A normal rerun
refuses an existing destination.
