# Workgraph 0.6 current operating contracts

Package 0.6.0 targets API 0.6, affected roots 5 and upload plan 2. Independent
planning/history heads, history batches and heartbeat cache retain format 1.
Read the [breaking upgrade](releases/v0.6.0.md#upgrade-from-05-or-an-older-preview)
before replacing an older executable. This records operating contracts, not a
claim that final package/platform/publication gates have passed.

| Task | Required boundary | Focused guide |
| --- | --- | --- |
| Join an existing workspace | Own actor/context/journal; existing socket/workspace ID; no second managed workspace or fake run | [Setup](../skills/workgraph/references/getting-started.md) |
| Construct requests | Typed JSON for objects/arrays/null, explicit byte files for text; check command exit before consuming output | [CLI](../skills/workgraph/references/cli-contract.md) |
| Install an allocation gate | Policy revision0 before creation, then its own current revision; publish ticket+gate atomically when coupled; never dispatch after a failed write | [Coordination](../skills/workgraph/references/coordination.md) |
| Find eligible work | Graph readiness differs from candidate actor/capability checks and actual registered-run resource/budget checks; no fake probe invocation | [Planning](../skills/workgraph/references/planning.md) |
| Read participants | Catalog registration differs from retained attributed writing; named recipients alone are not observed writers | [Participants](../skills/workgraph/references/coordination.md#discover-participants) |
| Inspect waiting work | Exact captured age/unknown clock and held counts are advisory; harness verifies stopped/isolated before recovery | [Observation](../skills/workgraph/references/coordination.md) |
| Recover a ticket | Explicit preserve_status/requeue disposition, exact guards, atomic cleanup; hold remains | [Recovery](../skills/workgraph/references/path-conditions-recovery.md) |
| Wait for a reservation | Actual holder/fence authoritative; explicit begin/refresh/close notes; TTL/estimate never grants or renews | [Contention](coordination-guide.md#make-shared-database-contention-visible) |
| Read complete collections | Preserve exact guard/cursor and source/filter/first capture; expand byte budgets or immutable detail refs without advancing past omitted content | [Pagination](../skills/workgraph/references/cli-contract.md) |
| Ask and answer | Reuse a discussion explicitly, designate resolver, expand request.answer exact pin; reassign responsibility never changes resolver | [Questions](../skills/workgraph/references/communication-evidence.md) |
| Publish evidence | Immutable bytes/version/digest plus metadata/link revisions; discover/recover upload stages with exact saved plan | [Resources](../skills/workgraph/references/resources.md) |
| Apply templates | Canonical pinned resource, preview expanded operation count/placement/actor policy; one transaction of at most 32 operations | [Templates](../skills/workgraph/references/coordination.md) |
| Share inputs | Pin versions/digests and use explicit cache coverage; bounded scratch stays harness-owned, never managed storage | [Shared work](../skills/workgraph/references/team-workflows.md) |

Small facts store summaries and links, not append-only reports. Their 4096-byte
canonical cap covers the whole replacement value. Keep about 1 KiB headroom for
later fields; put longer findings and verification evidence in versioned resources.
JSON null is an intentional value and is not deletion. Use explicit fact deletion
when deletion is intended and validate constructed JSON before sending.

A dispatcher documents lead-only vs verifier roles and compares overlapping
findings before constructing positive eligible-actor policies for independent
review. The daemon cannot infer authorship conflicts across duplicate findings.
The harness owns bounded provider backoff, crash-loop brakes, foreground waits,
process supervision and source checkout isolation. Workgraph records actual
invocations and cooperative ownership; it does not execute or stop them.
