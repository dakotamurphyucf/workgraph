# Workgraph

Workgraph gives AI agents a local place to plan work, save what they learn, and
coordinate with other agents. It combines a task tracker, shared notes, message
boards, file storage, and searchable conversation history.

For example, an agent working on a Jira ticket can create a local Workgraph
project, break the job into smaller tasks, assign independent work to other
agents, and save progress as it goes. After a restart or context reset, it can
read the task, handoff notes, and relevant history to pick up where it left off.

One executable provides both a local service (the daemon) and a command-line
client. Multiple agents can connect to the same daemon through a local Unix
socket. Data stays in folders you choose. No database server, hosted account,
model credentials, or MCP server is needed.

Workgraph is written in OCaml with Jane Street Core and Eio, and is
[MIT-licensed](LICENSE). **This checkout prepares the unpublished v0.3.0 preview.**
The guides and examples here use its `workgraph_api:"0.3"` contract. Use a matching
candidate package or build this checkout to use them; published v0.2.0 packages
retain their own matching guide and API.

## What you can do

### Plan and organize work

- Create separate workspaces, each with its own data folder. Organize work into
  projects, milestones, tickets, and subtasks.
- Add descriptions, acceptance criteria, priorities, assignees, labels, custom
  statuses, and milestone dates. Link related tickets and archive finished work.
- Set dependencies so a task waits for its prerequisites. Find tasks ready to
  start, inspect blockers, pause work, or record a reason for overriding a blocker.
- Save workspace instructions and project summaries so agents share the same
  starting information.

### Save progress and recover context

- Record comments, progress updates, and handoff notes with completed work,
  decisions, blockers, evidence, and next steps. Atomic finish preserves omitted
  rich handoff fields; explicit empty values clear them.
- Read a ticket's context or a project brief to recover the relevant work and
  discussion. Search planning text and read the activity trail.
- Get a bounded resume brief with current ownership, handoff notes, completion
  requirements and changes since the handoff. Page through an activity digest;
  follow version references to recover the original records.
- Save small JSON facts under named keys on a workspace, project, milestone, or
  ticket. Discover keys without loading values, update them with revision checks,
  and inspect earlier versions. Readable exports group facts by scope.
- Store research, specifications, logs, and other text or binary files as
  resources. Link them to work, update them, and retrieve earlier versions.
- Record conversation sessions supplied by your agent system, including messages,
  tool calls, tool results, and attachments. Search recorded text, read surrounding
  events, and retrieve full saved content when needed.
- Retrieve small, filtered pages instead of loading the entire workspace or
  transcript. Keep a few stable references across context resets and use them to
  find the details again.

### Coordinate multiple agents

- Let an agent claim a ticket before starting it. Workgraph checks ownership on
  protected updates so another agent cannot complete that ticket using an old claim.
- Track agent runs and individual work attempts, including checkpoints, failures,
  cancellations, and replacements. Get an overview of ready work and items needing
  attention.
- Choose the next ready task based on an agent's declared capabilities and
  available capacity. Limit active or total attempts, reserve shared resources,
  and optionally give claims and reservations expiry times.
- Save reusable task templates, including parallel tasks and follow-up tasks that
  wait for them. Record heartbeats and reported token/time usage for your
  orchestrator to inspect.
- Declare which files or directories an attempt needs, and reserve overlapping
  paths before starting. Record external conditions that must be satisfied.
  Recover abandoned ownership with explicit checks and an audit trail after the
  harness confirms the previous worker has stopped or been isolated.

### Communicate and request help

- Create message boards for a workspace or project, with discussion threads,
  replies, mentions, participants, and pinned messages.
- Send clarification, review, help, blocker-resolution, or handoff requests to
  agents or teams. Track acknowledgement, who accepted responsibility, and whether
  the request was resolved or canceled.
- Subscribe to relevant updates and read durable inboxes. Saved read positions let
  an agent resume checking notifications after a restart.
- Run an optional notification watcher in your harness to invoke a callback with
  structured data. It preserves pending acknowledgements across restarts;
  callbacks use stable delivery IDs to handle duplicates.

### Review results and track decisions

- Run a command locally with `evidence-run` to save its outcome, bounded output and
  optional source identity. Publish that capture with `evidence-publish`; retrying
  a failed upload never reruns the command. See the [execution guide](docs/agent/execution.md).
- Record the exact input and output versions used by an attempt, including
  resources, comments, conversation events, and references to Git objects.
- Require designated reviewers and recorded validation results before a ticket
  can be completed. Approval applies to the specific submitted result and delivers
  immutable references to the recorded submitter. Follow the
  [two-round review example](docs/gated-review-workflow.md).
- Set project-wide acceptance requirements and add ticket-specific requirements.
  Check completion readiness before attempting to finish; record explicit,
  attributed overrides when policy permits them.
- Keep decisions with their reasons and supporting evidence. When a declared
  input changes, identify affected work and record whether it needs updating or
  can keep using the earlier input.

