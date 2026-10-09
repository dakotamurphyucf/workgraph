# Boards, requests and inboxes

Communication is shared workspace metadata. Discussion bodies retain the existing
versioned comment storage; public comment views use author_id, actor_id and
reply_to_comment_id. Session recording does not publish a comment or
notify collaborators automatically. Actor and run IDs are local attribution,
not authentication identities. A team is an explicit addressable membership list,
not a permission role.

`Communication` is an immutable pure state machine. The planning transaction
dispatcher stages `Communication.Command.t` through `State`. A
successful `prepare` returns an unpublished candidate, typed resolved changes and
a JSON result. Changes and candidate become visible only after the existing disk
commit acknowledgement. Every operation carries the enclosing workspace sequence;
entity revisions and communication event/notification counters are separate.
All operations are bounded by the existing planning transaction storage limits.

## Boards and threads

`board.put` creates a board with expected revision `0`, or revises its title. Its
scope is workspace or one project and remains immutable. `thread.put` creates or
revises metadata: board, title, participants, explicit mentions, entity links,
state (`open`, `awaiting_response`, `resolved`) and pin status. The board remains
immutable. Thread states have no implication for ticket completion or request
acceptance/resolution. A resolved thread can be reopened by `thread.put`.

`thread.attach` appends an existing comment reference and checks the thread
revision. It rejects duplicate attachments and replies to resolved threads.
`thread.pin_message` changes a pin on an attached comment. The root dispatcher can
compose a `thread.reply` as a comment append followed by attachment in the same
planning batch; `Communication.thread_target` supplies its existing Discussion
target. Discussion itself validates body edits, reply parents and complete body
history. `validate_references` checks all comments target the thread board scope
and all linked entities exist against the final candidate.

Thread metadata history preserves every revision. `thread.list` filters board,
scope, state, unresolved state and involved/mentioned actor without reading
message bodies. `thread.search` searches titles; body search remains the existing
Discussion search and can be joined through attached comment references. Metadata
limits: titles 512 bytes, at most 1,000 participants/mentions, 100 links and 100,000
attached comment references per thread. Canonical collections deduplicate IDs;
message order remains publication order.

## Requests

[request.create](api-reference/request.create.md) names a thread and its attached source comment, request kind
(`clarification`, `review`, `help`, `blocker_resolution`, `handoff`), direct
actor/run recipients, optional teams, and one designated actor resolver. Team
members are expanded and deduplicated at creation; later membership edits never
change the stored delivery set. There must be 1..1,000 recipients. Optional
correlation IDs use 1..128 bytes, reply-to requests must be in the same thread,
and deadlines use canonical nonnegative Unix-millisecond decimal strings within
the signed 64-bit range.

[request.acknowledge](api-reference/request.acknowledge.md) changes only the attributed recipient's acknowledgement.
[request.accept](api-reference/request.accept.md) independently accepts responsibility and requires no existing
responsible recipient. Actor recipients require matching actor attribution; run
recipients require matching run attribution. `request.reassign` is restricted to
the resolver and either records the named delivery recipient as responsible or
returns responsibility to unaccepted. Reassignment history remains available.

`request.resolve` is restricted to the designated resolver. `request.cancel` is
restricted to the creator or resolver. Both are terminal: further acknowledgement,
acceptance, reassignment or terminal transitions fail with a typed conflict.
Resolution does not resolve the thread or complete a ticket. Retries use the
existing transaction idempotency keys; stable request IDs, revision guards and
one acknowledgement per recipient prevent duplicate publication even if a caller
omits the original retry key. They do not imply repeated commands return success
without that key.

`request.list` supports recipient, responsible recipient, scope, thread, kind,
open-only, unanswered and overdue filters. `unanswered` means an open request with
at least one unacknowledged delivery. Overdue uses a caller-supplied comparison
instant; no wall clock or scheduler runs inside the domain state machine.

## Subscriptions and durable inboxes

`subscription.put` persists recipient, optional workspace/project scope, optional
thread and notification kinds; an empty kinds list matches all kinds. Subscription
ownership requires matching recipient attribution. Its recipient remains
immutable, while its filter and active status are revision guarded.

Thread changes notify participants/mentions plus matching subscribers. Request
changes notify the frozen request delivery set, creator and designated resolver, plus matching subscribers. Each
notification stores a source reference and revision, workspace sequence, activity
serial, actor/run/timestamp attribution and resolved recipients, without copying
a discussion body. Matching recipients are deduplicated. Events with no recipients
remain valid source notifications but appear in no recipient inbox.

