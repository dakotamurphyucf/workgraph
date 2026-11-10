# Recover an interrupted change

These rules describe saved operations in the 0.8.3 UI. The
operation's displayed state, original writer and destination determine the next
action. For CLI journals, use
[saved-request recovery](../../skills/workgraph/references/cli-contract.md).

A lost reply does not tell you whether a change happened. Keep the saved operation
and its original connection, actor, run, request identity and guards. Inspect that
operation independently of the current browser selection. Do not create a fresh
copy of the intended change merely because the browser timed out or reloaded.

| Observation | What it establishes | Next step |
| --- | --- | --- |
| Prepared, unsent | Durable state positively establishes that no exchange was admitted. | Review and explicitly execute the saved operation. |
| Sending | Transmission was admitted; the current task may still be running. | Observe the existing operation. Do not start a second send. |
| Committed | The exact method result and durable publication acknowledgement validated. | Read the receipt and refresh affected views. |
| Observed | A validated ephemeral result, or a specifically supported nondurable observation. | Treat it as an observation, not a durable receipt. |
| Rejected | A definite daemon rejection was received. | Read current state and deliberately prepare a new draft if needed. |
| Outcome unknown | Commit or rejection cannot be established. | Keep dependent changes paused; use supported exact recovery or explicit identical retry. |

A restart turns an interrupted Sending observation into uncertainty, not proof of
failure. A local status-file persistence problem after an observed daemon commit
also does not make that commit a rejection. Preserve both the receipt and the
local diagnostic.

Receipt lookup is available for the daemon's registry and planning durable
namespaces. It must match the original saved request hash and validate the nested
original-method acknowledgement. A missing or pending receipt is not proof that
nothing was sent. The current public daemon API has no independent history receipt
lookup: the UI must say recovery is unsupported for that operation and retain
explicit identical retry rather than querying the wrong journal. Ephemeral writes
have no durable receipt to recover.

An exact retry reuses the saved request bytes and identity. It does not refresh
guards, switch actors, pick a new endpoint generation or generate another mutation
ID. Re-preparing changed inputs is a new intention and is appropriate only after
the previous outcome is safely resolved or otherwise accounted for. Never edit a
request journal to make it look like a different operation.

Package qualification precedes new daemon work and explicit retries. If the
observed daemon package differs from the companion, restore a matching pair
before retrying. The failure sends no acquisition/mutation request and does not
change an earlier unknown operation into rejected or definitely unsent. Its
original bytes, writer and endpoint generation remain visible; local inspection
and profile editing continue to work. Changing the current selection never
retargets a saved retry. A successful version check is cooperative compatibility,
not proof that the socket still belongs to the original daemon process.

If an endpoint changed, keep the original profile snapshot and journals. A socket
at the same path is not proof of the same daemon. Deliberate reattachment should
retain old recovery records rather than redirecting them silently. Other unrelated
reads and connections may remain useful while one write is uncertain.

For daemon startup conflicts, inspect the configured registry/socket/log and the
actual owning process. Do not unlink sockets or locks, infer death from lease age,
or create a competing writer for a data root. A shutdown response establishes a
request to drain; an unreachable attached endpoint does not establish process
exit. Follow the current [administration guide](../../skills/workgraph/references/administration.md)
for CLI lifecycle operations.
