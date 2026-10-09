#!/bin/sh
# Run against a daemon you own. Re-running uses the same durable mutation IDs.
# Usage: sh agent-workflow.sh /absolute/workgraph /absolute/socket \
#          /absolute/new-workspace /absolute/local-notes /absolute/resource-file
set -eu
if [ "$#" -ne 5 ]; then
  printf '%s\n' 'Usage: agent-workflow.sh EXE SOCKET WORKSPACE_ROOT LOCAL_NOTES RESOURCE_FILE' >&2
  exit 2
fi
wg=$1
socket=$2
workspace_root=$3
local_notes=$4
resource_file=$5
mkdir -p "$local_notes"
"$wg" workspace create "$socket" --workspace-id workflow-demo --actor-id operator \
  --mutation-id workflow-create --name 'Agent workflow' --root "$workspace_root"
"$wg" project create "$socket" --workspace-id workflow-demo --actor-id agent \
  --mutation-id project-create --project-id mvp --title 'Build the MVP'
"$wg" ticket create "$socket" --workspace-id workflow-demo --actor-id agent \
  --mutation-id research-create --ticket-id research --project-id mvp --title 'Research the design'
"$wg" ticket create "$socket" --workspace-id workflow-demo --actor-id agent \
  --mutation-id implementation-create --ticket-id implementation --project-id mvp --title 'Implement the design'
"$wg" dependency add "$socket" --workspace-id workflow-demo --actor-id agent \
  --mutation-id dependency-create --ticket-id implementation --prerequisite-id research
"$wg" comment add "$socket" --workspace-id workflow-demo --actor-id agent \
  --mutation-id decision --json-field target '{"kind":"ticket","id":"research"}' --kind decision --body 'Save progress and evidence with the work.'
if [ -f "$local_notes/resource-upload.json" ]; then
  "$wg" retry "$socket" "$local_notes/resource-upload.json"
else
  "$wg" resource upload "$socket" --workspace-id workflow-demo --actor-id agent \
    --resource-id notes --expected-revision 0 --title 'Research notes' \
    --file "$resource_file" --save-request "$local_notes/resource-upload.json"
fi
"$wg" resource link "$socket" --workspace-id workflow-demo --actor-id agent \
  --mutation-id attach-notes --resource-id notes --expected-revision 1 \
  --json-field target '{"kind":"ticket","id":"research"}'
"$wg" handoff set "$socket" --workspace-id workflow-demo --actor-id agent \
  --mutation-id handoff --ticket-id research --expected-revision 0 \
  --summary 'Initial research captured' --next-steps 'Review the attachment and claim the ready ticket' \
  --evidence 'Versioned research notes attached' --json-field resource-ids '["notes"]'
"$wg" ticket ready "$socket" --workspace-id workflow-demo
"$wg" ticket context "$socket" --workspace-id workflow-demo --ticket-id research
# Restart the daemon, then rerun this script: receipts preserve the original writes.
