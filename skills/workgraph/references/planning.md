# Planning, shared context and completion

Use this reference to organize work, inspect readiness, record progress, and keep
small shared values or handoffs. Read [concepts](concepts.md) for the terms and
[CLI contracts](cli-contract.md) before constructing requests. Each linked method
contains its complete request and result schema; these notes explain behavior
that matters when choosing and combining methods. Output lives in `result.data`;
applicable durability, revisions and omission information live in `result.meta`.

## Inspect and organize work

New projects, milestones and tickets start at entity revision `"1"` with status
`todo`. Projects start with unspecified priority `"0"`. Readiness is calculated,
not stored as a status. A ticket normally needs active workspace/project/milestone/
ticket scope, `todo` status, no claim, no hold, and done prerequisites unless
waived. Required paths, conditions and configured policies can impose further
checks. Ready tickets sort by priority (unspecified last), creation order
(including within a transaction), then ID. Reading readiness does not claim work.

| Need | Methods and behavior |
| --- | --- |
| Read workspace settings | [workspace.get](api/workspace.get.md) |
| Update or archive a workspace | [workspace.update](api/workspace.update.md), [workspace.archive](api/workspace.archive.md) use `settings.revision`, initially `"0"`, rather than `workspace_revision`. `archived:false` unarchives; archival never unregisters or deletes data. |
| Read a workspace overview | [workspace.overview](api/workspace.overview.md). Actor/run filters narrow `held_work` only. For allocation, reported liveness and review attention use [coordinator.overview](api/coordinator.overview.md). |
| Create, edit, archive or inspect projects | [project.create](api/project.create.md), [project.update](api/project.update.md), [project.archive](api/project.archive.md), [project.get](api/project.get.md), [project.list](api/project.list.md). Archival retains history and cannot leave visible work depending on hidden unfinished prerequisites. |
| Expand a project | [project.brief](api/project.brief.md) includes resources, communication, progress, work groups, tickets and milestones, each bounded as documented. |
| Create or edit milestones | [milestone.create](api/milestone.create.md) requires an existing project; [milestone.update](api/milestone.update.md), [milestone.archive](api/milestone.archive.md), [milestone.get](api/milestone.get.md), [milestone.list](api/milestone.list.md) inspect and maintain them. |
| Change a milestone date | [milestone.schedule](api/milestone.schedule.md) accepts a real `YYYY-MM-DD` date or `null` to clear it. Use this method rather than `milestone.update` for dates. |
| Create a ticket | [ticket.create](api/ticket.create.md). Parent/project/milestone references must agree. Omit absent references; do not send `null` for these creation fields. Capture the returned generated ID when you omit `ticket_id`. |
| Edit ticket title, description or status | [ticket.update](api/ticket.update.md) requires the observed ticket revision and no current claim, including for text-only edits. A direct transition to `done` still checks completion requirements. Use `ticket.finish` or `ticket.complete` for claimed work. |
| Set ticket metadata | [ticket.metadata](api/ticket.metadata.md). Priority is set here, not ticket.update: `"0"` is unspecified and sorts last; `"1"` precedes `"2"`. `null` clears assignee/custom status; `[]` clears labels. Assignment does not claim work. Setting a custom status requires no claim; a `done` category checks completion. |
| Move a ticket subtree | [ticket.move](api/ticket.move.md) requires all three destination fields: `project_id`, `milestone_id`, `parent_ticket_id`, each nullable. Descendants retain parent links and clear milestone assignments when their project changes. Cycles and inconsistent scopes reject. |
| Archive or pause work | [ticket.archive](api/ticket.archive.md) preserves history and excludes archived work from new allocation. [ticket.hold](api/ticket.hold.md) uses a nonempty reason to pause readiness and completion without changing status; `null` clears the hold. |

Project and milestone progress counts are derived from recorded work; their
statuses are set explicitly. Actors, labels and custom statuses are catalogs:
entries archive instead of disappearing, and archived entries cannot be newly
assigned. [actor.put](api/actor.put.md) creates at revision `"0"` or replaces at the
observed revision; omitted `archived` resets to false and names are nonempty, at
most 512 bytes. [label.put](api/label.put.md) replaces the whole record: omitted
description/archival reset to defaults. [status.put](api/status.put.md) creates at
revision `"0"`; its category cannot later change. Selecting a custom status sets
the ticket category; category or claim changes clear that selection. Discover
catalogs with [actor.list](api/actor.list.md), [label.list](api/label.list.md) and
[status.list](api/status.list.md).

## Dependencies, parent policies and related links

