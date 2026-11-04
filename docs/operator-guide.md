# Install and operate Workgraph

Version 0.5.2 includes the complete portable agent skill. See
[skill installation](agent-skill.md). Upgrading from 0.5.0 or 0.5.1 keeps the same API and
storage formats: retain your workspace, registry, contexts and saved requests.
Shut down the old daemon gracefully and restart with the new executable and the
same connection values. No data reset or migration is required.

Workgraph is a standalone early preview. It needs no hosted service, model
key, or account. The daemon and CLI are the same executable. All paths supplied
to it are absolute, and workspace/export destination parents must already exist.

## Install locally

For a source build, install opam, a C toolchain, make/pkg-config, and Python 3,
Git and jq for the test suite. If opam is new, initialize it without creating a
default compiler:
`opam init --bare --no-setup`. From an extracted source directory, provision a
dedicated switch without changing the global default:

```sh
workgraph_toolchain="$PWD/../workgraph-toolchain"
opam switch create "$workgraph_toolchain" ocaml-base-compiler.5.3.0 --no-switch
opam pin add --switch="$workgraph_toolchain" --yes --no-action dune 3.21.1
opam install --switch="$workgraph_toolchain" . --deps-only --with-test -y
export WORKGRAPH_OPAM_SWITCH="$workgraph_toolchain"
./dev build @fmt @runtest @install
./dev install --prefix "$PWD/../workgraph-install"
../workgraph-install/bin/workgraph --version
```

Direct dependencies are pinned in `dune-project`/generated `workgraph.opam`; Dune
requires at least 3.21. Select an existing matching switch with
`WORKGRAPH_OPAM_SWITCH` if one is already provisioned. `./dev` never installs
dependencies or changes a switch default. The repository's
[engineering standards](../engineering-standards.md) govern development.

`python3 tools/package.py NEW_ABSOLUTE_DIRECTORY` creates local source archives,
file manifests and `SHA256SUMS`; it does not build or publish anything. Supplying
`--binary ABS_EXECUTABLE --platform PLATFORM --notices DIRECTORY` also packages an
existing native executable with its dependency license texts and inventory.
Use notices from the toolchain that compiled the binary; the AlmaLinux recipe
collects these automatically. Check the tool's `--help` for supported labels and
[validation](validation.md) for executed platform evidence. A platform label alone
does not qualify a binary. Native bundles contain `bin/workgraph`; verify their
checksums and use a binary matching the target OS, architecture and runtime.

## Bootstrap v0.5.2 preview

<a id="candidate-bootstrap"></a>

