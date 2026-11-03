# Workgraph feedback implementation contracts

Status: accepted design; implementation and qualification in progress. This document
does not claim the candidate has passed release qualification. The coordination
workspace uses the independently installed **0.4.0** release throughout development.

## Purpose and boundaries

Remove repeated agent friction from the v0.4 findings while preserving a lightweight
local state service. Improve startup, ownership, idle behavior, readable evidence,
client discovery, questions and context recovery. The harness owns model processes,
external side effects and context policy. No MCP server, database replacement,
distributed scheduler, authentication claims or compatibility readers are added.

All admitted changes must preserve serialized planning, durable publication before
acknowledging a committed write, immutable evidence, exact successful retry identities,
uncertain-write fencing, validation of public inputs and independent durable replay.
Only the current candidate schema is supported. The integrated identifiers are
package 0.5.0, API 0.5 and affected stored roots 4; unchanged independent formats
remain 1. The development tracker is never opened by candidate code. Native targets
remain macOS ARM64 and AlmaLinux 10 x86_64 (including WSL use).

## Confirmed existing capabilities

Independent packaged-0.4 probes confirm journal diagnostics are on stderr, contexts
supply admitted invocation run defaults, fact list/keys support prefixes, request get
can expand messages, resources expose metadata titles, and large resources can be
uploaded/downloaded. Evidence run already returns stage/capture metadata, rejects an
existing stage, and publication rejects missing/empty stages. Provenance records its
omissions and does not report unchanged identity from a partial observation.

Preserve these behaviors and add focused regressions/discovery improvements. Recovery
already exists with exact guards and a stopped/isolated assertion. Duplicate active
attempts already reject. Investigate reports of eventual visibility or lost pages with
captures rather than introduce speculative cache fixes. Named capacity pools and
run active-attempt budgets already exist and should be exposed before duplicated.

## Runtime and acquisition

1. Acquire a socket-path-scoped lifetime ownership guard before binding or recovering.
   A recognized prior socket may be removed only under that guard with an exact native
   identity match. Refuse foreign/live/bound/replaced/unknown paths. Registry lock,
   PID lookup and connection refusal alone are insufficient. Keep guard identity stable
   across processes and native operations inside Platform. A crash before identity
   publication may conservatively refuse recovery; document and test that boundary.
2. Bootstrap reports actual readiness, bounded startup failure and timeout using the
   child's observed state. Do not mistake socket existence for recovered service
   readiness or a harness killing detached children for a successful persistent start.
3. One pure acquisition assessment serves direct claim/start/reassign, attempt start,
   automatic allocation, eligible-work reads and replay. Constrained capability work
   requires a registered compatible run. Pool occupancy counts each allocated ticket
   once (claim or nonterminal attempt); starting its attempt does not double-charge.
   Optional allowed actors are cooperative scheduling policy, not access control.
4. A standalone empty allocation is an explicit nondurable observation: no new head,
   receipt, attempt, bytes or change notification. Retrying that empty identity may
   re-evaluate; once selection commits, exact retries return its original receipt.
   Same-attempt recovery must validate the original semantic operation, never adopt a
   replacement claim. Client and CLI accept nondurable results only for this precisely
   validated outcome. A deliberate transaction batch still has its durable receipt.
5. Required automatic path holds retain exact claim borrowers. Finishing, releasing,
   reassigning away or guarded recovery removes that borrower and releases an automatic
   hold only after its last borrower is gone. Manual/reused manual holds remain manual.
   Expiry and terminal run status do not prove the external process has stopped.
6. Acquisition receipts return actual grants/tokens/leases. Conflicts name bounded
   conflicting paths and holders. Filters run before paging. Reservation waiting is a
   bounded client helper, with fresh attempts only after definite contention and exact
   retry retained for uncertainty; no persistent fairness queue is promised.

## Client contract

- Resolve offline help before opening context or performing I/O. Support helper help,
  family/action help, catalog-validated dotted/nested forms and useful typo suggestions.
  Preserve literal child argv after `--`. Show concise examples and real response paths.
- Preserve `result.data`/`result.meta`, distinct domain IDs and exact retry receipts.
  Return useful resulting run state and ownership/answer references rather than fake
  universal ID/status fields. Scripts must check exit status before extracting JSON.
- Add a typed summary view without making full ticket context silently incomplete.
  Include bounded current decisions, handoff and expandable references. Observer
  contexts may omit write identity; this is convenience, not enforced read-only access.
- Permit one explicit stdin source for parameter/text input, materialized and validated
  before journaling. Preserve exact bytes/newlines, bounded reads and cancellation;
  arbitrary filesystem devices/FIFOs remain outside the regular-file input contract.
- Updating resource text may omit title to preserve existing metadata under its exact
  entity guard. Creation still requires title. Name entity revision versus content
  version clearly; evidence pins always bind immutable content version/digest.
- Provide verified large-resource text/byte output without hand-decoding chunk base64.
  Streaming stdout can emit a prefix before a final integrity error; document this and
  provide a verified/spooled option when all-or-error delivery is required.
- Continuations carry method, scope, filters, capture and next position. Never replace
  a stale capture with the latest revision silently. Explain required guards, actual
  limits/bytes, missing ownership attribution and omitted blocker counts explicitly.
- Plan preflight reuses actual preparation/validation without commits or side effects.
  Examples demonstrate atomic resource/fact/result plus ticket finish. Large plans
  are not silently split while claiming all-or-nothing semantics.

## Questions, notifications and attention

Resolved requests store an optional exact answer comment/version in their terminal
state. Capture question references too. Resolve receipts expose request/thread revisions
and the answer reference; direct reads provide a bounded pinned answer. Plain resolve
without a body has no answer. Later comment edits never rewrite the delivered answer.
Notifications retain exact causal body references; metadata changes do not borrow an
unrelated latest message. Validate pins against discussion at event boundaries and on
replay, including scope, attachment, resolver and version.