[dependency.add](api/dependency.add.md) makes `ticket_id` wait for
`prerequisite_id`; [dependency.remove](api/dependency.remove.md) removes that
relationship and its waiver. Neither takes `expected_revision`.
[dependency.waive](api/dependency.waive.md) uses the dependent ticket's revision
and a nonempty reason to waive an existing relationship; `null` revokes the waiver.
Canceled prerequisites remain unsatisfied. Cycles reject even through done or
waived relationships. Parent graphs must also be acyclic.

Parenthood alone does not pass prerequisites to children. Inspect
[ticket.hierarchy.get](api/ticket.hierarchy.get.md) before changing the local policy
with [ticket.hierarchy.put](api/ticket.hierarchy.put.md). This policy has its own
revision (`"0"` before creation), requires both policy fields and a nonblank reason:

- `descendant_prerequisites:"independent"` is the default. `"inherit"` passes that
  ancestor's own declared prerequisites to descendants, including across an
  intermediate parent whose own policy is independent. It does not pass ownership,
  ancestor status, or that ancestor's unfinished-child gate.
- `child_completion:"all_done"` is the default: every child must be done for this
  parent to finish. `"done_or_canceled"` also permits this parent's canceled children.
  This changes no other ticket's prerequisites or child-completion policy.

A waiver belongs to the ticket declaring the prerequisite; descendants cannot
waive inherited relationships. A ticket's own relationships come first, then
inherited ones with deterministic nearest-source deduplication and explicit source
information in blockers. Direct and inherited relationships are checked together
for cycles, including after reparenting; an inheriting parent cannot depend on its
descendant. Policy updates are audited and checked again at completion. They do
not revoke existing claims or stop processes.

For an existing parent with no previous policy, after confirming revision `"0"`:

```sh
wg request ticket.hierarchy.put --ticket-id parent --expected-revision 0 \
  --descendant-prerequisites inherit --child-completion done_or_canceled \
  --reason "Apply this parent's declared prerequisites to descendants"
```

This creates a policy, not a dependency or claim.
[related.add](api/related.add.md) and [related.remove](api/related.remove.md) are
symmetric informational links, with both endpoint revisions checked and updated
together. They allow cycles, reject self-links, and allow at most 100 links per
ticket. They do not affect readiness.

### Change priority or lift a hold

Read the current ticket revision first. These are separate guarded writes; use
the revision returned after each change, not a copied example counter:

```sh
wg ticket metadata --ticket-id "$TICKET" --expected-revision "$REVISION" --priority 1 || exit 1
# Re-read or retain the returned ticket revision before the next mutation.
wg ticket hold --ticket-id "$TICKET" --expected-revision "$NEW_REVISION" \
  --json-field reason null || exit 1
```

`reason:null` lifts the hold. `ticket.release` instead releases a claim with its
actual owner/run/token; it does not unhold work. Clearing a hold does not clear
other readiness or completion gates.

## Find and understand a ticket

| Method | Use and limits |
| --- | --- |
| [ticket.list](api/ticket.list.md) | Filter current work; text matches title/description case-insensitively. |
| [ticket.ready](api/ticket.ready.md) | Read ready work in priority order. `target_run_id` applies that run's actor/capability/pool/budget/path checks; without it, graph-readiness defaults apply. For atomic selection use `ticket.claim_next`, described in [coordination](coordination.md). |
| [ticket.readiness](api/ticket.readiness.md) | Explain current blockers, including inherited prerequisites and allocation reasons. Its optional target run uses the same admission assessment as acquisition. |
| [ticket.blockers](api/ticket.blockers.md) | List unfinished nonwaived prerequisites. This is narrower than readiness: inspect readiness for holds, status and ownership too. |
| [ticket.resolve](api/ticket.resolve.md) | Convert a display key such as `WG-1` into the ticket ID used by other methods. |
| [ticket.brief](api/ticket.brief.md) | Read compact recorded fields, exact counts and source pointers. Use context/resume and explicit pages for deeper inspection. |
| [ticket.read](api/ticket.read.md) | Read complete ticket description, acceptance criteria, ownership and metadata without related histories. A small budget fails explicitly; prose is never silently clipped. |
| [ticket.context](api/ticket.context.md) | Expand ticket, related work, resources, communication, attempts, evidence, parent/children, readiness, handoff and changes. Updates/activity follow `handoff.covers_through`, or revision zero if none exists. |

