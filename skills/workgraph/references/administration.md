# Daemon, workspace administration, exports and restore

Read [the shared CLI and wire contract](cli-contract.md) before constructing requests.
Return to [the capability guide](../SKILL.md) to choose another reference.
Unless a result is explicitly shown as a complete envelope, it describes `result.data`;
receipt, query and capture metadata are in `result.meta`. These are the current preview
contracts, not compatibility guarantees for previously published previews.

## Terms and lifecycle

The **daemon** is the local service process. Its **registry** records machine-local
workspace paths, administrative receipts and background jobs. A **workspace**
contains portable planning, resources and conversation history. A registration
associates that workspace identity with one local path; **closed** means the
daemon will not serve normal workspace operations until it is explicitly opened.

An **export** publishes an immutable captured snapshot into a fresh destination.
An export **job** has an admission receipt and a separately queryable current
status. A **restore** verifies/copies/replays an export into fresh roots, then
registers those workspaces closed. A **fence** stops ordinary writes after an
uncertain storage outcome until recovery can establish the durable state.

## Choose a lifecycle operation

- For a new workspace, use `workspace.create`: it creates, registers and opens it.
  To attach an existing portable tree, use `workspace.register` instead.
- To pause access before copying, pulling or handing a tree to another writer,
  close it. Opening replays and verifies its ancestry; unregistering removes only
  the local registration and leaves files in place.
- For a backup while work continues, start an export, retain the job ID, poll for
  completion, and verify the published directory. The captured snapshot stays
  fixed even if the source changes.
- To use that backup, restore into a fresh root in a registry where its workspace
  identity is absent, then explicitly open it. Preserve the old copy until the
  restored data has been checked.
- After an uncertain write, recover the fence and inspect `registry.receipt` or
  `workspace.receipt` as appropriate; retry the exact saved request. Current entity
  state alone cannot establish that request's outcome.

Read [format compatibility](compatibility.md) before moving data between binaries.
Only the current preview's complete formats are supported.

## Registry-scoped writes and private roots

Administrative writes use `actor_id` plus `mutation_id` in the registry receipt
namespace; workspace planning mutations use a separate workspace-scoped namespace.
Do not add run_id or workspace_id unless the method contract lists it. Successful administrative writes report `meta.durable:true`; method links describe
`result.data` and its metadata. Receipt reuse returns
the original response. Open/close/unregister/restore are explicit local lifecycle operations.
Use a separate private registry folder and sibling workspace/export/request folders.
Creation/export/restore roots are absolute UTF-8 paths, NUL-free and at most 64KiB, disjoint and fresh, with existing parents.
Existing aliases/symlink ancestors do not bypass overlap checks. One daemon cannot register
two copies of the same workspace identity. Never edit, rename, replace or pull into an open
managed tree. A closed workspace remains closed across daemon restart until explicitly opened.

## Method rules

### `initialize`

[Request and result contract](api/initialize.md).

The CLI constructs the required top-level application API marker; raw socket requests must supply workgraph_api:"0.5". This application profile differs from the package version and independently versioned persisted roots; see [format compatibility](compatibility.md).

### `daemon.health`

[Request and result contract](api/daemon.health.md).

An unavailable workspace can be quarantined independently while others are usable. If registry_requires_restart is true, restart the daemon before non-diagnostic operations.

### `workspace.list`

[Request and result contract](api/workspace.list.md).

Every entry includes a nonblank UTF-8 `name` (at most 512 bytes) and explicit
`name_source`. `current` comes from the verified loaded workspace snapshot.
`last_known` comes from a durable registry checkpoint when the workspace was
created, registered, successfully opened or closed, or restored through verified
replay. Closed and unavailable workspaces retain that checkpoint without being
opened, inspected or replayed by listing. `daemon.health` uses the same fields.

