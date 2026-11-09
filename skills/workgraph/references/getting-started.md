# Getting started

This walkthrough uses the Workgraph command-line interface (CLI): the `workgraph`
program invoked from a shell. The [concepts reference](concepts.md) explains tickets,
claims and revisions. For precise input and recovery rules, read
[CLI contracts](cli-contract.md).

## Connect to supplied work

Prefer the connection values supplied by your runner. Reuse its workspace rather
than creating an unrelated one. Set absolute paths for your installed executable
and private context file:

```sh
WG=/absolute/path/to/workgraph
CONTEXT=/absolute/agent/context.json
AGENT_DIR=/absolute/agent
wg() { "$WG" --context "$CONTEXT" "$@"; }
"$WG" --version
wg workspace get
```

The context holds socket, workspace and permitted actor/run defaults. A context
with a request directory saves each new durable mutation before sending it. Confirm that
setup has configured one before writing. The chosen agent directory must exist;
keep response files and recovery notes there. Context defaults never silently
filter reads to “my work.” Select filters explicitly. See `"$WG" init --help` for
setup and `"$WG" help ticket.start` for offline method help.

## Set up a fresh local example

Skip this section when you already have a working context. Use the matching
supplied 0.8.0 executable for this source skill. Its application
API is still 0.7; this is distinct from the executable package version and does
not announce a published download. Normal startup/restore accept current formats. Existing supported
0.6.2-format workspaces need [offline migration](migration.md) into a new root,
with a fresh registry, context and request directory afterward. Preserve old saved
requests and resolve uncertain writes with their old matching executable first;
see [compatibility](compatibility.md).

On macOS or Linux, choose a new private absolute directory. The following creates
an isolated example under a fresh temporary directory; it does not use the current
project as managed storage. The `jq` program is needed only for the JSON extraction
shown later.

```sh
WG=/absolute/path/to/workgraph
DEMO=$(mktemp -d "/tmp/workgraph-demo.XXXXXX")
DEMO=$(cd "$DEMO" && pwd -P)
chmod 700 "$DEMO"
AGENT_DIR="$DEMO/agent"
mkdir "$AGENT_DIR"
CONTEXT="$AGENT_DIR/context.json"
SOCKET="$DEMO/daemon.sock"
"$WG" init --context "$CONTEXT" --socket "$SOCKET" \
  --workspace-id demo --actor-id worker \
  --root "$DEMO/workspace" --name "First Workgraph workspace" \
  --request-directory "$AGENT_DIR/requests" \
  --start-daemon true --registry "$DEMO/registry" \
  --daemon-log "$DEMO/daemon.log"
wg() { "$WG" --context "$CONTEXT" "$@"; }
```

Stop if setup fails. `init` creates the request directory, saves setup requests,
starts and checks the service, opens the new workspace, and publishes the context.
The registry and workspace paths are separate managed directories. Do not delete
sockets or lock files to resolve startup errors; follow
[administration](administration.md). On WSL place managed data in the Linux home
filesystem, not `/mnt/c`.

Some agent runners stop child processes when a shell call ends. If yours does,
run `serve` in a runner-managed persistent process or a separate terminal; see
[startup readiness and recovery](administration.md#startup-readiness-and-recovery).
A successful `init` verifies readiness at that moment, not the runner's future
process lifetime. Restart with the same registry and socket to recover saved work.

### Add another agent to the same workspace

Each agent uses its own actor identity, context and request journal. Share the
existing socket and workspace ID; do not create another workspace or copy the
first agent's context. For the demo above:

```sh
SECOND_AGENT_DIR="$DEMO/second-agent"
mkdir "$SECOND_AGENT_DIR" || exit 1
"$WG" init --context "$SECOND_AGENT_DIR/context.json" --socket "$SOCKET" \
  --workspace-id demo --actor-id reviewer \
  --request-directory "$SECOND_AGENT_DIR/requests" || exit 1
```

Give that agent its new context path. Register a separate run when tracking an
agent invocation; see [coordination](coordination.md). Startup options such as
`--start-daemon`, `--registry` and `--daemon-log` belong to `init`/`bootstrap`,
not ordinary API calls.

## Read, claim, record progress and finish

In the fresh example, create a ticket. For real work, use your assigned ticket ID
and start with its context instead of creating this example. Run commands in order;
a failed call must stop the flow before the next step. In a noninteractive script,
use explicit exit checks or `set -e`.

```sh
wg ticket create --title "Write and check a small note" \
  --description "Create a local note and verify its contents." \
  > "$AGENT_DIR/create.json" || exit 1
TICKET=$(jq -er '.result.data.ticket_id' "$AGENT_DIR/create.json") || exit 1
wg ticket context --ticket-id "$TICKET" || exit 1
wg ticket start --ticket-id "$TICKET" \
  > "$AGENT_DIR/start.json" || exit 1
TOKEN=$(jq -er '.result.data.token' "$AGENT_DIR/start.json") || exit 1
```

`ticket.start` checks readiness and records the claim together. Its returned token
identifies your ownership; save that actual value. This minimal example has no
run or attempt. For recorded agent invocations, capabilities, timed leases and
allocation, read [coordination](coordination.md).

Now do and verify the example's external work, then record the actual outcome:

```sh
printf '%s\n' 'Workgraph keeps a durable record of work.' > "$AGENT_DIR/note.txt"
cat "$AGENT_DIR/note.txt" || exit 1
wg ticket progress --ticket-id "$TICKET" --token "$TOKEN" \
  --body "Created the note and read it back successfully." || exit 1
wg ticket finish --ticket-id "$TICKET" --token "$TOKEN" \
  --evidence "Created agent/note.txt with the expected sentence and read it back successfully." \
  --json-field handoff '{"summary":"Example note created and checked.","next_steps":"No remaining work."}' \
  > "$AGENT_DIR/finish.json" || exit 1
wg ticket context --ticket-id "$TICKET"
```

The daemon records progress; the shell performed the file edit and check.
`ticket.finish` saves evidence, the optional handoff, and ticket completion together.
It also completes an active attempt when one exists. It rechecks current ownership,
dependencies, amendments and configured completion requirements. For real delivery,
link exact resources or captured execution evidence when durable access to output
is needed; a local path in prose does not publish the file.

## Recover a failed or uncertain write

Ordinary journaled writes print `saved_request: /absolute/file.json` to standard error. Keep that
file and inspect the exit status. Standard output contains the JSON response;
never merge error output into JSON before parsing it.

If a request might have executed but the reply was lost, retry its exact saved
file using the same socket:

```sh
"$WG" retry "$SOCKET" /absolute/saved-request.json
```

Do not rerun the original command with a new identity or changed revision. A known
`Conflict` is different: read the current record and decide whether a new operation
is appropriate. See [errors and recovery](cli-contract.md#errors-and-recovery).

For the isolated example only, finish by shutting down its daemon:

```sh
wg daemon shutdown
```

Do not shut down a shared service simply because your ticket is finished. Keep its
request files and local data while recovery or inspection may still be needed.
