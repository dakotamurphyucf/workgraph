# Recorded resume and activity digest

Use `ticket.resume` when taking over a ticket or rebuilding context after an
interruption. Use `activity.digest` when you need a bounded account of recorded changes
since a known point. A **ticket** is Workgraph's task record. A **handoff** is saved
task context with a **coverage** boundary saying which recorded changes its author had
incorporated. Neither method runs a model or acts outside Workgraph.

A **planning capture** fixes the committed state used to assemble the response. A
**source reference** identifies the exact recorded version behind an item, so you can
expand its evidence without treating a summary as the whole record. See
[concepts](concepts.md) for claims, runs, attempts, acceptance gates and policy.

## Resume a ticket from recorded context

`ticket.resume` returns a deterministic brief from one immutable planning capture. It
reads recorded task fields, current ownership and readiness, the latest handoff, path
requirements, external conditions, recovery audits, the effective acceptance policy and
completion gates, associated run and latest attempt, outstanding requests, selected
facts and changes after the handoff's recorded coverage. It performs no model execution
or external side effects.

```json
{
  "method": "ticket.resume",
  "params": {
    "workspace_id": "example",
    "ticket_id": "task",
    "max_bytes": "65536",
    "change_limit": "10",
    "include_markdown": false,
    "fact_selections": [
      {
        "scope": {
          "kind": "ticket",
          "id": "task"
        },
        "key": "decision"
      }
    ]
  }
}
```

The required task excerpt preserves its exact current claim, lease, hold, status,
project membership fence and control counters. It excludes relation and history arrays
with explicit counts. Its exact source references lead to the complete canonical task
record; excluded history is never silently described as empty. Known descriptive text
may be a UTF-8 prefix, with original and omitted byte counts. Facts, pins, identities
and leases are whole records. Selected facts use exact scopes with no inheritance or
inferred relevance. Missing and deleted keys are distinct warnings. Ticket fact key
discovery is returned separately from selected values; it is not a claim that every
discovered fact is relevant.

Task description and latest handoff prose use the space remaining after selecting
records and history, rather than a fixed 256-byte excerpt. Short instructions stay
complete when they fit. Markdown labels `Ticket description` and `Handoff objective`
separately and renders the latest handoff once; its structured audit row remains in
`changes` with the original source and coverage. Omissions still disclose exact bytes.

Discover small memory values with `fact.keys` for the exact scope, then select only the
keys needed for this task using `fact_selections` as in the example above. Key discovery
does not load values into the resume automatically.

Handoff freshness follows recorded coverage and the current claim token. A new claim by
the same actor can make the saved handoff incomplete. Missing coverage, new recorded
activity, unavailable observation time and omitted sections are explicit. The daemon
supplies its current observation time; pure State callers must supply a time when
requesting timed ownership diagnostics.

Post-handoff warnings include activity kinds and counts. `handoff_bookkeeping_activity`
means only handoff records and claim transitions followed coverage; inspect the current
owner before acting. `handoff_new_activity` includes other recorded changes. Neither
warning moves coverage or a cursor, or proves that external work has stopped.

## Read a digest of committed changes

`activity.digest` classifies committed transitions into completion, reopening, decision,
blocker, request, condition, recovery, ownership, progress, fact, task change and
resource rows. It compares actual historical task transitions and retains exact source
content or disclosed prose excerpts. Other resolved changes are counted separately. A
fact change is not inferred to be a decision.

```json
{
  "method": "activity.digest",
  "params": {
    "workspace_id": "example",
    "scope": {
      "kind": "ticket",
      "ticket_id": "task"
    },
    "after": "0",
    "limit": "50",
    "max_bytes": "65536",
    "include_markdown": false
  }
}
```

