# Final premerge review

On 2026-10-09, the primary reviewer examined the implementation against the
approved WG01–12 plan and engineering standards, supported by three GPT-6.1 Sol
reviewers using high reasoning and one independent Astra reviewer. The review
covered the changes from `main` at `8092991` to candidate `adf5c22`, followed by
the corrections below. The primary reviewer inspected the corrections personally.

## Findings corrected

| Finding | Correction and regression coverage |
| --- | --- |
| Reopening was reported as an ordinary task change in activity digests. | Classify the source reopening explicitly; test dependent reassessments, subsequent edits and captured cursor continuity. |
| A valid 65,536-byte reopening reason overflowed generated comments after their prefixes were added. | Preserve the full immutable reason and bound generated UTF-8 excerpts with an explicit truncation notice. Test the maximum reason size and replay. |
| Replay could accept a reopening with its dependent effects removed. | Share a pure reopening expansion between preparation and replay; require exact contiguous reassessments, decisions and claimant notifications. Independently remove effects and alter prose/routing in regression fixtures. |
| Reopening the same source twice in one batch could collide on notification identity. | Include the source ticket revision in the deterministic identity. Test both reopenings and a later metadata edit in one transaction. |
| Evidence replay could accept actor/run attribution rejected during preparation. | Recheck active attempt ownership and the current claim, preserving terminal reconciliation exceptions. Test forged attribution and valid manifest, submission, acceptance and reconciliation replay. |
| Public acceptance-policy S-expression decoders bypassed domain validation. | Apply the same validation and canonicalization as JSON codecs, including effective-policy digests. Test independently malformed values, forged digests, valid round trips and canonical reviewer ordering. |
| An agent workflow recipe used obsolete optional field names and null values. | Describe omission of absent `review_request_id` and `comment_id` references. |
| Native packages omitted `AGENTS.md`, which their README links to. | Include it in native and RPM documentation; test real packaging, source/native agreement and more than 100 relative offline documentation links. |
| Ready-order documentation described creation sequence instead of per-ticket creation order. | Correct the API guide, planning guide and public interface to include ordering within a batch. |

## Validation and limits

The fresh baseline full gate passed before these findings were corrected. That
result alone did not demonstrate the edge cases above; focused regression tests
were added for the corrections. After applying the pinned formatter, the full
macOS ARM64 gate passed:

```sh
./dev fmt
./dev build @fmt @runtest @install --force
```

The main integration suite passed all 68 cases in 28.637 seconds. Additional
native expect tests, daemon/socket feature tests, harness tests and packaging
checks passed as part of the same gate. The nine packaging tests included the
new offline-link check; generated-reference validation checked 238 methods and
240 files. `git diff --check` also passed. No test expectation was promoted to
accept an invalid behavior.

This review does not qualify previously built release archives for the corrected
source. Rebuild and qualify macOS ARM64 and AlmaLinux 10 x86_64 packages from the
final release candidate before publication. Native package execution, actual WSL
behavior and macOS signing/notarization are separate from build-tree tests.
No merge or release publication is part of this review.