`ticket.brief` is a preview, including at most 512 bytes of each prose field.
Its `expand_ticket` request retrieves the full ticket through `ticket.read`;
`expand` retrieves coordination context. Both preserve the observed workspace
revision, so a concurrent change causes a conflict rather than mixing snapshots.
`ticket.read` returns the entity under `data.ticket` and an `expand_context`
request. It excludes handoffs, instruction amendments and review records; inspect
those through context before acting on assigned work. Increase `max_bytes` up to
1048576 if a complete ticket does not fit the default 65536-byte response budget.

The nested evidence section in ticket context has its own `{data,meta}` wrapper,
`query_scope:"evidence"`, query revision and byte budget. Do not substitute the
outer planning revision. Resource, communication and attempt semantics are in
[resources](resources.md), [communication/evidence](communication-evidence.md) and
[coordination](coordination.md). Every nested page can have remaining items.

## Claim, start, finish or release

[ticket.claim](api/ticket.claim.md) checks eligibility, takes ownership, switches to
`in_progress` and clears a custom status. It does not create an attempt.
[ticket.start](api/ticket.start.md) can also write a nonblank initial note and start
an attempt when a fresh `attempt_id` and attributed run are supplied. Both can
check an optional observed ticket revision; omitting it selects the current
eligible unclaimed state together with claiming. Required paths, conditions and
ownership checks happen before saving. Explicit `null` is not an omitted default.

Claims are indefinite unless `lease_duration_ms` is supplied (1 through 86400000
milliseconds). Retain the actual returned token and inspect the resulting lease in
ticket context. See [coordination](coordination.md) for renewal and run-aware
allocation. Never predict ownership from `next_token`.

[ticket.finish](api/ticket.finish.md) saves the optional handoff, completion evidence,
active-attempt completion and ticket completion together. It requires the current
actor, optional run and token with an unexpired lease. It rechecks holds, effective
prerequisites, local child-completion policy, current amendment acknowledgements
and configured acceptance/review requirements. A blocked result uses the same
typed readiness blockers as start. `ticket_revision` is the ticket's revision,
independent of attempt, handoff and workspace revisions. Exact retry recovers the
original receipt.

Within finish's optional `handoff`, `summary` and `next_steps` are required.
Omitted rich fields (`objective`, `completed`, `decisions`, `blockers`, `resource_ids`)
and `covers_through` preserve prior values; explicit empty strings/lists clear
them. A first handoff defaults omitted rich fields to empty and coverage to zero.
Completion evidence becomes the new handoff's evidence. This patch behavior
differs from standalone `handoff.set`, whose omitted fields reset to defaults.
Historical handoffs remain immutable.

[ticket.complete](api/ticket.complete.md) is the smaller claimed-completion method,
without a handoff input. It requires nonempty evidence and the same applicable
completion gates, completes active attempts, clears the claim, sets `done`, and
adds an evidence comment.

[ticket.release](api/ticket.release.md) uses your matching actor/run/token, clears
the claim, sets `todo`, and cancels active attempts with evidence of release. A
matching owner can release an expired claim. [ticket.reassign](api/ticket.reassign.md)
requires an existing claim, the exact ticket revision, a nonempty reason and no
active attempt (finish the attempt first). A new claimant receives a fresh
indefinite claim/token. A `null` claimant releases to `todo` and must have no
claimant run. Previous tokens become stale.

[ticket.reopen](api/ticket.reopen.md) uses the exact ticket revision and nonblank
reason to reopen completed work as unclaimed `todo` with a fresh ownership token
sequence. Earlier evidence, attempts and waivers remain. Dependent claims/statuses
remain; recorded reassessments and durable notifications alert running dependents.
Reopening does not stop their processes.

## Discussion, progress and handoffs

[comment.add](api/comment.add.md) can discuss another actor's claimed work. Its
`target` is an explicit workspace/project/milestone/ticket/resource reference; a
reply must have the same target. A kind such as `decision` or `evidence` labels
ordinary discussion; it does not create a formal decision or evidence manifest.
[ticket.progress](api/ticket.progress.md) requires your current actor/run claim
and valid lease. It creates a discussion comment without changing ticket revision.

Only the original author can [edit](api/comment.edit.md) or
[tombstone](api/comment.tombstone.md) authored comments. Tombstoning marks the
current version deleted while retaining previous versions. Generated completion
evidence (`origin:"completion"`) is immutable: correct it with a new `comment.add`,
`kind:"evidence"`, and `reply_to_id` naming the original comment. This does not reopen
the ticket. Editing a declared input creates reconciliation records in the same
transaction. Read [comment.get](api/comment.get.md),
[comment.history](api/comment.history.md) (oldest first, including tombstones), or
[comment.list](api/comment.list.md). Omit `target` to list workspace-wide comments;
explicit `null` and the obsolete `ticket_id` selector reject. `author_id` is the
original author; `actor_id` attributes the returned version.

