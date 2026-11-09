# Optional UI packages

Workgraph's core CLI and daemon remain a separate package. A normal core build
does not run Node or npm. The optional UI is a native companion with embedded
browser assets; its installed runtime does not need Node, npm, an OCaml compiler
or a frontend server. A browser is needed to use the interface.

Package versions come from `dune-project`. The wire API version is independent;
matching an API number alone does not qualify an older daemon for a new UI.
Use the paired daemon or the exact matching core RPM. A locally generated
archive is a candidate, not a signed or publicly released distribution.

## Build a source archive

From the source checkout, choose a fresh absolute output directory:

```sh
mkdir -p "$PWD/dist"
python3 tools/package.py "$PWD/dist/source-preview"
```

The explicit source inventory includes `dev-ui`, both opam package declarations,
the frontend lockfile, authored UI sources, companion, tests and build tools.
It excludes `node_modules`, `_build`, `dist`, scratch/private state, generated
embedded assets, Playwright reports and test results. No build is performed.
The source archive and its manifest have deterministic member ordering, modes
and timestamps. `SHA256SUMS` records the complete archive hashes.

## Build on native macOS ARM64

Provision a fresh toolchain under an absolute path that you own. This does not
change your default opam switch or shell profile. Provisioning downloads the
fixed repository/compiler and checksum-pinned upstream build inputs, including
the required Cohttp source and Node/npm toolchain. Use Python 3.12 or newer
(or a maintained backport with `tarfile.data_filter`) for safe upstream extraction.

```sh
mkdir -p "$PWD/scratch"
packaging/provision-ui.sh "$PWD/scratch/ui-toolchain" macos-arm64
source "$PWD/scratch/ui-toolchain/environment.sh"
export WORKGRAPH_UI_INPUTS="$PWD/scratch/ui-toolchain"
WORKGRAPH_PACKAGE_UI=true packaging/macos/build.sh "$PWD/dist/ui-macos-arm64"
```

The explicit environment clears inherited OCaml/findlib/Dune and native library
overrides so external development prefixes cannot silently enter the build.
Build logs, the switch export, upstream identities, original dependency license
texts and installed-runtime results remain in the output directory. The optional
build runs the frontend checks, embeds the exact asset manifest, builds the
companion and runs the enabled native gate. Omitting `WORKGRAPH_PACKAGE_UI=true`
keeps the existing core-only recipe.

The paired `workgraph-ui-VERSION-macos-arm64.tar.gz` contains both executables,
offline guides, native dependency notices, browser notices and `ui-package/`
asset/provenance records. Its manifest binds both binaries to the complete source
identity. UI input and lock hashes must match the supplied source archive;
changed source requires rebuilding the assets. Inspection metadata is distinct
from the installed runtime result. These scripts do not sign or notarize a build.

## Verify and install a paired archive

Keep the exact source archive and checksum inventory with the native archive.
From the source checkout, validate everything before writing installed files:

```sh
mkdir /absolute/path/empty-installation
python3 packaging/verify.py /absolute/path/workgraph-ui-VERSION-macos-arm64.tar.gz \
  /absolute/path/workgraph-VERSION-source.tar.gz \
  --extract /absolute/path/empty-installation
```

Use the printed archive root beneath that directory. The companion requires an
absolute private state root. For example, after replacing the installation path:

```sh
installation=/absolute/path/empty-installation/workgraph-ui-VERSION-macos-arm64
mkdir -p -m 700 "$HOME/.local/state/workgraph-ui"
"$installation/bin/workgraph-ui" --state-root "$HOME/.local/state/workgraph-ui" \
  --daemon-executable "$installation/bin/workgraph"
```

This opens the loopback browser interface without starting a daemon or creating
a connection profile. Select an existing daemon connection, or explicitly use
the interface's managed-daemon flow. The example selects the paired executable
for that flow; `--daemon-executable /usr/bin/workgraph` selects the dependency's
core executable for an RPM installation. Explicit daemon operations qualify the
required daemon version before semantic work. `--no-open` leaves browser opening to you. Keep daemon
registry/workspace data, companion state and saved request journals outside the installation.
Removing the installation directory then removes only package files. Stop only
the companion/daemon processes you started before removing their binaries.

The installed smoke driver in `packaging/ui_smoke.py` starts owned fresh processes
and checks paired versions, readiness, every served asset hash/content type and
daemon attachment with a minimal runtime environment. It does not test graphical
browser interaction or prove qualification on a different operating system.

## AlmaLinux 10 AMD64 tar and RPM

Use a native Linux AMD64 host with an x86-64-v3-capable CPU and Docker. The source
tree contains an explicit optional image mode:

```sh
docker build --platform linux/amd64 -f packaging/almalinux/Containerfile \
  --build-arg BUILDER_UID="$(id -u)" --build-arg BUILDER_GID="$(id -g)" \
  --build-arg WORKGRAPH_PACKAGE_UI=true -t workgraph-ui-alma-builder .
mkdir -p dist/ui-almalinux-10-x86_64
docker run --rm --platform linux/amd64 -v "$PWD:/source:ro" \
  -v "$PWD/dist/ui-almalinux-10-x86_64:/out" workgraph-ui-alma-builder
packaging/almalinux/qualify.sh "$PWD/dist/ui-almalinux-10-x86_64"
```

The runtime image has no Node/compiler toolchain. Qualification checks tar and
RPM installations separately. The UI RPM requires the exact architecture/version/
release of `workgraph`; it owns `workgraph-ui` and its own documentation/licenses,
not the dependency's executable or user data. Install the core and UI RPMs from
the same output together. To keep the core even when it was installed solely as
a dependency, explicitly disable dependency cleanup when removing the UI:

```sh
sudo dnf --setopt=clean_requirements_on_remove=False remove workgraph-ui
```

There are no RPM service-start or user-data removal scripts. Native platform
qualification remains required: an ARM emulator is not native AMD64 evidence,
and an emulator that cannot start the AlmaLinux x86-64-v3 image cannot qualify it.
Container userspace checks do not establish WSL kernel, Windows browser forwarding,
SELinux, graphical browser or distribution signing/release qualification.

The CI workflows expose an opt-in `optional_ui` manual input. Their default
core-only path stays independent. Running or publishing remote workflows and
releases is a separate action; the local packaging commands do not do either.
