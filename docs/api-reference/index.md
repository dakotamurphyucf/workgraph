# Generated API reference

These files come from `workgraph schema`, using the same executable declarations
that validate requests and results. Load one method when needed. For daemon setup,
workflows, retry rules and feature discovery, start with [the agent guide](../../AGENT_GUIDE.md).

Each method file describes its params object and complete result `{data,meta}`.
Repeated schemas use local `$defs` and `$ref` within that same schema block.
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

| Method | Effect | Purpose |
| --- | --- | --- |
| [acceptance.assert](acceptance.assert.md) | mutation | Acceptance policy and exact evidence: acceptance.assert |
| [acceptance.assertions](acceptance.assertions.md) | read | Acceptance policy and exact evidence: acceptance.assertions |
| [acceptance.policy.effective](acceptance.policy.effective.md) | read | Acceptance policy and exact evidence: acceptance.policy.effective |
| [acceptance.policy.get](acceptance.policy.get.md) | read | Acceptance policy and exact evidence: acceptance.policy.get |
| [acceptance.policy.put](acceptance.policy.put.md) | mutation | Acceptance policy and exact evidence: acceptance.policy.put |
| [activity.digest](activity.digest.md) | read | Deterministic bounded recorded resume or captured digest. |
| [activity.since](activity.since.md) | read | Typed captured planning query: activity.since |
| [actor.list](actor.list.md) | read | Read canonical base planning metadata: actor.list |
| [actor.put](actor.put.md) | mutation | Apply actor.put as a durable planning mutation. |
| [allocation.pool_put](allocation.pool_put.md) | mutation | Run coordination method allocation.pool_put |
| [allocation.pools](allocation.pools.md) | read | Run coordination method allocation.pools |
| [allocation.ticket_policies](allocation.ticket_policies.md) | read | Run coordination method allocation.ticket_policies |
| [allocation.ticket_policy_put](allocation.ticket_policy_put.md) | mutation | Run coordination method allocation.ticket_policy_put |
| [attempt.checkpoint](attempt.checkpoint.md) | mutation | Run coordination method attempt.checkpoint |
| [attempt.finish](attempt.finish.md) | mutation | Run coordination method attempt.finish |
| [attempt.get](attempt.get.md) | read | Run coordination method attempt.get |
| [attempt.list](attempt.list.md) | read | Run coordination method attempt.list |
| [attempt.start](attempt.start.md) | mutation | Run coordination method attempt.start |
| [board.get](board.get.md) | read | Communication state and accountable requests: board.get |
| [board.list](board.list.md) | read | Communication state and accountable requests: board.list |
| [board.put](board.put.md) | mutation | Communication state and accountable requests: board.put |
| [changes.read](changes.read.md) | read | Complete captured commit metadata with exact prefix continuation. |
| [changes.wait](changes.wait.md) | read | Complete captured commit metadata with exact prefix continuation. |
| [comment.add](comment.add.md) | mutation | Apply comment.add as a durable planning mutation. |
| [comment.edit](comment.edit.md) | mutation | Apply comment.edit as a durable planning mutation. |
| [comment.get](comment.get.md) | read | Read comment provenance and content: comment.get |
| [comment.history](comment.history.md) | read | Read comment provenance and content: comment.history |
| [comment.list](comment.list.md) | read | Read comment provenance and content: comment.list |
| [comment.tombstone](comment.tombstone.md) | mutation | Apply comment.tombstone as a durable planning mutation. |
| [condition.get](condition.get.md) | read | Run coordination method condition.get |
| [condition.list](condition.list.md) | read | Run coordination method condition.list |
| [condition.put](condition.put.md) | mutation | Run coordination method condition.put |
| [condition.signal](condition.signal.md) | mutation | Run coordination method condition.signal |
| [condition.signals](condition.signals.md) | read | Run coordination method condition.signals |
| [contract.get](contract.get.md) | read | Acceptance policy and exact evidence: contract.get |
| [contract.history](contract.history.md) | read | Acceptance policy and exact evidence: contract.history |
| [contract.list](contract.list.md) | read | Acceptance policy and exact evidence: contract.list |
| [contract.put](contract.put.md) | mutation | Acceptance policy and exact evidence: contract.put |
| [coordinator.overview](coordinator.overview.md) | read | Whole typed metadata across one current coordination capture. |
| [daemon.export_all](daemon.export_all.md) | mutation | Local registry, complete exports and verified restores: daemon.export_all |
| [daemon.health](daemon.health.md) | read | Local registry, complete exports and verified restores: daemon.health |
| [daemon.restore_all](daemon.restore_all.md) | mutation | Local registry, complete exports and verified restores: daemon.restore_all |
| [daemon.shutdown](daemon.shutdown.md) | write | Drain admitted work and stop the daemon. |
| [decision.get](decision.get.md) | read | Acceptance policy and exact evidence: decision.get |
| [decision.history](decision.history.md) | read | Acceptance policy and exact evidence: decision.history |
| [decision.list](decision.list.md) | read | Acceptance policy and exact evidence: decision.list |
| [decision.put](decision.put.md) | mutation | Acceptance policy and exact evidence: decision.put |
| [dependency.add](dependency.add.md) | mutation | Apply dependency.add as a durable planning mutation. |
| [dependency.remove](dependency.remove.md) | mutation | Apply dependency.remove as a durable planning mutation. |
| [dependency.waive](dependency.waive.md) | mutation | Apply dependency.waive as a durable planning mutation. |
| [evidence.context](evidence.context.md) | read | Acceptance policy and exact evidence: evidence.context |
| [export.cancel](export.cancel.md) | mutation | Local registry, complete exports and verified restores: export.cancel |
| [export.get](export.get.md) | read | Local registry, complete exports and verified restores: export.get |
| [export.list](export.list.md) | read | Local registry, complete exports and verified restores: export.list |
| [export.retry](export.retry.md) | mutation | Local registry, complete exports and verified restores: export.retry |
| [export.verify](export.verify.md) | read | Local registry, complete exports and verified restores: export.verify |
| [fact.delete](fact.delete.md) | mutation | Read or update scoped working facts: fact.delete |
| [fact.get](fact.get.md) | read | Read or update scoped working facts: fact.get |
| [fact.history](fact.history.md) | read | Read or update scoped working facts: fact.history |
| [fact.keys](fact.keys.md) | read | Read or update scoped working facts: fact.keys |
| [fact.list](fact.list.md) | read | Read or update scoped working facts: fact.list |
| [fact.multi_get](fact.multi_get.md) | read | Read or update scoped working facts: fact.multi_get |
| [fact.put](fact.put.md) | mutation | Read or update scoped working facts: fact.put |
| [fact.search](fact.search.md) | read | Read or update scoped working facts: fact.search |
| [handoff.get](handoff.get.md) | read | Typed captured planning query: handoff.get |
| [handoff.history](handoff.history.md) | read | Typed captured planning query: handoff.history |
| [handoff.set](handoff.set.md) | mutation | Apply handoff.set as a durable planning mutation. |
| [history.get](history.get.md) | read | Independent captured conversation history: history.get |
| [history.payload](history.payload.md) | read | Independent captured conversation history: history.payload |
| [history.read](history.read.md) | read | Independent captured conversation history: history.read |
| [history.search](history.search.md) | read | Independent captured conversation history: history.search |
| [inbox.ack](inbox.ack.md) | mutation | Durably acknowledge selected notification IDs for one consumer and recipient. |
| [inbox.read](inbox.read.md) | read | Read bounded unread notifications for an explicit consumer and recipient without consuming them. |
| [inbox.wait](inbox.wait.md) | read | Wait boundedly for unread notifications; responses do not consume or acknowledge. |
| [initialize](initialize.md) | read | Read daemon capabilities and protocol limits. |
| [input.changed](input.changed.md) | mutation | Acceptance policy and exact evidence: input.changed |
| [label.list](label.list.md) | read | Read canonical base planning metadata: label.list |
| [label.put](label.put.md) | mutation | Apply label.put as a durable planning mutation. |
| [manifest.get](manifest.get.md) | read | Acceptance policy and exact evidence: manifest.get |
| [manifest.history](manifest.history.md) | read | Acceptance policy and exact evidence: manifest.history |
| [manifest.list](manifest.list.md) | read | Acceptance policy and exact evidence: manifest.list |
| [manifest.publish](manifest.publish.md) | mutation | Acceptance policy and exact evidence: manifest.publish |
| [message.send](message.send.md) | mutation | Send an immutable-body informal message with frozen actor/run/team routing. |
| [milestone.archive](milestone.archive.md) | mutation | Apply milestone.archive as a durable planning mutation. |
| [milestone.create](milestone.create.md) | mutation | Apply milestone.create as a durable planning mutation. |
| [milestone.get](milestone.get.md) | read | Read canonical base planning metadata: milestone.get |
| [milestone.list](milestone.list.md) | read | Read canonical base planning metadata: milestone.list |
| [milestone.schedule](milestone.schedule.md) | mutation | Apply milestone.schedule as a durable planning mutation. |
| [milestone.update](milestone.update.md) | mutation | Apply milestone.update as a durable planning mutation. |
| [project.archive](project.archive.md) | mutation | Apply project.archive as a durable planning mutation. |
| [project.brief](project.brief.md) | read | Typed captured planning query: project.brief |
| [project.create](project.create.md) | mutation | Apply project.create as a durable planning mutation. |
| [project.get](project.get.md) | read | Read canonical base planning metadata: project.get |
| [project.list](project.list.md) | read | Read canonical base planning metadata: project.list |
| [project.update](project.update.md) | mutation | Apply project.update as a durable planning mutation. |
| [reconciliation.list](reconciliation.list.md) | read | Acceptance policy and exact evidence: reconciliation.list |
| [reconciliation.record](reconciliation.record.md) | mutation | Acceptance policy and exact evidence: reconciliation.record |
| [recovery.get](recovery.get.md) | read | Run coordination method recovery.get |
| [recovery.list](recovery.list.md) | read | Run coordination method recovery.list |
| [registry.receipt](registry.receipt.md) | read | Local registry, complete exports and verified restores: registry.receipt |
| [related.add](related.add.md) | mutation | Apply related.add as a durable planning mutation. |
| [related.remove](related.remove.md) | mutation | Apply related.remove as a durable planning mutation. |
| [request.accept](request.accept.md) | mutation | Communication state and accountable requests: request.accept |
| [request.acknowledge](request.acknowledge.md) | mutation | Communication state and accountable requests: request.acknowledge |
| [request.cancel](request.cancel.md) | mutation | Communication state and accountable requests: request.cancel |
| [request.create](request.create.md) | mutation | Communication state and accountable requests: request.create |
| [request.get](request.get.md) | read | Communication state and accountable requests: request.get |
| [request.history](request.history.md) | read | Communication state and accountable requests: request.history |
| [request.list](request.list.md) | read | Communication state and accountable requests: request.list |
| [request.reassign](request.reassign.md) | mutation | Communication state and accountable requests: request.reassign |
| [request.resolve](request.resolve.md) | mutation | Communication state and accountable requests: request.resolve |
| [reservation.acquire](reservation.acquire.md) | mutation | Run coordination method reservation.acquire |
| [reservation.get](reservation.get.md) | read | Run coordination method reservation.get |
| [reservation.list](reservation.list.md) | read | Run coordination method reservation.list |
| [reservation.path.get](reservation.path.get.md) | read | Run coordination method reservation.path.get |
| [reservation.path.list](reservation.path.list.md) | read | Run coordination method reservation.path.list |
| [reservation.path.recover](reservation.path.recover.md) | mutation | Run coordination method reservation.path.recover |
| [reservation.path.release](reservation.path.release.md) | mutation | Run coordination method reservation.path.release |
| [reservation.path.renew](reservation.path.renew.md) | mutation | Run coordination method reservation.path.renew |
| [reservation.paths.acquire](reservation.paths.acquire.md) | mutation | Run coordination method reservation.paths.acquire |
| [reservation.recover](reservation.recover.md) | mutation | Run coordination method reservation.recover |
| [reservation.release](reservation.release.md) | mutation | Run coordination method reservation.release |
| [reservation.renew](reservation.renew.md) | mutation | Run coordination method reservation.renew |
| [resource.archive](resource.archive.md) | mutation | Apply resource.archive as a durable planning mutation. |
| [resource.finish_upload](resource.finish_upload.md) | mutation | Retained resource publication/metadata: resource.finish_upload |
| [resource.get](resource.get.md) | read | Retained resource publication/metadata: resource.get |
| [resource.history](resource.history.md) | read | Retained resource publication/metadata: resource.history |
| [resource.link](resource.link.md) | mutation | Apply resource.link as a durable planning mutation. |
| [resource.list](resource.list.md) | read | Retained resource publication/metadata: resource.list |
| [resource.put_text](resource.put_text.md) | mutation | Apply resource.put_text as a durable planning mutation. |
| [resource.read](resource.read.md) | read | Read complete bounded UTF-8 content by resource ID and latest or explicit version. |
| [resource.read_chunk](resource.read_chunk.md) | read | Read a verified binary byte range by resource ID and immutable version. |
| [resource.unlink](resource.unlink.md) | mutation | Apply resource.unlink as a durable planning mutation. |
| [resource.update](resource.update.md) | mutation | Apply resource.update as a durable planning mutation. |
| [restore.cancel](restore.cancel.md) | mutation | Local registry, complete exports and verified restores: restore.cancel |
| [review.accept](review.accept.md) | mutation | Acceptance policy and exact evidence: review.accept |
| [review.gate](review.gate.md) | read | Acceptance policy and exact evidence: review.gate |
| [review.list](review.list.md) | read | Acceptance policy and exact evidence: review.list |
| [review.policy.get](review.policy.get.md) | read | Acceptance policy and exact evidence: review.policy.get |
| [review.policy.put](review.policy.put.md) | mutation | Acceptance policy and exact evidence: review.policy.put |
| [review.record](review.record.md) | mutation | Acceptance policy and exact evidence: review.record |
| [review.submission.get](review.submission.get.md) | read | Acceptance policy and exact evidence: review.submission.get |
| [review.submission.list](review.submission.list.md) | read | Acceptance policy and exact evidence: review.submission.list |
| [review.submit](review.submit.md) | mutation | Acceptance policy and exact evidence: review.submit |
| [run.action_acknowledge](run.action_acknowledge.md) | mutation | Run coordination method run.action_acknowledge |
| [run.actions](run.actions.md) | read | Run coordination method run.actions |
| [run.budget_attention](run.budget_attention.md) | read | Templates, allocation bounds and reported usage: run.budget_attention |
| [run.budget_get](run.budget_get.md) | read | Templates, allocation bounds and reported usage: run.budget_get |
| [run.budget_put](run.budget_put.md) | mutation | Templates, allocation bounds and reported usage: run.budget_put |
| [run.get](run.get.md) | read | Run coordination method run.get |
| [run.heartbeat](run.heartbeat.md) | write | Record advisory liveness; does not renew ownership or require a mutation ID. |
| [run.heartbeat_get](run.heartbeat_get.md) | read | Read the current and last persisted advisory liveness observation. |
| [run.link_session](run.link_session.md) | mutation | Run coordination method run.link_session |
| [run.list](run.list.md) | read | Run coordination method run.list |
| [run.observe](run.observe.md) | mutation | Run coordination method run.observe |
| [run.register](run.register.md) | mutation | Run coordination method run.register |
| [run.transition](run.transition.md) | mutation | Run coordination method run.transition |
| [search.query](search.query.md) | read | Typed captured planning query: search.query |
| [session.append](session.append.md) | mutation | Independent captured conversation history: session.append |
| [session.archive](session.archive.md) | mutation | Independent captured conversation history: session.archive |
| [session.create](session.create.md) | mutation | Independent captured conversation history: session.create |
| [session.get](session.get.md) | read | Independent captured conversation history: session.get |
| [session.list](session.list.md) | read | Independent captured conversation history: session.list |
| [status.list](status.list.md) | read | Read canonical base planning metadata: status.list |
| [status.put](status.put.md) | mutation | Apply status.put as a durable planning mutation. |
| [subscription.get](subscription.get.md) | read | Communication state and accountable requests: subscription.get |
| [subscription.list](subscription.list.md) | read | Communication state and accountable requests: subscription.list |
| [subscription.put](subscription.put.md) | mutation | Communication state and accountable requests: subscription.put |
| [team.get](team.get.md) | read | Communication state and accountable requests: team.get |
| [team.list](team.list.md) | read | Communication state and accountable requests: team.list |
| [team.put](team.put.md) | mutation | Communication state and accountable requests: team.put |
| [template.get](template.get.md) | read | Templates, allocation bounds and reported usage: template.get |
| [template.instance_get](template.instance_get.md) | read | Templates, allocation bounds and reported usage: template.instance_get |
| [template.instance_list](template.instance_list.md) | read | Templates, allocation bounds and reported usage: template.instance_list |
| [template.instance_register](template.instance_register.md) | mutation | Templates, allocation bounds and reported usage: template.instance_register |
| [template.instantiate](template.instantiate.md) | mutation | Apply template.instantiate as a durable planning mutation. |
| [template.list](template.list.md) | read | Templates, allocation bounds and reported usage: template.list |
| [template.register](template.register.md) | mutation | Templates, allocation bounds and reported usage: template.register |
| [thread.attach](thread.attach.md) | mutation | Communication state and accountable requests: thread.attach |
| [thread.get](thread.get.md) | read | Communication state and accountable requests: thread.get |
| [thread.history](thread.history.md) | read | Communication state and accountable requests: thread.history |
| [thread.list](thread.list.md) | read | Communication state and accountable requests: thread.list |
| [thread.pin_message](thread.pin_message.md) | mutation | Communication state and accountable requests: thread.pin_message |
| [thread.put](thread.put.md) | mutation | Communication state and accountable requests: thread.put |
| [thread.reply](thread.reply.md) | mutation | Apply thread.reply as a durable planning mutation. |
| [thread.search](thread.search.md) | read | Communication state and accountable requests: thread.search |
| [ticket.archive](ticket.archive.md) | mutation | Apply ticket.archive as a durable planning mutation. |
| [ticket.blockers](ticket.blockers.md) | read | Typed captured planning query: ticket.blockers |
| [ticket.claim](ticket.claim.md) | mutation | Apply ticket.claim as a durable lifecycle mutation. |
| [ticket.claim_next](ticket.claim_next.md) | mutation | Apply ticket.claim_next as a durable planning mutation. |
| [ticket.complete](ticket.complete.md) | mutation | Apply ticket.complete as a durable planning mutation. |
| [ticket.context](ticket.context.md) | read | Typed captured planning query: ticket.context |
| [ticket.create](ticket.create.md) | mutation | Apply ticket.create as a durable planning mutation. |
| [ticket.finish](ticket.finish.md) | mutation | Apply ticket.finish as a durable lifecycle mutation. |
| [ticket.hold](ticket.hold.md) | mutation | Apply ticket.hold as a durable planning mutation. |
| [ticket.list](ticket.list.md) | read | Typed captured planning query: ticket.list |
| [ticket.metadata](ticket.metadata.md) | mutation | Apply ticket.metadata as a durable planning mutation. |
| [ticket.move](ticket.move.md) | mutation | Apply ticket.move as a durable planning mutation. |
| [ticket.paths.get](ticket.paths.get.md) | read | Run coordination method ticket.paths.get |
| [ticket.paths.list](ticket.paths.list.md) | read | Run coordination method ticket.paths.list |
| [ticket.paths.put](ticket.paths.put.md) | mutation | Run coordination method ticket.paths.put |
| [ticket.progress](ticket.progress.md) | mutation | Apply ticket.progress as a durable planning mutation. |
| [ticket.readiness](ticket.readiness.md) | read | Typed captured planning query: ticket.readiness |
| [ticket.ready](ticket.ready.md) | read | Typed captured planning query: ticket.ready |
| [ticket.reassign](ticket.reassign.md) | mutation | Apply ticket.reassign as a durable planning mutation. |
| [ticket.recover](ticket.recover.md) | mutation | Apply ticket.recover as a durable lifecycle mutation. |
| [ticket.recovery.get](ticket.recovery.get.md) | read | Read immutable guarded ticket recovery audit. |
| [ticket.recovery.list](ticket.recovery.list.md) | read | Read immutable guarded ticket recovery audit. |
| [ticket.release](ticket.release.md) | mutation | Apply ticket.release as a durable planning mutation. |
| [ticket.renew_lease](ticket.renew_lease.md) | mutation | Apply ticket.renew_lease as a durable planning mutation. |
| [ticket.reopen](ticket.reopen.md) | mutation | Apply ticket.reopen as a durable lifecycle mutation. |
| [ticket.resolve](ticket.resolve.md) | read | Typed captured planning query: ticket.resolve |
| [ticket.resume](ticket.resume.md) | read | Deterministic bounded recorded resume or captured digest. |
| [ticket.start](ticket.start.md) | mutation | Apply ticket.start as a durable lifecycle mutation. |
| [ticket.update](ticket.update.md) | mutation | Apply ticket.update as a durable planning mutation. |
| [transaction.apply](transaction.apply.md) | mutation | Commit 1..32 ordered planning operations atomically, with typed creation aliases. |
| [upload.abort](upload.abort.md) | write | Discard private staging and free upload admission. |
| [upload.begin](upload.begin.md) | write | Begin or resume actor-owned ephemeral byte staging. |
| [upload.chunk](upload.chunk.md) | write | Stage a contiguous opaque byte chunk or exact range retry. |
| [upload.status](upload.status.md) | write | Read private live staging progress. |
| [usage.list](usage.list.md) | read | Templates, allocation bounds and reported usage: usage.list |
| [usage.report](usage.report.md) | mutation | Templates, allocation bounds and reported usage: usage.report |
| [validation.add](validation.add.md) | mutation | Acceptance policy and exact evidence: validation.add |
| [validation.list](validation.list.md) | read | Acceptance policy and exact evidence: validation.list |
| [workspace.archive](workspace.archive.md) | mutation | Apply workspace.archive as a durable planning mutation. |
| [workspace.close](workspace.close.md) | mutation | Local registry, complete exports and verified restores: workspace.close |
| [workspace.create](workspace.create.md) | mutation | Local registry, complete exports and verified restores: workspace.create |
| [workspace.export](workspace.export.md) | mutation | Local registry, complete exports and verified restores: workspace.export |
| [workspace.get](workspace.get.md) | read | Read canonical base planning metadata: workspace.get |
| [workspace.list](workspace.list.md) | read | Local registry, complete exports and verified restores: workspace.list |
| [workspace.metrics](workspace.metrics.md) | read | Observe committed activity, reported usage and exact admission accounting; no inferred client calls. |
| [workspace.open](workspace.open.md) | mutation | Local registry, complete exports and verified restores: workspace.open |
| [workspace.overview](workspace.overview.md) | read | Typed captured planning query: workspace.overview |
| [workspace.receipt](workspace.receipt.md) | read | Local registry, complete exports and verified restores: workspace.receipt |
| [workspace.register](workspace.register.md) | mutation | Local registry, complete exports and verified restores: workspace.register |
| [workspace.restore](workspace.restore.md) | mutation | Local registry, complete exports and verified restores: workspace.restore |
| [workspace.unregister](workspace.unregister.md) | mutation | Local registry, complete exports and verified restores: workspace.unregister |
| [workspace.update](workspace.update.md) | mutation | Apply workspace.update as a durable planning mutation. |
