# Messages, requests, inboxes and acceptance evidence

Read [the CLI and wire contract](cli-contract.md) for request construction and retries.
Return to [the capability guide](../../AGENT_GUIDE.md) to choose another workflow.
Each method below links its authoritative generated request/result contract in
[the API reference](../api-reference/index.md); open only the methods you need.
The [two-round executable review workflow](../gated-review-workflow.md) documents
automatic request resolvers and the public JSON approval message body.

```xml
<workgraph_reference name="communication-evidence">
<workflow name="choose-communication"><![CDATA[
Use message.send for a durable direct message; it needs no board or thread.
Use a board for workspace/project scope, a thread for persistent conversation,
and a request for explicit accountable work. Requests do not allocate ticket work.
Delivery acknowledgement, accepted responsibility and terminal request resolution
are independent. Resolving a request neither resolves its thread nor completes a ticket.
Teams expand at send/request creation. Deduplicated actual recipients and matching
subscription routing are frozen when the event commits; later team/subscription
edits never rewrite past routing. Deadlines are caller-declared timestamps, with
no automatic expiry or transition. The harness owns processing and external sends.
]]></workflow>
<workflow name="capture-and-provenance"><![CDATA[
message.send creates an authored discussion comment and pins delivery to its initial
revision. Later discussion edits do not rewrite that delivered body. Request/thread
expansions explicitly expose CURRENT comment versions; request creation retained the
source comment ID but did not retain its original revision/body. Never present these
current bodies as original immutable evidence. Tombstones remain visible in attachment
order with their exact revisions. Preserve author/actor/run attribution and source
references when carrying packets into harness context.
Thread changes route to participants/mentions and active matching subscribers.
Request transitions route to frozen deliveries, creator, designated resolver and
matching subscribers. Notification sequence is the workspace transaction revision;
notification serial is the workspace-local communication cursor. These differ from
entity revisions, discussion activity serials and communication/evidence query revisions.
]]></workflow>
<workflow name="query-pages-and-budgets"><![CDATA[
Results use result.data; applicable receipt/query/budget metadata is in result.meta.
For communication/evidence lists, read offset zero first. Continue with next_offset
and meta.query_revision as revision, preserving filters. Positive offset requires
that exact current family revision; Conflict means restart at zero. At zero, revision
does not fence the read. Lists use typed-ID order unless a method specifies otherwise;
histories increase entity revision, assertions increase evidence serial.
Query budgets default to 65536 bytes and accept 4096..1048576. Inspect meta.budget:
truncated, omitted_fields/items and JSON-pointer details disclose incomplete views;
details_complete=false means the detail list itself is incomplete. Communication
text/arrays may be clipped; evidence policy/proof records stay complete, so fitting
removes whole page items or rejects an unfit direct record/first item. Narrow the query
or increase max_bytes before treating a view as complete. next_offset reflects actual
returned items, not the requested limit. If remaining is positive and the cursor cannot
advance, increase the budget. Unfit required metadata returns Invalid_argument.
With thread.get/request.get include_messages=true, paginate nested messages separately:
carry meta.query_revision as revision and related.discussion_serial as discussion_serial
on positive message_offset. Either changing capture conflicts; restart message_offset
zero. Related-page options without include_messages reject. Budget clipping is additional
to message pagination; inspect omissions and the adjusted nested next_offset.
]]></workflow>
<workflow name="inbox-processing"><![CDATA[
Choose a stable explicit consumer_id and actor/run recipient. inbox.read is pure unread
enumeration in serial order; inbox.wait adds a bounded wait, with the same filters and
cursors. Reading, waiting and local processing never acknowledge anything.
For an actor recipient from explicit context, use:
  "$WG" --context "$CONTEXT" request inbox.read --self --consumer-id agent-inbox
Explicit recipient JSON overrides --self. Request list/acknowledge/accept support the
same actor convenience; current-run selectors are listed in cli-contract.md.
Optional exclude_self defaults false. With an actor recipient it hides notifications
initiated by that actor across all runs; with a run recipient it hides only the exact
attributed run. Absent run attribution remains visible to run recipients. Use
--exclude-self true for the opt-in filter, or explicit Boolean JSON in raw requests.
For a frozen notification traversal, preserve returned through and advance after to
next_after. The notification range stays fixed, while source_current_revision and current
request/thread bodies remain observations at each read. Require 0 <= after <= through
<= latest serial. next_after is the last returned ID, or unchanged after on an empty page.
Retain consumer_id, recipient, exclude_self and the other filters across pages; numeric
cursors do not encode these settings. To disable exclusion and recover earlier hidden
notifications, restart the chosen range at its original after rather than keeping an
advanced filtered cursor. Exclusion runs before pagination/byte fitting; remaining counts
only matching unread rows. The response echoes exclude_self.
Filters never consume excluded notifications. Inspect budget omissions/remaining; if
remaining > 0 and no items fit, increase max_bytes before advancing.
After the harness has safely processed selected IDs, inbox.ack records them for this exact
consumer/recipient. Other consumers remain unread. It does not acknowledge a formal
request's delivery, accept its responsibility or resolve it; use the separate request
transitions when appropriate. Attribution must match the recipient. Save and exactly
retry the original durable mutation after an uncertain acknowledgement.
With omitted through, inbox.wait captures newer activity on each poll; explicit through
stays pinned. Timeout returns an empty capture; disconnect cancels the wait. It runs
outside serialized transaction dispatch and advances no consumer state.
The server cap is 25000 milliseconds (25 seconds); use a longer client timeout, such as
30 seconds. Repeat bounded waits to cover a longer observation window. For example, this
harness loop expects an existing context with a private request_directory and a durable
process_once(notification_id, item) callback. The callback owns external side effects and
must deduplicate by notification ID. Read transport failures back off; acknowledgement
failure stops so the reported saved request can be retried exactly.

import json, subprocess, time
WG = "/absolute/workgraph"
CONTEXT = "/absolute/agent/context.json"
CONSUMER = "agent-inbox"

def receive_loop(process_once, max_waits=12):
    def call(method, *options):
        return subprocess.run(
            [WG, "--context", CONTEXT, "request", method, "--self",
             "--consumer-id", CONSUMER, *options],
            capture_output=True, text=True, timeout=35)
    for _ in range(max_waits):
        reply = call("inbox.wait", "--exclude-self", "true",
                     "--timeout-ms", "25000", "--timeout", "30")
        if reply.returncode != 0:
            diagnostic = (json.loads(reply.stderr.splitlines()[-1]) if reply.stderr
                          else json.loads(reply.stdout)["error"]["data"])
            if diagnostic["kind"] != "Storage_unavailable":
                raise RuntimeError(reply.stderr + reply.stdout)
            time.sleep(1)
            continue
        items = json.loads(reply.stdout)["result"]["data"]["items"]
        for item in items:
            process_once(item["notification_id"], item)
        if items:
            ids = [item["notification_id"] for item in items]
            ack = call("inbox.ack", "--json-field", "notification_ids", json.dumps(ids))
            if ack.returncode != 0:
                raise RuntimeError("Retry the reported saved acknowledgement: " + ack.stderr + ack.stdout)

The loop acknowledges only successfully processed visible IDs. It never acknowledges
excluded rows. Completed acknowledgements prevent the next wait from redelivering those
IDs to this consumer; the callback's durable deduplication handles lost acknowledgements.
]]></workflow>
<workflow name="evidence-and-policy"><![CDATA[
Structured manifests, formal review/acceptance policies and their proofs are opt-in
for ordinary work. Finishing/completing work still requires evidence text; configured
requirements must be satisfied. Read acceptance.policy.effective when a ticket has
requirements or when preparing completion. Project and ticket requirements compose: a disabled local
policy cannot bypass inherited requirements. Exact-source inherited waivers bind project
policy and membership revisions, become visibly stale when either changes, and then
current inherited requirements apply. Weakening requires an attributed nonblank reason.
For required plain criteria, acceptance.assert can bind exact pins and the current claim
without a manifest. If a current attempt or ticket manifest exists, include it; omitting
it cannot bypass output invalidation. Review/validator gates require an exact current
manifest and Accepted submission. Run checks in the harness, retaining the policy digest
observed before the check, then validation.add with expected_policy_digest.
Internal resource/comment/event/contract/decision pins must exist at exact historical
versions; resources must also match their digest. Commit/checksum pins are external
assertions; Workgraph does not fetch them, run validators or authenticate external approvals.
Manifest, contract, policy, project membership, ownership and reopening changes invalidate
old proof bindings. Accepted submissions/validators bind the latest attempt under the claim,
including a later cancelled attempt. input.changed invalidates assertions consuming the old
pin and queues reconciliation for affected manifests. Historical evidence remains queryable.
A required criterion uses its latest current assertion; a later failure supersedes a pass.
After target changes, submit a new generation and obtain fresh reviews/validation. Rejection
preserves the rejected generation and routes an actionable request to the submitter.
Approval atomically sends a durable message to the recorded submitter actor and optional
run, binding the exact generation/manifest/contract/review. It preserves submission revision
and does not imply all gates passed. Its tagged body has gate_status:not_evaluated.
Automatic formal review requests designate the submitter as resolver; changes requests
designate the reviewer. Explicitly resolve superseded requests after verification.
Actor IDs are cooperative attribution, actor catalogs are metadata, and separate_actor
does not authenticate callers. Claim tokens fence stale writers rather than authenticate them.
Live manifest/submission/assertion/reconciliation operations require their recorded attempt
actor/run and current claim/lease. Terminal reconciliation acknowledge/continue may preserve
historical inputs with the recorded attribution; revised inputs require live ownership.
review.gate checks evidence only; completion readiness also checks claims, holds,
dependencies and children. Consult the acceptance-policy reference for detailed composition.
]]></workflow>
<reference href="../acceptance-policy.md" purpose="Policy composition, version-bound waivers and assertion freshness"/>
<methods>
  <method name="board.put" kind="mutation">
    <contract href="../api-reference/board.put.md"/>
    <behavior>Create at expected_revision="0"; later writes require the current board revision. Scope is immutable.</behavior>
  </method>
  <method name="thread.put" kind="mutation">
    <contract href="../api-reference/thread.put.md"/>
    <behavior>Replace thread metadata against its current revision. Board and attached/pinned comment IDs are preserved; omitted participant/mention/link lists clear those lists and omitted pinned becomes false. Reopen a resolved thread before replying.</behavior>
  </method>
  <method name="thread.attach" kind="mutation">
    <contract href="../api-reference/thread.attach.md"/>
    <behavior>Attach an existing comment with the board scope/target. Attachment history is append-only, each comment attaches once, and resolved threads reject attachment.</behavior>
  </method>
  <method name="thread.pin_message" kind="mutation">
    <contract href="../api-reference/thread.pin_message.md"/>
    <behavior>Pin/unpin an already attached comment; this is separate from the board-level thread.pinned flag.</behavior>
  </method>
  <method name="thread.reply" kind="mutation">
    <contract href="../api-reference/thread.reply.md"/>
    <behavior>Atomically author and attach a comment. Optional reply_to_id must be attached here and not tombstoned. Omitted comment_id is generated; empty bodies are permitted. Resolved threads must first reopen.</behavior>
  </method>
  <method name="team.put" kind="mutation">
    <contract href="../api-reference/team.put.md"/>
    <behavior>Replace a deduplicated named recipient set. Only future sends/request creation use its new membership.</behavior>
  </method>
  <method name="request.create" kind="mutation">
    <contract href="../api-reference/request.create.md"/>
    <behavior>Create an Open, Unaccepted request from an attached message. Freeze direct recipients plus current team members. reply_to_request_id must be in the same thread. Resolver and delivery set govern subsequent transitions.</behavior>
  </method>
  <method name="request.acknowledge" kind="mutation">
    <contract href="../api-reference/request.acknowledge.md"/>
    <behavior>A matching frozen recipient acknowledges its delivery on an Open request, once. Actor/run attribution must match. Accepting responsibility does not acknowledge delivery.</behavior>
  </method>
  <method name="request.accept" kind="mutation">
    <contract href="../api-reference/request.accept.md"/>
    <behavior>A matching delivery recipient takes an Open, Unaccepted request. Acknowledgement and resolution remain separate.</behavior>
  </method>
  <method name="request.reassign" kind="mutation">
    <contract href="../api-reference/request.reassign.md"/>
    <behavior>The designated resolver changes responsibility on an Open request to a frozen delivery recipient; omitted/null recipient clears it. Existing acknowledgements remain.</behavior>
  </method>
  <method name="request.resolve" kind="mutation">
    <contract href="../api-reference/request.resolve.md"/>
    <behavior>The designated resolver terminally resolves an Open request. Further transitions conflict; linked thread/ticket state is separate.</behavior>
  </method>
  <method name="request.cancel" kind="mutation">
    <contract href="../api-reference/request.cancel.md"/>
    <behavior>Creator or designated resolver terminally cancels an Open request. Delivery/responsibility history remains audit evidence.</behavior>
  </method>
  <method name="subscription.put" kind="mutation">
    <contract href="../api-reference/subscription.put.md"/>
    <behavior>Replace a recipient-owned filter/active setting; attribution must match and recipient is immutable. Empty filter matches all; thread filters require an existing thread. No retroactive delivery.</behavior>
  </method>
  <method name="message.send" kind="mutation">
    <contract href="../api-reference/message.send.md"/>
    <behavior>Author one comment and durably notify frozen direct/team recipients with its initial body. Replies must name an existing message with the same optional ticket. Reusing a stable message_id for a distinct send conflicts; recover uncertainty by exactly retrying the original mutation.</behavior>
  </method>
  <method name="inbox.ack" kind="mutation">
    <contract href="../api-reference/inbox.ack.md"/>
    <behavior>Durably acknowledge selected addressed notification IDs for one consumer/recipient. Independent of request transitions; retain the original request for exact retry.</behavior>
  </method>
  <method name="board.get" kind="query">
    <contract href="../api-reference/board.get.md"/>
    <behavior>Fetch current board metadata; missing IDs return Not_found.</behavior>
  </method>
  <method name="board.list" kind="query">
    <contract href="../api-reference/board.list.md"/>
    <behavior>List current boards by ID, optionally filtered by exact scope.</behavior>
  </method>
  <method name="thread.get" kind="query">
    <contract href="../api-reference/thread.get.md"/>
    <behavior>Fetch current metadata and optionally attached current messages. Use the dual communication/discussion capture and nested message paging described above.</behavior>
  </method>
  <method name="thread.list" kind="query">
    <contract href="../api-reference/thread.list.md"/>
    <behavior>List current threads by ID. Actor matches participants/mentions, unresolved excludes resolved, text matches title substrings case-insensitively; filters intersect.</behavior>
  </method>
  <method name="thread.history" kind="query">
    <contract href="../api-reference/thread.history.md"/>
    <behavior>Read all revisions of an existing thread in increasing entity revision order.</behavior>
  </method>
  <method name="thread.search" kind="query">
    <contract href="../api-reference/thread.search.md"/>
    <behavior>Search with the thread.list filters. Text is optional and searches titles, not discussion bodies.</behavior>
  </method>
  <method name="team.get" kind="query">
    <contract href="../api-reference/team.get.md"/>
    <behavior>Fetch current team metadata; missing IDs return Not_found.</behavior>
  </method>
  <method name="team.list" kind="query">
    <contract href="../api-reference/team.list.md"/>
    <behavior>List current teams by ID.</behavior>
  </method>
  <method name="request.get" kind="query">
    <contract href="../api-reference/request.get.md"/>
    <behavior>Fetch current request metadata and optional related messages. source_message is explicitly CURRENT; its original source reference has revision:null. Use dual capture paging, never infer an immutable original body.</behavior>
  </method>
  <method name="request.list" kind="query">
    <contract href="../api-reference/request.list.md"/>
    <behavior>List current requests by ID; filters intersect. recipient matches frozen delivery, responsible matches accepted ownership, unanswered means Open with unacknowledged delivery, overdue means an Open deadline strictly before the supplied instant.</behavior>
  </method>
  <method name="request.history" kind="query">
    <contract href="../api-reference/request.history.md"/>
    <behavior>Read all revisions of an existing request in increasing entity revision order.</behavior>
  </method>
  <method name="subscription.get" kind="query">
    <contract href="../api-reference/subscription.get.md"/>
    <behavior>Fetch a current subscription; missing IDs return Not_found.</behavior>
  </method>
  <method name="subscription.list" kind="query">
    <contract href="../api-reference/subscription.list.md"/>
    <behavior>List current subscriptions by ID, including inactive subscriptions.</behavior>
  </method>
  <method name="inbox.read" kind="query">
    <contract href="../api-reference/inbox.read.md"/>
    <behavior>Read a bounded unread capture; preserve through/next_after and inspect omissions. Reading is not acknowledgement.</behavior>
  </method>
  <method name="inbox.wait" kind="query">
    <contract href="../api-reference/inbox.wait.md"/>
    <behavior>Wait for unread items or timeout with the same capture semantics. No acknowledgement or automatic cursor advancement; disconnect cancels.</behavior>
  </method>
  <method name="contract.put" kind="mutation">
    <contract href="../api-reference/contract.put.md"/>
    <behavior>Publish/update an exact schema-resource pin and required input/output artifact names against the observed contract revision.</behavior>
  </method>
  <method name="manifest.publish" kind="mutation">
    <contract href="../api-reference/manifest.publish.md"/>
    <behavior>Bind exact named input/output pins to an attempt, ticket and contract version under the current claim/lease. Retain the returned manifest revision for downstream proof.</behavior>
  </method>
  <method name="review.policy.put" kind="mutation">
    <contract href="../api-reference/review.policy.put.md"/>
    <behavior>Update review fields of the canonical ticket policy while preserving criteria and inherited override. Weakening needs weakening_reason.</behavior>
  </method>
  <method name="acceptance.policy.put" kind="mutation">
    <contract href="../api-reference/acceptance.policy.put.md"/>
    <behavior>Publish the project/ticket acceptance definition and any exact inherited override against the current policy revision. Weakening needs an attributed reason.</behavior>
  </method>
  <method name="acceptance.assert" kind="mutation">
    <contract href="../api-reference/acceptance.assert.md"/>
    <behavior>Record a pass/fail for an exact current criterion and policy digest under the claim. Include current attempt/manifest when applicable and exact evidence pins.</behavior>
  </method>
  <method name="review.submit" kind="mutation">
    <contract href="../api-reference/review.submit.md"/>
    <behavior>Submit an exact current manifest as a new review generation against the current submission revision; obtain fresh proof for this generation.</behavior>
  </method>
  <method name="review.record" kind="mutation">
    <contract href="../api-reference/review.record.md"/>
    <behavior>Record an attributed approve/request_changes verdict for the exact submission generation. Preserve evidence; rejection retains history and requests action from the submitter.</behavior>
  </method>
  <method name="review.accept" kind="mutation">
    <contract href="../api-reference/review.accept.md"/>
    <behavior>Accept the observed submission only when its current bound policy requirements and proofs are satisfied.</behavior>
  </method>
  <method name="validation.add" kind="mutation">
    <contract href="../api-reference/validation.add.md"/>
    <behavior>Record a harness-produced named check on an exact manifest with the policy digest observed before running it. The daemon executes no check.</behavior>
  </method>
  <method name="decision.put" kind="mutation">
    <contract href="../api-reference/decision.put.md"/>
    <behavior>Publish a versioned decision with pinned rationale/evidence, affected targets and superseded decisions; historical internal pins must resolve exactly.</behavior>
  </method>
  <method name="input.changed" kind="mutation">
    <contract href="../api-reference/input.changed.md"/>
    <behavior>Explicitly record replacement of an exact input pin, invalidating dependent assertions and queuing manifest reconciliation. Contract/decision updates also invalidate exact consumed versions as described by acceptance policy.</behavior>
  </method>
  <method name="reconciliation.record" kind="mutation">
    <contract href="../api-reference/reconciliation.record.md"/>
    <behavior>Record acknowledge, justified continue or revised-manifest disposition against the current reconciliation revision. Terminal historical acknowledge/continue and live revision have different ownership guards.</behavior>
  </method>
  <method name="contract.get" kind="query">
    <contract href="../api-reference/contract.get.md"/>
    <behavior>Fetch latest or an explicit historical contract version.</behavior>
  </method>
  <method name="contract.list" kind="query">
    <contract href="../api-reference/contract.list.md"/>
    <behavior>List current contracts with evidence-family paging.</behavior>
  </method>
  <method name="contract.history" kind="query">
    <contract href="../api-reference/contract.history.md"/>
    <behavior>Read retained contract versions in increasing revision order.</behavior>
  </method>
  <method name="manifest.get" kind="query">
    <contract href="../api-reference/manifest.get.md"/>
    <behavior>Fetch latest or an explicit historical manifest version.</behavior>
  </method>
  <method name="manifest.list" kind="query">
    <contract href="../api-reference/manifest.list.md"/>
    <behavior>Discover current manifests by optional ticket/attempt filters.</behavior>
  </method>
  <method name="manifest.history" kind="query">
    <contract href="../api-reference/manifest.history.md"/>
    <behavior>Read retained manifest versions in increasing revision order.</behavior>
  </method>
  <method name="review.policy.get" kind="query">
    <contract href="../api-reference/review.policy.get.md"/>
    <behavior>Fetch the review projection of the canonical ticket policy; inspect effective acceptance policy for inherited requirements.</behavior>
  </method>
  <method name="acceptance.policy.get" kind="query">
    <contract href="../api-reference/acceptance.policy.get.md"/>
    <behavior>Fetch the current definition/version for one project or ticket scope.</behavior>
  </method>
  <method name="acceptance.policy.effective" kind="query">
    <contract href="../api-reference/acceptance.policy.effective.md"/>
    <behavior>Resolve requirements, source versions, membership/ownership/reopening fences and current digest. Discloses stale overrides; current inherited requirements apply.</behavior>
  </method>
  <method name="acceptance.assertions" kind="query">
    <contract href="../api-reference/acceptance.assertions.md"/>
    <behavior>Read immutable assertions in evidence serial order; current reflects target, binding and input freshness.</behavior>
  </method>
  <method name="review.submission.get" kind="query">
    <contract href="../api-reference/review.submission.get.md"/>
    <behavior>Fetch the current ticket submission and its bound generation/manifest/policy.</behavior>
  </method>
  <method name="review.submission.list" kind="query">
    <contract href="../api-reference/review.submission.list.md"/>
    <behavior>List current submissions, optionally by ticket.</behavior>
  </method>
  <method name="review.list" kind="query">
    <contract href="../api-reference/review.list.md"/>
    <behavior>Read review evidence, optionally filtered by ticket/reviewer.</behavior>
  </method>
  <method name="validation.list" kind="query">
    <contract href="../api-reference/validation.list.md"/>
    <behavior>Read recorded validator evidence, optionally for an exact manifest.</behavior>
  </method>
  <method name="decision.get" kind="query">
    <contract href="../api-reference/decision.get.md"/>
    <behavior>Fetch latest or an explicit historical decision version.</behavior>
  </method>
  <method name="decision.list" kind="query">
    <contract href="../api-reference/decision.list.md"/>
    <behavior>List current decisions, optionally by affected target.</behavior>
  </method>
  <method name="decision.history" kind="query">
    <contract href="../api-reference/decision.history.md"/>
    <behavior>Read retained decision versions in increasing revision order.</behavior>
  </method>
  <method name="reconciliation.list" kind="query">
    <contract href="../api-reference/reconciliation.list.md"/>
    <behavior>Discover pending input-change work by ticket/attempt; include resolved records by disabling pending_only.</behavior>
  </method>
  <method name="evidence.context" kind="query">
    <contract href="../api-reference/evidence.context.md"/>
    <behavior>Fetch bounded ticket policy/proof/manifest/submission/decision/reconciliation context. Inspect omission metadata before assuming it is complete.</behavior>
  </method>
  <method name="review.gate" kind="query">
    <contract href="../api-reference/review.gate.md"/>
    <behavior>Check the pure evidence completion gate; separately inspect ticket completion readiness for non-evidence blockers.</behavior>
  </method>
</methods>
<examples><![CDATA[
Shell examples use WG, SOCKET and REQUESTS as in cli-contract.md; workspace demo and
recipient reviewer must exist. Replace fixture IDs with IDs obtained from your reads.
Read before acknowledging; select the actual returned notification IDs after processing:
  "$WG" request "$SOCKET" inbox.read --workspace-id demo --consumer-id review-harness --json-field recipient '{"kind":"actor","id":"reviewer"}'
  "$WG" request "$SOCKET" inbox.ack --workspace-id demo --actor-id reviewer --consumer-id review-harness --json-field recipient '{"kind":"actor","id":"reviewer"}' --json-field notification_ids '["1"]' --save-request "$REQUESTS/ack-1.json"
The ID "1" is illustrative: acknowledge it only if it was returned/addressed to this recipient.
Inspect a thread and its current attached messages:
  "$WG" request "$SOCKET" thread.get --workspace-id demo --thread-id thread --json-field include_messages true
When requirements apply, start with the effective policy rather than inventing pins/digests:
  "$WG" request "$SOCKET" acceptance.policy.effective --workspace-id demo --ticket-id task
  "$WG" request "$SOCKET" review.gate --workspace-id demo --ticket-id task
]]></examples>
</workgraph_reference>
```
