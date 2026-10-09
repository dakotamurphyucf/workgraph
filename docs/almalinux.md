# AlmaLinux 10 on x86_64, including WSL

For copy-and-paste installation, optional removal of an older setup, and a first
ticket workflow, use the [WSL reset and quick-start guide](wsl-quickstart.md).

The native package targets ordinary AlmaLinux 10 x86_64/AMD64 userspace. It runs
in the foreground and requires no systemd service, automatic startup or OCaml
toolchain. The RPM and native tarball contain the same executable.

Each qualified release includes `qualification.json` with `"status": "passed"`,
artifact checksums, the exact source identity and build environment. The
[AlmaLinux package workflow](https://github.com/dakotamurphyucf/workgraph/actions/workflows/almalinux.yml)
builds in official AlmaLinux 10 userspace on a native AMD64 runner and tests both
packages in separate fresh runtime containers. Check the release evidence for
the passing run and commit before treating a download as qualified.

The pinned image contains AlmaLinux 10.2 and glibc 2.39. Its standard AMD64
userspace requires x86-64-v3 support. Docker tests use the host kernel; they do
not certify Windows, the WSL kernel, SELinux policy or every AlmaLinux 10 minor
release. ARM64 Docker emulation that lacks x86-64-v3 cannot run this image.

## Install the qualified package

Use the `almalinux-10-x86_64` download and verify its published SHA256 checksum.
For the RPM:

```sh
sudo dnf install ./workgraph-0.2.0-1.el10.x86_64.rpm
workgraph --version
```

For the tarball:

```sh
tar -xzf workgraph-0.2.0-almalinux-10-x86_64.tar.gz
install -Dm755 workgraph-0.2.0-almalinux-10-x86_64/bin/workgraph \
  "$HOME/.local/bin/workgraph"
export PATH="$HOME/.local/bin:$PATH"
workgraph --version
```

The version must print `0.2.0`. The executable links to the AlmaLinux system
libraries recorded in the release's `linked-libraries.txt`; an OCaml runtime or
opam installation is unnecessary. Git is needed only for Git handoffs, and
Python 3 is needed for the supplied examples and qualification walkthrough.
Third-party license texts and an exact dependency inventory are retained under
`THIRD_PARTY_NOTICES/` in the native archive and
`/usr/share/licenses/workgraph/THIRD_PARTY_NOTICES/` in the RPM installation.

## Run inside AlmaLinux WSL

Keep the registry, managed workspaces and socket on the distribution's Linux
filesystem, such as `$HOME/.local/state/workgraph`. Avoid `/mnt/c` for managed
stores: Workgraph relies on Linux locking, Unix sockets, atomic rename and
directory synchronization. Microsoft also recommends using the Linux filesystem
when working with Linux tools. See [Microsoft's WSL filesystem guidance](https://learn.microsoft.com/en-us/windows/wsl/filesystems).

In an AlmaLinux WSL shell:

```sh
mkdir -p "$HOME/.local/state/workgraph"
chmod 700 "$HOME/.local/state/workgraph"
workgraph serve "$HOME/.local/state/workgraph/registry" \
  "$HOME/.local/state/workgraph/daemon.sock"
```

Leave that foreground process running. In a second AlmaLinux WSL shell:

```sh
workgraph call "$HOME/.local/state/workgraph/daemon.sock" initialize '{}'
workgraph call "$HOME/.local/state/workgraph/daemon.sock" workspace.create \
  '{"workspace_id":"demo","name":"Demo","root":"'"$HOME"'/.local/state/workgraph/demo","actor_id":"operator","mutation_id":"create-demo"}'
workgraph call "$HOME/.local/state/workgraph/daemon.sock" workspace.list '{}'
workgraph call "$HOME/.local/state/workgraph/daemon.sock" daemon.shutdown '{}'
```

For an end-to-end check on the actual WSL installation, install Git and Python 3,
obtain the matching source archive, and run its walkthrough with a fresh directory
under the Linux home filesystem:

```sh
sudo dnf install git python3
tar -xzf workgraph-0.2.0-source.tar.gz
python3 workgraph-0.2.0/tools/installed_smoke.py "$(command -v workgraph)" \
  "$HOME/.local/state/workgraph/wsl-qualification"
python3 workgraph-0.2.0/examples/history-recovery-demo.py "$(command -v workgraph)" \
  --directory "$HOME/.local/state/workgraph/wsl-history-qualification"
```

Both destination directories must be unused. The first walkthrough checks the
installed CLI, Git clone/resume, export verification and restore. The second
checks history adapter retries, search, complete payloads and context recovery.
Keep their JSON output and daemon logs when reporting a failure.

## Reproduce the build and package qualification

Run from a clean source checkout on a native Linux AMD64 host with an x86-64-v3
capable CPU, a running Linux AMD64 Docker daemon, Bash and Python 3.10+. The host
UID/GID must be nonzero so the build's permission tests run as an ordinary user.
Qualification rejects an ARM host or ARM Docker daemon running AMD64 through
emulation. No host opam switch is created or changed:

```sh
mkdir -p "$PWD/dist/almalinux-10-x86_64"
docker build --platform linux/amd64 -f packaging/almalinux/Containerfile \
  --build-arg "BUILDER_UID=$(id -u)" --build-arg "BUILDER_GID=$(id -g)" \
  -t workgraph-alma-builder .
docker run --rm --platform linux/amd64 \
  -v "$PWD:/source:ro" -v "$PWD/dist/almalinux-10-x86_64:/out" \
  workgraph-alma-builder /usr/local/bin/workgraph-build /source /out
packaging/almalinux/qualify.sh "$PWD/dist/almalinux-10-x86_64"
```

The output directory must be empty before the build. The builder includes Git,
Python 3 and jq for the integration tests and shell examples. It runs as an
ordinary user so permission tests retain their meaning. It packages the explicit
source allowlist before compiling; `.git`, checkout credentials, host build
outputs, local workspace data, `scratch/` and `dist/` are excluded.

The recipe fixes the official AlmaLinux 10.2 AMD64 image manifest to
`sha256:ba31c3299856068f77bc10574cad51b0a4f6a3dafb882668656e1639bee63db6`,
opam to `2.3.0` with a verified binary checksum, the opam repository tree to
`e4cd7ede2d55a46570977c0ffaa7e96845190817`, OCaml to `5.3.0`, Dune to `3.21.1`,
and ocamlformat to `0.28.1`. The project pins its direct library dependencies.
`toolchain.export` records the complete resolved dependency closure and package
definitions. DNF repositories remain live; all installed RPM versions are
recorded, so this is a reproducible build procedure rather than a promise of
bit-identical future output.

`./dev build @fmt @runtest @install` must pass before packaging. The RPM spec
installs that tested native archive and preserves executable bytes; it is not a
separate compiler build. Fresh runtime containers contain Git and Python 3 but
no compiler, opam or Dune. They qualify tar and RPM independently, verify dynamic
library resolution and RPM integrity, run both walkthroughs from the installed
package, and compare the installed executable hashes. Before extraction or
execution, qualification checks safe regular archive members, complete manifest
inventories and hashes, recomputed source identity, complete source/native guides,
notice inventory hashes and exact installed tar/RPM contents. The RPM includes
the same inspection record, guide tools and dependency notices as the tarball.

Results are retained under `dist/almalinux-10-x86_64`: `archives/`, `rpm/`,
`logs/`, `runtime/`, `toolchain.export`, `build-metadata.json` and, only after both
runtime checks pass, `qualification.json`. This final record binds source identity,
archive/RPM hashes and executable SHA256. The native archive's embedded
`QUALIFICATION.json` has `status: inspection-only`; it does not claim a runtime
result before installed checks have run. `notices/INVENTORY.json` records the
installed opam dependency closure, source checksums and hashes of preserved
license files, including notices discovered inside vendored library sources.
See the [official AlmaLinux image
documentation](https://wiki.almalinux.org/containers/docker-images) and
[AlmaLinux 10 architecture notes](https://wiki.almalinux.org/release-notes/10.0)
for the standard x86-64-v3 image baseline.
