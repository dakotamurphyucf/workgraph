# Messages, requests, inboxes and acceptance evidence

Read [the CLI and wire contract](cli-contract.md) for request construction and retries.
Return to [the capability guide](../SKILL.md) to choose another workflow.
Each method below links its authoritative generated request/result contract in
[the API reference](api/index.md); open only the methods you need.
The [two-round executable review workflow](gated-review-workflow.md) documents
automatic request resolvers and the public JSON approval message body.

## Terms and workflow

A **message** is a durable direct communication. A **thread** groups discussion
comments under a workspace or project **board**. A **request** adds a designated
resolver and tracks delivery, responsibility and resolution independently. An
**inbox notification** is a routed event; each named **consumer** has its own
acknowledgements. Reading any of these does not acknowledge it.

An evidence **pin** identifies an exact historical version, rather than “latest.”
A **contract** names required artifacts and pins their schema resource. A
**manifest** binds an attempt's named inputs and outputs to pins. A review
**submission generation** freezes one manifest for review. An acceptance **gate**
is a configured condition checked before accepting or completing work. These
records are optional unless a project or ticket policy requires them.

For a question, use the example below. For asynchronous work, read
[Inbox processing](#inbox-processing). For formal acceptance, follow
[Evidence and policy](#evidence-and-policy) and the
[two-round review example](gated-review-workflow.md). The method notes at the end
preserve operation-specific rules; their linked schemas define exact wire shapes.

## Ask a question and record its answer

Set `WG` to the matching executable and `CONTEXT` to the asking actor's context
file. Context files contain the socket, workspace, actor and a private request
journal directory; see [connection setup](cli-contract.md). This example also
uses `RESOLVER_CONTEXT`, the reviewer actor's context, and requires `jq`.

Ask and answer a question with two actor contexts on the same workspace. Both
contexts have private request directories; `RESOLVER_CONTEXT` identifies `reviewer`.
Use a fresh request ID and an existing `task` ticket. `jq` extracts the observed
request revision; successful writes already have exact saved retry files.

```sh
"$WG" --context "$CONTEXT" request ask --request-id clarification-1 \
  --ticket-id task --title 'Choose the output format' \
  --body 'Should the report be JSON or Markdown?' \
  --json-field recipients '[{"kind":"actor","id":"reviewer"}]' \
  --resolver-id reviewer

"$WG" --context "$RESOLVER_CONTEXT" request list --ticket-id task --resolver-id reviewer
REQUEST_REV=$("$WG" --context "$RESOLVER_CONTEXT" request get \
  --request-id clarification-1 | jq -er '.result.data.revision')
"$WG" --context "$RESOLVER_CONTEXT" request resolve --request-id clarification-1 \
  --expected-revision "$REQUEST_REV" --body 'Use JSON so the harness can parse it.'
"$WG" --context "$CONTEXT" request get --request-id clarification-1 --include-messages true
```

Request resolution records the answer and leaves task completion to its owner.
Reading these results acknowledges neither request delivery nor inbox processing.

## Choose a communication record

Use message.send for a durable direct message; it needs no board or thread.
Use `request.ask` to author a question and create an accountable request in one saved
mutation. Always supply `request_id`, nonblank `body`, nonempty `recipients` and
`resolver_id`; optional `kind` defaults to `clarification`. Choose its destination:

- **New discussion:** supply `title`. Workgraph creates a dedicated board and thread.
  Optional `ticket_id` links the ticket and selects its project scope when applicable;
  otherwise the discussion has workspace scope.
- **Existing board, new thread:** also supply `board_id`. The existing board is kept.
  A project board accepts only a ticket from that project; a workspace board can link
  any existing ticket. The author and resolver are the new thread's participants.
- **Existing thread:** supply `thread_id` and its observed `expected_thread_revision`.
  Omit `title`, `ticket_id` and `board_id`: these conflict rather than silently changing
  the existing thread. Its title, participants, links and closure policy remain intact;
  normal thread/request lifecycle rules still apply.

Request delivery recipients are separate from thread participants. A new thread ID
and the question ID are deterministic. Missing destinations, stale thread revisions,
scope conflicts or identity collisions publish none of the question/request changes.
An exact saved retry returns the original receipt, including after a restart.

```sh
# Start a topic on an existing shared board.
"$WG" --context "$CONTEXT" request ask --request-id design-choice \
  --board-id team-board --title "Choose a design" --body "Which approach should we use?" \
  --resolver-id lead --json-field recipients '[{"kind":"actor","id":"lead"}]'

# Ask another question in an existing thread. Use its actual observed revision.
"$WG" --context "$CONTEXT" request ask --request-id design-followup \
  --thread-id existing-thread --expected-thread-revision 3 \
  --body "Should this also cover the retry path?" --resolver-id lead \
  --json-field recipients '[{"kind":"actor","id":"lead"}]'
```

Retain returned request_id/request_revision, board_id, thread_id/thread_revision and
question {comment_id,revision}; use them instead of deriving internal IDs yourself.
Use request.resolve with expected_revision and optional nonblank body to attach an answer
and resolve atomically as the designated resolver. The thread revision is captured inside
that same planning transaction; callers do not perform a separate read/write sequence.
Validation failure publishes neither answer nor resolution; an exact saved retry never
creates a second answer or duplicate notifications. Omitting body keeps plain resolution.
Use a board for workspace/project scope, a thread for persistent conversation,
and a request for explicit accountable work. Requests do not allocate ticket work.
Delivery acknowledgement, accepted responsibility and terminal request resolution
are independent. Question-created threads default to closing when all their requests
become terminal; ordinary threads default to manual closure. Resolution never completes a ticket.
Teams expand at send/request creation. Deduplicated actual recipients and matching
subscription routing are frozen when the event commits; later team/subscription
edits never rewrite past routing. Deadlines are caller-declared timestamps, with
no automatic expiry or transition. The harness owns processing and external sends.

### Wait for one request's answer

`request.ask` returns `request_revision`, not a generic `revision` or `status`.
`request.get` instead returns the current request `revision` and a status object:
test `.result.data.status.kind` for `open`, `resolved` or `cancelled`. A resolved
request's `.result.data.answer` contains the exact pinned comment body and version,
or null when it was resolved without an answer. `include_messages` adds related
conversation; searching those messages is not how to retrieve the resolution.

Use the local CLI helper for a bounded wait. It preserves those `request.get` data
paths and adds `.result.meta.wait.{stop,resolved,poll_count}`:

```sh
if "$WG" --context "$CONTEXT" request wait --request-id design-choice \
     --wait-ms 30000 --poll-interval-ms 1000 > "$AGENT_DIR/answer.json"; then
  jq '.result.data.answer' "$AGENT_DIR/answer.json"
else
  # A read error may leave no success result. Inspect stderr and the saved output.
  cat "$AGENT_DIR/answer.json"
fi
```

This reads immediately, then polls at intervals; it does not ask again or acknowledge
delivery. Total wait is 1000..300000ms; interval is 250..25000ms. `--timeout` caps each
transport by the remaining monotonic deadline. Exit 0 means a complete resolved
observation, including resolution without an answer. `cancelled`, `deadline`, and
`incomplete` stop with exit 1 and the last observation; an open request at timeout is
still open. Read errors stop unchanged. The helper requests a 1MiB budget and refuses
to present a clipped response as a complete answer. A later edit of the answer's
comment does not replace the version pinned by resolution.

`meta.wait` is a local helper extension; raw `request.get` is unchanged. No daemon
worker or persistent watch is created. The caller decides whether to wait again,
read another request or act on the answer. Journal, `--self`, and pagination flags
do not apply to this helper; a context's request directory is unused.

## Capture and provenance

message.send creates an authored discussion comment and pins delivery to its initial
revision. Later discussion edits do not rewrite that delivered body. Request/thread
expansions explicitly expose CURRENT comment versions separately from immutable
request.question and returned answer refs. Request questions and causal notification
bodies pin their original comment revisions; later edits do not rewrite them.
Notifications identify causal_body/body_source. Do not substitute current expanded
related.source_message or related.messages.items for a pinned causal body. Tombstones remain visible in attachment
order with their exact revisions. Preserve author/actor/run attribution and source
references when carrying packets into harness context.
Thread changes route to participants/mentions and active matching subscribers.
Request transitions route to frozen deliveries, creator, designated resolver and
matching subscribers. Notification sequence is the workspace transaction revision;
notification serial is the workspace-local communication cursor. These differ from
entity revisions, discussion activity serials and communication/evidence query revisions.

## Query pages and budgets

Results use result.data; applicable receipt/query/budget metadata is in result.meta.
For communication/evidence lists, read offset zero first. Continue with next_offset
and meta.query_revision as revision, preserving filters. Positive offset requires
that exact current family revision; Conflict means deliberately start a new capture
at zero. An explicitly supplied revision also fences offset zero, including a
larger-budget retry. Lists use typed-ID order unless a method specifies otherwise;
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

## Inbox processing

Choose a stable explicit consumer_id and actor/run recipient. inbox.read is pure unread
enumeration in serial order; inbox.wait adds a bounded wait, with the same filters and
cursors. Reading, waiting and local processing never acknowledge anything.
For an actor recipient from explicit context, use:

```sh
"$WG" --context "$CONTEXT" request inbox.read --self --consumer-id agent-inbox
```

Explicit recipient JSON overrides --self. Request list/acknowledge/accept support the
same actor convenience; see [current-run selectors](cli-contract.md).
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
30 seconds. Repeat bounded waits to cover a longer observation window.

For a restartable callback consumer, use the bundled
[notification watcher](harness-hooks.md#notification-callback). It journals the
packet and exact acknowledgement, uses a stable delivery ID, and documents the
crash window in which the callback must deduplicate its own effects. Reading a
notification and executing its callback are separate from acknowledging delivery.

## Evidence and policy

Structured manifests, formal review/acceptance policies and their proofs are opt-in
for ordinary work. Finishing/completing work still requires evidence text; configured
requirements must be satisfied. Read acceptance.policy.effective when a ticket has
requirements or when preparing completion.

### Compose project and ticket requirements

Project and ticket requirements compose: a disabled local
policy cannot bypass inherited requirements. Exact-source inherited waivers bind project
policy and membership revisions, become visibly stale when either changes, and then
current inherited requirements apply. Weakening requires an attributed nonblank reason.
For required plain criteria, acceptance.assert can bind exact pins and the current claim
without a manifest. If a current attempt or ticket manifest exists, include it; omitting
it cannot bypass output invalidation. Review/validator gates require an exact current
manifest and Accepted submission. Run checks in the harness, retaining the policy digest
observed before the check, then validation.add with expected_policy_digest.
### Retain exact proof bindings

Internal resource/comment/event/contract/decision pins must exist at exact historical
versions; resources must also match their digest. Commit/checksum pins are external
assertions; Workgraph does not fetch them, run validators or authenticate external approvals.
Manifest, contract, policy, project membership, ownership and reopening changes invalidate
old proof bindings. Accepted submissions/validators bind the latest attempt under the claim,
including a later cancelled attempt. input.changed invalidates assertions consuming the old
pin and queues reconciliation for affected manifests. Historical evidence remains queryable.
A required criterion uses its latest current assertion; a later failure supersedes a pass.
### Review the current generation

After target changes, submit a new generation and obtain fresh reviews/validation. Rejection
preserves the rejected generation and routes an actionable request to the submitter.
Approval atomically sends a durable message to the recorded submitter actor and optional
run, binding the exact generation/manifest/contract/review. It preserves submission revision
and does not imply all gates passed. Its tagged body has gate_status:not_evaluated.
Automatic formal review requests designate the submitter as resolver; changes requests
designate the reviewer. Explicitly resolve superseded requests after verification.
### Preserve attribution and ownership

Actor IDs are cooperative attribution, actor catalogs are metadata, and separate_actor
does not authenticate callers. Claim tokens fence stale writers rather than authenticate them.
Live manifest/submission/assertion/reconciliation operations require their recorded attempt
actor/run and current claim/lease. Terminal reconciliation acknowledge/continue may preserve
historical inputs with the recorded attribution; revised inputs require live ownership.
review.gate checks evidence only; completion readiness also checks claims, holds,
dependencies and children. Consult [acceptance policy](planning.md) for detailed composition.

## Method rules

### `board.put`

[Request and result contract](api/board.put.md).

Create at expected_revision="0"; later writes require the current board revision. Scope is immutable.

### `thread.put`

[Request and result contract](api/thread.put.md).

Create at expected_revision="0", then replace thread metadata against its current revision. Board and attached/pinned comment IDs are preserved; omitted participant/mention/link lists clear those lists and omitted pinned becomes false. Reopen a resolved thread before replying.

### `thread.attach`

[Request and result contract](api/thread.attach.md).

Attach an existing comment with the board scope/target. Attachment history is append-only, each comment attaches once, and resolved threads reject attachment.

### `thread.pin_message`

[Request and result contract](api/thread.pin_message.md).

Pin/unpin an already attached comment; this is separate from the board-level thread.pinned flag.

### `thread.reply`

[Request and result contract](api/thread.reply.md).

Atomically author and attach a comment. Optional reply_to_id must be attached here and not tombstoned. Omitted comment_id is generated; empty bodies are permitted. Resolved threads must first reopen.

### `team.put`

[Request and result contract](api/team.put.md).

Replace a deduplicated named recipient set. Only future sends/request creation use its new membership.

### `request.ask`

[Request and result contract](api/request.ask.md).

Atomically author a question and create its accountable request. New topics require title and optionally board_id/ticket_id; an existing thread requires thread_id/expected_thread_revision and rejects those new-topic fields. The result identifies the board, request and actual final thread revision, plus the exact question reference. See the destination choices above.

### `request.create`

[Request and result contract](api/request.create.md).

Create an Open, Unaccepted request from an attached message. Freeze direct recipients plus current team members. reply_to_request_id must be in the same thread. Resolver and delivery set govern subsequent transitions.

### `request.acknowledge`

[Request and result contract](api/request.acknowledge.md).

A matching frozen recipient acknowledges its delivery on an Open request, once. Actor/run attribution must match. Accepting responsibility does not acknowledge delivery.

### `request.accept`

[Request and result contract](api/request.accept.md).

A matching delivery recipient takes an Open, Unaccepted request. Acknowledgement and resolution remain separate.

### `request.reassign`

[Request and result contract](api/request.reassign.md).

The designated resolver changes responsibility on an Open request to a frozen delivery recipient; omitted/null recipient clears it. Existing acknowledgements remain.
This changes responsibility only: `resolver_id` stays unchanged and the new
responsible recipient cannot resolve merely because of reassignment.

### `request.resolve`

[Request and result contract](api/request.resolve.md).

Only the designated resolver terminally resolves an Open request at expected_revision.
Another participant can contribute an answer with thread.reply; that does not
close the request or replace its pinned answer. The designated resolver can then
resolve with body to author the exact durable answer. Optional body is nonblank UTF-8, at most 65536 bytes; it authors and attaches the answer in the same commit. Failure publishes neither part, exact retry duplicates neither. Omit body for plain resolution. Further transitions conflict; linked thread/ticket state is separate.

### `request.cancel`

[Request and result contract](api/request.cancel.md).

Creator or designated resolver terminally cancels an Open request. Delivery/responsibility history remains audit evidence.

### `subscription.put`

[Request and result contract](api/subscription.put.md).

Replace a recipient-owned filter/active setting; attribution must match and recipient is immutable. Empty filter matches all; thread filters require an existing thread. No retroactive delivery.

### `message.send`

[Request and result contract](api/message.send.md).

Author one comment and durably notify frozen direct/team recipients with its initial body. Replies must name an existing message with the same optional ticket. Reusing a stable message_id for a distinct send conflicts; recover uncertainty by exactly retrying the original mutation.

### `inbox.ack`

[Request and result contract](api/inbox.ack.md).

Durably acknowledge selected addressed notification IDs for one consumer/recipient. Independent of request transitions; retain the original request for exact retry.

### `board.get`

[Request and result contract](api/board.get.md).

Fetch current board metadata; missing IDs return Not_found.

### `board.list`

[Request and result contract](api/board.list.md).

List current boards by ID, optionally filtered by exact scope.

### `thread.get`

[Request and result contract](api/thread.get.md).

Fetch current metadata and optionally attached current messages. Use the dual communication/discussion capture and nested message paging described above.

### `thread.list`

[Request and result contract](api/thread.list.md).

List current threads by ID. Actor matches participants/mentions, unresolved excludes resolved, text matches title substrings case-insensitively; filters intersect.

### `thread.history`

[Request and result contract](api/thread.history.md).

Read all revisions of an existing thread in increasing entity revision order.

### `thread.search`

[Request and result contract](api/thread.search.md).

Search with the thread.list filters. Text is optional and searches titles, not discussion bodies.

### `team.get`

[Request and result contract](api/team.get.md).

Fetch current team metadata; missing IDs return Not_found.

### `team.list`

[Request and result contract](api/team.list.md).

List current teams by ID.

### `request.get`

[Request and result contract](api/request.get.md).

Reads current request metadata, pinned question/answer references, current thread_revision and optional related CURRENT messages. Request revision, thread revision, discussion serial and family query revision are distinct. include_messages expansion preserves dual-capture paging; it does not replace original question/answer provenance.

### `request.list`

[Request and result contract](api/request.list.md).

Each list item includes `thread_summary` from the same immutable communication capture: `thread_revision`, `title`, `title_bytes`, `scope`, `links` and `link_count`. These labels and work references require no client joins. `title_bytes` and `link_count` describe the original source even when the response budget returns prefixes; inspect `.result.meta.budget.details` for omitted paths. Ordinary CLI reads expose an exact same-page `meta.pagination.retry_request` when summaries are clipped. Increase its `max_bytes` to expand at the captured communication revision; intervening communication edits produce `Conflict`. `thread.get` reads current state: compare its returned revision with the captured `thread_revision` before treating it as the same source. Request history and mutation receipts retain their own snapshot fields without current thread summaries.

List current requests by ID; filters intersect before pagination and byte fitting. Optional ticket_id matches linked ticket threads and resolver_id selects the designated resolver. Reading/filtering acknowledges no delivery or inbox entry. recipient matches frozen delivery, responsible matches accepted ownership, unanswered means Open with unacknowledged delivery, overdue means an Open deadline strictly before the supplied instant.

### `request.history`

[Request and result contract](api/request.history.md).

Read all revisions of an existing request in increasing entity revision order.

### `subscription.get`

[Request and result contract](api/subscription.get.md).

Fetch a current subscription; missing IDs return Not_found.

### `subscription.list`

[Request and result contract](api/subscription.list.md).

List current subscriptions by ID, including inactive subscriptions.

### `inbox.read`

[Request and result contract](api/inbox.read.md).

Read a bounded unread capture; preserve through/next_after and inspect omissions. Reading is not acknowledgement.

### `inbox.wait`

[Request and result contract](api/inbox.wait.md).

Wait for unread items or timeout with the same capture semantics. No acknowledgement or automatic cursor advancement; disconnect cancels.

### `contract.put`

[Request and result contract](api/contract.put.md).

Publish/update an exact schema-resource pin and required input/output artifact names against the observed contract revision.

### `manifest.publish`

[Request and result contract](api/manifest.publish.md).

Bind exact named input/output pins to an attempt, ticket and contract version under the current claim/lease. Retain the returned manifest revision for downstream proof.

### `review.policy.put`

[Request and result contract](api/review.policy.put.md).

Update review fields of the canonical ticket policy while preserving criteria and inherited override. Weakening needs weakening_reason.

### `acceptance.policy.put`

[Request and result contract](api/acceptance.policy.put.md).

Publish the project/ticket acceptance definition and any exact inherited override against the current policy revision. Weakening needs an attributed reason.

### `acceptance.assert`

[Request and result contract](api/acceptance.assert.md).

Record a pass/fail for an exact current criterion and policy digest under the claim. Include current attempt/manifest when applicable and exact evidence pins.

### `review.submit`

[Request and result contract](api/review.submit.md).

Submit an exact current manifest as a new review generation against the current submission revision; obtain fresh proof for this generation.

### `review.record`

[Request and result contract](api/review.record.md).

Record an attributed approve/request_changes verdict for the exact submission generation. Preserve evidence; rejection retains history and requests action from the submitter.

### `review.accept`

[Request and result contract](api/review.accept.md).

Accept the observed submission only when its current bound policy requirements and proofs are satisfied.

### `validation.add`

[Request and result contract](api/validation.add.md).

Record a harness-produced named check on an exact manifest with the policy digest observed before running it. The daemon executes no check.

### `decision.put`

[Request and result contract](api/decision.put.md).

Publish a versioned decision with pinned rationale/evidence, affected targets and superseded decisions; historical internal pins must resolve exactly.

### `input.changed`

[Request and result contract](api/input.changed.md).

Explicitly record replacement of an exact input pin, invalidating dependent assertions and queuing manifest reconciliation. Contract/decision updates also invalidate exact consumed versions as described by acceptance policy.

### `reconciliation.record`

[Request and result contract](api/reconciliation.record.md).

Record acknowledge, justified continue or revised-manifest disposition against the current reconciliation revision. Terminal historical acknowledge/continue and live revision have different ownership guards.

### `contract.get`

[Request and result contract](api/contract.get.md).

Fetch latest or an explicit historical contract version.

### `contract.list`

[Request and result contract](api/contract.list.md).

List current contracts with evidence-family paging.

### `contract.history`

[Request and result contract](api/contract.history.md).

Read retained contract versions in increasing revision order.

### `manifest.get`

[Request and result contract](api/manifest.get.md).

Fetch latest or an explicit historical manifest version.

### `manifest.list`

[Request and result contract](api/manifest.list.md).

Discover current manifests by optional ticket/attempt filters.

### `manifest.history`

[Request and result contract](api/manifest.history.md).

Read retained manifest versions in increasing revision order.

### `review.policy.get`

[Request and result contract](api/review.policy.get.md).

Fetch the review projection of the canonical ticket policy; inspect effective acceptance policy for inherited requirements.

### `acceptance.policy.get`

[Request and result contract](api/acceptance.policy.get.md).

Fetch the current definition/version for one project or ticket scope.

### `acceptance.policy.effective`

[Request and result contract](api/acceptance.policy.effective.md).

Resolve requirements, source versions, membership/ownership/reopening fences and current digest. Discloses stale overrides; current inherited requirements apply.

### `acceptance.assertions`

[Request and result contract](api/acceptance.assertions.md).

Read immutable assertions in evidence serial order; current reflects target, binding and input freshness.

### `review.submission.get`

[Request and result contract](api/review.submission.get.md).

Fetch the current ticket submission and its bound generation/manifest/policy.

### `review.submission.list`

[Request and result contract](api/review.submission.list.md).

List current submissions, optionally by ticket.

### `review.list`

[Request and result contract](api/review.list.md).

Read review evidence, optionally filtered by ticket/reviewer.

### `validation.list`

[Request and result contract](api/validation.list.md).

Read recorded validator evidence, optionally for an exact manifest.

### `decision.get`

[Request and result contract](api/decision.get.md).

Fetch latest or an explicit historical decision version.

### `decision.list`

[Request and result contract](api/decision.list.md).

List current decisions, optionally by affected target.

### `decision.history`

[Request and result contract](api/decision.history.md).

Read retained decision versions in increasing revision order.

### `reconciliation.list`

[Request and result contract](api/reconciliation.list.md).

Discover pending input-change work by ticket/attempt; include resolved records by disabling pending_only.

### `evidence.context`

[Request and result contract](api/evidence.context.md).

Fetch bounded ticket policy/proof/manifest/submission/decision/reconciliation context. Inspect omission metadata before assuming it is complete.

### `review.gate`

[Request and result contract](api/review.gate.md).

Check the pure evidence completion gate; separately inspect ticket completion readiness for non-evidence blockers.

## Inspect before acknowledging or completing

These reads use the same `CONTEXT` introduced in the question example. Replace
`task` and `thread-1` with existing identities from your own results.

```sh
"$WG" --context "$CONTEXT" request inbox.read --self --consumer-id agent-inbox
"$WG" --context "$CONTEXT" request thread.get --thread-id thread-1 \
  --json-field include_messages true
"$WG" --context "$CONTEXT" request acceptance.policy.effective --ticket-id task
"$WG" --context "$CONTEXT" request review.gate --ticket-id task
```

After processing notifications, acknowledge only IDs returned for that exact
consumer and recipient. Use [inbox.ack](api/inbox.ack.md) with those IDs and save
the mutation. No placeholder notification ID is safe to acknowledge blindly.

## Metadata and amendments

request.metadata changes priority/deadline under the observed request revision. Related
and supersedes links retain explicit lineage without inferring answers or canceling older
requests. Instruction amendments publish immutable attributed text or exact
resource-version pins; resource metadata revisions and content revisions differ.
require_ack creates a current completion/attempt gate, not a new process instruction
channel. The current owner acknowledges the exact amendment version with actor/run/claim
token and valid lease. Inbox delivery acknowledgement is separate from instruction
acknowledgement. Progress and renewal preserve acceptance; a replacement claim needs its
own acknowledgement. Withdraw/supersede explicitly retains history and frozen provenance.
Required amendments cannot be added to already Done work without explicit reopen. Reads
expose current heads and retained versions; preparation and replay enforce completion
gates. No amendment launches, interrupts or proves a process stopped.

### `request.metadata`

[Request and result contract](api/request.metadata.md).

Guarded request priority/deadline patch; omission preserves, documented null clears optional metadata.

### `ticket.amendment.publish`

[Request and result contract](api/ticket.amendment.publish.md).

Publish a guarded immutable instruction version, optional required acknowledgement and explicit superseded refs.

### `ticket.amendment.withdraw`

[Request and result contract](api/ticket.amendment.withdraw.md).

Guarded explicit withdrawal; immutable publication and acknowledgement history remains available.

### `ticket.amendment.acknowledge`

[Request and result contract](api/ticket.amendment.acknowledge.md).

Acknowledge exact current amendment under the live ticket ownership fence; delivery ack is separate.

### `ticket.amendment.get`

[Request and result contract](api/ticket.amendment.get.md).

Read exact amendment identity/version and current head information.

### `ticket.amendment.list`

[Request and result contract](api/ticket.amendment.list.md).

Bounded current amendment heads for selected work.

### `ticket.amendment.history`

[Request and result contract](api/ticket.amendment.history.md).

Bounded immutable publication/withdrawal history.

### `ticket.amendment.acknowledgements`

[Request and result contract](api/ticket.amendment.acknowledgements.md).

Bounded retained acknowledgements with exact instruction and ownership provenance.
