# Administration and recovery

In **Overview**, choose **Manage project** (or **Manage workspace** when no project
is selected), then **Maintenance**. Choose **Exports**, **Restore**, **Offline
migration**, or **Journals and recovery** for the task you need.
The daemon connection dialog also offers **Offline tools** before any connection
or actor has been selected. Paths for daemon API operations belong
to the daemon host; offline migration, cleanup and journal paths belong to the
companion host. Actor selection is cooperative attribution, not authentication.

## Deliberate saved actions

Fill a tailored form and choose **Review and prepare action**. This captures the
endpoint generation, effective actor/run, selected workspace/project and exact
parameters once. The resulting preview is read-only. Apply the saved request
explicitly; preparation never executes it. Navigation retains drafts and their
original captures. Copying a frozen action creates a new editable draft using the
current selection, with a new identity.

A browser transport failure does not establish that an admitted write was unsent.
Inspect the saved operation and use its original receipt or explicit exact retry.
Never replace an uncertain mutation with a newly generated identity. The shared
operation controller owns finite read-only observation after a Sending result;
it never retries a write automatically.

## Export and restore

Workspace export captures committed planning, history and resource bytes. Export
all captures the selected daemon's registered workspaces; partial capture is an
explicit option and an incomplete container cannot restore all. Job inspection
shows the original capture vector, omissions, attempt and cancellation request.
A completed admission receipt remains historical; inspect the job for its current
state. Cancellation is a request until the job reaches a terminal state. Retry
preserves the original capture and uses a fresh attempt and stage.

The Exports section separates the job list from **Verify an export**. Open
**Find an export by job ID** to inspect a specific job or review cancellation.
Choosing a completed job’s verification shortcut fills the directory; it does not
run verification automatically.

Export listing follows the daemon's exact continuation, including its snapshot.
If concurrent job changes invalidate it, reset the traversal. Whole jobs and
capture vectors are retained; the short card preview is labeled and the full
response is available. Verification checks inventory, hashes and safe paths. It
does not perform canonical domain replay. For an all-workspace container verify
individual `workspaces/ID` members; restore-all validates the outer container too.

Restore requires a verified current-format export, absent workspace identities and
fresh disjoint target roots. Installed workspaces register **closed**; open them
explicitly. Multi-root publication is resumable and may be partial. A pending
registry receipt describes a durable intent; there is no percentage progress API.
Inspect or retry the original saved operation after interruption. Cancel a pending
restore by naming its original actor/mutation in a separate deliberate cancellation
request. Cancellation only releases reservations when no target was installed or
occupied, and does not delete target files.

## Offline conversion of released 0.6.2 roots

Stop the old daemon and resolve uncertain old requests using the old executable
before conversion. Only the released 0.6.2 workspace representation is supported.
Choose the source and a fresh destination with an existing parent. Preparation
preserves the original paths and captures their canonical execution paths; this
is path provenance, not an immutable source-byte snapshot. The fixed helper
preserves committed source files and verifies a new destination before publication.
No daemon or writer is required for this host tool.

Planning receipts/transactions retain their supported representation, while
history digests change. The complete conversion report includes every old/new
history-head mapping. Machine registry jobs, caches, exports and old API request
envelopes are not migrated. Register a successful destination separately in a
fresh registry.

The companion retains at most 100 local jobs and admits one helper at a time. It
synchronizes preparation and the Running barrier before acknowledgement/invocation.
The browser can detach without stopping an admitted helper. Unsent cancellation
is definite; cancellation after admission is uncertain and never proves rollback.
Cancellation delivery requires a synchronized request. Restart converts Running
to Outcome_unknown; the helper never restarts automatically under its old identity.
Inspect the captured paths before deliberately creating any new plan.

Success includes a bounded typed summary and the private full-report path, SHA256
and byte count. Copy the displayed `cat -- 'path'` command to obtain its complete
JSON on the companion host. There is no arbitrary HTTP file endpoint. A report
publication failure does not negate known conversion success. Startup verifies
report integrity; a missing or changed report retains its expected metadata with
a diagnostic. A post-success provenance/publication uncertainty explicitly says
that conversion was not rolled back.

Cleanup accepts only an unpublished migration stage and its exact owner token.
It checks the ownership marker and allowlisted contents, and never deletes a
published destination or original source. Inspect a failed migration's diagnostic
and supply the stage/token deliberately; no error text is automatically executed.

## Journals

Companion-owned saved operations can be listed and reloaded into the same shared
controller for exact receipt recovery/retry. Reloading is read-only. Metadata
retains original endpoint generation and writer.

External/orphan request files can be inspected on the companion host. Their
metadata is explicitly **unchecked** and transmission **unknown**. Envelope SHA256
and receipt request SHA256 are distinct. Directory reads are bounded,
nonrecursive and may be partial; continue with the returned filename. Duplicate
and conflict groups cover returned entries only. Invalid files retain diagnostics.

The UI never silently adopts or sends an external request. After inspection,
choose an explicit intended daemon socket and copy the shell-quoted
`workgraph retry SOCKET FILE` command. Run it yourself on the companion host using
the matching executable. The file does not authenticate its original endpoint.
Upload plans expose a separate finish identity, require the original source bytes,
and preserve resource publication versus optional ticket-link outcome separately.