[handoff.set](api/handoff.set.md) saves structured recovery notes using the
**handoff's** `expected_revision` (`"0"` initially). On claimed work supply the
matching token and actor/run; on unclaimed work omit token. It replaces omitted
optional text/list fields with their defaults. `covers_through` defaults to `"0"`;
set it only to the last planning workspace revision actually reviewed. It does
not assert that unseen concurrent work was read. [handoff.get](api/handoff.get.md)
returns `Not_found` if none exists. [handoff.history](api/handoff.history.md) returns
complete oldest-first versions; historical prose and source information remain
exact, so an oversized first record requires a larger byte budget.

### Read a prospective actor's eligibility

```json
{"method":"ticket.ready","params":{"workspace_id":"demo","candidate":{"actor_id":"reviewer","capabilities":["review"]},"limit":"50"}}
```

`candidate` and `target_run_id` are mutually exclusive. A candidate is an explicit
read-only description of an invocation that could be registered: up to 100 distinct
nonblank capabilities of at most 96 UTF-8 bytes each. It creates no actor, run,
claim, attempt or reservation. Read assessment scope and unknown checks: graph
readiness covers planning conditions; candidate checks add actor/capability policy
and current shared pool availability, while run lifecycle/budget and required-path
ownership can remain unknown. An actual run selector adds its own admission checks.
No read reserves work or guarantees later acquisition. Do not create probe runs to
make a picker look like real activity.

## Small shared facts

Facts store JSON under an exact key in one explicit scope:
`{"kind":"workspace"}` or `{"kind":"ticket","id":"task"}` (also project/milestone).
The same key in different scopes is independent; nothing is inherited. Use
resources for longer notes or logs. Keys are case-sensitive, nonblank UTF-8, 1–128
bytes with no controls. Values allow any valid JSON, at most 4096 canonical bytes
and 16 container levels. The cap counts the entire replacement value, not just
changed fields. Keep summaries below about 3 KiB to leave headroom and publish
long findings/verdicts in versioned resources; a verifier need not append a report
to an almost-full finding fact. JSON `null` is a value, never deletion. Construct
it deliberately with typed JSON, inspect the preview, and use fact.delete when
deletion is intended.

| Method | Behavior |
| --- | --- |
| [fact.put](api/fact.put.md) | Write using the observed per-key revision, or `"0"` for a never-used key. Recreating a deleted key uses its current revision. Claims do not guard facts. |
| [fact.delete](api/fact.delete.md) | Record deletion under the observed revision. Missing keys reject; repeated deletion conflicts. |
| [fact.get](api/fact.get.md) | Read the exact current record, including a deleted marker. Missing keys return `Not_found`. No pagination inputs. |
| [fact.multi_get](api/fact.multi_get.md) | Read up to 100 requested keys in order, with explicit `{scope,key,missing:true}` records for absent keys and visible deleted records. |
| [fact.list](api/fact.list.md) | Page current records sorted by exact key. Prefix matching is case-sensitive; empty prefix matches the scope. Deleted keys are excluded unless requested. |
| [fact.keys](api/fact.keys.md) | Same filters/order as list, returning key metadata, revision, type and attribution without values. Use first for discovery; ticket context also includes bounded key counts. |
| [fact.history](api/fact.history.md) | Read oldest-first attributed versions including deletions; a missing key returns `Not_found`. |
| [fact.search](api/fact.search.md) | Search active keys/current JSON values using an ASCII case-insensitive substring, with byte offsets and bounded snippets. Text must be nonblank, at most 256 bytes. |
| [fact.references](api/fact.references.md) | Find facts with declared ticket/resource links using scoped bounded pagination; it does not infer IDs from JSON values. |

Records retain scope, key, revision, deletion state, actor, optional run, timestamp,
planning change revision, declared references and applicable value/type. Deletion
retains history and revision. Whole values are never shortened: budgets reduce the
number of page items; increase `max_bytes` if no item fits. Query budgets range
4096–1048576 bytes (default 65536); page size is 1–100 (default 50), offset defaults
to zero. Later offsets require the earlier `result.meta.workspace_revision` as
`at_revision`. A new update uses a new mutation ID and observed fact revision;
an exact retry keeps the previous ID and parameters. Per workspace, retained facts
are bounded to 10000 keys and 16 MiB of version metadata. Readable exports group
keys/history into one file per scope.

