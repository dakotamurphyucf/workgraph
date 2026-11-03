#!/usr/bin/env bash
# One CI job per invocation; bounded idle waits, explicit lifecycle and exact journals.
# Usage: CTX=ABS_CONTEXT RUN=FRESH_RUN PROJECT=P SRC=ABS_CHECKOUT STAGES=ABS_PARENT
#        WG=ABS_MATCHING_EXECUTABLE bash ci-worker.sh COMMAND ARG...
# The context must configure an existing private request_directory. No stderr hiding.
set -euo pipefail
set -o noclobber
WG=${WG:-workgraph}
: "${CTX:?set CTX}" "${RUN:?set a fresh RUN}" "${PROJECT:?set PROJECT}"
: "${SRC:?set absolute SRC}" "${STAGES:?set existing absolute STAGES}"
ORCH=${ORCH:-agent-orch}
[ "$#" -gt 0 ] || { echo 'ci-worker: supply the literal test argv' >&2; exit 1; }
case "$SRC:$STAGES" in /*:/*) ;; *) echo 'ci-worker: absolute paths required' >&2; exit 1 ;; esac
[ -d "$STAGES" ] || { echo 'ci-worker: stage parent must exist' >&2; exit 1; }
jq -e '.request_directory | type == "string" and startswith("/")' "$CTX" >/dev/null
wg() { "$WG" --context "$CTX" "$@"; }
trap 'echo "ci-worker interrupted; retain own claim/stage/journals; inspect before retry" >&2; exit 130' INT TERM

wg run register --run-id "$RUN" --target-run-id "$RUN" \
  --json-field capabilities '["ci"]' --objective "CI for $PROJECT" >/dev/null
finish_run() {
  local status=$1 evidence=$2 record revision
  record=$(wg run get --target-run-id "$RUN")
  revision=$(jq -er '.result.data.revision' <<<"$record")
  wg run transition --run-id "$RUN" --target-run-id "$RUN" \
    --expected-revision "$revision" --status "$status" --evidence "$evidence" >/dev/null
}

n=0
while [ "$n" -lt 24 ]; do
  n=$((n + 1))
  # Capture before readiness to avoid losing a release between read and park.
  overview=$(wg workspace overview)
  revision=$(jq -er '.result.meta.workspace_revision' <<<"$overview")
  feed=$(wg changes read --source planning --after "$revision")
  jq -e '.result.data.needs_larger_budget == false' <<<"$feed" >/dev/null
  cursor=$(jq -er '.result.data.cursor' <<<"$feed")
  ready=$(wg ticket ready --project-id "$PROJECT" --target-run-id "$RUN" \
    --label-id ci --leaf-only true --limit 1 --max-bytes 1048576)
  jq -e '(.result.meta.budget.truncated // false) == false' <<<"$ready" >/dev/null
  ticket=$(jq -er '.result.data.items[0].ticket_id // ""' <<<"$ready")
  if [ -z "$ticket" ]; then
    # The feed is a wake hint; readiness is always re-read. Never poll claim_next.
    wg changes wait --source planning --cursor "$cursor" --timeout-ms 2500 >/dev/null
    continue
  fi
  # A competing start is a reason to stop and inspect, not to parse a null token
  # or repeat a possibly committed acquisition with a fresh identity.
  started=$(wg ticket start --run-id "$RUN" --ticket-id "$ticket" --attempt-id "$RUN-$n")
  token=$(jq -er '.result.data.token' <<<"$started")
  stage="$STAGES/$RUN-$ticket-$n"
  resource="$RUN-$ticket-$n"
  test_status=0
  "$WG" evidence-run --stage "$stage" --cwd "$SRC" --source-root "$SRC" \
    --output-limit 1048576 -- "$@" >"$STAGES/$RUN-$n.capture-summary.json" || test_status=$?
  if [ "$test_status" -ne 0 ] && [ "$test_status" -ne 2 ]; then
    echo "ci-worker: capture infrastructure failure; preserve $stage and own claim $ticket/$token" >&2
    exit 1
  fi
  # Publication + linking are independent commits. A nonzero result can mean
  # publication committed but link failed; stop and retry stage/publication.json.
  published=$(wg evidence-publish --run-id "$RUN" --stage "$stage" \
    --resource-id "$resource" --expected-revision 0 --title "CI for $ticket" --ticket-id "$ticket")
  digest=$(jq -er '.result.data.version.digest' <<<"$published")
  version=$(jq -er '.result.data.version.revision' <<<"$published")
  outcome=$(jq -ce ' .outcome ' "$STAGES/$RUN-$n.capture-summary.json")
  evidence="Capture helper exit=$test_status; command outcome=$outcome; resource=$resource version=$version sha256=$digest; publication/link receipts checked."
  if [ "$test_status" -eq 0 ]; then
    wg ticket finish --run-id "$RUN" --ticket-id "$ticket" --token "$token" --evidence "$evidence" >/dev/null
    finish_run completed "$evidence"
    echo "$ticket: passed; $resource@$version"
    exit 0
  fi
  wg ticket progress --run-id "$RUN" --ticket-id "$ticket" --token "$token" \
    --kind evidence --body "$evidence" >/dev/null
  wg ticket release --run-id "$RUN" --ticket-id "$ticket" --token "$token" >/dev/null
  recipients=$(jq -nc --arg actor "$ORCH" '[{kind:"actor",id:$actor}]')
  wg message send --run-id "$RUN" --message-id "$RUN-$n-failed" \
    --json-field recipients "$recipients" --body "$ticket failed. $evidence Add a fix prerequisite before another CI run." >/dev/null
  finish_run failed "$evidence"
  exit 2
done
finish_run completed 'No eligible CI ticket during 24 bounded wake/read cycles; no work claimed.'
echo 'ci-worker: idle limit reached; harness decides whether/when to launch a fresh run' >&2
exit 3
