# Integrated validation

On 2026-10-09, the pinned macOS ARM64 toolchain passed:

```sh
./dev fmt
./dev build @fmt @runtest @install
```

The whole-tree gate includes native expect tests, independent malformed-input and
replay fixtures, real daemon/socket tests, CLI context and journaling checks,
reference harness tests, package-verifier fixtures and generated documentation
checks. The main Python integration suite passed all 68 cases in 24.284 seconds;
focused feature suites are additional. This is build-tree validation, not installed
artifact qualification or a performance guarantee.

## Review findings addressed

- Unknown methods are rejected before workspace access or mutation admission. The
  CLI also rejects them before generating identities, saving journals or connecting,
  rather than misleadingly requesting a mutation ID.
- CLI read operations inherit workspace scope only. Actor/run context defaults no
  longer become accidental query filters. Explicit selectors remain unchanged;
  actor-owned upload staging receives its applicable actor default.
- Coordinator readiness uses the selected run consistently with allocation. Whole
  coordinator/feed rows fit the actual public response budget; oversized rows retain
  their position, and coordinator reports exact required bytes.
- Historical activity retains full typed payloads. Discussion, handoff and resource
  provenance agrees with its audit header. Repeated signals retain their original
  timestamp and sequence while matching exact accepted content and attribution.
- Completed export cancellation reports the intended lifecycle error before touching
  cancellation state. Earlier final-review fixes also preserved current-attempt
  acceptance fences and recovery cursor continuity.
- All OCaml/Dune files were formatted with the pinned Jane Street configuration.
  Ambiguous interface documentation attachments were fixed with proper spacing;
  comment validation was not disabled.

The first full integration run exposed older tests using generic public `id` fields
and a persisted ticket fixture missing its required initial membership revision.
Those fixtures now exercise the current schema. The independent canonical JSON and
SHA-256 fixture was recomputed using Python, not the encoder under test. Tests for
small context budgets now assert actionable rejection when complete retained
evidence cannot fit, then verify a bounded larger response and explicit prose
omissions. No exception output was accepted as a successful expectation, and no
prototype compatibility reader was added.

## Coverage by work area

| Area | Executable checks |
| --- | --- |
| Canonical API, transactions and durable records | `test/api_catalog`, `test/transaction_api`, `test/storage_test.ml`, `test/persistence`, main integration suite |
| Lifecycle, reopen, ordinary completion and readiness | `test/lifecycle`, `test/domain_test.ml`, `test/planning_ticket`, `test/planning_context` |
| Agent CLI context, startup and exact request journals | `test/cli_context`, main integration suite |
| Facts, direct reads, history and resource transfers | `test/facts`, `test/facts_integration`, `test/direct_reads`, `test/history`, `test/upload_api` |
| Messages, requests, immutable routing and inbox recovery | `test/communication`, `test/inbox_wait`, `test/discussion_test.ml` |
| Command capture and optional inherited acceptance | `test/execution_capture`, `test/acceptance_policy`, `test/evidence`, `test/lifecycle` |
| Paths, external conditions, recovery and allocation | `test/coordination`, `test/coordinator`, `test/runs` |
| Resume, digests, feeds, usage and admission | `test/resume`, `test/feeds`, `test/metrics`, `test/admission`, `test/evaluation`, `test/policy_api` |
| External reference drivers and offline discovery | `test/codex_hooks`, `test/notification_watcher`, `test/harness_interop`, `test/generated_reference`, `tools/check_agent_guide.py` |
| Archive manifests, notices and installed-copy verification | `test/packaging` |

These paths identify actual test coverage, not a claim that every possible input or
failure interleaving has been tested. Additional focused acceptance checks, when
added, must pass before the final source is packaged.

The completion audit added two explicit acceptance cases that were previously
covered only indirectly. `test/facts_integration` now writes the same key with
distinct values in all four containing scopes and verifies exact reads, key-only
discovery and absence of fallback. `test/coordination` starts two competing runs
concurrently against overlapping required file/subtree reservations: exactly one
transaction wins, and the loser receives no claim, attempt, reservation or progress
note. Repeating the exact requests preserves the result and state. The focused
facts/coordination gate passed; its two daemon tests took 1.488 seconds. The joint
hook/watcher test also passed, with scope recorded in [harness evidence](harness-hooks.md).

Native package qualification remains a separate gate: run the installed executable
and packaged drivers, verify manifests/notices/dependencies and preserve the resulting
artifact-bound qualification record. Prior artifacts built from different source
do not qualify this implementation. See [package scope](package-readiness.md),
[recovery/discovery measurements](agent-recovery.md) and the focused acceptance
records in this directory for their specific evidence and limitations.