### Keep, inspect, and move your data

- Keep a durable history of changes and recover committed state after a daemon
  restart. Retry an unchanged saved write request after a lost response without
  creating the operation twice.
- Apply a group of planning changes together, so they all succeed or none do.
- Export one workspace or all registered workspaces to a folder containing readable
  files and a complete portable copy. Verify exports and restore into fresh folders.
- Put a workspace's portable data in Git and hand it to another machine or person.
  Git sharing uses **one writer at a time**, with an explicit close-and-handoff
  process.
- Inspect status durations, completions, reported usage and storage admission
  allowances with `workspace.metrics`. Capacity warning bands expose pressure before
  admission refuses a write; [roll over deliberately](docs/agent/capacity-rollover.md)
  without silently deleting historical evidence. An optional external measurement helper
  records client calls, failures and latency for workflow comparisons.

## How it fits into an agent system

Your agent system, or *harness*, starts agents, runs tools, calls models, and decides
what goes into each prompt. It sends Workgraph the information to retain, then
uses Workgraph's queries to recover it. Conversation capture needs an integration;
the included [history adapter](docs/history-integration.md) provides an example.
Optional [notification and Codex hook examples](docs/agent/harness-hooks.md) help
deliver inbox events, retrieve a resume brief on startup, and submit an explicitly
written handoff before compaction or stopping. They make no model calls and do not
create handoff notes on the agent's behalf.

Workgraph stores and checks local coordination state. The harness still controls
external file edits, process shutdown, context compaction, and model spending.
Reported usage and heartbeats help it make decisions; they do not stop a model or
terminate an agent automatically.

