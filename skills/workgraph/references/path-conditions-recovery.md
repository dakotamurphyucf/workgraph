# Paths, external conditions and ownership recovery

Read [the shared CLI and wire contract](cli-contract.md) before constructing requests.
Return to [the capability guide](../SKILL.md) to choose another reference.

## Terms and workflow

A **worktree identity** is a name the harness assigns to a checkout namespace.
A **path target** names a file or subtree within that namespace. A **holder** is
one run's shared or exclusive reservation. Its token, lease revision and target
**epoch** are guards that prevent an old caller from releasing replacement work.
A ticket **path policy** declares paths needed by that ticket. An **external
condition** waits for a report about a particular operation and artifact version.
A **recovery audit** records a deliberate cleanup after the harness confirms that
the old process stopped or is isolated from the resource.

Choose the relevant sequence:

- **Protect paths for a ticket:** agree on a worktree identity, declare targets
  with `ticket.paths.put`, set `require_reservations:true` when ownership is
  mandatory, then claim/start under a registered run. Required compatible holds
  are acquired atomically with ownership; a failed grant leaves all parts unchanged.
- **Protect an arbitrary resource:** use named reservations, or explicitly acquire
  one or more path targets with `reservation.paths.acquire`. Retain the actual
  holder tokens and lease revisions. Renew timed holds explicitly and release
  only the exact holder you own.
- **Wait for external work:** declare a condition with its operation and artifact
  pin. After the harness observes completion, signal that exact current binding
  with evidence. Required unsatisfied conditions block readiness/start.
- **Recover abandoned work:** first verify stopped or isolated state outside
  Workgraph, read the current ownership guards, then submit the appropriate
  reservation or ticket recovery request. A stale guard must fail; rereading a
  replacement owner does not itself authorize cleanup.

All workspace writes include `workspace_id`, `actor_id`, `mutation_id` and any
applicable `run_id`. Use a saved request for exact retries. IDs, decimal-string
counters, response envelopes and error handling follow the
[shared contract](cli-contract.md). The method links below supply complete schemas.

## Logical paths and overlap

Paths identify cooperative logical worktree namespaces. They do not inspect physical
files or prevent writes. Use an explicit worktree_id shared by every cooperating
caller; run.worktree_ref remains free-form metadata. Callers must canonicalize symlink,
hardlink and case-folding aliases to one lexical identity. No daemon enforcement or
filesystem alias detection is implied. A canceled/expired run need not have stopped.

### Path target

A target has `worktree_id`, `kind` (`file` or `subtree`) and `path`. For example:

```json
{"worktree_id":"checkout-1","kind":"file","path":"src/main.ml"}
```

Paths are relative valid UTF-8, nonempty and at most 4096 bytes. Repeated slashes and
'.' components normalize. Reject absolute paths, '..' components, controls, backslashes
and glob metacharacters * ? [ ]. Worktree root '.' is allowed only for subtree.
Targets compare case-sensitively. A subtree overlaps its descendants at component
boundaries, so src overlaps src/main.ml but not src-other/main.ml. Distinct worktrees
never overlap. Durable replay rejects noncanonical targets rather than normalizing them.

