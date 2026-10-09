# Optional harness integrations

```xml
<workgraph_reference topic="harness-hooks">
<purpose><![CDATA[
Use these external Python 3.10+ standard-library examples on macOS or Linux. They
use the ordinary Workgraph socket API. They are optional: an agent can perform the
same reads and writes through the CLI. Workgraph itself launches no callbacks or
models and does not manage the agent's prompt, process or context window.
]]></purpose>

<notification_callback><![CDATA[

Run the bundled watcher as a separate harness process. Supply your connection
values, a stable consumer name, a private checkpoint path and an explicit callback:

```sh
python3 /absolute/workgraph/examples/notification-watcher.py \
  --socket "$SOCKET" --workspace-id "$WORKSPACE" --actor-id "$ACTOR" \
  --consumer-id agent-watcher --recipient-id "$ACTOR" \
  --state /absolute/agent/watcher.json \
  --callback-cwd /absolute/agent \
  -- python3 /absolute/agent/handle-notification.py
```

For a run recipient, also supply `--run-id "$RUN" --recipient-kind run
--recipient-id "$RUN"`. The actor must own that run. Optional `--ticket-id` and
repeatable `--kind` filter deliveries. `--once` exits after one delivery or a wait
timeout; the default repeats bounded waits. `--timeout-ms` accepts 1–25000,
`--max-bytes` accepts 4096–1048576 (default 65536).

The callback receives one JSON object on stdin:

```json
{
  "workspace_id": "demo",
  "consumer_id": "agent-watcher",
  "recipient": {"kind": "actor", "id": "agent"},
  "delivery_id": "stable-sha256",
  "notification": {"notification_id": "12", "...": "actual notification fields"},
  "read_meta": {"...": "actual read metadata, including budget information"}
}
```

Treat this example as a shape, not a literal API request. Inspect `read_meta` for
clipping and follow the notification's source references when more content is
needed. Return exit status zero only after durably recording the delivery and any
intended work. Use `delivery_id` as a persistent deduplication key. It identifies a
notification for this workspace/consumer/recipient; it is not an authorization token.
Message text is stdin data. It never becomes a shell command. Callback stdout and
stderr go to the watcher's stderr; watcher stdout contains progress JSON.

Delivery is **at least once**. The watcher saves the packet before invoking the
callback, records callback success before acknowledging, and saves the exact
`inbox.ack` request. If the reply is lost, restart with the same arguments and
checkpoint: the watcher retries that request without rerunning a recorded-complete
callback. A crash after callback effects but before the success checkpoint can
invoke the callback again with the same delivery ID. The callback must handle that
window itself. A nonzero exit or socket failure leaves pending work and exits the
watcher; your process supervisor decides when to restart it.

One process holds the checkpoint lock. Its identity includes socket, actor/run,
recipient, consumer, filters, callback arguments and working directory. Changing
them requires a deliberate new checkpoint; changing the consumer starts an
independent acknowledgement stream. The watcher queries unacknowledged events
from the server, rather than using its display-only last-delivery ID as a filter.
Acknowledgement does not resolve an accountable request or complete a ticket.

]]></notification_callback>

<codex_command_hooks><![CDATA[

`examples/codex-hooks/` contains a binding template, a hooks definition template
and `workgraph-hook.py`. Replace absolute paths and IDs in copies before use.
Give each agent its own binding, handoff request and receipt files. You may add
`run_id` and an absolute `agent_guide` path. Default resume budget is 8192 bytes;
the example permits 4096–16384. Keep the files private and out of source control.

The adapter implements three command-hook events:

| Event | Workgraph action |
| --- | --- |
| `SessionStart` | Read `ticket.resume` and return its complete bounded result as additional context. |
| `PreCompact` | Submit an already-authored `handoff.set` request, if present. |
| `Stop` | Submit/retry the same explicit handoff request, if present. |

Codex command hooks receive JSON on stdin. Its documented startup output uses
`hookSpecificOutput.additionalContext`; compaction and stop accept common JSON
output. Review and trust your edited hook definition through Codex's hook controls.
The adapter does not activate hooks or modify Codex settings. Transcript formats
are not a stable interface, so this adapter never reads them.
[Official Codex hook documentation](https://learn.chatgpt.com/docs/hooks).

Before a reset, the agent or harness writes an explicit request file:

```json
{
  "method": "handoff.set",
  "params": {
    "workspace_id": "demo",
    "actor_id": "agent",
    "mutation_id": "unique-saved-handoff-identity",
    "ticket_id": "task",
    "expected_revision": "0",
    "covers_through": "12",
    "summary": "Observed decisions and completed work",
    "next_steps": "Concrete remaining actions",
    "evidence": "Exact checks and results"
  }
}
```

Replace both counters with observed values: `expected_revision` guards the previous
handoff (zero when absent); `covers_through` is the planning revision actually
reviewed. Include the bound `run_id` when supplied. See
[planning](planning.md) for the remaining optional handoff fields. Use a new
mutation ID for a new handoff; keep an uncertain request unchanged. Publish the
request file atomically after fully writing it, so a hook never reads a partial file.

The hook checks the request's workspace, actor, ticket and run against the binding.
It saves a synced receipt only after a durable acknowledgement and retains the
original request for exact retries. An absent request produces an informational
message; no handoff is invented from status, a todo title or a transcript. Errors
exit nonzero, without claiming persistence or requesting a continuation. Your
harness decides whether failure should prevent compaction or stopping. A retained
older request only retries that older handoff; it does not summarize newer work.

On startup the returned context includes source references and omission metadata.
The adapter labels workspace content as recorded data, not new authority. Supply
the agent guide as well; let the agent retrieve missing detail. The harness retains
control of truncation, context assembly and any further model calls.

Qualification scope is recorded in [harness integration acceptance](../acceptance/harness-hooks.md).
]]></codex_command_hooks>
</workgraph_reference>
```
