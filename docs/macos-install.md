# macOS ARM64 native installation

This download section installs the published v0.2.0 preview with its own bundled
guide and API. The current checkout prepares unpublished v0.3.0; build it from
source using the [README](../README.md#build-the-current-checkout-from-source) or
the local archive procedure below. No v0.3.0 download is published here.

The native archive is intended for Apple Silicon Macs. It contains the executable,
complete offline guide and references, examples, dependency license texts and a
file-hash manifest. Running the executable does not require opam or OCaml.
Packaging does not publish release assets.

Download the v0.2.0 preview archive and its checksums from the release, then
verify the selected archive before extracting it. The release's `SHA256SUMS`
also lists other assets, so select exactly this archive's entry:

```sh
mkdir -p "$HOME/Downloads/workgraph-0.2.0"
cd "$HOME/Downloads/workgraph-0.2.0" || exit
WORKGRAPH_RELEASE="https://github.com/dakotamurphyucf/workgraph/releases/download/v0.2.0"
curl -fLO "$WORKGRAPH_RELEASE/workgraph-0.2.0-macos-arm64.tar.gz"
curl -fLO "$WORKGRAPH_RELEASE/SHA256SUMS"
awk '$2 == "workgraph-0.2.0-macos-arm64.tar.gz" { print; count++ }
     END { if (count != 1) exit 1 }' SHA256SUMS > macos.SHA256SUMS &&
  shasum -a 256 -c macos.SHA256SUMS &&
  tar -xzf workgraph-0.2.0-macos-arm64.tar.gz &&
  ./workgraph-0.2.0-macos-arm64/bin/workgraph --version
```

The version must print `0.2.0`. Check the release's macOS qualification JSON
and evidence archive for the source identity and actual macOS version tested.

Keep the extracted directory together so relative guide links remain usable. Add
its `bin` directory to your PATH if desired. Start with its bundled `AGENT_GUIDE.md`
and `docs/agent/cli-contract.md`, which match that installed preview. Git is needed
for Git workflow examples; Python is used by example/qualification drivers, not by
the executable itself.

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