`message.send` creates one authored discussion comment and a direct message,
without requiring a board or thread. Explicit message IDs, correlation IDs and
optional ticket/reply references support durable workflows. Direct actor/run,
team and subscription routes are deduplicated and frozen at commit. Its delivery
body references the exact initial comment revision; later edits do not rewrite it.

`inbox.read` enumerates unread notifications for an explicit `consumer_id` and
actor/run `recipient`, with optional kind and linked-ticket filters. It captures
`through` and returns `next_after` as the last actually returned notification ID,
or the supplied `after` when no item is returned. Reading never consumes IDs.
`inbox.wait` uses the same fields and a bounded timeout, waits outside serialized
transaction dispatch, and preserves filters across polls. Without explicit
`through`, polls capture later activity; an explicit bound remains pinned.

`inbox.ack` acknowledges a selected nonempty list of workspace-local decimal
notification IDs for that exact consumer and recipient. Attribution must match
the recipient, and every selected ID must have been addressed to it. Other
consumers retain unread state. Exact mutation retries recover durable receipts.
Inbox acknowledgement never accepts responsibility or acknowledges/resolves a
formal request.

Lists default to 50 records, at most 100. Offset pages require the observed
communication revision. Query byte budgets default to 64KiB and accept 4KiB..1MiB.
Inbox packets include canonical source references, original and current source
revisions, linked ticket IDs and an explicitly initial/current discussion body.
Budget omissions identify clipped text/items and adjust remaining and next_after
to the IDs actually returned. When remaining is positive but no item fits,
increase max_bytes without advancing after.

## Public contracts

The [generated per-method index](api-reference/index.md) contains the executable
request and result contracts. Start with [board.put](api-reference/board.put.md),
[thread.put](api-reference/thread.put.md), [request.create](api-reference/request.create.md),
[subscription.put](api-reference/subscription.put.md) and
[comment.add](api-reference/comment.add.md). Use [request.get](api-reference/request.get.md)
and [thread.get](api-reference/thread.get.md) for their complete public records.

These contracts use canonical entity IDs, named tagged alternatives and lowercase
enums. Input fields and provenance fields can differ: for example, thread replies
accept `reply_to_id`, while comment views report `reply_to_comment_id`. Use the
method schema rather than its private domain or durable event representation.
Budgeted public query views disclose prose/collection omissions while preserving
identity, revision and source provenance. Durable replay uses separate encodings.

## Persistence and integration

`Communication_event` is a current representation with an explicit version
field. Decode rejects unsupported versions, unknown or duplicate fields, invalid
identifiers and noncanonical or invalid counters. Replay validates consecutive
entity/event/activity revisions, monotonic workspace sequences, immutable
references, request lifecycle transitions and exact recipient deliveries. Unsupported format tags are rejected; no pre-release schema migration is supported.

Integrate these APIs:

- `decode`, `encode`, `mutation_methods`, `query_methods`: typed wire/client routing.
- `prepare`, `candidate`, `changes`, `result`: planning command staging.
- `Change.jsonaf_of_t`, `Change.decode`, `apply`: resolved durable event replay.
- `validate_references`: final-batch validation with Discussion and entity lookup.
- `query`, `to_json`: inspection and portable state output.
- `thread_target`: atomic comment-plus-thread-reply composition.

The focused expect suite in `test/communication` checks separate delivery and
responsibility transitions, team snapshots, filtered notifications, stable inbox
captures, read cursor replay, terminal transitions, run attribution, frozen
codec validation, external comment scope validation and randomized replay
round trips. Real-daemon integration tests exercise durable commit/retry,
export/restore, CLI/client exposure and atomic direct reply composition. See
[validation](validation.md) for the executed suite and platform limits.

## Shared command composition

[thread.reply](api-reference/thread.reply.md) stages one scoped discussion comment
and attachment atomically using the observed thread revision, and returns the
complete updated thread record.
A reply parent must already be attached to that thread. Ticket contexts and project
briefs include bounded linked/scoped thread and request pages. The explicit
thread.search title/metadata query supplements the ordinary discussion search.

Transaction aliases support typed communication creation IDs, including nested
entity links and recipients. `$alias` text in titles or discussion bodies remains
literal prose; aliases are resolved only in declared identifier positions.
