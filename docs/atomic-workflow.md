# Validate and apply an atomic plan

Use `transaction.preflight` to check a plan against one current workspace snapshot.
It runs the same domain preparation as `transaction.apply`, including aliases,
ownership, revisions, dependencies and completion policy. It writes no workspace
events, resources, receipts or request journals.

A successful preview is **not a reservation or commit guarantee**. Other clients
can change the state before application. Disk health and storage commit admission
are checked by the actual write. Generated IDs are provisional and unreserved.
`staged_blob_bytes` counts prepared content, not additional disk space.

The following plan publishes notes, stores a navigation fact and finishes a ticket
in one transaction. Replace `task`, token `1`, resource ID and expected revisions
with the exact values from your current workspace. The current actor must own the
claim; configured review/acceptance gates must already be satisfied. A fact saying
`checked` is not acceptance evidence.

```sh
export WG_CONTEXT=/absolute/path/agent.json
export WG_ACTOR=worker
export WG_RUN=worker-run

cat > plan.json <<'JSON'
{
  "operations": [
    {
      "method": "resource.put_text",
      "params": {
        "resource_id": "task-result",
        "expected_revision": "0",
        "title": "Task result",
        "text": "Implementation and validation notes.\n"
      }
    },
    {
      "method": "fact.put",
      "params": {
        "scope": {"kind": "ticket", "id": "task"},
        "key": "result",
        "expected_revision": "0",
        "value": {"summary": "Implementation complete"},
        "references": [{"kind": "resource", "id": "task-result"}]
      }
    },
    {
      "method": "ticket.finish",
      "params": {
        "ticket_id": "task",
        "token": "1",
        "evidence": "Focused tests passed; exact output is retained in the linked notes."
      }
    }
  ]
}
JSON

# Simulation attribution is explicit: ordinary read defaults do not select an actor/run.
if workgraph --context "$WG_CONTEXT" transaction preflight \
    --actor-id "$WG_ACTOR" --run-id "$WG_RUN" \
    --params-file plan.json > preview.json; then
  jq '.result.data' preview.json
else
  cat preview.json
  exit 1
fi

# Every check runs again. The CLI saves the exact write before sending it.
if workgraph --context "$WG_CONTEXT" transaction apply \
    --actor-id "$WG_ACTOR" --run-id "$WG_RUN" \
    --params-file plan.json > applied.json; then
  jq '.result | {receipt: .meta, operations: .data.results}' applied.json
else
  cat applied.json
  exit 1
fi
```

`transaction.preflight --at-revision REV` refuses a different planning snapshot.
That guard applies to the preview only. Entity revisions, claim tokens and other
guards inside the plan still protect the eventual write. Do not replace a failed
guard with the latest value without reassessing the plan.

If a write's outcome is uncertain, use `workgraph retry /absolute/saved/request.json`
with its unchanged bytes and identity. Inspect exit status before reading JSON;
diagnostics and saved request paths are on stderr. A preview has no mutation ID and
must never be treated as a durable receipt.

Plans contain 1–128 operations within the normal request byte limit. Template
expansion shares this budget: each created ticket, dependency, policy and final
instance registration counts. A template with no dependencies or policies can
therefore create up to 127 tickets. Byte, event and retained-state admission
limits still apply. Nested
transactions, daemon administration and upload staging are not atomic plan
operations. Large resource uploads must be prepared separately; link their exact
published versions in the plan. No helper silently splits a plan into transactions.
