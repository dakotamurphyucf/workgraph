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

Install `scripts/wgx_dashboard.py` beside the installed `wgx` shell script.
Interactive `dash` and `tree` require Python 3.10+ (standard library only).

Use `status` for one bounded summary, `ticket` for detailed task context, `watch`
for change observation, and `dash` for an interactive display. Project and run
selectors must identify actual records in that workspace.

Colors distinguish done/resolved work (green), active work (yellow), ready work
(cyan), and open requests (magenta). `WGX_COLOR=auto` is the default: colors appear
only on a non-dumb terminal. `WGX_COLOR=always` preserves styles through a pager
such as `less -R`; `WGX_COLOR=never` disables them. A nonempty `NO_COLOR` always
disables color, including in `always` mode. Status counts, symbols and labels
remain readable without color. Storage gauges turn yellow at 80% and red at 95%;
the daemon-reported severity is also displayed independently.

Every network operation is read-only. A consumer-specific inbox read never
acknowledges notifications. Reported run state does not establish process liveness,
and lease expiry does not remove a holder or authorize recovery.

| Command | Semantics |
| --- | --- |
| `status [-p PROJECT] [--run RUN]` | Tickets and daemon `ticket.ready` share one planning capture. Without a run, the label is explicitly graph readiness; `--run` selects actual worker eligibility. Colored counts and progress bars summarize the selected tickets. Other todo work shows declared prerequisites and holds; a listed prerequisite is not necessarily unmet. Exact reasons remain available from `ticket.readiness`. Question titles and links share their requests' communication capture. The last six rendered activity lines share the ticket planning capture. Requests/runs/paths/storage are workspace-wide, independently captured panels. Failure stops the view rather than pretending a panel is empty. |
| `dash [-p PROJECT] [--run RUN]` | Quiet Overview plus Tasks, Questions, Agents and Activity tabs; item-based anchored selection, responsive wrapping, detail/status inspectors, filters, pause and reconnect. Full terminal height and saved screen/modes restore on quit/signals/errors. Non-TTY/dumb terminals receive one plain snapshot. See controls below. |
| `tree TICKET` | Captured workspace-wide declared prerequisite graph; explicit shared/missing nodes and a 250-row limit. Downstream count includes all reachable dependent tickets, including completed ones, and is not an effort estimate or an eligibility prediction. |
| `watch [--metadata] [--all\|--cursor CURSOR]` | Drains planning read/wait replies and expands their exact revision interval into readable activity: starts, finishes, decisions, questions and other recorded events. Bodies are previews. `--metadata` skips expansion and retains the compact revision/target stream. Advances only the consumed opaque cursor after rendering succeeds, never `through`. Errors/budget/no-progress stop nonzero and retain the last consumed cursor (or initial `after` boundary). Interruption never acknowledges delivery. A replay after a partial output can repeat displayed lines. |
| `feed [N]` | Last N rendered planning events (default 30, 1..1000), from a current guarded capture. At least one line per commit, including a generic expansion pointer for otherwise unrendered event types; the last N commits therefore contain the last N rendered lines. Collection budget exhaustion stops instead of silently returning an older first page. |
| `ticket TICKET` | Task/acceptance/handoff fields, priority, labels, parent, prerequisites, blockers, ownership and captured paged comments/linked resources. Notes show author, time and color-coded kind. Note bodies are visibly clipped previews with an exact expansion command. The context itself is bounded; omission errors are explicit. |
| `questions` | Captured request IDs, current thread titles and linked tickets, author/resolver, status, responsibility, priority, age and optional deadline timestamp. Thread labels use the same communication revision as requests; they are not the immutable original question body. Expand question and pinned answer with `request.get --include-messages true`; listing does not imply acceptance or resolution. |
| `agents` | Captured runs and current claimed tickets, with caller-reported state, capabilities and objective. A run with no displayed claims is not necessarily an idle external process. |
| `inbox ACTOR [CONSUMER]` | All bounded captured deliveries unacknowledged by that exact consumer. Body previews can have explicit omission metadata; reading never acknowledges. |
| `output RESOURCE [--limit BYTES]` | Verified complete resource download followed by the existing strict public capture decoder/inspector. Default 4096 retained bytes per stream; configurable 1..65536. Safe decoded previews escape controls; invalid UTF8 replacement, retained/observed/truncated/EOF and provenance coverage remain explicit. |
| `output RESOURCE --raw stdout\|stderr` | Explicit exact **retained** stream bytes on stdout; redirect to a file. Metadata goes to stderr. Raw bytes may control a terminal; the switch is deliberate. Discarded process bytes cannot be reconstructed. |
| `storage` | Colored gauges with percentages, readable byte units, actual named limits/remaining/severity and cumulative lifetime; no invented average capacity or provider quota enforcement. |
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

