#!/usr/bin/env bash
# wgx: readable terminal views of a Workgraph workspace (read-only).
#
#   wgx status [-p PROJECT]      one-screen dashboard: tickets, owners, questions, agents, storage
#   wgx dash   [-p PROJECT]      the dashboard, redrawn every time something changes (Ctrl-C to quit)
#   wgx watch  [--all]           live event stream: one plain-English line per change (--all replays history first)
#   wgx feed   [N]               the last N events (default 30)
#   wgx ticket TICKET            one ticket: task, owner, prerequisites, handoff, notes, decisions, evidence, files
#   wgx questions                tracked questions: who asked, who must answer, status
#   wgx agents                   registered runs and what each one is working on
#   wgx inbox ACTOR [CONSUMER]   notifications ACTOR has not acknowledged (consumer id defaults to ACTOR)
#   wgx output RESOURCE          the captured stdout/stderr inside an evidence-run resource
#   wgx storage                  how much of the workspace's lifetime budget is used
#   wgx files                    which files/folders are reserved, by whom
#   wgx history TEXT             search saved agent conversations
#   wgx convo SESSION [SEQ] [N]  read N saved conversation events around SEQ (default: the start)
#
# Needs: workgraph 0.4, jq. Uses $WG_CONTEXT, or pass --context FILE before the command.
# Nothing here writes to Workgraph.

set -o pipefail
# macOS ships Bash 3.2, where nounset rejects valid empty array expansions.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"

