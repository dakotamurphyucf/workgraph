# Use Workgraph as durable task context

The CLI is the supported integration surface. No project-maintained MCP server,
model runtime or task executor is required. `examples/agent-workflow.sh` is a
repeatable CLI-only starting fixture; its writes retain stable mutation IDs across
daemon restarts. User-authored skills can wrap the same commands.

## Begin or resume a session

1. Check `initialize`, `daemon health`, and `workspace overview`. Use an explicit
   stable actor ID and a distinct run ID when invocation ownership matters.
2. Read workspace instructions and the relevant `project brief`. Create bounded
   tickets with acceptance criteria, milestones and parent relationships. Add
   execution prerequisites with `dependency add`; parents organize work separately.
   `related add` records nonblocking relationships.
3. Query `ticket ready` and `ticket context`. Inspect readiness reasons, resource
   pointers and existing claims before choosing work. Display keys resolve through
   `ticket resolve`; mutations and relationships use the returned opaque ID.
4. Claim using the observed ticket revision. Save the returned token plus actor/run
   identity. Claim conflicts mean another request won; read current context. A
   fresh run cannot reuse another run's token even if the actor name is the same.

Parallel task execution is an orchestrator decision. Workgraph's dependency DAG
and atomic claims provide scheduling facts; they do not isolate a shared checkout
or fence writes to external tools. Only done prerequisites unblock execution;
canceled prerequisites still block. Holds and documented waivers are explicit.
Assignments do not reserve work. Claims survive restart and are indefinite by
default; optional timed leases require explicit renewal. Heartbeats do not renew
leases. See the [coordination guide](coordination-guide.md).

## Keep evidence with the task

Use `ticket progress` for work protected by a claim and `comment add` for ordinary
discussion. Update after a meaningful implementation step, new finding, failure or
change of direction. A useful update contains:

```text
Changed: files/modules and observable behavior.
Decision: what was chosen and why; link alternatives if they matter.
Validation: exact command, result, and relevant log/resource IDs.
Remaining: concrete next action, uncertainty, blockers and running processes.
```

Attach research, logs and implementation notes as versioned resources. Link them
to the ticket/project. Text fits `resource put_text`; files use `resource upload`
with a saved request. Preserve resource IDs/content versions instead of treating a
local machine path as portable context. Binary download verifies the pinned version.
Metadata and content have separate revisions; read the current metadata revision
before updates. Comments have their own revisions, so unrelated comments do not
invalidate a ticket title edit.

For each mutation either supply an explicit stable mutation ID or use
`--save-request /absolute/new-file.json`. The saved file is synced before sending.
On timeout or lost response, inspect the receipt and retry that same file. Do not
reuse a key for changed arguments or change run attribution on a retry.

## Handoff before compaction, pause or reassignment

Read the current handoff revision, then replace it with `handoff set` using that
revision and the current claim token/run. Preserve history rather than overwriting
comments. Suggested handoff fields:

| Field | Content |
| --- | --- |
| `objective` | Intended user-visible result and constraints |
| `summary`, `completed` | Current state and completed work |
| `decisions` | Accepted choices with rationale |
| `blockers` | Actual impediments and the evidence needed to resolve them |
| `next_steps` | First concrete actions for the next invocation |
| `evidence`, `resource_ids` | Commands/results and portable supporting artifacts |
| `covers_through` | Workspace revision actually reviewed, never a guessed future cursor |

The default coverage is conservative. Progress and a handoff in the same atomic
batch remain discoverable afterward. On resume, `ticket context` returns the latest
handoff and subsequent changes, including edits/tombstones of older comments.
Fetch further pages or `activity since` until all relevant updates are reviewed.
Budget omissions are explicit: inspect `budget.truncated`, details and cursors;
an incomplete page is not proof that no more context exists. Pagination must use
the observed workspace revision, and stale pages restart from a current snapshot.

To transfer ownership, record a reason with `ticket reassign`, the observed ticket
revision, and the next actor/run. The new fencing token invalidates the old owner.
To keep working after daemon restart, retain the same actor/run/token. To release,
use the current claim identity; do not delete history or rely on claim expiry.

## Complete and preserve the outcome

Run the acceptance checks and attach concrete evidence. `ticket complete` requires
the current claim identity and nonempty evidence, and rejects unresolved blockers
or children. An atomic batch can include final progress, handoff and completion
with one durable receipt; preconditions execute in declared order. Project and
milestone completion ratios are derived, while their explicit status remains a
separate deliberate update.

Export the workspace when a portable audit snapshot is useful. Poll the job and
verify its completed destination. For a Git handoff, close before committing or
pulling and explicitly transfer writer ownership. Keep request retry files and
machine-local registry data outside the portable workspace's committed tree.
