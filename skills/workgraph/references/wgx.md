# Read-only terminal views with wgx

The bundled [wgx.sh](../scripts/wgx.sh) is a read-only terminal viewer for an
existing workspace. It requires Bash 3.2+, `jq` 1.6+, Python 3, the matching
`workgraph` executable and standard Unix terminal/filesystem utilities. Its sibling Python
helpers must remain together under the bundled `scripts/` directory.

Set `SKILL` to the absolute installed skill folder and `WG` to the matching
executable, or put `workgraph` on `PATH`. Set `CONTEXT` to an observer's existing
agent context file; it supplies the socket and workspace. Supply `WG_CONTEXT`
or `--context ABS_FILE` on each invocation. Help needs no daemon or context.
A **capture** is a fixed query observation: pages retain its revision/head so a
changing workspace cannot silently splice different observations into one view.

```bash
WG=/absolute/path/workgraph bash "$SKILL/scripts/wgx.sh" --context "$CONTEXT" status
WG=/absolute/path/workgraph bash "$SKILL/scripts/wgx.sh" --context "$CONTEXT" status \
  -p existing-project --run existing-run
```

Use `status` for one bounded summary, `ticket` for detailed task context, `watch`
for change observation, and `dash` for an interactive display. Project and run
selectors must identify actual records in that workspace.

Every network operation is read-only. A consumer-specific inbox read never
acknowledges notifications. Reported run state does not establish process liveness,
and lease expiry does not remove a holder or authorize recovery.

| Command | Semantics |
| --- | --- |
| `status [-p PROJECT] [--run RUN]` | Tickets and daemon `ticket.ready` share one planning capture. Without a run, the label is explicitly graph readiness; `--run` selects actual worker eligibility. Other todo work is unscheduled, with exact reasons available from `ticket.readiness`. Requests/runs/paths/storage are workspace-wide, independently captured panels. Failure stops the view rather than pretending a panel is empty. |
| `dash [-p PROJECT] [--run RUN]` | Same captured view, roughly two-second revision polling. Controlling-TTY dimensions override stale `LINES/COLUMNS`. j/k/arrows/space/b/g/G scroll; q quits. Resize preserves bounded scroll position. Wrapping, cursor and persistent terminal modes restore on quit, signals and errors. Non-TTY or dumb terminals receive one plain snapshot. `NO_COLOR` disables color, while an interactive dashboard still needs cursor controls. |
| `watch [--all\|--cursor CURSOR]` | Reads planning change metadata and drains both read and wait replies. Advances only the actual consumed opaque cursor, never `through`. Errors/budget/no-progress stop nonzero and retain a printed cursor for explicit resume. Interruption stops observation, with no acknowledgement. This metadata stream links exact targets/revisions; it is not a full body dump. |
| `feed [N]` | Last N rendered planning events (default 30, 1..1000), from a current guarded capture. At least one line per commit, including a generic expansion pointer for otherwise unrendered event types; the last N commits therefore contain the last N rendered lines. Collection budget exhaustion stops instead of silently returning an older first page. |
| `ticket TICKET` | Full task/acceptance/handoff fields and captured paged comments/linked resources. Note bodies are visibly clipped previews with an exact expansion command. The context itself is bounded; omission errors are explicit. |
| `questions` | Captured complete request IDs, author/resolver, status and responsibility. Expand question and pinned answer with `request.get --include-messages true`; listing does not imply acceptance or resolution. |
| `agents` | Captured runs and current claimed tickets, with caller-reported state/capabilities. |
| `inbox ACTOR [CONSUMER]` | All bounded captured deliveries unacknowledged by that exact consumer. Body previews can have explicit omission metadata; reading never acknowledges. |
| `output RESOURCE [--limit BYTES]` | Verified complete resource download followed by the existing strict public capture decoder/inspector. Default 4096 retained bytes per stream; configurable 1..65536. Safe decoded previews escape controls; invalid UTF8 replacement, retained/observed/truncated/EOF and provenance coverage remain explicit. |
| `output RESOURCE --raw stdout\|stderr` | Explicit exact **retained** stream bytes on stdout; redirect to a file. Metadata goes to stderr. Raw bytes may control a terminal; the switch is deliberate. Discarded process bytes cannot be reconstructed. |
| `storage` | Actual named meters, units/limits/remaining/severity and cumulative lifetime; no invented average capacity or provider quota enforcement. |
| `files` | Captured holders, exact tokens/mode and lease deadline, including explicit expiry semantics. |
| `history TEXT` | Captured paged indexed matches plus indexing/coverage status. A partial-index no-hit is not absence. |
| `convo SESSION [SEQ] [N]` | Forward window beginning at sequence SEQ (default beginning), up to N=1..100 events. Best-effort UTF8 and exact base64 previews, bounded to 1200 bytes per selected payload/text, with total/next-offset/has-more and captured head. Clipped or binary text is not exact decoded history. Expand bytes with `history.payload` and the same head; use returned next_anchor rather than invented position arithmetic. |

Collections reuse the typed CLI `--paginate` helper, preserving each family's
capture, selectors and guards. Defaults are 100 pages and 16MiB total response
bytes. `WGX_MAX_PAGES` accepts 1..1000; `WGX_TOTAL_BYTES` accepts
4096..67108864. Incomplete traversal returns nonzero with exact stop, capture,
next/retry request and problem metadata. No guard is silently refreshed. A
complete collection can still omit body fields: those budget counters are shown
on stderr and the view does not claim complete bodies. `attention.read` is not
used as a shortcut for independently paged readiness.

Untrusted control characters, including ESC, C0/C1 and directional formatting
controls, become visible escapes before terminal styling. Evidence output first
downloads and verifies the complete immutable resource. It builds a private
inspection copy containing the downloaded capture and its command object so the
existing `evidence-show` decoder can validate all fields before any stream output.
It never launches, publishes, rewrites or asserts ownership of an execution.
Cleanup removes only known files in its own fresh private temporary directory.

The viewer uses ordinary read APIs and never creates work, starts a process,
publishes evidence or acknowledges an inbox. A terminal rendering or clipped
preview is an observation; follow its expansion commands for exact source bytes.
