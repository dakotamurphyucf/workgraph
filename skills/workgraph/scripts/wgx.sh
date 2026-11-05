#!/usr/bin/env bash
# wgx: read-only terminal views for the matching current Workgraph executable.
# Usage: WG=/absolute/workgraph wgx --context ABS_FILE COMMAND [ARGS]
# status|dash [-p PROJECT] [--run RUN]   graph readiness or explicit run eligibility
# watch [--metadata] [--all|--cursor CURSOR]  readable events, until interrupted
# feed [N]                             last N rendered planning events (1..1000)
# ticket T | tree T | questions | agents | inbox ACTOR [CONSUMER] | storage | files
# output RESOURCE [--limit BYTES|--raw stdout|stderr]   verified capture, safe by default
# history TEXT | convo SESSION [SEQ] [N]              bounded captured history previews
# Requires Bash 3.2+, jq 1.6+, matching workgraph; dash/tree also use Python 3.10+.
# WGX_COLOR=auto|always|never (NO_COLOR disables); WGX_MAX_PAGES / WGX_TOTAL_BYTES bound reads.
set -o pipefail
WG=${WG:-workgraph}
CTX=${WG_CONTEXT:-}
if [ "${1:-}" = '--context' ]; then
  [ "$#" -ge 2 ] && [ -n "$2" ] || { echo 'wgx: --context requires a file' >&2; exit 2; }
  CTX=$2; shift 2
fi
case "${1:-}" in -h|--help|help) sed -n '2,11p' "$0" | sed 's/^# *//'; exit 0 ;; esac
fail() {
  if [ -n "${JQLIB:-}" ]; then
    printf '%s' "$*" | jq -Rrs "${COLORS[@]}" "$JQLIB clean | \"wgx: \" + ." >&2
  else printf 'wgx: %s\n' "$*" >&2; fi
  return 1
}
uint() { case "$1" in ''|*[!0-9]*|0[0-9]*) return 1 ;; esac; [ "${#1}" -le 9 ] && [ "$1" -ge "$2" ] && [ "$1" -le "$3" ]; }
identifier() { case "$1" in ''|*[!a-zA-Z0-9_-]*) return 1 ;; esac; [ "${#1}" -le 96 ]; }
MAX_PAGES=${WGX_MAX_PAGES:-100}; TOTAL_BYTES=${WGX_TOTAL_BYTES:-16777216}
uint "$MAX_PAGES" 1 1000 && uint "$TOTAL_BYTES" 4096 67108864 || { fail 'invalid traversal bounds'; exit 2; }
command -v jq >/dev/null && command -v "$WG" >/dev/null || { fail 'jq and the matching WG executable are required'; exit 1; }
[ -n "$CTX" ] && [ -f "$CTX" ] || { fail 'supply WG_CONTEXT or --context ABS_FILE'; exit 1; }
case "${WGX_COLOR:-auto}" in auto|always|never) ;; *) fail 'WGX_COLOR must be auto, always or never'; exit 2 ;; esac
if [ -z "${NO_COLOR:-}" ] && { [ "${WGX_COLOR:-auto}" = always ] || { [ "${WGX_COLOR:-auto}" = auto ] && [ -t 1 ] && [ "${TERM:-dumb}" != dumb ]; }; }; then
  B=$'\033[1m' D=$'\033[2m' R=$'\033[0m' G=$'\033[32m' Y=$'\033[33m' C=$'\033[36m' M=$'\033[35m' RED=$'\033[31m'
else B='' D='' R='' G='' Y='' C='' M='' RED=''; fi
COLORS=(--arg B "$B" --arg D "$D" --arg R "$R" --arg G "$G" --arg Y "$Y" --arg C "$C" --arg M "$M" --arg RED "$RED")

# One envelope, checked exit before interpretation; a pagination partial result
# remains available to pages() for its explicit stop/retry diagnostic.
wg() {
  local out code=0
  out=$("$WG" --context "$CTX" "$@") || code=$?
  if ! printf '%s\n' "$out" | jq -se 'length == 1 and (.[0]|type == "object" and has("result") and (has("error")|not) and (.result|type == "object"))' >/dev/null; then
    printf '%s\n' "$out" | jq -ac '.error // empty' >&2
    fail "request failed ($code): $*; no valid success envelope"; return 1
  fi
  printf '%s\n' "$out" | jq -c '.result'
  return "$code"
}

