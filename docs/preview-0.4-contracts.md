# Workgraph 0.4 client usability preview

Status: implemented and reviewed; see the [acceptance record](acceptance/v0.4-client-usability.md).

## Purpose and scope

Make common commands discoverable and questions/answers easy for agents and people
using the existing local service. Preserve durable publication, exact successful
retries, serialized planning, attribution and ownership fences. No new runtime,
external service, authentication system or storage engine is introduced.

Target package: **0.4.0 preview**, application API **0.4**. Changed planning/root
formats use a new current identity; unchanged independent formats retain their
identity. Fresh data and saved requests are required where the current identity
changes. No migration or legacy storage readers. Older peers must fail clearly
without misrepresenting possible write outcomes.

## Command discovery

- `init --help`, `help init`, and bootstrap equivalents print offline helper usage
  successfully, without opening a socket, writing a journal or creating files.
- `request get/list/...` must select the corresponding request-domain method when
  used with context; retain documented `request SOCKET METHOD` and dotted methods.
  Ambiguous/incomplete forms give a concrete correction rather than guessing a socket.
- `ticket.get` is a CLI spelling for `ticket.context`, canonicalized before saving;
  no duplicate daemon contract is required. Unknown-method suggestions name it.
- Brief method help shows one bounded level of object/array/tagged-object shape,
  not a recursively expanded schema. Envelope requirements distinguish raw calls
  from context defaults; context never supplies an unavailable identity silently.
- Fix incorrect generated descriptions and create examples (`expected_revision:0`
  for creating board/thread). Claim-next brief help names registered live run,
  matching attribution and fresh attempt ID requirements.

## Accountable questions and answers

- Provide `request.ask`: one saved, atomic mutation creates a scoped discussion
  board/thread, initial question and accountable request using existing event types.
  Minimal inputs: request_id, title, body, recipients, resolver; optional ticket_id
  and request kind (default clarification). Workspace scope applies without a ticket.
  Internal IDs are deterministically derived in validated namespaces from request_id;
  collisions reject without partial creation. Return request and thread identifiers,
  their revisions and question reference so callers can continue without guessing.
- Preserve lower-level request.create, board/thread and discussion APIs.
- Extend request.resolve with an optional answer body. With a body, author and attach
  the answer and resolve in one planning commit. Enforce existing resolver policy,
  expected request revision and nonblank bounded UTF-8 body. Thread update uses the
  same serialized capture; no separate read/write race. Without a body retain the
  existing resolution behavior. Retrying the saved mutation must not duplicate an
  answer or notifications; any validation failure publishes neither part.
- request.list accepts optional ticket_id and resolver filters, applied before
  pagination and byte fitting. request.get exposes current thread_revision, with
  clear distinction from request and workspace revisions.
- Reading/filtering still never acknowledges delivery or inbox processing. No new
  notification consumption policy, human identity service or agent process control.

## Actionable results and errors

- ticket.finish and ticket.release return ticket_revision for the affected ticket;
  finish retains existing attempt output and rich handoff merging.
- A finish blocked on readiness supplies the same typed blocker detail as start.
- Guidance states ownership tokens are visible, sequential stale-writer fences,
  not credentials; callers must not use another owner's token.
- Common missing-socket and existing execution-stage failures have useful public
  messages without raw Eio exception strings. Distinguish connection failure before
  send from uncertainty after a write could have executed; never advise blind new-ID
  retries after uncertainty.

## Narrow reliability fixes

- Preserve parsed valid request IDs on envelope rejection where possible. Recognize
  a strict JSON-RPC invalid-envelope rejection with null ID, including an older peer
  rejecting the application marker, without attempting legacy data support.
- Separate rejection before dispatch from failures while encoding/writing responses
  after dispatch. Arbitrary malformed, mismatched or lost write acknowledgements
  remain uncertain. Do not infer nonexecution merely from unreadable error data.
- Bound the complete diagnostic response, including repeated messages and field
  paths, while retaining useful typed detail. Oversized invalid input must produce
  a bounded decodable rejection, not overflow its response frame.
- Socket startup must never unlink another process's bound/live socket based on
  connection refusal. Prefer conservative refusal when ownership cannot be proven;
  stale cleanup needs an explicit safe ownership/recovery rule. Preserve owned-inode
  cleanup, cancellation and normal graceful restart. Avoid creating a new registry
  for an already occupied socket when feasible without weakening ownership checks.
- Internal and lifecycle diagnostics tolerate closed output pipes. Catch only known
  logging/output failures; preserve unrelated exceptions and cancellation.

## Acceptance and release

Focused regressions cover discovery without side effects, nested brief shape bounds,
question/answer atomicity and exact retry/replay, filters/revisions, blocked finish,
legacy rejection, malformed/lost post-send responses, large invalid field names,
bound-not-listening socket refusal and closed diagnostic pipes. Root reviews all
changes for engineering standards and invariants. Run `./dev fmt`, then
`./dev build @fmt @runtest @install`; keep generated references consistent.

One integrated question/answer/task workflow checks the user-visible contract.
Update README, agent references and installation/reset quick starts. Qualify native
AlmaLinux 10 x86_64 RPM/tar and macOS ARM64 packages and compare packaged source to
reviewed commit. Publish source, native packages, complete offline guides, checksums
and bounded qualification evidence after final CI. No actual WSL or signing claim
without execution. Use background subprocesses for CI status waiting.

## Deferred to a later release

Ticket deltas, receipt compression/removal, resource-scan optimization, checkpoints,
sealed segments, non-durable empty allocation and its retry redesign, revised budget
waiting/explanations, capacity-on-write metadata/error-kind normalization, rollover
freeze/read-only/provenance/CLI, default resume facts/deduplication, richer project
briefs, bulk self acknowledgement, MIME/archive conveniences, broad operational
logging, expanded platforms, comparative model studies and performance campaigns.

Implement only this scope. New observations go into the deferred backlog unless they
block correctness of an included workflow. Resolver filtering may be explicitly
cut if disproportionately expensive; record any such scope decision rather than
silently claiming completion. Focused safety regressions are never a scope cut.
