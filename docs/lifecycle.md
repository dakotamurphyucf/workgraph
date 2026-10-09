# Ticket lifecycle

Use `ticket.start` to claim one eligible ticket atomically with an optional
`initial_note` and optional fresh `attempt_id`. Supply `run_id` when starting an
attempt. `expected_revision` is optional: omit it to select the current unclaimed
eligible state, or supply the revision you observed to reject intervening changes.
`ticket.claim` has the same optional guard. Existing progress, claim, attempt,
handoff and completion primitives remain available.

Use `ticket.finish` with the ownership `token` and nonblank `evidence`. An optional
`handoff` contains `summary`, `next_steps` and optional `covers_through`. Completion
finishes any active owned attempt and the ticket together. A failed check publishes
none of the handoff, attempt or ticket updates. One mutation identity covers the
whole operation; retry the exact saved request after an uncertain response.
Ordinary attempts require evidence, ownership and the normal completion checks;
manifests and accepted reviews are required only when an enabled review policy
explicitly configures them.

Parents can start by default. Unfinished children still prevent parent completion.
`ticket.claim_next` accepts `leaf_only: true` to exclude parents with unfinished
children. Equal-priority tickets are selected by creation order, including within a
single transaction, while that transaction advances the workspace revision once.

`ticket.reopen` takes `ticket_id`, the current `expected_revision` and a nonblank
`reason`. Any cooperating actor can explicitly reopen completed work. It becomes
unclaimed todo work; assignee, prior completion evidence, terminal attempts and
explicit dependency waivers remain intact. A replacement claim has a fresh token.
Generic status updates cannot create a new completion or reopen completed tickets;
use owned completion with evidence or explicit reopening. Previously accepted output
from an older claim cannot satisfy the reopened ticket's configured review policy.
Editing evidence by itself does not reopen a ticket.

An unwaived reopened prerequisite blocks dependent eligibility and completion.
Running dependents retain their ownership and receive a durable ticket-linked
message. Completed dependents retain their completed status and receive structured
reassessment history identifying the source prerequisite, reopen workspace revision,
reason, actor and timestamp. Reopening never cascades automatically. A reassessment
records an observation; it does not silently decide whether replacement work is
needed. Explicit waivers continue to bypass their prerequisite.

`ticket.readiness` and `ticket.context` expose eligibility reasons and completion
checks from the same functions used during preparation. Completion diagnostics
include blocked prerequisite and unfinished child identities plus the policy or
hold problem. Preflight describes the captured state; commit checks again.
No eligible tickets does not imply every ticket is complete.

Handoff `covers_through` means the workspace revision actually observed by its
writer, not the time the handoff was saved. Omitting it conservatively covers no
activity (zero). Context keeps subsequent updates visible; the latest redundant
handoff-only activity entry is hidden in presentation without advancing coverage.
