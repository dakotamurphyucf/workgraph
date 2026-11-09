# Generated API reference

These files come from `workgraph schema`, using the same executable declarations
that validate requests and results. Load one method when needed. For daemon setup,
workflows, retry rules and feature discovery, start with [the Workgraph skill](../../SKILL.md).

A method is one named operation, such as `ticket.create`. Its request parameters
are the input fields you supply. Its result contains `data` (the returned records)
and `meta` (information about durability, revisions and omitted content).
Use [capability and intent discovery](../discovery/index.md) when the method name
is unfamiliar. Begin with the concise input table. Use `workgraph methods --core` for the everyday
tier and `workgraph help METHOD` for a small example and preconditions. CLI helpers
such as `init` are local workflows, separately labelled in the CLI index. See
[common envelopes and types](common.md). Repeated schemas use named local `$defs`
and `$ref` within that same schema block.
Definitions preserve all original fields and validation annotations; no external
file or network lookup is needed. Start at `properties`, then follow needed shapes.
The transport wraps this result in JSON-RPC. `read` has no write effect; `write`
changes state without a durable retry receipt; `mutation` uses a saved retry
identity. Respect each method's more specific contract.

A counter is a nonnegative integer written as a JSON string, such as `"0"` or
`"12"`, without leading zeros. IDs are names, while revisions identify versions of
a record. Read [basic concepts](../concepts.md) for those distinctions.
The `core` tier groups everyday methods; `advanced` groups specialized methods.
Tiers do not grant permissions.

Counters are canonical decimal strings. `x-maxUtf8Bytes`, `x-maximumDecimal` and
other extension annotations describe checks ordinary JSON Schema validators may
ignore. Mapped domain invariants also appear in descriptions; runtime validation
is authoritative. Do not infer permission or operational policy from a schema.

Regenerate with `python3 tools/generate_api_reference.py --binary /absolute/workgraph
--output skills/workgraph/references/api`; add `--check` to detect drift without writing files.

