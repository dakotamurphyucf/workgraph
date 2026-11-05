# macOS ARM64 native installation

Version 0.6.2 uses application API 0.6 and affected stored roots 5, unchanged
from 0.6.0 and 0.6.1. An upgrade from either retains existing roots, contexts
and journals;
stop the daemon gracefully, install the matching client/daemon, replace the complete
[agent skill](agent-skill.md), and restart. No data reset is required. Read the
[0.6.2 upgrade notes](releases/v0.6.2.md#upgrade-from-060-or-061) before replacing an executable.
For 0.5 or earlier, follow the separate
[preservation-first fresh-root procedure](releases/v0.6.0.md#upgrade-from-05-or-an-older-preview).
Release qualification records identify exact source, artifacts and observed platform
checks; installation instructions do not substitute for that evidence.

Use the [release notes](releases/v0.6.2.md) for features, breaking changes, upgrade
steps and qualification limits. Use a matching 0.6.2 executable and guide.

The macOS deployment target and tested OS must come from the final matching
qualification JSON. Prior-release checks do not qualify the 0.6.2 executable.
Developer ID signing, notarization and downloaded Gatekeeper launch require
separate evidence; no such qualification is claimed here.

## Install v0.6.2 preview

This installation walkthrough targets **v0.6.2 preview**, application API **0.6**
and affected stored roots **5**, with its matching bundled guide/API.
Download its archive and qualification evidence from the
[v0.6.2 release](https://github.com/dakotamurphyucf/workgraph/releases/tag/v0.6.2).
Alternatively, use the [source build](../README.md#build-the-current-checkout-from-source)
or the local archive procedure below. All 0.5 and earlier installations require
fresh data and journals; follow the [upgrade steps](releases/v0.6.0.md#upgrade-from-05-or-an-older-preview).

The native archive is intended for Apple Silicon Macs. It contains the executable,
complete offline guide and references, examples, dependency license texts and a
file-hash manifest. Running the executable does not require opam or OCaml.
Packaging does not publish release assets.

Download the v0.6.2 preview archive and its checksums from the release, then
verify the selected archive before extracting it. The release's `SHA256SUMS`
also lists other assets, so select exactly this archive's entry:

```sh
set -eu
mkdir -p "$HOME/Downloads/workgraph-0.6.2"
cd "$HOME/Downloads/workgraph-0.6.2" || exit
WORKGRAPH_RELEASE="https://github.com/dakotamurphyucf/workgraph/releases/download/v0.6.2"
curl -fLO "$WORKGRAPH_RELEASE/workgraph-0.6.2-macos-arm64.tar.gz"
curl -fLO "$WORKGRAPH_RELEASE/SHA256SUMS"
awk '$2 == "workgraph-0.6.2-macos-arm64.tar.gz" { print; count++ }
     END { if (count != 1) exit 1 }' SHA256SUMS > macos.SHA256SUMS &&
  shasum -a 256 -c macos.SHA256SUMS &&
  tar -xzf workgraph-0.6.2-macos-arm64.tar.gz &&
  ./workgraph-0.6.2-macos-arm64/bin/workgraph --version
```

The version must print `0.6.2`. Check the release's macOS qualification JSON
and evidence archive for the source identity and actual macOS version tested.

Keep the extracted directory together so relative guide links remain usable. Add
its `bin` directory to your PATH if desired. The complete agent skill is bundled
at `skills/workgraph/`; follow [skill installation](agent-skill.md) to copy it
into your harness. Git is needed for Git workflow examples. The optional WGX
viewer uses Bash and jq; its interactive dashboard and dependency tree need
Python 3.10+. Use `brew install jq python` if needed, then follow the
[WGX setup](../README.md#watch-agents-work). Python is also used by example
and qualification drivers, not by the executable itself.

After installation, `workgraph init --help` and `workgraph help request.ask`
work offline. The bundled [agent CLI contract](../skills/workgraph/references/cli-contract.md) covers
context setup, saved exact retries and the API 0.6 contract. Its
[communication reference](../skills/workgraph/references/communication-evidence.md) shows how to ask a
question and atomically publish an answer.

Startup holds an exclusive socket-path ownership guard. Recovery removes only
the exact recorded native socket identity after ownership/peer checks; foreign,
live, replaced or unknown paths refuse. Connection refusal alone grants no cleanup
authority. Preserve locks and managed data, and choose a fresh private endpoint
when ownership is uncertain. See [administration](../skills/workgraph/references/administration.md).

## Building and qualifying a local archive

Use an Apple Silicon macOS host, Bash, Git, Python 3.10+ and an already provisioned
matching opam switch. The script checks OCaml 5.3.0, Dune 3.21.1 and ocamlformat
0.28.1 before building; it never changes switch selection or global defaults.
The output directory must be an absolute path that does not exist:

```sh
WORKGRAPH_OPAM_SWITCH=default packaging/macos/build.sh "$PWD/dist/macos-arm64"
```

The script runs `./dev build @fmt @runtest @install`, exports exact toolchain
metadata, collects upstream notices, inspects the Mach-O architecture/deployment
target and rejects non-system dynamic dependencies or runtime search paths. It
then builds the source/native archives and runs the installed daemon/socket,
lifecycle, Git resume, export/restore and history-recovery examples. Archive
checksums, full command logs and machine-readable reports are retained in output.
`qualification.json` is written only after the installed checks pass; it binds the
source identity, executable SHA256 and archive hashes. The archive's embedded
`QUALIFICATION.json` records inspection before runtime qualification and therefore
uses `status: inspection-only` rather than claiming the later runtime result.

Qualification validates safe regular archive members, exact manifests and hashes,
complete source/native guide agreement and all declared dependency notice hashes
before extracting or executing the package. To repeat installed qualification for
existing archives in a fresh evidence directory:

```sh
packaging/macos/qualify.sh "$PWD/dist/macos-arm64/archives" "$PWD/scratch/macos-runtime-recheck"
```

`evidence/native.json` records the actual minimum deployment target embedded by
the linker and the macOS version tested. A linker deployment target is not proof
of qualification on that older OS. Inspect each artifact's evidence before
claiming support for a specific version. ARM64 is the only macOS architecture.

Runtime checks use `env -i`, a fresh HOME, `/usr/bin:/bin` PATH and no opam/OCaml or
DYLD overrides. The qualification driver may use an absolute Python path. The
host's development toolchain remains physically installed: this establishes
runtime independence from switch paths, not a hermetic machine or a clean OS
installation. Current packaging fails closed if a future dependency needs
bundled non-system libraries; those require an explicit relocation and license
review before releasing an archive.

The packaging scripts do not apply Developer ID signing or notarization. Linker
ad-hoc signatures, when present, are recorded by inspection. Launching a locally
extracted archive does not qualify Gatekeeper behavior for a browser download;
that behavior remains untested unless separately recorded. There is no installer
package or automatic background service setup.

## CI and periodic durability checks

The Linux and macOS workflows provision private opam roots with the same fixed
repository tree, OCaml 5.3.0, Dune 3.21.1 and ocamlformat 0.28.1. They do not use
or change developer switches. Linux's scheduled/manual job additionally compiles
`bench/fault_shim.c` and runs `bench/fault_matrix.py`, a finite 60-case selection
covering write, sync and rename boundaries before/after interception with error
or process-exit outcomes. Its step has a 15-minute bound and preserves JSON and
per-case daemon logs. These POSIX syscall failures establish retry/recovery
behavior; they are not a power-loss simulation. The configured workflows must
actually run before their results can count as qualification evidence.
