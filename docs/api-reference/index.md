# Generated API reference

These files come from `workgraph schema`, using the same executable declarations
that validate requests and results. Load one method when needed. For daemon setup,
workflows, retry rules and feature discovery, start with [the agent guide](../../AGENT_GUIDE.md).

Each method file describes its params object and complete result `{data,meta}`.
Begin with the concise input table. Use `workgraph methods --core` for the everyday
tier and `workgraph help METHOD` for a small example and preconditions. CLI helpers
such as `init` are local workflows, separately labelled in the CLI index. See
[common envelopes and types](common.md). Repeated schemas use named local `$defs`
and `$ref` within that same schema block.
Definitions preserve all original fields and validation annotations; no external
file or network lookup is needed. Start at `properties`, then follow needed shapes.
The transport wraps this result in JSON-RPC. `read` has no write effect; `write`
changes state without a durable retry receipt; `mutation` uses a saved retry
identity. Respect each method's more specific contract.

Counters are canonical decimal strings. `x-maxUtf8Bytes`, `x-maximumDecimal` and
other extension annotations describe checks ordinary JSON Schema validators may
ignore. Mapped domain invariants also appear in descriptions; runtime validation
is authoritative. Do not infer permission or operational policy from a schema.

Regenerate with `python3 tools/generate_api_reference.py --binary /absolute/workgraph
--output docs/api-reference`; add `--check` to detect drift without writing files.

