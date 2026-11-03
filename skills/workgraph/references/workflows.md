# Executable workflows and recovery recipes

Read [the shared CLI and wire contract](cli-contract.md) before constructing requests.
Return to [the capability guide](../SKILL.md) to choose another reference.
Unless a result is explicitly shown as a complete envelope, it describes `result.data`;
receipt, query and capture metadata are in `result.meta`. These are the current preview
contracts, not compatibility guarantees for previously published previews.

For a complete two-actor, two-round example with saved retries, immutable output pins,
change requests and durable approval delivery, run the
[gated review workflow](gated-review-workflow.md).
For warning bands, typed admission failures and deliberate export/verify/close before
carrying selected context to a fresh workspace, use the
[capacity rollover recipe](capacity-rollover.md).

## Example prerequisites and connection

A **workspace** stores one shared graph. A **project** groups tickets; a **ticket**
is a unit of work. A **claim** records its current owner and returns a token for
protected writes. A **handoff** preserves observed results and next steps across
agent sessions. The caller (the **harness**) supplies processes, checkouts and
external actions. Workgraph stores their attributed records.

The shell examples require a POSIX-style shell, `jq`, and a matching executable.
Set these variables once in each terminal, replacing the paths with real absolute
paths. Choose a fresh private `WG_BASE`; do not reuse older-preview roots.

```sh
WG=/absolute/path/to/workgraph
WG_BASE=/absolute/private/workgraph-demo
SOCKET="$WG_BASE/s"
WORKSPACE=demo
ACTOR=worker
REQUESTS="$WG_BASE/requests"
```

If the harness already supplied a live daemon and workspace, use its connection
values and skip workspace creation. Otherwise create private parents, then leave
the daemon running in terminal 1:

```sh
mkdir -p "$WG_BASE"
chmod 700 "$WG_BASE"
mkdir -p "$WG_BASE/requests"
"$WG" serve "$WG_BASE/registry" "$SOCKET"
```

In terminal 2, set the same variables above and create the workspace. Stop on any
unexpected nonzero exit; do not continue by inventing IDs or revisions.

```sh
"$WG" workspace create "$SOCKET" --actor-id "$ACTOR" --workspace-id "$WORKSPACE" \
  --name Demo --root "$WG_BASE/workspace" \
  --save-request "$REQUESTS/create-workspace.json"
```

Every new write below uses a new saved-request filename. Those files are private
recovery journals. After an uncertain response, retry its exact file before
issuing a replacement operation.

## Create and claim a simple ticket

This ticket has no registered attempt or enabled review policy. The project and
ticket IDs must be unused. Capture the returned revision and claim token; they
are different counters with different roles.

```sh
"$WG" project create "$SOCKET" --workspace-id "$WORKSPACE" --actor-id "$ACTOR" \
  --project-id demo-project --title 'Deliver the requested change' \
  --save-request "$REQUESTS/create-project.json"
CREATED=$("$WG" ticket create "$SOCKET" --workspace-id "$WORKSPACE" --actor-id "$ACTOR" \
  --project-id demo-project --ticket-id demo-task --title 'Implement and verify' \
  --description 'Record the checks and leave a handoff.' \
  --save-request "$REQUESTS/create-ticket.json")
TICKET=$(printf '%s' "$CREATED" | jq -er '.result.data.ticket_id')
TICKET_REV=$(printf '%s' "$CREATED" | jq -er '.result.data.revision')
CLAIM=$("$WG" ticket claim "$SOCKET" --workspace-id "$WORKSPACE" --actor-id "$ACTOR" \
  --ticket-id "$TICKET" --expected-revision "$TICKET_REV" \
  --save-request "$REQUESTS/claim.json")
TOKEN=$(printf '%s' "$CLAIM" | jq -er '.result.data.token')
```

## Record observed work, hand off and complete

Perform the actual implementation and checks outside Workgraph before these
writes. Replace the sample result/evidence text with the actual commands,
observations and remaining limitations. A saved statement is an attributed report,
not proof that Workgraph executed a check. The handoff is new here, so its
`expected_revision` is zero; editing an existing handoff needs its observed revision.

```sh
"$WG" ticket progress "$SOCKET" --workspace-id "$WORKSPACE" --actor-id "$ACTOR" \
  --ticket-id "$TICKET" --token "$TOKEN" --body 'Implementation complete; checks passed.' \
  --save-request "$REQUESTS/progress.json"
TICKET_CONTEXT=$("$WG" ticket context "$SOCKET" --workspace-id "$WORKSPACE" --ticket-id "$TICKET")
OBSERVED=$(printf '%s' "$TICKET_CONTEXT" | jq -er '.result.meta.workspace_revision')
"$WG" handoff set "$SOCKET" --workspace-id "$WORKSPACE" --actor-id "$ACTOR" \
  --ticket-id "$TICKET" --token "$TOKEN" --expected-revision 0 \
  --summary 'Implemented and verified the requested change.' \
  --next-steps 'Review the recorded result.' --evidence 'Acceptance checks passed.' \
  --covers-through "$OBSERVED" --save-request "$REQUESTS/handoff.json"
"$WG" ticket complete "$SOCKET" --workspace-id "$WORKSPACE" --actor-id "$ACTOR" \
  --ticket-id "$TICKET" --token "$TOKEN" --evidence 'Acceptance checks passed.' \
  --save-request "$REQUESTS/complete.json"
"$WG" ticket context "$SOCKET" --workspace-id "$WORKSPACE" --ticket-id "$TICKET" --output text
```

