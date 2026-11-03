# Coordinate a team through durable checkpoints

Workgraph stores shared work, ownership, questions, evidence and handoffs. The
**harness** is the caller that launches agents, builds their prompts, supervises
processes and performs external actions. An **actor** identifies a participant;
a **run** identifies one invocation; a ticket **claim** and its token identify the
current logical owner. None of these is authentication or proof of process state.

For a runnable first ticket, use [workflows](workflows.md). For a review involving
a worker and a distinct reviewer, use the [two-round workflow](gated-review-workflow.md).
Read only the focused references needed at each checkpoint.

## Before starting work

Obtain the matching executable, private context/request directory, workspace,
actor, optional registered run, assigned ticket and exact path scopes. Use one
context and request journal per agent; see [CLI setup](cli-contract.md).
Read the latest handoff, amendments, effective acceptance policy and relevant
inbox. A child ticket does not automatically inherit its parent's prerequisites;
configure [dependencies and child completion gates](planning.md) explicitly.

When allocating rather than assigning work, use run-aware eligibility and retain
the actual claim/attempt receipt. After a known empty `claim_next`, capture
[attention](attention.md) before checking readiness and parking in a filtered
wait. Keep cursor continuations and omission flags. Never silently refresh stale
guards or reinterpret an uncertain acquisition as an empty result.

## While working

Keep small named results in facts, reasons in decision comments, long material in
resources, and accountable questions in requests. Save exact writes before
transmission. Persist a handoff before compaction; the harness owns the timing and
choice of model context. See [communication and evidence](communication-evidence.md),
[resources](resources.md) and [context recovery](resume-digest.md).

Required automatic path holds record their exact claim borrowers and release when
the last borrower leaves. Manual holds survive until explicitly released with the
owner's current fence. Expiration and a terminal run record establish neither that
the process stopped nor authority for foreign cleanup. Guarded recovery requires
an external stopped/isolated confirmation; see [ownership recovery](path-conditions-recovery.md).

## Before completing or handing off

Check actual test results, evidence versions, review/validation requirements,
required instruction acknowledgements and prerequisite/child conditions. Publish
external captures first, then record result pins/facts and finish using a supported
atomic transaction when that grouping is needed. Publishing an artifact and
linking its resource are separate receipts. The harness must retain recovery state
between them. [Execution evidence](execution.md) explains captured outputs.

## Before sharing or transferring data

Review visible transcript/tool data and captured outputs for secrets. Export a
consistent snapshot, verify it, restore into a fresh private root and trace
important decisions to immutable sources. Private model reasoning is never input
to a transcript converter. Use one writer at a time: independent histories do not
merge. Follow [administration and transfer](administration.md) for exact lifecycle
steps, and [history](history.md) for indexed coverage and payload recovery.
