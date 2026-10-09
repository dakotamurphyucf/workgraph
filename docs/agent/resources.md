# Resources and file transfers

Read [the CLI and wire contract](cli-contract.md) for request construction and retries.
Return to [the capability guide](../../AGENT_GUIDE.md) to choose another workflow.
Each daemon method below links its authoritative generated request/result contract in
[the API reference](../api-reference/index.md). The upload/download CLI helpers are
local orchestration, with their own contracts here.

```xml
<workgraph_reference name="resources">
<workflow name="publish-or-reference"><![CDATA[
Use resource.put_text for at most 65536 UTF-8 bytes. Use raw upload staging or the
resource upload CLI helper for larger text or arbitrary binary bytes, up to 64MiB.
Resources are immutable content versions plus editable metadata. Every metadata/content
mutation uses the current RESOURCE METADATA expected_revision; "0" creates a resource.
Metadata edits, links and archive changes increment metadata revision without creating
content versions. Publication increments content-version revision independently and
captures exact bytes/digest/size/filename/MIME/actor/timestamp. For evidence, pin
version.revision and digest, not resource.revision. Keep returned generated resource IDs.
resource.put_text requires title on creation AND update; repeat the current title when
changing only content. Omitted filename/MIME preserve current metadata on update.
Logical filenames are basenames, not filesystem paths. MIME types are type/subtype
without parameters. Consult the generated contract for validation limits.
Archive hides resources from ordinary lists, retains all bytes/versions/links and permits
direct reads/history. Unarchive before publishing new content. Links make metadata visible
in target contexts without loading bytes. Publishing does not itself update a ticket
handoff, discussion request or model prompt; the harness chooses context and side effects.
]]></workflow>
<workflow name="discover-and-read"><![CDATA[
Query metadata first; retrieve only needed immutable versions. resource.get/list/history
are bounded planning queries with meta.workspace_revision and meta.budget. Continue list
or history pages with next_offset and the returned workspace_revision as at_revision,
preserving filters. Positive offset requires at_revision; any supplied at_revision must
match current planning revision. A planning change conflicts: restart the metadata page
traversal. History items are retained content versions, not metadata-edit history.
Inspect truncated/omitted_fields/omitted_items and JSON-pointer budget details before
using metadata as complete. details_complete=false means the omission detail list is
incomplete. Text/target arrays may be shortened; identities and immutable version identity
remain complete. Budget trimming can shorten a page further than its requested limit.
Use resource.read for complete small UTF-8 content; it rejects large/non-UTF-8 bytes with
Invalid_argument and points to resource.read_chunk. Neither byte read accepts max_bytes.
With omitted version, reads select latest at execution. Pin the first returned content
version for every later byte request, independently of metadata revisions/planning changes.
read_chunk offsets count bytes and lengths are 1..262144 bytes. Verify resource/version,
offset, whole digest and size identity, every chunk_digest, and the final assembled SHA-256.
Advance with next_offset until null/EOF; offset=size_bytes returns an empty EOF chunk.
Empty files and arbitrary binary bytes are supported. The CLI downloader does this verification.
]]></workflow>
<workflow name="raw-upload-and-recovery"><![CDATA[
upload.begin/chunk/status/abort use workspace_id, actor_id and stable upload_id. Do not
supply mutation_id/run_id; the strict raw upload decoders reject them. These are private,
actor-owned EPHEMERAL staging operations. Their received offset is contiguous staging
progress, not a durable publication watermark. Only resource.finish_upload is a normal
durable planning mutation with a mutation identity/optional run attribution.
Begin with exact size/digest, send canonical padded Base64 chunks at received, inspect
status to resume, then finish with resource metadata and its observed expected_revision.
A contained previously received range with identical bytes is a safe chunk retry; gaps,
partial overlaps and changed bytes conflict. There is no implicit network retry, upload
listing or upload.finish daemon method. Empty uploads need no chunks.
Finish requires all bytes, verifies size/SHA-256, syncs/installs the blob, then commits the
resource version and durable receipt. It is standalone, outside transaction.apply groups.
A failed revision guard can leave an installed orphan with no resource publication. While
staging is live, a deliberate corrected finish can use revised metadata and a fresh mutation
ID. After publication staging is forgotten, but exact original receipt retry still works.
After lost acknowledgement/restart, retry/check the ORIGINAL finish first: receipt lookup
precedes staging lookup. If no receipt exists, re-stage the original bytes (the same raw
upload ID can begin again) and send that same finish. Restart discards abandoned .part
files under the writer lock. abort frees staging admission but cannot undo publication
or delete installed orphan blobs. Never infer publication from a staging acknowledgement.
Per workspace: eight staged uploads/256MiB reserved declared bytes, 10000 resources,
and 512MiB of distinct blobs referenced by retained content versions. Retained orphan
bytes do not count toward that referenced-byte ceiling; it is not a total disk quota.
]]></workflow>
<workflow name="session-payloads"><![CDATA[
For oversized conversation payloads, publish exact opaque bytes/searchable text, retain
the returned content-version digest and size, then session.append with blob content.
Install before append. Retain a resource_versions reference when the resource-version
relationship matters. For retrieval, pin session history captures and resource versions,
follow byte cursors and verify digests, then carry only chosen records into harness context.
]]></workflow>
<reference href="history.md" purpose="Immutable session captures and blob observation references"/>
<methods>
  <method name="resource.put_text" kind="mutation">
    <contract href="../api-reference/resource.put_text.md"/>
    <behavior>Publish exact small UTF-8 bytes as a new immutable version; title is required on creation and update. Preserve description, targets and archive state. Optional creation resource_id is generated durably; retain it. Omitted filename/MIME default on creation and preserve current metadata on update. Archived publication conflicts.</behavior>
  </method>
  <method name="resource.update" kind="mutation">
    <contract href="../api-reference/resource.update.md"/>
    <behavior>Patch supplied metadata only; even an otherwise empty update advances metadata revision. Older content-version filename/MIME never change.</behavior>
  </method>
  <method name="resource.archive" kind="mutation">
    <contract href="../api-reference/resource.archive.md"/>
    <behavior>Set archive visibility while retaining all versions/links. The shared metadata decoder also accepts its documented metadata patch fields.</behavior>
  </method>
  <method name="resource.link" kind="mutation">
    <contract href="../api-reference/resource.link.md"/>
    <behavior>Link an existing typed target; duplicate links conflict. Contexts expose sorted linked metadata without fetching bytes.</behavior>
  </method>
  <method name="resource.unlink" kind="mutation">
    <contract href="../api-reference/resource.unlink.md"/>
    <behavior>Remove one target link; an absent link conflicts. Resource content is retained.</behavior>
  </method>
  <method name="resource.get" kind="query">
    <contract href="../api-reference/resource.get.md"/>
    <behavior>Fetch current summary metadata; direct reads include archived resources. Inspect budget omissions before treating metadata as complete.</behavior>
  </method>
  <method name="resource.list" kind="query">
    <contract href="../api-reference/resource.list.md"/>
    <behavior>Discover summaries ordered by resource ID with target/archive filters. Continue using planning at_revision and next_offset; inspect budget omissions.</behavior>
  </method>
  <method name="resource.history" kind="query">
    <contract href="../api-reference/resource.history.md"/>
    <behavior>Read retained immutable content versions in increasing version order, including archived resources. Use planning capture paging; metadata-only edits add no versions.</behavior>
  </method>
  <method name="resource.read" kind="query">
    <contract href="../api-reference/resource.read.md"/>
    <behavior>Fetch latest or pinned complete UTF-8 content up to 65536 bytes with verified version, SHA-256 and full size. Unknown resource/version returns Not_found; larger/binary content requires read_chunk.</behavior>
  </method>
  <method name="resource.read_chunk" kind="query">
    <contract href="../api-reference/resource.read_chunk.md"/>
    <behavior>Fetch a verified binary byte range; pin the first selected version and follow next_offset to EOF. Verify identities, every chunk digest and assembled digest.</behavior>
  </method>
  <method name="upload.begin" kind="ephemeral-upload">
    <contract href="../api-reference/upload.begin.md"/>
    <behavior>Begin/resume the same actor/ID/size/digest staging entry. Changed owner/size/digest conflicts; admission exhaustion is Invalid_argument. Empty staging is supported.</behavior>
  </method>
  <method name="upload.chunk" kind="ephemeral-upload">
    <contract href="../api-reference/upload.chunk.md"/>
    <behavior>Stage a contiguous nonempty chunk of at most 256KiB, or exactly retry an identical contained range. Missing/restarted upload is Not_found; chunks after install conflict.</behavior>
  </method>
  <method name="upload.status" kind="ephemeral-upload">
    <contract href="../api-reference/upload.status.md"/>
    <behavior>Observe received/declared size/digest for the live owner. Missing staging after restart/finish/abort is Not_found; different owner conflicts.</behavior>
  </method>
  <method name="upload.abort" kind="ephemeral-upload">
    <contract href="../api-reference/upload.abort.md"/>
    <behavior>Discard live staging and free admission. Absent staging abort is safe; another live owner conflicts. Installed blobs/publications remain.</behavior>
  </method>
  <method name="resource.finish_upload" kind="mutation">
    <contract href="../api-reference/resource.finish_upload.md"/>
    <behavior>Verify/install the actor-owned bytes and durably publish resource metadata/version. Exact retry checks the receipt before live staging, allowing recovery after restart. Incomplete upload conflicts; size/checksum mismatch is Invalid_argument.</behavior>
  </method>
</methods>
<cli_command name="resource upload" helper_method="resource.upload" daemon_method="false">
  <arguments><![CDATA[
"$WG" resource upload "$SOCKET" --workspace-id ID --actor-id ID --resource-id ID
  --expected-revision REV --title TEXT --file ABS_FILE
  [--run-id ID] [--filename BASENAME] [--mime-type TYPE/SUBTYPE]
  (--save-request ABS_NEW_FILE, configured request-directory journaling, or --mutation-id ID)
Use an explicit resource ID. Source must be an absolute regular file, at most 64MiB.
The save-request parent must exist and the file must be fresh. Filename defaults to source
basename; MIME defaults to application/octet-stream. General --timeout SECONDS applies
to each wire operation separately; JSON is default output, --output text is supported.
]]></arguments>
  <behavior><![CDATA[
The helper hashes the source and expands a version-1 upload plan. With request journaling,
it syncs the exact plan before sending. It checks workspace.receipt for the finish identity,
begins/resumes staging, sends chunks of up to 256KiB and invokes resource.finish_upload. The saved plan freezes all metadata/run/mutation
IDs, source absolute path, size and digest. Its result is the durable finish receipt.
Recover with workgraph retry SOCKET SAVED_FILE. Completed retry can succeed after removing
the source because receipt lookup precedes reading it. Incomplete retry verifies unchanged
source bytes, resumes received or re-stages after restart. Changed source conflicts.
No failed network operation retries implicitly. resource.upload is CLI-only: raw daemon
calls fail. Use the helper's saved plan, rather than constructing an upload-plan schema.
]]></behavior>
</cli_command>
<cli_command name="resource download" helper_method="resource.download" daemon_method="false">
  <arguments><![CDATA[
"$WG" resource download "$SOCKET" --workspace-id ID --resource-id ID
  --destination ABS_NEW_FILE [--version CONTENT_VERSION]
No actor/run/mutation ID is accepted. Destination must be fresh and absolute, with an
existing parent. General --timeout SECONDS and --output json|text are local CLI options.
]]></arguments>
  <behavior><![CDATA[
The helper reads 256KiB chunks, pins the first version if omitted, verifies range/size/chunk
and complete SHA-256, syncs a private 0600 file, atomically publishes without replacing any
existing destination and syncs its directory. The result identifies resource/version/digest,
size_bytes and destination. It does not mutate workspace state; resource.download is CLI-only.
Before publication, errors leave no destination; private-file cleanup is best effort and a
killed client may leave an unreferenced .downloading-* file. A directory-sync failure AFTER
publication reports Outcome_unknown with the complete destination retained for inspection.
Do not blindly delete/re-download it. Repeating against an existing destination returns Invalid_argument with its local path,
including when another process creates that destination before publication.
]]></behavior>
</cli_command>
<examples><![CDATA[
Use WG, SOCKET and REQUESTS as in cli-contract.md; demo exists and paths are absolute.
Replace source/destination examples with actual paths and use fresh request/destination files.
Publish small text with an exact saved retry identity, then read its content version:
  "$WG" request "$SOCKET" resource.put_text --workspace-id demo --actor-id worker --resource-id note --expected-revision 0 --title Note --text 'Recorded evidence.' --save-request "$REQUESTS/publish-note.json"
  "$WG" request "$SOCKET" resource.read --workspace-id demo --resource-id note --version 1
For a file, save the helper plan, recover by exact retry and download a pinned version:
  "$WG" resource upload "$SOCKET" --workspace-id demo --actor-id worker --resource-id attachment --expected-revision 0 --title Attachment --file /absolute/hello.bin --save-request "$REQUESTS/upload-attachment.json"
  "$WG" retry "$SOCKET" "$REQUESTS/upload-attachment.json"
  "$WG" resource download "$SOCKET" --workspace-id demo --resource-id attachment --version 1 --destination /absolute/hello-copy.bin
]]></examples>
</workgraph_reference>
```