# Family-specific capture/continuation belongs to the typed CLI helper. Refuse
# to render an incomplete collection as complete; never erase an optional error.
pages() {
  local value code=0
  value=$(wg "$@" --paginate --page-limit "$MAX_PAGES" --total-bytes "$TOTAL_BYTES" --limit 100 --max-bytes 1048576) || code=$?
  if [ "$code" -ne 0 ] || ! jq -e '.data.pagination.complete == true' <<<"$value" >/dev/null; then
    fail "incomplete collection $*"
    [ -n "$value" ] || value='{}'
    jq -ac '.data.pagination // {stop:"invalid_or_failed_response"}' <<<"$value" >&2
    return 1
  fi
  if jq -e 'any(.data.pages[]; .meta.budget.truncated == true or ((.data.omitted_for_budget // "0")|tonumber)>0)' <<<"$value" >/dev/null; then
    fail "$* has omitted fields/bodies"
    jq -ac '[.data.pages[] | {budget:.meta.budget,omitted_for_budget:(.data.omitted_for_budget // "0")}]' <<<"$value" >&2
  fi
  jq -c '{data:((.data.pages[-1].data // {}) + {items:[.data.pages[].data.items[]?]}),meta:(.data.pages[0].meta // {}),pagination:.data.pagination}' <<<"$value"
}
all_tickets() { pages ticket.list "$@"; }
JQLIB='
def t: if . == null then "        " else .[11:19] end;
def epoch: if . == null then null else (.[0:10] + "T" + .[11:19] + "Z" | fromdateiso8601) end;
def ago($now): (epoch) as $e | if $e == null then "" else ($now - $e) as $s |
  if $s < 60 then "\($s|floor)s ago" elif $s < 3600 then "\($s/60|floor)m ago"
  elif $s < 86400 then "\($s/3600|floor)h ago" else "\($s/86400|floor)d ago" end end;
