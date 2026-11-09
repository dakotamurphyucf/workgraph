#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: workgraph-build SOURCE_DIRECTORY FRESH_OUTPUT_DIRECTORY" >&2
  exit 2
fi
test "$(id -u)" -ne 0
[ "$(uname -m)" = x86_64 ]
source_directory=$(realpath "$1")
output_directory=$(realpath "$2")
if [ -n "$(find "$output_directory" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
  echo "Output directory must be empty: $output_directory" >&2
  exit 2
fi
mkdir "$output_directory/logs"
build_directory=$(mktemp -d /home/workgraph/build.XXXXXXXX)

# Package the source allowlist before building, so ignored data and host _build
# outputs can never enter the compiler input or release archives.
python3 "$source_directory/tools/package.py" "$build_directory/input-package" \
  | tee "$output_directory/logs/source-package.json"
tar -xzf "$build_directory"/input-package/workgraph-*-source.tar.gz -C "$build_directory"
project_directory=$(find "$build_directory" -mindepth 1 -maxdepth 1 -type d -name 'workgraph-*' -print)
cd "$project_directory"
source "$project_directory/packaging/clean-ocaml-env.sh"
version=$(python3 packaging/source_version.py "$project_directory")
optional_ui=${WORKGRAPH_PACKAGE_UI:-false}
case "$optional_ui" in true|false) ;; *) echo 'WORKGRAPH_PACKAGE_UI must be true or false' >&2; exit 2 ;; esac
notice_options=()
ui_options=()

{
  cat /etc/os-release
  uname -a
  arch
  ldd --version
  opam --version
  opam exec -- ocamlc -version
  opam exec -- dune --version
  opam exec -- ocamlformat --version
  id
} > "$output_directory/logs/build-environment.txt"
cat /proc/cpuinfo > "$output_directory/logs/cpuinfo.txt"
rpm -qa --queryformat '%{NAME} %{VERSION}-%{RELEASE} %{ARCH}\n' | sort \
  > "$output_directory/logs/build-rpms.txt"
opam list --installed --columns=name,version > "$output_directory/logs/opam-packages.txt"
if [ "$optional_ui" = true ]; then
  opam switch export --full "$output_directory/toolchain.export"
else
  opam switch export --full --freeze "$output_directory/toolchain.export"
fi

./dev build @fmt @runtest @install --display=short -j "${WORKGRAPH_JOBS:-2}" \
  2>&1 | tee "$output_directory/logs/build-test-install.log"
test "$(./dev run --version)" = "$version"
if [ "$optional_ui" = true ]; then
  test -n "${WORKGRAPH_UI_INPUTS:-}"
  test "$(node --version)" = v22.14.0
  test "$(npm --version)" = 10.9.2
  ./dev-ui install 2>&1 | tee "$output_directory/logs/ui-install.log"
  ./dev-ui frontend 2>&1 | tee "$output_directory/logs/ui-frontend.log"
  ./dev-ui native 2>&1 | tee "$output_directory/logs/ui-native.log"
  WORKGRAPH_UI_BUILD=true ./dev build @fmt @runtest @install --display=short -j "${WORKGRAPH_JOBS:-2}" \
    2>&1 | tee "$output_directory/logs/ui-enabled-gate.log"
  ldd _build/default/ui/companion/bin/main.exe > "$output_directory/logs/ui-linked-libraries.txt"
  if grep -q 'not found' "$output_directory/logs/ui-linked-libraries.txt"; then exit 1; fi
  file _build/default/ui/companion/bin/main.exe > "$output_directory/logs/ui-executable-format.txt"
  readelf -h _build/default/ui/companion/bin/main.exe > "$output_directory/logs/ui-elf-header.txt"
  notice_options=(--ui --cohttp-source "$WORKGRAPH_UI_INPUTS/cohttp")
  ui_options=(--ui-binary "$project_directory/_build/default/ui/companion/bin/main.exe"
              --ui-manifest "$project_directory/ui/tools/embedded/manifest.json"
              --ui-notices "$project_directory/ui/tools/embedded/frontend-notices.txt")
  cp "$WORKGRAPH_UI_INPUTS/provision.json" "$WORKGRAPH_UI_INPUTS/cohttp/upstream.json" "$output_directory/logs/"
