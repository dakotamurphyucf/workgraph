# Acceptance policies and exact evidence

Acceptance policies state which recorded checks must pass before a ticket can
complete. Workgraph records attributed claims and exact provenance. The harness
runs commands, obtains external approvals and decides whether a claim is true.
Workgraph neither executes validators nor interprets criterion prose.

A policy belongs to a project or a ticket. Its scope is an explicit object:
`{"kind":"project","project_id":"app"}` or
`{"kind":"ticket","ticket_id":"change"}`. A ticket inherits its current
project policy. Enabled project and ticket policies compose: reviewer requirements
are conjunctive, validators are combined, and actor separation applies if either
policy requires it. Disabling a ticket policy does not disable inherited checks.

Each criterion has a validated ASCII key, a nonblank description of at most 4096
UTF-8 bytes, and a `required` Boolean. Optional criteria appear in policy reads but
do not block completion. A criterion reference includes scope, policy revision and
key; equally named project and ticket criteria remain distinct.

## Updating and reading policies

| Method | Required method parameters |
| --- | --- |
| `acceptance.policy.put` | `scope`, `expected_revision`, `enabled`, `reviewers`, `separate_actor`, `validators`, `criteria` |
| `acceptance.policy.get` | `scope` |
| `acceptance.policy.effective` | `ticket_id` |
| `review.policy.put` | `ticket_id`, `expected_revision`, `enabled`, `reviewers`, `separate_actor`, `validators` |

Mutations also require the standard workspace, actor and mutation identity;
`run_id` supplies optional run attribution. Counters are canonical decimal strings.
An initial policy uses `expected_revision:"0"`. Full updates replace the identified
scope's definition. `review.policy.put` updates only review fields of the same
canonical ticket definition, preserving its criteria and inherited override.

Reviewer requirements are `{"kind":"actor","actor_id":"reviewer"}` or
`{"kind":"role","name":"security","member_ids":["alice","bob"]}`.
Every named actor and every role must approve; one approving member satisfies one
role. A scope allows at most 100 requirements, 100 validators and 100 criteria.
A role has 1 through 100 distinct members. Names and criterion keys are unique.

Removing a required criterion, changing its description, removing a reviewer or
validator, disabling requirements, or relaxing actor separation requires a
nonblank `weakening_reason`. Widening a role's eligible membership also weakens
its requirement. Narrowing membership or adding requirements strengthens it.
Every successful policy update creates a new version and invalidates older proof
bindings, even when the effective requirements otherwise look identical.

A ticket may include an `inherited_override` with these fields:

- `against`: the exact project `scope` and `revision`.
- `membership_revision`: the ticket’s current positive membership revision.
- `reviewers`, `validators`, `criteria`: exact inherited requirements to waive.
- `waive_separate_actor`: whether to waive inherited actor separation.
- `reason`: the attributed, nonblank reason for the exception.

A new or changed override must name the current project version, membership revision and actual
inherited requirements. The mutation also supplies `weakening_reason`. A later
project edit or ticket move makes the override stale. Tickets begin at membership
revision 1; every actual project change increments it, including moves affecting
descendants. Moving away and back never restores an old waiver. Effective reads disclose
that stale override and reapply current inherited requirements. Stored historical
waivers are never silently carried onto different work.

Evidence policy/proof reads preserve complete records and their binding digests.
Byte budgets remove whole page items; an oversized direct record or first item
returns `Invalid_argument`, requiring a larger `max_bytes`.

## Assertions and work identity

`acceptance.policy.effective` returns the current sources, composed requirements,
applicable or stale override and a SHA-256 `digest`. Read it before doing work and
again when recording a check. `evidence.context` also returns this effective
policy and each historical assertion’s current status before work starts. Policy bindings include ticket, project, source
versions, membership revision, ownership token and reopening fence. A membership, policy, ownership or
reopen change invalidates an older binding. Reviews and validator results also
require the latest attempt under the current claim; starting a replacement and
cancelling it does not restore approval of an earlier attempt.

`acceptance.assert` requires:

- `ticket_id`, the current positive claim `token`, and `expected_policy_digest`.
- A `criterion` containing its scope, `policy_revision` and key.
- `passed`, nonblank `evidence`, and 1 through 100 exact `evidence_pins`.

When a current attempt or ticket manifest exists, include its exact `attempt_id`
or `manifest` reference. Omitting an existing target is rejected. The stored
assertion binds the current attempt, current manifest and its input/output pins.
An ordinary ticket can use exact comment, resource, event, commit or checksum pins
without manufacturing an empty manifest. Changing existing outputs or declaring
replacement of consumed evidence invalidates previous assertions.

For example, after reading the effective digest and acquiring token 1:

```json
{
  "ticket_id": "change",
  "token": "1",
  "expected_policy_digest": "<digest from acceptance.policy.effective>",
  "criterion": {
    "scope": {"kind":"ticket","ticket_id":"change"},
    "policy_revision":"1",
    "key":"tests"
  },
  "passed": true,
  "evidence_pins": [{"kind":"comment","comment_id":"test-results","revision":"1"}],
  "evidence":"The recorded test results satisfy this criterion."
}
```

`acceptance.assertions` takes `ticket_id`, optional `criterion`/`attempt_id`, and
normal evidence pagination. It returns immutable assertions with a `current`
flag. Completion requires the latest current assertion for every required
criterion to pass. A later failure overrides an earlier pass.

Review submissions, reviews and validator results bind the full effective policy,
exact manifest and contract. `validation.add` requires the observed
`expected_policy_digest`; saving a result never infers which observed policy the
harness tested. Configured review or validator gates still require an accepted
submission of the completing attempt's manifest. Ordinary work without configured
requirements remains manifest-free.

Public pins are named objects with lowercase `kind` values (`resource`, `event`,
`commit`, `checksum`, `comment`, `contract`, `decision`). Resource pins carry
`resource_id`, `revision` and a lowercase SHA-256 digest. Contract and manifest
references carry `contract_id` or `manifest_id` and `revision`. Durable event
encoding is a separate internal contract.

Preparation validates ownership and current bindings against the immutable
planning capture. Independent replay repeats those checks at each event boundary;
final batch validation repeats completion checks after every staged mutation.
Historical evidence remains readable after it becomes ineligible.