Rename is an ordinary workspace transaction; it does not depend on a second registry
commit. Its current loaded name changes immediately. A successful close checkpoints
that name, so rename-close-restart retains it in closed listings. If the process
stops before a successful open/close checkpoint and the workspace is then unavailable,
`last_known` may predate the rename. An external writer can also change a closed
workspace's name. Open the workspace explicitly to replay its verified current name
and refresh the checkpoint; do not infer a current-disk name from `last_known`.

`open` reports whether the workspace is currently loaded; `open_intent` records the
registry's requested open state. A failed configured-open attempt reports its error
while retaining the last-known name. A deliberately closed workspace has no current
archive state (`archived=null`); listing does not probe whether its root is reachable.
An unavailable workspace can be quarantined independently while others are usable.
If registry_requires_restart is true, restart the daemon before non-diagnostic operations.

### `daemon.shutdown`

[Request and result contract](api/daemon.shutdown.md).

Gracefully drains admitted operations and active export cancellation/results. Reconnect by restarting the same daemon configuration; do not delete stored data.

### `workspace.create`

[Request and result contract](api/workspace.create.md).

Creates, registers and opens the workspace. name must be nonblank and <=512 bytes. Saved create intents make exact retries resumable after crashes; never delete its stage to force a fresh request.

### `workspace.register`

[Request and result contract](api/workspace.register.md).

Validates/replays existing data and opens it. To move an existing closed registration, the prior root must no longer exist and the new head must descend from the last closed head. To intentionally select a separate existing copy, unregister the old registration first.

### `workspace.open`

[Request and result contract](api/workspace.open.md).

Registered root must be closed. Replays and verifies data plus ancestry before serving it. Reusing an old successful open receipt does not reopen after a subsequent close.

### `workspace.close`

[Request and result contract](api/workspace.close.md).

Closes and records last known planning/history heads; retains registration and files. Active exports pin the root: wait for completion or cancellation first. Can close a fenced workspace for recovery.

### `workspace.unregister`

[Request and result contract](api/workspace.unregister.md).

Removes only the local registration and releases its lock. Workspace files, portable history and prior registry receipts remain; active export pins prevent unregistering.

### `workspace.receipt`

[Request and result contract](api/workspace.receipt.md).

Requires an open, unfenced workspace. It inspects the saved receipt rather than trying to infer success from current entity state.

### `registry.receipt`

[Request and result contract](api/registry.receipt.md).

Pending means a create/restore intent exists. A registry fence requires daemon restart before this lookup; missing in-memory data is not proof of a failed commit.

### `workspace.export`

[Request and result contract](api/workspace.export.md).

Captures the committed planning revision plus history head and resource bytes, then returns a running job. Writes may continue while export materializes that immutable capture.

### `daemon.export_all`

[Request and result contract](api/daemon.export_all.md).

Captures all registered workspaces together. Complete mode requires each open/available. Partial mode lists unavailable IDs in omitted and creates an incomplete container that daemon.restore_all will reject; each included member is still a complete workspace snapshot.

### `export.get`

[Request and result contract](api/export.get.md).

Poll until completed/failed/canceled/interrupted. Admission receipt is a historical response, not a current job status query.

### `export.list`

[Request and result contract](api/export.list.md).

Page = {items:[complete ExportJob],offset:dec,remaining:dec,next_offset:dec|null}. Byte fitting retains whole jobs, including every capture and head; an oversized first job fails Invalid_argument. Increase max_bytes rather than advancing an unchanged offset. Budget metadata reports complete items omitted by byte fitting and measures the public data/meta envelope. Use the returned snapshot as at_snapshot for offsets>0. Changes to the job listing invalidate the snapshot and require a new first page.

### `export.cancel`

[Request and result contract](api/export.cancel.md).

Only active work before publication can be canceled. Response records cancel_requested; poll to observe terminal status. No destination is published on successful cancellation; private staging may remain.

### `export.retry`

[Request and result contract](api/export.retry.md).

Retries a failed/canceled/interrupted job with the ORIGINAL captured revision/history head, fresh attempt number and stage. Cannot retry an active or completed job; sources must be open and original capture accessible; destination must still be fresh.

### `export.verify`

[Request and result contract](api/export.verify.md).

