# Pinned artifacts, reviews and decisions

`Evidence` is an immutable pure planning-domain state machine. Its current tagged
`Evidence_event` schema rejects unknown fields, malformed counters and unsupported
format tags. There is one pre-release schema, with no compatibility or migration
readers. Results become visible only through the existing durable planning commit.

Contracts pin an existing resource revision and SHA-256 digest that documents the
schema. Built-in schema version `1` requires explicitly named input/output fields;
unsupported versions and missing required artifacts reject publication atomically.
Schema resources describe richer external contracts without embedding an arbitrary
validation language. Names have the existing 1..96-byte opaque-ID syntax. Each
contract has at most 100 required inputs and 100 required outputs.

Manifests bind one attempt and ticket to an exact contract revision and named
input/output pins. Each list contains at most 100 distinct named artifacts. Pins
are closed typed alternatives: exact resource revision/digest, committed session
Event_ref, Git repository/object ID, SHA-256 source/checksum, exact comment version,
contract version or decision version. Digests require 64 lowercase hex bytes; Git
IDs accept 40 or 64 lowercase hex bytes. Resource/event/comment existence is checked
against final immutable domain/session captures. External Git/checksum references
are declared provenance with validated syntax; Workgraph does not perform network
or external filesystem validation for them. Later resource publication cannot alter
older pinned manifests. Manifest revisions preserve exact historical provenance.

Acceptance policies are revisioned at project and ticket scope. The
[effective policy](api-reference/acceptance.policy.effective.md) composes both for
current work and explains inherited overrides, including stale ones. Policies can
require named reviewers or roles with frozen member IDs, submitter/reviewer
separation, named validators and identified acceptance criteria. Role membership
is declared local coordination data, not authentication or proof of independence.

Use [acceptance.policy.put](api-reference/acceptance.policy.put.md) for the complete
scoped policy. [review.policy.put](api-reference/review.policy.put.md) updates the
ticket's review fields while preserving its criteria and inherited override.
Weakening requires an attributed reason. An inherited override binds the observed
project policy version and ticket membership revision; moving away and back or
changing the project policy cannot silently reactivate it. Stale overrides are
disclosed and current inherited requirements apply. Read the effective policy
before starting or completing work.

A required criterion needs a passing [acceptance assertion](api-reference/acceptance.assert.md)
with exact evidence pins. Assertions bind the current effective policy, ownership,
reopen fence and, when present, the current attempt and manifest/artifacts. Ordinary
work without a manifest can still supply exact pinned evidence. New ownership,
replacement attempts, changed outputs or changed policy invalidate older proofs.
Omitting an optional manifest cannot bypass an existing output binding.

Submissions bind the latest ticket output to the exact manifest, contract and
composed effective policy, current ownership and reopen fence. A submission generation identifies the review subject; a separate
lifecycle revision guards pending/accepted/changes-requested transitions. Reviews
and external validator results are immutable records tied to exact versions.
Acceptance requires every configured reviewer/role requirement and the latest
passing result from every required named validator. A later failed validator
cannot be hidden by an earlier passing result. Rejection requires a new submission
generation. Changed outputs, contracts or policies require current matching evidence.
An explicit review_request_id preserves an existing actionable request. Without one,
State stages a review board, linked thread, discussion message and actionable review
request for the frozen named actors and role members in the same transaction. The
request correlation records exact manifest and contract references. A request-changes
verdict atomically adds a reply request to the submitting actor and run.
The reply's discussion body preserves the exact rejection evidence, including the
64KiB text boundary; its typed request stores correlation separately. Acceptance
resolves its linked review request when the caller is the designated resolver;
recipient acknowledgements and responsibility acceptance remain independent.

Completion checks the current acceptance gate both while staging completion and
against the final transaction candidate, including raw ticket.update/category Done.
Tickets without review or criterion requirements preserve ordinary completion
semantics. An ordinary registered attempt can complete with evidence and no
manifest. When configured review or validation gates require a manifest, publish
the attempt's current inputs and outputs and satisfy the gates against that exact
manifest. Existing artifact bindings cannot be bypassed by omitting a manifest.
An earlier attempt's approval cannot authorize its replacement, including a new
attempt under the same claim. Already completed tickets retain their status and historical accepted pinned evidence after
later input/policy mutations; Workgraph records reconciliation/attention information.
An explicit reopening and later recompletion checks current requirements. Workgraph
does not automatically reopen tickets or reinterpret their prose.

Decision records link scope, rationale/evidence pins, affected entities and explicit
superseded decisions. Supersession cycles reject publication. Contract/decision
updates and atomic resource publication/comment revision input.changed events create reconciliation records
for precisely the latest declared manifests consuming the old pin. Repeated identical
changes do not duplicate reconciliation records. Acknowledge, justified continued
use, and a new manifest consuming the replacement input are distinct dispositions.
They preserve old pins and all review/validation history. Pending reconciliation
blocks acceptance for a gated attempt; acknowledging it does not itself replace an
input or manufacture a review for a changed manifest/contract.
Live consumers require their current ticket claim and lease when recording a
disposition. A terminal consumer's recorded actor and run may acknowledge or justify
continued historical use without the obsolete claim token. These dispositions do
not revise artifacts or change replacement-attempt ownership; revised manifests
remain restricted to live consumers with current ownership.

Exact public inputs and outputs are generated from the executable:

- [Contract publication](api-reference/contract.put.md) and [manifest publication](api-reference/manifest.publish.md), including named tagged pin objects.
- [Submission](api-reference/review.submit.md), [review verdicts](api-reference/review.record.md), [validator results](api-reference/validation.add.md) and [acceptance](api-reference/review.accept.md).
- [Decisions](api-reference/decision.put.md), [input changes](api-reference/input.changed.md) and [reconciliation](api-reference/reconciliation.record.md).
- [Evidence context](api-reference/evidence.context.md), [gate explanation](api-reference/review.gate.md), [policy](api-reference/acceptance.policy.get.md) and [assertions](api-reference/acceptance.assertions.md).

Public alternatives use named `kind` objects and lowercase enum values. Durable
event encodings are separate and must not be copied into requests. Unknown or
duplicate fields reject decoding. Evidence/proof records and their page items fit
as complete records under a byte budget; if one complete record cannot fit, increase
`max_bytes`. Their policy digests and exact artifact bindings are never clipped.
Use returned page fences and offsets when retrieving history.

`State` validates current attempt/run actor ownership and actual ticket
claim tokens before manifest, submission, acceptance or reconciliation writes.
Resource publication and its input-change record stage in the same planning
transaction. Session references are validated against an independently committed
immutable journal capture through State.validate_history; no Store I/O runs inside
Evidence. `State` owns ticket/readiness semantics; transport and persistence layers
handle durable receipt retries.

Focused expect tests cover version-bound acceptance, roles/separation, rejection,
validator replacement, exact old-pin consumers, preserved provenance, contract
updates, decision cycles, malformed schemas/references/events, wire codecs and
50 independent consumer/replay property fixtures.

Shared State integration routes typed evidence/run/policy commands and exposes
bounded evidence, attempt and communication sections in ticket.context. Project
briefs include scoped/linked communication metadata. Resource replacement and
comment revision replay require the exact adjacent resolved input-change event;
missing or mismatched companions reject as corruption. New completion replay also
checks the final acceptance gate. Existing completed history remains immutable.