fi
ldd _build/default/bin/main.exe > "$output_directory/logs/linked-libraries.txt"
file _build/default/bin/main.exe > "$output_directory/logs/executable-format.txt"
readelf -h _build/default/bin/main.exe > "$output_directory/logs/elf-header.txt"
python3 packaging/almalinux/collect_notices.py "$output_directory/notices" ${notice_options[@]+"${notice_options[@]}"} \
  2>&1 | tee "$output_directory/logs/dependency-notices.log"
python3 tools/package.py "$output_directory/archives" \
  --binary "$project_directory/_build/default/bin/main.exe" \
  --notices "$output_directory/notices" \
  --platform almalinux-10-x86_64 \
  ${ui_options[@]+"${ui_options[@]}"} \
  | tee "$output_directory/logs/native-package.json"

mkdir -p "$build_directory/rpmbuild"/{BUILD,BUILDROOT,RPMS,SOURCES,SPECS,SRPMS}
cp "$output_directory/archives/workgraph-$version-almalinux-10-x86_64.tar.gz" \
  "$build_directory/rpmbuild/SOURCES/"
cp /opt/workgraph.spec "$build_directory/rpmbuild/SPECS/workgraph.spec"
rpmbuild -bb --define "_topdir $build_directory/rpmbuild" \
  --define "workgraph_version $version" \
  "$build_directory/rpmbuild/SPECS/workgraph.spec" \
  2>&1 | tee "$output_directory/logs/rpm-build.log"
if [ "$optional_ui" = true ]; then
  cp "$output_directory/archives/workgraph-ui-$version-almalinux-10-x86_64.tar.gz" "$build_directory/rpmbuild/SOURCES/"
  cp /opt/workgraph-ui.spec "$build_directory/rpmbuild/SPECS/"
  rpmbuild -bb --define "_topdir $build_directory/rpmbuild" --define "workgraph_version $version" \
    "$build_directory/rpmbuild/SPECS/workgraph-ui.spec" 2>&1 | tee "$output_directory/logs/ui-rpm-build.log"
fi
mkdir "$output_directory/rpm"
cp "$build_directory/rpmbuild/RPMS/x86_64/"*.rpm "$output_directory/rpm/"
rpm -qp --requires "$output_directory/rpm/"*.rpm > "$output_directory/logs/rpm-requires.txt"
rpm -qpl "$output_directory/rpm/"*.rpm > "$output_directory/logs/rpm-files.txt"
(cd "$output_directory/rpm" && sha256sum ./*.rpm > SHA256SUMS)

python3 - "$output_directory" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

out = Path(sys.argv[1])
package = json.loads((out / 'logs/native-package.json').read_text())
artifacts = {p.relative_to(out).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
             for directory in ['archives', 'rpm'] for p in (out / directory).iterdir() if p.is_file()}
metadata = {
    'schema': 1, 'status': 'build-tests-passed-runtime-pending',
    'target': 'almalinux-10-x86_64', 'version': json.loads((out / 'logs/source-package.json').read_text())['version'],
    'base_image': 'docker.io/library/almalinux@sha256:ba31c3299856068f77bc10574cad51b0a4f6a3dafb882668656e1639bee63db6',
    'opam_repository_commit': 'e4cd7ede2d55a46570977c0ffaa7e96845190817',
    'opam_version': '2.3.0', 'ocaml_version': '5.3.0', 'dune_version': '3.21.1',
    'ocamlformat_version': '0.28.1', 'source_identity': package['source_identity'],
    'build_checks': ['@fmt', '@runtest', '@install'], 'artifacts': artifacts,
    'dependency_notices': 'notices/INVENTORY.json',
    'limits': ['AlmaLinux userspace on the container host kernel',
               'No Windows, WSL kernel or SELinux qualification',
               'DNF repository package versions are recorded, not snapshot-pinned'],
}
(out / 'build-metadata.json').write_text(json.dumps(metadata, indent=2, sort_keys=True) + '\n')
PY