A returned path reservation contains its target, epoch and complete holders.
Each holder records actor/run attribution, token, shared/exclusive mode, lease and
manual or automatic origin. A lease records its own revision, duration and deadline;
indefinite ownership has no deadline. An automatic origin records the exact ticket
claims borrowing it, including their tokens. Borrowers are sorted, unique, nonempty
and bounded to 100. See [acquisition's result contract](api/reservation.paths.acquire.md).

Holders of different runs may overlap only when both modes are shared. Expiry never releases a holder:
incompatible holders, including expired holders, keep blocking until release/recovery.
Acquisition advances the target's epoch. Release retains that epoch and other holders.

### Ticket path policy

A policy records the ticket, its policy revision, target/mode declarations and
`require_reservations`. See [ticket.paths.put](api/ticket.paths.put.md).
At most 100 distinct targets. Requests normalize paths and sort declarations by target;
each target appears once. require_reservations defaults false. Declared paths remain
visible even when optional. Required paths gate readiness and atomically acquire missing
compatible ownership with claim/start/claim_next. Missing invocation run yields a blocker.
Live compatible covering holds are reused; fresh automatic holds are indefinite.
Existing shared holds are never upgraded implicitly, and expired holds are never released
implicitly. Renew timed ownership explicitly or confirm the old process is stopped/isolated
before guarded recovery. A failed grant leaves every proposed claim/attempt/path unchanged.

### External condition

A declaration binds `condition_id` to one immutable ticket/creator, a current
revision, an `operation_id`, an artifact pin, a label and optional recipients.
An artifact or evidence pin uses the tagged objects in
[the condition contract](api/condition.put.md), not an unstructured string. For
example, an external checksum pin has this shape, with an actual SHA-256 digest:

```json
{"kind":"checksum","source":"deployment","digest":"0000000000000000000000000000000000000000000000000000000000000000"}
```

The all-zero digest above is illustrative; replace it with the observed artifact digest. See
[evidence pins](communication-evidence.md#terms-and-workflow) for their purpose.
Returned recipients are distinct and sorted. Label is nonblank UTF-8, at most 4096 bytes.
A condition read returns the declaration, satisfaction state and latest signal, if any.

A signal records its stable ID, exact declaration revision, operation/artifact,
evidence pins, summary and immutable actor/run/time/sequence attribution.
A signal requires 1..100 evidence pins. Its
summary is nonblank UTF-8, at most 64KiB. The supplied signal must match the exact current
condition revision, operation and artifact. It is an attributed cooperative report, not
an authenticated external event. Workgraph never polls or executes an external service.
Every declaration replacement invalidates satisfaction until a signal binds its new
revision. Required pending conditions gate readiness/start. Replacing a running ticket's
condition is visible context; it does not stop the worker. Historical declarations/signals
and evidence pins remain available and are validated against their referenced versions.
The declaration creator and current ticket owner receive deduplicated durable notifications;
extra recipients can be declared. Actual routing is frozen on the transition.

### Ownership recovery

A recovery request names a stable recovery ID, the named/path target, expected
epoch, old run/actor/token, expected lease revision, confirmation (`stopped` or
`isolated`), a nonblank reason and optional evidence. All guard counters are
positive. At most 100 validated evidence pins are accepted; the UTF-8 reason is at
most 64 KiB. The immutable audit retains that request and the recovering actor,
optional run, time and sequence. Use the exact tagged target in
[reservation.recover](api/reservation.recover.md) or
[reservation.path.recover](api/reservation.path.recover.md).

The exact old actor/run/token, reservation epoch and lease revision must still match.
A replacement owner/renewal invalidates the stale guard. Recovery can release expired or
live ownership after an explicit external stopped/isolated assertion. The daemon neither
kills processes nor proves isolation. Stable recovery IDs identify immutable audits;
exact mutation retries return the original receipt. Use ticket.recover's separate lifecycle
contract for ticket claims; these methods concern named/path reservations only.

## Read complete records and pages

Coordination lists accept optional `limit` (default 50, 1..100), `max_bytes`
(default 65536, 4096..1048576), `offset` (default 0) and `expected_revision`.
The data contains whole `items`, `next_offset` and an omission count.
Metadata includes query_scope:"runs",query_revision:"N". Nonzero offset requires the
first page's query_revision as expected_revision. Without a supplied observation clock, pure readiness callers report observation_time_required for timed required ownership; runtime reads use the captured server clock. Lists preserve whole records and fail
Invalid_argument if one cannot fit; increase max_bytes. Keep filters unchanged. Path and
ticket lists use target/ticket order; condition/recovery lists use IDs. Signals use sequence
then signal ID. Record gets accept max_bytes with the same bounds/default and never clip.

## Method rules

### `reservation.paths.acquire`

[Request and result contract](api/reservation.paths.acquire.md).

Acquire 1..32 distinct target/mode requests atomically for an active, actor-owned
run. Optional lease durations are positive milliseconds up to 24 hours; omit the
duration for indefinite ownership. Grants are staged in target order, checking
existing and earlier staged overlaps. Retain each actual returned holder token,
lease and origin, rather than assuming a token or using the collection revision.

### `reservation.path.renew`

[Request and result contract](api/reservation.path.renew.md).

Renew an unexpired timed hold using its target run, target, current token and
lease revision. Renewal preserves token/mode and advances the lease revision.

### `reservation.path.release`

[Request and result contract](api/reservation.path.release.md).

Release only the exact actor/run/token holder for the target. Cleanup remains
permitted after expiry or a terminal run; other holders remain.

### `reservation.path.get`

[Request and result contract](api/reservation.path.get.md).

Read one complete path reservation. Increase `max_bytes` if it cannot fit; gets
never clip a holder record.

### `reservation.path.list`

[Request and result contract](api/reservation.path.list.md).

Page whole reservations, including released targets whose holder lists are
empty. Use the coordination capture rules above.

### `ticket.paths.put`

[Request and result contract](api/ticket.paths.put.md).

Create with `expected_revision:"0"`; edits require the current path policy
revision and no current claim or nonterminal attempt. Declare at most 100 unique
targets. `require_reservations` defaults to false. The returned `revision` is the
coordination projection revision; fetch `ticket.paths.get` for the policy revision.
A declaration is recorded context and never stops an external process.

### `ticket.paths.get`

[Request and result contract](api/ticket.paths.get.md).

Read the complete policy for one ticket, including its own revision and whether
reservations are required.

### `ticket.paths.list`

[Request and result contract](api/ticket.paths.list.md).

Page complete ticket path policies under the coordination capture rules above.

### `condition.put`

[Request and result contract](api/condition.put.md).

Create a condition with revision zero or replace it against its current
declaration revision. Ticket and creator remain immutable. `required` defaults
to true; at most 100 extra actor recipients can be declared. The receipt includes
the declaration and coordination projection revision; use the declaration's own
revision when signaling or replacing it.

### `condition.signal`

[Request and result contract](api/condition.signal.md).

Bind a stable signal to the exact current condition revision, operation and
artifact, with evidence and a summary. Repeating a signal under a fresh mutation
returns its original signal/time/sequence without another signal event only when
all content and actor/run attribution are identical; changed reuse conflicts.
The fresh mutation receipt can have a later workspace revision. An exact saved
mutation retry remains authoritative for the original committed response.

### `condition.get`

[Request and result contract](api/condition.get.md).

Read the complete current declaration, satisfaction and latest signal.

### `condition.list`

[Request and result contract](api/condition.list.md).

Page complete current conditions, optionally filtered by ticket.

### `condition.signals`

[Request and result contract](api/condition.signals.md).

Page one condition's immutable signals in sequence then signal-ID order.

### `reservation.recover`

[Request and result contract](api/reservation.recover.md).

Apply the guarded recovery described above to a named reservation. The target
uses `kind:"named"` and `reservation_id`. Retain the immutable returned audit.

### `reservation.path.recover`

[Request and result contract](api/reservation.path.recover.md).

Apply the guarded recovery described above to a path reservation. The target
uses `kind:"path"` and its nested path target. Retain the immutable returned audit.

### `recovery.get`

[Request and result contract](api/recovery.get.md).

Read the complete immutable named/path recovery audit by recovery ID.

### `recovery.list`

[Request and result contract](api/recovery.list.md).

Page immutable named/path recovery audits using coordination captures.

### `ticket.recover`

[Request and result contract](api/ticket.recover.md).

Recover a ticket claim using its exact ticket revision, old actor, old run
(including explicit null when absent), claim token and lease revision. Supply a
stable recovery ID, stopped/isolated confirmation, required `disposition`, reason
and optional evidence. Use `disposition:"requeue"` to clear the claim and return
the ticket to `todo` in one transaction, clearing any custom status identity.
Use `disposition:"preserve_status"` to clear ownership while retaining status.
An unowned `in_progress` ticket remains excluded from ready work; requeue it
explicitly when another worker should pick it up.

Both dispositions cancel only matching active attempts, release the exact
automatic claim borrowers and pool occupancy, and preserve holds, progress,
previous evidence, terminal attempts, sibling borrowers and manual reservations.
A retained hold still blocks readiness/start after requeue. The immutable audit
records the chosen disposition. Recovery terminates no process. Reused recovery
IDs conflict; exact saved mutation retries return the original receipt. Stale
guards never release replacement work.

### `ticket.recovery.get`

[Request and result contract](api/ticket.recovery.get.md).

Read the complete immutable ticket recovery audit. It retains the request,
recovering actor/run, time and sequence; metadata carries `workspace_revision`.
`max_bytes` accepts 4096..1048576.

### `ticket.recovery.list`

[Request and result contract](api/ticket.recovery.list.md).

Page complete ticket recovery audits in recovery-ID order, optionally filtered
by ticket. Unlike named/path audit lists, a nonzero offset requires the first
page's `workspace_revision` as `expected_revision`, not a coordination query
revision. Preserve filters and restart the capture on conflict.

## Declare paths before claiming work

Use the matching executable in `WG` and an existing agent context in `CONTEXT`.
The context supplies connection/attribution and a private request journal. This
example requires an existing unclaimed ticket `task`; every cooperating caller
must agree that `checkout-1` names the same worktree.

```sh
"$WG" --context "$CONTEXT" request ticket.paths.put \
  --ticket-id task --expected-revision 0 --require-reservations true \
  --json-field declarations '[{"target":{"worktree_id":"checkout-1","kind":"subtree","path":"src"},"mode":"exclusive"}]'
"$WG" --context "$CONTEXT" request ticket.paths.get --ticket-id task
```

Zero creates a new path policy; use the observed policy revision for replacement.
A declaration alone creates no holder: ownership arrives with claim/start or an
explicit acquisition. After ownership is acquired, use `reservation.path.get` with
the same target to inspect its actual holders. Before first acquisition that
reservation read can return `Not_found`. Retain exact saved writes for uncertain
outcome recovery.

## Automatic borrowers and explicit release

Explicit named/path acquisitions are Manual. Claim/start/claim-next create missing
required indefinite Automatic holds and attach exact claim borrowers to reusable automatic
covering holds. Compatible covering Manual holds remain Manual. Sibling claims can borrow
one automatic hold; finish/release/reassignment-away/guarded recovery remove only the
matching borrower and release an automatic hold only when its final borrower exits. Manual
ownership and sibling borrowers survive. Expiry or terminal run status alone never deletes
holds. Direct release/recovery of borrowed holds rejects until permitted claim cleanup.
Ordered batches can start then finish, or release then change paths then reclaim. Ticket
path policy is frozen under a claim or nonterminal attempt; declare at most 100 targets.
Cleanup events name exact changed covering targets (at most 200), validated again on
replay; a child declaration is not proof that only the narrower child hold changed. Typed
reservation conflicts identify requested target and bounded owner metadata with exact
omitted counts, excluding fence tokens.

## Wait for a contended reservation

The local `reservation wait` / `reservation paths wait` helper requires `--request-directory
ABS_EXISTING_PRIVATE_DIR` and the original acquisition fields. `--wait-ms` defaults to 30000
(1000..300000), `--max-attempts` defaults to 32 (1..100), `--wait-slice-ms` defaults to 1000
(1..25000). It captures the planning feed before acquisition and syncs an exclusive exact
journal before each attempt. Only definite typed reservation contention on an original
requested target permits another identity after wake/timer; original guards and atomic
batch stay fixed. Other errors, uncertainty, invalid/nondurable replies and save failures
stop. It never recovers expiry, renews ownership, promises fairness or changes processes.
Check exit status and result.data.wait.completed, then use result.data.daemon_response for
the actual receipt. After uncertainty retry the exact saved_request; retry does not rerun
the helper.