def one: (. // "") | gsub("\\s+"; " ") | if length > 90 then .[0:87] + "..." else . end;
def short($n): (. // "") | gsub("\\s+"; " ") | if length > $n then .[0:($n-1)] + "~" else . end;
def pad($n): tostring | if length >= $n then .[0:$n] else . + (" " * ($n - length)) end;
def who: (.actor_id // "?");
def whorun: if . == null then "unclaimed" else (.actor_id // "?") + (if .run_id then " (" + .run_id + ")" else "" end) end;
def hdr($s): "\n" + $B + $s + $R;
def empty_rows: if length == 0 then ["  " + $D + "none" + $R] else . end | .[];
def state_color: if . == "done" or . == "resolved" then $G elif . == "in_progress" or . == "running" then $Y
  elif . == "open" then $M elif . == "todo" then $C else $D end;
def styled_state: (state_color) + . + $R;
def bytes: tonumber | if . < 1024 then "\(.) B" elif . < 1048576 then "\(./1024*10|floor/10) KiB" else "\(./1048576*10|floor/10) MiB" end;
def gauge($used; $limit; $color):
  (if $limit > 0 then [0, ([1, ($used/$limit)]|min)]|max else 0 end) as $ratio |
  ($ratio*24|floor) as $filled | $color + "[" + ("#"*$filled) + ("-"*(24-$filled)) + "]" + $R;
def meter:
  (.used|tonumber) as $used | (.limit|tonumber) as $limit |
  (if $limit > 0 then $used*100/$limit else 0 end) as $pct |
  (if $pct >= 95 then $RED elif $pct >= 80 then $Y else $G end) as $color |
  "  \(.name)  " + gauge($used;$limit;$color) + " \($pct*10|floor/10)%  " +
  (if (.name|endswith("bytes")) then ($used|bytes) + " / " + ($limit|bytes) else "\($used) / \($limit)" end) +
  "  \(.severity)";
def request_rows($threads):
  . as $q | ($threads[.thread_id // ""] // {}) as $thread |
  "  " + (.status.kind|styled_state) + "  " + $B + .request_id + $R + "  " + (($thread.title // "[thread title unavailable]")|short(72)),
  "    \(.created.actor_id) -> " + $B + .resolver_id + $R + "  (\(.responsibility.kind))  priority=\(.priority // "0")  " +
    $D + (.created.timestamp|ago(now)) + $R +
    (if .deadline_unix_ms then "  deadline(ms)=\(.deadline_unix_ms)" else "" end),
  ([$thread.links[]? | select(.kind=="ticket") | .id] | if length > 0 then "    on " + join(", ") else empty end);
def run_rows($tickets):
  . as $run | [$tickets[] | select(.claim != null and .claim.run_id == $run.run_id) | .ticket_id] as $work |
  "  " + $B + .run_id + $R + "  " + .actor_id + "  " + (.status|styled_state) +
    (if ($work|length)>0 then "  on " + ($work|join(", ")) else "  " + $D + "no claimed tickets in this view" + $R end),
  "    " + (.objective // ""|short(90)) + (if (.capabilities|length)>0 then "  [" + (.capabilities|join(", ")) + "]" else "" end);
def ticket_row:
  "  " + $B + .ticket_id + $R + "  " + (.title|short(72)) +
    (if (.label_ids|length)>0 then "  " + $D + "[" + (.label_ids|join(", ")) + "]" + $R else "" end);

def tgt: if .kind == "ticket" then .ticket_id // .id elif .kind == "project" then "project " + (.project_id // .id)
  elif .kind == "workspace" then "workspace" else (.kind + " " + (.id // "")) end;
def line($ts; $who; $icon; $text): "\($D)\($ts|t)\($R)  \($who|pad(12))  \($icon) \($text)";
def event:
  . as $it
  | ([.changes[] | select(.kind == "ticket_put" and .ticket.revision == "1") | .ticket.ticket_id]) as $created
  | .changes[]
  | if .kind == "ticket_put" then .ticket as $k
      | if $k.revision == "1" then line($it.timestamp; $it|who; "\($C)+\($R)"; "created \($B)\($k.ticket_id)\($R)  \($k.title|short(60))")
        elif $k.status == "in_progress" and $k.claim then line($it.timestamp; $it|who; "\($Y)>\($R)"; "working on \($B)\($k.ticket_id)\($R)")
        elif $k.status == "done" then line($it.timestamp; $it|who; "\($G)v\($R)"; "finished \($B)\($k.ticket_id)\($R)")
        elif $k.status == "canceled" then line($it.timestamp; $it|who; "\($D)x\($R)"; "canceled \($k.ticket_id)")
        elif ($created | index($k.ticket_id)) then empty
        elif $k.claim == null and $k.status == "todo" then line($it.timestamp; $it|who; "\($D)~\($R)"; "\($k.ticket_id) is unclaimed again (released or edited)")
        else line($it.timestamp; $it|who; "\($D)~\($R)"; "updated \($k.ticket_id) (\($k.status))") end
    elif .kind == "comment_changed" and .change.kind == "create" then .change as $c
      | ($c.version.body|one) as $body
      | if ($c.comment_id|startswith("ask-")) then line($it.timestamp; $it|who; "\($M)?\($R)"; "asked: \($body)")
        elif ($c.comment_id|startswith("answer-")) then line($it.timestamp; $it|who; "\($M)!\($R)"; "answered: \($body)")
        elif ($c.comment_id|startswith("message-")) then line($it.timestamp; $it|who; "\($M)@\($R)"; "message: \($body)")
        elif $c.comment_kind == "decision" then line($it.timestamp; $it|who; "\($C)*\($R)"; "\($B)decision\($R) on \($c.target|tgt): \($body)")
        elif $c.comment_kind == "evidence" then line($it.timestamp; $it|who; "\($G)=\($R)"; "evidence on \($c.target|tgt): \($body)")
        elif $c.comment_kind == "blocker" then line($it.timestamp; $it|who; "\($RED)!\($R)"; "\($RED)blocker\($R) on \($c.target|tgt): \($body)")
        else line($it.timestamp; $it|who; "\($D)-\($R)"; "note on \($c.target|tgt): \($body)") end
    elif .kind == "communication_changed" and .event.update.kind == "request_put" then .event.update as $u
      | if $u.notification_kind == "request_created" then line($it.timestamp; $it|who; "\($M)?\($R)"; "opened question \($B)\($u.request.request_id)\($R) for \($u.request.resolver_id)")
        elif $u.notification_kind == "request_resolved" then line($it.timestamp; $it|who; "\($G)v\($R)"; "resolved question \($B)\($u.request.request_id)\($R)")
        else line($it.timestamp; $it|who; "\($M)~\($R)"; "question \($u.request.request_id): \($u.notification_kind // "updated")") end
    elif .kind == "agent_run_changed" and .event.update.kind == "run_put" then .event.update.run as $r
      | if $r.revision == "1" then line($it.timestamp; $it|who; "\($C)+\($R)"; "started run \($B)\($r.run_id)\($R)" + (if ($r.capabilities|length) > 0 then " (can: \($r.capabilities|join(", ")))" else "" end))
        else line($it.timestamp; $it|who; "\($D)~\($R)"; "run \($r.run_id) is now \($r.status)") end
    elif .kind == "agent_run_changed" and .event.update.kind == "ticket_policy_put" then .event.update.policy as $p
      | line($it.timestamp; $it|who; "\($C)#\($R)"; "\($p.ticket_id) now needs: \($p.required_capabilities|join(", "))")
    elif .kind == "agent_run_changed" and .event.update.kind == "path_reservation_put" then .event.update.reservation as $v
      | "\($v.target.worktree_id):\($v.target.path)\(if $v.target.kind == "subtree" then "/" else "" end)" as $where
      | if any($v.holders[]; .actor_id == $it.actor_id) then line($it.timestamp; $it|who; "\($C)#\($R)"; "reserved \($B)\($where)\($R)")
        else line($it.timestamp; $it|who; "\($D)#\($R)"; "released \($where)") end
    elif .kind == "agent_run_changed" and .event.update.kind == "ticket_paths_put" then .event.update.paths as $q
      | line($it.timestamp; $it|who; "\($C)#\($R)"; "\($q.ticket_id) will need: \([$q.declarations[] | "\(.target.worktree_id):\(.target.path) (\(.mode))"] | join(", "))")
    elif .kind == "agent_run_changed" and .event.update.kind == "pool_put" then
      line($it.timestamp; $it|who; "\($C)#\($R)"; "pool \(.event.update.pool.name // "?") allows \(.event.update.pool.limit // "?") at a time")
    elif .kind == "allocation_empty" then line($it.timestamp; $it|who; "\($D).\($R)"; "\($D)asked for work, nothing available\($R)")
    elif .kind == "resource_changed" then .change as $c
      | line($it.timestamp; $it|who; "\($C)#\($R)"; "\($c.kind) file \($B)\($c.resource_id)\($R)" + (if $c.metadata.title then "  \($c.metadata.title|short(50))" else "" end))
    elif .kind == "facts_changed" then .fact as $f
      | line($it.timestamp; $it|who; "\($C)#\($R)"; "fact \($f.key) = \($f.value|tojson|short(60))")
    elif .kind == "project_put" then line($it.timestamp; $it|who; "\($C)+\($R)"; "project \($B)\(.project.project_id)\($R) (\(.project.status))")
    else empty end;
def events: .data.items[] | . as $it | [event] | if length > 0 then .[] else line($it.timestamp;$it|who;"·";"commit " + $it.revision + " (expand activity.since)") end;
'

# Escape untrusted terminal controls before adding our own optional styles.
JQLIB+='
def hex4: . as $n | [4096,256,16,1] | map(. as $d | "0123456789abcdef"[((($n/$d)|floor)%16):(((($n/$d)|floor)%16)+1)]) | join("");
def clean: walk(if type == "string" then explode | map(if . < 32 or (.>=127 and .<=159) or (.>=8234 and .<=8238) or (.>=8294 and .<=8297) then "\\u" + hex4 else [.]|implode end) | join("") else . end);
'
render() { local filter=$1; shift; jq -r "${COLORS[@]}" "$@" "$JQLIB clean | $filter"; }

cmd_feed() {
  local n=${1:-30} ov revision from value
  uint "$n" 1 1000 && [ "$#" -le 1 ] || { fail 'feed N requires 1..1000'; return 2; }
  ov=$(wg workspace.overview) || return 1
  revision=$(jq -er '.meta.workspace_revision' <<<"$ov") || return 1
  from=$((revision > n ? revision-n : 0))
  value=$(pages activity.since --after "$from" --at-revision "$revision") || return 1
  # Every commit contributes at least one line, including unknown event types;
  # therefore the last N commits contain the last N rendered lines.
  render 'events' <<<"$value" | tail -n "$n"
}

cmd_watch() {
  local cursor='' after page next count=0 bytes=0 size metadata='' activity first last
  if [ "${1:-}" = --metadata ]; then metadata=1; shift; fi
  case "$#:${1:-}" in
    0:) page=$(wg workspace.overview) || return 1; after=$(jq -er '.meta.workspace_revision' <<<"$page") || return 1 ;;
    1:--all) after=0 ;;
    2:--cursor) [ -n "$2" ] || return 2; cursor=$2 ;;
    *) fail 'watch accepts [--metadata] [--all or --cursor CURSOR]'; return 2 ;;
  esac
  trap 'fail "interrupted; retained cursor: $cursor (initial after: ${after:-not supplied})"; exit 130' INT
  trap 'fail "interrupted; retained cursor: $cursor (initial after: ${after:-not supplied})"; exit 143' TERM
  if [ -n "$cursor" ]; then page=$(wg changes.read --source planning --cursor "$cursor" --limit 100 --max-bytes 1048576) || { fail "retained cursor: $cursor"; return 1; }
  else page=$(wg changes.read --source planning --after "$after" --limit 100 --max-bytes 1048576) || return 1; fi
  while :; do
    if ! jq -e '.data.needs_larger_budget == false and (.data.cursor|type == "string" and length > 0) and (.data.items|type == "array")' <<<"$page" >/dev/null; then
      fail "watch budget/invalid page; retained cursor: $cursor"; return 1
    fi
    next=$(jq -er '.data.cursor' <<<"$page") || return 1
    if jq -e '.data.has_more == true' <<<"$page" >/dev/null && [ "$next" = "$cursor" ]; then fail "watch made no progress; retained cursor: $cursor"; return 1; fi
    size=$(printf '%s' "$page" | wc -c); bytes=$((bytes+size)); count=$((count+1))
    if [ "$count" -gt "$MAX_PAGES" ] || [ "$bytes" -gt "$TOTAL_BYTES" ]; then fail "watch drain limit; retained cursor: $cursor"; return 1; fi
    if [ -n "$metadata" ]; then
      # kinds are distinct event tags, not a count of changes in the commit.
      render '.data.items[] | $D + "revision " + .revision + $R + "  " + (.timestamp|t) + "  " + $B + .actor_id + $R + (if .run_id then " (" + .run_id + ")" else "" end) + "  " + $C + (.targets|map(tgt)|join(", ")) + $R + "  " + $M + (.kinds|join(", ")) + $R' <<<"$page" || return 1
    elif jq -e '.data.items|length>0' <<<"$page" >/dev/null; then
      first=$(jq -er '.data.items[0].revision' <<<"$page") || return 1
      last=$(jq -er '.data.items[-1].revision' <<<"$page") || return 1
      # Expand only the consumed interval. The original cursor remains the retry
      # boundary until all captured activity has been fetched and rendered.
      activity=$(pages activity.since --after "$((first-1))" --at-revision "$last") || { fail "retained cursor: $cursor (initial after: ${after:-not supplied})"; return 1; }
      size=$(printf '%s' "$activity" | wc -c); bytes=$((bytes+size))
      if [ "$bytes" -gt "$TOTAL_BYTES" ]; then fail "watch activity byte limit; retained cursor: $cursor"; return 1; fi
      render 'events' <<<"$activity" || { fail "retained cursor: $cursor"; return 1; }
    fi
    cursor=$next                         # only after the returned rows were emitted
    if jq -e '.data.has_more == true' <<<"$page" >/dev/null; then
      page=$(wg changes.read --source planning --cursor "$cursor" --limit 100 --max-bytes 1048576) || { fail "retained cursor: $cursor"; return 1; }
    else
      count=0; bytes=0
      page=$(wg changes.wait --source planning --cursor "$cursor" --timeout-ms 25000 --limit 100 --max-bytes 1048576) || { fail "retained cursor: $cursor"; return 1; }
    fi
  done
}

status_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in -p|--run) [ "$#" -ge 2 ] && identifier "$2" || { fail 'missing/invalid status selector'; return 2; }; shift 2 ;; *) fail 'status/dash accepts -p PROJECT and --run RUN'; return 2 ;; esac
  done
}
cmd_status() {
  status_args "$@" || return 2
  local project='' run='' pf=() rf=() ov tl ready rq rn pr mt threads recent revision from
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -p) project=$2; pf=(--project-id "$2"); shift 2 ;;
      --run) run=$2; rf=(--target-run-id "$2"); shift 2 ;;
    esac
  done
  ov=$(wg workspace.overview) || return 1
  revision=$(jq -er '.meta.workspace_revision' <<<"$ov") || return 1
  tl=$(all_tickets "${pf[@]}" --at-revision "$revision") || return 1
  ready=$(pages ticket.ready "${pf[@]}" "${rf[@]}" --at-revision "$revision") || return 1
  rq=$(pages request.list) || return 1
  # Thread labels share the request capture, not a later mutable observation.
  threads=$(pages thread.list --revision "$(jq -er '.meta.query_revision' <<<"$rq")") || return 1
  rn=$(pages run.list) || return 1
  pr=$(pages reservation.path.list) || return 1; mt=$(wg workspace.metrics) || return 1
  from=$((revision > 6 ? revision-6 : 0))
  recent=$(pages activity.since --after "$from" --at-revision "$revision") || return 1
  printf '%s\n' "$tl" "$ready" "$rq" "$rn" "$pr" "$mt" "$threads" "$recent" | render '
    . as [$tickets,$ready,$requests,$runs,$paths,$metrics,$threads,$recent] | $tickets.data.items as $T |
    ($threads.data.items|map({key:.thread_id,value:.})|from_entries) as $TH |
    [$T[]|select(.status=="in_progress")] as $doing |
    [$T[]|select(.status=="done")] as $done |
    [$T[]|select(.status=="canceled")] as $canceled |
    [$T[]|select(.status=="todo")|. as $t|select(all($ready.data.items[];.ticket_id != $t.ticket_id))] as $waiting |
    [$requests.data.items[]|select(.status.kind=="open")] as $open |
    def count_row($label;$n;$color): "  " + $color + ($label|pad(12)) + $R + " " + ($n|pad(5)) + gauge($n;($T|length);$color);
    $B + "Workgraph" + $R + " · " + $ws + " · planning capture " + $revision + (if $project=="" then "" else " · project " + $project end),
    "Readiness: " + (if $run=="" then "graph-ready only; select --run RUN for worker eligibility" else "eligible for run " + $run end),
    "", count_row("done";($done|length);$G), count_row("working";($doing|length);$Y),
    count_row("ready";($ready.data.items|length);$C), count_row("other todo";($waiting|length);$M),
    (if ($canceled|length)>0 then count_row("canceled";($canceled|length);$D) else empty end),
    "  " + $D + "\($T|length) tickets · \($open|length) open requests (workspace-wide)" + $R,
    hdr("IN PROGRESS"),
    ([$doing[]|ticket_row, ("    " + $Y + (.claim|whorun) + $R + "  " + $D + (.updated_at|ago(now)) + $R)]|empty_rows),
    hdr(if $run=="" then "GRAPH READY (not run eligibility)" else "ELIGIBLE FOR " + $run end),
    ([$ready.data.items[]|ticket_row]|empty_rows),
    hdr("OTHER TODO (inspect ticket.readiness for exact reasons)"),
    ([$waiting[]|ticket_row,
      (if (.prerequisite_ticket_ids|length)>0 then "    " + $D + "declared prerequisites: " + (.prerequisite_ticket_ids|join(", ")) + $R else empty end),
      (if .hold then "    " + $RED + "hold: " + (.hold|tojson|short(100)) + $R else empty end)]|empty_rows),
    hdr("OPEN REQUESTS (workspace-wide)"), ([$open[]|request_rows($TH)]|empty_rows),
    hdr("RUNS (caller-reported, workspace-wide)"), ([$runs.data.items[]|run_rows($T)]|empty_rows),
    hdr("RESERVED FILES (workspace-wide)"),
    ([$paths.data.items[]|. as $p|.holders[]|"  " + $C + "\($p.target.worktree_id):\($p.target.path)" + $R + "  \(.actor_id)/\(.run_id)  \(.mode) token=\(.token)"]|empty_rows),
    hdr("RECENT (workspace-wide; last 6 rendered events at this planning capture)"),
    ([$recent|events]|.[-6:]|map("  " + .)|empty_rows),
    hdr("STORAGE (independent named meters)"),
    (($metrics.data.planning_admission + $metrics.data.storage_admission)[]? | select(.name=="planning_payload_bytes" or .name=="history_batch_bytes") | meter),
    "\n" + $D + "Panels have independent captured collection revisions; list text is a preview. No read acknowledges an inbox." + $R,
    $D + "Details: wgx ticket ID · questions · agents · feed 30 · storage" + $R
  ' -s --arg ws "$(jq -er '.workspace_id' "$CTX")" --arg revision "$revision" --arg project "$project" --arg run "$run"
}

dashboard() {
  local script
  script="$(cd "$(dirname "$0")" && pwd)/wgx_dashboard.py"
  command -v python3 >/dev/null && [ -f "$script" ] || { fail 'dash/tree require Python 3 and wgx_dashboard.py beside wgx; reinstall both viewer files'; return 1; }
  python3 "$script" --wg "$WG" --context "$CTX" "$@"
}
cmd_dash() {
  status_args "$@" || return 2
  if [ ! -t 0 ] || [ ! -t 1 ] || [ "${TERM:-dumb}" = dumb ]; then cmd_status "$@"; return $?; fi
  # Replace Bash so terminal signals reach the UI and its cancellable read worker.
  local script
  script="$(cd "$(dirname "$0")" && pwd)/wgx_dashboard.py"
  command -v python3 >/dev/null && [ -f "$script" ] || { fail 'dash requires Python 3 and the adjacent wgx_dashboard.py'; return 1; }
  exec python3 "$script" --wg "$WG" --context "$CTX" "$@"
}

cmd_ticket() {
  local id=$1 context comments resources target
  identifier "$id" || return 2
  target=$(jq -nc --arg id "$id" '{kind:"ticket",id:$id}')
  context=$(wg ticket.context --ticket-id "$id" --max-bytes 1048576) || return 1
  comments=$(pages comment.list --json-field target "$target") || return 1
  resources=$(pages resource.list --json-field target "$target") || return 1
  if jq -e '.meta.budget.truncated == true' <<<"$context" >/dev/null; then fail 'ticket context has omissions; inspect its budget/continuation metadata'; return 1; fi
  printf '%s\n' "$context" "$comments" "$resources" | render '
    . as [$x,$comments,$resources] | $x.data.ticket as $t |
    $B + "\($t.display_key // "")  \($t.ticket_id) — \($t.title)" + $R,
    "status=" + ($t.status|styled_state) + " project=\($t.project_id // "none") priority=\($t.priority)",
    "owner=" + $Y + ($t.claim|whorun) + $R + (if $t.claim then " token=\($t.claim.token)" else "" end),
    (if ($t.label_ids|length)>0 then "labels: " + ($t.label_ids|join(", ")) else empty end),
    (if $t.parent_ticket_id then "parent: " + $t.parent_ticket_id else empty end),
    (if ($t.prerequisite_ticket_ids|length)>0 then "declared prerequisites: " + ($t.prerequisite_ticket_ids|join(", ")) else empty end),
    (if ($x.data.blocker_ticket_ids|length)>0 then $RED + "blocked by: " + ($x.data.blocker_ticket_ids|join(", ")) + $R else empty end),
    (if $t.hold then $RED + "hold: " + ($t.hold|tojson) + $R else empty end),
    hdr("TASK"), $t.description, hdr("ACCEPTANCE"), $t.acceptance_criteria,
    (if $x.data.handoff then hdr("HANDOFF"), ($x.data.handoff | to_entries[] | "\(.key): \(.value|if type=="string" then . else tojson end)") else empty end),
    hdr("NOTES, DECISIONS, EVIDENCE (all captured rows; body previews)"),
    ([$comments.data.items[] |
      (if .kind=="decision" then $C elif .kind=="evidence" then $G elif .kind=="blocker" then $RED else $D end) as $color |
      "  " + (.created_at|t) + "  " + (.author_id // .actor_id // "?") + "  " + $color + .kind + $R + "  " + .comment_id,
      "    " + (.body|one)]|empty_rows),
    hdr("LINKED RESOURCES"), ([$resources.data.items[] | "  " + $C + .resource_id + $R + "  " + .metadata.title]|empty_rows),
    $D + "Expand clipped bodies: comment.get --comment-id ID; full bounded context: ticket.context --ticket-id " + $t.ticket_id + $R
  ' -s
}
cmd_questions() {
  local value threads; value=$(pages request.list) || return 1
  threads=$(pages thread.list --revision "$(jq -er '.meta.query_revision' <<<"$value")") || return 1
  printf '%s\n' "$value" "$threads" | render '
    . as [$requests,$threads] | ($threads.data.items|map({key:.thread_id,value:.})|from_entries) as $TH |
    $B + "QUESTIONS / REQUESTS" + $R,
    ([$requests.data.items[]|request_rows($TH)]|empty_rows),
    $D + "Expand question/answer: request.get --request-id ID --include-messages true" + $R' -s
}
cmd_agents() {
  local runs tickets; runs=$(pages run.list) || return 1; tickets=$(all_tickets --status in_progress) || return 1
  printf '%s\n' "$runs" "$tickets" | render '. as [$runs,$tickets] |
    $B + "RUN / ACTOR / REPORTED STATE / WORK / CAPABILITIES / OBJECTIVE" + $R,
    ([$runs.data.items[]|run_rows($tickets.data.items)]|empty_rows),
    $D + "Reported state is not process liveness." + $R' -s
}
cmd_inbox() {
  local actor=$1 consumer=${2:-$1} value recipient
  identifier "$actor" && identifier "$consumer" || return 2
  recipient=$(jq -nc --arg id "$actor" '{kind:"actor",id:$id}')
  value=$(pages inbox.read --consumer-id "$consumer" --json-field recipient "$recipient") || return 1
  printf 'Unacknowledged for %s / consumer %s (read only)\n' "$actor" "$consumer"
  render '[.data.items[] | $B + .notification_id + $R + " \(.kind) from \(.attribution.actor_id) " + $D + (.attribution.timestamp|ago(now)) + $R + "  \(.body_source.body // "[no body supplied]"|one)"]|empty_rows' <<<"$value"
}
cmd_output() (
  local id=$1 limit=4096 raw='' tmp receipt inspection stream offset retained
  shift; identifier "$id" || return 2
  case "$#:${1:-}" in 0:) ;; 2:--limit) limit=$2; uint "$limit" 1 65536 || return 2 ;; 2:--raw) raw=$2; case "$raw" in stdout|stderr) ;; *) return 2 ;; esac ;; *) return 2 ;; esac
  umask 077; tmp=$(mktemp -d "${TMPDIR:-/tmp}/wgx-inspect.XXXXXXXX") || return 1
  trap 'rm -f "$tmp/command.json" "$tmp/capture.json"; rmdir "$tmp"' EXIT
  trap 'exit 130' INT; trap 'exit 143' TERM
  receipt=$(wg resource.download --resource-id "$id" --destination "$tmp/capture.json") || return 1
  jq -ce '.command' "$tmp/capture.json" > "$tmp/command.json" || return 1
  # The public typed decoder validates the untouched complete capture before any
  # stream output. This is a private inspection copy, never a launch/publication.
  for stream in stdout stderr; do
    inspection=$("$WG" evidence-show --stage "$tmp" --"$stream" --length "$limit" --output json) || return 1
    if [ -n "$raw" ]; then
      [ "$stream" = "$raw" ] || continue
      jq -c 'del(.text,.data_base64)' <<<"$inspection" >&2
      retained=$(jq -er '.retained_bytes' <<<"$inspection"); offset=0
      while [ "$offset" -lt "$retained" ]; do
        "$WG" evidence-show --stage "$tmp" --"$raw" --offset "$offset" --length 65536 --output bytes || return 1
        offset=$((offset+65536))
      done
    else
      if [ "$stream" = stdout ]; then
        render '"$ " + (.command.argv|join(" ")) + " (cwd " + .command.cwd + ")"' < "$tmp/capture.json" || return 1
        render '"Verified resource: " + (.data|del(.destination)|tojson)' <<<"$receipt" || return 1
      fi
      render '"--- " + .stream + " (safe decoded preview) ---", (del(.text,.data_base64)|tojson), .text, "Use output RESOURCE --raw STREAM > FILE for exact retained bytes; discarded bytes cannot be reconstructed."' <<<"$inspection" || return 1
    fi
  done
)
cmd_storage() {
  local value; value=$(wg workspace.metrics) || return 1
  render '(.data.planning_admission + .data.storage_admission)[] | meter, ("    remaining=\(.remaining // "unknown") lifetime=\(.lifetime)")' <<<"$value" || return 1
  echo 'Advisory: at 80% of a cumulative meter, plan a successor workspace; retained data is not silently freed. See skills/workgraph/references/capacity-rollover.md.'
}
cmd_files() {
  local value; value=$(pages reservation.path.list) || return 1
  render '[.data.items[] | . as $p | .holders[] | $C + "\($p.target.worktree_id):\($p.target.path)" + $R + " \(.actor_id)/\(.run_id) \(.mode) token=\(.token) deadline=\(.lease.deadline_unix_ms // "none") (expiry does not remove ownership)"]|empty_rows' <<<"$value"
}
cmd_history() {
  local value; [ -n "$1" ] || return 2; value=$(pages history.search --text "$1") || return 1
  render '(.data.items[]|"\(.event_ref.session_id)#\(.event_ref.sequence) \(.role)/\(.kind) \(.snippet|one)"), "Index complete=\(.data.complete) unindexed=\(.data.unindexed_events) unsearchable=\(.data.unsearchable_events). A no-hit partial index is not absence. Preview: convo SESSION SEQ."' <<<"$value"
}
cmd_convo() {
  local session=$1 sequence=${2:-0} n=${3:-8} value head event ref payload anchor part
  identifier "$session" && uint "$sequence" 0 1000000 && uint "$n" 1 100 || return 2
  # A bounded forward window, not a fabricated around-page continuation.
  anchor=$((sequence > 0 ? sequence-1 : 0))
  value=$(wg history.read --session-id "$session" --direction after --anchor "$anchor" --limit "$n" --max-bytes 1048576) || return 1
  head=$(jq -er '.meta.history_capture.head' <<<"$value") || return 1
  while IFS= read -r event; do
    render '"#\(.event_ref.sequence) \(.actor_id) \(.event.role)/\(.event.kind)"' <<<"$event"
    ref=$(jq -c '.event_ref' <<<"$event")
    part=payload; [ "$(jq -r '.event.searchable_text != null' <<<"$event")" = true ] && part=searchable_text
    payload=$(wg history.payload --head "$head" --json-field event_ref "$ref" --json-field part "{\"kind\":\"$part\"}" --length 1200) || return 1
    # Best-effort UTF8, explicitly a preview; exact base64 and byte continuation
    # remain available. Sanitize AFTER decoding, including a clipped UTF8 suffix.
    render '"best-effort UTF8 preview: " + (.data.bytes_base64|@base64d|clean), "exact preview base64: " + .data.bytes_base64, "total=\(.data.total_bytes) next_offset=\(.data.next_offset) has_more=\(.data.has_more)"' <<<"$payload"
  done < <(jq -c '.data.items[]' <<<"$value")
  render '"History window has_more=\(.data.has_more) next_anchor=\(.data.next_anchor) omitted_for_budget=\(.data.omitted_for_budget). Preserve head " + $head + "; expand with history.payload."' --arg head "$head" <<<"$value"
}
command=${1:-status}; [ "$#" -eq 0 ] || shift
case "$command" in
  status) cmd_status "$@" ;; dash) cmd_dash "$@" ;; watch) cmd_watch "$@" ;; feed) cmd_feed "$@" ;;
  tree) [ "$#" -eq 1 ] && identifier "$1" || exit 2; dashboard --tree "$1" ;;
  ticket) [ "$#" -eq 1 ] && cmd_ticket "$@" ;; questions) [ "$#" -eq 0 ] && cmd_questions ;;
  agents) [ "$#" -eq 0 ] && cmd_agents ;; inbox) [ "$#" -ge 1 ] && [ "$#" -le 2 ] && cmd_inbox "$@" ;;
  output) [ "$#" -ge 1 ] && cmd_output "$@" ;; storage) [ "$#" -eq 0 ] && cmd_storage ;; files) [ "$#" -eq 0 ] && cmd_files ;;
  history) [ "$#" -eq 1 ] && cmd_history "$@" ;; convo) [ "$#" -ge 1 ] && [ "$#" -le 3 ] && cmd_convo "$@" ;;
  *) fail "unknown command: $command (try help)"; exit 2 ;;
esac
