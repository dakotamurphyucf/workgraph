# Supplied team-guide coverage audit

Authority: `workgraph-team-guide.html` supplied by the user, 1990 source lines, SHA256
`d15b5c6fd602758c67a38de416f4eb1be7faefaedb92d0286c4b0c2ee540f02c`. The original was read in full; a structured inventory records 50 headings, 40 preformatted blocks and 13 instructional diagrams (the fourteenth SVG only defines markers). CSS, font styling, copy-button JavaScript and decorative layout are represented by Markdown headings, copyable fences, tables, Mermaid and collapsible source blocks. No substantive workflow was replaced by a link alone.

The README contains complete corrected script sources; focused tests keep those
bytes equal to maintained files. This audit maps the supplied material to its
current documentation. The [feedback coverage and release gates](acceptance/v0.6-feedback.md)
track implementation checks, package verification and platform limits separately.
The helper uses bounded typed pagination, daemon-derived graph/run eligibility and
explicit retention/provenance limits; incomplete traversal remains a nonzero result.

## Every section and how-to

| HTML line / heading | README destination |
| --- | --- |
| 205 — Workgraph | [README](../README.md#workgraph) |
| 255 — What Workgraph is | [README](../README.md#what-lives-here) |
| 318 — Why use it | [README](../README.md#what-lives-here) |
| 320 — Agents forget | [README](../README.md#what-lives-here) |
| 321 — Parallel agents collide | [README](../README.md#what-lives-here) |
| 322 — Questions get lost | [README](../README.md#what-lives-here) |
| 323 — "Done" is a claim, not proof | [README](../README.md#what-lives-here) |
| 324 — Different tools can't share state | [README](../README.md#what-lives-here) |
| 325 — Reviewers lack the backstory | [README](../README.md#what-lives-here) |
| 332 — The ideas you need | [README](../README.md#concepts-and-choosing-a-record) |
| 423 — Which one do I use? | [README](../README.md#concepts-and-choosing-a-record) |
| 442 — Capabilities and pools: who may take which work | [README](../README.md#concepts-and-choosing-a-record) |
| 492 — Install and set up | [README](../README.md#install-and-set-up) |
| 496 — Download, check and install | [README](../README.md#install-and-set-up) |
| 511 — Start the daemon and create your workspace | [README](../README.md#install-and-set-up) |
| 545 — Try one ticket end to end | [README](../README.md#install-and-set-up) |
| 561 — Add one context per agent | [README](../README.md#install-and-set-up) |
| 576 — After a reboot or wsl --shutdown | [README](../README.md#install-and-set-up) |
| 592 — Give it to an agent | [README](../README.md#give-it-to-an-agent) |
| 622 — Use cases you can try today | [README](../README.md#eight-workflows) |
| 627 — 1. Memory that survives context resets | [README](../README.md#1-memory-across-resets) |
| 684 — 2. An orchestrator coordinating parallel agents across harnesses | [README](../README.md#2-orchestrator-workers-and-ci) |
| 750 — Step 1 · Give each participant a context | [README](../README.md#2-orchestrator-workers-and-ci) |
| 759 — Step 2 · The orchestrator writes the plan in one atomic step | [README](../README.md#2-orchestrator-workers-and-ci) |
| 781 — Step 3 · Each LLM worker runs this loop | [README](../README.md#2-orchestrator-workers-and-ci) |
| 809 — Make "record the result and close the ticket" one step | [README](../README.md#2-orchestrator-workers-and-ci) |
| 821 — Step 4 · A worker asks, the orchestrator answers | [README](../README.md#2-orchestrator-workers-and-ci) |
| 860 — Step 5 · A plain script joins as a worker | [README](../README.md#2-orchestrator-workers-and-ci) |
| 935 — Step 6 · Watch and close out | [README](../README.md#2-orchestrator-workers-and-ci) |
| 945 — Prompts for the agents | [README](../README.md#2-orchestrator-workers-and-ci) |
| 968 — 3. Agents asking each other questions | [README](../README.md#3-agent-to-agent-qa-and-messages) |
| 983 — 4. Review-gated work | [README](../README.md#4-independent-review-gates) |
| 1014 — 5. Ship the agents' working state with an MR | [README](../README.md#5-a-merge-request-snapshot-with-backstory) |
| 1075 — 6. A shared backlog with special skills | [README](../README.md#6-shared-skill-backlog) |
| 1091 — 7. Parallel coding agents in one repo, without editing the same files | [README](../README.md#7-same-repository-explicit-source-ownership) |
| 1128 — Declare the paths when you plan | [README](../README.md#7-same-repository-explicit-source-ownership) |
| 1139 — Work as usual, then release | [README](../README.md#7-same-repository-explicit-source-ownership) |
| 1152 — Reserve something without a ticket | [README](../README.md#7-same-repository-explicit-source-ownership) |
| 1168 — 8. Save agents' conversations so reviewers can read the actual reasoning | [README](../README.md#8-searchable-user-visible-conversations) |
| 1187 — Install the converter | [README](../README.md#8-searchable-user-visible-conversations) |
| 1272 — Import a session | [README](../README.md#8-searchable-user-visible-conversations) |
| 1285 — Read it | [README](../README.md#8-searchable-user-visible-conversations) |
| 1318 — Watch agents work | [README](../README.md#watch-agents-work) |
| 1374 — Install wgx | [README](../README.md#watch-agents-work) |
| 1801 — What each view answers | [README](../README.md#watch-agents-work) |
| 1836 — Quick one-liners without wgx | [README](../README.md#watch-agents-work) |
| 1865 — Inspect a workspace | [README](../README.md#inspect-a-workspace) |
| 1897 — Export and import workspaces | [README](../README.md#backup-share-move-and-retire) |
| 1924 — Know before you start | [README](../README.md#limits-and-operational-care) |
| 1943 — Where to read more | [README](../README.md#references) |

## Every code block

| HTML line | Corrected complete equivalent |
| --- | --- |
| 470 | [Capabilities, policy, pool and catalog commands](../README.md#concepts-and-choosing-a-record) |
| 499 | [Checksum-verified published AlmaLinux installation](../README.md#install-and-set-up) |
| 514 | [Private matching bootstrap](../README.md#install-and-set-up) |
| 531 | [Generated directory tree](../README.md#install-and-set-up) |
| 547 | [End-to-end checked smoke](../README.md#install-and-set-up) |
| 564 | [Separate participant contexts](../README.md#install-and-set-up) |
| 582 | [Replaced unsafe socket deletion with guarded lifecycle guidance](../README.md#install-and-set-up) |
| 594 | [Full installation/setup prompt](../README.md#give-it-to-an-agent) |
| 616 | [Full connection prompt](../README.md#give-it-to-an-agent) |
| 654 | [Fact, progress, decision and every handoff field](../README.md#1-memory-across-resets) |
| 677 | [Resume with explicit selected fact](../README.md#1-memory-across-resets) |
| 752 | [Four participant contexts](../README.md#2-orchestrator-workers-and-ci) |
| 761 | [Complete atomic plan JSON with current aliases/methods](../README.md#2-orchestrator-workers-and-ci) |
| 778 | [Preflight and apply](../README.md#2-orchestrator-workers-and-ci) |
| 783 | [Registered worker selection, empty handling and lifecycle](../README.md#2-orchestrator-workers-and-ci) |
| 812 | [Atomic resource/link/fact/finish JSON](../README.md#2-orchestrator-workers-and-ci) |
| 845 | [Accountable question](../README.md#2-orchestrator-workers-and-ci) |
| 849 | [List, exact resolve and selected ack](../README.md#2-orchestrator-workers-and-ci) |
| 856 | [Expanded question and pinned answer read](../README.md#2-orchestrator-workers-and-ci) |
| 884 | [Complete maintained CI script inline plus invocation](../README.md#2-orchestrator-workers-and-ci) |
| 937 | [Closeout reads and team message](../README.md#2-orchestrator-workers-and-ci) |
| 946 | [Complete orchestrator prompt](../README.md#2-orchestrator-workers-and-ci) |
| 955 | [Complete worker prompt](../README.md#2-orchestrator-workers-and-ci) |
| 970 | [Direct message/reply and selected consumer ack](../README.md#3-agent-to-agent-qa-and-messages) |
| 1039 | [Bounded export polling, verify, archive and hash](../README.md#5-a-merge-request-snapshot-with-backstory) |
| 1047 | [Fresh reviewer restore/init guidance](../README.md#5-a-merge-request-snapshot-with-backstory) |
| 1059 | [Complete six-question review prompt](../README.md#5-a-merge-request-snapshot-with-backstory) |
| 1077 | [Capability-routed skill backlog](../README.md#6-shared-skill-backlog) |
| 1130 | [Complete atomic path declarations/start plan](../README.md#7-same-repository-explicit-source-ownership) |
| 1141 | [Scoped release with actual returned tokens, never all foreign holds](../README.md#7-same-repository-explicit-source-ownership) |
| 1154 | [Ad-hoc lease request and explicit expiry semantics](../README.md#7-same-repository-explicit-source-ownership) |
| 1189 | [Complete visible-only converter inline; private extraction removed](../README.md#8-searchable-user-visible-conversations) |
| 1274 | [Converter install, deterministic incremental import/cursor](../README.md#8-searchable-user-visible-conversations) |
| 1286 | [Search/read/history/convo commands](../README.md#8-searchable-user-visible-conversations) |
| 1295 | [Visible tool-event illustration and full expansion guidance](../README.md#8-searchable-user-visible-conversations) |
| 1324 | [Dashboard illustration with truthful readiness boundary](../README.md#watch-agents-work) |
| 1352 | [Feed illustration and consumed continuation semantics](../README.md#watch-agents-work) |
| 1376 | [Complete maintained viewport-fixed wgx inline plus installation](../README.md#watch-agents-work) |
| 1820 | [Ticket card illustration with full handoff fields](../README.md#watch-agents-work) |
| 1838 | [Six plain jq views plus decoded evidence inspection commands](../README.md#watch-agents-work) |

## Every instructional diagram

| HTML line | Preserved teaching content |
| --- | --- |
| 259 | [CLI/harness/socket/daemon/private workspace architecture](../README.md#what-lives-here) |
| 336 | [Containment, dependency and actor/run/communication relations](../README.md#concepts-and-choosing-a-record) |
| 383 | [Lifecycle and derived readiness](../README.md#concepts-and-choosing-a-record) |
| 446 | [GPU/CI eligibility and one-slot pool routing](../README.md#concepts-and-choosing-a-record) |
| 631 | [Recorded handoff across reset](../README.md#1-memory-across-resets) |
| 688 | [Orchestrator, two workers and CI](../README.md#2-orchestrator-workers-and-ci) |
| 713 | [Historical run timeline, corrected Claude provenance](../README.md#2-orchestrator-workers-and-ci) |
| 825 | [Question, resolver, pinned answer and delivery acknowledgement](../README.md#2-orchestrator-workers-and-ci) |
| 864 | [CI capture/publication/pass/red/infrastructure outcomes](../README.md#2-orchestrator-workers-and-ci) |
| 987 | [Two exact-submission review rounds](../README.md#4-independent-review-gates) |
| 1018 | [MR author export, verification and independent review copy](../README.md#5-a-merge-request-snapshot-with-backstory) |
| 1095 | [Subtree/file overlap and disjoint peer](../README.md#7-same-repository-explicit-source-ownership) |
| 1172 | [Visible transcript conversion, stable-ID import, search and export](../README.md#8-searchable-user-visible-conversations) |

## Corrections applied

- Facts use 4096 canonical JSON bytes; source selection and large visible parts are explicit and lossless within that selection. The converter never extracts private reasoning and has no enabling flag.
- Every shell call checks failure before jq under pipefail/errexit or an explicit branch. Journaling diagnostics remain on stderr; raw stdout byte helpers have separate documented metadata streams.
- Current canonical methods, transaction `as`/`$alias`, envelope placement, actual selection claim paths, explicit attempt IDs and current entity guards replace stale spellings and assumed token/revision values.
- Empty standalone allocation is a nondurable observation. Run status is caller-reported; lease expiry never removes holders or proves process death. Ticket-scoped borrowed grants and independent manual holds have distinct cleanup.
- Captures retain bounded prefixes; tail is of retained bytes. Declared selected-source coverage is not whole-tree proof. Publication and linking are independent receipts and retry never reruns execution.
- Readiness is daemon-derived/run-aware. Parent links are independent by default; explicit hierarchy policy inherits source-owned prerequisite conditions only. All collection/cursor families retain their own capture and omission semantics; attention nested readiness stays manual.
- Original measured results remain explicitly historical. The topology/timeline does not invent Codex measurements; the CI restart bar is distinguished from the 45ms test execution.
- Socket recovery never relies on `pgrep || rm`; export polling is bounded and handles terminal failure/cancellation/interruption; restored roots and independent writers cannot merge.
- Full matching source code remains inline for CI, converter and wgx. Helper tests cover large pages, readiness and binary rendering; package and platform results are recorded separately from this content audit.

## Current 0.6 contract coverage

The [current contract map](preview-0.6-contracts.md) and
[feedback coverage](acceptance/v0.6-feedback.md) add the policy revision, role and
duplicate-author gates, priority/unhold, resolver/responsibility distinction,
whole-value fact cap, 32-operation expansion limit and harness backoff guidance.
The generated API reference and bundled README are regenerated from the final
integrated executable/source; historical line numbers above remain provenance,
not current source positions or final release qualification.

Source packaging explicitly includes docs/ and skills/ descendants; native bundles
retain those same bytes plus required core files/tools under packaging/verify.py.
New standalone documentation belongs in those included trees. New root-level
entrypoints or helpers outside them require an explicit source/native allowlist
review. scratch/, dist/, credentials and request journals are never release source.