## Interactive controls and observation boundaries

- Overview shows progress, up to three attention items and active tasks. Attention
  is not repeated in the header. Questions shows the full attention list, including
  reviews and pending instruction acknowledgements. Tasks has ready, waiting,
  active and completed work. Agents and Activity contain workspace-wide records.
- Up/down or `j/k` select whole items, skipping their wrapped lines, subtitles,
  headings and spacing. Selection stays anchored to the item across refreshes and
  resizing. Enter opens details; Escape returns through nested views.
- Tab/Shift-Tab or left/right switch tabs; `1`–`5` select a tab directly. Each tab
  remembers its position. Space/b or Page Down/Up pages; g/G or Home/End jumps.
- `c` collapses the selected section. `/` searches the current view; `a` filters
  worker/resolver. Empty input clears the filter. `f` opens Tasks and cycles
  all/active/ready/blocked/done; `h` opens Agents and hides/shows non-running reports.
- `p` freezes displayed content and ages while reads continue. Resume reports
  distinct records observed changing, including changes subsequently reverted.
  This is not a count of every event between captures.
- `d` opens a selected ticket's dependency tree; Enter inspects a node.
- `i` opens the status inspector: capture revision, exact-check coverage, last
  successful read, errors, omission details, workspace-wide reservations and all
  named storage meters. Technical ownership/policy fields remain in inspectors.
  Loading, incomplete-data and disconnection warnings stay visible on the main view.
- `r` refreshes, `?` explains controls, `q` quits. No action writes or acknowledges.

The dashboard uses a Linear-inspired dark palette: charcoal surfaces, off-white
headings, gray metadata and indigo navigation, questions and change highlights.
Muted green marks completion, amber marks active/waiting work, and soft red marks
errors. Selection has a lighter charcoal background and pale indigo text.
These 256-color styles retain meaningful labels and markers when color is disabled.
Narrow terminals use abbreviated tab labels. Titles wrap at word
boundaries where possible; long words still wrap to fit. A detail screen scrolls
by line when it has no selectable items. Ticket details include task text, notes,
linked resource names and exact start/completion requirements; resource bodies
are not downloaded. Agent details include objectives, capabilities and reservations.

Questions and reviews use the request capture and matching thread labels. Pending
instruction acknowledgements and completion blockers come from ticket context;
eight nonterminal tickets are inspected per refresh, with planning revision guards.
Coverage counts are in the status inspector, with a main-view loading warning; uninspected tickets are never labeled clear. Changing the
planning revision invalidates these detailed checks. Large or frequently changing
workspaces may need direct ticket inspection before coverage finishes. Bounded
context collections retain their omission and remaining counts; the viewer does
not turn them into complete bodies. Ticket details use the selected planning
capture; notes/resources and request details are separately captured current reads.

Project selection filters tickets and linked attention items. Runs, path holds,
activity and storage remain labeled workspace-wide. Worker filtering uses recorded
owners/resolvers; it does not claim to detect running processes. Declared dependency
trees do not expand inherited readiness policies; use exact readiness reasons.

One read worker refreshes about every two seconds after a successful fetch. Reads
have a ten-second timeout; failed refreshes back off to at most thirty seconds.
The last successful complete snapshot stays visible and explicitly stale while
reconnecting. A manual refresh does not interrupt an already running read. Keyboard
navigation stays responsive; quitting cancels the viewer's CLI subprocess, never
the daemon. No view creates or acknowledges requests, changes tickets or reserves
files. The dashboard does not start a daemon on reconnect.

Text is escaped before styling and wrapped by Unicode cell width. Very wide emoji
sequences may render differently between terminal emulators. `NO_COLOR` disables
styles; terminal positioning controls remain necessary for the interactive UI.
