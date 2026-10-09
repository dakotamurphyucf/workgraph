# Capacity warnings and selected rollover acceptance

The public `Admission` interfaces define exact 50/80/95-percent advisory bands,
validated units/headroom, cumulative versus temporary lifetimes, binding-meter
refusals with proposed total utilization, and a three-meter health summary.
Health captures immutable planning counters at load/commit and cached storage/upload
counters at read, without workspace file scans. Existing admission guards and
publication ordering remain authoritative.

Focused checks executed with the pinned toolchain:

```sh
./dev runtest --build-dir=_build-discovery -j2 test/admission test/administration_api test/metrics
./dev runtest --build-dir=_build-discovery -j2 test/capacity
```

The expect tests cover exact threshold boundaries, independently malformed meter
fields, bounded summaries and typed capacity diagnostic roundtrip/negative-counter
rejection. The real daemon tests hide a planning head during advisory health,
exercise all upload-slot bands and both binding upload refusals, compare authoritative
counters before/after refusal, and verify an export while staging is full.

The executable rollover test creates selected parent/prerequisite links, an omitted
external dependency, scoped facts, linked exact resource bytes and a rich handoff.
It also creates an active run/attempt and an approved current review submission.
The recipe verifies an export, closes the predecessor and creates a fresh successor.
Assertions verify rewritten graph IDs, copied values/bytes/handoff context, explicit
predecessor digest/reference and omissions, held successor tickets, absence of claims,
attempts/runs/submissions, exact saved-request replay, and recoverable predecessor
claim/approval after explicit reopen. No large saturation workload or native-platform
qualification is claimed by these focused checks; the final integration gate runs
the repository-wide suites.

Operator procedure and executable invocation are in
[capacity and rollover](../agent/capacity-rollover.md). Only the current API/export
format is used; no historical-format compatibility path is introduced.