Checks inventory, hashes, safe paths and captured metadata, not full domain replay. For export-all use each workspaces/ID member here; the outer container is verified by daemon.restore_all. Source data remains untouched. Full replay validation happens during restore/register.

### `workspace.restore`

[Request and result contract](api/workspace.restore.md).

The workspace ID comes from the export; it must not already be registered. Verifies/copies/replays complete portable data, publishes the fresh root and registers it CLOSED. Explicitly workspace.open afterward. Restores workspace receipts, resources and conversation history, not the original machine registry.

### `daemon.restore_all`

[Request and result contract](api/daemon.restore_all.md).

roots must map exactly every member ID. All IDs must be absent locally and parents exist. Across filesystems publication is resumable, not an atomic filesystem-wide rename. Retry the original request after partial progress; already installed owned roots are validated/reused.

### `restore.cancel`

[Request and result contract](api/restore.cancel.md).

Uses a NEW own actor/mutation identity to cancel a pending restore. Allowed only when no target is installed or occupied. Releases reservations without deleting files; original receipt becomes {kind:"canceled"}. If any target was published, complete the original retry instead.

## Export captures, jobs and portable contents

A capture records workspace identity, planning revision/head and history head.
A job records its ID, single-workspace/all-workspaces kind, destination, captures,
explicitly omitted IDs, status, attempt number, cancellation flag and any error.
The status is `running`, `completed`, `failed`, `canceled` or `interrupted`; retain
the actual returned job ID rather than inventing one. Exact shapes are in
[export.get](api/export.get.md).

At most 8 active jobs; one export worker writes them in order. Workspaces remain pinned until
jobs finish. Restart treats a private staging directory as incomplete, never as a published
backup. A matching fully verified destination can establish completed after interruption.
Completed is publication history; verify stored output again before relying on its integrity.

A workspace export contains readable Markdown projections, workspace JSON, audit records,
resource versions, and portable/ with canonical data. An export-all container has manifest.json
and workspaces/ID/ members. Restore requires full current-format snapshots; unknown formats,
partial containers, extra/missing files, unsafe paths, symlinks and bad hashes reject.
Keep exports outside active workspace roots. Registry receipts/export-job metadata are local;
back up the registry separately if you need that machine's administrative history.

## Transfer a portable tree with Git

One writer at a time, including across machines. To transfer:
1. Finish/cancel active exports; workspace.close and wait for success before copy/commit/pull.
2. Use ordinary Git tools to track the portable workspace tree: workspace.json, HEAD.json,
   transactions/, blobs/, the generated .gitignore, and the managed history tree if present.
   Track the workspace's portable contents as a whole, not a manually selected old subset.
   Leave .local/ ignored; keep machine registry/socket/retry files outside the workspace.
3. Hand ownership off explicitly. Clone/pull only while the receiving workspace is closed.
   Register the new copied root, or open its existing registration. Existing registrations
   reject rollback/divergence from the last closed planning/history heads.
4. Inspect recovered context before new work. Do not run independent writers on branches
   and expect a Git merge to reconcile transactions. Local locks cannot fence remote copies.
No Git commands, remote authentication, or distributed history merging run automatically.

## Startup readiness and recovery

Use init/bootstrap with explicit private sibling roots and a matching executable.
Successful readiness means a valid initialize handshake from the intended profile, not
merely an existing socket. The socket-path guard applies across registries and aliases.
Recovery unlinks only its recorded exact socket identity after exclusive ownership and
peer checks; unrecognized, symlinked, replaced, bound and live paths refuse. Never infer
safety from connection refusal or pgrep. If a crash preceded identity recording, choose a
fresh endpoint. Bootstrap reports timeout, child exit and bounded startup log separately.
Timeout is not proof a detached daemon stopped: the temporary supervisor is reaped while
an intended daemon may continue. A tool harness can also kill a spawned child when its
shell ends; distinguish that external lifecycle from product readiness. Preserve logs and
use a foreground terminal or a harness-managed persistent process when diagnosing.
