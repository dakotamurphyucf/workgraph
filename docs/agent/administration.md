# Daemon, workspace administration, exports and restore

Read [the shared CLI and wire contract](cli-contract.md) before constructing requests.
Return to [the capability guide](../../AGENT_GUIDE.md) to choose another reference.
Unless a result is explicitly shown as a complete envelope, it describes `result.data`;
receipt, query and capture metadata are in `result.meta`. These are the current preview
contracts, not compatibility guarantees for previously published previews.

```xml
<workgraph_reference name="administration">
<administration_and_portability>
<rules><![CDATA[
Administration A writes use registry-scoped actor_id+mutation_id receipts, not planning M.
Do not add run_id or workspace_id unless the entry lists it. Responses below describe .result.data; A writes report meta.durable=true. Receipt reuse returns
the original response. Open/close/unregister/restore are explicit local lifecycle operations.
Use a separate private registry folder and sibling workspace/export/request folders.
Creation/export/restore roots are absolute UTF-8 paths, NUL-free and at most 64KiB, disjoint and fresh, with existing parents.
Existing aliases/symlink ancestors do not bypass overlap checks. One daemon cannot register
two copies of the same workspace identity. Never edit, rename, replace or pull into an open
managed tree. A closed workspace remains closed across daemon restart until explicitly opened.
]]></rules>
<method name="initialize" envelope="N"><![CDATA[
Required: none.
Optional: none.
Result: {workgraph_api:"0.4",max_frame_bytes:"4194304",name:"workgraph",version:"0.4.0",administrative_receipts:true,workspace_receipts:true,registry_format_version:"3",background_exports:true}.
The CLI constructs the required top-level application API marker; raw socket requests must supply workgraph_api:"0.4". This application profile differs from the package version and independently versioned persisted roots; see docs/compatibility.md in the installed bundle.
]]></method>
<method name="daemon.health" envelope="N"><![CDATA[
Required: none.
Optional: none.
Result: {registry_requires_restart:bool,pending_creates:dec,pending_restores:dec,active_exports:dec,workspaces:[{workspace_id:id,root:text,archived:bool|null,open:bool,open_intent:bool,error:Problem|null}]}.
An unavailable workspace can be quarantined independently while others are usable. If registry_requires_restart is true, restart the daemon before non-diagnostic operations.
]]></method>
<method name="workspace.list" envelope="N"><![CDATA[
Required: none.
Optional: none.
Result: {registry_requires_restart:bool,pending_creates:dec,pending_restores:dec,active_exports:dec,workspaces:[{workspace_id:id,root:text,archived:bool|null,open:bool,open_intent:bool,error:Problem|null}]}.
An unavailable workspace can be quarantined independently while others are usable. If registry_requires_restart is true, restart the daemon before non-diagnostic operations.
]]></method>
<method name="daemon.shutdown" envelope="N"><![CDATA[
Required: none.
Optional: none.
Result: {stopping:true}.
Gracefully drains admitted operations and active export cancellation/results. Reconnect by restarting the same daemon configuration; do not delete stored data.
]]></method>
<method name="workspace.create" envelope="A"><![CDATA[
Required: name:text, root:absolute fresh directory.
Optional: workspace_id:id (generated if absent).
Result: {workspace_id:id}.
Creates, registers and opens the workspace. name must be nonblank and <=512 bytes. Saved create intents make exact retries resumable after crashes; never delete its stage to force a fresh request.
]]></method>
<method name="workspace.register" envelope="A"><![CDATA[
Required: root:absolute existing portable workspace directory.
Optional: none.
Result: {workspace_id:id}.
Validates/replays existing data and opens it. To move an existing closed registration, the prior root must no longer exist and the new head must descend from the last closed head. To intentionally select a separate existing copy, unregister the old registration first.
]]></method>
<method name="workspace.open" envelope="A"><![CDATA[
Required: workspace_id:id.
Optional: none.
Result: {opened:true}.
Registered root must be closed. Replays and verifies data plus ancestry before serving it. Reusing an old successful open receipt does not reopen after a subsequent close.
]]></method>
<method name="workspace.close" envelope="A"><![CDATA[
Required: workspace_id:id.
Optional: none.
Result: {closed:true}.
Closes and records last known planning/history heads; retains registration and files. Active exports pin the root: wait for completion or cancellation first. Can close a fenced workspace for recovery.
]]></method>
<method name="workspace.unregister" envelope="A"><![CDATA[
Required: workspace_id:id.
Optional: none.
Result: {unregistered:true}.
Removes only the local registration and releases its lock. Workspace files, portable history and prior registry receipts remain; active export pins prevent unregistering.
]]></method>
<method name="workspace.receipt" envelope="N"><![CDATA[
Required: workspace_id:id, actor_id:id, mutation_id:id.
Optional: run_id:id.
Result: {status:"absent"} OR {status:"committed",request_hash:digest,response:original {data,meta} planning receipt}.
Requires an open, unfenced workspace. It inspects the saved receipt rather than trying to infer success from current entity state.
]]></method>
<method name="registry.receipt" envelope="N"><![CDATA[
Required: actor_id:id, mutation_id:id.
Optional: none.
Result: {status:"absent"|"pending"} OR {status:"committed",request_hash:digest,response:original {data,meta} admin result}.
Pending means a create/restore intent exists. A registry fence requires daemon restart before this lookup; missing in-memory data is not proof of a failed commit.
]]></method>
<method name="workspace.export" envelope="A"><![CDATA[
Required: workspace_id:id, destination:absolute fresh directory.
Optional: none.
Result: ExportJob.
Captures the committed planning revision plus history head and resource bytes, then returns a running job. Writes may continue while export materializes that immutable capture.
]]></method>
<method name="daemon.export_all" envelope="A"><![CDATA[
Required: destination:absolute fresh directory.
Optional: allow_partial:bool=false.
Result: ExportJob.
Captures all registered workspaces together. Complete mode requires each open/available. Partial mode lists unavailable IDs in omitted and creates an incomplete container that daemon.restore_all will reject; each included member is still a complete workspace snapshot.
]]></method>
<method name="export.get" envelope="N"><![CDATA[
Required: job_id:id.
Optional: none.
Result: ExportJob.
Poll until completed/failed/canceled/interrupted. Admission receipt is a historical response, not a current job status query.
]]></method>
<method name="export.list" envelope="N"><![CDATA[
Required: none.
Optional: offset:dec="0", limit:dec="50" (1..100), max_bytes:dec="65536" (4096..1048576), at_snapshot:digest.
Result: {data:Page<ExportJob>,meta:{snapshot:digest,budget:Budget}} (complete .result object).
Page = {items:[complete ExportJob],offset:dec,remaining:dec,next_offset:dec|null}. Byte fitting retains whole jobs, including every capture and head; an oversized first job fails Invalid_argument. Increase max_bytes rather than advancing an unchanged offset. Budget metadata reports complete items omitted by byte fitting and measures the public data/meta envelope. Use the returned snapshot as at_snapshot for offsets>0. Changes to the job listing invalidate the snapshot and require a new first page.
]]></method>
<method name="export.cancel" envelope="A"><![CDATA[
Required: job_id:id.
Optional: none.
Result: ExportJob.
Only active work before publication can be canceled. Response records cancel_requested; poll to observe terminal status. No destination is published on successful cancellation; private staging may remain.
]]></method>
<method name="export.retry" envelope="A"><![CDATA[
Required: job_id:id.
Optional: none.
Result: ExportJob.
Retries a failed/canceled/interrupted job with the ORIGINAL captured revision/history head, fresh attempt number and stage. Cannot retry an active or completed job; sources must be open and original capture accessible; destination must still be fresh.
]]></method>
<method name="export.verify" envelope="N"><![CDATA[
Required: directory:absolute completed single-workspace export directory.
Optional: none.
Result: {workspace_id:id,revision:dec,head:digest|null,verified:true,canonical_state_validated:false}.
Checks inventory, hashes, safe paths and captured metadata, not full domain replay. For export-all use each workspaces/ID member here; the outer container is verified by daemon.restore_all. Source data remains untouched. Full replay validation happens during restore/register.
]]></method>
<method name="workspace.restore" envelope="A"><![CDATA[
Required: directory:absolute single-workspace export directory, root:absolute fresh destination.
Optional: none.
Result: {kind:"installed",open:false,workspaces:[{root:text,capture:Capture}]}.
The workspace ID comes from the export; it must not already be registered. Verifies/copies/replays complete portable data, publishes the fresh root and registers it CLOSED. Explicitly workspace.open afterward. Restores workspace receipts, resources and conversation history, not the original machine registry.
]]></method>
<method name="daemon.restore_all" envelope="A"><![CDATA[
Required: directory:absolute complete export-all container, roots:{workspace_id:absolute fresh destination,...}.
Optional: none.
Result: {kind:"installed",open:false,workspaces:[{root:text,capture:Capture}]}.
roots must map exactly every member ID. All IDs must be absent locally and parents exist. Across filesystems publication is resumable, not an atomic filesystem-wide rename. Retry the original request after partial progress; already installed owned roots are validated/reused.
]]></method>
<method name="restore.cancel" envelope="A"><![CDATA[
Required: target_actor_id:id, target_mutation_id:id.
Optional: none.
Result: {kind:"canceled"}.
Uses a NEW own actor/mutation identity to cancel a pending restore. Allowed only when no target is installed or occupied. Releases reservations without deleting files; original receipt becomes {kind:"canceled"}. If any target was published, complete the original retry instead.
]]></method>
<export_shapes><![CDATA[
Capture = {workspace_id:id,revision:dec,head:digest|null,history_head:digest|null}.
ExportJob = {job_id:id,kind:"workspace"|"all",destination:absolute path,captures:[Capture],
 omitted:[workspace ID],status:"running"|"completed"|"failed"|"canceled"|"interrupted",
 attempt:dec,cancel_requested:bool,error:text|null}.
At most8 active jobs; one export worker writes them in order. Workspaces remain pinned until
jobs finish. Restart treats a private staging directory as incomplete, never as a published
backup. A matching fully verified destination can establish completed after interruption.
Completed is publication history; verify stored output again before relying on its integrity.

A workspace export contains readable Markdown projections, workspace JSON, audit records,
resource versions, and portable/ with canonical data. An export-all container has manifest.json
and workspaces/ID/ members. Restore requires full current-format snapshots; unknown formats,
partial containers, extra/missing files, unsafe paths, symlinks and bad hashes reject.
Keep exports outside active workspace roots. Registry receipts/export-job metadata are local;
back up the registry separately if you need that machine's administrative history.
]]></export_shapes>
<git_handoff><![CDATA[
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
]]></git_handoff>
</administration_and_portability>
</workgraph_reference>
```
