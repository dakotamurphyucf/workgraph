# Harness integrations: acceptance evidence

The examples are external Python standard-library clients. They add no daemon
process launcher, model runtime, MCP server or external messaging transport.

## Notification watcher

`test/notification_watcher` covers:

- Callback failure retains unacknowledged work.
- A crash window after callback success but before local persistence redelivers
  the same stable ID, requiring callback deduplication.
- Lost acknowledgement replies reuse the exact saved request and skip a callback
  whose success was already persisted.
- Fixed identity, concurrent checkpoint ownership and packet mutation protection.
- A real callback receives shell-looking message text literally on JSON stdin.
- A real daemon commits an acknowledgement whose reply is discarded; daemon and
  watcher restart preserve the receipt and do not repeat the completed callback.

On 2026-10-08, `./dev build @test/notification_watcher/runtest` passed four unit
tests and one actual socket/process test on macOS ARM64. This establishes the
tested recovery phases, not exactly-once delivery or atomicity with arbitrary
external callback effects.

## Codex hook adapter

The official command-hook contract was checked against
[Codex hook documentation](https://learn.chatgpt.com/docs/hooks). Installed
`codex-cli 0.160.1` also generated its experimental app-server JSON schemas using
`codex app-server generate-json-schema`; these expose configured hook groups,
the expected event names and additional-context limits. App-server schema
inspection is supporting interface evidence, not execution of a command hook.

`test/codex_hooks/hook_test.py` passed four tests on 2026-10-08, using independent
hook payload shapes. They check bounded context preservation without transcript
reads, absence of invented notes, exact request replay after a lost reply, binding
and coverage checks, and rejection of non-durable acknowledgements.

The real-socket hook-process fixture passed on 2026-10-08 as part of
`./dev build @test/resume/runtest @test/codex_hooks/runtest`: four hook unit tests
and one socket/process test (1.277 seconds). It exercises explicit handoff publication,
daemon restart, exact retry and recovery from Workgraph with no transcript available.
The same invocation still had an unrelated resume native fixture failure, so this
is scoped evidence for the hook tests, not a claim that the combined gate passed.

No hosted model call or interactive Codex compaction session has been run by these
tests. Hook configuration is supplied as a template; no user settings or hook trust
state were changed. The full repository gate and installed-package qualification
remain separate checks.

## Joint reference-driver interoperability

On 2026-10-09, `./dev build @test/harness_interop/runtest` passed one real-process
test in 0.608 seconds. Both shipped reference drivers connected to the same daemon:

- The hook process published an explicitly authored handoff through `PreCompact`.
- An independent watcher process delivered a ticket-linked message and request to
  its configured callback. The callback durably corrected a scoped fact, replied
  to the thread and resolved the request before watcher acknowledgement.
- After daemon restart, the actual hook process handled `SessionStart` and returned
  the corrected fact and resolved request history with no outstanding request. The
  ticket remained `todo` and unclaimed; saved handoff request/receipt files stayed
  unchanged. A further watcher step did not redeliver acknowledged notifications.
- Direct comment/thread retrieval after restart verified the exact reply and its
  attachment. A workspace-board comment stays workspace-scoped; linking its thread
  to a ticket does not promise that every reply body appears in the ticket resume.

This establishes interoperability between the external reference drivers and the
local service. The callback was deterministic fixture code; no hosted model,
interactive Codex session or actual model compaction ran. The existing separate
driver tests cover lost acknowledgements and duplicate handling; this joint test
does not expand that claim to arbitrary callback side effects.
