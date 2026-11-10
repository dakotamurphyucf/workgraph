# Optional installation and connections

Install the optional **0.8.3** browser UI alongside the matching Workgraph daemon.
The [core installation guide](../../README.md#install-and-set-up) remains available
for CLI-only use.

## Install a release

Choose the archive for your machine: `macos-arm64` for Apple Silicon, or
`almalinux-10-x86_64` for AlmaLinux 10 on AMD64. The latter requires an
x86-64-v3-capable CPU. Each UI archive contains both executables and the offline
guides. In a new download directory:

```sh
platform=macos-arm64  # On AlmaLinux: almalinux-10-x86_64
release=https://github.com/dakotamurphyucf/workgraph/releases/download/v0.8.3
archive="workgraph-ui-0.8.3-$platform.tar.gz"
curl -fLO "$release/$archive"
curl -fLO "$release/SHA256SUMS"
awk -v name="$archive" '$2 == name { print; found++ } END { if (found != 1) exit 1 }' \
  SHA256SUMS > selected.sha256
# macOS; on AlmaLinux use: sha256sum -c selected.sha256
shasum -a 256 -c selected.sha256
mkdir -p "$HOME/.local/opt"
tar -xzf "$archive" -C "$HOME/.local/opt"
installation="$HOME/.local/opt/workgraph-ui-0.8.3-$platform"
"$installation/bin/workgraph-ui" --state-root "$HOME/.local/state/workgraph-ui"
```

Continue only if the checksum succeeds. The launcher opens your browser and prints
the local URL. Use **Workgraph** at the top of the sidebar to add a connection to
an existing daemon or start one. Select or create a workspace, then choose an
acting person or agent before making changes. No model service or credentials are
required. Actor selection is cooperative attribution, not login authentication.

On AlmaLinux, you can instead download the matching core and UI RPMs, verify
both against `SHA256SUMS`, then install them together:

```sh
sudo dnf install ./workgraph-0.8.3-1.el10.x86_64.rpm \
  ./workgraph-ui-0.8.3-1.el10.x86_64.rpm
workgraph-ui --state-root "$HOME/.local/state/workgraph-ui" --no-open
```

`--no-open` prints the URL without trying to launch a browser, useful inside WSL.
For a stable address, add `--port 8765`. Windows-to-WSL forwarding is your local
network setup and has not been qualified in this release. macOS downloads are
not Developer ID signed or notarized; Gatekeeper may require explicit approval.

### Upgrade without losing your data

Stop the old companion and deliberately stop or hand off the daemon you manage.
Keep workspace roots, registry, context files and request journals outside the
installation directory. Resolve uncertain operations with their original version
before switching. Install both 0.8.3 executables together and restart with the same
private data locations. Existing 0.7.0 and 0.8.0 workspace formats are unchanged; no reset or
migration is needed. For older 0.6.2 data, use the separate [migration guide](../migration.md).
Removing the UI removes package files, not workspace data. See [package removal](packages.md).

## Core and UI are separate choices

The core `workgraph` package remains independently buildable and installable.
It does not require frontend assets, Node.js, npm or the UI HTTP libraries. The
optional `workgraph-ui` package is in the same repository and Dune root. Its
installed form is one native companion executable with embedded browser
assets, paired with a matching `workgraph` daemon executable. Installed operation
requires neither Node.js nor opam. Source-build instructions are also provided below.

Do not infer that a core-only install contains a UI or that an empty optional
install manifest is a successful UI build. Do not mix companion and daemon
versions. Install core and UI from the same **0.8.3** release. Application API
**0.7** alone is insufficient to establish matching package semantics.

## Connect deliberately

The connection screen remembers a label and an explicit local Unix socket
path. Attach checks the daemon handshake and version. Attaching does not create a
workspace or start a daemon. Remembered profiles are local companion settings;
changing an endpoint produces a new generation so old saved operations keep their
original target. A socket path is not cryptographic daemon identity: replacing a
daemon at the same path may be undetectable.

The companion compares the fully decoded `initialize.version` with its compiled
package version before each ordinary daemon operation, including direct reads,
new write preparation/admission and receipt lookup. Each explicit bounded native
helper start, exact retry or recovery is qualified before its daemon work. There
is no attach/profile cache that authorizes later operations. An incompatible
endpoint reports observed and required versions with matching-core upgrade
guidance. Profile editing, local inspection and retained drafts remain available.
The check takes at most two seconds and respects a smaller remaining operation
deadline. It neither upgrades nor starts a daemon automatically.

After building, launch the companion with a private absolute state-root path:

```sh
_build/default/ui/companion/bin/main.exe \
  --state-root "$HOME/.local/share/workgraph/ui" --no-open \
  --daemon-executable "$PWD/_build/default/bin/main.exe"
```

An installed pair uses `workgraph-ui --state-root ABS` and normally needs no
executable override. The launcher looks for `workgraph` beside the invoked UI
executable, resolving relative and PATH invocation. If that logical location has
no pair, it follows the UI symlink to its physical installation directory. The
optional `--daemon-executable ABS` is a native launcher setting; the browser cannot
choose a program or command line. A missing, wrong-version or unresponsive pair
disables local startup while profile configuration remains usable; attach and
reads can still use an independently supplied matching daemon.
Version probing has a two-second deadline. For the verified archive layout,
source builds, extraction checks and removal rules, see [optional platform
packages](packages.md). Package removal must leave private workspace data,
profiles and recovery journals intact.

The default listener is IPv4 loopback on an ephemeral port. `--host` accepts only
`127.0.0.1` or `::1`; `--port` accepts `0..65535`. The launcher emits one
`workgraph-ui-ready-1` JSON readiness record with the actual URL after binding.
`--no-open` leaves opening that URL to the operator. Browser-opening failure keeps
the companion running and prints the URL. No profile or daemon starts implicitly.
Open the printed URL exactly: replacing `127.0.0.1` with `localhost`, or changing
its port, changes the HTTP authority and browser origin. The companion checks
those values; an equivalent-looking address is not automatically accepted.

The browser can reuse HTTP/1.1 connections for successive asset requests, API
calls, and live observation. This reduces the number of new connections needed during
page loading and live updates. Browsers may still open several
connections for parallel requests; keep-alive does not force all traffic onto one
socket. An idle connection closes after 90 seconds without complete request
headers, and the browser can open another when needed. Each request still checks
its own host, origin, launch capability, and body framing. Client-requested close
and invalid transport requests end the connection. Custom HTTP clients should
wait for each complete response before sending the next request; pipelining is
not supported. These browser HTTP connections are separate from the daemon's
Unix-socket protocol.

Use **Connection profiles** for first-run setup, then **Add connection**. Save the
profile, choose **Attach & inspect capabilities** in **Daemon**, and use
**Use connection** to select that endpoint for browsing. In **Daemon**, expand
**Start a local daemon** if the service is not already running. Local startup captures
that profile generation, registry directory, private log path, timeout and current
observer or writer context. **Review startup plan** saves this exact plan without
starting a daemon; **Start saved plan** starts the reviewed attempt. A failed or
uncertain attempt retains its identity for inspection and an explicit exact retry.
Endpoint readiness is a historical handshake, with process ownership unknown:
another launcher can win the socket race. It is never reported as proof that the
companion owns a daemon process.

**Disconnect selection** changes browser selection only. **Review daemon shutdown**
requires an acting actor and prepares an exact `daemon.shutdown` request; the
subsequent execution asks the daemon to drain. Neither acknowledgement nor endpoint
unreachability proves process exit. Closing the browser does not kill a shared
daemon. Never delete an occupied socket or lock to force startup.

In Overview, open **Manage project** or **Manage workspace** for project, milestone
and workspace tools, or select **Maintenance** in that dialog for administration.
An attached empty registry offers **Choose or create a workspace**. Reads
work without a writer. Tailored lifecycle forms capture their original connection,
scope, actor and optional run while editing; navigation and actor changes preserve
unsent text and do not recapture its target. Review validates and durably prepares
the request, then a separate explicit execution applies it. Conflicts retain the
original guard and require a refreshed record and a new reviewed draft. Close a
workspace before unregistering its local association; its portable files remain.

## Work on the source build

These commands are repository development entry points, not installed launcher
commands. Use the pinned, already provisioned OCaml switch selected by `./dev`;
`WORKGRAPH_OPAM_SWITCH` may select another already provisioned matching switch.
Do not change unrelated switches or global defaults. The frontend requires the
exact Node.js 22.14.0 and npm 10.9.2 builder recorded in
`ui/tools/toolchain.json`. The source-only engineering guide is
`ui/frontend/README.md`.

```sh
# Independent core checks; UI dependencies and frontend assets are unnecessary.
WORKGRAPH_UI_BUILD=false ./dev build @fmt @runtest @install

# Optional frontend dependency install and checks.
./dev-ui install
./dev-ui check

# Build the real frontend and generate/check embedded assets.
./dev-ui frontend

# Explicit native UI build, after the real frontend has been embedded.
./dev-ui native
```

`./dev-ui build` combines frontend and native builds. The package build entry
point uses the active package-manager build environment rather than selecting a
different switch. UI build commands currently require Dune's default `_build`
directory and reject custom build-directory arguments. Source checks passing do
not establish final browser behavior, platform support or release readiness.
See `ui/frontend/README.md` in a source checkout for dependency, formatting, test
and asset-provenance commands; avoid substituting a development server for the
embedded artifact.

## Response framing

The browser transport accepts only the companion's fixed-length, unencoded JSON
responses: one valid `Content-Length`, no `Transfer-Encoding` and no
`Content-Encoding`. The client admits at most 4 MiB for ordinary responses and
16 MiB for full operation or launch inspection, then verifies the exact received
byte length. Missing, compressed or streaming framing is rejected. This is a
same-origin native companion protocol, not a general HTTP client. A transport
failure never triggers an automatic write retry or implies definite rejection.

## Platform qualification

| Environment | Intended layout | Required verification before claiming support |
| --- | --- | --- |
| macOS ARM64 | Native companion and daemon, local browser | Real installed pair, browser flows, lifecycle, permissions, transfers and recovery. |
| AlmaLinux 10 x86_64 | Native companion and daemon, local browser | Build/link and libc/runtime dependencies, installed pair, browser flows and recovery. |
| WSL with a Windows browser | Companion and daemon inside Linux; browser reaches the companion through the user's Windows/WSL forwarding setup | Actual Windows-browser qualification is deferred to post-release testing. Do not interpret native AlmaLinux qualification as a WSL browser pass. |

These are target environments, not a list of passed qualifications. In WSL, the
daemon socket and companion filesystem paths are Linux paths. The Windows browser
uses the companion HTTP address, not the Unix socket. The user configures any
Windows-to-WSL port mapping or forwarding needed to reach that address; Workgraph
does not manage Windows networking. Keep the printed URL's authority and origin
when arranging access. If forwarding fails, do not expose the service on every
network interface: LAN binding is unsupported by this launcher.

For this release, actual Windows-browser/WSL testing is explicitly deferred to
post-release testing on Windows and WSL and is not a release blocker. It remains untested,
not a passed qualification. Native macOS and native AlmaLinux package/runtime
checks are still required before claiming those artifacts are qualified.


### Live updates and multiple tabs

An open workspace tab keeps one change-observation long poll open for up to
25 seconds. When nothing changes, it renews that request without rereading the
page. Changes trigger a batched refresh; connection interruptions retry quietly
one second apart and retain the displayed content. The UI does not reload the page
or retry writes because an observation failed.

The companion admits up to 16 simultaneous observations independently of ordinary
reads and writes. Reloading or closing a tab ends its old observation. Switching tabs or windows
does not disconnect live updates. Background tabs keep receiving changes while
the browser allows them to run; browser suspension or computer sleep can still
interrupt updates, which recover quietly while retaining displayed content.
If all observation slots are occupied, affected tabs temporarily use bounded
fallback refreshes while retrying. Browser connection limits can still constrain
many simultaneously visible windows sharing the same origin.


Compatible page switches retain the current live observation. When a page needs
a different feed, the UI requests cancellation on the server and consumes the
completed response so its HTTP connection remains reusable. Read-only network
failures receive at most one immediate retry; writes never use that retry path.
Saved-connection reads time out after ten seconds instead of waiting indefinitely.
Subsequent automatic recovery attempts wait one second, without exponential backoff.