Generic threads default to manual closure. Question-created threads opt into closure
when all their requests are terminal. Resolving/canceling one request does not close a
thread with open siblings. Expose priority and the existing deadline primitive on ask;
guard edits and cross-thread related/supersedes links. Supersedes is acyclic and does
not implicitly cancel the earlier request. Existing same-thread reply relationships
remain distinct.

An actor overview composes held claims/attempts, named/path reservations, incoming open
requests, outgoing waiting requests and explicitly selected unread consumer state.
Use one bounded captured view with tagged rows and honest omissions. Inbox acknowledgement
never resolves a request; reading never acknowledges either.

Unified attention reads/waits select project, communication recipient/consumer,
source kinds, fact scope/prefix and ticket/run scope. Return typed exact-source changes
and grouped communication rows with every underlying notification ID available for
explicit acknowledgement. Group by logical operation, never matching message text.
Cursors bind filter, lineage, capture and row/fragment position, including several
logical events in one transaction. Unmatched ranges advance scanning safely; oversized
rows preserve position and explain the required budget.

Keep readiness semantics small and explicit: report a captured current eligible-work
view when relevant changes invalidate readiness, not a claimed history of every
transient ready/unready edge. Include prerequisite, policy, pool and reservation effects
on dependent work. Do not reconstruct the entire workspace history on each idle wait.
Wait outside the serialized writer, recheck after wakes, prevent the read/park race,
and remain parked for unrelated changes. Timeout/disconnect releases resources. No
polling allocation, automatic acknowledgement or external callback execution occurs.

## Instruction changes and secondary workflow primitives

- Immutable ticket amendments carry text or exact resource pins, optional required
  acknowledgement and explicit supersession/withdrawal history. Acknowledgement binds
  the current actor/run/claim token and amendment version, not the ticket revision
  that ordinary progress changes. Gate every completion path and replay; renewed
  ownership/progress does not invalidate an acknowledgement, a new claim does.
- Parent prerequisite inheritance is opt-in and inherits prerequisite conditions,
  never parent ownership or its unfinished-child gate. Canceled children remain
  blocking unless an explicit parent completion policy permits them. Canceled
  prerequisites still require satisfaction or an attributed waiver.
- Project completion checks aggregate unfinished/owned/gated work in one capture.
  A guarded project finish records structured handoff and status atomically. All
  equivalent Done transitions enforce the same declared completion conditions;
  no automatic ticket completion, request resolution or process termination.
- Extend fact queries with at most eight ANDed scalar-equality JSON-pointer predicates
  (bounded path/depth; missing differs from null). Numeric equality uses the documented
  canonical representation, without float conversion. Up to 32 typed ticket/resource
  navigation references support reverse lookup; omitted references preserve existing
  ones, empty clears. Validate existence/aliases/replay. Exact proof remains evidence
  pins rather than a freely editable `verified` fact convention.
- Reuse immutable usage reports for scoped rollups and up to 16 named nonnegative
  integer measurements with explicit units. Deduplicate by existing usage identity,
  expose overflow and unallocated run spending, and never invent per-ticket costs.
  Existing token/elapsed budgets keep their meanings; no second metrics database.
- Preserve existing active-attempt controls; add a distinct bounded active-claim
  policy only where direct claims require it. Assignees remain advisory unless an
  explicit eligibility rule says otherwise.

## Evidence, exports and documentation

Provide decoded bounded evidence inspection, output ranges/tails with truthful
retention metadata, prominent provenance coverage, explicit source selection, and
convenient ticket linking. A selected-source identity covers only that declared set.
Never relabel a retained prefix as a tail or partial provenance as whole-tree proof.
Cleanup is explicit for a validated owned stage; no overwrite, broad prune or deletion
of foreign/live/published evidence. Retrying publication never re-executes a command.

Readable exports include every handoff field, attributed decisions and history events
with complete-byte references. Render from immutable captures and verified blobs,
bound previews honestly, inventory hashes, preserve cancellation and portable replay.

The final README incorporates all substantive content from the supplied team HTML:
concepts/selection table, platforms/install/reset, setup and connection prompts,
all eight use cases, atomic workflows, capabilities/pools, wgx installation and all
views, transcript ingestion/search, inspection, exports/restoration and limitations.
Correct unsafe socket removal, stale command advice and unsupported historical claims.
Keep historical measurements labelled as observations. Export user-visible transcript
messages/tools only, never private model reasoning. Include the complete maintained
helper script or a complete inline installation source as appropriate to the README.
Focused agent/API docs and packaged skills/workgraph/scripts/allowlists stay synchronized.

## Implementation and acceptance

Workgraph project `dev` in workspace `feedback-05` owns the live ticket graph, source
feedback, design resources, prompts, decisions and evidence. Workers use GPT-6.1 Sol
with high reasoning, isolated Git worktrees and explicit path reservations. Root
reviews every change before integration. Area-reviewed slices may start after their
own prerequisites; global review, documentation and qualification gates remain strict.

Every property has meaningful focused tests: public malformed inputs, independent
replay, exact retry, atomic rollback, competing claims, immutable captures, wait races,
socket ownership, real CLI streams and byte/cursor boundaries. Review tests for actual
failure detection and avoid redundant implementation-mirroring assertions. Run the
formatter and `./dev build @fmt @runtest @install` on the integrated candidate, then
real multi-agent/recovery/export workflows and native installed-package checks.
Record exact commands, exit statuses and limitations. No unresolved blocker/major
review findings at acceptance. Publishing a release is a separate user instruction.
