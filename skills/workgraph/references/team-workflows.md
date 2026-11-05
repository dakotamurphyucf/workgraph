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

## Shared input, scratch and independent review

Publish common review inputs once as resource versions and record exact version/
digest pins. Use the bundled input-cache helper with those explicit inputs and
inspect its coverage; a local cache path alone is not portable provenance. Keep
private per-agent scratch and caches outside the source checkout, for example
`~/.local/state/workgraph-0.6/scratch/ACTOR/`, so clean-worktree checks do not remove
inputs or force repeated downloads. Use repository scratch only if its policy
explicitly provides and ignores it. Keep accepted shared context and completion
evidence as durable resources. Never put scratch, caches or source checkouts inside
managed registry/workspace data directories.

Participant prompts should name lead-only synthesis/dispatch work and the allowed
verifier roles. Before a finding gets a verifier ticket, compare related findings
at the same location and identify all involved authors. Configure a positive
nonempty allowed-actor list of independent reviewers; allocation cannot infer that
two tickets describe the same author's finding. Install and check the policy before
dispatch, preferably in the same atomic transaction as creation.

## Harness launch and wait responsibility

Inspect provider API errors before launching a replacement invocation. Respect a
reported reset or retry time, cap exponential backoff, and brake repeated rapid
no-progress failures. Keep the harness responsive to stop/control while waiting;
do not create hundreds of fake runs or dispatch facts for refused launches.
Record a run for an actual invocation. Workgraph observations and held-work counts
help inspection but cannot prove external process termination.

Wait for shared locks in bounded foreground intervals that fit the runner's tool
limits. Keep exact request journals through uncertainty. Advisory waiter expiry
only hides a note; it never releases a ticket or reservation. Verify actual grant
receipts and close advisory notes explicitly after acquisition/cancellation.
