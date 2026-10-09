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
| [acceptance.assert](acceptance.assert.md) | advanced | mutation | Assert acceptance state. |
| [acceptance.assertions](acceptance.assertions.md) | advanced | read | Read acceptance assertions data. |
| [acceptance.policy.effective](acceptance.policy.effective.md) | advanced | read | Read acceptance policy effective data. |
| [acceptance.policy.get](acceptance.policy.get.md) | advanced | read | Read one acceptance policy record and its current revision. |
| [acceptance.policy.put](acceptance.policy.put.md) | advanced | mutation | Create or update acceptance policy metadata with revision guards. |
| [activity.digest](activity.digest.md) | core | read | Deterministic bounded recorded resume or captured digest. |
| [activity.since](activity.since.md) | advanced | read | Read bounded committed activity after a retained sequence. |
| [actor.list](actor.list.md) | advanced | read | List actor records matching the explicit filters. |
| [actor.put](actor.put.md) | advanced | mutation | Create or update actor metadata with revision guards. |
| [allocation.pool_put](allocation.pool_put.md) | advanced | mutation | Create or update allocation limits with the pool's entity revision. |
| [allocation.pools](allocation.pools.md) | advanced | read | Read allocation pools data. |
| [allocation.ticket_policies](allocation.ticket_policies.md) | advanced | read | Read allocation ticket policies data. |
| [allocation.ticket_policy_put](allocation.ticket_policy_put.md) | advanced | mutation | Ticket policy put allocation state. |
| [attempt.checkpoint](attempt.checkpoint.md) | advanced | mutation | Checkpoint attempt state. |
| [attempt.finish](attempt.finish.md) | advanced | mutation | Finish attempt state. |
| [attempt.get](attempt.get.md) | core | read | Read one attempt record and its current revision. |
| [attempt.list](attempt.list.md) | advanced | read | List attempt records matching the explicit filters. |
| [attempt.start](attempt.start.md) | advanced | mutation | Start attempt state. |
| [board.get](board.get.md) | advanced | read | Read one board record and its current revision. |
| [board.list](board.list.md) | advanced | read | List board records matching the explicit filters. |
| [board.put](board.put.md) | advanced | mutation | Create a discussion board at revision 0 or update its guarded metadata. |
| [changes.read](changes.read.md) | advanced | read | Complete captured commit metadata with exact prefix continuation. |
| [changes.wait](changes.wait.md) | advanced | read | Complete captured commit metadata with exact prefix continuation. |
| [comment.add](comment.add.md) | advanced | mutation | Add comment state. |
| [comment.edit](comment.edit.md) | advanced | mutation | Edit comment state. |
| [comment.get](comment.get.md) | advanced | read | Read one comment record and its current revision. |
| [comment.history](comment.history.md) | advanced | read | Read retained attributed comment history. |
| [comment.list](comment.list.md) | advanced | read | List comment records matching the explicit filters. |
| [comment.tombstone](comment.tombstone.md) | advanced | mutation | Tombstone comment state. |
| [condition.get](condition.get.md) | advanced | read | Read one condition record and its current revision. |
| [condition.list](condition.list.md) | advanced | read | List condition records matching the explicit filters. |
| [condition.put](condition.put.md) | advanced | mutation | Create or update condition metadata with revision guards. |
| [condition.signal](condition.signal.md) | advanced | mutation | Signal condition state. |
| [condition.signals](condition.signals.md) | advanced | read | Read condition signals data. |
| [contract.get](contract.get.md) | advanced | read | Read one contract record and its current revision. |
| [contract.history](contract.history.md) | advanced | read | Read retained attributed contract history. |
| [contract.list](contract.list.md) | advanced | read | List contract records matching the explicit filters. |
| [contract.put](contract.put.md) | core | mutation | Create or update contract metadata with revision guards. |
| [coordinator.overview](coordinator.overview.md) | advanced | read | Whole typed metadata across one current coordination capture. |
| [daemon.export_all](daemon.export_all.md) | advanced | mutation | Export all daemon state. |
| [daemon.health](daemon.health.md) | core | read | Read daemon health data. |
| [daemon.restore_all](daemon.restore_all.md) | advanced | mutation | Restore all daemon state. |
| [daemon.shutdown](daemon.shutdown.md) | advanced | write | Drain admitted work and stop the daemon. |
| [decision.get](decision.get.md) | advanced | read | Read one decision record and its current revision. |
| [decision.history](decision.history.md) | advanced | read | Read retained attributed decision history. |
| [decision.list](decision.list.md) | advanced | read | List decision records matching the explicit filters. |
| [decision.put](decision.put.md) | advanced | mutation | Create or update decision metadata with revision guards. |
| [dependency.add](dependency.add.md) | advanced | mutation | Add dependency state. |
| [dependency.remove](dependency.remove.md) | advanced | mutation | Remove dependency state. |
| [dependency.waive](dependency.waive.md) | advanced | mutation | Waive dependency state. |
| [evidence.context](evidence.context.md) | advanced | read | Read evidence context data. |
| [export.cancel](export.cancel.md) | advanced | mutation | Cancel export state. |
| [export.get](export.get.md) | advanced | read | Read one export record and its current revision. |
| [export.list](export.list.md) | advanced | read | List export records matching the explicit filters. |
| [export.retry](export.retry.md) | advanced | mutation | Retry export state. |
| [export.verify](export.verify.md) | advanced | read | Read export verify data. |
| [fact.delete](fact.delete.md) | advanced | mutation | Delete fact state. |
| [fact.get](fact.get.md) | core | read | Read one fact record and its current revision. |
| [fact.history](fact.history.md) | advanced | read | Read retained attributed fact history. |
| [fact.keys](fact.keys.md) | core | read | Discover scoped fact keys without loading their values. |
| [fact.list](fact.list.md) | advanced | read | List fact records matching the explicit filters. |
| [fact.multi_get](fact.multi_get.md) | core | read | Read fact multi get data. |
| [fact.put](fact.put.md) | core | mutation | Write one bounded scoped JSON fact with an optional revision guard. |
| [fact.search](fact.search.md) | advanced | read | Search retained fact text with bounded results. |
| [handoff.get](handoff.get.md) | core | read | Read the current structured handoff and its revision. |
| [handoff.history](handoff.history.md) | advanced | read | Read retained attributed handoff history. |
| [handoff.set](handoff.set.md) | core | mutation | Publish a structured ownership-guarded handoff with explicit coverage. |
| [history.get](history.get.md) | advanced | read | Read one history record and its current revision. |
| [history.payload](history.payload.md) | advanced | read | Read history payload data. |
| [history.read](history.read.md) | advanced | read | Read history read data. |
| [history.search](history.search.md) | advanced | read | Search retained history text with bounded results. |
| [inbox.ack](inbox.ack.md) | core | mutation | Acknowledge only the selected delivered inbox entries. |
| [inbox.read](inbox.read.md) | core | read | Read bounded recipient notifications with resumable visible-row pagination. |
| [inbox.wait](inbox.wait.md) | core | read | Wait up to 25 seconds for recipient notifications. |
| [initialize](initialize.md) | core | read | Read daemon capabilities and protocol limits. |
| [input.changed](input.changed.md) | advanced | mutation | Changed input state. |
| [label.list](label.list.md) | advanced | read | List label records matching the explicit filters. |
| [label.put](label.put.md) | advanced | mutation | Create or update label metadata with revision guards. |
| [manifest.get](manifest.get.md) | advanced | read | Read one manifest record and its current revision. |
| [manifest.history](manifest.history.md) | advanced | read | Read retained attributed manifest history. |
| [manifest.list](manifest.list.md) | advanced | read | List manifest records matching the explicit filters. |
| [manifest.publish](manifest.publish.md) | core | mutation | Publish manifest state. |
| [message.send](message.send.md) | core | mutation | Send an immutable-body informal message with frozen actor/run/team routing. |
| [milestone.archive](milestone.archive.md) | advanced | mutation | Archive milestone metadata while preserving retained history. |
| [milestone.create](milestone.create.md) | advanced | mutation | Create a new milestone with explicit identity and metadata. |
| [milestone.get](milestone.get.md) | advanced | read | Read one milestone record and its current revision. |
| [milestone.list](milestone.list.md) | advanced | read | List milestone records matching the explicit filters. |
| [milestone.schedule](milestone.schedule.md) | advanced | mutation | Schedule milestone state. |
| [milestone.update](milestone.update.md) | advanced | mutation | Update selected milestone fields with revision guards. |
| [project.archive](project.archive.md) | advanced | mutation | Archive project metadata while preserving retained history. |
| [project.brief](project.brief.md) | core | read | Read a bounded captured project summary, tickets and milestones. |
| [project.create](project.create.md) | core | mutation | Create a new project with explicit identity and metadata. |
| [project.get](project.get.md) | core | read | Read one project record and its current revision. |
| [project.list](project.list.md) | core | read | List project records matching the explicit filters. |
| [project.update](project.update.md) | advanced | mutation | Update selected project fields with revision guards. |
| [reconciliation.list](reconciliation.list.md) | advanced | read | List reconciliation records matching the explicit filters. |
| [reconciliation.record](reconciliation.record.md) | advanced | mutation | Record reconciliation state. |
| [recovery.get](recovery.get.md) | advanced | read | Read one recovery record and its current revision. |
| [recovery.list](recovery.list.md) | advanced | read | List recovery records matching the explicit filters. |
| [registry.receipt](registry.receipt.md) | advanced | read | Read registry receipt data. |
| [related.add](related.add.md) | advanced | mutation | Add related state. |
| [related.remove](related.remove.md) | advanced | mutation | Remove related state. |
| [request.accept](request.accept.md) | advanced | mutation | Accept request state. |
| [request.acknowledge](request.acknowledge.md) | advanced | mutation | Acknowledge request state. |
| [request.ask](request.ask.md) | core | mutation | Ask an accountable question and create its discussion and request atomically. |
| [request.cancel](request.cancel.md) | advanced | mutation | Cancel request state. |
| [request.create](request.create.md) | core | mutation | Create an accountable request with explicit recipient and resolver. |
| [request.get](request.get.md) | core | read | Read one request with its request and current thread revisions. |
| [request.history](request.history.md) | advanced | read | Read retained attributed request history. |
| [request.list](request.list.md) | core | read | List requests with recipient, ticket and resolver filters; reading acknowledges nothing. |
| [request.reassign](request.reassign.md) | advanced | mutation | Reassign request state. |
| [request.resolve](request.resolve.md) | core | mutation | Resolve an accountable request as its resolver, optionally attaching an answer. |
| [reservation.acquire](reservation.acquire.md) | advanced | mutation | Acquire reservation state. |
| [reservation.get](reservation.get.md) | advanced | read | Read one reservation record and its current revision. |
| [reservation.list](reservation.list.md) | advanced | read | List reservation records matching the explicit filters. |
| [reservation.path.get](reservation.path.get.md) | advanced | read | Read one reservation path record and its current revision. |
| [reservation.path.list](reservation.path.list.md) | advanced | read | List reservation path records matching the explicit filters. |
| [reservation.path.recover](reservation.path.recover.md) | advanced | mutation | Recover reservation path state. |
| [reservation.path.release](reservation.path.release.md) | advanced | mutation | Release reservation path state. |
| [reservation.path.renew](reservation.path.renew.md) | advanced | mutation | Renew reservation path state. |
| [reservation.paths.acquire](reservation.paths.acquire.md) | advanced | mutation | Acquire reservation paths state. |
| [reservation.recover](reservation.recover.md) | advanced | mutation | Recover reservation state. |
| [reservation.release](reservation.release.md) | advanced | mutation | Release reservation state. |
| [reservation.renew](reservation.renew.md) | advanced | mutation | Renew reservation state. |
| [resource.archive](resource.archive.md) | advanced | mutation | Archive resource metadata while preserving retained history. |
| [resource.finish_upload](resource.finish_upload.md) | advanced | mutation | Finish upload resource state. |
| [resource.get](resource.get.md) | core | read | Read one resource record and its current revision. |
| [resource.history](resource.history.md) | advanced | read | Read retained attributed resource history. |
| [resource.link](resource.link.md) | advanced | mutation | Link resource state. |
| [resource.list](resource.list.md) | core | read | List resource records matching the explicit filters. |
| [resource.put_text](resource.put_text.md) | core | mutation | Publish immutable UTF-8 content with required title and retained metadata. |
| [resource.read](resource.read.md) | core | read | Read complete bounded UTF-8 content by resource ID and latest or explicit version. |
| [resource.read_chunk](resource.read_chunk.md) | advanced | read | Read a verified binary byte range by resource ID and immutable version. |
| [resource.unlink](resource.unlink.md) | advanced | mutation | Unlink resource state. |
| [resource.update](resource.update.md) | advanced | mutation | Update selected resource fields with revision guards. |
| [restore.cancel](restore.cancel.md) | advanced | mutation | Cancel restore state. |
| [review.accept](review.accept.md) | core | mutation | Accept the current submission after its configured review gates pass. |
| [review.gate](review.gate.md) | core | read | Inspect current submission requirements and recorded reviewer decisions. |
| [review.list](review.list.md) | advanced | read | List review records matching the explicit filters. |
| [review.policy.get](review.policy.get.md) | advanced | read | Read one review policy record and its current revision. |
| [review.policy.put](review.policy.put.md) | advanced | mutation | Create or update review policy metadata with revision guards. |
| [review.record](review.record.md) | core | mutation | Record an immutable reviewer decision for an exact submission generation. |
| [review.submission.get](review.submission.get.md) | advanced | read | Read one review submission record and its current revision. |
| [review.submission.list](review.submission.list.md) | advanced | read | List review submission records matching the explicit filters. |
| [review.submit](review.submit.md) | core | mutation | Bind submitted outputs to an exact manifest and active attempt. |
| [run.action_acknowledge](run.action_acknowledge.md) | advanced | mutation | Action acknowledge run state. |
| [run.actions](run.actions.md) | advanced | read | Read run actions data. |
| [run.budget_attention](run.budget_attention.md) | advanced | read | Read run budget attention data. |
| [run.budget_get](run.budget_get.md) | advanced | read | Read run budget get data. |
| [run.budget_put](run.budget_put.md) | advanced | mutation | Budget put run state. |
| [run.get](run.get.md) | core | read | Read one run's identity, state and entity revision. |
| [run.heartbeat](run.heartbeat.md) | advanced | write | Record advisory liveness; does not renew ownership or require a mutation ID. |
| [run.heartbeat_get](run.heartbeat_get.md) | advanced | read | Read the current and last persisted advisory liveness observation. |
| [run.link_session](run.link_session.md) | advanced | mutation | Link session run state. |
| [run.list](run.list.md) | advanced | read | List run records matching the explicit filters. |
| [run.observe](run.observe.md) | core | mutation | Observe run state. |
| [run.register](run.register.md) | core | mutation | Register an attributed agent invocation with an independent run revision. |
| [run.transition](run.transition.md) | advanced | mutation | Transition run state. |
| [search.query](search.query.md) | core | read | Search captured planning entities and content with bounded results. |
| [session.append](session.append.md) | advanced | mutation | Append session state. |
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
| [template.instance_get](template.instance_get.md) | advanced | read | Read template instance get data. |
| [template.instance_list](template.instance_list.md) | advanced | read | Read template instance list data. |
| [template.instance_register](template.instance_register.md) | advanced | mutation | Instance register template state. |
| [template.instantiate](template.instantiate.md) | advanced | mutation | Instantiate template state. |
| [template.list](template.list.md) | advanced | read | List template records matching the explicit filters. |
| [template.register](template.register.md) | advanced | mutation | Register template state. |
| [thread.attach](thread.attach.md) | advanced | mutation | Attach thread state. |
| [thread.get](thread.get.md) | advanced | read | Read one thread record and its current revision. |
| [thread.history](thread.history.md) | advanced | read | Read retained attributed thread history. |
| [thread.list](thread.list.md) | advanced | read | List thread records matching the explicit filters. |
| [thread.pin_message](thread.pin_message.md) | advanced | mutation | Pin message thread state. |
| [thread.put](thread.put.md) | advanced | mutation | Create a discussion thread at revision 0 or update its guarded metadata. |
| [thread.reply](thread.reply.md) | advanced | mutation | Reply thread state. |
| [thread.search](thread.search.md) | advanced | read | Search retained thread text with bounded results. |
| [ticket.archive](ticket.archive.md) | advanced | mutation | Archive ticket metadata while preserving retained history. |
| [ticket.blockers](ticket.blockers.md) | core | read | Read the captured reasons blocking a ticket. |
| [ticket.claim](ticket.claim.md) | advanced | mutation | Claim ticket state. |
| [ticket.claim_next](ticket.claim_next.md) | core | mutation | Allocate eligible work and start an attempt under pool policy. |
| [ticket.complete](ticket.complete.md) | advanced | mutation | Complete ticket state. |
| [ticket.context](ticket.context.md) | core | read | Read captured ticket context, ownership, links and handoff. |
| [ticket.create](ticket.create.md) | core | mutation | Create a new ticket with explicit identity and metadata. |
| [ticket.finish](ticket.finish.md) | core | mutation | Record completion evidence and finish an active attempt atomically. |
| [ticket.hold](ticket.hold.md) | advanced | mutation | Hold ticket state. |
| [ticket.list](ticket.list.md) | core | read | List ticket records matching the explicit filters. |
| [ticket.metadata](ticket.metadata.md) | core | mutation | Update a ticket's priority, assignee, labels, acceptance criteria or status. |
| [ticket.move](ticket.move.md) | advanced | mutation | Move ticket state. |
| [ticket.paths.get](ticket.paths.get.md) | advanced | read | Read one ticket paths record and its current revision. |
| [ticket.paths.list](ticket.paths.list.md) | advanced | read | List ticket paths records matching the explicit filters. |
| [ticket.paths.put](ticket.paths.put.md) | advanced | mutation | Create or update ticket paths metadata with revision guards. |
| [ticket.progress](ticket.progress.md) | core | mutation | Append an attributed progress comment under current ownership. |
| [ticket.readiness](ticket.readiness.md) | core | read | Explain whether a ticket can start and identify unmet prerequisites. |
| [ticket.ready](ticket.ready.md) | core | read | List eligible ready tickets with optional parent and capability filters. |
| [ticket.reassign](ticket.reassign.md) | advanced | mutation | Reassign ticket state. |
| [ticket.recover](ticket.recover.md) | advanced | mutation | Recover ticket state. |
| [ticket.recovery.get](ticket.recovery.get.md) | advanced | read | Read immutable guarded ticket recovery audit. |
| [ticket.recovery.list](ticket.recovery.list.md) | advanced | read | Read immutable guarded ticket recovery audit. |
| [ticket.release](ticket.release.md) | core | mutation | Release ticket state. |
| [ticket.renew_lease](ticket.renew_lease.md) | advanced | mutation | Renew lease ticket state. |
| [ticket.reopen](ticket.reopen.md) | advanced | mutation | Reopen ticket state. |
| [ticket.resolve](ticket.resolve.md) | advanced | read | Resolve a human display key to its canonical ticket ID. |
| [ticket.resume](ticket.resume.md) | core | read | Recover bounded recorded task context with exact historical sources. |
| [ticket.start](ticket.start.md) | core | mutation | Claim a ready ticket and optionally start an attempt atomically. |
| [ticket.update](ticket.update.md) | core | mutation | Update selected ticket fields with revision guards. |
| [transaction.apply](transaction.apply.md) | core | mutation | Commit 1..32 ordered planning operations atomically, with typed creation aliases. |
| [upload.abort](upload.abort.md) | advanced | write | Discard private staging and free upload admission. |
| [upload.begin](upload.begin.md) | advanced | write | Begin or resume actor-owned ephemeral byte staging. |
| [upload.chunk](upload.chunk.md) | advanced | write | Stage a contiguous opaque byte chunk or exact range retry. |
| [upload.status](upload.status.md) | advanced | write | Read private live staging progress. |
| [usage.list](usage.list.md) | advanced | read | List usage records matching the explicit filters. |
| [usage.report](usage.report.md) | advanced | mutation | Report usage state. |
| [validation.add](validation.add.md) | advanced | mutation | Add validation state. |
| [validation.list](validation.list.md) | advanced | read | List validation records matching the explicit filters. |
| [workspace.archive](workspace.archive.md) | advanced | mutation | Archive workspace metadata while preserving retained history. |
| [workspace.close](workspace.close.md) | advanced | mutation | Close workspace state. |
| [workspace.create](workspace.create.md) | advanced | mutation | Create a new workspace with explicit identity and metadata. |
| [workspace.export](workspace.export.md) | advanced | mutation | Export workspace state. |
| [workspace.get](workspace.get.md) | advanced | read | Read one workspace record and its current revision. |
| [workspace.list](workspace.list.md) | advanced | read | List workspace records matching the explicit filters. |
| [workspace.metrics](workspace.metrics.md) | core | read | Observe committed activity, reported usage and exact admission accounting; no inferred client calls. |
| [workspace.open](workspace.open.md) | advanced | mutation | Open workspace state. |
| [workspace.overview](workspace.overview.md) | core | read | Read a bounded captured workspace summary and open work. |
| [workspace.receipt](workspace.receipt.md) | advanced | read | Read workspace receipt data. |
| [workspace.register](workspace.register.md) | advanced | mutation | Register workspace state. |
| [workspace.restore](workspace.restore.md) | advanced | mutation | Restore workspace state. |
| [workspace.unregister](workspace.unregister.md) | advanced | mutation | Unregister workspace state. |
| [workspace.update](workspace.update.md) | advanced | mutation | Update selected workspace fields with revision guards. |
