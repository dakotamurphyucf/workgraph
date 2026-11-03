# Workgraph concepts

Read this when using Workgraph for the first time or when a reference uses an
unfamiliar term. Return to [the skill](../SKILL.md) to choose an operation.

## Work and identity

A **workspace** is a durable local collection of work and shared context. A
**project** groups a delivery goal; a **milestone** groups progress toward a dated
checkpoint within a project. A **ticket** records a unit of work with instructions,
status, acceptance criteria and links. Its internal ID is different from a
human-facing display key such as `WG-1`; `ticket.resolve` converts that key to an ID.

A **prerequisite** is another ticket that must be done before work is ready. A
**dependency** is the declared relationship to that prerequisite. A parent ticket
organizes children; parenthood alone does not make its prerequisites apply to its
children. An explicit hierarchy policy controls that behavior. A **hold** pauses
readiness and completion without changing status. A **waiver** records a reason to
ignore one declared prerequisite's blocking effect, without removing the relationship.

An **actor** is the recorded identity of a person or agent. A **run** records one
invocation of an agent and its declared capabilities. An **attempt** records one
try at a ticket. A run can make several attempts over its lifetime. Registering a
run does not start a process; your runner does that. These cooperative identifiers
attribute work; they are not login credentials or a security boundary.

## Ownership and readiness

A **claim** records who currently owns a ticket. Workgraph returns a **token**, a
number identifying that particular claim, to reject writes from previous owners.
Use the returned token with the same actor and optional run ID. Do not guess it or
use one belonging to someone else. Assigning a ticket for planning is different
from claiming it for execution.

A **lease** adds an expiration time to ownership. Expiration does not stop a
process, delete its claim, or grant another actor permission to clean up its work.
The runner must stop or isolate the previous process before guarded recovery.
A **heartbeat** is a caller's report of activity; it is not proof of process liveness.

**Readiness** is a current assessment of whether work can begin. It checks status,
dependencies, holds and applicable rules. With a target run it also considers that
run's capabilities, capacity and required paths. Reading readiness grants no claim;
the write checks again. **Allocation** selects work subject to those rules. A
**pool** limits shared capacity, such as the number of active jobs using a service.
A **path reservation** coordinates declared file or subtree scopes; it does not
lock files. A **condition** is an explicitly recorded external prerequisite,
updated by a signal from the runner rather than inferred by the daemon.

## Saving, retrying and reading consistently

A **mutation** is a write operation. A **transaction** commits supported planning
writes together, so either their validated changes are saved together or none are.
The daemon saves the committed data durably before acknowledging success. A
**receipt** is the recorded success result used to recover an exact retry.

A **mutation ID** identifies one intended write, together with its workspace and
actor. **Idempotency** means retrying that same identity and identical inputs
returns the original receipt rather than doing the write twice. A saved request
freezes those inputs. If transmission might have succeeded but the reply is lost,
the outcome is **uncertain**: retry the saved request, never replace its identity.
A changed intention is a new operation with a fresh identity.

A **revision** is the version number of a particular record or state stream.
`expected_revision` asks an update to succeed only if its target still has the
version you read. This is a **guard** against overwriting intervening changes.
Each entity, handoff and other independently versioned record has its own revision.
`workspace_revision` counts committed planning transactions; it is not a ticket's
revision. Counters are JSON strings such as `"12"`, not JSON numbers.

A **capture** identifies the state used for a consistent read. Planning pages use
`at_revision` to continue the current captured workspace revision; it does not
retrieve an arbitrary old snapshot. Other families use their own revisions, history
heads or opaque cursors. A **cursor** is a continuation position supplied by the
method. Keep that exact position and its scope; do not substitute another counter.

A **byte budget** limits response size. **Truncated** output has omitted text or
items. Inspect omission metadata and remaining pages before drawing conclusions.
A complete page traversal can still contain shortened text or incomplete indexing.
A **query envelope** is the response wrapper: `result.data` contains the operation's
output, while `result.meta` contains applicable revisions, durability and omission
information. An error occupies `error` instead of `result`.

## Shared context and completion

A **fact** is a small named JSON value in an explicit workspace, project, milestone
or ticket scope. Facts are editable shared context. A **resource** stores longer
text or binary bytes. A resource's metadata revision and immutable content version
are different: exact evidence uses a content version and digest, the hash identifying
those bytes. A **pin** names an exact version instead of following future edits.

A **comment** records discussion or progress. A **handoff** is structured recovery
context: objective, completed work, decisions, blockers, next steps and evidence.
A **request** records an accountable question or task for a designated recipient
or resolver. A **thread** groups discussion messages; an **inbox** delivers
notifications. Reading, acknowledging delivery, accepting responsibility, and
resolving a request are separate actions.

An **instruction amendment** is an attributed change to recorded instructions;
completion can require the current claimant to acknowledge it. A **contract**
records expected inputs or outputs. A **manifest** pins exact evidence sources;
a **validation** records a check. A **submission** identifies the outputs presented
for review. A **gate** is a configured completion requirement: an ordinary comment
saying “approved” does not replace the required review or acceptance record.
**Reconciliation** records how to handle changed inputs instead of silently moving
pins to newer versions.

A **session** groups visible conversation and tool events explicitly imported by
the runner. Planning activity and captured conversation history are separate
streams with different counters. Workgraph does not automatically capture
conversations, infer summaries or store private model reasoning through the bundled
converter.