The scope may be workspace (the default), project or ticket. Project selection includes
recorded ticket and milestone containment. A resource-targeted record belongs to its
explicitly recorded target scopes at that captured position: one resource-link hop,
followed by ticket/milestone project containment. Resource-to- resource chains are not
traversed. Removing a link appears once in its previous scope; later comments on the
unlinked resource do not belong to that scope. No current membership is borrowed for an
older captured page. Returned cursors bind workspace, scope and the exact retained audit
prefix. Continue with the same scope and the returned cursor, omitting `after`. Rows are
ordered by workspace revision and zero-based change ordinal, so a large transaction can
span multiple pages without losing its remaining rows. A page keeps its original
`capture.through` and request summary despite intervening commits. Outstanding requests
and their scope are reconstructed at that captured boundary, using captured thread links
and board scope. A completed cursor validates its old prefix before advancing to a fresh
upper boundary. A different workspace, scope or restored prefix rejects the cursor with
`Conflict`; malformed cursor data is `Invalid_argument`.

## Response budgets and omissions

Both methods measure the complete public response, including metadata, provenance,
counts, continuation and optional Markdown, against `max_bytes` (4096–1048576, default
65536). Whole optional records are omitted with section counts. A digest whose first
complete row cannot fit returns an actionable error to increase the budget; it never
skips that row. A resume may omit all change rows while returning its essential task;
its cursor continues them through `activity.digest` with the same ticket scope.
`include_markdown` defaults to false. When true, structured records and deterministic
Markdown are fitted together. Markdown escapes recorded text and contains stable source
labels rather than interpolated remote URLs.

## Expand exact source versions

Source references identify recorded versions. A current getter with `at_revision` is an
exact current capture guard, not a historical snapshot reader. Expand a
`planning_change` source using `activity.since` after its workspace revision minus one,
page until the pinned revision appears, then select the exact change ordinal from that
audit's complete public changes. Comment, fact and request histories also retain their
exact versions. A task recovery is represented by its complete recovery audit and exact
guards; use its preceding task source plus that audit to reconstruct the recovered
control fields. Current task/run getters may already have moved beyond a pinned version.
The source and capture references disclose this distinction rather than promising a
current getter returns old content.

## `ticket.resume` request and response

[Complete request and result schema](api/ticket.resume.md).

Supply `workspace_id` and `ticket_id`. Optional fields are:

| Field | Meaning and limits |
| --- | --- |
| `run_id` | Select run-specific diagnostics. |
| `at_revision` | Exact current planning revision guard. |
| `max_bytes` | Complete response budget, 4096..1048576 bytes. |
| `change_limit` | 1..100 change rows. |
| `fact_selections` | At most 16 exact `{scope,key}` selections. |
| `fact_prefix` | Fact-key discovery prefix, at most 128 UTF-8 bytes. |
| `include_markdown` | Boolean, default `false`. |

Unknown or duplicate fields reject. Fact scopes use `kind` plus `id`; digest scopes
instead use `project_id` or `ticket_id`.

The response has `result.meta.workspace_revision` and data fields `ticket_id`,
`capture`, `observed_unix_ms`, `items`, `changes`, `warnings`, `counts`, `cursor`,
`has_more`, and optional `markdown`. Items retain a kind, summary, typed sources, actual
record and `clipped_fields`. The task excerpt counts excluded history arrays; current
ownership and control fields stay exact. Each section count reports its `total`,
`returned` and `omitted` records.

## `activity.digest` request and response

[Complete request and result schema](api/activity.digest.md).

Supply `workspace_id`. Optional fields are:

| Field | Meaning and limits |
| --- | --- |
| `scope` | Workspace, project with `project_id`, or ticket with `ticket_id`. |
| `after` or `cursor` | Mutually exclusive starting position or continuation. |
| `limit` | 1..100 rows. |
| `max_bytes` | Complete response budget, 4096..1048576 bytes. |
| `include_markdown` | Boolean, default `false`. |

