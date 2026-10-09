# Executable workflows and recovery recipes

Read [the shared CLI and wire contract](cli-contract.md) before constructing requests.
Return to [the capability guide](../../AGENT_GUIDE.md) to choose another reference.
Unless a result is explicitly shown as a complete envelope, it describes `result.data`;
receipt, query and capture metadata are in `result.meta`. These are the current preview
contracts, not compatibility guarantees for previously published previews.

```xml
<workgraph_reference name="workflows">
<working_examples>
<example id="new-local-workspace" language="sh" prerequisites="WG is an executable; WG_BASE is a fresh absolute directory chosen by the harness"><![CDATA[
# Only if the harness has not already supplied a running daemon/workspace.
mkdir -p "$WG_BASE"
chmod 700 "$WG_BASE"
mkdir -p "$WG_BASE/requests"
# Terminal 1: leave this process running.
"$WG" serve "$WG_BASE/registry" "$WG_BASE/s"
# Terminal 2: configure the same executable and base, then:
SOCKET="$WG_BASE/s"
WORKSPACE=demo
ACTOR=worker
REQUESTS="$WG_BASE/requests"
"$WG" workspace create "$SOCKET" --actor-id "$ACTOR" --workspace-id "$WORKSPACE" \
  --name Demo --root "$WG_BASE/workspace" \
  --save-request "$REQUESTS/create-workspace.json"
]]></example>
<example id="ticket-lifecycle" language="sh" prerequisites="Open workspace; WG/SOCKET/WORKSPACE/ACTOR/REQUESTS set; jq installed; fresh IDs and request filenames"><![CDATA[
# This simple ticket has no registered attempt or enabled review policy.
"$WG" project create "$SOCKET" --workspace-id "$WORKSPACE" --actor-id "$ACTOR" \
  --project-id demo-project --title 'Deliver the requested change' \
  --save-request "$REQUESTS/create-project.json"
CREATED=$("$WG" ticket create "$SOCKET" --workspace-id "$WORKSPACE" --actor-id "$ACTOR" \
  --project-id demo-project --ticket-id demo-task --title 'Implement and verify' \
  --description 'Record the checks and leave a handoff.' \
  --save-request "$REQUESTS/create-ticket.json")
TICKET=$(printf '%s' "$CREATED" | jq -er '.result.data.id')
TICKET_REV=$(printf '%s' "$CREATED" | jq -er '.result.data.revision')
CLAIM=$("$WG" ticket claim "$SOCKET" --workspace-id "$WORKSPACE" --actor-id "$ACTOR" \
  --ticket-id "$TICKET" --expected-revision "$TICKET_REV" \
  --save-request "$REQUESTS/claim.json")
TOKEN=$(printf '%s' "$CLAIM" | jq -er '.result.data.token')
"$WG" ticket progress "$SOCKET" --workspace-id "$WORKSPACE" --actor-id "$ACTOR" \
  --ticket-id "$TICKET" --token "$TOKEN" --body 'Implementation complete; checks passed.' \
  --save-request "$REQUESTS/progress.json"
CONTEXT=$("$WG" ticket context "$SOCKET" --workspace-id "$WORKSPACE" --ticket-id "$TICKET")
OBSERVED=$(printf '%s' "$CONTEXT" | jq -er '.result.meta.workspace_revision')
"$WG" handoff set "$SOCKET" --workspace-id "$WORKSPACE" --actor-id "$ACTOR" \
  --ticket-id "$TICKET" --token "$TOKEN" --expected-revision 0 \
  --summary 'Implemented and verified the requested change.' \
  --next-steps 'Review the recorded result.' --evidence 'Acceptance checks passed.' \
  --covers-through "$OBSERVED" --save-request "$REQUESTS/handoff.json"
"$WG" ticket complete "$SOCKET" --workspace-id "$WORKSPACE" --actor-id "$ACTOR" \
  --ticket-id "$TICKET" --token "$TOKEN" --evidence 'Acceptance checks passed.' \
  --save-request "$REQUESTS/complete.json"
"$WG" ticket context "$SOCKET" --workspace-id "$WORKSPACE" --ticket-id "$TICKET" --output text
# Only after a lost/uncertain reply, replay the SAME saved write:
"$WG" retry "$SOCKET" "$REQUESTS/complete.json"
]]></example>
<example id="resource-note" language="sh" prerequisites="Same workspace/actor; fresh resource ID and request files; TICKET is an existing ticket"><![CDATA[
"$WG" resource put_text "$SOCKET" --workspace-id "$WORKSPACE" --actor-id "$ACTOR" \
  --resource-id findings --expected-revision 0 --title 'Implementation notes' \
  --json-field text '"Decision: retain the existing interface. Tests passed."' \
  --save-request "$REQUESTS/note.json"
TARGET=$(jq -cn --arg id "$TICKET" '{kind:"ticket",id:$id}')
"$WG" resource link "$SOCKET" --workspace-id "$WORKSPACE" --actor-id "$ACTOR" \
  --resource-id findings --expected-revision 1 --json-field target "$TARGET" \
  --save-request "$REQUESTS/link-note.json"
"$WG" resource get "$SOCKET" --workspace-id "$WORKSPACE" --resource-id findings
# For a long note, replace --json-field text JSON with --field-file text /absolute/file.
]]></example>
<recipe id="multi-agent-work"><![CDATA[
Register one run per invocation, recording the actor and capabilities. Configure allocation
pools/ticket policies and run budgets before selection. ticket.claim_next requires a fresh
attempt ID, the target run field, AND matching envelope run_id. kind:"empty" means nothing
was selected; do not assume a claim or attempt was created. kind:"selected" contains the
claim/token and attempt result; attempt.get supplies its current record/revision.
For explicit selection use ticket.claim first, then attempt.start with the same actor/run/
token. Keep run_id on every claim-protected mutation. Read request/inbox and record progress
and checkpoints while working. If a parent requests cancellation, the harness actually
stops/checks the worker, records an appropriate terminal result, and explicitly cleans up
claims/reservations. Acknowledging a runner action does not execute it.
Ordinary attempts can complete with evidence and no manifest. If configured gates require
one, publish the attempt's contract-bound manifest and satisfy those gates. Replacements
need their own evidence/approval; old approval cannot authorize new outputs.
Failed/cancelled attempts remain as history. Finish an active attempt before
reassigning its claim. A claim release itself cancels active attempts; do not invent a new
mutation identity to bypass an uncertain finish/release. Use exact receipts for recovery.
]]></recipe>
<recipe id="communication-and-review"><![CDATA[
For discussion: board.put(expected_revision0, workspace/project scope), then thread.put
with its required metadata, then thread.reply using the current thread revision. Save the
returned comment_id. Create a typed request referencing that attached comment, frozen
recipients/teams and a resolver. Recipients acknowledge delivery and optionally accept
responsibility. The designated resolver resolves or reassigns; read positions do not do it.
For review: publish a resource describing the artifact contract, contract.put its exact
version/digest, manifest.publish the attempt's named inputs/outputs, review.policy.put the
reviewer/validator requirements, and review.submit the current manifest, omitting
review_request_id if no linked request. Reviewers use review.record, omitting comment_id
if no attached comment. Record required validation.add outcomes. review.accept must bind
that same submission and current inputs. Then complete the attempt/ticket with evidence.
When a consumed input changes, read reconciliation.list/evidence.context and explicitly
record acknowledgement, justified continued use, or a replacement manifest as appropriate.
Acknowledgement alone does not update inputs or approve a new result.
]]></recipe>
<recipe id="history-and-context-reset"><![CDATA[
The harness supplies completed observable events (or explicitly labeled partial events),
stable source IDs, full opaque payload bytes and separately supplied searchable UTF-8 text.
Create a session linked to relevant local entities, then append events using the exact
Session_event_input schema in history.md. Persist the source/cursor and exact pending write before
sending; advance the source cursor only after the durable history receipt. On restart,
retry the unchanged write before ingesting new records. Changed acknowledged source prefixes
must be rejected or handled by an explicit new source/session, not silently rewritten.
Retain a small recovery-index resource with connection/workspace/ticket/session IDs and
important event references; publish it separately after the history commit. Before a context
reset record a normal handoff and keep that index in the remaining context. On resumption,
read ticket.context and the handoff, search the recorded history, expand surrounding events
and complete payload chunks, and follow corrections/superseding decisions. Use event
correlation values to match tool calls/results. Check indexed coverage and fixed history
heads while paging. Choose recovered material deliberately; Workgraph does not assemble
the model prompt or decide what should be forgotten. Preserve this API guide in context.
]]></recipe>
<recipe id="backup-and-restore"><![CDATA[
Start workspace.export with a fresh saved admin request; capture result.job_id. Poll export.get
until status="completed". export.verify the finished single-workspace destination. Restore
into a new root in a registry where that workspace ID is absent; workspace.restore registers
it closed, so open explicitly. When replacing a local copy, close/unregister deliberately
before selecting the restored identity. Keep the old files until the replacement is verified.
For all-workspace backups use daemon.export_all and complete mode unless partial output is
explicitly wanted. daemon.restore_all needs the exact roots mapping for every member and
validates the whole container. Do not apply export.verify to the outer export-all directory;
verify its individual workspaces/ID members there. Never restore a private staging directory.
]]></recipe>
<recipe id="agent-local-contexts"><![CDATA[
Agent-local contexts and recovery

Use a separate context and request directory for each cooperating agent:

"$WG" init --context /absolute/agent/context.json --socket "$SOCKET" \
  --workspace-id "$WORKSPACE" --actor-id "$ACTOR" --root /absolute/workspace \
  --name Demo --request-directory /absolute/agent/requests
"$WG" --context /absolute/agent/context.json ticket create --title "Investigate failure"
"$WG" --context /absolute/agent/context.json ticket ready

The write reports its synced request file on stderr. If its response is lost, retry
that path with `"$WG" --context /absolute/agent/context.json retry ABS_REQUEST_FILE`.
Do not reissue the create command to recover: reissuing chooses a new mutation ID.
Supply ticket IDs explicitly for subsequent work; contexts contain no current ticket.
]]></recipe>
</working_examples>
</workgraph_reference>
```
