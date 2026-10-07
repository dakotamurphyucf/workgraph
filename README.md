# Workgraph

Workgraph is a local task graph and durable working memory for agent workflows.
A Unix-socket daemon stores plans, progress, handoffs, artifacts and observable
conversation history; a JSON CLI lets a harness recover context and coordinate
workers. It is a standalone OCaml/Core/Eio package licensed under [MIT](LICENSE).

The harness owns model calls, prompt assembly, process execution and external
side effects. Workgraph records supplied facts and ownership; it does not launch
agents, count provider tokens or stop external processes. No hosted service,
model credentials or MCP server is required.

Version 0.1.0 is an early preview with one current storage/wire schema. Prototype
formats and automatic migrations are unsupported.

## Features

- Projects, milestones and tickets with dependencies, readiness, holds, waivers,
  exclusive claims, progress and structured handoffs.
- Atomic planning transactions, durable receipts, exact-request retries and
  recovery that validates transaction history and referenced bytes.
- Versioned text/binary resources, pinned manifests, review gates, decisions and
  explicit reconciliation when consumed inputs change.
- Runs, attempts, fork/join templates, allocation pools, optional leases,
  communication threads, requests, subscriptions and durable inboxes.
- Bounded context/history queries, retained session payloads, portable exports,
  verified restore and explicit one-writer Git handoffs.

## Build and install

Install opam, a C toolchain, make/pkg-config and Python 3 for tests. If needed,
initialize opam with `opam init --bare --no-setup`. From this checkout, provision
a dedicated switch without changing the global default:

```sh
workgraph_toolchain="$PWD/../workgraph-toolchain"
opam switch create "$workgraph_toolchain" ocaml-base-compiler.5.3.0 --no-switch
opam install --switch="$workgraph_toolchain" . --deps-only --with-test -y
export WORKGRAPH_OPAM_SWITCH="$workgraph_toolchain"
./dev build @fmt @runtest @install
./dev install --prefix "$PWD/../workgraph-install"
../workgraph-install/bin/workgraph --version
```

For an existing matching switch, set `WORKGRAPH_OPAM_SWITCH` to its name or path.
`./dev` uses that switch (default: `default`) and this repository's Dune root;
it does not install dependencies or change switch defaults. Direct dependency
versions are pinned in `dune-project` and `workgraph.opam`.

For AlmaLinux 10 x86_64 and WSL, see the [package and WSL guide](docs/almalinux.md)
for the build recipe, validation scope and runtime commands.
See the [operator guide](docs/operator-guide.md)
for runtime layout, recovery and packaging. [Validation](docs/validation.md) records
executed tests and platform limits; test counts are not capacity or durability guarantees.

## Quickstart

Use a private runtime directory outside the source tree. In one terminal, start
the foreground daemon with the executable built above:

```sh
mkdir -p -m 700 "$HOME/.workgraph-demo"
_build/default/bin/main.exe serve \
  "$HOME/.workgraph-demo/registry" "$HOME/.workgraph-demo/wg.sock"
```

In another terminal, from the same checkout:

```sh
WG="$PWD/_build/default/bin/main.exe"
RUNTIME="$HOME/.workgraph-demo"
SOCKET="$RUNTIME/wg.sock"
mkdir -p -m 700 "$RUNTIME/requests"

"$WG" workspace create "$SOCKET" --workspace demo --actor operator \
  --name Demo --root "$RUNTIME/workspace" \
  --save-request "$RUNTIME/requests/create-workspace.json"
"$WG" ticket create "$SOCKET" --workspace demo --actor worker \
  --ticket-id task --title 'Verify restart recovery' \
  --description 'Record progress, restart, and recover the same context.' \
  --save-request "$RUNTIME/requests/create-task.json"
"$WG" ticket context "$SOCKET" --workspace demo --ticket-id task --text
```

The workspace root and saved-request files must be fresh; their parents must
exist. Use a shorter private socket path if your home path exceeds the OS Unix
socket limit. Default output is JSON-RPC; `--text` is for human inspection. After
a lost write reply, retry the unchanged saved request with
`"$WG" retry "$SOCKET" "$RUNTIME/requests/create-task.json"`.

Ctrl-C or SIGTERM drains admitted requests. Restart with the same registry/socket
to recover durable data. Continue with the [agent context guide](AGENT_GUIDE.md)
for claim, progress, handoff, ownership and bounded retrieval rules.

## Documentation

- [Agent context guide](AGENT_GUIDE.md): concise CLI operating contract and recovery.
- [API reference](docs/api.md): methods, response shapes, resources and exports.
- [Task workflow](docs/agent-workflow.md) and [coordination guide](docs/coordination-guide.md).
- [Communication](docs/communication.md), [evidence](docs/evidence.md) and
  [history integration](docs/history-integration.md).
- [Operator guide](docs/operator-guide.md), [format and durability](docs/compatibility.md)
  and [validation](docs/validation.md).
- [Extension contracts](docs/extension-contracts.md), [contributor guidance](AGENTS.md)
  and [engineering standards](engineering-standards.md).

Keep local data directories private. Actor/run IDs are audit attribution, not
authentication. Advisory locks and claim tokens do not coordinate disconnected
copies or fence external filesystem writes. Read the operator guide before moving
workspace data; retain backups and hand off the sole writer explicitly.
