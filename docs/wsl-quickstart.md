# Workgraph on AlmaLinux 10 in WSL: reset, install, and quick start

This guide installs **Workgraph v0.2.0 preview** on **x86_64/AMD64 AlmaLinux 10**
inside WSL. Run the commands in your AlmaLinux terminal, as your normal user;
use `sudo` only where shown. No OCaml, opam, or systemd setup is required.
Use that package's bundled guides for its matching API. The current checkout
prepares unpublished v0.3.0; its [source-build instructions](../README.md#build-the-current-checkout-from-source)
and agent guide apply to that newer preview. This page retains the published
v0.2.0 download links and workflow.

For a first installation, skip the optional reset and begin with
[Install v0.2.0](#install-v020).

The preview has changed its API and storage format. Start with fresh registry
and workspace folders; old prototype data has no migration support. You may
retain old data separately with its matching executable instead of deleting it.

## Optional: remove an older installation and its data

Removing the RPM does **not** remove workspace data. An older manually installed
executable can also take precedence over the RPM in your `PATH`.

### 1. Identify the old executable and workspace folders

```bash
type -a workgraph
rpm -q workgraph
```

While the old daemon is running, list its registered workspace roots. Set
`OLD_SOCKET` to the socket you actually used; the value below is an earlier
example location. Another example was `$HOME/.workgraph-demo/wg.sock`.

```bash
OLD_SOCKET="$HOME/.local/state/workgraph/daemon.sock"
workgraph call "$OLD_SOCKET" workspace.list '{}'
```

Record any workspace roots outside the main Workgraph directory. Those folders
need separate cleanup if you want to discard their data. If the daemon is
already stopped, use your previous startup configuration to identify its paths;
you do not need to start it merely to uninstall the executable.

### 2. Stop the old daemon

Stop any custom launcher you created so it cannot restart the daemon, then:

```bash
workgraph call "$OLD_SOCKET" daemon.shutdown '{}'
```

Alternatively, press **Ctrl-C** in the terminal running the foreground daemon.
Repeat for any other old instances you intend to reset. If shutdown fails, stop
and resolve that before deleting data. Do not delete managed folders, socket
files, or locks while their daemon is running.

### 3. Remove the old executable

If `rpm -q workgraph` found an installed package:

```bash
sudo dnf remove workgraph
```

If `type -a workgraph` also showed a manually installed copy at
`~/.local/bin/workgraph`, remove that copy:

```bash
rm -i -- "$HOME/.local/bin/workgraph"
```

For other manual installations, remove only the confirmed old executable or
dedicated installation directory. Remove old shell aliases or `PATH` entries
pointing to extracted packages or source-build installations. Do not delete a
source repository or shared development tools just to uninstall Workgraph.

Clear Bash's cached executable locations and check again:

```bash
hash -r
type -a workgraph
```

For a complete uninstall, the last command should report that Workgraph was not
found. You do not need to uninstall opam or its shared toolchains.

### 4. Optionally delete old local data

**Deletion permanently removes tickets, resources, conversation history, and
other state in the selected folders.** Skip this step to retain old data
separately. If you need a backup, preserve the complete stopped workspace root
before deleting it.

The following are example locations from earlier setup instructions. Run only
the commands matching directories you have inspected and want to discard:

```bash
rm -rI -- "$HOME/.local/state/workgraph"
rm -rI -- "$HOME/.workgraph-demo"
```

GNU `rm -I` asks for confirmation before recursive deletion. These commands are
for AlmaLinux, not the host Windows or macOS shell.

If you also want to erase a setup made with this guide, stop its daemon first,
then explicitly delete its separate directory:

```bash
rm -rI -- "$HOME/.local/state/workgraph-0.2"
```

Separately remove any custom workspace roots identified earlier, and old
context/request folders you no longer need. **Deleting the registry alone does
not delete workspaces stored elsewhere.** Exports and Git copies also remain
where you stored them. Do not broadly search for and delete everything named
`workgraph`.

## Install v0.2.0

Download the RPM and checksums from the
[v0.2.0 release](https://github.com/dakotamurphyucf/workgraph/releases/tag/v0.2.0):

```bash
command -v curl >/dev/null || sudo dnf install -y curl-minimal
sudo dnf install -y jq

mkdir -p "$HOME/Downloads/workgraph-0.2.0"
cd "$HOME/Downloads/workgraph-0.2.0" || exit

RELEASE="https://github.com/dakotamurphyucf/workgraph/releases/download/v0.2.0"

curl -fLO "$RELEASE/workgraph-0.2.0-1.el10.x86_64.rpm"
curl -fLO "$RELEASE/SHA256SUMS"

sha256sum --check --ignore-missing SHA256SUMS &&
  sudo dnf install -y ./workgraph-0.2.0-1.el10.x86_64.rpm

hash -r
command -v workgraph
workgraph --version
```

Do not continue if a download or checksum check fails. Expected executable and
version:

```text
/usr/bin/workgraph
0.2.0
```

The executable uses standard AlmaLinux system libraries. `jq` is needed only
for the shell example below that extracts an ownership token.

## Start the daemon and create a workspace

Keep managed data and the socket on the Linux filesystem under `$HOME`, rather
than `/mnt/c`. This setup uses a private directory dedicated to v0.2.0.

```bash
umask 077
WG_HOME="$HOME/.local/state/workgraph-0.2"
mkdir -p "$WG_HOME"

export WG_CONTEXT="$WG_HOME/agent.json"

workgraph init \
  --context "$WG_CONTEXT" \
  --socket "$WG_HOME/daemon.sock" \
  --workspace-id demo \
  --actor-id agent-1 \
  --root "$WG_HOME/workspace" \
  --name Demo \
  --request-directory "$WG_HOME/requests" \
  --start-daemon true \
  --registry "$WG_HOME/registry" \
  --daemon-log "$WG_HOME/daemon.log"
```

This starts the daemon in the background when needed, creates the workspace,
and writes connection defaults to `agent.json`. Repeating the same setup reuses
the matching workspace and context. The first run requires a fresh workspace
root; do not precreate `$WG_HOME/workspace`.

| Location under `~/.local/state/workgraph-0.2/` | Purpose |
| --- | --- |
| `registry/` | Local workspace registrations and administrative state |
| `workspace/` | This workspace's durable tickets, resources, and history |
| `daemon.sock` | Local client connection socket |
| `agent.json` | Connection and write-attribution defaults for this agent |
| `requests/` | Saved exact write requests for recovery after an uncertain response |
| `daemon.log` | Daemon output and diagnostics |

The request directory is optional, but recommended. With it configured, the CLI
saves durable writes before sending them and prints each saved path to stderr.
Those messages are expected. If a response is lost, retry the exact saved file;
reissuing the creation command creates a new request. See the installed CLI
contract for recovery details.

`WG_CONTEXT` is a shell convenience variable: commands use it only when you pass
`--context "$WG_CONTEXT"` explicitly.

## Create a project and complete a ticket

Run these creation commands once in the new workspace:

```bash
workgraph project create --context "$WG_CONTEXT" \
  --project-id demo-project \
  --title "My first project"

workgraph ticket create --context "$WG_CONTEXT" \
  --project-id demo-project \
  --ticket-id first-task \
  --title "Try Workgraph"
```

Start the ticket and retain the returned ownership token:

```bash
WG_TOKEN=$(
  workgraph ticket start --context "$WG_CONTEXT" \
    --ticket-id first-task \
    --initial-note "Testing the basic workflow." |
  jq -er '.result.data.token'
)
```

Record progress, then finish using that token:

```bash
workgraph comment add --context "$WG_CONTEXT" \
  --json-field target '{"kind":"ticket","id":"first-task"}' \
  --kind progress \
  --body "Installation and basic commands work."

workgraph ticket finish --context "$WG_CONTEXT" \
  --ticket-id first-task \
  --token "$WG_TOKEN" \
  --evidence "Created, started, and updated a ticket successfully."
```

The finish response includes `"completed": true`. For real work, record what you
actually implemented or verified as the completion evidence.

## Inspect the saved state

```bash
workgraph workspace overview --context "$WG_CONTEXT" --output text

workgraph ticket context --context "$WG_CONTEXT" \
  --ticket-id first-task --output text
```

Omit `--output text` to receive JSON. In a new terminal, restore the context
variable before running commands:

```bash
export WG_CONTEXT="$HOME/.local/state/workgraph-0.2/agent.json"
```

## Give an agent access

The RPM installs the capability guide and its detailed references together:

```text
/usr/share/doc/workgraph/AGENT_GUIDE.md
/usr/share/doc/workgraph/docs/agent/
/usr/share/doc/workgraph/docs/api-reference/
```

Give your agent the introduction below, replacing `<your-linux-user>` with your
actual Linux username. It must have shell access inside this WSL distribution
and permission to use your Workgraph socket.

> Workgraph is our local task tracker and persistent memory store. Use it to
> break work into tickets, record progress and decisions, and recover context
> between sessions. Read `/usr/share/doc/workgraph/AGENT_GUIDE.md` and follow its
> references when needed. Use `/usr/bin/workgraph` with
> `--context /home/<your-linux-user>/.local/state/workgraph-0.2/agent.json`.
> The workspace is `demo`; the project is `demo-project`.

To print the actual connection values for this setup:

```bash
printf 'Executable: %s\nContext: %s\nGuide: %s\n' \
  "$(command -v workgraph)" \
  "$HOME/.local/state/workgraph-0.2/agent.json" \
  '/usr/share/doc/workgraph/AGENT_GUIDE.md'
```

This context identifies one actor, `agent-1`. For multiple cooperating agents,
give each its own actor/context and request directory while sharing the daemon
and workspace. The agent guide explains optional runs and coordination. After
a hard reset, give agents the new context and guide; do not reuse old saved
requests or old prototype workspace roots.

## Stop and restart

Stop the daemon gracefully:

```bash
workgraph daemon shutdown --context "$WG_CONTEXT"
```

Your data remains on disk. Repeat the full `workgraph init` setup block above to
restart and reuse the workspace. Do not repeat the project/ticket creation
commands just to resume work. Shutting down the WSL instance ends its running
processes; run setup again when returning. No automatic startup service is
installed by this guide.

## Platform checks and further information

The release passed fresh AlmaLinux 10 x86_64 container installation checks for
both the RPM and native archive. Actual WSL execution is a separate environment
check. The standard AlmaLinux 10 AMD64 target requires an x86-64-v3-capable CPU.

The [AlmaLinux guide](almalinux.md) includes optional installed-runtime checks
you can run on your WSL instance. See the [operator guide](operator-guide.md)
for backups, exports, Git handoffs, and recovery, and the
[agent guide](../AGENT_GUIDE.md) for the full capability overview.