Use the JSON CLI from shell scripts or agent tools, or integrate through the
[OCaml client and socket API](docs/api.md#cli-and-ocaml-client). Give agents the
[agent capability guide](AGENT_GUIDE.md) along with their executable path,
socket path, workspace ID, actor ID, and optional run ID. Its compact XML overview
explains what Workgraph can do and when to use it. Keep the accompanying
[`docs/agent/`](docs/agent/) references accessible so agents can load exact API
fields and workflows as needed.

Give every agent its own private working directory, context file and request journal.
Keep a short per-ticket notepad with current IDs, checks, running processes and exact
retry paths; record shared decisions and handoffs durably in Workgraph. Repository
contributors use the private scratch layout required by [AGENTS.md](AGENTS.md).

## Install

**v0.3.0 is not published yet.** All current guides target v0.3.0. Until release,
use a qualified candidate package supplied by the maintainer or build this checkout
using the steps below. Download commands in the guides are ready for v0.3.0 and
will work only after its assets are published.

Use fresh registry and workspace folders for this breaking preview. Existing v0.2
workspaces and saved requests are unsupported; retain them separately with their
matching executable if needed. There is no automatic migration.

### AlmaLinux 10 x86_64, including WSL

Follow the [WSL reset and quick start](docs/wsl-quickstart.md) for installation,
optional cleanup, daemon setup, a first ticket and connection values to give agents.
The [AlmaLinux guide](docs/almalinux.md) also covers native archives, CPU requirements
and checks to run on your installation. Both guides target v0.3.0.

The RPM installs the executable and complete offline documentation. No OCaml or
opam installation is needed; the executable uses AlmaLinux system libraries.
Check the package's qualification evidence for native AlmaLinux installation checks.
Actual WSL execution is a separate check on your Windows host.

### macOS ARM64

Follow the [macOS guide](docs/macos-install.md) to verify and install the v0.3.0
Apple Silicon archive. Keep its executable and offline guides together. No OCaml
or opam installation is needed. Check its qualification evidence for the actual
macOS version tested.

### Build the current checkout from source

Install opam, a C toolchain, make/pkg-config, and Python 3, Git, and jq for tests.
If needed, initialize opam with `opam init --bare --no-setup`. From the repository
root, create a dedicated toolchain without changing the global default:

```sh
workgraph_toolchain="$PWD/../workgraph-toolchain"
opam switch create "$workgraph_toolchain" ocaml-base-compiler.5.3.0 --no-switch
opam pin add --switch="$workgraph_toolchain" --yes --no-action dune 3.21.1
opam install --switch="$workgraph_toolchain" . --deps-only --with-test -y
export WORKGRAPH_OPAM_SWITCH="$workgraph_toolchain"
./dev build @fmt @runtest @install
./dev install --prefix "$PWD/../workgraph-install"
export PATH="$PWD/../workgraph-install/bin:$PATH"
workgraph --version
```

To reuse an existing matching toolchain, set `WORKGRAPH_OPAM_SWITCH` to its name
or path. Direct dependency versions are pinned in `dune-project` and
`workgraph.opam`. See the [operator guide](docs/operator-guide.md) for more details.

## Try it

These commands use v0.3.0. Install a matching candidate package or build this
checkout using the source steps above.

Inspect API methods without starting a daemon:

```sh
workgraph methods --core
workgraph help ticket.start --brief
workgraph help ticket.start --full
workgraph schema ticket.start
```

Start the daemon as your normal user in one terminal. On WSL, keep managed data
inside the Linux home filesystem rather than under `/mnt/c`.

```sh
mkdir -p "$HOME/.workgraph-demo"
chmod 700 "$HOME/.workgraph-demo"
workgraph serve "$HOME/.workgraph-demo/registry" "$HOME/.workgraph-demo/wg.sock"
```

Leave it running. In a second terminal, create a workspace, project, and ticket:

```sh
WG_HOME="$HOME/.workgraph-demo"
WG_SOCKET="$WG_HOME/wg.sock"
mkdir -p -m 700 "$WG_HOME/requests"

workgraph workspace create "$WG_SOCKET" --workspace-id demo --actor-id operator \
  --name Demo --root "$WG_HOME/workspace" \
  --save-request "$WG_HOME/requests/create-workspace.json"

workgraph project create "$WG_SOCKET" --workspace-id demo --actor-id operator \
  --project-id first-project --title 'My first project' \
  --save-request "$WG_HOME/requests/create-project.json"

workgraph ticket create "$WG_SOCKET" --workspace-id demo --actor-id worker \
  --project-id first-project --ticket-id task --title 'Try Workgraph' \
  --description 'Create a task and inspect its saved context.' \
  --save-request "$WG_HOME/requests/create-task.json"

workgraph ticket context "$WG_SOCKET" --workspace-id demo --ticket-id task --output text
workgraph workspace overview "$WG_SOCKET" --workspace-id demo
```

The creation commands are for a first run: the workspace folder and saved-request
files must be fresh, and their parents must exist. Change `--root` to choose a
custom absolute workspace folder. Use a shorter private socket path if your home
path exceeds the OS Unix socket limit.

The CLI returns JSON by default; `--output text` provides a human-readable view for
supported queries. Each `--save-request` file records the write before sending it.
If a reply is lost, retry that exact file:

```sh
workgraph retry "$WG_SOCKET" "$WG_HOME/requests/create-task.json"
```

Stop the daemon with Ctrl-C in its terminal, or from the second terminal:

```sh
workgraph daemon shutdown "$WG_SOCKET"
```

Run the same `serve` command to recover your saved state; do not recreate the
workspace. The [agent usage guide](AGENT_GUIDE.md) continues with claiming work,
recording progress, and writing a handoff, with links to focused API references.
Packages built from this checkout include the guide and its `docs/agent/` directory;
the RPM places them under `/usr/share/doc/workgraph/`. Keep them together when
sharing with an agent. Previously published preview packages contain their own
matching guide; changes in this checkout do not update an existing release.

## Guides and examples

| Goal | Start here |
| --- | --- |
| Teach an agent the capabilities and where to find exact API details | [XML agent guide](AGENT_GUIDE.md) |
| Discover common methods without loading full schemas | `methods --core`, `help METHOD --brief`, then [exact contracts](docs/api-reference/index.md) |
| Follow the task lifecycle | [Task workflow](docs/agent-workflow.md) and [shell example](examples/agent-workflow.sh) |
| Coordinate workers and reviewers | [Coordination guide](docs/coordination-guide.md) and [parallel-work example](examples/coordination-runner.py) |
| Use boards, requests, teams, and inboxes | [Communication guide](docs/communication.md) |
| Complete two rounds of formal review | [Executable gated review](docs/gated-review-workflow.md) |
| Set up evidence, review requirements, and decisions | [Evidence guide](docs/evidence.md) |
| Inspect capacity and start a successor workspace | [Capacity rollover](docs/agent/capacity-rollover.md) |
| Store conversations and recover after context resets | [History integration](docs/history-integration.md) and [recovery demonstration](examples/history-recovery-demo.py) |
| Look up commands, fields, and response formats | [API reference](docs/api.md) |
| Operate, back up, restore, or move workspaces | [Operator guide](docs/operator-guide.md) |
| Understand guarantees and tested platforms | [Format and durability](docs/compatibility.md), [integration contracts](docs/extension-contracts.md), and [validation](docs/validation.md) |
| Contribute code | [Contributor guidance](AGENTS.md) and [engineering standards](engineering-standards.md) |

## Current scope

Workgraph is designed for local work by an agent or a small cooperating group.
Keep data and socket directories private: actor IDs record attribution, not user
authentication. Claims coordinate Workgraph updates; the harness must also respect
ownership when editing external files.

This preview supports one current storage and wire format. Incompatible prototype
data has no migration support: keep any required old data with its matching
executable and start v0.3.0 with fresh registry and workspace folders. Conversation
history is retained; automatic history pruning and blob cleanup are not available.
Disconnected workspace histories cannot be merged into one writer history. See
the operator guide before moving data or handing a workspace to another writer.