`fact.list` and `fact.keys` accept up to eight `{pointer,equals}` tests, all of which
must match before pagination. A pointer is an RFC 6901 JSON path, at most 512 UTF-8
bytes and 16 segments; the empty pointer selects the root. Tests compare scalar
values. Missing differs from `null`, and numeric representations `1`, `1.0`, `1e0`
remain distinct. A put can declare up to 32 distinct existing ticket/resource
references. Omitting `references` preserves them; `[]` clears them. Only declared
references and scope IDs resolve transaction aliases; the JSON value remains
literal. Editable fact links are navigation aids; exact resource versions are
needed for immutable evidence.

## Search and the change trail

[search.query](api/search.query.md) performs case-insensitive substring search over
current revisions. Text must be nonblank and at most 256 bytes; supplied `kinds`
must be nonempty and distinct. Hits include exact source identity/revision,
target, byte offsets and bounded snippets. Text resources contribute at most
64 KiB each and 1 MiB per request. Inspect `coverage` and `unindexed_resources`:
coverage reports current-only indexing and eligible/indexed/unindexed/truncated
counts; each unindexed item explains unsupported MIME type, invalid UTF-8,
unrequested content, prefix-only indexing or exhausted query text budget, with
indexed/omitted byte counts and whether size is known. Narrow scope or read the
resource for complete bytes. This does not search complete conversation history.

[activity.since](api/activity.since.md) returns planning transactions strictly after
`after` (default `"0"`) in ascending revision order. Filters select affected
entities, not transcript events. Each item retains attributed, ordered changes
across planning, facts, communication, runs, evidence, policy, recovery and
resources, including original text, frozen recipients, initial comment-version
pins, notification IDs, digests and counters. Byte fitting removes a page suffix
only; an oversized first transaction requires a larger budget, never an unchanged
success cursor. To expand an activity source from a digest or attention item, use
`after = source.workspace_revision - 1` with the **current** `at_revision` guard,
then select the exact revision and change ordinal. This guard ensures a consistent
current read; it does not retrieve an arbitrary historical snapshot.

## Preview and commit a group of changes

[transaction.preflight](api/transaction.preflight.md) previews bounded preparation
and alias resolution against a captured state. It makes no durable change, stores
no receipt, reserves nothing and grants no ownership. The proposed result can be
stale before the real transaction.

[transaction.apply](api/transaction.apply.md) commits 1–128 supported operations
with one actor/run, one receipt and one workspace revision. Put workspace/actor/
mutation/run fields on the outer request only; inner `params` contain method fields.
Preconditions run in order; final graphs/references validate together. Nested
transactions, administrative operations, history writes, upload staging and
worker-only publication are excluded. Template expansion counts toward 128.
Results are in `result.data.results` in input order, each with `method` and its
normal `data`; template expansion has one outer result with tagged internal results.
External tools and file edits are never rolled back by this transaction.

A creation can bind an `as` alias. Use `"$alias"` only in supported typed ID positions,
including nested declared references. Aliases are type-checked; text stays literal.
Forward IDs resolve but do not bypass operations requiring an entity to already
exist when they execute. Supported creation bindings are:

| Creation | Bound ID |
| --- | --- |
| project.create, milestone.create, ticket.create, comment.add | project_id, milestone_id, ticket_id, comment_id respectively |
| resource.put_text at revision zero | resource_id |
| board.put, thread.put, team.put, subscription.put at revision zero | board_id, thread_id, team_id, subscription_id respectively |
| request.create, run.register, attempt.start | request_id, target_run_id, attempt_id respectively |
| contract.put, manifest.publish, decision.put at revision zero | contract_id, manifest_id, decision_id respectively |
| review.record, validation.add | review_id, validation_id respectively |
| template.instantiate, template.instance_register | instance_id |

Only supported project/milestone/ticket/comment/resource creation methods generate
omitted IDs here; other IDs must be explicit. Updates cannot take arbitrary aliases.
Example complete parameter object for project and ticket creation together:

```json
{"workspace_id":"demo","actor_id":"agent","mutation_id":"plan-1","operations":[
  {"method":"project.create","as":"p","params":{"project_id":"p1","title":"Deliver feature"}},
  {"method":"ticket.create","params":{"ticket_id":"t1","project_id":"$p","title":"Implement feature"}}
]}
```

## Finish a project

[project.readiness](api/project.readiness.md) reports current member completion,
ownership, nonterminal attempts and configured gates. Open requests are counted
but do not independently block finish. Canceled members may be terminal; archived
unfinished members still block. [project.finish](api/project.finish.md) requires
the exact project revision, nonblank evidence and structured handoff. It completes
no member ticket, resolves no request and stops no process. Final transaction
validation and replay recheck the same gates.