CTX=${WG_CONTEXT:-$HOME/.local/state/workgraph-0.4/agent.json}
if [ "${1:-}" = "--context" ]; then CTX=$2; shift 2; fi
case "${1:-}" in -h|--help|help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;; esac
command -v jq >/dev/null || { echo "wgx: jq is required (sudo dnf install -y jq)" >&2; exit 1; }
[ -f "$CTX" ] || { echo "wgx: no context file at $CTX (set WG_CONTEXT or pass --context FILE)" >&2; exit 1; }

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\e[1m' D=$'\e[2m' R=$'\e[0m' G=$'\e[32m' Y=$'\e[33m' C=$'\e[36m' M=$'\e[35m' RED=$'\e[31m'
else
  B='' D='' R='' G='' Y='' C='' M='' RED=''
fi
COLORS=(--arg B "$B" --arg D "$D" --arg R "$R" --arg G "$G" --arg Y "$Y" --arg C "$C" --arg M "$M" --arg RED "$RED")

# Read-only call; prints .result as JSON, or a clear error and a non-zero status.
wg() {
  local out
  if ! out=$(workgraph "$@" --context "$CTX"); then
    echo "wgx: Workgraph command failed: $*" >&2; return 1
  fi
  if [ -z "$out" ]; then echo "wgx: '$*' failed: is the daemon running? (try: workgraph daemon health --context $CTX)" >&2; return 1; fi
  if echo "$out" | jq -e 'has("error") or has("kind")' >/dev/null 2>&1; then
    echo "wgx: '$*': $(echo "$out" | jq -r '.error.data.message // .error.message // .message')" >&2; return 1
  fi
  printf '%s\n' "$out" | jq -ce 'if has("result") and (.result | type == "object") then .result else error("missing result envelope") end'
}

# For each request in a request-list result, look up its thread's title and linked ticket.
# Prints {"REQUEST_ID": {"title": ..., "ticket": ...}, ...}; only open requests unless ALL=1.
thread_info() {
  local rq=$1 all=${2:-0}
  echo "$rq" | jq -r --arg all "$all" '.data.items[] | select($all == "1" or .status.kind != "resolved") | "\(.request_id) \(.thread_id)"' \
    | while read -r rid th; do
        wg thread get --thread-id "$th" | jq -c --arg rid "$rid" '{($rid): {title: .data.title, ticket: ([.data.links[]? | select(.kind == "ticket") | .id] | join(","))}}'
      done | jq -s 'add // {}'
}

# Every page of ticket.list as one {data:{items}} object (pages pinned to one revision).
all_tickets() {
  local off=0 at=() page out=""
  while :; do
    page=$(wg ticket list "$@" --limit 100 --max-bytes 1048576 --offset "$off" "${at[@]}") || return 1
    [ ${#at[@]} -eq 0 ] && at=(--at-revision "$(jq -r .meta.workspace_revision <<<"$page")")
    out+="$page"$'\n'
    off=$(jq -r '.data.next_offset // empty' <<<"$page"); [ -z "$off" ] && break
  done
  jq -sc '{data: {items: (map(.data.items) | add // [])}}' <<<"$out"
}

# Shared jq helpers: time formatting and the event formatter.
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
def whorun: (.actor_id // "?") + (if .run_id then " (" + .run_id + ")" else "" end);
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
'

cmd_feed() {
  local n=${1:-30} rev from
  rev=$(wg workspace overview | jq -r .meta.workspace_revision) || return 1
  from=$(( rev > n ? rev - n : 0 ))
  wg activity since --after "$from" --limit 100 --max-bytes 1048576 \
    | jq -r "${COLORS[@]}" "$JQLIB"' .data.items[] | event'
}

cmd_watch() {
  local rev
  rev=$(wg workspace overview | jq -r .meta.workspace_revision) || return 1
  [ "${1:-}" = "--all" ] && rev=0
  echo "${B}Watching workspace $(jq -r .workspace_id "$CTX")${R} from revision $rev. Ctrl-C to stop." >&2
  while true; do
    local page
    page=$(wg activity since --after "$rev" --limit 100 --max-bytes 1048576) || { sleep 3; continue; }
    echo "$page" | jq -r "${COLORS[@]}" "$JQLIB"' .data.items[] | event'
    local last; last=$(echo "$page" | jq -r '.data.items[-1].revision // empty')
    [ -n "$last" ] && rev=$last
    [ "$(echo "$page" | jq -r '.data.remaining')" != "0" ] && continue
    wg changes wait --after "$rev" --timeout-ms 25000 >/dev/null || sleep 3
    sleep 1   # coalesce bursts of writes into one redraw
  done
}

cmd_status() {
  local project=""
  [ "${1:-}" = "-p" ] && project=$2
  local pf=(); [ -n "$project" ] && pf=(--project-id "$project")
  local ov tl rq rn mt fd
  ov=$(wg workspace overview) || return 1
  tl=$(all_tickets "${pf[@]}") || return 1
  rq=$(wg request list --limit 100) || rq='{"data":{"items":[]}}'
  rn=$(wg run list) || rn='{"data":{"items":[]}}'
  local pr; pr=$(wg reservation path.list --limit 100 --max-bytes 1048576) || pr='{"data":{"items":[]}}'
  mt=$(wg workspace metrics) || mt='{"data":{"planning_admission":[],"storage_admission":[]}}'
  fd=$(cmd_feed 6 2>/dev/null)
  local ti; ti=$(thread_info "$rq")
  printf '%s\n' "$ov" "$tl" "$rq" "$rn" "$mt" "$ti" "$pr" | jq -sr "${COLORS[@]}" \
    --arg ws "$(jq -r .workspace_id "$CTX")" --arg project "$project" --arg feed "$fd" --argjson max "${WGX_MAX:-100000}" "$JQLIB"'
    . as [$ov, $tl, $rq, $rn, $mt, $ti, $pr] |
    (now) as $now
    | $tl.data.items as $T
    | ($T | map({key: .ticket_id, value: .status}) | from_entries) as $st
    | def bar($n; $total; $col): if $total == 0 then "" else $col + ("#" * (($n * 40 / $total) | ceil)) + $R end;
      def hdr($s): "\n\($B)\($s)\($R)";
      def more($a): if ($a|length) > $max then "  \($D)+ \(($a|length) - $max) more (wgx status -p PROJECT shows all)\($R)" else empty end;
    ($T | map(select(.status == "todo")) | map(. + {waits: [.prerequisite_ticket_ids[] | select(($st[.] // "done") != "done")]})) as $todo
    | ($todo | map(select((.waits|length) == 0))) as $ready
    | ($todo | map(select((.waits|length) > 0))) as $blocked
    | ($T | map(select(.status == "in_progress"))) as $doing
    | ($T | map(select(.status == "done")) | length) as $done
    | ($T | length) as $total
    | "\($B)Workgraph\($R) · workspace \($B)\($ws)\($R)" + (if $project != "" then " · project \($B)\($project)\($R)" else "" end)
      + " · revision \($ov.meta.workspace_revision) · \(now | strftime("%H:%M:%S")) UTC",
      "",
      "  done        \($done|pad(4)) \(bar($done; $total; $G))",
      "  working     \($doing|length|pad(4)) \(bar($doing|length; $total; $Y))",
      "  ready       \($ready|length|pad(4)) \(bar($ready|length; $total; $C))",
      "  waiting     \($blocked|length|pad(4)) \(bar($blocked|length; $total; $D))",
      hdr("IN PROGRESS"),
      (if ($doing|length) == 0 then "  \($D)nobody is working on a ticket right now\($R)" else
        ($doing[] | "  \($Y)>\($R) \(.ticket_id|pad(36)) \(.title|short(40)|pad(40))  \(.claim|whorun|pad(30)) \($D)\(.updated_at|ago($now))\($R)") end),
      hdr("READY TO START"),
      (if ($ready|length) == 0 then "  \($D)none\($R)" else
        ($ready[:$max][] | "  \($C)o\($R) \(.ticket_id|pad(36)) \(.title|short(40)|pad(40))" + (if (.label_ids|length) > 0 then "  \($D)[\(.label_ids|join(","))]\($R)" else "" end)), more($ready) end),
      hdr("WAITING ON OTHER TICKETS"),
      (if ($blocked|length) == 0 then "  \($D)none\($R)" else
        ($blocked[:$max][] | "  \($D)-\($R) \(.ticket_id|pad(36)) \(.title|short(40)|pad(40))  \($D)after \(.waits|length) tickets: \(.waits|join(", ")|short(50))\($R)"), more($blocked) end),
      hdr("OPEN QUESTIONS"),
      ([$rq.data.items[] | select(.status.kind != "resolved" and .status.kind != "cancelled" and .status.kind != "canceled")] as $open
        | if ($open|length) == 0 then "  \($D)none\($R)" else
          ($open[] | ($ti[.request_id] // {}) as $x
            | "  \($M)?\($R) \(.request_id|pad(18)) \(($x.title // "")|short(40)|pad(40)) \(.created.actor_id) -> \($B)\(.resolver_id)\($R)"
              + (if ($x.ticket // "") != "" then "  \($D)on \($x.ticket)\($R)" else "" end) + "  \($D)\(.created.timestamp|ago($now))\($R)") end),
      hdr("AGENTS (runs)"),
      ([$rn.data.items[] | select(.status == "running") | . as $r | select($max > 1000 or ([$T[] | select(.claim.run_id == $r.run_id)] | length) == 0)] as $runs
        | if ($runs|length) == 0 then "  \($D)\(if $max > 1000 then "no running runs" else "no idle runs (busy runs are listed under IN PROGRESS)" end)\($R)" else
          ($runs[] | . as $r | ([$T[] | select(.claim.run_id == $r.run_id) | .ticket_id] | join(", ")) as $on
            | "  \($r.run_id|pad(20)) \($r.actor_id|pad(14)) " + (if $on != "" then "\($Y)on \($on)\($R)" else "\($D)idle\($R)" end)
              + (if ($r.capabilities|length) > 0 then "  \($D)can: \($r.capabilities|join(","))\($R)" else "" end)) end),
      ([$pr.data.items[] | select((.holders|length) > 0)] as $held
        | if ($held|length) == 0 then empty else hdr("FILES RESERVED"),
          ($held[] | "  \($C)#\($R) \("\(.target.worktree_id):\(.target.path)\(if .target.kind == "subtree" then "/" else "" end)"|pad(34)) \([.holders[] | "\(.actor_id) (\(.mode))"] | join(", "))") end),
      hdr("RECENT"),
      ($feed | split("\n") | map(select(length > 0)) | .[] | "  " + .),
      ($mt.data.planning_admission[]? | select(.name == "planning_payload_bytes")
        | (.used|tonumber) as $u
        | "\n\($D)storage: \(if $u < 1048576 then "\($u/1024|floor) KiB" else "\($u/1048576*10|floor/10) MiB" end) of \((.limit|tonumber)/1048576|floor) MiB lifetime budget used (\($u*100/(.limit|tonumber)*100|round/100)%, \(.severity)) · details: wgx storage\($R)")
  '
}

cmd_dash() {
  # Full status, scrollable, redrawn in place when the workspace changes; the scroll position survives redraws.
  local off=0 last="" rev screen="" rows=24 cols=80 total maxoff key rest redraw=1
  local size next_rows next_cols saved_stty
  saved_stty=$(stty -g </dev/tty 2>/dev/null)
  trap 'tput smam 2>/dev/null; tput cnorm 2>/dev/null; [ -z "$saved_stty" ] || stty "$saved_stty" </dev/tty; exit 0' INT TERM
  trap 'redraw=1' WINCH
  tput civis 2>/dev/null; clear
  # Clip long logical rows instead of wrapping them into extra viewport rows.
  tput rmam 2>/dev/null
  while true; do
    # tput in $(...) can consult inherited LINES/COLUMNS or terminfo defaults.
    # Query the controlling TTY instead, and detect resizing even without new data.
    size=$(stty size </dev/tty 2>/dev/null)
    next_rows=${size%% *}; next_cols=${size##* }
    case "$next_rows" in ''|*[!0-9]*) next_rows=24 ;; esac
    case "$next_cols" in ''|*[!0-9]*) next_cols=80 ;; esac
    [ "$next_rows" -ge 2 ] || next_rows=24
    [ "$next_cols" -ge 1 ] || next_cols=80
    if [ "$rows" != "$next_rows" ] || [ "$cols" != "$next_cols" ]; then
      rows=$next_rows; cols=$next_cols; redraw=1
    fi
    rev=$(wg workspace overview 2>/dev/null | jq -r .meta.workspace_revision)
    if [ -n "$rev" ] && [ "$rev" != "$last" ]; then screen=$(WGX_MAX=${WGX_MAX:-100000} cmd_status "$@"); last=$rev; redraw=1; fi
    if [ -n "$redraw" ]; then
      total=$(printf '%s\n' "$screen" | wc -l)
      maxoff=$((total - rows + 1)); [ "$maxoff" -lt 0 ] && maxoff=0
      [ "$off" -gt "$maxoff" ] && off=$maxoff; [ "$off" -lt 0 ] && off=0
      tput cup 0 0 2>/dev/null
      printf '%s\n' "$screen" | tail -n +$((off + 1)) | head -n $((rows - 1)) | sed $'s/$/\033[K/'
      tput ed 2>/dev/null
      tput cup $((rows - 1)) 0 2>/dev/null
      printf '%s' "${D}lines $((off + 1))-$((off + rows - 1 < total ? off + rows - 1 : total)) of $total · live · j/k or arrows scroll · space/b page · g/G top/bottom · q quit${R}"
      redraw=""
    fi
    if IFS= read -rsn1 -t 2 key; then
      case "$key" in
        j) off=$((off + 1)) ;; k) off=$((off - 1)) ;;
        ' ') off=$((off + rows - 2)) ;; b) off=$((off - rows + 2)) ;;
        g) off=0 ;; G) off=1000000 ;;
        q) break ;;
        $'\e') read -rsn2 -t 1 rest
          case "$rest" in
            '[A') off=$((off - 1)) ;; '[B') off=$((off + 1)) ;;
            '[5') read -rsn1 -t 1; off=$((off - rows + 2)) ;;
            '[6') read -rsn1 -t 1; off=$((off + rows - 2)) ;;
          esac ;;
      esac
      redraw=1
    fi
  done
  trap - WINCH INT TERM
  tput smam 2>/dev/null; tput cnorm 2>/dev/null
  [ -z "$saved_stty" ] || stty "$saved_stty" </dev/tty
  echo
}

cmd_ticket() {
  local id=${1:?usage: wgx ticket TICKET}
  local ctx cm
  ctx=$(wg ticket get --ticket-id "$id" --max-bytes 1048576) || return 1
  cm=$(wg comment list --json-field target "{\"kind\":\"ticket\",\"id\":\"$id\"}" --limit 100 --max-bytes 1048576) || cm='{"data":{"items":[]}}'
  rs=$(wg resource list --limit 100) || rs='{"data":{"items":[]}}'
  printf '%s\n' "$ctx" "$cm" "$rs" | jq -sr "${COLORS[@]}" --arg id "$id" "$JQLIB"'
    . as [$x, $cm, $rs] |
    (now) as $now | $x.data.ticket as $k
    | "\($B)\($k.display_key)  \($k.ticket_id)\($R)  \($k.title)",
      "  status \($B)\($k.status)\($R) · project \($k.project_id) · priority \($k.priority)"
        + (if ($k.label_ids|length) > 0 then " · labels \($k.label_ids|join(","))" else "" end),
      (if $k.claim then "  owner  \($Y)\($k.claim|whorun)\($R) (token \($k.claim.token))" else "  owner  \($D)nobody\($R)" end),
      (if ($k.prerequisite_ticket_ids|length) > 0 then "  after  \($k.prerequisite_ticket_ids|join(", "))" else empty end),
      "",
      "\($B)TASK\($R)", ($k.description // "" | split("\n")[0:12][] | "  " + .),
      (if ($k.acceptance_criteria // "") != "" then "\n\($B)ACCEPTANCE\($R)", ($k.acceptance_criteria | split("\n")[] | "  " + .) else empty end),
      (if $x.data.handoff then $x.data.handoff as $h | "\n\($B)HANDOFF\($R) \($D)by \($h.actor_id), \($h.timestamp|ago($now))\($R)",
        ([["summary",$h.summary],["done",$h.completed],["decided",$h.decisions],["blockers",$h.blockers],["next",$h.next_steps]][]
          | select((.[1] // "") != "") | "  \(.[0]|pad(9)) \(.[1]|one)") else empty end),
      "\n\($B)NOTES, DECISIONS, EVIDENCE\($R)",
      (if ($cm.data.items|length) == 0 then "  \($D)none\($R)" else
        ($cm.data.items | sort_by(.created_at)[] |
          (if .kind == "decision" then $C + "decision" elif .kind == "evidence" then $G + "evidence" elif .kind == "blocker" then $RED + "blocker"
           else $D + .kind end) as $tag
          | "  \(.created_at|t)  \(.author_id // .actor_id|pad(12)) \($tag)\($R)  \(.body|one)") end),
      ([$rs.data.items[] | select(any(.metadata.targets[]?; .kind == "ticket" and .id == $id))] as $files
        | if ($files|length) > 0 then "\n\($B)FILES\($R)", ($files[] | "  \(.resource_id|pad(28)) \(.metadata.title // "")") else empty end)
  '
}

cmd_questions() {
  local rq ti; rq=$(wg request list --limit 100) || return 1
  ti=$(thread_info "$rq" 1)
  printf '%s\n' "$rq" "$ti" | jq -sr "${COLORS[@]}" "$JQLIB"'
    .[1] as $ti | .[0]
    | (now) as $now
    | if (.data.items|length) == 0 then "no questions or requests yet" else
      "\($B)\("REQUEST"|pad(20)) \("QUESTION"|pad(36)) \("FROM"|pad(10)) \("MUST ANSWER"|pad(12)) \("TICKET"|pad(10)) STATUS\($R)",
      (.data.items[] | ((.status.kind) as $s | ($ti[.request_id] // {}) as $x
        | "\(.request_id|pad(20)) \(($x.title // "")|short(36)|pad(36)) \(.created.actor_id|pad(10)) \(.resolver_id|pad(12)) \((if ($x.ticket // "") == "" then "-" else $x.ticket end)|pad(10)) "
          + (if $s == "resolved" then "\($G)resolved\($R) \($D)\(.status.attribution.timestamp|ago($now))\($R)"
             else "\($M)\($s)\($R) \($D)(\(.responsibility.kind)) asked \(.created.timestamp|ago($now))\($R)" end))) end
  '
  echo "${D}read one: workgraph request get --request-id ID --context \$WG_CONTEXT${R}"
}

cmd_agents() {
  local rn tl; rn=$(wg run list) || return 1; tl=$(all_tickets --status in_progress) || tl='{"data":{"items":[]}}'
  printf '%s\n' "$rn" "$tl" | jq -sr "${COLORS[@]}" "$JQLIB"'
    . as [$rn, $tl] |
    "\($B)\("RUN"|pad(22)) \("ACTOR"|pad(14)) \("STATUS"|pad(10)) \("WORKING ON"|pad(18)) CAN DO / OBJECTIVE\($R)",
    ($rn.data.items[] | . as $r | ([$tl.data.items[] | select(.claim.run_id == $r.run_id) | .ticket_id] | join(",")) as $on
      | "\($r.run_id|pad(22)) \($r.actor_id|pad(14)) "
        + (if $r.status == "running" then "\($G)running\($R)   " else "\($D)\($r.status|pad(10))\($R)" end)
        + " \((if $on == "" then "-" else $on end)|pad(18)) "
        + (if ($r.capabilities|length) > 0 then "[\($r.capabilities|join(","))] " else "" end) + ($r.objective|short(40)))
  '
}

cmd_inbox() {
  local who=${1:?usage: wgx inbox ACTOR [CONSUMER_ID]} consumer=${2:-$1}
  local ib; ib=$(wg inbox read --consumer-id "$consumer" --json-field recipient "{\"kind\":\"actor\",\"id\":\"$who\"}" --limit 100 --max-bytes 1048576) || return 1
  echo "${D}unacknowledged for $who (consumer id $consumer):${R}"
  jq -r "${COLORS[@]}" "$JQLIB"'
    (now) as $now
    | .data.items as $u
    | if ($u|length) == 0 then "\($D)nothing unacknowledged\($R)" else
      ($u[] | "\(.notification_id|pad(5)) \(.kind|pad(18)) from \(.attribution.actor_id|pad(12)) \($D)\(.attribution.timestamp|ago($now))\($R)  \(.body_source.body // "" | one)") end
  ' <<<"$ib"
}

cmd_output() {
  local id=${1:?usage: wgx output RESOURCE}
  local cap; cap=$(wg resource read --resource-id "$id" | jq -r .data.text) || return 1
  echo "$cap" | jq -r "${COLORS[@]}" '"\($B)$ \(.command.argv | join(" "))\($R)   \($D)(in \(.command.cwd))\($R)",
    "\($D)outcome: \(.outcome | tojson)\($R)"'
  for s in stdout stderr; do
    local bytes; bytes=$(echo "$cap" | jq -r ".$s.observed_bytes // 0")
    [ "$bytes" = "0" ] && continue
    echo "${B}--- $s ($bytes bytes) ---${R}"
    echo "$cap" | jq -r ".$s.base64" | base64 -d
  done
}

cmd_storage() {
  local mt; mt=$(wg workspace metrics) || return 1
  jq -r "${COLORS[@]}" "$JQLIB"'
    def pct: ((.used|tonumber) * 100 / (.limit|tonumber));
    def gauge($n): (if $n >= 95 then $RED elif $n >= 80 then $Y else $G end) as $c
      | (($n/5)|ceil) as $w | $c + ("#" * $w) + $R + $D + ("." * (20 - $w)) + $R;
    "\($B)\("METER"|pad(28)) \("USED"|pad(14)) \("LIMIT"|pad(14)) BUDGET\($R)",
    ((.data.planning_admission + .data.storage_admission)[] | select(.lifetime == "cumulative")
      | pct as $p | "\(.name|pad(28)) \(.used|pad(14)) \(.limit|pad(14)) \(gauge($p)) \($p*100|round/100)%")
  ' <<<"$mt"
  echo "${D}cumulative: nothing is ever freed. At 80% plan a successor workspace (docs/agent/capacity-rollover.md).${R}"
}

cmd_files() {
  local pr; pr=$(wg reservation path.list --limit 100 --max-bytes 1048576) || return 1
  jq -r "${COLORS[@]}" "$JQLIB"'
    (now) as $now
    | [.data.items[] | select((.holders|length) > 0)] as $held
    | if ($held|length) == 0 then "\($D)no files or folders are reserved\($R)" else
      "\($B)\("WORKTREE:PATH"|pad(36)) \("HOLDER"|pad(24)) \("MODE"|pad(10)) \("TOKEN"|pad(6)) LEASE\($R)",
      ($held[] | . as $r | .holders[] |
        "\("\($r.target.worktree_id):\($r.target.path)\(if $r.target.kind == "subtree" then "/" else "" end)"|pad(36)) \("\(.actor_id) (\(.run_id))"|pad(24)) \(.mode|pad(10)) \(.token|pad(6)) "
        + (if .lease.duration_ms == null then "until released" else "\((.lease.duration_ms|tonumber)/60000|floor) min lease" end)) end
  ' <<<"$pr"
}

cmd_history() {
  local text=${1:?usage: wgx history TEXT}
  local hs; hs=$(wg history search --text "$text" --limit 20 --max-bytes 1048576) || return 1
  jq -r "${COLORS[@]}" "$JQLIB"'
    if (.data.items|length) == 0 then "\($D)no saved conversation mentions that\($R)" else
      (.data.items[] | "\($B)\(.event_ref.session_id)\($R) #\(.event_ref.sequence|pad(5)) \($D)\(.role)/\(.kind|pad(12))\($R) \(.snippet|one)") end,
    (if .data.complete == false then "\($Y)search index still catching up; try again in a moment\($R)" else empty end),
    (if .data.has_more then "\($D)more hits exist; refine the text\($R)" else empty end),
    "\($D)read around a hit: wgx convo SESSION SEQ\($R)"
  ' <<<"$hs"
}

cmd_convo() {
  local session=${1:?usage: wgx convo SESSION [SEQ] [N]} seq=${2:-0} n=${3:-8}
  local page head
  if [ "$seq" = "0" ]; then
    page=$(wg history read --session-id "$session" --direction after --anchor 0 --limit "$n" --max-bytes 1048576) || return 1
  else
    page=$(wg history read --session-id "$session" --direction around --anchor "$seq" --limit "$n" --max-bytes 1048576) || return 1
  fi
  head=$(echo "$page" | jq -r .meta.history_capture.head)
  echo "$page" | jq -c '.data.items[] | {seq: .event_ref.sequence, role: .event.role, kind: .event.kind, actor: .actor_id, has_text: (.event.searchable_text != null)}' |
  while read -r ev; do
    local s; s=$(jq -r .seq <<<"$ev")
    local label; label=$(jq -r '"#\(.seq) \(.actor) \(.role)/\(.kind)"' <<<"$ev")
    if [ "$s" = "$seq" ]; then echo "${Y}${B}> $label${R}"; else echo "${B}$label${R}"; fi
    if [ "$(jq -r .has_text <<<"$ev")" = "true" ]; then
      wg history payload --head "$head" --json-field event_ref "{\"session_id\":\"$session\",\"sequence\":\"$s\"}" \
        --json-field part '{"kind":"searchable_text"}' --length 1200 | jq -r .data.bytes_base64 | base64 -d | sed 's/^/    /' | head -14
    fi
    echo
  done
  echo "${D}more: wgx convo $session $(( seq + n )) $n${R}"
}

case "${1:-status}" in
  status)    [ "$#" -gt 0 ] && shift; cmd_status "$@" ;;
  dash)      shift; cmd_dash "$@" ;;
  watch)     shift; cmd_watch "$@" ;;
  feed)      shift; cmd_feed "$@" ;;
  ticket)    shift; cmd_ticket "$@" ;;
  questions) cmd_questions ;;
  agents)    cmd_agents ;;
  inbox)     shift; cmd_inbox "$@" ;;
  output)    shift; cmd_output "$@" ;;
  storage)   cmd_storage ;;
  files)     cmd_files ;;
  history)   shift; cmd_history "$@" ;;
  convo)     shift; cmd_convo "$@" ;;
  *) echo "wgx: unknown command '$1' (try: wgx help)" >&2; exit 2 ;;
esac
