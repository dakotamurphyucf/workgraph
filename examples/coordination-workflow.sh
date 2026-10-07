#!/bin/sh
# Demonstrate local run attribution, claim-next, progress and reviewer comments.
# Requires an already-open workspace with one eligible ready leaf ticket.
# Usage: sh coordination-workflow.sh EXE SOCKET WORKSPACE PROJECT ACTOR REVIEWER STATE_DIR
set -eu

if [ "$#" -ne 7 ]; then
  printf '%s\n' 'Usage: coordination-workflow.sh EXE SOCKET WORKSPACE PROJECT ACTOR REVIEWER STATE_DIR' >&2
  exit 2
fi

wg=$1
socket=$2
workspace=$3
project=$4
actor=$5
reviewer=$6
state_dir=$7
mkdir -p "$state_dir"
command -v jq >/dev/null 2>&1 || {
  printf '%s\n' 'This example requires jq.' >&2
  exit 2
}

worker_run=workflow-worker
reviewer_run=workflow-reviewer
attempt_id=workflow-attempt

mutate() {
  name=$1
  method=$2
  params=$3
  params_file=$state_dir/$name.params.json
  request_file=$state_dir/$name.request.json

  if [ -f "$params_file" ]; then
    current=$(jq -cS . "$params_file")
    wanted=$(printf '%s' "$params" | jq -cS .)
    if [ "$current" != "$wanted" ]; then
      printf 'Parameters changed for saved step %s; use a fresh state directory.\n' "$name" >&2
      return 2
    fi
  else
    printf '%s\n' "$params" > "$params_file"
  fi

  if [ -f "$request_file" ]; then
    saved=$(jq -cS '.params' "$request_file")
    current=$(jq -cS . "$params_file")
    if [ "$saved" != "$current" ]; then
      printf 'Saved request differs for step %s; use a fresh state directory.\n' "$name" >&2
      return 2
    fi
    "$wg" retry "$socket" "$request_file"
  else
    "$wg" request "$socket" "$method" --params-file "$params_file" --save-request "$request_file"
  fi
}

worker_params=$(jq -cn --arg ws "$workspace" --arg actor "$actor" \
  --arg mutation 'workflow-register-worker' --arg id "$worker_run" \
  --arg project "$project" \
  '{workspace_id:$ws,actor_id:$actor,mutation_id:$mutation,
    id:$id,objective:"Implement and report one ready ticket",capabilities:[]}' )
mutate register-worker run.register "$worker_params" >/dev/null

reviewer_params=$(jq -cn --arg ws "$workspace" --arg actor "$reviewer" \
  --arg mutation 'workflow-register-reviewer' --arg id "$reviewer_run" \
  '{workspace_id:$ws,actor_id:$actor,mutation_id:$mutation,
    id:$id,objective:"Review the worker report",capabilities:[]}' )
mutate register-reviewer run.register "$reviewer_params" >/dev/null

claim_params=$(jq -cn --arg ws "$workspace" --arg actor "$actor" \
  --arg run "$worker_run" --arg mutation 'workflow-claim-next' \
  --arg attempt "$attempt_id" --arg project "$project" \
  '{workspace_id:$ws,actor_id:$actor,run_id:$run,mutation_id:$mutation,
    attempt_id:$attempt,run:$run,project_id:$project}')
claim_response=$(mutate claim-next ticket.claim_next "$claim_params")
printf '%s\n' "$claim_response" > "$state_dir/claim-next.response.json"
claim=$(printf '%s' "$claim_response" | jq -ce '.result.result')
if [ "$(printf '%s' "$claim" | jq -r '.kind')" = empty ]; then
  printf '%s\n' 'No eligible ticket was available.'
  exit 0
fi
ticket=$(printf '%s' "$claim" | jq -r '.claim.ticket_id')
token=$(printf '%s' "$claim" | jq -r '.claim.token')

worker_comment=$(jq -cn --arg ws "$workspace" --arg actor "$actor" \
  --arg run "$worker_run" --arg mutation 'workflow-worker-comment' \
  --arg ticket "$ticket" \
  '{workspace_id:$ws,actor_id:$actor,run_id:$run,mutation_id:$mutation,
    ticket_id:$ticket,kind:"progress",body:"Claimed this ticket; starting the work."}')
mutate worker-comment comment.add "$worker_comment" >/dev/null

progress=$(jq -cn --arg ws "$workspace" --arg actor "$actor" \
  --arg run "$worker_run" --arg mutation 'workflow-progress' \
  --arg ticket "$ticket" --arg token "$token" \
  '{workspace_id:$ws,actor_id:$actor,run_id:$run,mutation_id:$mutation,
    ticket_id:$ticket,token:$token,kind:"progress",body:"Work is ready for review."}')
mutate progress ticket.progress "$progress" >/dev/null

# Heartbeats are observations. Supplying a mutation ID satisfies the CLI envelope;
# the daemon does not deduplicate this observation and it never renews a lease.
heartbeat=$(jq -cn --arg ws "$workspace" --arg actor "$actor" \
  --arg run "$worker_run" --arg mutation 'workflow-heartbeat-1' \
  '{workspace_id:$ws,actor_id:$actor,run_id:$run,mutation_id:$mutation}')
printf '%s\n' "$heartbeat" > "$state_dir/heartbeat.params.json"
"$wg" request "$socket" run.heartbeat --params-file "$state_dir/heartbeat.params.json" >/dev/null

review_comment=$(jq -cn --arg ws "$workspace" --arg actor "$reviewer" \
  --arg run "$reviewer_run" --arg mutation 'workflow-review-comment' \
  --arg ticket "$ticket" \
  '{workspace_id:$ws,actor_id:$actor,run_id:$run,mutation_id:$mutation,
    ticket_id:$ticket,kind:"evidence",body:"Reviewed the reported work; follow the configured evidence gate before completion."}')
mutate reviewer-comment comment.add "$review_comment" >/dev/null

printf 'Worker run %s and reviewer run %s recorded comments on ticket %s.\n' \
  "$worker_run" "$reviewer_run" "$ticket"
printf 'The claim token is retained in %s/claim-next.response.json; inspect ticket.context before completing work.\n' \
  "$state_dir"