Only after a lost or uncertain completion response, replay the same saved write:

```sh
"$WG" retry "$SOCKET" "$REQUESTS/complete.json"
```

## Store and link a longer note

A resource stores versioned content separately from ticket progress. Use a fresh
resource ID, create its content, then link it to this example's ticket. Publication
and linking are separate durable mutations; recover each with its own saved file.

```sh
"$WG" resource put_text "$SOCKET" --workspace-id "$WORKSPACE" --actor-id "$ACTOR" \
  --resource-id findings --expected-revision 0 --title 'Implementation notes' \
  --json-field text '"Decision: retain the existing interface. Tests passed."' \
  --save-request "$REQUESTS/note.json"
TARGET=$(jq -cn --arg id "$TICKET" '{kind:"ticket",id:$id}')
"$WG" resource link "$SOCKET" --workspace-id "$WORKSPACE" --actor-id "$ACTOR" \
  --resource-id findings --expected-revision 1 --json-field target "$TARGET" \
  --save-request "$REQUESTS/link-note.json"
"$WG" resource get "$SOCKET" --workspace-id "$WORKSPACE" --resource-id findings
```

For a long note, replace `--json-field text JSON` with
`--field-file text /absolute/file`. Content and resource metadata have different
revision roles; see [resources](resources.md).

## Allocate an attempt to a registered worker

The simple example above needs no run or attempt. Use this sequence when the
harness schedules an invocation and needs allocation, provenance or attempt gates.
See [coordination](coordination.md) for exact selection and ownership semantics.

Register one run per invocation, recording the actor and capabilities. Configure allocation
pools/ticket policies and run budgets before selection. ticket.claim_next requires a fresh
attempt ID, the target run field, AND matching envelope run_id. kind:"empty" means nothing
was selected; standalone empty is nondurable and its exact identity may reevaluate
until selection commits (explicit batches stay durable). Do not infer an attempt.
kind:"selected" contains the
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

## Ask for a decision or obtain formal review

For an accountable question use request.ask with request_id, title, body, recipients,
resolver_id and optional ticket_id/kind. Keep returned request/thread IDs and revisions.
The resolver can request.resolve with the observed request revision and body to attach
an answer and resolve atomically; no separate thread update is needed. See the short
[question/answer example](communication-evidence.md#ask-a-question-and-record-its-answer). Reading or filtering requests never
acknowledges delivery.
For an independently assembled discussion: board.put(expected_revision 0, workspace/project scope), then thread.put
with its required metadata, then thread.reply using the current thread revision. Save the
returned comment_id. Create a typed request referencing that attached comment, frozen
recipients/teams and a resolver. Recipients acknowledge delivery and optionally accept
responsibility. The designated resolver resolves or reassigns; read positions do not do it.
For review, follow the [complete two-round example](gated-review-workflow.md) or
perform the corresponding sequence: publish a resource describing the artifact contract, contract.put its exact
version/digest, manifest.publish the attempt's named inputs/outputs, review.policy.put the
reviewer/validator requirements, and review.submit the current manifest, omitting
review_request_id if no linked request. Reviewers use review.record, omitting comment_id
if no attached comment. Record required validation.add outcomes. review.accept must bind
that same submission and current inputs. Then complete the attempt/ticket with evidence.
When a consumed input changes, read reconciliation.list/evidence.context and explicitly
record acknowledgement, justified continued use, or a replacement manifest as appropriate.
Acknowledgement alone does not update inputs or approve a new result.

## Preserve observable session history across a context reset

The harness supplies completed observable events (or explicitly labeled partial events),
stable source IDs, full opaque payload bytes and separately supplied searchable UTF-8 text.
Create a session linked to relevant local entities, then append events using the exact
event input schema in [history](history.md). Persist the source/cursor and exact pending write before
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

## Export, verify and restore a snapshot

Start workspace.export with a fresh saved admin request; capture `result.data.job_id`. Poll export.get
until status="completed". export.verify the finished single-workspace destination. Restore
into a new root in a registry where that workspace ID is absent; workspace.restore registers
it closed, so open explicitly. When replacing a local copy, close/unregister deliberately
before selecting the restored identity. See
[administration](administration.md) for lifecycle contracts and job status semantics. Keep the old files until the replacement is verified.
For all-workspace backups use daemon.export_all and complete mode unless partial output is
explicitly wanted. daemon.restore_all needs the exact roots mapping for every member and
validates the whole container. Do not apply export.verify to the outer export-all directory;
verify its individual workspaces/ID members there. Never restore a private staging directory.

## Keep per-agent contexts and recover writes

Use a separate context and request directory for each cooperating agent. The
workspace already exists at `/absolute/workspace`; choose matching root/identity
and create the private request directory before setup. `init` reuses that
registered workspace and records defaults; it does not infer a current ticket.

```sh
"$WG" init --context /absolute/agent/context.json --socket "$SOCKET" \
  --workspace-id "$WORKSPACE" --actor-id "$ACTOR" --root /absolute/workspace \
  --name Demo --request-directory /absolute/agent/requests
"$WG" --context /absolute/agent/context.json ticket create --title "Investigate failure"
"$WG" --context /absolute/agent/context.json ticket ready
```

The write reports its synced request file on stderr. If its response is lost, retry
that path with `"$WG" --context /absolute/agent/context.json retry ABS_REQUEST_FILE`.
Do not reissue the create command to recover: reissuing chooses a new mutation ID.
Supply ticket IDs explicitly for subsequent work; contexts contain no current ticket.