Keep scope unchanged across cursor pages. The response has
`result.meta.workspace_revision` and data fields `capture`, `entries`,
`outstanding_requests`, `counts`, `cursor`, `has_more` and optional `markdown`. The
capture records `after`, nullable `after_change_index`, `through` and `lineage`. Each
entry retains `workspace_revision`, `change_index`, `category` and an `item` with exact
source references. Records fit as whole units; if the first row cannot fit, the method
returns `Invalid_argument` with guidance to increase the budget.

## Policy and amendment audit

activity.digest retains typed hierarchy policy and instruction amendment records with
exact event/source attribution. Amendment publication, acknowledgement and withdrawal
records remain whole validated nested structures; no clipped object is disguised as a
full change. If an exact required row cannot fit, increase max_bytes rather than
fabricating a partial record. A digest is committed activity, not historical run
eligibility. ticket.brief gives a smaller current overview; it does not replace selected
facts, exact resource expansion or complete resume gates.

## CLI example

After [setting up an agent context](getting-started.md), replace these absolute paths
and use an existing ticket ID. `CONTEXT` supplies the socket and workspace. This selects
one exact fact key; it does not search parent scopes or choose relevant facts for you. A
missing key is returned as a warning.

```sh
WG=/absolute/path/to/workgraph
CONTEXT=/absolute/private/agent/context.json

"$WG" --context "$CONTEXT" request ticket.resume \
  --ticket-id task --max-bytes 65536 --change-limit 10 \
  --json-field fact_selections '[{"scope":{"kind":"ticket","id":"task"},"key":"decision"}]'

"$WG" --context "$CONTEXT" request activity.digest \
  --json-field scope '{"kind":"ticket","ticket_id":"task"}' \
  --after 0 --limit 50 --max-bytes 65536
```

When a digest returns `has_more`, send its cursor with the same scope and omit `after`.
Keep paging before calling that captured interval complete. When a resume omits changes,
continue its cursor through `activity.digest` using the same ticket scope.

## Traverse exact audit changes

Use `activity.read` for complete audit content when a valid transaction exceeds
`activity.since`'s whole-commit response budget. It preserves original commit order,
zero-based change ordinals, historical attribution and frozen target routing. Use
`activity.digest` for classified history and `ticket.resume` for focused recovery.

```sh
"$WG" --context "$CONTEXT" request activity.read \
  --after 0 --limit 50 --max-bytes 65536
"$WG" --context "$CONTEXT" request activity.read \
  --cursor "$CURSOR" --limit 50 --max-bytes 65536
```

An initial `after` fixes the retained prefix through `data.through`, identified by
`data.lineage`. Resume with the returned `data.cursor`, omit `after`, and keep the
optional `target` and `actor_id` selectors unchanged. Later commits stay outside
that capture. Changed or unavailable retained lineage rejects `Conflict`. A null
cursor means the capture is exhausted; start a new read with `after=through` to
observe subsequent commits. Changing the byte budget or limit while continuing is
allowed. No mutable server cursor or external process is created.

Each item gives `revision`, `change_index`, original `change_count`, `byte_offset`,
`total_bytes` and SHA256 `digest`. A `kind:"change"` item contains a complete public
audit record in `value`, with exactly one original change and its source headers.
When one such record cannot fit, `kind:"chunk"` contains a nonempty UTF8-safe slice
of that record's canonical JSON text. Offsets and lengths count UTF8 bytes, not
characters. Append slices in order, starting at byte zero; each following offset
must equal bytes already collected. Require the final byte length and SHA256 to
match, then parse the assembled JSON. Whole records use the same canonical bytes
and digest. Chunks include exact content, including whitespace, rather than clipped
prose. The next cursor never advances beyond unread change bytes.

`remaining_changes` counts all incomplete or unread changes in the fixed capture,
including a partially returned change. `limit` counts whole items or chunks,
1..100. `max_bytes` counts the complete public result envelope, 4096..1048576.
Budget omissions count changes excluded by byte fitting within the requested item
limit; ordinary limit paging is represented by the cursor and remaining count.