This release identifies package 0.5.2/API 0.5 and affected stored roots 4.
Install a [matching release package](releases/v0.5.2.md#install) or build from source
as above. Follow the [upgrade steps](releases/v0.5.2.md#upgrade-from-04-or-an-older-preview)
before replacing an older executable. These commands use fresh private sibling
roots, socket, contexts and journals; WG must name the matching 0.5.2 executable.
Data, request journals and exports from 0.4 or earlier are not accepted or
automatically migrated. Existing 0.5.0/0.5.1 installations keep their current paths.

```sh
WG="$PWD/_build/default/bin/main.exe"
WG05_STATE="$HOME/.local/state/wg05"
umask 077
mkdir -p "$WG05_STATE/agent/requests"
"$WG" --version
"$WG" init --context "$WG05_STATE/agent/context.json" \
  --socket "$WG05_STATE/wg.sock" --workspace-id demo05 --actor-id operator \
  --root "$WG05_STATE/workspace" --name 'Preview workspace' \
  --request-directory "$WG05_STATE/agent/requests" \
  --start-daemon true --registry "$WG05_STATE/registry" \
  --daemon-log "$WG05_STATE/daemon.log"
"$WG" --context "$WG05_STATE/agent/context.json" workspace overview
```

Use a fresh WG05_STATE when any of these identities already belongs to another
setup. On WSL keep it on Linux storage. Shorten the private socket parent if needed
for the OS path limit. For a persistent foreground session, instead run serve in a
terminal/harness-owned process and omit init's daemon-start fields. Some harnesses
terminate children when a shell ends; check the initialize response and log rather
than assuming that is a product startup failure. Bootstrap timeout also does not
prove a detached daemon stopped.

Startup serializes socket-path ownership across different registries and parent
aliases. Only the exact recorded socket inode can be recovered under its exclusive
guard and peer checks. Unknown, symlinked, replaced, bound and live paths refuse.
Connection refusal, a PID guess and a registry lock are insufficient. Preserve
logs and choose a fresh endpoint when ownership is uncertain; never delete locks
or data to force startup. See [administration](../skills/workgraph/references/administration.md).

## Runtime layout

`skills/workgraph/scripts/serve-local.sh` is an editable foreground configuration example. Set
`WORKGRAPH_EXE`, `WORKGRAPH_RUNTIME`, and `WORKGRAPH_REGISTRY`, then invoke it with
`sh`. Use a short private socket directory to fit macOS's Unix socket path limit.
The socket is mode 0600. Use private local directories owned by the running user.
The application is not an authentication boundary among clients of that user.

The registry stores machine-local paths, open/closed intent, administrative receipts,
creation/restore intents and export jobs. Each workspace's custom root contains
`workspace.json`, `HEAD.json`, `transactions/`, `blobs/`, `.gitignore`, and private
`.local/` locks/staging. Workspace roots and active export/restore destinations
must be disjoint from each other and from the registry; use sibling directories.
Admission resolves existing symlink ancestors before checking overlap. Canonical
storage directories must remain real directories. Detecting replacement fences
the owner until close/recovery; repairing a path does not reactivate that owner.
Actor/run names provide attribution and claim fencing, not OS access control.

Start with `workgraph serve /registry /socket`. Stop with Ctrl-C, SIGTERM, or
`workgraph daemon shutdown /socket`. Shutdown drains admitted writes and cancels/
drains active exports. After an ungraceful stop, recovery verifies every registered
open root independently. Check `workgraph daemon health /socket`; one quarantined
workspace does not prevent healthy workspaces from opening. A failed daemon may
leave a socket pathname; startup's ownership checks distinguish stale paths from
live listeners. Do not remove another running daemon's socket or lock files.

Use the [API reference](api.md) and `workgraph --help` for named fields, raw JSON,
saved requests and timeouts. Stdout is machine JSON; diagnostics are on stderr.
`workspace.close` preserves closed intent across restart. `workspace.unregister`
removes the registration without deleting data. A moved closed root can be
registered at its new path while preserving identity and ancestry checks.

## Failure and retry procedures

| Result | Action |
| --- | --- |
| `Conflict`, `Stale_claim`, `Already_claimed` | Read current context/revisions; resolve ownership/preconditions before a new mutation |
| `Blocked`, `Dependency_cycle` | Inspect readiness/blockers and repair the plan explicitly |
| `Storage_unavailable` | Correct disk space, permissions or filesystem availability; preserve the original request |
| `Outcome_unknown` for a workspace | Close/open to recover (or restart), inspect `workspace receipt`, retry the exact saved request |
| Registry write fence/unknown outcome | Restart the daemon, inspect `registry receipt`, retry its original request |
| `Idempotency_conflict` | The key already names different content; find the original request/receipt before deciding on new work |
| `Corrupt_store`, `Unsupported_version` | Preserve evidence and recover a known-good portable copy; do not edit HEAD to guess a rollback |

`--save-request` writes/syncs an exclusive request file before transmission. Keep
it and use `workgraph retry /socket /saved-request.json`; retries preserve identity.
A lost response does not cancel admitted work. A stored receipt is authoritative;
missing in-memory data in a fenced workspace is not proof of absence. The CLI
does not automatically retry writes or generate replacement IDs after failure.

For corruption, stop writing, preserve the entire affected root (including orphans
and diagnostics), inspect health/logs, and verify a backup. Restore a verified
export into a new root. Do not delete history/blobs or rewrite registry/HEAD JSON
to make validation pass. Hashes detect inconsistent content but do not authenticate
someone with write access to the complete directory. Orphan transaction/blob and
abandoned export/restore stages are retained; there is no garbage collector.

Pending create/restore intents reserve their identities and roots. After fixing
storage, retry the exact request. A partly installed multi-root restore is resumable;
it is not one atomic filesystem transaction across disks. `restore.cancel` releases
an intent only when no target has been installed or occupied. It deletes no data.
See the [API reference](api.md#export-and-git-handoff) for full
restore/retry/cancel command spelling.

## Backups, restore and Git handoff

Start `workspace export` or `daemon export_all` with saved administrative requests.
Poll `export get` until completed, then `export verify`. Exports capture committed
immutable revisions while writes continue. Active exports pin source workspaces.
The manifest contains readable projections plus a complete `portable/` tree with
history, receipts and every resource version. Partial export-all explicitly lists
omissions and cannot be restored as a complete set. A staging directory is never
a completed export; use the published destination and manifest.

`workspace restore` requires a fresh root and a workspace ID absent from the local
registry. `daemon restore_all` requires explicit fresh roots for exactly the complete
export's IDs. Restore verifies manifests, replays canonical events and checks blobs,
then registers the roots closed. Open explicitly. `export verify` checks inventory/
hashes; its `canonical_state_validated:false` distinguishes that check from restore.
Back up the registry separately when preserving local job/administrative history;
workspace portability does not depend on carrying that registry to a new machine.

For Git, close and wait for success before commit/copy/pull. Track only the portable
workspace tree; `.local/` stays ignored. Clone on the receiving machine and register
the copied root with its local registry. Hand writer ownership off explicitly:
advisory locks protect one filesystem, not disconnected copies. Never run two
independent writers and expect a later Git merge to reconcile their transactions.
An existing registration rejects reopening a head that does not descend from its
last closed head. A fresh clone has no previous local head to compare against.

See [format and durability](../skills/workgraph/references/compatibility.md) for the current schema, rejected
format changes and recovery guarantees, the [API reference](api.md#storage-and-ownership)
for admission limits, and [validation](validation.md) for executed checks and
platform coverage. There is no checkpoint/compaction feature or actual hardware
power-loss qualification.
