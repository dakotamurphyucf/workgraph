# Two actors, two review rounds

The [executable example](../examples/gated-review-workflow.py) performs a complete
review workflow using the public CLI. Supply an executable, running daemon socket,
open workspace and a fresh absolute private state directory. Python 3 is the only
additional dependency. See [workspace setup](agent/workflows.md) if the harness has
not supplied a connection.

```sh
python3 examples/gated-review-workflow.py "$WG" "$SOCKET" "$WORKSPACE" \
  /absolute/private/review-state --prefix review-demo \
  --worker worker --reviewer reviewer
```

Choose a fresh prefix for the first run. The script creates its project, ticket,
distinct worker/reviewer runs, schema resource, contract and output manifest. It
starts the ticket and attempt atomically. Each mutation is saved before sending;
rerunning with the same arguments retries those exact requests and retains the
original read captures. Failed preparation reports remain historical observations.
Use a new state directory and prefix for a new workflow.

The first submission automatically creates a formal review request. The reviewer
requests changes; the worker publishes a corrected output and manifest, then submits
generation 2. The reviewer approves that generation, and the worker receives a durable
notification with its exact manifest and contract references. Approval preserves the
submission revision. The worker accepts the submission using that revision, checks
the evidence gate, then finishes the ticket and active attempt atomically. Output
reports the actual revisions, immutable pins and notification body. The deliberate
first-round completion block appears under `expected_policy_blocks`; an accidental
failure aborts the example.

The policy requires a distinct named reviewer with `separate_actor:true`. Actor IDs
are cooperative attribution, and actor catalogs are metadata. Workgraph does not
authenticate those callers. Claim tokens fence stale writers; they are not credentials.
The harness owns agent processes, artifact verification and external side effects.

The automatic formal review request names the submitter as its resolver. A
`request_changes` verdict creates a `blocker_resolution` request addressed to the
recorded submitter actor and run, with the reviewer as resolver. After verifying the
correction, the reviewer explicitly resolves that changes request. The worker explicitly
resolves the superseded first formal review request. Acceptance resolves the current
formal review request only when the accepting actor is its designated resolver.
Superseded requests and unrelated requests are never silently closed. Inbox
acknowledgement and request delivery/responsibility/resolution remain separate actions.

Every `approve` verdict atomically publishes an ordinary durable message to the
submission's recorded actor and optional run. Its immutable initial body is canonical
JSON validated by `Review_approval.codec`. Read it through `inbox.read` or `inbox.wait`
with `kinds:["message_received"]`; parse `body_source.body`. Frozen routing and exact
references remain historical after later attempts or submissions. Normal exact retries
produce no additional delivery. A collision with an existing message identity rejects
the whole approval transaction.

| Field | Public meaning |
| --- | --- |
| `kind` | Literal `review_approved` |
| `ticket_id` | Reviewed ticket ID |
| `generation` | Positive submission generation, encoded as a decimal string |
| `manifest` | Exact `{manifest_id, revision}` reference |
| `contract` | Exact `{contract_id, revision}` reference |
| `review_id` | Immutable review ID; use `review.list` to retrieve its evidence |
| `review_serial` | Positive workspace-local evidence serial, encoded as a decimal string |
| `submitter`, `reviewer` | Recorded `{actor_id, run_id, timestamp}` attribution; `run_id` may be null |
| `gate_status` | Literal `not_evaluated` |
| `summary` | Literal sentence shown below |

The summary is `One reviewer approved this submission. Other review and validation
requirements may remain.` The body excludes potentially large review evidence.
One approval can leave other reviewers or validators outstanding. Read `review.gate`
and accept the current submission explicitly; ticket completion also checks ownership,
holds, dependencies and children. Approval alone does not authorize changed outputs or
a replacement attempt.

The dedicated `test/gated_review` suite runs this example, repeats its exact mutations
and restarts the daemon. It also checks multiple reviewers, immutable captures,
replacement attempts, malformed public bodies, identity collisions and replay rejection
when the approval's paired message is missing, changed or rerouted.
