# Capacity and selected-work rollover

A workspace retains planning history, conversation history and resource versions. An
**admission meter** tracks a limit checked before new work is committed. **Rollover**
means creating a fresh **successor** workspace from selected context in the old
**predecessor**. It is a deliberate transfer of working context, not a history
compaction or transfer of completion approval.

Read [workspace metrics](metrics.md) to interpret each meter and [resource
transfer](resources.md) to distinguish temporary upload staging from retained
publication. A **fact** is a versioned value under an exact scope and key; a **handoff**
is saved ticket context with a recorded activity coverage boundary. See
[concepts](concepts.md) for the ownership and acceptance records omitted below.

## Inspect capacity before choosing recovery

Use `daemon.health` for a compact advisory view of loaded workspaces and
`workspace.metrics` for the complete admission meters. Every meter reports its actual
guard's units, used/limit/remaining, percentage, lifetime and severity: normal below
50%, notice from 50%, warning from 80%, and critical from 95%. Percentages round down.
Warnings do not reserve space or guarantee that a future write will fit; serialized
admission remains authoritative.

Health shows the three highest utilization ratios, a count of meters at or above 50%,
and the number omitted. It uses last committed planning counters and cached
storage/upload counters, without scanning workspace files on each read. Closed or
unavailable workspaces have `capacity: null`. Use explicit reads, metrics and verified
exports when you need current source or storage integrity checks.

## Temporary upload occupancy

`active_uploads` and `reserved_upload_bytes` are temporary. An upload reserves its whole
declared size, including bytes not received yet. Complete a known upload or use
`upload.abort` with its owning actor and upload ID; this frees staging occupancy. A
daemon restart discards interrupted staging, so begin again and resend the exact bytes.
Successfully published resources remain retained after staging is freed. Do not delete
managed files to free a meter.

A refusal keeps its original error kind and supplies `details.type: "capacity"`,
`meter`, `used`, `limit`, `attempted`, `unit`, and an `operator_action` reference.
`attempted` is the proposed **total** utilization, not an increment. Check that binding
meter before choosing recovery; aborting uploads does not reclaim retained
planning/history/resource/fact capacity.

## Roll over before saturation

Planning commits/transaction bytes/payload bytes, history commits/batch bytes, entities,
referenced resource bytes and fact keys/version bytes are cumulative under the current
retention rules. Archived entities and deleted fact tombstones still count. Archiving is
not reclamation, and restoring the same export preserves its history and utilization.
There is no supported in-place history deletion or automatic summarization. Plan a fresh
successor while there is room to export and record the transition. Read and export
operations remain available when an admission meter refuses new retained writes.

The executable [capacity-rollover.py](../scripts/capacity-rollover.py) recipe uses the
current CLI/API. The harness/operator must first stop or isolate predecessor writers,
including processes using other daemons; Workgraph does not stop them. The required
`--writers-quiesced` flag records that explicit operator assertion. Choose fresh
successor, export and private state paths. Keep the predecessor and its verified export
available for historical retrieval.

Create an explicit UTF-8 JSON selection file. All IDs in it belong to the predecessor;
replace these examples with real IDs. A handoff selection names its ticket. The `scope`
identifies where a fact lives; no parent-scope inheritance is inferred.

```json
{
  "tickets": [
    "parent",
    "child"
  ],
  "resources": [
    "notes"
  ],
  "handoffs": [
    "child"
  ],
  "facts": [
    {
      "scope": {
        "kind": "workspace"
      },
      "key": "decision"
    },
    {
      "scope": {
        "kind": "ticket",
        "id": "child"
      },
      "key": "next"
    }
  ]
}
```

After [setting up the daemon and predecessor workspace](getting-started.md), set these
paths. `SKILL` is this installed skill folder. The successor root, export and state
directories must be fresh, with existing private parents and no overlap with managed
workspace roots. `SELECTION` is the file above. Stop or isolate all predecessor writers
before invoking this command; the flag is your assertion that this has happened, not an
instruction to stop them.

```sh
SKILL=/absolute/path/to/workgraph-skill
WG=/absolute/path/to/workgraph
SOCKET=/absolute/private/workgraph.sock
SUCCESSOR_ROOT=/absolute/private/next-work
EXPORT_DIRECTORY=/absolute/private/old-work-export
STATE_DIRECTORY=/absolute/private/rollover-state
SELECTION=/absolute/private/selection.json

python3 "$SKILL/scripts/capacity-rollover.py" \
  --binary "$WG" --socket "$SOCKET" \
  --actor operator --predecessor old-work --successor next-work \
  --successor-root "$SUCCESSOR_ROOT" \
  --export-directory "$EXPORT_DIRECTORY" \
  --state-directory "$STATE_DIRECTORY" \
  --selection "$SELECTION" --writers-quiesced
```

The recipe exports and verifies the predecessor, validates the selected sources, checks
the captured revision if it is open, and closes it. A close fences new writes through
this daemon and preserves registry history. It creates a fresh workspace and records
fresh IDs and explicit predecessor references in a successor JSON resource and private
`mapping.json`. Existing saved requests replay exact writes when the same command is
rerun; changing the saved intent is rejected. Keep the private state directory for
recovery. An already existing successor is rejected unless this intent owns its saved
creation request. Reopening the predecessor requires quiescing and closing it again
before resuming this intent.

## What the successor receives

| Copied context | Treatment |
| --- | --- |
| Selected open, unarchived tickets | Fresh IDs; title, description, priority and acceptance text; every ticket held pending operator review. |
| Projects and milestones | Explicit selections plus selected tickets' membership; fresh IDs, project instructions/priority/acceptance text, milestone descriptions and target dates. |
| Parent, prerequisite and related edges | Rewrite edges between selected entities; record omitted external edges for the operator. |
| Selected unarchived resources | Copy latest exact bytes, metadata and selected target links; record predecessor version/digest and omitted targets. |
| Explicit scope/key facts | Copy latest live value into a rewritten selected scope; record original revision. Embedded JSON IDs stay literal historical references. |
| Selected current handoffs | Copy retained context and selected resource links; retain exact evidence and label it historical in the mapping with source revision/coverage. Fresh successor coverage does not certify completion. |

Claims, leases, runs, attempts, reservations, reviewer decisions, submissions, satisfied
gates, acceptance policies, waivers, recovery records and receipts are omitted.
Assignees, custom status IDs and labels are omitted. Prior resource/fact versions,
conversations, sessions, old handoff audit and unselected work remain in the
predecessor/export. The mapping declares these omissions explicitly. Free text and fact
values are not rewritten by guessing which strings are IDs.

## Review before enabling successor work

A **hold** prevents a ticket from being selected for normal work. The recipe places
copied tickets on hold so the operator can resolve the explicit omissions first. Before
releasing a successor hold, resolve recorded omitted dependencies and resource
references, configure fresh policies, and select fresh ownership. A copied handoff or an
approved predecessor submission supplies historical context only. The successor inherits
no approval or satisfied gate. Use normal current workflow commands to establish its own
evidence, review and completion.

## Retrieve predecessor history

For historical retrieval, use exact source IDs/versions in the retained predecessor or
verified export. `workspace.open` can reopen a closed predecessor for normal reads; keep
its writers isolated if it is being retained only as history. Do not restore its export
over the successor expecting fresh capacity or authority.