| Method | Tier | Effect | Purpose |
| --- | --- | --- | --- |
| [acceptance.assert](acceptance.assert.md) | advanced | mutation | Record an attributed pass or fail for an exact current acceptance criterion and policy digest. |
| [acceptance.assertions](acceptance.assertions.md) | advanced | read | List recorded acceptance assertions and their exact criterion and evidence references. |
| [acceptance.policy.effective](acceptance.policy.effective.md) | advanced | read | Read the acceptance criteria effective for a ticket after applicable policy inheritance. |
| [acceptance.policy.get](acceptance.policy.get.md) | advanced | read | Read one scope&#x27;s stored acceptance policy and its revision. |
| [acceptance.policy.put](acceptance.policy.put.md) | advanced | mutation | Create or replace guarded acceptance criteria for a project or ticket scope. |
| [activity.digest](activity.digest.md) | core | read | Build a bounded deterministic digest of recorded planning activity with exact source references. |
| [activity.read](activity.read.md) | advanced | read | Traverse captured planning audit changes as bounded canonical JSON chunks. |
| [activity.since](activity.since.md) | advanced | read | Read bounded committed planning activity after a retained sequence. |
| [actor.list](actor.list.md) | advanced | read | List registered actor identities and their catalog metadata. |
| [actor.overview](actor.overview.md) | advanced | read | Read an actor&#x27;s held ownership, requests and selected unread state in one capture. |
| [actor.put](actor.put.md) | advanced | mutation | Create or update guarded actor identity metadata. |
| [allocation.pool_put](allocation.pool_put.md) | advanced | mutation | Create or update a shared allocation pool&#x27;s guarded capacity limits. |
| [allocation.pools](allocation.pools.md) | advanced | read | Read shared allocation pools and their recorded capacity policy. |
| [allocation.ticket_policies](allocation.ticket_policies.md) | advanced | read | Read ticket-specific allocation requirements and their independent policy revisions. |
| [allocation.ticket_policy_put](allocation.ticket_policy_put.md) | advanced | mutation | Install guarded capability, actor and pool requirements for a ticket&#x27;s allocation. |
| [attempt.checkpoint](attempt.checkpoint.md) | advanced | mutation | Append an immutable checkpoint to an owned active attempt. |
| [attempt.finish](attempt.finish.md) | advanced | mutation | Record a guarded terminal outcome for an attempt without implicitly completing its ticket. |
| [attempt.get](attempt.get.md) | core | read | Read one attempt&#x27;s owner, claim binding, checkpoints and current revision. |
| [attempt.list](attempt.list.md) | advanced | read | List attempts under explicit ticket, run and state filters. |
| [attempt.start](attempt.start.md) | advanced | mutation | Start a recorded attempt under an existing valid ticket claim and admitted run. |
| [attention.read](attention.read.md) | advanced | read | Read filtered attention events with exact source references and bounded coverage. |
| [attention.wait](attention.wait.md) | advanced | read | Wait for filtered attention after the captured position without acknowledging sources. |
| [board.get](board.get.md) | advanced | read | Read a discussion board and its current metadata revision. |
| [board.list](board.list.md) | advanced | read | List discussion boards in explicit workspace or project scope. |
| [board.put](board.put.md) | advanced | mutation | Create a discussion board at revision zero or update its guarded metadata. |
| [changes.read](changes.read.md) | advanced | read | Read complete captured commit metadata with exact prefix continuation. |
| [changes.wait](changes.wait.md) | advanced | read | Wait for matching commit metadata while preserving the feed&#x27;s exact cursor and filters. |
| [comment.add](comment.add.md) | advanced | mutation | Add an attributed comment to a supported planning subject. |
| [comment.edit](comment.edit.md) | advanced | mutation | Publish a guarded new text revision of an existing comment. |
| [comment.get](comment.get.md) | advanced | read | Read a comment&#x27;s current retained text and provenance. |
| [comment.history](comment.history.md) | advanced | read | Read a comment&#x27;s retained attributed revisions in order. |
| [comment.list](comment.list.md) | advanced | read | List comments attached to a selected planning subject. |
| [comment.tombstone](comment.tombstone.md) | advanced | mutation | Mark a comment as tombstoned while retaining its revision history. |
| [condition.get](condition.get.md) | advanced | read | Read one external condition&#x27;s definition and revision. |
| [condition.list](condition.list.md) | advanced | read | List declared external conditions under explicit scope filters. |
| [condition.put](condition.put.md) | advanced | mutation | Create or update a guarded external-condition definition. |
| [condition.signal](condition.signal.md) | advanced | mutation | Record an explicit attributed state signal for an external condition. |
| [condition.signals](condition.signals.md) | advanced | read | Read retained attributed signals for an external condition. |
| [contract.get](contract.get.md) | advanced | read | Read an exact or current contract version and its pinned schema requirements. |
| [contract.history](contract.history.md) | advanced | read | Read retained contract versions and their attribution. |
| [contract.list](contract.list.md) | advanced | read | List evidence contracts under explicit filters. |
| [contract.put](contract.put.md) | core | mutation | Publish guarded versioned input and output requirements with exact schema references. |
| [coordinator.overview](coordinator.overview.md) | advanced | read | Read bounded whole coordination rows from one planning, history and heartbeat capture. |
| [daemon.export_all](daemon.export_all.md) | advanced | mutation | Start a captured export of all registered workspaces, reporting any explicitly omitted members. |
| [daemon.health](daemon.health.md) | core | read | Read local daemon health, registry fences and registered workspace availability. |
| [daemon.restore_all](daemon.restore_all.md) | advanced | mutation | Verify and restore every member of a complete export container into fresh mapped roots. |
| [daemon.shutdown](daemon.shutdown.md) | advanced | write | Drain admitted operations and gracefully stop the local daemon. |
| [decision.get](decision.get.md) | advanced | read | Read a retained decision&#x27;s current or exact version and rationale. |
| [decision.history](decision.history.md) | advanced | read | Read retained attributed versions of a decision. |
| [decision.list](decision.list.md) | advanced | read | List recorded decisions matching explicit scope filters. |
| [decision.put](decision.put.md) | advanced | mutation | Publish a guarded versioned decision with its rationale and evidence references. |
| [dependency.add](dependency.add.md) | advanced | mutation | Add a directed prerequisite edge between tickets, rejecting invalid cycles. |
| [dependency.remove](dependency.remove.md) | advanced | mutation | Remove an explicitly selected prerequisite relationship between tickets. |
| [dependency.waive](dependency.waive.md) | advanced | mutation | Record an explicit reason to waive a prerequisite&#x27;s blocking effect without removing its edge. |
| [evidence.context](evidence.context.md) | advanced | read | Read the captured contracts, manifests, checks and policy evidence relevant to work. |
| [export.cancel](export.cancel.md) | advanced | mutation | Request cancellation of an active export before its destination is published. |
| [export.get](export.get.md) | advanced | read | Read an export job&#x27;s current status, captured heads and publication outcome. |
| [export.list](export.list.md) | advanced | read | List complete export-job records under a fixed listing snapshot. |
| [export.retry](export.retry.md) | advanced | mutation | Retry a failed, cancelled or interrupted export using its original immutable capture. |
| [export.verify](export.verify.md) | advanced | read | Verify an exported workspace&#x27;s inventory, hashes, paths and captured metadata. |
| [fact.delete](fact.delete.md) | advanced | mutation | Delete a scoped fact under its revision guard while retaining a tombstone and history. |
| [fact.get](fact.get.md) | core | read | Read one named scoped JSON fact and its current revision. |
| [fact.history](fact.history.md) | advanced | read | Read retained attributed versions and deletion history for a scoped fact. |
| [fact.keys](fact.keys.md) | core | read | Discover scoped fact keys without loading their JSON values. |
| [fact.list](fact.list.md) | advanced | read | List scoped fact values and metadata under explicit filters and byte bounds. |
| [fact.multi_get](fact.multi_get.md) | core | read | Read an explicit collection of scoped fact keys in one capture. |
| [fact.put](fact.put.md) | core | mutation | Write one bounded scoped JSON fact with its required revision guard. |
| [fact.references](fact.references.md) | advanced | read | Find scoped facts with explicitly declared ticket or resource navigation references. |
| [fact.search](fact.search.md) | advanced | read | Search scoped fact keys and retained searchable value text with bounded coverage. |
| [handoff.get](handoff.get.md) | core | read | Read the current structured handoff and its independent revision. |
| [handoff.history](handoff.history.md) | advanced | read | Read retained attributed revisions of a ticket&#x27;s structured handoff. |
| [handoff.set](handoff.set.md) | core | mutation | Publish a structured ownership-guarded handoff with explicit coverage. |
| [history.get](history.get.md) | advanced | read | Read one retained conversation event and its exact source metadata. |
| [history.payload](history.payload.md) | advanced | read | Read a bounded exact payload range from retained conversation history. |
| [history.payloads](history.payloads.md) | advanced | read | Read bounded payload prefixes for many exact events in one capture. |
| [history.read](history.read.md) | advanced | read | Traverse explicitly imported session events under a fixed history capture. |
| [history.search](history.search.md) | advanced | read | Search retained imported conversation events with bounded results and source coverage. |
| [inbox.ack](inbox.ack.md) | core | mutation | Acknowledge only selected delivered inbox entries for an explicit consumer. |
| [inbox.read](inbox.read.md) | core | read | Read bounded recipient notifications with resumable visible-row pagination. |
| [inbox.wait](inbox.wait.md) | core | read | Wait up to 25 seconds for recipient notifications without acknowledging them. |
| [initialize](initialize.md) | core | read | Read live daemon capabilities, protocol version and request limits. |
| [input.changed](input.changed.md) | advanced | mutation | Record that an exact pinned input has been superseded, retaining the changed-input evidence. |
| [label.list](label.list.md) | advanced | read | List reusable ticket labels and their metadata. |
| [label.put](label.put.md) | advanced | mutation | Create or update guarded metadata for a reusable ticket label. |
| [manifest.get](manifest.get.md) | advanced | read | Read a manifest&#x27;s exact named input and output pins at a selected revision. |
| [manifest.history](manifest.history.md) | advanced | read | Read retained manifest revisions and attribution. |
| [manifest.list](manifest.list.md) | advanced | read | List manifests matching explicit ticket, attempt or contract filters. |
| [manifest.publish](manifest.publish.md) | core | mutation | Publish a guarded manifest binding an attempt&#x27;s named inputs and outputs to exact evidence pins. |
| [message.send](message.send.md) | core | mutation | Send an immutable-body informal message with frozen actor, run or team routing. |
| [milestone.archive](milestone.archive.md) | advanced | mutation | Archive a milestone while retaining its recorded work and history. |
| [milestone.create](milestone.create.md) | advanced | mutation | Create a dated project milestone with explicit planning metadata. |
| [milestone.get](milestone.get.md) | advanced | read | Read a milestone&#x27;s metadata, placement and current revision. |
| [milestone.list](milestone.list.md) | advanced | read | List milestones under project and archive filters. |
| [milestone.schedule](milestone.schedule.md) | advanced | mutation | Update a milestone&#x27;s guarded date schedule. |
| [milestone.update](milestone.update.md) | advanced | mutation | Update selected milestone planning fields under its entity revision guard. |
| [participant.list](participant.list.md) | advanced | read | Discover catalog actors and retained attributed participants without inferring liveness. |
| [project.archive](project.archive.md) | advanced | mutation | Archive a project while preserving its planning state and history. |
| [project.brief](project.brief.md) | core | read | Read a bounded captured project summary with tickets and milestones. |
| [project.create](project.create.md) | core | mutation | Create a project for a delivery goal with explicit planning metadata. |
| [project.finish](project.finish.md) | core | mutation | Complete a project after its captured work, ownership and configured gates permit it. |
| [project.get](project.get.md) | core | read | Read a project&#x27;s planning metadata and current entity revision. |
| [project.list](project.list.md) | core | read | List projects matching explicit archive and planning filters. |
| [project.readiness](project.readiness.md) | core | read | Check project completion, ownership and gates without changing work. |
| [project.update](project.update.md) | advanced | mutation | Update selected project planning fields under its entity revision guard. |
| [reconciliation.list](reconciliation.list.md) | advanced | read | List recorded reconciliations for explicitly changed evidence inputs. |
| [reconciliation.record](reconciliation.record.md) | advanced | mutation | Record an attributed reconciliation decision for an explicitly changed pinned input. |
| [recovery.get](recovery.get.md) | advanced | read | Read one immutable named or path ownership-recovery audit record. |
| [recovery.list](recovery.list.md) | advanced | read | List retained ownership-recovery audit records under explicit filters. |
| [registry.receipt](registry.receipt.md) | advanced | read | Read the registry-scoped durable receipt or pending intent for an exact mutation identity. |
| [related.add](related.add.md) | advanced | mutation | Add an informational relationship between tickets without changing readiness. |
| [related.remove](related.remove.md) | advanced | mutation | Remove an informational relationship between tickets. |
| [request.accept](request.accept.md) | advanced | mutation | Record a recipient&#x27;s explicit acceptance of responsibility for a request. |
| [request.acknowledge](request.acknowledge.md) | advanced | mutation | Record explicit delivery acknowledgement for a request recipient. |
| [request.ask](request.ask.md) | core | mutation | Ask an accountable question and create its discussion and request atomically. |
| [request.cancel](request.cancel.md) | advanced | mutation | Cancel an accountable request under its current revision guard. |
| [request.create](request.create.md) | core | mutation | Create an accountable request with explicit recipients and a designated resolver. |
| [request.get](request.get.md) | core | read | Read a request&#x27;s pinned question, exact answer and current thread revision. |
| [request.history](request.history.md) | advanced | read | Read retained attributed request transitions and metadata revisions. |
| [request.list](request.list.md) | core | read | List requests with recipient, ticket and resolver filters; reading acknowledges nothing. |
| [request.metadata](request.metadata.md) | advanced | mutation | Update supported request metadata under its revision guard. |
| [request.reassign](request.reassign.md) | advanced | mutation | Change or clear accepted request responsibility under its current revision guard, preserving its resolver. |
| [request.resolve](request.resolve.md) | core | mutation | Resolve a request as its designated resolver, optionally attaching an exact answer atomically. |
| [reservation.acquire](reservation.acquire.md) | advanced | mutation | Atomically acquire a batch of named shared or exclusive reservations for a registered run. |
| [reservation.contention](reservation.contention.md) | advanced | read | Read actual holders and advisory waiters or expected-release notes without granting ownership. |
| [reservation.get](reservation.get.md) | advanced | read | Read one named reservation&#x27;s retained holders and ownership metadata. |
| [reservation.holder_note.put](reservation.holder_note.put.md) | advanced | mutation | Set or clear an advisory note under the exact current holder fence and note revision. |
| [reservation.list](reservation.list.md) | advanced | read | List retained named reservations and their recorded holders. |
| [reservation.path.get](reservation.path.get.md) | advanced | read | Read a retained logical path reservation and its current ownership metadata. |
| [reservation.path.list](reservation.path.list.md) | advanced | read | List logical file or subtree reservations under explicit worktree and ownership filters. |
| [reservation.path.recover](reservation.path.recover.md) | advanced | mutation | Recover an exact expired logical path hold after the harness stops or isolates its prior execution. |
| [reservation.path.release](reservation.path.release.md) | advanced | mutation | Release an owned logical path reservation using its actual fencing token. |
| [reservation.path.renew](reservation.path.renew.md) | advanced | mutation | Renew an owned timed logical path reservation under its exact lease guards. |
| [reservation.paths.acquire](reservation.paths.acquire.md) | advanced | mutation | Atomically acquire a batch of lexical file or subtree scopes for a registered run. |
| [reservation.recover](reservation.recover.md) | advanced | mutation | Recover an exact expired named hold after the harness stops or isolates its prior execution. |
| [reservation.release](reservation.release.md) | advanced | mutation | Release an owned named reservation using its actual fencing token. |
| [reservation.renew](reservation.renew.md) | advanced | mutation | Renew an owned timed named reservation under its exact lease guards. |
| [reservation.waiter.put](reservation.waiter.put.md) | advanced | mutation | Begin, refresh or close an advisory waiter record with its own revision and bounded lifetime. |
| [resource.archive](resource.archive.md) | advanced | mutation | Archive resource metadata while preserving immutable content and retained history. |
| [resource.brief](resource.brief.md) | advanced | read | Read a bounded resource summary with exact expansion references and omission counts. |
| [resource.finish_upload](resource.finish_upload.md) | advanced | mutation | Publish verified staged bytes as an immutable resource version under its metadata guard. |
| [resource.get](resource.get.md) | core | read | Read resource metadata, links and immutable content-version descriptors. |
| [resource.history](resource.history.md) | advanced | read | Read retained immutable resource content-version descriptors. |
| [resource.link](resource.link.md) | advanced | mutation | Attach an existing resource to a supported planning entity under guarded metadata. |
| [resource.list](resource.list.md) | core | read | List resource metadata under explicit scope, link and archive filters. |
| [resource.put_text](resource.put_text.md) | core | mutation | Publish immutable UTF-8 content with required creation title and retained metadata. |
| [resource.read](resource.read.md) | core | read | Read complete UTF-8 content up to 65536 bytes from an immutable resource version. |
| [resource.read_chunk](resource.read_chunk.md) | advanced | read | Read a verified binary byte range by resource ID and immutable version. |
| [resource.read_text](resource.read_text.md) | advanced | read | Read a bounded UTF-8 text range with byte-correct continuation and immutable version or digest. |
| [resource.unlink](resource.unlink.md) | advanced | mutation | Remove a resource&#x27;s planning-entity attachment while preserving its content. |
| [resource.update](resource.update.md) | advanced | mutation | Update guarded resource metadata without publishing replacement content bytes. |
| [restore.cancel](restore.cancel.md) | advanced | mutation | Cancel a pending restore only before any target is installed or occupied. |
| [review.accept](review.accept.md) | core | mutation | Accept the current submission only after its configured review and validation gates pass. |
| [review.gate](review.gate.md) | core | read | Inspect current submission requirements, reviewer decisions and outstanding gate reasons. |
| [review.list](review.list.md) | advanced | read | List immutable reviewer verdicts with exact submission and evidence references. |
| [review.policy.get](review.policy.get.md) | advanced | read | Read the review projection of a ticket&#x27;s canonical acceptance policy and its revision. |
| [review.policy.put](review.policy.put.md) | advanced | mutation | Update guarded ticket-review requirements while preserving criteria and inherited-policy overrides. |
| [review.record](review.record.md) | core | mutation | Record an immutable reviewer verdict for an exact submitted generation. |
| [review.submission.get](review.submission.get.md) | advanced | read | Read a ticket&#x27;s current submission generation and frozen manifest and policy binding. |
| [review.submission.list](review.submission.list.md) | advanced | read | List current review submissions under explicit ticket filters. |
| [review.submit](review.submit.md) | core | mutation | Bind submitted outputs to an exact manifest and active attempt in a new review generation. |
| [run.action_acknowledge](run.action_acknowledge.md) | advanced | mutation | Acknowledge a selected recorded run-budget action under its exact guard. |
| [run.actions](run.actions.md) | advanced | read | Read recorded budget actions associated with a run. |
| [run.budget_attention](run.budget_attention.md) | advanced | read | Read run-budget attention and the reasons a recorded budget requires action. |
| [run.budget_get](run.budget_get.md) | advanced | read | Read one run&#x27;s declared budget policy and independent revision. |
| [run.budget_put](run.budget_put.md) | advanced | mutation | Create or update guarded run-budget limits for admitted work and reported consumption. |
| [run.get](run.get.md) | core | read | Read one run&#x27;s immutable identity, reported lifecycle and entity revision. |
| [run.heartbeat](run.heartbeat.md) | advanced | write | Record advisory liveness without renewing ownership or requiring a mutation ID. |
| [run.heartbeat_get](run.heartbeat_get.md) | advanced | read | Read the current and last persisted advisory heartbeat observation. |
| [run.link_session](run.link_session.md) | advanced | mutation | Associate an existing imported conversation session with a registered run. |
| [run.list](run.list.md) | advanced | read | List registered invocations under explicit actor and lifecycle filters. |
| [run.observe](run.observe.md) | core | mutation | Durably record a guarded run observation and caller-reported progress metadata. |
| [run.register](run.register.md) | core | mutation | Register an attributed invocation with objective, capabilities and an independent run revision. |
| [run.sessions](run.sessions.md) | advanced | read | List a run&#x27;s explicit and automatically attributed conversation sessions. |
| [run.transition](run.transition.md) | advanced | mutation | Record a guarded run lifecycle transition without controlling its external process. |
| [search.query](search.query.md) | core | read | Search captured planning entities and content with bounded results and coverage metadata. |
| [session.append](session.append.md) | advanced | mutation | Append a validated batch of explicit conversation or tool events to a session. |
| [session.archive](session.archive.md) | advanced | mutation | Archive a conversation session while preserving retained events and payloads. |
| [session.create](session.create.md) | advanced | mutation | Create a durable container for explicitly imported conversation and tool events. |
| [session.get](session.get.md) | advanced | read | Read a session&#x27;s metadata and retained history head. |
| [session.list](session.list.md) | advanced | read | List explicitly created history sessions under supported filters. |
| [status.list](status.list.md) | advanced | read | List the workspace&#x27;s named ticket statuses and lifecycle categories. |
| [status.put](status.put.md) | advanced | mutation | Create or update guarded ticket-status metadata and its lifecycle category. |
| [subscription.get](subscription.get.md) | advanced | read | Read one notification subscription and its current revision. |
| [subscription.list](subscription.list.md) | advanced | read | List retained notification subscriptions under explicit filters. |
| [subscription.put](subscription.put.md) | advanced | mutation | Create or update guarded notification routing preferences. |
| [team.get](team.get.md) | advanced | read | Read a team and its explicitly recorded actor members. |
| [team.list](team.list.md) | advanced | read | List named actor teams and their routing metadata. |
| [team.put](team.put.md) | advanced | mutation | Create or update guarded team metadata and explicit actor membership. |
| [template.get](template.get.md) | advanced | read | Read a complete registered template at its exact pinned content version. |
| [template.instance_get](template.instance_get.md) | advanced | read | Read an immutable template instance and its generated ticket plan. |
| [template.instance_list](template.instance_list.md) | advanced | read | List immutable template instances in stable instance-ID order. |
| [template.instance_register](template.instance_register.md) | advanced | mutation | Validate and register a deterministic template instance against an already existing graph. |
| [template.instantiate](template.instantiate.md) | advanced | mutation | Expand a pinned canonical template into tickets, dependencies and declared policies atomically. |
| [template.list](template.list.md) | advanced | read | List registered immutable template versions. |
| [template.register](template.register.md) | advanced | mutation | Register a canonical graph specification pinned to matching published resource bytes and digest. |
| [thread.attach](thread.attach.md) | advanced | mutation | Attach an existing comment to a guarded discussion thread in its board scope. |
| [thread.get](thread.get.md) | advanced | read | Read a thread&#x27;s metadata, references and optional bounded current messages. |
| [thread.history](thread.history.md) | advanced | read | Read retained attributed thread metadata revisions. |
| [thread.list](thread.list.md) | advanced | read | List threads under explicit board and planning-scope filters. |
| [thread.pin_message](thread.pin_message.md) | advanced | mutation | Pin or unpin an already attached comment in a guarded discussion thread. |
| [thread.put](thread.put.md) | advanced | mutation | Create a discussion thread at revision zero or update its guarded metadata. |
| [thread.reply](thread.reply.md) | advanced | mutation | Publish an attributed reply into a guarded discussion thread. |
| [thread.search](thread.search.md) | advanced | read | Search discussion thread titles with bounded results and explicit scope filters. |
| [ticket.amendment.acknowledge](ticket.amendment.acknowledge.md) | advanced | mutation | Acknowledge an exact instruction-amendment revision under the current ticket claim. |
| [ticket.amendment.acknowledgements](ticket.amendment.acknowledgements.md) | advanced | read | List exact amendment acknowledgements and their claim bindings. |
| [ticket.amendment.get](ticket.amendment.get.md) | advanced | read | Read an exact immutable instruction amendment with its current withdrawal state. |
| [ticket.amendment.history](ticket.amendment.history.md) | advanced | read | Read retained immutable revisions and lifecycle history of an instruction amendment. |
| [ticket.amendment.list](ticket.amendment.list.md) | advanced | read | List captured ticket instruction amendments with whole-record pagination. |
| [ticket.amendment.publish](ticket.amendment.publish.md) | advanced | mutation | Publish an attributed immutable revision of changed ticket instructions. |
| [ticket.amendment.withdraw](ticket.amendment.withdraw.md) | advanced | mutation | Explicitly withdraw an instruction amendment under its exact revision guard. |
| [ticket.archive](ticket.archive.md) | advanced | mutation | Archive an eligible ticket while retaining its planning record and history. |
| [ticket.blockers](ticket.blockers.md) | core | read | Read captured reasons currently blocking a ticket&#x27;s readiness or completion. |
| [ticket.brief](ticket.brief.md) | advanced | read | Read a bounded ticket summary with exact expansion references and omission counts. |
| [ticket.claim](ticket.claim.md) | advanced | mutation | Acquire logical ticket ownership and its fencing token without starting an attempt. |
| [ticket.claim_next](ticket.claim_next.md) | core | mutation | Atomically select and claim eligible work; a standalone empty observation writes nothing. |
| [ticket.complete](ticket.complete.md) | advanced | mutation | Complete claimed work with nonempty evidence, finishing active attempts and clearing ownership. |
| [ticket.context](ticket.context.md) | core | read | Read captured ticket instructions, ownership, links, handoff and related context. |
| [ticket.create](ticket.create.md) | core | mutation | Create a ticket with explicit instructions, placement and planning metadata. |
| [ticket.finish](ticket.finish.md) | core | mutation | Record completion evidence and finish an active attempt atomically. |
| [ticket.hierarchy.get](ticket.hierarchy.get.md) | advanced | read | Read stored hierarchy policy and the effective flat-plan defaults. |
| [ticket.hierarchy.put](ticket.hierarchy.put.md) | advanced | mutation | Create or update guarded parent-child planning policy. |
| [ticket.hold](ticket.hold.md) | advanced | mutation | Set a ticket hold reason or lift the hold with JSON null. |
| [ticket.list](ticket.list.md) | core | read | List tickets under explicit project, status, assignment and other planning filters. |
| [ticket.metadata](ticket.metadata.md) | core | mutation | Update guarded priority, assignee, labels, acceptance criteria or status. |
| [ticket.move](ticket.move.md) | advanced | mutation | Move a ticket between supported project, milestone or parent placements under guards. |
| [ticket.paths.get](ticket.paths.get.md) | advanced | read | Read a ticket&#x27;s declared required logical path-ownership policy. |
| [ticket.paths.list](ticket.paths.list.md) | advanced | read | List declared ticket path requirements under explicit filters. |
| [ticket.paths.put](ticket.paths.put.md) | advanced | mutation | Install guarded required logical file or subtree ownership for a ticket. |
| [ticket.progress](ticket.progress.md) | core | mutation | Append an attributed progress comment under current ticket ownership. |
| [ticket.read](ticket.read.md) | advanced | read | Read complete instructions, acceptance criteria and ownership without related histories. |
| [ticket.readiness](ticket.readiness.md) | core | read | Explain graph readiness and optional candidate or registered-run admission checks. |
| [ticket.ready](ticket.ready.md) | core | read | List graph-ready work or candidate/run-admissible tickets under explicit selectors. |
| [ticket.reassign](ticket.reassign.md) | advanced | mutation | Transfer or release an existing ticket claim with a fresh ownership fence and explicit reason. |
| [ticket.recover](ticket.recover.md) | advanced | mutation | Recover an exact expired claim with explicit disposition after the harness stops or isolates prior execution. |
| [ticket.recovery.get](ticket.recovery.get.md) | advanced | read | Read one immutable guarded ticket-recovery audit record. |
| [ticket.recovery.list](ticket.recovery.list.md) | advanced | read | List immutable ticket-recovery records under one guarded workspace capture. |
| [ticket.release](ticket.release.md) | core | mutation | Release current ticket ownership, return work to Todo and cancel active attempts with release evidence. |
| [ticket.renew_lease](ticket.renew_lease.md) | advanced | mutation | Renew a timed ticket claim under its exact token and lease revision. |
| [ticket.reopen](ticket.reopen.md) | advanced | mutation | Reopen eligible completed work under its current planning guards. |
| [ticket.resolve](ticket.resolve.md) | advanced | read | Resolve a human-facing display key to its canonical ticket ID. |
| [ticket.resume](ticket.resume.md) | core | read | Recover bounded recorded task context with exact historical source references. |
| [ticket.start](ticket.start.md) | core | mutation | Claim a ready ticket and optionally start an attempt atomically. |
| [ticket.update](ticket.update.md) | core | mutation | Update guarded title, description or status; use ticket.metadata for priority. |
| [transaction.apply](transaction.apply.md) | core | mutation | Commit 1..128 ordered planning operations atomically with typed creation aliases. |
| [transaction.preflight](transaction.preflight.md) | advanced | read | Validate an atomic plan and its exact native expanded operation count without committing it. |
| [upload.abort](upload.abort.md) | advanced | write | Discard actor-owned private upload staging and free its admission. |
| [upload.begin](upload.begin.md) | advanced | write | Begin or resume actor-owned ephemeral byte staging with declared content metadata. |
| [upload.chunk](upload.chunk.md) | advanced | write | Stage a contiguous opaque byte chunk or retry an identical byte range. |
| [upload.list](upload.list.md) | advanced | read | Inspect complete live upload owner, progress, lifecycle and age metadata. |
| [upload.status](upload.status.md) | advanced | read | Read one actor-owned live upload&#x27;s contiguous progress and lifecycle. |
| [usage.aggregate](usage.aggregate.md) | advanced | read | Aggregate immutable caller-reported usage and named integer samples in one capture. |
| [usage.list](usage.list.md) | advanced | read | List immutable caller-reported usage records under explicit scope filters. |
| [usage.report](usage.report.md) | advanced | mutation | Record an immutable attributed consumption report and supported named integer samples. |
| [validation.add](validation.add.md) | advanced | mutation | Record an attributed validator outcome against exact pinned evidence. |
| [validation.list](validation.list.md) | advanced | read | List recorded checks and their exact evidence bindings. |
| [workspace.archive](workspace.archive.md) | advanced | mutation | Archive guarded workspace planning metadata while retaining its durable contents. |
| [workspace.close](workspace.close.md) | advanced | mutation | Close a loaded workspace and checkpoint its planning and history heads while retaining registration. |
| [workspace.create](workspace.create.md) | advanced | mutation | Create, register and open a new durable workspace at a fresh private root. |
| [workspace.export](workspace.export.md) | advanced | mutation | Start an immutable captured workspace export while normal writes may continue. |
| [workspace.get](workspace.get.md) | advanced | read | Read workspace planning metadata and its current entity revision. |
| [workspace.list](workspace.list.md) | advanced | read | List registry workspaces with open intent, availability and explicit name provenance. |
| [workspace.metrics](workspace.metrics.md) | core | read | Observe committed activity, reported usage and exact admission accounting. |
| [workspace.open](workspace.open.md) | advanced | mutation | Replay and verify a closed registered workspace before serving scoped operations. |
| [workspace.overview](workspace.overview.md) | core | read | Read a bounded captured workspace summary and its open work. |
| [workspace.receipt](workspace.receipt.md) | advanced | read | Read a workspace-planning mutation&#x27;s exact durable saved receipt. |
| [workspace.register](workspace.register.md) | advanced | mutation | Verify and register an existing portable workspace tree, then open it. |
| [workspace.restore](workspace.restore.md) | advanced | mutation | Verify, copy and replay a complete export into a fresh root, registering the result closed. |
| [workspace.unregister](workspace.unregister.md) | advanced | mutation | Remove a closed workspace&#x27;s local registry association while leaving portable files intact. |
| [workspace.update](workspace.update.md) | advanced | mutation | Update guarded workspace planning name, summary, description or instructions. |