| Method | Tier | Effect | Purpose |
| --- | --- | --- | --- |
| [acceptance.assert](acceptance.assert.md) | advanced | mutation | Acceptance policy and exact evidence: acceptance.assert |
| [acceptance.assertions](acceptance.assertions.md) | advanced | read | Acceptance policy and exact evidence: acceptance.assertions |
| [acceptance.policy.effective](acceptance.policy.effective.md) | advanced | read | Acceptance policy and exact evidence: acceptance.policy.effective |
| [acceptance.policy.get](acceptance.policy.get.md) | advanced | read | Acceptance policy and exact evidence: acceptance.policy.get |
| [acceptance.policy.put](acceptance.policy.put.md) | advanced | mutation | Acceptance policy and exact evidence: acceptance.policy.put |
| [activity.digest](activity.digest.md) | core | read | Deterministic bounded recorded resume or captured digest. |
| [activity.since](activity.since.md) | advanced | read | Since activity state; honor the explicit ownership and revision guards. |
| [actor.list](actor.list.md) | advanced | read | List actor records matching the explicit filters. |
| [actor.put](actor.put.md) | advanced | mutation | Create or update actor metadata with revision guards. |
| [allocation.pool_put](allocation.pool_put.md) | advanced | mutation | Create or update allocation limits with the pool's entity revision. |
| [allocation.pools](allocation.pools.md) | advanced | read | Pools allocation state; honor the explicit ownership and revision guards. |
| [allocation.ticket_policies](allocation.ticket_policies.md) | advanced | read | Ticket policies allocation state; honor the explicit ownership and revision guards. |
| [allocation.ticket_policy_put](allocation.ticket_policy_put.md) | advanced | mutation | Ticket policy put allocation state; honor the explicit ownership and revision guards. |
| [attempt.checkpoint](attempt.checkpoint.md) | advanced | mutation | Checkpoint attempt state; honor the explicit ownership and revision guards. |
| [attempt.finish](attempt.finish.md) | advanced | mutation | Finish attempt state; honor the explicit ownership and revision guards. |
| [attempt.get](attempt.get.md) | core | read | Read one attempt record and its current revision. |
| [attempt.list](attempt.list.md) | advanced | read | List attempt records matching the explicit filters. |
| [attempt.start](attempt.start.md) | advanced | mutation | Start attempt state; honor the explicit ownership and revision guards. |
| [board.get](board.get.md) | advanced | read | Read one board record and its current revision. |
| [board.list](board.list.md) | advanced | read | List board records matching the explicit filters. |
| [board.put](board.put.md) | advanced | mutation | Create or update board metadata with revision guards. |
| [changes.read](changes.read.md) | advanced | read | Complete captured commit metadata with exact prefix continuation. |
| [changes.wait](changes.wait.md) | advanced | read | Complete captured commit metadata with exact prefix continuation. |
| [comment.add](comment.add.md) | advanced | mutation | Add comment state; honor the explicit ownership and revision guards. |
| [comment.edit](comment.edit.md) | advanced | mutation | Edit comment state; honor the explicit ownership and revision guards. |
| [comment.get](comment.get.md) | advanced | read | Read one comment record and its current revision. |
| [comment.history](comment.history.md) | advanced | read | Read retained attributed comment history. |
| [comment.list](comment.list.md) | advanced | read | List comment records matching the explicit filters. |
| [comment.tombstone](comment.tombstone.md) | advanced | mutation | Tombstone comment state; honor the explicit ownership and revision guards. |
| [condition.get](condition.get.md) | advanced | read | Read one condition record and its current revision. |
| [condition.list](condition.list.md) | advanced | read | List condition records matching the explicit filters. |
| [condition.put](condition.put.md) | advanced | mutation | Create or update condition metadata with revision guards. |
| [condition.signal](condition.signal.md) | advanced | mutation | Signal condition state; honor the explicit ownership and revision guards. |
| [condition.signals](condition.signals.md) | advanced | read | Signals condition state; honor the explicit ownership and revision guards. |
| [contract.get](contract.get.md) | advanced | read | Acceptance policy and exact evidence: contract.get |
| [contract.history](contract.history.md) | advanced | read | Acceptance policy and exact evidence: contract.history |
| [contract.list](contract.list.md) | advanced | read | Acceptance policy and exact evidence: contract.list |
| [contract.put](contract.put.md) | core | mutation | Acceptance policy and exact evidence: contract.put |
| [coordinator.overview](coordinator.overview.md) | advanced | read | Whole typed metadata across one current coordination capture. |
| [daemon.export_all](daemon.export_all.md) | advanced | mutation | Export all daemon state; honor the explicit ownership and revision guards. |
| [daemon.health](daemon.health.md) | core | read | Health daemon state; honor the explicit ownership and revision guards. |
| [daemon.restore_all](daemon.restore_all.md) | advanced | mutation | Restore all daemon state; honor the explicit ownership and revision guards. |
| [daemon.shutdown](daemon.shutdown.md) | advanced | write | Drain admitted work and stop the daemon. |
| [decision.get](decision.get.md) | advanced | read | Acceptance policy and exact evidence: decision.get |
| [decision.history](decision.history.md) | advanced | read | Acceptance policy and exact evidence: decision.history |
| [decision.list](decision.list.md) | advanced | read | Acceptance policy and exact evidence: decision.list |
| [decision.put](decision.put.md) | advanced | mutation | Acceptance policy and exact evidence: decision.put |
| [dependency.add](dependency.add.md) | advanced | mutation | Add dependency state; honor the explicit ownership and revision guards. |
| [dependency.remove](dependency.remove.md) | advanced | mutation | Remove dependency state; honor the explicit ownership and revision guards. |
| [dependency.waive](dependency.waive.md) | advanced | mutation | Waive dependency state; honor the explicit ownership and revision guards. |
| [evidence.context](evidence.context.md) | advanced | read | Acceptance policy and exact evidence: evidence.context |
| [export.cancel](export.cancel.md) | advanced | mutation | Cancel export state; honor the explicit ownership and revision guards. |
| [export.get](export.get.md) | advanced | read | Read one export record and its current revision. |
| [export.list](export.list.md) | advanced | read | List export records matching the explicit filters. |
| [export.retry](export.retry.md) | advanced | mutation | Retry export state; honor the explicit ownership and revision guards. |
| [export.verify](export.verify.md) | advanced | read | Verify export state; honor the explicit ownership and revision guards. |
| [fact.delete](fact.delete.md) | advanced | mutation | Delete fact state; honor the explicit ownership and revision guards. |
| [fact.get](fact.get.md) | core | read | Read one fact record and its current revision. |
| [fact.history](fact.history.md) | advanced | read | Read retained attributed fact history. |
| [fact.keys](fact.keys.md) | core | read | Discover scoped fact keys without loading their values. |
| [fact.list](fact.list.md) | advanced | read | List fact records matching the explicit filters. |
| [fact.multi_get](fact.multi_get.md) | core | read | Multi get fact state; honor the explicit ownership and revision guards. |
| [fact.put](fact.put.md) | core | mutation | Write one bounded scoped JSON fact with an optional revision guard. |
| [fact.search](fact.search.md) | advanced | read | Search retained fact text with bounded results. |
| [handoff.get](handoff.get.md) | core | read | Read the current structured handoff and its revision. |
| [handoff.history](handoff.history.md) | advanced | read | Read retained attributed handoff history. |
| [handoff.set](handoff.set.md) | core | mutation | Publish a structured ownership-guarded handoff with explicit coverage. |
| [history.get](history.get.md) | advanced | read | Read one history record and its current revision. |
| [history.payload](history.payload.md) | advanced | read | Payload history state; honor the explicit ownership and revision guards. |
| [history.read](history.read.md) | advanced | read | Read history state; honor the explicit ownership and revision guards. |
| [history.search](history.search.md) | advanced | read | Search retained history text with bounded results. |
| [inbox.ack](inbox.ack.md) | core | mutation | Acknowledge only the selected delivered inbox entries. |
| [inbox.read](inbox.read.md) | core | read | Read bounded recipient notifications with resumable visible-row pagination. |
| [inbox.wait](inbox.wait.md) | core | read | Wait up to 25 seconds for recipient notifications. |
| [initialize](initialize.md) | core | read | Read daemon capabilities and protocol limits. |
| [input.changed](input.changed.md) | advanced | mutation | Acceptance policy and exact evidence: input.changed |
| [label.list](label.list.md) | advanced | read | List label records matching the explicit filters. |
| [label.put](label.put.md) | advanced | mutation | Create or update label metadata with revision guards. |
| [manifest.get](manifest.get.md) | advanced | read | Acceptance policy and exact evidence: manifest.get |
| [manifest.history](manifest.history.md) | advanced | read | Acceptance policy and exact evidence: manifest.history |
| [manifest.list](manifest.list.md) | advanced | read | Acceptance policy and exact evidence: manifest.list |
| [manifest.publish](manifest.publish.md) | core | mutation | Acceptance policy and exact evidence: manifest.publish |
| [message.send](message.send.md) | core | mutation | Send an immutable-body informal message with frozen actor/run/team routing. |
| [milestone.archive](milestone.archive.md) | advanced | mutation | Archive milestone metadata while preserving retained history. |
| [milestone.create](milestone.create.md) | advanced | mutation | Create a new milestone with explicit identity and metadata. |
| [milestone.get](milestone.get.md) | advanced | read | Read one milestone record and its current revision. |
| [milestone.list](milestone.list.md) | advanced | read | List milestone records matching the explicit filters. |
| [milestone.schedule](milestone.schedule.md) | advanced | mutation | Schedule milestone state; honor the explicit ownership and revision guards. |
| [milestone.update](milestone.update.md) | advanced | mutation | Update selected milestone fields with revision guards. |
| [project.archive](project.archive.md) | advanced | mutation | Archive project metadata while preserving retained history. |
| [project.brief](project.brief.md) | core | read | Read a bounded captured project summary, tickets and milestones. |
| [project.create](project.create.md) | core | mutation | Create a new project with explicit identity and metadata. |
| [project.get](project.get.md) | core | read | Read one project record and its current revision. |
| [project.list](project.list.md) | core | read | List project records matching the explicit filters. |
| [project.update](project.update.md) | advanced | mutation | Update selected project fields with revision guards. |
| [reconciliation.list](reconciliation.list.md) | advanced | read | Acceptance policy and exact evidence: reconciliation.list |
| [reconciliation.record](reconciliation.record.md) | advanced | mutation | Acceptance policy and exact evidence: reconciliation.record |
| [recovery.get](recovery.get.md) | advanced | read | Read one recovery record and its current revision. |
| [recovery.list](recovery.list.md) | advanced | read | List recovery records matching the explicit filters. |
| [registry.receipt](registry.receipt.md) | advanced | read | Receipt registry state; honor the explicit ownership and revision guards. |
| [related.add](related.add.md) | advanced | mutation | Add related state; honor the explicit ownership and revision guards. |
| [related.remove](related.remove.md) | advanced | mutation | Remove related state; honor the explicit ownership and revision guards. |
| [request.accept](request.accept.md) | advanced | mutation | Accept request state; honor the explicit ownership and revision guards. |
| [request.acknowledge](request.acknowledge.md) | advanced | mutation | Acknowledge request state; honor the explicit ownership and revision guards. |
| [request.cancel](request.cancel.md) | advanced | mutation | Cancel request state; honor the explicit ownership and revision guards. |
| [request.create](request.create.md) | core | mutation | Create an accountable request with explicit recipient and resolver. |
| [request.get](request.get.md) | core | read | Read one request record and its current revision. |
| [request.history](request.history.md) | advanced | read | Read retained attributed request history. |
| [request.list](request.list.md) | core | read | List request records matching the explicit filters. |
| [request.reassign](request.reassign.md) | advanced | mutation | Reassign request state; honor the explicit ownership and revision guards. |
| [request.resolve](request.resolve.md) | core | mutation | Resolve an accountable request as its designated resolver. |
| [reservation.acquire](reservation.acquire.md) | advanced | mutation | Acquire reservation state; honor the explicit ownership and revision guards. |
| [reservation.get](reservation.get.md) | advanced | read | Read one reservation record and its current revision. |
| [reservation.list](reservation.list.md) | advanced | read | List reservation records matching the explicit filters. |
| [reservation.path.get](reservation.path.get.md) | advanced | read | Read one reservation path record and its current revision. |
| [reservation.path.list](reservation.path.list.md) | advanced | read | List reservation path records matching the explicit filters. |
| [reservation.path.recover](reservation.path.recover.md) | advanced | mutation | Recover reservation path state; honor the explicit ownership and revision guards. |
| [reservation.path.release](reservation.path.release.md) | advanced | mutation | Release reservation path state; honor the explicit ownership and revision guards. |
| [reservation.path.renew](reservation.path.renew.md) | advanced | mutation | Renew reservation path state; honor the explicit ownership and revision guards. |
| [reservation.paths.acquire](reservation.paths.acquire.md) | advanced | mutation | Acquire reservation paths state; honor the explicit ownership and revision guards. |
| [reservation.recover](reservation.recover.md) | advanced | mutation | Recover reservation state; honor the explicit ownership and revision guards. |
| [reservation.release](reservation.release.md) | advanced | mutation | Release reservation state; honor the explicit ownership and revision guards. |
| [reservation.renew](reservation.renew.md) | advanced | mutation | Renew reservation state; honor the explicit ownership and revision guards. |
| [resource.archive](resource.archive.md) | advanced | mutation | Archive resource metadata while preserving retained history. |
| [resource.finish_upload](resource.finish_upload.md) | advanced | mutation | Finish upload resource state; honor the explicit ownership and revision guards. |
| [resource.get](resource.get.md) | core | read | Read one resource record and its current revision. |
| [resource.history](resource.history.md) | advanced | read | Read retained attributed resource history. |
| [resource.link](resource.link.md) | advanced | mutation | Link resource state; honor the explicit ownership and revision guards. |
| [resource.list](resource.list.md) | core | read | List resource records matching the explicit filters. |
| [resource.put_text](resource.put_text.md) | core | mutation | Publish immutable UTF-8 content with required title and retained metadata. |
| [resource.read](resource.read.md) | core | read | Read complete bounded UTF-8 content by resource ID and latest or explicit version. |
| [resource.read_chunk](resource.read_chunk.md) | advanced | read | Read a verified binary byte range by resource ID and immutable version. |
| [resource.unlink](resource.unlink.md) | advanced | mutation | Unlink resource state; honor the explicit ownership and revision guards. |
| [resource.update](resource.update.md) | advanced | mutation | Update selected resource fields with revision guards. |
| [restore.cancel](restore.cancel.md) | advanced | mutation | Cancel restore state; honor the explicit ownership and revision guards. |
| [review.accept](review.accept.md) | core | mutation | Accept the current submission after its configured review gates pass. |
| [review.gate](review.gate.md) | core | read | Inspect current submission requirements and recorded reviewer decisions. |
| [review.list](review.list.md) | advanced | read | Acceptance policy and exact evidence: review.list |
| [review.policy.get](review.policy.get.md) | advanced | read | Acceptance policy and exact evidence: review.policy.get |
| [review.policy.put](review.policy.put.md) | advanced | mutation | Acceptance policy and exact evidence: review.policy.put |
| [review.record](review.record.md) | core | mutation | Record an immutable reviewer decision for an exact submission generation. |
| [review.submission.get](review.submission.get.md) | advanced | read | Acceptance policy and exact evidence: review.submission.get |
| [review.submission.list](review.submission.list.md) | advanced | read | Acceptance policy and exact evidence: review.submission.list |
| [review.submit](review.submit.md) | core | mutation | Bind submitted outputs to an exact manifest and active attempt. |
| [run.action_acknowledge](run.action_acknowledge.md) | advanced | mutation | Action acknowledge run state; honor the explicit ownership and revision guards. |
| [run.actions](run.actions.md) | advanced | read | Actions run state; honor the explicit ownership and revision guards. |
| [run.budget_attention](run.budget_attention.md) | advanced | read | Budget attention run state; honor the explicit ownership and revision guards. |
| [run.budget_get](run.budget_get.md) | advanced | read | Budget get run state; honor the explicit ownership and revision guards. |
| [run.budget_put](run.budget_put.md) | advanced | mutation | Budget put run state; honor the explicit ownership and revision guards. |
| [run.get](run.get.md) | core | read | Read one run's identity, state and entity revision. |
| [run.heartbeat](run.heartbeat.md) | advanced | write | Record advisory liveness; does not renew ownership or require a mutation ID. |
| [run.heartbeat_get](run.heartbeat_get.md) | advanced | read | Read the current and last persisted advisory liveness observation. |
| [run.link_session](run.link_session.md) | advanced | mutation | Link session run state; honor the explicit ownership and revision guards. |
| [run.list](run.list.md) | advanced | read | List run records matching the explicit filters. |
| [run.observe](run.observe.md) | core | mutation | Observe run state; honor the explicit ownership and revision guards. |
| [run.register](run.register.md) | core | mutation | Register an attributed agent invocation with an independent run revision. |
| [run.transition](run.transition.md) | advanced | mutation | Transition run state; honor the explicit ownership and revision guards. |
| [search.query](search.query.md) | core | read | Query search state; honor the explicit ownership and revision guards. |
| [session.append](session.append.md) | advanced | mutation | Append session state; honor the explicit ownership and revision guards. |
| [session.archive](session.archive.md) | advanced | mutation | Archive session metadata while preserving retained history. |
| [session.create](session.create.md) | advanced | mutation | Create a new session with explicit identity and metadata. |
| [session.get](session.get.md) | advanced | read | Read one session record and its current revision. |
| [session.list](session.list.md) | advanced | read | List session records matching the explicit filters. |
| [status.list](status.list.md) | advanced | read | List status records matching the explicit filters. |
| [status.put](status.put.md) | advanced | mutation | Create or update status metadata with revision guards. |
| [subscription.get](subscription.get.md) | advanced | read | Read one subscription record and its current revision. |
| [subscription.list](subscription.list.md) | advanced | read | List subscription records matching the explicit filters. |
| [subscription.put](subscription.put.md) | advanced | mutation | Create or update subscription metadata with revision guards. |
| [team.get](team.get.md) | advanced | read | Read one team record and its current revision. |
| [team.list](team.list.md) | advanced | read | List team records matching the explicit filters. |
| [team.put](team.put.md) | advanced | mutation | Create or update team metadata with revision guards. |
| [template.get](template.get.md) | advanced | read | Read one template record and its current revision. |
| [template.instance_get](template.instance_get.md) | advanced | read | Instance get template state; honor the explicit ownership and revision guards. |
| [template.instance_list](template.instance_list.md) | advanced | read | Instance list template state; honor the explicit ownership and revision guards. |
| [template.instance_register](template.instance_register.md) | advanced | mutation | Instance register template state; honor the explicit ownership and revision guards. |
| [template.instantiate](template.instantiate.md) | advanced | mutation | Instantiate template state; honor the explicit ownership and revision guards. |
| [template.list](template.list.md) | advanced | read | List template records matching the explicit filters. |
| [template.register](template.register.md) | advanced | mutation | Register template state; honor the explicit ownership and revision guards. |
| [thread.attach](thread.attach.md) | advanced | mutation | Attach thread state; honor the explicit ownership and revision guards. |
| [thread.get](thread.get.md) | advanced | read | Read one thread record and its current revision. |
| [thread.history](thread.history.md) | advanced | read | Read retained attributed thread history. |
| [thread.list](thread.list.md) | advanced | read | List thread records matching the explicit filters. |
| [thread.pin_message](thread.pin_message.md) | advanced | mutation | Pin message thread state; honor the explicit ownership and revision guards. |
| [thread.put](thread.put.md) | advanced | mutation | Create or update thread metadata with revision guards. |
| [thread.reply](thread.reply.md) | advanced | mutation | Reply thread state; honor the explicit ownership and revision guards. |
| [thread.search](thread.search.md) | advanced | read | Search retained thread text with bounded results. |
| [ticket.archive](ticket.archive.md) | advanced | mutation | Archive ticket metadata while preserving retained history. |
| [ticket.blockers](ticket.blockers.md) | core | read | Read the captured reasons blocking a ticket. |
| [ticket.claim](ticket.claim.md) | advanced | mutation | Claim ticket state; honor the explicit ownership and revision guards. |
| [ticket.claim_next](ticket.claim_next.md) | core | mutation | Allocate eligible work and start an attempt under pool policy. |
| [ticket.complete](ticket.complete.md) | advanced | mutation | Complete ticket state; honor the explicit ownership and revision guards. |
| [ticket.context](ticket.context.md) | core | read | Read captured ticket context, ownership, links and handoff. |
| [ticket.create](ticket.create.md) | core | mutation | Create a new ticket with explicit identity and metadata. |
| [ticket.finish](ticket.finish.md) | core | mutation | Record completion evidence and finish an active attempt atomically. |
| [ticket.hold](ticket.hold.md) | advanced | mutation | Hold ticket state; honor the explicit ownership and revision guards. |
| [ticket.list](ticket.list.md) | core | read | List ticket records matching the explicit filters. |
| [ticket.metadata](ticket.metadata.md) | core | mutation | Update a ticket's priority, assignee, labels, acceptance criteria or status. |
| [ticket.move](ticket.move.md) | advanced | mutation | Move ticket state; honor the explicit ownership and revision guards. |
| [ticket.paths.get](ticket.paths.get.md) | advanced | read | Read one ticket paths record and its current revision. |
| [ticket.paths.list](ticket.paths.list.md) | advanced | read | List ticket paths records matching the explicit filters. |
| [ticket.paths.put](ticket.paths.put.md) | advanced | mutation | Create or update ticket paths metadata with revision guards. |
| [ticket.progress](ticket.progress.md) | core | mutation | Append an attributed progress comment under current ownership. |
| [ticket.readiness](ticket.readiness.md) | core | read | Explain whether a ticket can start and identify unmet prerequisites. |
| [ticket.ready](ticket.ready.md) | core | read | List eligible ready tickets with optional parent and capability filters. |
| [ticket.reassign](ticket.reassign.md) | advanced | mutation | Reassign ticket state; honor the explicit ownership and revision guards. |
| [ticket.recover](ticket.recover.md) | advanced | mutation | Recover ticket state; honor the explicit ownership and revision guards. |
| [ticket.recovery.get](ticket.recovery.get.md) | advanced | read | Read immutable guarded ticket recovery audit. |
| [ticket.recovery.list](ticket.recovery.list.md) | advanced | read | Read immutable guarded ticket recovery audit. |
| [ticket.release](ticket.release.md) | core | mutation | Release ticket state; honor the explicit ownership and revision guards. |
| [ticket.renew_lease](ticket.renew_lease.md) | advanced | mutation | Renew lease ticket state; honor the explicit ownership and revision guards. |
| [ticket.reopen](ticket.reopen.md) | advanced | mutation | Reopen ticket state; honor the explicit ownership and revision guards. |
| [ticket.resolve](ticket.resolve.md) | advanced | read | Resolve ticket state; honor the explicit ownership and revision guards. |
| [ticket.resume](ticket.resume.md) | core | read | Recover bounded recorded task context with exact historical sources. |
| [ticket.start](ticket.start.md) | core | mutation | Claim a ready ticket and optionally start an attempt atomically. |
| [ticket.update](ticket.update.md) | core | mutation | Update selected ticket fields with revision guards. |
| [transaction.apply](transaction.apply.md) | core | mutation | Commit 1..32 ordered planning operations atomically, with typed creation aliases. |
| [upload.abort](upload.abort.md) | advanced | write | Discard private staging and free upload admission. |
| [upload.begin](upload.begin.md) | advanced | write | Begin or resume actor-owned ephemeral byte staging. |
| [upload.chunk](upload.chunk.md) | advanced | write | Stage a contiguous opaque byte chunk or exact range retry. |
| [upload.status](upload.status.md) | advanced | write | Read private live staging progress. |
| [usage.list](usage.list.md) | advanced | read | List usage records matching the explicit filters. |
| [usage.report](usage.report.md) | advanced | mutation | Report usage state; honor the explicit ownership and revision guards. |
| [validation.add](validation.add.md) | advanced | mutation | Acceptance policy and exact evidence: validation.add |
| [validation.list](validation.list.md) | advanced | read | Acceptance policy and exact evidence: validation.list |
| [workspace.archive](workspace.archive.md) | advanced | mutation | Archive workspace metadata while preserving retained history. |
| [workspace.close](workspace.close.md) | advanced | mutation | Close workspace state; honor the explicit ownership and revision guards. |
| [workspace.create](workspace.create.md) | advanced | mutation | Create a new workspace with explicit identity and metadata. |
| [workspace.export](workspace.export.md) | advanced | mutation | Export workspace state; honor the explicit ownership and revision guards. |
| [workspace.get](workspace.get.md) | advanced | read | Read one workspace record and its current revision. |
| [workspace.list](workspace.list.md) | advanced | read | List workspace records matching the explicit filters. |
| [workspace.metrics](workspace.metrics.md) | core | read | Observe committed activity, reported usage and exact admission accounting; no inferred client calls. |
| [workspace.open](workspace.open.md) | advanced | mutation | Open workspace state; honor the explicit ownership and revision guards. |
| [workspace.overview](workspace.overview.md) | core | read | Read a bounded captured workspace summary and open work. |
| [workspace.receipt](workspace.receipt.md) | advanced | read | Receipt workspace state; honor the explicit ownership and revision guards. |
| [workspace.register](workspace.register.md) | advanced | mutation | Register workspace state; honor the explicit ownership and revision guards. |
| [workspace.restore](workspace.restore.md) | advanced | mutation | Restore workspace state; honor the explicit ownership and revision guards. |
| [workspace.unregister](workspace.unregister.md) | advanced | mutation | Unregister workspace state; honor the explicit ownership and revision guards. |
| [workspace.update](workspace.update.md) | advanced | mutation | Update selected workspace fields with revision guards. |
