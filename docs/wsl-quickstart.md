# Workgraph on AlmaLinux 10 in WSL: install and quick start

Version 0.5.2 includes the complete portable agent skill. See
[skill installation](agent-skill.md). Upgrading from 0.5.0 or 0.5.1 keeps the same API and
storage formats: retain your workspace, registry, contexts and saved requests.
Shut down the old daemon gracefully and restart with the new executable and the
same connection values. No data reset or migration is required.

This walkthrough installs **Workgraph v0.5.2 preview** on **x86_64/AMD64 AlmaLinux
10** userspace inside WSL. It uses API **0.5** and affected stored roots **4**.
Run commands in your AlmaLinux terminal as your normal user; use `sudo` only where
shown. No OCaml, opam or systemd setup is required for the RPM.

Native AlmaLinux tar/RPM qualification does not qualify an actual WSL kernel,
Windows or SELinux policy. The standard AlmaLinux 10 AMD64 image requires an
x86-64-v3-capable CPU. Keep registry/workspace data and the socket under your
Linux home, never `/mnt/c`. See the [release qualification scope](releases/v0.5.2.md#qualification-and-limits).

## Preserve an older setup before upgrading

For a first installation, continue with [Install v0.5.2](#install-v052).
For 0.5.0 or 0.5.1, follow [the patch upgrade steps](releases/v0.5.2.md#upgrade-from-050-or-051) and keep your existing data.
The preservation/fresh-root steps below apply only to **0.4 or earlier**; follow
the complete [older-preview upgrade steps](releases/v0.5.0.md#upgrade-from-04-or-an-older-preview)
**before** upgrading the RPM, which replaces `/usr/bin/workgraph`:

1. Identify the actual older binary (`type -a workgraph`), daemon socket,
   registered roots and custom launchers. Keep its matching executable and
   downloaded native/source/RPM archives so you can still read older data.
2. With that older executable and context, resolve or retain exact uncertain
   request journals, export and verify needed data, then stop custom launchers
   and shut down the old daemon gracefully. Preserve complete stopped registry
   and workspace roots, contexts, journals, logs and exports separately.
3. Install 0.5.2 and use the fresh version-specific paths below. Do not reuse an
   old socket, context, request directory or managed root. Older exports cannot
   be restored by 0.5. Do not change format markers or copy old managed files.

No deletion is required to upgrade. Uninstalling an RPM does not remove workspace
data. A reset is an optional, separate destructive choice: only after stopping
all owners and verifying retained backups, explicitly select the exact old roots
and contexts you intend to discard. Deleting only a registry leaves custom
workspace roots elsewhere; never broadly delete paths named `workgraph`, socket
guards or locks to force a new setup.

## Install v0.5.2

Download the RPM and checksums from the
[v0.5.2 release](https://github.com/dakotamurphyucf/workgraph/releases/tag/v0.5.2):

```bash
set -euo pipefail
command -v curl >/dev/null || sudo dnf install -y curl-minimal
sudo dnf install -y jq python3

mkdir -p "$HOME/Downloads/workgraph-0.5.2"
cd "$HOME/Downloads/workgraph-0.5.2" || exit

RELEASE="https://github.com/dakotamurphyucf/workgraph/releases/download/v0.5.2"

curl -fLO "$RELEASE/workgraph-0.5.2-1.el10.x86_64.rpm"
curl -fLO "$RELEASE/SHA256SUMS"

awk '$2 == "workgraph-0.5.2-1.el10.x86_64.rpm" { print; count++ }
     END { if (count != 1) exit 1 }' SHA256SUMS > rpm.SHA256SUMS &&
  sha256sum --check rpm.SHA256SUMS &&
  sudo dnf install -y ./workgraph-0.5.2-1.el10.x86_64.rpm

hash -r
command -v workgraph
workgraph --version
```

Do not continue if a download or checksum check fails. Expected executable and
version:

```text
/usr/bin/workgraph
0.5.2
```

The executable uses standard AlmaLinux system libraries. `jq` supports the shell examples and optional WGX viewer. WGX
interactive dashboards and dependency trees also need Python 3.10+; both helper
dependencies are installed above. Follow the [WGX setup](../README.md#watch-agents-work)
to install the two viewer files together.

## Start the daemon and create a workspace

Keep managed data and the socket on the Linux filesystem under `$HOME`, rather
than `/mnt/c`. This fresh example uses a private directory for the 0.5 release line.
If upgrading from 0.5.0 or 0.5.1, keep your existing context and paths instead.

```bash
workgraph init --help
workgraph help request.ask

umask 077
WG_HOME="$HOME/.local/state/workgraph-0.5"
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

| Location under `~/.local/state/workgraph-0.5/` | Purpose |
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
reissuing the creation command creates a new request. A malformed or mismatched
acknowledgement can also leave a write uncertain; keep the same saved identity.
Connection failure before sending is reported separately. See the installed CLI
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
if started=$(workgraph ticket start --context "$WG_CONTEXT" \
  --ticket-id first-task --initial-note "Testing the basic workflow."); then
  WG_TOKEN=$(jq -er '.result.data.token' <<<"$started")
else
  exit 1  # Preserve the exact saved request; do not invent a new retry identity.
fi
```

Record progress, then finish using that token:

```bash
workgraph ticket progress --context "$WG_CONTEXT" \
  --ticket-id first-task --token "$WG_TOKEN" \
  --body "Installation and basic commands work."

workgraph ticket finish --context "$WG_CONTEXT" \
  --ticket-id first-task \
  --token "$WG_TOKEN" \
  --evidence "Created, started, and updated a ticket successfully."
```

The finish response includes `"completed": true` and `ticket_revision` for the
affected ticket. Ownership tokens are visible sequential stale-writer fences, not
credentials; use only your own current actor/run/token. For real work, record what you
actually implemented or verified as the completion evidence.

## Inspect the saved state

```bash
workgraph workspace overview --context "$WG_CONTEXT" --output text
workgraph request list --context "$WG_CONTEXT" --ticket-id first-task

workgraph ticket context --context "$WG_CONTEXT" \
  --ticket-id first-task --output text
```

With context, `request list/get/ask/resolve/...` selects request-domain methods;
`ticket get` also reads the canonical ticket context. For an atomic question and
answer example, read the installed
[`communication reference`](../skills/workgraph/references/communication-evidence.md). Reading or filtering
requests never acknowledges delivery or inbox processing.

Omit `--output text` to receive JSON. In a new terminal, restore the context
variable before running commands:

```bash
export WG_CONTEXT="$HOME/.local/state/workgraph-0.5/agent.json"
```

## Give an agent access

Install the complete skill folder using [skill installation](agent-skill.md).
For example, after copying it to your harness's configured skills directory, its
entry point might be `$HOME/.agents/skills/workgraph/SKILL.md`. The folder includes
its own references, API schemas and scripts.

The v0.5.2 RPM installs the full folder at
`/usr/share/doc/workgraph/skills/workgraph/`. Copy that folder into your harness
using the skill installation instructions above. Older v0.5.0 packages retain
the previous guide layout; their assets have not been replaced.

Give your agent the introduction below, replacing `<your-linux-user>` with your
actual Linux username. It must have shell access inside this WSL distribution
and permission to use your Workgraph socket.

> Workgraph is our local task tracker and persistent memory store. Use it to
> break work into tickets, record progress and decisions, and recover context
> between sessions. Read `/home/<your-linux-user>/.agents/skills/workgraph/SKILL.md` and follow its
> references when needed. Use `/usr/bin/workgraph` with
> `--context /home/<your-linux-user>/.local/state/workgraph-0.5/agent.json`.
> The workspace is `demo`; the project is `demo-project`.

To print the actual connection values for this setup:

```bash
printf 'Executable: %s\nContext: %s\nGuide: %s\n' \
  "$(command -v workgraph)" \
  "$HOME/.local/state/workgraph-0.5/agent.json" \
  "$HOME/.agents/skills/workgraph/SKILL.md"
```

This context identifies one actor, `agent-1`. For multiple cooperating agents,
give each its own actor/context and request directory while sharing the daemon
and workspace. The skill explains optional runs and coordination. After
an upgrade or deliberate reset, give agents the new context and matching guide;
do not reuse old saved requests or old prototype workspace roots.

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

Startup uses an exclusive socket-path guard and recovers only an exact previously
recorded native socket identity after ownership and peer checks. Foreign, live,
replaced or unknown endpoints refuse. A crash before identity publication can
require a fresh private endpoint. Connection refusal or a process-name guess is
not cleanup authority. Preserve locks, logs and managed data; choose a fresh socket
and explicitly update startup/context configuration if ownership is uncertain.

## Platform checks and further information

Before installing a release, check its qualification evidence for passing fresh
AlmaLinux 10 x86_64 container checks of both the RPM and native archive. Actual
WSL execution is a separate environment check. The standard AlmaLinux 10 AMD64
target requires an x86-64-v3-capable CPU.

The [AlmaLinux guide](almalinux.md) includes optional installed-runtime checks
you can run on your WSL instance. See the [operator guide](operator-guide.md)
for backups, exports, Git handoffs, and recovery, and the
[agent guide](../skills/workgraph/SKILL.md) for the full capability overview.
