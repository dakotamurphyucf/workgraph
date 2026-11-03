# Read-only terminal views with wgx

The maintained source is [tools/wgx.sh](../../tools/wgx.sh); the README includes
the complete same script. It needs Bash, `jq`, a matching `workgraph` executable
on `PATH`, and an explicit `WG_CONTEXT` or `--context ABS_FILE`. Installation
copies that source to a user-selected executable path; it never starts an agent.

This preparatory source preserves the tested Bash 3.2, escape portability and
full terminal-height viewport fixes. The installed helper is deliberately left
unchanged. Final helper qualification is a separate gate: **the existing helper
is a preview, not an authoritative allocation or complete audit view**.

| Command | View and current boundary |
| --- | --- |
| `status [-p PROJECT]` | Dashboard; tickets are paged, but other panels can be bounded. Its local ready/waiting approximation does not establish run eligibility. Use `ticket.ready --target-run-id RUN` and `ticket.readiness` for scheduling. Project filtering selects tickets; auxiliary panels are workspace-wide. |
| `dash [-p PROJECT]` | Scrollable dashboard. Polls roughly every two seconds; not an immediate change subscription. Reads controlling TTY dimensions, preserves scroll position across updates/resizes, and restores wrapping/cursor settings on its supported exit paths. |
| `watch [--all]` | Planning activity, resumed from the last consumed revision; `--all` starts at zero. A displayed page is bounded. Preserve the last consumed position; never substitute a returned high-water mark for undelivered rows. |
| `feed [N]` | Current implementation selects a recent revision range, not exactly N rendered events. |
| `ticket TICKET` | Task card with bounded context, notes, handoff and linked resources. Text previews and first pages are not the whole record. |
| `questions` | Tracked request status/resolver/responsibility; a bounded first page, not proof no other questions exist. |
| `agents` | Caller-reported runs and current claimed tickets; status does not prove process liveness. |
| `inbox ACTOR [CONSUMER]` | Notifications unacknowledged by that exact consumer. Reading never acknowledges or resolves anything. |
| `output RESOURCE` | Legacy small-capture raw decoder. Prefer verified resource download plus bounded `evidence-show`; raw captured bytes can control a terminal. Large/binary-safe rendering remains a qualification item. |
| `storage` | Named cumulative planning/history admission meters. Inspect each meter's own units/limit; no provider quota is enforced. |
| `files` | Bounded path holders/fences/lease policies. Expiry does not remove a holder or prove its process stopped. |
| `history TEXT` | Bounded indexed search; inspect incomplete indexing and more-results notices. No hit does not establish absence. |
| `convo SESSION [SEQ] [N]` | Bounded text preview (currently 1200 bytes / 14 lines per event). Expand with `history.payload` under the same captured head for complete bytes. |

For scripting and complete captured collections, prefer the CLI's explicit
`--paginate` helper and check `.result.data.pagination.complete`. Each family has
different captures and continuation fields; `attention.read` has independently
paged readiness and remains manual. Do not acknowledge an inbox to clear a view.

The final qualification matrix includes Bash 3.2/macOS ARM64 and Bash 5/AlmaLinux
10/WSL; real PTY height/resize/scroll/signal cleanup; non-TTY/NO_COLOR behavior;
more than 100 rows; byte omissions; current-revision conflicts; malformed/offline
replies; Unicode/control characters; verified captures larger than 64KiB; and
before/after daemon revision plus inbox acknowledgement equality for every view.
Record platform evidence rather than assuming a shell syntax check covers it.
