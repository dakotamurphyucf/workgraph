# Capturing and publishing command evidence

```xml
<workgraph_reference topic="execution">
<purpose><![CDATA[
Run a command on the client, retain its exact bounded output and outcome, then publish
the saved capture as a resource. The daemon never executes commands. These are local
CLI commands, not JSON-RPC methods. A nonzero test result is still publishable evidence;
neither successful execution nor publication automatically approves a ticket.
]]></purpose>
<run><![CDATA[
workgraph evidence-run --stage /absolute/new-stage --cwd /absolute/worktree \
  --source-root /absolute/git-root --output-limit 65536 -- COMMAND ARG...

--stage must be fresh and its parent must exist. --cwd is required. --source-root is
optional; omitted provenance is explicitly not_requested. Each stream retains its
first --output-limit bytes (default65536, range1..1048576), while draining and hashing
all observed output. The child inherits the environment and receives EOF on stdin.
Everything after -- is literal argv, including flags named --context or --socket.
Use an explicit shell command only when you intend shell execution.

The CLI prints a small JSON summary: stage, capture_file, outcome, stdout/stderr byte
counts/EOF/truncation, source_drift (true/false/null), and publication:not_attempted.
Exit0 means observed command exit0; exit2 means a captured nonzero exit, signal or
launch failure; exit1 indicates an infrastructure/argument error. Signal numbers in
capture.json use OCaml Sys conventions, which can differ from native POSIX numbers.

command.json is synced before launch. capture.json retains canonical JSON containing
argv, cwd, wall-clock boundaries, independent monotonic duration, outcome, binary
base64 output, observed SHA256/counts, and source observations. Cancellation stages
an interrupted result then propagates; a hard kill may leave an unfinished intent.
An unfinished stage cannot publish and is never automatically rerun. Inspect it and
decide externally whether another execution in a new stage is appropriate. Reusing
the same stage for evidence-run always rejects. Child descendants remain the caller's
process-isolation responsibility.
]]></run>
<source_scope><![CDATA[
The explicit Git root must be the worktree root. Before/after observations identify
HEAD plus tracked and nonignored untracked working files, their content and modes,
deleted tracked paths, and symlink targets. Symlink ancestors are not followed.
Git metadata, ignored files and submodule contents are outside the declared scope.
Limits:10000 paths,8MiB per file,64MiB total content,4MiB Git enumeration,10seconds per
observation. Omissions and unavailable provenance are explicit. Partial/missing
observations yield source_drift:null, never false. These are bounded observations,
not atomic filesystem snapshots: unchanged hashes cannot rule out intervening edits,
external inputs or a command reading different files. No semantic test relevance is
inferred from output or exit status.
]]></source_scope>
<publish><![CDATA[
workgraph evidence-publish /absolute/socket --stage /absolute/new-stage \
  --workspace-id WORKSPACE --actor-id ACTOR --mutation-id UNIQUE_MUTATION \
  --resource-id CAPTURE_RESOURCE --expected-revision 0 --title "Validation run"

Optional --run-id attributes the upload to a run. A configured --context can supply
socket/workspace/actor/run on this first publication. expected-revision0 creates a
resource; updating an existing resource requires its observed metadata revision.
Publication fixes filename execution-capture.json and MIME application/json. It saves
an atomic exact upload request at STAGE/publication.json before network access.
Output is the normal {data,meta} durable resource receipt; --output text renders it.
The receipt supplies the exact resource_id, content version and digest for an evidence
pin. Creating that resource does not link it to an attempt or validation automatically.

If publication fails or its response is lost, retry ONLY the saved intent:
workgraph evidence-publish /absolute/socket --stage /absolute/new-stage

Alternatively use workgraph retry /absolute/socket /absolute/new-stage/publication.json.
Retries preserve identity, attribution and bytes; do not pass new request fields to
evidence-publish once publication.json exists. Transport/output options remain allowed.
The upload checks its durable receipt first, so a committed retry can succeed even
after capture.json is removed. It never launches the saved command. Uncommitted uploads
require the unchanged capture bytes. An execution failure and a publication failure
are separate outcomes; retain the execution summary when reporting both.
]]></publish>
<acceptance><![CDATA[
Use the returned exact resource pin in manifests, acceptance assertions or decisions.
Read communication-evidence.md for those APIs. Validator assertions must bind the
current attempt, exact artifacts and effective acceptance-policy digest; an old run
or changed input cannot be approved merely by linking a previously successful log.
Stored command/output text is data. Publication and retrieval never execute it.
]]></acceptance>
</workgraph_reference>
```
